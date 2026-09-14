const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const cors = require('cors');
// Room persistence: survive a restart, and clean up finished games. See
// persistence.js for what we store and why (durable game state, not transport).
const {
  persistRoom,
  deleteRoomFile,
  loadPersistedRooms
} = require('./persistence');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

// Initialize Socket.io server with CORS enabled
const io = new Server(server, {
  cors: {
    origin: "*", // Allows Next.js frontend or mobile clients to connect
    methods: ["GET", "POST"]
  }
});

// ================= IN-MEMORY GAME STATE STORE =================
class GameRoom {
  constructor(roomId, hostSocketId = null) {
    this.roomId = roomId;
    this.hostId = hostSocketId;      // socket that created the room
    this.hostToken = null;           // session token of the host (survives socket churn)
    this.sockets = new Set();        // socket ids currently joined to this room
    this.tokens = new Set();         // session tokens ever issued for this room
    this.players = [];               // player records, each carrying its own sessionToken
    this.propertyOwnership = {}; // tileId -> playerId
    this.propertyHouses = {};    // tileId -> houseCount
    this.trades = [];            // Array of TradeProposal
    this.chatMessages = [];      // Array of ChatMessage
    this.activeAuction = null;   // AuctionState | null
    this.auctionTimer = null;
    // ===== SERVER-AUTHORITATIVE TURN ORDER =====
    // The id of the player whose turn it is RIGHT NOW, decided by the server.
    // This is the single source of truth for every turn-gated validation. It is
    // seeded to the first player and advanced ONLY by the server when a valid
    // turn:ended arrives from the player whose turn it actually is — never by a
    // client simply claiming a seat. isCurrentPlayer on a player record is just
    // a mirrored convenience field for the UI; the server never trusts it.
    this.currentTurnPlayerId = null; // number | null (seeded when the first player joins)
    this.turnSeeded = false;
    // Server-side turn clock. Armed whenever the turn changes; on expiry the
    // server itself forces the turn forward (see handleTurnTimeout). Kept here so
    // teardown and turn:ended have one place to cancel it — never leaked.
    this.turnTimer = null;
    this.turnDeadline = null; // epoch ms when the current turn times out (for clients)
    this.turnToken = 0;       // monotonic guard so a stale timer can't fire late
    // Grace-period timer: armed when the LAST socket leaves, so a lone player
    // refreshing their own tab can still rejoin. Cleared on any return or when
    // the room is torn down. Kept here so teardown has one place to clear it.
    this.emptyTimer = null;
    this.createdAt = Date.now();
  }

  isEmpty() {
    return this.sockets.size === 0;
  }

  // Cancel the empty-room grace timer (a player came back, or we're tearing down).
  clearEmptyTimer() {
    if (this.emptyTimer) {
      clearTimeout(this.emptyTimer);
      this.emptyTimer = null;
    }
  }

  // Add message to chat history (cap at 100)
  addChatMessage(msg) {
    this.chatMessages.push(msg);
    if (this.chatMessages.length > 100) {
      this.chatMessages.shift();
    }
  }

  // Start or reset auction countdown timer
  startAuctionTimer(io) {
    if (this.auctionTimer) {
      clearInterval(this.auctionTimer);
      this.auctionTimer = null;
    }

    if (!this.activeAuction) return;

    this.auctionTimer = setInterval(() => {
      if (!this.activeAuction) {
        clearInterval(this.auctionTimer);
        this.auctionTimer = null;
        return;
      }

      this.activeAuction.timeLeft -= 1;

      if (this.activeAuction.timeLeft <= 0) {
        clearInterval(this.auctionTimer);
        this.auctionTimer = null;

        // Auto-end auction when timer expires
        const endedAuction = { ...this.activeAuction, timeLeft: 0 };
        if (endedAuction.highestBidderId !== null) {
          this.propertyOwnership[endedAuction.tileId] = endedAuction.highestBidderId;
        }

        this.activeAuction = null;
        // The timer-driven auto-end also settles ownership — persist it too.
        persistRoom(this);
        io.to(this.roomId).emit('auction:end', { auction: endedAuction });
        console.log(`🔨 Room ${this.roomId}: Auction ended. Winner: Player ${endedAuction.highestBidderId ?? 'None'}`);
      } else {
        io.to(this.roomId).emit('auction:tick', { auction: this.activeAuction });
      }
    }, 1000);
  }

  clearAuctionTimer() {
    if (this.auctionTimer) {
      clearInterval(this.auctionTimer);
      this.auctionTimer = null;
    }
  }

  // ===== SERVER-AUTHORITATIVE TURN MANAGEMENT =====
  // Seed the turn to the first (non-bankrupt, non-kicked) player once, at the
  // moment the first player joins. After this the turn is advanced ONLY through
  // advanceTurn(), never by re-reading a client-supplied flag.
  seedTurn() {
    if (this.turnSeeded) return;
    const first = this.players.find(p => !p.isBankrupt);
    if (!first) return;
    this.currentTurnPlayerId = first.id;
    this.turnSeeded = true;
    this.syncTurnFlags();
  }

  // Make sure the turn clock is running. Called once the room actually has an
  // identified player (so we don't start ticking before anyone is in a game).
  // Idempotent: re-arming while a turn is already on the clock is a no-op, so
  // it's safe to call from identify / rejoin without resetting a live turn.
  ensureTurnClock(io) {
    if (this.currentTurnPlayerId === null) return;
    if (this.turnTimer) return;
    this.startTurnTimer((room) => handleTurnTimeout(room, io));
  }

  // Mirror the authoritative turn onto the players' isCurrentPlayer flags. This
  // is a ONE-WAY projection (server truth -> UI convenience flag); nothing in
  // validation ever reads the flag back.
  syncTurnFlags() {
    for (const p of this.players) {
      p.isCurrentPlayer = (p.id === this.currentTurnPlayerId);
    }
  }

  // Advance the turn to the next eligible player. "Eligible" = still in the
  // game (not bankrupt). Wraps around the roster. Returns the new turn player id
  // (or null if there is nobody left to take a turn).
  advanceTurn() {
    if (!this.players.length) {
      this.currentTurnPlayerId = null;
      return null;
    }
    const currentIdx = this.players.findIndex(p => p.id === this.currentTurnPlayerId);
    const start = currentIdx === -1 ? 0 : currentIdx;
    for (let i = 1; i <= this.players.length; i++) {
      const cand = this.players[(start + i) % this.players.length];
      if (cand && !cand.isBankrupt) {
        this.currentTurnPlayerId = cand.id;
        this.syncTurnFlags();
        return cand.id;
      }
    }
    // Everyone left is bankrupt — leave the turn where it is.
    this.syncTurnFlags();
    return this.currentTurnPlayerId;
  }

  // Cancel the current turn clock, if any. Safe to call any number of times.
  clearTurnTimer() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    this.turnDeadline = null;
    // Bumping the token invalidates any timer callback that already queued.
    this.turnToken += 1;
  }

  // Arm the turn clock for the CURRENT turn. On expiry the server forces the
  // turn forward itself, via the SAME advanceTurn() path a normal turn:ended
  // uses — there is no second turn-advance mechanism. `onTimeout(room)` is the
  // callback that performs the forced advance + broadcast (it needs `io`, which
  // the room doesn't hold).
  startTurnTimer(onTimeout) {
    this.clearTurnTimer();
    if (this.currentTurnPlayerId === null) return; // no one to time out
    const myToken = this.turnToken;
    this.turnDeadline = Date.now() + TURN_TIME_LIMIT_MS;
    this.turnTimer = setTimeout(() => {
      // Ignore a stale timer (the turn already moved on and re-armed).
      if (myToken !== this.turnToken) return;
      this.turnTimer = null;
      onTimeout(this);
    }, TURN_TIME_LIMIT_MS);
    // Don't let the turn clock hold the event loop open by itself.
    if (typeof this.turnTimer.unref === 'function') this.turnTimer.unref();
  }

  // The one place a turn is advanced. Called BOTH by a legal turn:ended and by
  // the timeout handler, so both paths produce identical state + broadcast. The
  // caller decides whether the outgoing player also goes bankrupt (timeout does).
  beginTurn(io) {
    const nextId = this.advanceTurn();
    this.startTurnTimer((room) => handleTurnTimeout(room, io));
    // A turn transition is a meaningful state change: persist here so BOTH a
    // normal turn:ended and a timeout save the new turn in one place.
    persistRoom(this);
    io.to(this.roomId).emit('turn:changed', {
      currentTurnPlayerId: nextId,
      turnDeadline: this.turnDeadline
    });
    return nextId;
  }
}

// Global rooms map: roomCode -> GameRoom
const rooms = new Map();

// How long an emptied room lingers before it's torn down. Long enough to cover
// a page refresh or a brief network blip, short enough not to hoard memory.
const EMPTY_ROOM_TTL_MS = Number(process.env.EMPTY_ROOM_TTL_MS) || 90 * 1000; // 90s default
// How long a room RESTORED FROM DISK (at boot) waits for someone to come back
// before it too is reaped. Longer than the normal empty-room TTL because players
// need time to notice the server restarted and reconnect — but it is ALWAYS
// armed, so a restored room nobody ever rejoins can't leak its file or its
// in-memory entry forever.
const RESTORED_ROOM_TTL_MS = Number(process.env.RESTORED_ROOM_TTL_MS) || 15 * 60 * 1000; // 15 min default
// How long a player has to take their turn before the SERVER forces it forward.
// Mirrors the client's TURN_TIME_LIMIT (120s). Env-overridable so tests can use
// a short clock instead of waiting two minutes per turn.
const TURN_TIME_LIMIT_MS = Number(process.env.TURN_TIME_LIMIT_MS) || 120 * 1000; // 120s default
// ===== TURN TIMEOUT (SERVER-ENFORCED) =====
// Fires when a player lets their turn clock expire. Matches the client's
// existing timeout behaviour: the idle player is ELIMINATED (bankrupted) and the
// turn moves on. Crucially it advances through advanceTurn()/beginTurn() — the
// exact path a legal turn:ended uses — and broadcasts the same turn:changed
// event, so clients need no special "timed out vs ended" branch.
function handleTurnTimeout(room, io) {
  const timedOutId = room.currentTurnPlayerId;
  const player = timedOutId === null ? null : room.players.find(p => p.id === timedOutId);
  if (!player) return;

  console.log(`⏰ Room ${room.roomId}: Player ${player.id} timed out — eliminated`);

  // Eliminate the idle player, exactly as the client's timeout did: mark
  // bankrupt and release their properties/houses. Done BEFORE advancing so
  // advanceTurn() skips them and hands the turn to a live player.
  player.isBankrupt = true;
  player.money = 0;
  for (const [tileId, ownerId] of Object.entries(room.propertyOwnership)) {
    if (ownerId === player.id) {
      delete room.propertyOwnership[tileId];
      delete room.propertyHouses[tileId];
    }
  }

  // Tell everyone about the elimination, then advance via the shared path.
  io.to(room.roomId).emit('player:bankrupt', { playerId: player.id, reason: 'timeout' });
  room.beginTurn(io);
}
// Tear a room down completely: stop every timer it owns, invalidate its session
// tokens (so a stale localStorage token can't resurrect it), and drop it from
// the map. Centralised so ALL teardown paths do the same cleanup.
function teardownRoom(room) {
  if (!room) return;
  room.clearAuctionTimer();
  room.clearEmptyTimer();
  room.clearTurnTimer();
  for (const token of room.tokens) sessions.delete(token);
  rooms.delete(room.roomId);
  // Retention: a normally-finished (or abandoned past the empty-room TTL) game
  // must not accumulate on disk forever. This is the ONE place data is dropped.
  deleteRoomFile(room.roomId);
  console.log(`🧹 Room ${room.roomId} torn down (${rooms.size} room(s) remaining)`);
}

// Arm the empty-room grace timer: the SINGLE place a room schedules its own
// teardown for being empty. Used both when a room empties normally (leaveRoom)
// and when a room is restored from disk with zero sockets at boot — the latter
// with a longer TTL. Centralised so EVERY empty room has exactly one pending
// teardown and none can slip through forever.
function armEmptyRoomTimer(room, ttlMs) {
  if (!room) return;
  room.clearEmptyTimer();
  room.emptyTimer = setTimeout(() => {
    room.emptyTimer = null;
    // Only tear down if it's STILL empty (a rejoin cancels the timer directly,
    // but re-check as a belt-and-braces guard).
    if (room.isEmpty()) teardownRoom(room);
  }, ttlMs);
  // Don't let a pending grace timer hold the event loop open: a long-running
  // server is unaffected, but a test harness or CLI tool that boots the server
  // and expects it to exit cleanly still can.
  if (typeof room.emptyTimer.unref === 'function') room.emptyTimer.unref();
}

// Rebuild a live GameRoom from a persisted snapshot at boot. Live transport
// state (sockets, timers) is intentionally NOT restored — there are no
// connections yet at boot. But durable game state (players, ownership, turn,
// trades, auction) IS, so a restart doesn't orphan a game in progress.
function rehydrateRoom(data) {
  const room = new GameRoom(data.roomId, null);
  room.hostToken = data.hostToken || null;
  room.players = Array.isArray(data.players) ? data.players : [];
  room.propertyOwnership = data.propertyOwnership || {};
  room.propertyHouses = data.propertyHouses || {};
  room.trades = Array.isArray(data.trades) ? data.trades : [];
  room.activeAuction = data.activeAuction || null;
  room.currentTurnPlayerId = data.currentTurnPlayerId ?? null;
  room.turnSeeded = !!data.turnSeeded;
  room.createdAt = data.createdAt || Date.now();

  // Repopulate the durable identity lookups so a pre-restart session token still
  // resolves after the bounce (otherwise every rejoin would be rejected).
  const tokens = Array.isArray(data.tokens) ? data.tokens : [];
  for (const token of tokens) {
    const player = room.players.find(p => p.sessionToken === token);
    if (!player) continue;
    room.tokens.add(token);
    sessions.set(token, { roomId: room.roomId, playerId: player.id });
  }

  // Keep the mirrored UI flag consistent with the restored authoritative turn.
  room.syncTurnFlags();
  return room;
}

// Load every persisted room back into memory BEFORE the server starts listening,
// so a restart re-adopts live games instead of silently losing them.
function restorePersistedRooms() {
  const persisted = loadPersistedRooms();
  let restored = 0;
  for (const data of persisted) {
    if (rooms.has(data.roomId)) continue;
    const room = rehydrateRoom(data);
    rooms.set(data.roomId, room);
    // A restored room has ZERO sockets by definition — give it the longer
    // restored-room grace so players can reconnect, but ARM IT NOW. Without this
    // a room nobody ever rejoins would sit in memory (and on disk) forever, so
    // every restart would leak. A rejoin clears the timer as usual.
    armEmptyRoomTimer(room, RESTORED_ROOM_TTL_MS);
    restored += 1;
  }
  if (restored > 0) {
    console.log(`💾 Restored ${restored} room(s) from disk (${rooms.size} total, ${RESTORED_ROOM_TTL_MS / 1000}s grace each)`);
  }
  return restored;
}

// ================= PERSISTENT SESSION TOKENS =================
// Player identity is keyed by a durable session token, NOT by socket.id (which
// is thrown away on every reconnect). These two maps let us route live traffic
// to the right player record while still supporting those reconnects:
//   sessions    : token -> { roomId, playerId }  (the durable identity lookup)
//   socketToken : socket.id -> token             (fast routing for the live socket)
const sessions = new Map();
const socketToken = new Map();

// Issue a token AND seed the player record it identifies, so a later rejoin can
// find the player by token. The record starts as a minimal stub; the client
// fills in name/color/etc. as the game runs. Rejoin is about IDENTITY, not yet
// about restoring the full game state.
function createSessionToken(room, playerId, { name, color } = {}) {
  const token = crypto.randomUUID();
  const player = {
    id: playerId,
    sessionToken: token,
    name: name || `Player ${playerId}`,
    color: color || null,
    money: 0,
    position: 0,
    isCurrentPlayer: playerId === 1,
    mood: 'happy'
  };
  room.players.push(player);
  sessions.set(token, { roomId: room.roomId, playerId });
  room.tokens.add(token);
  // The first player to be added owns turn 1 by server decree. Seeding here (as
  // opposed to lazily on first validation) means the very first player:rolled /
  // player:moved already has an authoritative turn to check against.
  room.seedTurn();
  return token;
}

// Look up a token and return the room + player it belongs to, or null if the
// token is unknown / belongs to a different room (expired, tampered with, etc.).
function resolveSession(token, roomId) {
  if (typeof token !== 'string' || !token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (roomId && session.roomId !== roomId) return null;
  const room = rooms.get(session.roomId);
  if (!room) {
    sessions.delete(token);
    return null;
  }
  const player = room.players.find(p => p.sessionToken === token) || null;
  if (!player) return null;
  return { room, player, playerId: session.playerId };
}

// Room codes are 6 chars from an unambiguous alphabet (no 0/O/1/I) so they're
// easy to read aloud and type across devices without confusion.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

function generateRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
  } while (rooms.has(code)); // guarantee uniqueness
  return code;
}

// Normalize whatever the client typed/passed into a canonical code. Codes
// never contain 0/1/O/I, so fold the confusable characters onto their
// canonical twins: O -> 0 is wrong here, we fold TYPED 0/O to the alphabet's
// nearest legal char. Since the alphabet excludes 0/1/O/I entirely, any of
// those slipping in is a user typo and gets folded to nothing-matchable.
function normalizeRoomCode(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toUpperCase().replace(/[^A-Z2-9]/g, '');
}

function getOrCreateRoom(roomId, hostSocketId = null) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new GameRoom(roomId, hostSocketId));
    console.log(`✨ Created new game room: ${roomId}`);
  }
  return rooms.get(roomId);
}

// Snapshot of everything a client needs to render the room on first join.
function serializeRoomState(room) {
  return {
    roomId: room.roomId,
    hostId: room.hostId,
    connectedCount: room.sockets.size,
    players: room.players,
    propertyOwnership: room.propertyOwnership,
    propertyHouses: room.propertyHouses,
    // The authoritative turn, so a client can render whose turn it is from the
    // server's truth rather than inferring it from a stale local flag.
    currentTurnPlayerId: room.currentTurnPlayerId,
    // When the current turn times out (epoch ms), so the UI countdown is driven
    // by the server's clock rather than a client-side guess.
    turnDeadline: room.turnDeadline,
    trades: room.trades,
    chatMessages: room.chatMessages,
    activeAuction: room.activeAuction
  };
}

// Player-scoped restore payload sent on a successful player:rejoin. This is
// everything the returning client needs to repaint the board for ITSELF:
//   me         - this player's own record (money, position, jail/bankrupt…)
//   players    - the full roster, so the sidebar shows everyone
//   properties - this player's owned tiles + house counts
//   trades     - any trade this player is currently a party to
//   auction    - the live auction if this player is bidding / a participant
function serializePlayerState(room, player) {
  const ownedProperties = [];
  for (const [tileId, ownerId] of Object.entries(room.propertyOwnership)) {
    if (ownerId === player.id) {
      ownedProperties.push({
        tileId: Number(tileId),
        houses: room.propertyHouses[tileId] || 0
      });
    }
  }

  const myTrades = room.trades.filter(
    t => t.initiatorId === player.id || t.targetId === player.id
  );

  const auction = room.activeAuction && (
    room.activeAuction.highestBidderId === player.id ||
    room.activeAuction.tileId !== undefined
  ) ? room.activeAuction : null;

  return {
    me: player,
    players: room.players,
    ownedProperties,
    ownedPropertyIds: ownedProperties.map(p => p.tileId),
    propertyOwnership: room.propertyOwnership,
    propertyHouses: room.propertyHouses,
    // The authoritative turn + its deadline, so a rejoining client repaints the
    // correct current player and the correct countdown from server truth.
    currentTurnPlayerId: room.currentTurnPlayerId,
    turnDeadline: room.turnDeadline,
    trades: myTrades,
    activeAuction: auction,
    chatMessages: room.chatMessages
  };
}

// Remove a socket from its room. Crucially, if the room has no members left
// we also tear down its auction timer and drop it from the map, so abandoned
// games don't leak intervals or memory.
function leaveRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;

  const room = rooms.get(roomId);
  socket.leave(roomId);
  socket.data.roomId = null;

  if (!room) return;

  room.sockets.delete(socket.id);
  // Drop the live socket→token route. The token itself stays valid so the
  // player can be rebound to a NEW socket later via player:rejoin.
  socketToken.delete(socket.id);
  socket.to(roomId).emit('room:peer-left', { socketId: socket.id, connectedCount: room.sockets.size });

  if (room.isEmpty()) {
    // Nobody is here to take a turn, so the turn clock must not keep ticking:
    // disarm it now rather than let it fire an elimination for an empty room.
    // A rejoin re-arms it (ensureTurnClock), so a returning player is still
    // timed as expected. Teardown also clears it, as a second line of defence.
    room.clearTurnTimer();
    // Don't tear down immediately: the common case is ONE player who refreshed
    // their own tab, and they can't rejoin a room that no longer exists. Arm a
    // grace timer instead — a player:rejoin inside the window cancels it.
    armEmptyRoomTimer(room, EMPTY_ROOM_TTL_MS);
    console.log(`⏳ Room ${roomId} emptied — ${EMPTY_ROOM_TTL_MS / 1000}s grace period before teardown`);
  }
}

// REST Endpoints for Server Health & Monitoring
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeRooms: rooms.size,
    uptimeSeconds: process.uptime()
  });
});

app.get('/api/room/:roomId', (req, res) => {
  const roomId = normalizeRoomCode(req.params.roomId);
  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  res.json({
    roomId: room.roomId,
    playerCount: room.players.length,
    connectedCount: room.sockets.size,
    propertyCount: Object.keys(room.propertyOwnership).length,
    activeAuction: room.activeAuction != null,
    chatMessageCount: room.chatMessages.length
  });
});

// Lightweight existence probe so the lobby can validate a code BEFORE
// committing the user to a socket connection to a room that isn't there.
app.get('/api/room/:roomId/exists', (req, res) => {
  const roomId = normalizeRoomCode(req.params.roomId);
  const room = rooms.get(roomId);
  res.json({
    roomId,
    exists: !!room,
    connectedCount: room ? room.sockets.size : 0
  });
});

// ================= SOCKET.IO REAL-TIME MULTIPLAYER SYSTEM =================
io.on('connection', (socket) => {
  // NOTE: a freshly connected socket is deliberately NOT placed in any room.
  // It sits in the lobby until it explicitly emits room:create or room:join.
  // socket.data.roomId is the single source of truth for which game this
  // socket belongs to — every handler below reads it, never a global.
  socket.data.roomId = null;

  console.log(`🟢 Socket connected: ${socket.id} (lobby — not in a room yet)`);

  // Helper: resolve the room this socket is currently in, or null.
  const currentRoom = () => (socket.data.roomId ? rooms.get(socket.data.roomId) : null);

  // Tell the socket which room it's in (and let the UI show the code).
  // `token` is the socket's durable session token — the client persists it so a
  // future reconnect can rebind to the same player record via player:rejoin.
  const emitRoomJoined = (room, role, token, playerState = null) => {
    if (token) socket.data.sessionToken = token;
    socket.emit('room:joined', {
      roomId: room.roomId,
      role,
      token,
      isHost: room.hostToken ? room.hostToken === token : room.hostId === socket.id,
      connectedCount: room.sockets.size,
      state: serializeRoomState(room),
      // Only present on a rejoin: the player-scoped snapshot the client uses to
      // repaint the board for itself instead of starting from defaults.
      playerState
    });
  };

  // Attach a freshly connected socket to an existing player record and make it
  // the live routing target for that player's session token.
  const bindSocketToToken = (room, token, playerId = null) => {
    room.sockets.add(socket.id);
    socket.data.roomId = room.roomId;
    socket.data.sessionToken = token;
    // A rejoined socket is identified the moment it's rebound: the token names
    // exactly one seat, so we can trust it without another handshake. This is
    // what makes turn-gated events work immediately after a refresh.
    if (playerId !== null && playerId !== undefined) socket.data.playerId = playerId;
    socket.join(room.roomId);
    socketToken.set(socket.id, token);
  };

  // ---------- LOBBY: CREATE A ROOM ----------
  socket.on('room:create', (payload, ack) => {
    if (socket.data.roomId) leaveRoom(socket);

    const roomId = generateRoomCode();
    const room = getOrCreateRoom(roomId, socket.id);
    room.sockets.add(socket.id);
    socket.data.roomId = roomId;
    socket.join(roomId);

    // Issue a durable session token for the host and remember who the host is
    // by token (not socket id), so the role survives a reconnect.
    const token = createSessionToken(room, 1);
    room.hostToken = token;
    socketToken.set(socket.id, token);

    console.log(`🏗️  Room ${roomId} created by ${socket.id} (token ${token.slice(0, 8)}…)`);
    // A new room (and its host token) is meaningful state — persist it now so a
    // restart before the first move still recovers the room + host identity.
    persistRoom(room);
    emitRoomJoined(room, 'host', token);
    if (typeof ack === 'function') ack({ ok: true, roomId, token });
  });

  // ---------- LOBBY: JOIN AN EXISTING ROOM BY CODE ----------
  socket.on('room:join', (payload, ack) => {
    const requested = normalizeRoomCode(payload && payload.roomId);

    if (!requested) {
      const err = { ok: false, error: 'Enter a room code to join.' };
      socket.emit('room:error', err);
      if (typeof ack === 'function') ack(err);
      return;
    }

    const room = rooms.get(requested);
    if (!room) {
      const err = { ok: false, error: `No room found with code ${requested}.` };
      socket.emit('room:error', err);
      if (typeof ack === 'function') ack(err);
      return;
    }

    // Already in this room (e.g. a reconnect): just re-sync, don't double-add.
    if (socket.data.roomId && socket.data.roomId !== requested) leaveRoom(socket);

    // Someone's back before the grace period expired — keep the room alive.
    room.clearEmptyTimer();

    room.sockets.add(socket.id);
    socket.data.roomId = requested;
    socket.join(requested);

    // Issue a fresh session token for this guest. playerId is provisional here
    // (the client assigns real player slots) — the token is what matters.
    const token = createSessionToken(room, room.tokens.size + 1);
    socketToken.set(socket.id, token);

    // A new player seat + token is durable identity — write it through.
    persistRoom(room);
    console.log(`➡️  Socket ${socket.id} joined room ${requested} (${room.sockets.size} connected, token ${token.slice(0, 8)}…)`);
    emitRoomJoined(room, 'guest', token);
    socket.to(requested).emit('room:peer-joined', {
      socketId: socket.id,
      connectedCount: room.sockets.size
    });

    if (typeof ack === 'function') ack({ ok: true, roomId: requested, token });
  });

  // ---------- LOBBY: REJOIN WITH A SESSION TOKEN ----------
  // A reconnecting client sends the token it stored for this room. If the token
  // is still valid we rebind this new socket to the existing player record. If
  // it isn't (expired / wrong room / tampered), we tell the client so it can
  // fall back to a normal room:join.
  socket.on('player:rejoin', (payload, ack) => {
    const requested = normalizeRoomCode(payload && payload.roomId);
    const token = payload && payload.token;

    if (socket.data.roomId) leaveRoom(socket);

    const resolved = requested ? resolveSession(token, requested) : null;

    if (!resolved) {
      socketToken.delete(socket.id);
      const err = { ok: false, error: 'Unknown or expired session — join as a new player.', reason: 'no-session' };
      console.log(`♻️  Rejoin rejected for token ${String(token).slice(0, 8)}… in room ${requested || '(none)'}`);
      if (typeof ack === 'function') ack(err);
      return;
    }

    const { room, player } = resolved;
    bindSocketToToken(room, token, player.id);
    // A successful rejoin cancels any pending empty-room teardown. Done AFTER
    // binding (not before) so the socket is counted when we re-check emptiness.
    room.clearEmptyTimer();
    // A rejoined player is a real participant again — ensure the turn clock runs.
    room.ensureTurnClock(io);

    // Everything this player needs to pick up where they left off.
    const playerState = serializePlayerState(room, player);

    const role = room.hostToken === token ? 'host' : 'guest';
    console.log(`♻️  Socket ${socket.id} re-joined room ${room.roomId} as ${role} (token ${token.slice(0, 8)}…, restoring ${playerState.ownedProperties.length} propert${playerState.ownedProperties.length === 1 ? 'y' : 'ies'})`);
    emitRoomJoined(room, role, token, playerState);
    socket.to(room.roomId).emit('room:peer-joined', {
      socketId: socket.id,
      connectedCount: room.sockets.size
    });

    if (typeof ack === 'function') {
      ack({ ok: true, roomId: room.roomId, token, rejoined: true, playerId: player.id, playerState });
    }
  });

  // ---------- LOBBY: LEAVE ----------
  socket.on('room:leave', () => {
    const roomId = socket.data.roomId;
    leaveRoom(socket);
    socket.emit('room:left', { roomId });
  });

  // Client requests manual state synchronization for ITS room only.
  socket.on('game:request-sync', () => {
    const room = currentRoom();
    if (!room) {
      socket.emit('room:error', { ok: false, error: 'You are not in a room.' });
      return;
    }
    socket.emit('game:sync', serializeRoomState(room));
  });

  // ---------- IDENTITY: player:identify HANDSHAKE ----------
  // On connect/rejoin the client tells us which seat it is. This is the ONLY
  // way a socket acquires an acting identity, and it is tied to the socket's
  // session token: a client cannot claim to be someone else because the seat it
  // asks for must be free (not already bound to a different token). The server
  // then records socket.data.playerId, which every turn-gated validation trusts.
  //
  // Payload: { roomId, playerId?, token? }
  //   - token    : the durable session token issued on create/join/rejoin. If
  //                omitted we fall back to the token already bound to this socket
  //                (so a rebound rejoin socket needn't resend it).
  //   - playerId : the seat the client believes it holds. OPTIONAL — when omitted
  //                the server uses the seat already bound to the token. Either
  //                way the token is the anchor: a client cannot identify as a seat
  //                that a different token already holds.
  socket.on('player:identify', (payload, ack) => {
    const requested = normalizeRoomCode(payload && payload.roomId);
    const token = (payload && payload.token) || socket.data.sessionToken || socketToken.get(socket.id);

    if (!requested) {
      const err = { ok: false, code: 'BAD_PAYLOAD', error: 'player:identify needs a roomId.' };
      if (typeof ack === 'function') ack(err);
      return;
    }

    // The token must resolve to THIS room. This is the anti-impersonation core:
    // identity is anchored to the token, and the token names one room + one seat.
    const resolved = resolveSession(token, requested);
    if (!resolved) {
      const err = { ok: false, code: 'BAD_SESSION', error: 'Unknown or expired session — cannot identify.' };
      console.log(`🚫 Identify rejected: token ${String(token).slice(0, 8)}… not valid for room ${requested}`);
      if (typeof ack === 'function') ack(err);
      return;
    }

    const { room } = resolved;
    // Claimed seat = what the client asked for, or the seat its token already
    // owns. Never anything else — the token is the only source of truth.
    const claimedId = (payload && payload.playerId !== undefined && payload.playerId !== null)
      ? payload.playerId
      : resolved.playerId;

    // The seat must exist in the room.
    const player = findPlayer(room, claimedId);
    if (!player) {
      const err = { ok: false, code: 'UNKNOWN_PLAYER', error: `No player ${claimedId} in this room.` };
      if (typeof ack === 'function') ack(err);
      return;
    }

    // A seat can only be bound to ONE token. If a different live token already
    // holds this seat, refuse — otherwise a second client could hijack it.
    const seatedToken = player.sessionToken;
    if (seatedToken && seatedToken !== token) {
      const err = { ok: false, code: 'SEAT_TAKEN', error: `Player ${claimedId} is already claimed by another session.` };
      console.log(`🚫 Identify rejected: seat ${claimedId} already held by token ${String(seatedToken).slice(0, 8)}…`);
      if (typeof ack === 'function') ack(err);
      return;
    }

    // Bind this seat to the token atomically: update the player record and the
    // session lookup so the token genuinely owns the seat from now on. This also
    // fixes the provisional playerId a fresh guest was given on join.
    player.sessionToken = token;
    const session = sessions.get(token);
    if (session) session.playerId = claimedId;
    room.tokens.add(token);

    socket.data.playerId = claimedId;
    socket.data.roomId = room.roomId;
    socketToken.set(socket.id, token);

    // An identified player is a real game participant — make sure the turn
    // clock is ticking. Idempotent, so a second identify won't reset a live turn.
    room.ensureTurnClock(io);
    // The seat→token binding is durable identity: persist so a restart keeps the
    // mapping and a pre-restart token can still rejoin the same seat.
    persistRoom(room);

    console.log(`🪪 Socket ${socket.id} identified as Player ${claimedId} in room ${room.roomId} (token ${String(token).slice(0, 8)}…)`);
    if (typeof ack === 'function') {
      ack({
        ok: true,
        roomId: room.roomId,
        playerId: claimedId,
        currentTurnPlayerId: room.currentTurnPlayerId,
        turnDeadline: room.turnDeadline
      });
    }
  });

  // ===================== INPUT VALIDATION (ANTI-CHEAT) =====================
  // The server is the gatekeeper for anything that mutates room state. A
  // client can send whatever it likes, so every state-changing event is checked
  // BEFORE it's applied: illegal events are rejected with an explicit `ok:false`
  // ack and never broadcast or applied. Validation reads only server-side truth
  // (propertyOwnership/Houses, trades, activeAuction, and each player's money /
  // position as the server last recorded them).

  // Which player record does THIS socket control? Identity is established ONE
  // way only: the client completes the player:identify handshake, which the
  // server validates against the socket's session token. socket.data.playerId
  // is therefore a server-verified fact, not a client claim — a client cannot
  // assert a seat it doesn't hold the token for, because the token is bound to
  // a specific player record in `sessions`.
  //
  // Falls back to the token's own playerId (so a socket rebound by player:rejoin
  // is identified without a second handshake). Returns null when we genuinely
  // can't tell, in which case turn-gated events are REJECTED rather than trusted.
  const actingPlayerId = () => {
    if (socket.data.playerId !== undefined && socket.data.playerId !== null) return socket.data.playerId;
    // The token->session binding is the authoritative fallback: it can only ever
    // name the player this socket legitimately holds.
    const token = socketToken.get(socket.id) || socket.data.sessionToken;
    if (token) {
      const session = sessions.get(token);
      if (session) return session.playerId;
    }
    return null;
  };

  const findPlayer = (room, playerId) => room.players.find(p => p.id === playerId) || null;

  // The player whose turn it currently is, per SERVER state. This reads the
  // authoritative per-room field the server itself advances — never the
  // client-mirrored isCurrentPlayer flag (which a hostile client controls).
  // Returns null only when no turn has been seeded (empty room).
  const currentTurnPlayerId = (room) => room.currentTurnPlayerId;

  // Turn gate for a state-changing event. Returns a rejection payload when the
  // acting socket is not the player whose turn it is, or null when it's allowed.
  // `explicitPlayerId` (when the payload names a player) is cross-checked against
  // the socket's OWN identified seat so a client can't act AS another player.
  const turnGate = (room, ack, explicitPlayerId) => {
    const turnId = currentTurnPlayerId(room);
    const actorId = actingPlayerId();
    // No turn established yet (empty room) — nothing to enforce.
    if (turnId === null) return null;
    // We don't know who this socket is: refuse rather than guess. This is the
    // heart of the fix — an unidentified actor is not silently trusted.
    if (actorId === null) {
      return reject(ack, 'NOT_IDENTIFIED', 'Identify yourself with player:identify before acting.');
    }
    // The payload naming a different player than the socket's seat is an
    // impersonation attempt (spoofing playerId on the wire).
    if (explicitPlayerId !== undefined && explicitPlayerId !== null && explicitPlayerId !== actorId) {
      return reject(ack, 'NOT_YOUR_PLAYER', `You control player ${actorId}, not ${explicitPlayerId}.`);
    }
    if (turnId !== actorId) {
      return reject(ack, 'NOT_YOUR_TURN', `It is player ${turnId}'s turn, not ${actorId}'s.`);
    }
    return null;
  };

  const isOwnableTile = (tileId) => {
    // Server has no board table, so "ownable" = not one of the special non-tile
    // ids the client uses for corners/events. Ids here mirror BOARD_TILES: the
    // board is 0..39; 0 (START) and the corner/event ids aren't purchasable.
    if (!Number.isInteger(tileId) || tileId < 0 || tileId > 39) return false;
    return true;
  };

  const DICE_MIN = 2;
  const DICE_MAX = 12;

  // Distinct ack shapes so tests (and the client) can tell WHY something was
  // rejected — a bare `ok:false` hides which rule tripped.
  const reject = (ack, code, error) => {
    const payload = { ok: false, code, error };
    if (typeof ack === 'function') ack(payload);
    return payload;
  };

  // ===================== ROOM-SCOPED GAME EVENTS =====================
  // Every handler below scopes to `currentRoom()`. If a socket hasn't joined a
  // room yet, the event is dropped — we never fall back to a global broadcast.
  // This is what guarantees a move in room A can't reach room B.
  //
  // `room` is the room snapshot captured at handler start; `roomId` is the
  // channel we broadcast into for that room only.
  //
  // A handler returns `true` (or undefined) to accept, or a rejection payload
  // (from `reject`) to refuse. On refusal the event is neither applied nor
  // broadcast, so a rejected cheat can't corrupt room state or reach peers.
  const withRoom = (handler) => (data, ack) => {
    const room = currentRoom();
    if (!room) {
      if (typeof ack === 'function') ack({ ok: false, error: 'You are not in a room.' });
      return;
    }
    handler(room, room.roomId, data, ack);
  };

  // Player Movement & Roll Events
  // player:moved is the canonical position/money update. Rules enforced:
  //   - the playerId must exist in this room
  //   - the socket must be identified AS that player (no impersonation)
  //   - it must be that player's SERVER-tracked turn
  //   - position must be a real board index (0..39)
  //   - money must be a finite, non-negative number
  socket.on('player:moved', withRoom((room, roomId, data, ack) => {
    if (!data || data.playerId === undefined) {
      return reject(ack, 'BAD_PAYLOAD', 'player:moved needs a playerId.');
    }
    const player = findPlayer(room, data.playerId);
    if (!player) return reject(ack, 'UNKNOWN_PLAYER', `No player ${data.playerId} in this room.`);

    // Turn + identity gate against the server's authoritative turn.
    const gateError = turnGate(room, ack, data.playerId);
    if (gateError) return gateError;

    if (!Number.isInteger(data.position) || data.position < 0 || data.position > 39) {
      return reject(ack, 'BAD_POSITION', `Position ${data.position} is off the board (0-39).`);
    }
    if (data.money !== undefined && (!Number.isFinite(data.money) || data.money < 0)) {
      return reject(ack, 'BAD_MONEY', `Money ${data.money} is not a valid amount.`);
    }

    player.position = data.position;
    if (data.money !== undefined) player.money = data.money;
    socket.to(roomId).emit('player:moved', data);
    if (typeof ack === 'function') ack({ ok: true });
  }));

  // Two-player rent settlement. This exists because player:moved's turnGate only
  // lets a socket report state for ITS OWN seat, so the landing player's client
  // could never broadcast the OWNER's new balance (it would be rejected as
  // NOT_YOUR_PLAYER). Rather than loosen that gate — which would let a client
  // credit money to anyone — the server applies both sides itself here.
  // Rules enforced:
  //   - payerId must be the acting/turn player (same gate as every other action)
  //   - ownerId must actually own tileId per room.propertyOwnership (closes the
  //     spoofing gap: a hostile client can't claim rent for a tile it doesn't own)
  //   - amount must be a finite number > 0
  // KNOWN LIMITATION: the amount is NOT checked against the board's rent tables
  // (tile type / house count) — those live only in the frontend today. Proper
  // validation needs board data ported server-side, part of the eventual full
  // server-authoritative decision.
  socket.on('rent:paid', withRoom((room, roomId, data, ack) => {
    if (!data || data.payerId === undefined || data.ownerId === undefined || data.tileId === undefined) {
      return reject(ack, 'BAD_PAYLOAD', 'rent:paid needs payerId, ownerId and tileId.');
    }
    const payer = findPlayer(room, data.payerId);
    if (!payer) return reject(ack, 'UNKNOWN_PLAYER', `No player ${data.payerId} in this room.`);
    const owner = findPlayer(room, data.ownerId);
    if (!owner) return reject(ack, 'UNKNOWN_OWNER', `No player ${data.ownerId} in this room.`);
    if (data.payerId === data.ownerId) {
      return reject(ack, 'SAME_PLAYER', 'A player cannot pay rent to themselves.');
    }

    // Paying rent is a turn action: only the identified player on turn may pay.
    const gateError = turnGate(room, ack, data.payerId);
    if (gateError) return gateError;

    // Ownership is verified against SERVER state, not the client's claim.
    if (room.propertyOwnership[data.tileId] !== data.ownerId) {
      return reject(ack, 'NOT_OWNER', `Tile ${data.tileId} is not owned by player ${data.ownerId}.`);
    }
    if (!Number.isFinite(data.amount) || data.amount <= 0) {
      return reject(ack, 'BAD_AMOUNT', `Amount ${data.amount} must be a positive number.`);
    }

    // Debit payer (clamped at 0 like the rest of the codebase), credit owner.
    payer.money = Math.max(0, (Number.isFinite(payer.money) ? payer.money : 0) - data.amount);
    owner.money = (Number.isFinite(owner.money) ? owner.money : 0) + data.amount;
    // A rent payment changes two balances: a meaningful state change, persist it.
    persistRoom(room);
    console.log(`💰 Room ${roomId}: Player ${data.payerId} paid $${data.amount} rent to Player ${data.ownerId} (tile ${data.tileId})`);
    socket.to(roomId).emit('rent:paid', {
      payerId: data.payerId,
      ownerId: data.ownerId,
      tileId: data.tileId,
      payerMoney: payer.money,
      ownerMoney: owner.money,
    });
    if (typeof ack === 'function') ack({ ok: true });
  }));

  // Two-player position swap (Surprise card "swap places"). Same reasoning as
  // rent:paid — the acting client legitimately moves BOTH players, but
  // player:moved's gate would reject the emit for the non-acting one, so the
  // server performs the swap on its own copy and broadcasts once for both.
  // Rules enforced:
  //   - playerId must be the acting/turn player via turnGate
  //   - targetId must name a real player in this room, distinct from playerId
  socket.on('players:swapped', withRoom((room, roomId, data, ack) => {
    if (!data || data.playerId === undefined || data.targetId === undefined) {
      return reject(ack, 'BAD_PAYLOAD', 'players:swapped needs playerId and targetId.');
    }
    const player = findPlayer(room, data.playerId);
    if (!player) return reject(ack, 'UNKNOWN_PLAYER', `No player ${data.playerId} in this room.`);
    const target = findPlayer(room, data.targetId);
    if (!target) return reject(ack, 'UNKNOWN_TARGET', `No player ${data.targetId} in this room.`);
    if (data.playerId === data.targetId) {
      return reject(ack, 'SAME_PLAYER', 'A player cannot swap places with themselves.');
    }

    // Swapping is a turn action: only the identified player on turn may swap.
    const gateError = turnGate(room, ack, data.playerId);
    if (gateError) return gateError;

    // Swap the two positions on the server's copy.
    const temp = player.position;
    player.position = target.position;
    target.position = temp;
    // A swap changes two players' positions: persist it.
    persistRoom(room);
    console.log(`🔄 Room ${roomId}: Players ${data.playerId} and ${data.targetId} swapped places`);
    socket.to(roomId).emit('players:swapped', {
      playerId: data.playerId,
      targetId: data.targetId,
      playerPosition: player.position,
      targetPosition: target.position,
    });
    if (typeof ack === 'function') ack({ ok: true });
  }));

  // A roll must be within real two-dice range and be made by the player whose
  // turn it is. We don't trust a client-supplied total: it's recomputed.
  socket.on('player:rolled', withRoom((room, roomId, data, ack) => {
    if (!data || !Array.isArray(data.dice) || data.dice.length !== 2) {
      return reject(ack, 'BAD_PAYLOAD', 'player:rolled needs two dice values.');
    }
    const [a, b] = data.dice;
    const diceOk = [a, b].every(d => Number.isInteger(d) && d >= 1 && d <= 6);
    if (!diceOk) return reject(ack, 'BAD_DICE', `Dice ${JSON.stringify(data.dice)} are outside 1-6.`);

    const total = a + b;
    if (total < DICE_MIN || total > DICE_MAX) {
      return reject(ack, 'OUT_OF_RANGE', `Roll ${total} is outside the ${DICE_MIN}-${DICE_MAX} range.`);
    }
    // If the client sent a total, it must match the dice (catching "rolled 12"
    // with dice [1,1]).
    if (data.total !== undefined && data.total !== total) {
      return reject(ack, 'TOTAL_MISMATCH', `Total ${data.total} doesn't match dice ${total}.`);
    }

    // The roller must be the identified player whose server-tracked turn it is.
    const gateError = turnGate(room, ack, data.playerId);
    if (gateError) return gateError;

    // Record the roll as the server's memory of the last roll this turn, so a
    // subsequent player:moved can be range-checked against it if needed.
    room.lastRoll = { playerId: actingPlayerId(), total, at: Date.now() };

    socket.to(roomId).emit('player:rolled', { ...data, total });
    if (typeof ack === 'function') ack({ ok: true, total });
  }));

  socket.on('player:skill-card', withRoom((room, roomId, data) => {
    socket.to(roomId).emit('player:skill-card', data);
  }));

  // End-of-turn signal. The client says "my turn is over"; the SERVER decides
  // whether that's true and, if so, advances the authoritative turn itself. A
  // client can't advance someone else's turn (turnGate rejects) and can't skip
  // ahead by naming a next player — the server computes the next seat from its
  // own roster. The new turn is broadcast so every client repaints from truth.
  socket.on('turn:ended', withRoom((room, roomId, data, ack) => {
    const gateError = turnGate(room, ack, data && data.playerId);
    if (gateError) return gateError;

    // Advance through the shared turn path: this cancels the outgoing turn
    // clock, advances the turn, re-arms the clock for the new player, and
    // broadcasts turn:changed — identical to what a timeout produces.
    const nextId = room.beginTurn(io);
    console.log(`⏭️  Room ${roomId}: turn ended — now Player ${nextId}'s turn`);
    if (typeof ack === 'function') ack({ ok: true, currentTurnPlayerId: nextId, turnDeadline: room.turnDeadline });
  }));

  // Property & Upgrade Events
  // A purchase is legal only if: the tile is real and unowned, the buyer exists
  // and is standing on it, and they can afford it. Price comes from the payload
  // but is sanity-checked (must be a positive number); funds are checked against
  // the money the server has recorded for that player.
  socket.on('property:bought', withRoom((room, roomId, data, ack) => {
    if (!data || data.tileId === undefined || data.playerId === undefined) {
      return reject(ack, 'BAD_PAYLOAD', 'property:bought needs tileId and playerId.');
    }
    const player = findPlayer(room, data.playerId);
    if (!player) return reject(ack, 'UNKNOWN_PLAYER', `No player ${data.playerId} in this room.`);

    // A purchase is a turn action: only the identified player on turn may buy.
    const gateError = turnGate(room, ack, data.playerId);
    if (gateError) return gateError;

    if (!isOwnableTile(data.tileId)) {
      return reject(ack, 'BAD_TILE', `Tile ${data.tileId} is not a purchasable tile.`);
    }
    if (room.propertyOwnership[data.tileId] !== undefined) {
      return reject(ack, 'ALREADY_OWNED', `Tile ${data.tileId} is already owned.`);
    }
    // Must be standing on the tile being bought.
    if (player.position !== data.tileId) {
      return reject(ack, 'NOT_ON_TILE', `Player is on ${player.position}, not on tile ${data.tileId}.`);
    }

    const price = data.price !== undefined ? data.price : 0;
    if (!Number.isFinite(price) || price < 0) {
      return reject(ack, 'BAD_PRICE', `Price ${price} is not valid.`);
    }
    // Affordability is only enforceable once we know the player's money is
    // server-tracked (non-zero from a prior accepted move). A skint-but-unknown
    // player (money still 0 stub) is allowed; an explicit overspend is not.
    const knownMoney = Number.isFinite(player.money) ? player.money : null;
    if (knownMoney !== null && knownMoney > 0 && price > knownMoney) {
      return reject(ack, 'INSUFFICIENT_FUNDS', `Costs $${price} but player has $${knownMoney}.`);
    }

    room.propertyOwnership[data.tileId] = data.playerId;
    if (price > 0 && knownMoney !== null) player.money = knownMoney - price;
    // A purchase changes ownership + money: a meaningful state change, persist it.
    persistRoom(room);
    console.log(`🏠 Room ${roomId}: Tile ${data.tileId} purchased by Player ${data.playerId}`);
    socket.to(roomId).emit('property:bought', data);
    if (typeof ack === 'function') ack({ ok: true });
  }));

  // Only the tile's owner may build, on their own turn, and house counts must
  // be sane integers.
  socket.on('house:upgraded', withRoom((room, roomId, data, ack) => {
    if (!data || data.tileId === undefined) {
      return reject(ack, 'BAD_PAYLOAD', 'house:upgraded needs a tileId.');
    }
    // Building is a turn action gated by the server-tracked turn.
    const gateError = turnGate(room, ack, data.playerId);
    if (gateError) return gateError;

    if (!isOwnableTile(data.tileId)) {
      return reject(ack, 'BAD_TILE', `Tile ${data.tileId} is not a buildable tile.`);
    }
    if (!Number.isInteger(data.houses) || data.houses < 0 || data.houses > 5) {
      return reject(ack, 'BAD_HOUSE_COUNT', `House count ${data.houses} must be 0-5.`);
    }
    const owner = room.propertyOwnership[data.tileId];
    // Identity is the socket's verified seat, never a client-asserted playerId.
    const actorId = actingPlayerId();
    if (owner === undefined) {
      return reject(ack, 'NOT_OWNED', `Tile ${data.tileId} has no owner to upgrade.`);
    }
    if (actorId !== null && owner !== actorId) {
      return reject(ack, 'NOT_OWNER', `Tile ${data.tileId} belongs to player ${owner}, not ${actorId}.`);
    }
    room.propertyHouses[data.tileId] = data.houses;
    // A build changes the board permanently — persist it.
    persistRoom(room);
    socket.to(roomId).emit('house:upgraded', data);
    if (typeof ack === 'function') ack({ ok: true });
  }));

  // Player Elimination / Kick Events
  // A player may only declare THEMSELVES bankrupt (you can't knock out a rival).
  socket.on('player:bankrupt', withRoom((room, roomId, data, ack) => {
    if (!data || data.playerId === undefined) {
      return reject(ack, 'BAD_PAYLOAD', 'player:bankrupt needs a playerId.');
    }
    const p = findPlayer(room, data.playerId);
    if (!p) return reject(ack, 'UNKNOWN_PLAYER', `No player ${data.playerId} in this room.`);

    const actorId = actingPlayerId();
    if (actorId !== null && actorId !== data.playerId) {
      return reject(ack, 'NOT_SELF', `Player ${actorId} cannot bankrupt player ${data.playerId}.`);
    }

    p.isBankrupt = true;
    // Clear owned properties
    for (const [tileId, ownerId] of Object.entries(room.propertyOwnership)) {
      if (ownerId === data.playerId) {
        delete room.propertyOwnership[tileId];
        delete room.propertyHouses[tileId];
      }
    }
    // An elimination changes the roster + board permanently — persist it.
    persistRoom(room);
    socket.to(roomId).emit('player:bankrupt', data);
    if (typeof ack === 'function') ack({ ok: true });
  }));

  socket.on('player:kicked', withRoom((room, roomId, data) => {
    socket.to(roomId).emit('player:kicked', data);
  }));

  // Trading System Events
  // A trade is only valid if BOTH sides exist and each actually owns every tile
  // they're offering, with enough cash to cover any money in the deal. Validated
  // at creation; re-validated at accept (the world may have changed since).
  const validateTrade = (room, t) => {
    if (!t || !t.id) return { code: 'BAD_PAYLOAD', error: 'Trade needs an id.' };
    if (!t.initiatorId || !t.targetId || t.initiatorId === t.targetId) {
      return { code: 'BAD_PARTIES', error: 'Trade needs two distinct players.' };
    }
    const initiator = findPlayer(room, t.initiatorId);
    const target = findPlayer(room, t.targetId);
    if (!initiator || !target) {
      return { code: 'UNKNOWN_PLAYER', error: 'Both trade parties must exist in this room.' };
    }

    const initiatorTiles = Array.isArray(t.initiatorPropertyIds) ? t.initiatorPropertyIds : [];
    const targetTiles = Array.isArray(t.targetPropertyIds) ? t.targetPropertyIds : [];

    // Each offered tile must really belong to the player offering it.
    for (const tileId of initiatorTiles) {
      if (room.propertyOwnership[tileId] !== t.initiatorId) {
        return { code: 'NOT_OWNER', error: `Player ${t.initiatorId} does not own tile ${tileId}.` };
      }
    }
    for (const tileId of targetTiles) {
      if (room.propertyOwnership[tileId] !== t.targetId) {
        return { code: 'NOT_OWNER', error: `Player ${t.targetId} does not own tile ${tileId}.` };
      }
    }

    const initiatorMoney = Number(t.initiatorMoney) || 0;
    const targetMoney = Number(t.targetMoney) || 0;
    if (initiatorMoney < 0 || targetMoney < 0) {
      return { code: 'BAD_MONEY', error: 'Trade money cannot be negative.' };
    }
    // Cash must be on hand (only enforceable once money is server-tracked).
    if (initiator.money > 0 && initiatorMoney > initiator.money) {
      return { code: 'INSUFFICIENT_FUNDS', error: `Player ${t.initiatorId} offered $${initiatorMoney} but has $${initiator.money}.` };
    }
    if (target.money > 0 && targetMoney > target.money) {
      return { code: 'INSUFFICIENT_FUNDS', error: `Player ${t.targetId} offered $${targetMoney} but has $${target.money}.` };
    }
    return null; // valid
  };

  socket.on('trade:created', withRoom((room, roomId, trade, ack) => {
    const bad = validateTrade(room, trade);
    if (bad) return reject(ack, bad.code, bad.error);

    room.trades = [trade, ...room.trades.filter(t => t.id !== trade.id)];
    // An active trade is durable state — persist so it survives a restart.
    persistRoom(room);
    socket.to(roomId).emit('trade:created', trade);
    if (typeof ack === 'function') ack({ ok: true });
  }));

  socket.on('trade:updated', withRoom((room, roomId, trade, ack) => {
    const bad = validateTrade(room, trade);
    if (bad) return reject(ack, bad.code, bad.error);

    room.trades = room.trades.map(t => t.id === trade.id ? trade : t);
    persistRoom(room);
    socket.to(roomId).emit('trade:updated', trade);
    if (typeof ack === 'function') ack({ ok: true });
  }));

  socket.on('trade:accepted', withRoom((room, roomId, data, ack) => {
    if (!data || !data.trade) {
      return reject(ack, 'BAD_PAYLOAD', 'trade:accepted needs a trade.');
    }
    const t = data.trade;
    // Re-validate against CURRENT state: a tile may have changed hands or a
    // player may have spent the cash since the trade was proposed.
    const bad = validateTrade(room, t);
    if (bad) return reject(ack, bad.code, bad.error);

    // Transfer only after validation, so a bad trade can't half-apply.
    room.trades = room.trades.map(x => x.id === t.id ? { ...x, status: 'accepted' } : x);
    for (const tileId of t.initiatorPropertyIds) room.propertyOwnership[tileId] = t.targetId;
    for (const tileId of t.targetPropertyIds) room.propertyOwnership[tileId] = t.initiatorId;

    const initiator = findPlayer(room, t.initiatorId);
    const target = findPlayer(room, t.targetId);
    const im = Number(t.initiatorMoney) || 0;
    const tm = Number(t.targetMoney) || 0;
    if (initiator && initiator.money > 0) initiator.money = initiator.money - im + tm;
    if (target && target.money > 0) target.money = target.money - tm + im;

    // Trade completion moves money AND tiles — one of the clearest "meaningful
    // state change" cases the phase called out. Persist it.
    persistRoom(room);
    socket.to(roomId).emit('trade:accepted', data);
    if (typeof ack === 'function') ack({ ok: true });
  }));

  socket.on('trade:rejected', withRoom((room, roomId, data, ack) => {
    if (!data || !data.tradeId) {
      return reject(ack, 'BAD_PAYLOAD', 'trade:rejected needs a tradeId.');
    }
    if (!room.trades.some(t => t.id === data.tradeId)) {
      return reject(ack, 'UNKNOWN_TRADE', `No trade ${data.tradeId} in this room.`);
    }
    room.trades = room.trades.map(t => t.id === data.tradeId ? { ...t, status: 'rejected' } : t);
    persistRoom(room);
    socket.to(roomId).emit('trade:rejected', data);
    if (typeof ack === 'function') ack({ ok: true });
  }));

  socket.on('trade:cancelled', withRoom((room, roomId, data, ack) => {
    if (!data || !data.tradeId) {
      return reject(ack, 'BAD_PAYLOAD', 'trade:cancelled needs a tradeId.');
    }
    if (!room.trades.some(t => t.id === data.tradeId)) {
      return reject(ack, 'UNKNOWN_TRADE', `No trade ${data.tradeId} in this room.`);
    }
    room.trades = room.trades.filter(t => t.id !== data.tradeId);
    persistRoom(room);
    socket.to(roomId).emit('trade:cancelled', data);
    if (typeof ack === 'function') ack({ ok: true });
  }));

  // Real-Time Chat Engine
  socket.on('chat:message', withRoom((room, roomId, msg) => {
    if (msg && msg.text) {
      room.addChatMessage(msg);
      console.log(`💬 [Room ${roomId}] ${msg.senderName}: ${msg.text}`);
    }
    socket.to(roomId).emit('chat:message', msg);
  }));

  // Auction System Events
  socket.on('auction:start', withRoom((room, roomId, data, ack) => {
    if (!data || !data.auction) {
      return reject(ack, 'BAD_PAYLOAD', 'auction:start needs an auction.');
    }
    if (room.activeAuction) {
      return reject(ack, 'AUCTION_IN_PROGRESS', 'An auction is already running in this room.');
    }
    if (!isOwnableTile(data.auction.tileId)) {
      return reject(ack, 'BAD_TILE', `Tile ${data.auction.tileId} cannot be auctioned.`);
    }
    if (room.propertyOwnership[data.auction.tileId] !== undefined) {
      return reject(ack, 'ALREADY_OWNED', `Tile ${data.auction.tileId} is already owned.`);
    }
    room.activeAuction = { ...data.auction, timeLeft: data.auction.timeLeft || 15 };
    room.startAuctionTimer(io);
    // Auction START is a lifecycle boundary worth persisting. Individual bids
    // are high-frequency and deliberately NOT persisted (write amplification for
    // transient state); the live auction object is saved on start/end.
    persistRoom(room);
    console.log(`🔨 Room ${roomId}: Auction started for Tile ${data.auction.tileId}`);
    socket.to(roomId).emit('auction:start', data);
    if (typeof ack === 'function') ack({ ok: true });
  }));

  // A bid is legal only if: an auction is live, the bidder is a real player who
  // hasn't passed, the bid strictly beats the current bid, and they can cover it.
  socket.on('auction:bid', withRoom((room, roomId, data, ack) => {
    if (!data || !data.auction) {
      return reject(ack, 'BAD_PAYLOAD', 'auction:bid needs an auction.');
    }
    const live = room.activeAuction;
    if (!live) return reject(ack, 'NO_AUCTION', 'There is no active auction.');

    const incoming = data.auction;
    if (incoming.id !== live.id) {
      return reject(ack, 'STALE_AUCTION', 'Bid is for a different auction than the live one.');
    }
    const bidderId = incoming.highestBidderId;
    const bidder = findPlayer(room, bidderId);
    if (!bidder) return reject(ack, 'UNKNOWN_PLAYER', `No player ${bidderId} to bid.`);

    if (Array.isArray(live.passedPlayerIds) && live.passedPlayerIds.includes(bidderId)) {
      return reject(ack, 'ALREADY_PASSED', `Player ${bidderId} already passed on this auction.`);
    }

    const newBid = Number(incoming.currentBid);
    if (!Number.isFinite(newBid)) {
      return reject(ack, 'BAD_BID', `Bid ${incoming.currentBid} is not a number.`);
    }
    if (newBid <= Number(live.currentBid)) {
      return reject(ack, 'BID_TOO_LOW', `Bid $${newBid} must exceed the current bid $${live.currentBid}.`);
    }
    if (bidder.money > 0 && newBid > bidder.money) {
      return reject(ack, 'INSUFFICIENT_FUNDS', `Player ${bidderId} can't cover a $${newBid} bid with $${bidder.money}.`);
    }

    room.activeAuction = { ...incoming, timeLeft: 15 }; // Reset timer to 15s on new bid
    room.startAuctionTimer(io);
    console.log(`🔨 Room ${roomId}: Bid $${incoming.currentBid} by Player ${bidderId}`);
    socket.to(roomId).emit('auction:bid', data);
    if (typeof ack === 'function') ack({ ok: true });
  }));

  // Passing: the auction must be live and the passer must be a real player.
  socket.on('auction:pass', withRoom((room, roomId, data, ack) => {
    if (!data || !data.auction) {
      return reject(ack, 'BAD_PAYLOAD', 'auction:pass needs an auction.');
    }
    const live = room.activeAuction;
    if (!live) return reject(ack, 'NO_AUCTION', 'There is no active auction.');
    if (data.auction.id !== live.id) {
      return reject(ack, 'STALE_AUCTION', 'Pass is for a different auction than the live one.');
    }
    const passedIds = Array.isArray(data.auction.passedPlayerIds) ? data.auction.passedPlayerIds : [];
    for (const pid of passedIds) {
      if (!findPlayer(room, pid)) {
        return reject(ack, 'UNKNOWN_PLAYER', `Passed list includes unknown player ${pid}.`);
      }
    }
    room.activeAuction = data.auction;
    socket.to(roomId).emit('auction:pass', data);
    if (typeof ack === 'function') ack({ ok: true });
  }));

  socket.on('auction:end', withRoom((room, roomId, data, ack) => {
    if (!data || !data.auction) {
      return reject(ack, 'BAD_PAYLOAD', 'auction:end needs an auction.');
    }
    room.clearAuctionTimer();
    const winnerId = data.auction.highestBidderId;
    if (winnerId !== null && winnerId !== undefined) {
      // Only award to a real player, and never overwrite an existing owner.
      const winner = findPlayer(room, winnerId);
      if (!winner) {
        return reject(ack, 'UNKNOWN_PLAYER', `Winner ${winnerId} is not in this room.`);
      }
      if (room.propertyOwnership[data.auction.tileId] === undefined) {
        room.propertyOwnership[data.auction.tileId] = winnerId;
      }
    }
    room.activeAuction = null;
    // Auction END settles ownership — persist the outcome.
    persistRoom(room);
    socket.to(roomId).emit('auction:end', data);
    if (typeof ack === 'function') ack({ ok: true });
  }));

  // Generic Passthrough Fallback — also room-scoped. Lobby/room-control events
  // are excluded so they never get re-broadcast as game traffic.
  socket.onAny((event, ...args) => {
    const internalEvents = [
      'room:create', 'room:join', 'player:rejoin', 'player:identify', 'room:leave',
      'player:moved', 'player:rolled', 'player:skill-card', 'turn:ended', 'property:bought',
      'rent:paid', 'players:swapped',
      'house:upgraded', 'player:bankrupt', 'player:kicked', 'trade:created',
      'trade:updated', 'trade:accepted', 'trade:rejected', 'trade:cancelled',
      'chat:message', 'auction:start', 'auction:bid', 'auction:pass', 'auction:end',
      'game:request-sync', 'disconnect'
    ];
    if (internalEvents.includes(event)) return;

    const roomId = socket.data.roomId;
    if (!roomId) return; // not in a room → nothing to broadcast to
    socket.to(roomId).emit(event, ...args);
  });

  // Socket Disconnection — hands its room back if it was the last member incl.
  // the host, and notifies only the peers in that same room.
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    leaveRoom(socket);
    console.log(`🔴 Socket disconnected: ${socket.id}${roomId ? ` (was in Room ${roomId})` : ' (lobby)'}`);
  });
});

// Start Server on Port 3001. Restore persisted rooms FIRST, before we accept a
// single connection, so a restart re-adopts in-progress games rather than
// letting them be silently replaced by a fresh empty room of the same code.
const PORT = process.env.PORT || 3001;
restorePersistedRooms();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`================================================`);
  console.log(`🚀 Monopoly Multiplayer Server running on http://localhost:${PORT}`);
  console.log(`📡 Socket.IO Real-time Engine active on port ${PORT}`);
  console.log(`================================================`);
});