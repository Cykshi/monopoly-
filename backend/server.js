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
// The shared numeric/string guards. `isMoneyAmount` in particular is the check
// that treats $0 as a VALID balance rather than as "unknown", which is what
// closed the old "skip affordability at zero" hole in the trade path.
const { isMoneyAmount, normalizeChatText, normalizeId } = require('./game/validation');
// The SERVER'S board: tile types, official purchase prices, rent tables, house
// and hotel costs. Every money-moving decision the server makes reads its
// numbers from here — never from a client payload. This is the module that
// makes "buy California for $0" impossible.
const board = require('./game/board');
const cards = require('./game/cards');

const app = express();

const isProduction = process.env.NODE_ENV === 'production';
const allowedOrigins = isProduction
  ? (process.env.CLIENT_URL ? process.env.CLIENT_URL.split(',').map((url) => url.trim()) : [])
  : [
      process.env.CLIENT_URL,
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3001',
      'http://localhost:3002',
      'http://127.0.0.1:3002',
      'http://localhost:3099',
      'http://127.0.0.1:3099'
    ].filter(Boolean);

const corsOriginHandler = (origin, callback) => {
  // Allow requests with no origin (such as mobile apps, server-to-server, curl, tests)
  if (!origin) return callback(null, true);

  if (isProduction) {
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origin ${origin} not allowed by CORS`));
  }

  // Development: allow explicit list or any localhost/127.0.0.1 origin
  if (
    allowedOrigins.includes(origin) ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  ) {
    return callback(null, true);
  }

  return callback(new Error(`Origin ${origin} not allowed by CORS`));
};

app.use(cors({
  origin: corsOriginHandler,
  credentials: true
}));
app.use(express.json());

const server = http.createServer(app);

// Initialize Socket.io server with CORS enabled
const io = new Server(server, {
  cors: {
    origin: corsOriginHandler,
    methods: ["GET", "POST"],
    credentials: true
  }
});

// ================= AUTHORITATIVE DICE =================
// The one and only source of a dice value. The client never supplies dice, so
// this is not a fairness mechanism against a hostile client (there is nothing
// for them to influence) — it is simply the server deciding the roll.
function rollD6() {
  return Math.floor(Math.random() * 6) + 1;
}

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
    // ===== AUTHORITATIVE REST HOUSE POT =====
    // The accumulated shared pot (fines, fees, etc.). Rest House pays this out;
    // Club fees accumulate into it.
    this.pot = 0;
    this.restHousePot = 0;
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
    // When the current turn began (epoch ms), and the deadline derived from it.
    // Both are the server's own clock values — never supplied by a client.
    this.turnStartedAt = null;
    this.turnDeadline = null; // epoch ms when the current turn times out (for clients)
    // The deadline startTurnTimer() most recently armed with, staged for the next
    // turn:changed broadcast. undefined = no new turn was armed (see beginTurn).
    this.nextTurnDeadline = undefined;
    this.turnToken = 0;       // monotonic guard so a stale timer can't fire late
    // ===== ACTION IDEMPOTENCY =====
    // Every mutating action a client may send twice carries a client-generated
    // `actionId` (a string). `processedActions` remembers the ids this room has
    // already applied, so a replayed frame — the same movement re-sent, a
    // duplicate purchase, a retry after a flaky reconnect — is DROPPED instead
    // of applied a second time. This is the ONLY replay defence: it is keyed on
    // an id the client supplies but the server records, so the client cannot
    // re-use an id to get a second mutation (a re-used id is a no-op, not a
    // fresh action). Bounded below so a long game can't grow it without limit.
    //
    // Deliberately NOT persisted: a replay can only happen on a live socket, and
    // a restart tears every socket down, so the set can safely start empty.
    this.processedActions = new Set();
    this.actionSeq = 0;       // how many actions this room has applied
    // ===== AUTHORITATIVE DICE / MOVEMENT =====
    // The SERVER rolls the dice. This is the ONE place a roll is decided; the
    // client only asks for a roll and is TOLD the result. A client-supplied
    // `dice`/`total` is never read, so "roll a 12" is not a thing a client can
    // do. See rollDiceFor() and the player:rolled handler.
    //
    // The shape is deliberately explicit about WHO rolled and WHETHER the result
    // has been spent, because movement is derived from it:
    //   { playerId, dice: [d1, d2], total, kind, seq, consumed, at }
    // `consumed` is the single-use latch that makes "move twice from one roll"
    // impossible; `seq` bumps on every roll so a stale reference can be spotted.
    this.lastRoll = null;
    this.rollSeq = 0;         // monotonic counter, one per roll issued
    // Grace-period timer: armed when the LAST socket leaves, so a lone player
    // refreshing their own tab can still rejoin. Cleared on any return or when
    // the room is torn down. Kept here so teardown has one place to clear it.
    this.emptyTimer = null;
    // Set the first time anyone actually rolls. The lobby is only a lobby until
    // then, so this is what freezes name/colour editing — the server's own view
    // of "has the game begun", not a client flag. Persisted so a restart mid-game
    // doesn't silently reopen the roster for editing.
    this.isGameStarted = false;
    // The room's player CEILING (2..6). Deliberately a maximum rather than a
    // required headcount: the game may start with any count from 2 up to this,
    // and room:join refuses once this many real seats exist.
    this.maxPlayers = MAX_PLAYERS_DEFAULT;
    // Set when the game is over and who won. `isGameOver` is the single flag the
    // turn clock checks, so a finished game can never keep ticking.
    this.winnerId = null;
    this.winnerReason = null;
    this.isGameOver = false;
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
        this.settleAuction(io);
      } else {
        io.to(this.roomId).emit('auction:tick', { auction: this.activeAuction });
      }
    }, 1000);
  }

  // Server-authoritative auction settlement.
  // Called by BOTH timer completion and auction:end socket events.
  //
  // Atomic and safe against double-charging:
  // 1. Identifies the authoritative winning player from server auction state.
  // 2. Verifies the winning bid is affordable against winner's current balance.
  // 3. Deducts the winning bid from winner.money.
  // 4. Assigns property ownership ONLY after successful payment.
  // 5. Persists and broadcasts updated money + ownership.
  // 6. Clears activeAuction and cancels the timer so settlement executes at most once.
  settleAuction(io) {
    if (!this.activeAuction || this.activeAuction._settled) {
      return null;
    }

    // Mark settled and clear timer immediately to prevent re-entry / double-charge
    this.activeAuction._settled = true;
    this.clearAuctionTimer();

    const live = this.activeAuction;
    this.activeAuction = null;

    const winnerId = live.highestBidderId;
    const tileId = live.tileId;
    const winningBid = Number(live.currentBid);

    let winner = null;
    let successfulPayment = false;

    if (winnerId !== null && winnerId !== undefined) {
      winner = this.players.find((p) => p.id === winnerId) || null;
      if (winner && !winner.isBankrupt) {
        const knownMoney = Number.isFinite(winner.money) ? winner.money : 0;
        const validBid = Number.isFinite(winningBid) && winningBid >= 0;
        const canAfford = validBid && knownMoney >= winningBid;
        const unowned = this.propertyOwnership[tileId] === undefined;

        if (canAfford && unowned) {
          winner.money = knownMoney - winningBid;
          this.propertyOwnership[tileId] = winner.id;
          successfulPayment = true;
        }
      }
    }

    const settledAuction = {
      ...live,
      timeLeft: 0,
      highestBidderId: successfulPayment && winner ? winner.id : null,
    };
    delete settledAuction._settled;

    // Persist meaningful state change (ownership + money)
    persistRoom(this);

    const payload = {
      auction: settledAuction,
      winnerId: settledAuction.highestBidderId,
      tileId,
      currentBid: winningBid,
      winnerMoney: (successfulPayment && winner) ? winner.money : (winner ? winner.money : null),
      propertyOwnership: this.propertyOwnership,
    };

    if (io) {
      io.to(this.roomId).emit('auction:end', payload);
    }

    console.log(`🔨 Room ${this.roomId}: Auction ended. Winner: Player ${settledAuction.highestBidderId ?? 'None'}` +
      (successfulPayment ? ` for $${winningBid} (new balance $${winner.money})` : ' (no sale)'));

    return {
      settled: settledAuction,
      successfulPayment,
      winnerId: settledAuction.highestBidderId,
      tileId,
      winnerMoney: payload.winnerMoney,
    };
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
  //
  // Gated on the game ACTUALLY having started: in the lobby/pre-game state there
  // is nothing to time out, and after a game-over there is nobody left to time
  // out either. Without these two guards a player merely identifying in the
  // lobby would arm a clock that eliminates them before the game even began.
  ensureTurnClock(io) {
    if (this.isGameOver) return;
    if (this.isGameStarted !== true) return;
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

  // ===== AUTHORITATIVE DICE =====
  // Roll one six-sided die. Kept as a single named helper so the randomness has
  // exactly one home (the project's existing approach is Math.random(); there is
  // no crypto requirement here because the dice are no longer a client input and
  // the server is the only party that reads them).
  //
  // Roll the pair, stamp WHO rolled it, and store it as the room's authoritative
  // roll. `kind` records WHY the roll exists so the movement path can validate
  // the distance it derives:
  //   'dice' - a normal two-dice turn roll (total 2..12)
  //   'card' - a Movement Card spend (total = the card's chosen distance)
  // A card distance of 0 is refused by the caller, so every stored roll has a
  // positive total and therefore always moves the player at least one tile.
  //
  // The previous roll is REPLACED, which is what makes a roll single-use: once a
  // new roll exists, the old one can no longer be spent (its `seq` is stale and
  // the new record is not yet consumed).
  rollDiceFor(playerId, kind = 'dice', total = null) {
    const dice = kind === 'card'
      ? [total, 0]
      : [rollD6(), rollD6()];
    const resolvedTotal = kind === 'card' ? total : dice[0] + dice[1];
    this.rollSeq += 1;
    this.lastRoll = {
      playerId,
      dice,
      total: resolvedTotal,
      kind,
      seq: this.rollSeq,
      consumed: false,
      at: Date.now(),
    };
    return this.lastRoll;
  }

  // Cancel any unspent roll. Called when the turn changes: a roll belongs to the
  // turn it was made in, so the next player must not be able to spend the
  // previous player's roll (and the previous player must not be able to move
  // after their turn has ended).
  clearRoll() {
    this.lastRoll = null;
  }

  // ===== ACTION IDEMPOTENCY =====
  // Claim `actionId` for this room. Returns:
  //   'new'         - never seen; the caller MAY apply the action
  //   'duplicate'   - already applied; the caller MUST drop it
  //   'malformed'   - not a usable id; the caller MUST reject
  //
  // The id is claimed BEFORE the mutation, so two frames arriving back-to-back
  // cannot both pass the check: Node runs these handlers one at a time, and the
  // first claim is already recorded when the second looks. Claiming before
  // applying is what makes the guarantee hold even if the mutation itself later
  // fails validation — a rejected action still burns its id, so a client cannot
  // retry the same id with different values and get a second look.
  claimAction(actionId) {
    if (typeof actionId !== 'string' || !actionId) return 'malformed';
    // Bounded so a hostile client can't send an unbounded-length id.
    if (actionId.length > MAX_ACTION_ID_LEN) return 'malformed';
    if (this.processedActions.has(actionId)) return 'duplicate';
    this.processedActions.add(actionId);
    this.actionSeq += 1;
    // Cap the remembered set: the OLDEST ids fall out first. A replay that
    // arrives after this many newer actions would be re-applied — acceptable,
    // because a legitimate retry happens within a round-trip, and this keeps a
    // long game's memory bounded. Set iteration order is insertion order, so
    // the first entry is genuinely the oldest.
    if (this.processedActions.size > MAX_REMEMBERED_ACTIONS) {
      const oldest = this.processedActions.values().next().value;
      this.processedActions.delete(oldest);
    }
    return 'new';
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
        // A roll belongs to the turn it was made in. Moving the turn on retires
        // it, so the outgoing player can no longer spend it and the incoming
        // player cannot spend someone else's. Cleared here — the single place a
        // turn advances — so both the normal turn:ended path and the timeout
        // path retire the roll identically.
        this.clearRoll();
        // A turn change invalidates any pending timeout for the PREVIOUS turn.
        // It must be cancelled HERE, while currentTurnPlayerId is already the new
        // player, because handleTurnTimeout() eliminates whoever holds the turn
        // when it fires. Without this, a timer armed for player A (deadline still
        // in the future) survives A ending its turn normally and later eliminates
        // a live player — guilt-free. Re-arming the new turn wipes the same state,
        // so cancel-then-arm is idempotent (see startTurnTimer).
        this.clearTurnTimer();
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
    this.nextTurnDeadline = undefined;
    this.turnStartedAt = null;
    // Bumping the token invalidates any timer callback that already queued.
    this.turnToken += 1;
  }

  // Arm the turn clock for the CURRENT turn. On expiry the server forces the
  // turn forward itself, via the SAME advanceTurn() path a normal turn:ended
  // uses — there is no second turn-advance mechanism. `onTimeout(room)` is the
  // callback that performs the forced advance + broadcast (it needs `io`, which
  // the room doesn't hold).
  startTurnTimer(onTimeout) {
    // Never arm for a finished game or one that hasn't begun: either way there is
    // no live turn to expire, and arming would eliminate someone spuriously.
    // Ordered BEFORE clearTurnTimer() deliberately. clearTurnTimer() bumps
    // turnToken, and advanceTurn() relies on that bump to invalidate the outgoing
    // turn's timer. This early return must therefore NOT bump the token: when a
    // turn times out the room is flagged game-over and the deadline it was
    // clearing is still the one the caller must publish as null.
    if (this.isGameOver) return;
    if (this.isGameStarted !== true) return;
    if (this.currentTurnPlayerId === null) return; // no one to time out
    this.clearTurnTimer();
    const myToken = this.turnToken;
    const startedAt = Date.now();
    const deadline = startedAt + TURN_TIME_LIMIT_MS;
    // `turnStartedAt` is the DURABLE "when did this turn begin" stamp, and
    // `turnDeadline` is derived from it. Both are persisted, so a restart can
    // recompute how much of the turn is left instead of advertising a deadline
    // that only made sense in the previous process. TURN_TIME_LIMIT_MS is the
    // single authoritative duration; nothing else may invent one.
    this.turnStartedAt = startedAt;
    // Recorded on the room AND staged for the turn:changed broadcast. Screens and
    // sends are separated because startTurnTimer() may decline to arm a turn at
    // all (finished game), in which case the caller must publish null — a
    // deadline for a turn that will never expire would hang every client clock.
    this.nextTurnDeadline = deadline;
    this.turnDeadline = deadline;
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
    // A finished game has no next turn to begin — bail before touching the clock.
    if (this.isGameOver) return;
    const nextId = this.advanceTurn();
    this.startTurnTimer((room) => handleTurnTimeout(room, io));
    // A turn transition is a meaningful state change: persist here so BOTH a
    // normal turn:ended and a timeout save the new turn in one place.
    persistRoom(this);
    // Read the deadline the timer actually armed with (not room.turnDeadline —
    // see nextTurnDeadline on the class), so a finished game advertises null
    // rather than a stale deadline left over from the turn that just expired.
    const deadline = this.nextTurnDeadline;
    this.nextTurnDeadline = undefined;
    io.to(this.roomId).emit('turn:changed', {
      currentTurnPlayerId: nextId,
      turnDeadline: deadline
    });
    return nextId;
  }
}

// Global rooms map: roomCode -> GameRoom
const rooms = new Map();

// NOTE: there is deliberately NO empty-room grace period any more. When the last
// player leaves a room, its session is ended immediately and every token for it is
// invalidated (see leaveRoom/teardownRoom), so the next visit always starts from
// scratch: lobby -> name -> colour -> a brand-new room code. The only remaining
// TTL is the longer one below, which applies solely to rooms restored from disk
// at boot (those have no players connected yet by definition).
// How long a room RESTORED FROM DISK (at boot) waits for someone to come back
// before it too is reaped. Longer than a live room because players need time to
// notice the server restarted and reconnect — but it is ALWAYS armed, so a
// restored room nobody ever rejoins can't leak its file or its in-memory entry.
const RESTORED_ROOM_TTL_MS = Number(process.env.RESTORED_ROOM_TTL_MS) || 15 * 60 * 1000; // 15 min default
// How long a player has to take their turn before the SERVER forces it forward.
// Mirrors the client's TURN_TIME_LIMIT (120s). Env-overridable so tests can use
// a short clock instead of waiting two minutes per turn.
const TURN_TIME_LIMIT_MS = Number(process.env.TURN_TIME_LIMIT_MS) || 120 * 1000; // 120s default
// Bounds for the per-action idempotency key. The id is client-supplied so both
// its LENGTH and the number of ids we remember must be capped: without the
// first, one frame could carry a multi-megabyte string; without the second, a
// long game would grow the room's memory without limit.
const MAX_ACTION_ID_LEN = 80;
const MAX_REMEMBERED_ACTIONS = 512;
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

  // A timeout on an already-finished game must be inert. The clock is cancelled
  // when a winner is declared, so this is belt-and-braces against a callback
  // that was already queued when the game ended.
  if (room.isGameOver) return;

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

  // ADVANCE FIRST, THEN EVALUATE THE WIN CONDITION.
  //
  // Order matters and is the whole point of this block. beginTurn() is what
  // recomputes the authoritative turn from the roster AFTER the elimination, so
  // the turn must move before we ask "is the game over?". Doing it the other way
  // round is a real bug: with two players, eliminating one leaves exactly one
  // "active" player, which reads as last-player-standing and ends the game —
  // even though the survivor is still owed the rest of the match. The survivor
  // would win by timeout rather than by play, and currentTurnPlayerId would be
  // left pointing at the bankrupt seat, so every subsequent action was rejected
  // as NOT_YOUR_TURN (and the eliminated player's own actions still accepted).
  room.beginTurn(io);

  // LAST PLAYER STANDING, evaluated on the post-advance roster. Only a game
  // where literally nobody else can take a turn is over. `room.tokens` is what
  // separates "left the game" from "still playing": a disconnected player's
  // token is dropped from the room, so a seat that vanished can't keep a
  // one-sided game alive forever.
  const activePlayers = room.players.filter(
    p => !p.isBankrupt && room.tokens.has(p.sessionToken || '')
  );
  if (activePlayers.length === 1) {
    declareWinner(room, io, activePlayers[0], 'last-player-standing');
  } else if (activePlayers.length === 0) {
    // Nobody holds a seat any more — nobody left to win.
    room.isGameOver = true;
    room.winnerId = null;
    room.winnerReason = 'abandoned';
    room.clearTurnTimer();
    room.clearAuctionTimer();
    persistRoom(room);
    io.to(room.roomId).emit('game:over', { winnerId: null, winnerName: null, reason: 'abandoned' });
  }
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

  // ===== COMPATIBILITY: BACKFILL MONEY, NEVER RESET IT =====
  // Rooms persisted before the server owned starting money have their seats
  // saved at money: 0, because the client used to hold the real balance and the
  // server's copy was only ever overwritten by player:moved. Those rooms would
  // restore with every player broke.
  //
  // The distinction that matters: an ABSENT balance is backfilled; a PRESENT one
  // is left exactly as it was. A player who genuinely has $0 — because they spent
  // it, or went bankrupt — must NOT be handed a fresh $1500 by a restart. So the
  // test is `Number.isFinite(money)`, not `money === 0`.
  for (const player of room.players) {
    if (!player || typeof player !== 'object') continue;
    if (!Number.isFinite(player.money)) {
      player.money = board.STARTING_MONEY;
    }
    if (typeof player.inJail !== 'boolean') {
      player.inJail = false;
    }
    if (!Number.isInteger(player.jailTurns) || player.jailTurns < 0) {
      player.jailTurns = 0;
    }
    if (typeof player.hasSkillCard !== 'boolean') {
      player.hasSkillCard = true;
    }
    if (typeof player.isResting !== 'boolean') {
      player.isResting = false;
    }
  }
  room.pot = Number.isFinite(data.pot) ? data.pot : (Number.isFinite(data.restHousePot) ? data.restHousePot : 0);
  room.restHousePot = room.pot;
  room.propertyOwnership = data.propertyOwnership || {};
  room.propertyHouses = data.propertyHouses || {};
  room.trades = Array.isArray(data.trades) ? data.trades : [];
  room.activeAuction = data.activeAuction || null;
  room.currentTurnPlayerId = data.currentTurnPlayerId ?? null;
  room.turnSeeded = !!data.turnSeeded;
  // Restore the turn clock so a restart resumes the SAME turn window. If the
  // stored deadline has already passed (the process was down longer than the
  // remaining turn time), we do NOT hand out a fresh window: we clear the stamp
  // so the first ensureTurnClock() re-arms a full turn for whoever holds it.
  // That is the same outcome the timeout would have produced, without needing
  // the players to be connected for the timer to fire.
  const restoredDeadline = Number.isFinite(data.turnDeadline) ? data.turnDeadline : null;
  if (restoredDeadline !== null && restoredDeadline > Date.now()) {
    room.turnStartedAt = Number.isFinite(data.turnStartedAt) ? data.turnStartedAt : null;
    room.turnDeadline = restoredDeadline;
  } else {
    room.turnStartedAt = null;
    room.turnDeadline = null;
  }
  room.isGameStarted = !!data.isGameStarted;
  room.maxPlayers = Number.isInteger(data.maxPlayers)
    ? Math.min(MAX_PLAYERS_LIMIT, Math.max(MIN_PLAYERS, data.maxPlayers))
    : MAX_PLAYERS_DEFAULT;
  room.isGameOver = !!data.isGameOver;
  room.winnerId = data.winnerId ?? null;
  room.winnerReason = data.winnerReason ?? null;
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

// ================= PLAYER NAME / COLOR =================
// The one fixed palette a player may pick from. This MUST stay in lockstep with
// PLAYER_COLOR_PALETTE in frontend/app/page.tsx: the client renders these exact
// swatches and the server is the authority on which are already taken. A colour
// outside this list is refused, so a hostile client can't invent a hue that
// collides visually with someone else's token.
const PLAYER_COLOR_PALETTE = [
  '#F4A6C0', // Baby Pink
  '#E32636', // Crimson Red
  '#00A86B', // Emerald Green
  '#8E44AD', // Wildberry Purple
  '#2196F3', // Deep Sky Blue
  '#FFEB3B', // Yellow
  '#FF9800', // Orange
  '#00BCD4', // Cyan (turquoise-leaning)
  '#CDDC39', // Lime (yellow-green)
];

const PLAYER_NAME_MAX = 20;

// Longest chat message the server will accept and store. Caps both the wire
// payload and the retained history; a client cannot post an unbounded blob.
const CHAT_TEXT_MAX = 280;

// Player-count bounds for a room. MIN is what a game needs to be playable at
// all; MAX is the absolute ceiling any room may configure.
const MAX_PLAYERS_DEFAULT = 6;
const MAX_PLAYERS_LIMIT = 6;
const MIN_PLAYERS = 2;

// A "seat" is a player the server has actually created a record for. The seeded
// template players a client renders don't exist here, which is what makes this
// the honest measure of how full a room really is.
function seatedCount(room) {
  return room.players.filter(p => p.sessionToken).length;
}

// Normalize an incoming name to its canonical stored form, or return null when
// it isn't usable. Callers decide whether null is fatal (set-name rejects) or
// merely means "fall back to the default" (create/join).
function normalizePlayerName(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Cap length AFTER trimming so trailing spaces can't eat the budget.
  return trimmed.slice(0, PLAYER_NAME_MAX);
}

// Case-insensitive because the client may echo back '#8B5CF6'; the stored form is
// always the palette's lowercase canonical value.
function normalizePlayerColor(raw) {
  if (typeof raw !== 'string') return null;
  const wanted = raw.trim().toLowerCase();
  return PLAYER_COLOR_PALETTE.find(c => c.toLowerCase() === wanted) || null;
}

// Who, if anyone, in this room already holds `color`? A null/undefined colour is
// "not chosen yet" and never counts as a conflict, so the seeded default players
// don't block the first real pick. `exceptPlayerId` lets a player re-pick the
// colour they already hold without tripping their own conflict check.
function colorHolder(room, color, exceptPlayerId = null) {
  if (!color) return null;
  const wanted = color.toLowerCase();
  return room.players.find(
    p => p.id !== exceptPlayerId &&
      typeof p.color === 'string' &&
      p.color.toLowerCase() === wanted
  ) || null;
}

// Issue a token AND seed the player record it identifies, so a later rejoin can
// find the player by token. The record starts as a minimal stub; the client
// fills in name/color/etc. as the game runs. Rejoin is about IDENTITY, not yet
// about restoring the full game state.
//
// MONEY IS SEEDED HERE, by the server. This is the ONE place a seat's starting
// balance is decided. The client used to own STARTING_MONEY (it rendered 1500
// locally and reported it on player:moved), which meant the server's copy began
// at 0 and only became real once the client told it a number — i.e. the client
// was authoritative over starting cash. It is not any more: the value comes from
// the board module, and player:moved no longer accepts money at all.
function createSessionToken(room, playerId, { name, color } = {}) {
  // Colour arrives pre-validated (see the create/join handlers). We re-check
  // here anyway so the invariant "a stored colour is always from the palette"
  // holds no matter which call path seeded the record.
  const safeColor = normalizePlayerColor(color);
  const token = crypto.randomUUID();
  const player = {
    id: playerId,
    sessionToken: token,
    name: normalizePlayerName(name) || `Player ${playerId}`,
    color: safeColor,
    // Set once the player has finished the lobby step (name + colour) and is
    // actually in the room. From that moment their NAME is fixed for good — a
    // stricter lock than the game-start one, because the name is the identity
    // everyone reads in the log/roster and shouldn't mutate mid-lobby.
    // Colour stays editable until the game starts.
    hasEntered: false,
    // Authoritative starting balance, straight from the rules module. A player
    // record is NEVER created with a caller-supplied balance.
    money: board.STARTING_MONEY,
    position: 0,
    isCurrentPlayer: playerId === 1,
    mood: 'happy',
    inJail: false,
    jailTurns: 0,
    hasSkillCard: true,
    isResting: false
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

// ===== WIN CONDITION =====
// Last player standing. Called after ANY elimination. If exactly one non-bankrupt
// player remains, they have won and the game is over — we don't wait for any
// further condition. Returns the winner (or null).
//
// There is deliberately ONE win path: this reads the same `isBankrupt` flags the
// existing elimination logic already maintains, and reuses the room's existing
// turn-clock teardown. No parallel win-detection system.
function findSoleSurvivor(room) {
  const alive = room.players.filter(p => !p.isBankrupt);
  return alive.length === 1 ? alive[0] : null;
}

// Declare a winner: stamp the room, stop every clock, persist, and broadcast the
// SAME `game:over` event the client's existing win overlay listens for.
function declareWinner(room, io, winner, reason) {
  if (room.winnerId !== null && room.winnerId !== undefined) return null; // already over
  room.winnerId = winner.id;
  room.winnerReason = reason;
  room.isGameOver = true;
  // Reuse the existing turn-clock teardown — never a second mechanism.
  room.clearTurnTimer();
  room.clearAuctionTimer();
  persistRoom(room);
  io.to(room.roomId).emit('game:over', {
    winnerId: winner.id,
    winnerName: winner.name,
    reason,
  });
  console.log(`🏆 Room ${room.roomId}: GAME OVER — ${winner.name} (Player ${winner.id}) wins by ${reason}`);
  return winner;
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

// Player records carry `sessionToken`, which is the durable credential that owns
// the seat — anyone holding it can player:rejoin as that player. It must NEVER
// reach another client, so every roster we put on the wire goes through here.
// `hasSeat` replaces it with the only thing clients legitimately need to know:
// whether this is a real, server-created seat (as opposed to a client-side
// placeholder for a player who hasn't joined yet).
function publicPlayer(player) {
  const { sessionToken, ...rest } = player;
  // `hasEntered` is exposed so the client can lock its own name input to match
  // the server's NAME_LOCKED rule — never as a substitute for it.
  return { ...rest, hasSeat: !!sessionToken };
}

function publicPlayers(room) {
  return room.players.map(publicPlayer);
}

// Snapshot of everything a client needs to render the room on first join.
function serializeRoomState(room) {
  return {
    roomId: room.roomId,
    hostId: room.hostId,
    connectedCount: room.sockets.size,
    players: publicPlayers(room),
    propertyOwnership: room.propertyOwnership,
    propertyHouses: room.propertyHouses,
    // The authoritative turn, so a client can render whose turn it is from the
    // server's truth rather than inferring it from a stale local flag.
    currentTurnPlayerId: room.currentTurnPlayerId,
    // So a (re)joining client knows whether the roster is still editable — the
    // picker renders read-only once the game has begun.
    isGameStarted: room.isGameStarted === true,
    // Game-over state, so a rejoining client repaints the win overlay instead of
    // sitting on a frozen board with no explanation.
    isGameOver: room.isGameOver === true,
    winnerId: room.winnerId ?? null,
    winnerReason: room.winnerReason ?? null,
    // The room's player ceiling, so the client renders "N / max" and can tell
    // when the room is full without guessing.
    maxPlayers: room.maxPlayers ?? MAX_PLAYERS_DEFAULT,
    // When the current turn times out (epoch ms), so the UI countdown is driven
    // by the server's clock rather than a client-side guess.
    turnDeadline: room.turnDeadline,
    trades: room.trades,
    chatMessages: room.chatMessages,
    activeAuction: room.activeAuction,
    pot: room.pot ?? 0,
    restHousePot: room.pot ?? 0
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
    me: publicPlayer(player),
    players: publicPlayers(room),
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
    chatMessages: room.chatMessages,
    pot: room.pot ?? 0,
    restHousePot: room.pot ?? 0
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
  // ===== CLEAR THE ACTING IDENTITY TOO =====
  // `playerId` is only meaningful INSIDE the room it was bound in, and ids are
  // small integers reused by every room. Leaving it set meant a socket that moved
  // to another room still carried the seat number it held in the old one, so an
  // action naming that number could resolve to a completely different player in
  // the new room. Identity is per-room, so it is dropped with the room.
  socket.data.playerId = null;
  socket.data.sessionToken = null;

  if (!room) return;

  room.sockets.delete(socket.id);
  // Drop the live socket→token route. The token itself stays valid so the
  // player can be rebound to a NEW socket later via player:rejoin.
  socketToken.delete(socket.id);
  socket.to(roomId).emit('room:peer-left', { socketId: socket.id, connectedCount: room.sockets.size });

  if (room.isEmpty()) {
    // Nobody is here to take a turn, so the turn clock must not keep ticking:
    // disarm it now rather than let it fire an elimination for an empty room.
    room.clearTurnTimer();

    // LAST PLAYER GONE -> END THE SESSION NOW.
    // Every session in this room is finished, so we reap it immediately instead
    // of waiting out a grace window. Two things must die together:
    //   1. the room itself (in memory + on disk), and
    //   2. every session token, so a stale localStorage token in any browser
    //      cannot resolve back to a seat and drag someone into this dead room.
    // teardownRoom() already does both (it deletes each token from `sessions`,
    // drops the room, and removes the persisted file), so we reuse it rather than
    // adding a second mechanism. The result: the next visit starts from the very
    // beginning — lobby, name, colour picker, brand-new room code.
    //
    // NOTE: this is deliberately NOT the old grace-period behaviour. A refresh
    // used to be able to rejoin inside 90s; now an empty room is gone at once, so
    // a player who wants their seat back must not fully disconnect.
    teardownRoom(room);
    console.log(`🧹 Room ${roomId} was left by its last player — session ended`);
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
    // by token (not socket id), so the role survives a reconnect. The name the
    // host typed on the lobby screen is bound here, in the SAME identity path —
    // there is no separate name-registration step to keep in sync.
    const token = createSessionToken(room, 1, { name: payload && payload.name });
    room.hostToken = token;
    socketToken.set(socket.id, token);
    // The host owns seat 1 by server decree — createSessionToken() just created
    // that record with exactly this token — so the binding is already proven and
    // we record it here. Without this the host would hold a token but no acting
    // identity until it separately called player:identify.
    socket.data.playerId = 1;

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

    // ===== ONE ROOM PER SOCKET =====
    // A socket that is already seated somewhere must LEAVE first. Previously this
    // handler called leaveRoom() and then carried on, which let a socket hop
    // rooms by emitting room:join again — and, more importantly, let a client
    // reach into a room it was not a member of. There is no legitimate flow that
    // joins a second room without leaving the first, so this is refused rather
    // than silently obeyed. Use room:leave (or player:rejoin for a reconnect).
    if (socket.data.roomId) {
      const err = {
        ok: false,
        code: 'ALREADY_IN_ROOM',
        error: 'You are already in a room. Leave it before joining another.',
      };
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
    // NOTE: the `leaveRoom` that used to sit here is gone — see the ONE ROOM PER
    // SOCKET guard at the top of this handler.

    // CAPACITY CHECK. A room is full when it already holds as many real seats as
    // its configured ceiling. Checked here (server-side) because a client could
    // otherwise keep joining past the cap. Note the ceiling is a MAXIMUM, not a
    // required headcount: joining fewer than max is always fine.
    const alreadyInThisRoom = socket.data.roomId === requested;
    if (!alreadyInThisRoom && seatedCount(room) >= room.maxPlayers) {
      const err = {
        ok: false,
        code: 'ROOM_FULL',
        error: `Room ${requested} is full (${room.maxPlayers} player${room.maxPlayers === 1 ? '' : 's'} max).`
      };
      socket.emit('room:error', err);
      if (typeof ack === 'function') ack(err);
      return;
    }

    // Someone's back before the grace period expired — keep the room alive.
    room.clearEmptyTimer();

    room.sockets.add(socket.id);
    socket.data.roomId = requested;
    socket.join(requested);

    // Issue a fresh session token for this guest. playerId is provisional here
    // (the client assigns real player slots) — the token is what matters. The
    // typed name rides along on the same call so the record is born with it.
    const token = createSessionToken(room, room.tokens.size + 1, { name: payload && payload.name });
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
    const room = roomId ? rooms.get(roomId) : null;
    const leaverId = actingPlayerId();
    // Capture BEFORE leaveRoom() drops the socket, so we still know who left.
    const wasInGame = !!(room && room.isGameStarted && !room.isGameOver);

    leaveRoom(socket);
    socket.emit('room:left', { roomId });

    // A player leaving a LIVE game is an elimination: they're gone for good
    // (leaving drops their session token, so they cannot rejoin this seat).
    // Mark them bankrupt so the survivor logic below and the board agree.
    // Done AFTER leaveRoom so the departing socket isn't counted.
    if (wasInGame && room && leaverId !== null) {
      // ===== THE ROOM MAY ALREADY BE GONE =====
      // leaveRoom() tears a room down the moment its last socket leaves, and that
      // teardown deletes the room from `rooms` AND removes its persisted file.
      // The elimination logic below then used to call persistRoom(room) on that
      // dead object, which RECREATED the file for a room that no longer exists —
      // an orphan on disk that came back on the next boot. Bail out early when the
      // room is already torn down; there is nothing left to eliminate or persist.
      if (!rooms.has(room.roomId)) return;

      const leaver = room.players.find(p => p.id === leaverId);
      if (leaver && !leaver.isBankrupt) {
        leaver.isBankrupt = true;
        leaver.money = 0;
        for (const [tileId, ownerId] of Object.entries(room.propertyOwnership)) {
          if (ownerId === leaver.id) {
            delete room.propertyOwnership[tileId];
            delete room.propertyHouses[tileId];
          }
        }
        io.to(room.roomId).emit('player:bankrupt', { playerId: leaver.id, reason: 'left' });
        persistRoom(room);

        // Nobody left to play: the game is over with no winner. Tearing the
        // clocks down here reuses the same teardown path as a real win.
        const stillSeated = room.players.filter(
          p => !p.isBankrupt && room.tokens.has(p.sessionToken || '')
        );
        if (stillSeated.length === 0) {
          room.isGameOver = true;
          room.winnerId = null;
          room.winnerReason = 'abandoned';
          room.clearTurnTimer();
          room.clearAuctionTimer();
          persistRoom(room);
          io.to(room.roomId).emit('game:over', {
            winnerId: null,
            winnerName: null,
            reason: 'abandoned'
          });
          console.log(`🏳️ Room ${room.roomId}: every player left — game over (abandoned)`);
        } else {
          // Otherwise the normal last-player-standing rule may now be satisfied.
          const survivor = findSoleSurvivor(room);
          if (survivor) declareWinner(room, io, survivor, 'last-player-standing');
        }
      }
    }
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
  // Payload: { roomId, playerId?, token?, name? }
  //   - token    : the durable session token issued on create/join/rejoin. If
  //                omitted we fall back to the token already bound to this socket
  //                (so a rebound rejoin socket needn't resend it).
  //   - playerId : the seat the client believes it holds. OPTIONAL — when omitted
  //                the server uses the seat already bound to the token. Either
  //                way the token is the anchor: a client cannot identify as a seat
  //                that a different token already holds.
  //   - name     : OPTIONAL initial display name. Applied on the SAME identity
  //                binding below so "who am I" and "what am I called" are set in
  //                one server round-trip rather than two racing paths.
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

    // Apply an initial name if one was supplied. Only overwrite when the incoming
    // name is actually usable, so a re-identify with no name can't wipe a name
    // the player already chose. Colours are deliberately NOT set here — they go
    // through player:set-color, which is the only place that can enforce
    // "nobody else holds this colour" atomically.
    const identifiedName = normalizePlayerName(payload && payload.name);
    if (identifiedName) player.name = identifiedName;

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
        name: player.name,
        color: player.color,
        currentTurnPlayerId: room.currentTurnPlayerId,
        turnDeadline: room.turnDeadline
      });
    }
  });

  // ---------- GAME: START THE TURN CLOCK (pre-game, first roll) ----------
  // The clock is armed on the first roll (see player:rolled). A client that
  // needs the deadline BEFORE rolling — e.g. to render a countdown for the
  // opening turn — can ask for it here. Read-only: it never arms or advances
  // anything, so it cannot be used to extend or steal a turn.
  socket.on('game:turn-deadline', (data, ack) => {
    const room = currentRoom();
    if (!room) {
      if (typeof ack === 'function') ack({ ok: false, code: 'NOT_IN_ROOM', error: 'You are not in a room.' });
      return;
    }
    if (typeof ack === 'function') {
      ack({
        ok: true,
        currentTurnPlayerId: room.currentTurnPlayerId,
        turnDeadline: room.turnDeadline,
        turnRemainingMs: room.turnDeadline === null ? null : Math.max(0, room.turnDeadline - Date.now())
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
  //
  // ===== IDENTIFICATION IS AN EXPLICIT BINDING, NOT MERE TOKEN POSSESSION =====
  // `sessions` maps a token to a seat the moment room:create / room:join issues
  // it, so a joined-but-unidentified socket ALREADY has a session entry. Reading
  // that entry as "this socket is identified" made every freshly-joined socket an
  // actor without ever completing the player:identify handshake — which is how a
  // socket that never identified could still chat and act.
  //
  // So the fallback is gated on `socket.data.playerId` having been set by a real
  // binding (player:identify / player:rejoin, which both assign it). That flag is
  // the difference between "holds a token" and "has claimed the seat".
  const actingPlayerId = () => {
    // Set ONLY by player:identify and player:rejoin (via bindSocketToToken).
    // A socket that merely called room:create/room:join has it null, and so has
    // no acting identity until it identifies.
    if (socket.data.playerId !== undefined && socket.data.playerId !== null) return socket.data.playerId;
    return null;
  };

  const findPlayer = (room, playerId) => room.players.find(p => p.id === playerId) || null;

  // ===== AUTHORITATIVE ACTOR =====
  // The player record this socket is authenticated as, or null. This is the ONLY
  // sanctioned way for a handler to learn "who is asking": identity comes from
  // the socket's session token (set by player:identify / player:rejoin), never
  // from a payload field.
  //
  // A handler that needs the actor MUST use this. Reading `data.playerId` to
  // decide whose money/property/turn is affected is the impersonation bug this
  // helper exists to make impossible.
  //
  // THE ROOM BINDING IS CHECKED HERE. `actingPlayerId()` returns the seat this
  // socket identified as, but that id is only meaningful inside the room the
  // socket is actually a member of. Without this check a socket sitting in room B
  // could send an action naming player 1 — a real seat in room A — and, since ids
  // are small integers reused across rooms, the lookup would find a player and
  // the action would be applied to a stranger's seat in a room it never joined.
  // Every handler reaches identity through here, so the check covers them all.
  const actorOf = (room) => {
    if (!room || socket.data.roomId !== room.roomId) return null;
    const id = actingPlayerId();
    return id === null ? null : findPlayer(room, id);
  };

  // Require an identified actor, and return a rejection when there isn't one.
  // Returns { actor } on success or { error } on refusal, so callers can do:
  //   const { actor, error } = requireActor(room, ack);
  //   if (error) return error;
  const requireActor = (room, ack) => {
    const actor = actorOf(room);
    if (!actor) {
      return { error: reject(ack, 'NOT_IDENTIFIED', 'Identify yourself with player:identify before acting.') };
    }
    if (isOutOfGame(actor)) {
      return { error: reject(ack, 'PLAYER_OUT', 'You are out of the game.') };
    }
    return { actor };
  };

  // Require the actor to be one of the named parties to a trade. A trade moves
  // money and property between exactly two seats, so only those two may create,
  // update, accept, reject or cancel it. Without this check ANY identified player
  // could settle someone else's deal — including accepting one on a victim's
  // behalf, which is the impersonation case this guards.
  const requireTradeParty = (room, ack, trade, { allowInitiator = true, allowTarget = true } = {}) => {
    const { actor, error } = requireActor(room, ack);
    if (error) return { error };
    if (!trade || typeof trade !== 'object') {
      return { error: reject(ack, 'BAD_PAYLOAD', 'Trade must be an object.') };
    }
    const isInitiator = trade.initiatorId === actor.id;
    const isTarget = trade.targetId === actor.id;
    if (allowInitiator && isInitiator) return { actor };
    if (allowTarget && isTarget) return { actor };
    return {
      error: reject(ack, 'NOT_TRADE_PARTY', 'Only the two players in this trade may act on it.')
    };
  };

  // Is this player still allowed to act at all? A bankrupt seat is out of the
  // game permanently, so no event may be accepted from it regardless of what the
  // turn pointer says. This is deliberately separate from the turn gate: a
  // bankrupt player who happens to still hold the turn pointer (e.g. the seat
  // that just timed out) must be refused, not merely "not on turn".
  const isOutOfGame = (player) => Boolean(player && player.isBankrupt);

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
    // We don't know who this socket is: refuse rather than guess. This is the
    // heart of the fix — an unidentified actor is not silently trusted.
    // Checked BEFORE the empty-turn escape below, so an unidentified socket can
    // never act on a room whose turn pointer happens to be null.
    if (actorId === null) {
      return reject(ack, 'NOT_IDENTIFIED', 'Identify yourself with player:identify before acting.');
    }
    // An eliminated seat is out of the game permanently, whatever the turn
    // pointer says. Checked before the null-turn escape for the same reason: a
    // bankrupt player must be refused even when no turn is established.
    const actor = findPlayer(room, actorId);
    if (actor && actor.isBankrupt) {
      return reject(ack, 'PLAYER_OUT', 'You are out of the game.');
    }
    // The payload naming a different player than the socket's seat is an
    // impersonation attempt (spoofing playerId on the wire).
    if (explicitPlayerId !== undefined && explicitPlayerId !== null && explicitPlayerId !== actorId) {
      return reject(ack, 'NOT_YOUR_PLAYER', `You control player ${actorId}, not ${explicitPlayerId}.`);
    }
    // No turn established yet (empty room) — nothing further to enforce.
    if (turnId === null) return null;
    if (turnId !== actorId) {
      return reject(ack, 'NOT_YOUR_TURN', `It is player ${turnId}'s turn, not ${actorId}'s.`);
    }
    return null;
  };

  // Ownability now comes from the SERVER'S board table (backend/game/board.js),
  // not from a bare 0..39 range. The old range check treated every square as
  // purchasable — including corners, TAX, TREASURE and SURPRISE — because the
  // server had no board data to consult. The board module is the single source
  // of truth for which tiles can be bought and what they cost.
  //
  // These are re-exported here so the handlers below read as one vocabulary;
  // they are the board module's functions, not local re-implementations.
  const { isOwnableTile, purchasePrice, isPropertyTile, buildCost, sellRefund } = board;

  // Replay gate for a MUTATING action. Runs AFTER turnGate (so identity and turn
  // ownership are already established) and BEFORE any state is touched.
  //
  // The client attaches an `actionId` to each action it may retry (a movement,
  // a purchase, a build, a rent settlement). We claim it once per room; a second
  // frame carrying the same id is dropped here, so the mutation and its ledger
  // entry happen exactly once even if the client re-sends or the transport
  // duplicates the frame.
  //
  // Returns a rejection payload when the action must not proceed, else null.
  const actionGate = (room, ack, actionId) => {
    const verdict = room.claimAction(actionId);
    if (verdict === 'new') return null;
    if (verdict === 'duplicate') {
      // Not an error the player should ever see in normal play (it means the
      // client retried); report it distinctly so a buggy client is diagnosable
      // instead of silently "succeeding" twice.
      return reject(ack, 'DUPLICATE_ACTION', 'That action was already applied.');
    }
    return reject(ack, 'BAD_ACTION_ID', 'This action is missing a usable actionId.');
  };

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

  // ---------- LOBBY: PICK A NAME / COLOUR ----------
  // These two live OUTSIDE withRoom() on purpose. withRoom() bails with a bare
  // {ok:false,error} when the socket isn't in a room yet, but the name/colour
  // step is the first thing a player does after joining — and it should give the
  // same explicit `code` shape as every other rejection. So we resolve the room
  // ourselves and use reject() throughout for one consistent ack contract.
  const lobbyPlayer = () => {
    const room = currentRoom();
    if (!room) return { error: reject(null, 'NOT_IN_ROOM', 'You are not in a room.') };
    const pid = actingPlayerId();
    if (pid === null) return { error: reject(null, 'NOT_IDENTIFIED', 'Identify yourself with player:identify first.') };
    const player = findPlayer(room, pid);
    if (!player) return { error: reject(null, 'UNKNOWN_PLAYER', `No player ${pid} in this room.`) };
    return { room, player };
  };

  // Once the game is running the roster is frozen: names and colours are locked
  // everywhere (lobby picker AND the in-game settings panel), because they're now
  // baked into tokens, ownership tints and the turn log. Same lock as the other
  // pre-start settings.
  const lobbyEditLocked = (room) => room.isGameStarted === true;

  socket.on('player:set-name', (data, ack) => {
    const { room, player, error } = lobbyPlayer();
    if (error) { if (typeof ack === 'function') ack(error); return; }

    if (lobbyEditLocked(room)) {
      return reject(ack, 'GAME_STARTED', 'Names are locked once the game has started.');
    }

    // STRICTER than the game-start lock: once this player has entered the room
    // (completed the lobby name+colour step), their name is permanent. The name
    // is the identity every other player reads in the roster and the action log,
    // so it must not drift once they've joined the table. Enforced here rather
    // than only hiding the input, so a client can't bypass it over the socket.
    if (player.hasEntered) {
      return reject(ack, 'NAME_LOCKED', 'Your name is locked once you enter the room.');
    }

    const name = normalizePlayerName(data && data.name);
    if (!name) {
      return reject(ack, 'BAD_NAME', 'Name must be a non-empty string.');
    }

    player.name = name;
    persistRoom(room);
    // Broadcast the FULL roster, not just this player: every client's settings
    // panel renders all names, so one payload keeps every panel in step.
    io.to(room.roomId).emit('room:players', serializeRoomState(room));
    console.log(`📝 Room ${room.roomId}: Player ${player.id} named "${name}"`);
    if (typeof ack === 'function') ack({ ok: true, name });
  });

  // The room's player ceiling. Only the host may set it, and only before the
  // game starts — changing capacity mid-game would let a late joiner into a
  // running match. Lowering the cap below the current headcount is allowed
  // (it just blocks any FURTHER joins); it never kicks anyone already inside.
  socket.on('player:set-max-players', (data, ack) => {
    const { room, player, error } = lobbyPlayer();
    if (error) { if (typeof ack === 'function') ack(error); return; }

    if (lobbyEditLocked(room)) {
      return reject(ack, 'GAME_STARTED', 'Max players is locked once the game has started.');
    }
    const hostToken = room.hostToken;
    const token = socketToken.get(socket.id) || socket.data.sessionToken;
    if (!hostToken || token !== hostToken) {
      return reject(ack, 'NOT_HOST', 'Only the host can change max players.');
    }

    const wanted = Number(data && data.maxPlayers);
    if (!Number.isInteger(wanted) || wanted < MIN_PLAYERS || wanted > MAX_PLAYERS_LIMIT) {
      return reject(ack, 'BAD_MAX_PLAYERS', `Max players must be ${MIN_PLAYERS}-${MAX_PLAYERS_LIMIT}.`);
    }

    room.maxPlayers = wanted;
    persistRoom(room);
    io.to(room.roomId).emit('room:players', serializeRoomState(room));
    console.log(`👥 Room ${room.roomId}: max players set to ${wanted} (${seatedCount(room)} seated)`);
    if (typeof ack === 'function') ack({ ok: true, maxPlayers: wanted });
  });

  socket.on('player:set-color', (data, ack) => {
    const { room, player, error } = lobbyPlayer();
    if (error) { if (typeof ack === 'function') ack(error); return; }

    if (lobbyEditLocked(room)) {
      return reject(ack, 'GAME_STARTED', 'Colours are locked once the game has started.');
    }

    // ===== PERMANENT LOCK =====
    // A colour, once chosen, is fixed for the rest of this player's session in
    // the room. There is deliberately NO re-pick path: the only way to get a
    // different colour is to leave the room entirely (which drops the session
    // token) and rejoin, landing back on the picker as a fresh player. Enforced
    // here, not by hiding the UI — a client can still call this event directly.
    if (player.color !== null && player.color !== undefined) {
      console.log(`🔒 Room ${room.roomId}: Player ${player.id} already holds ${player.color} — re-pick refused`);
      return reject(ack, 'COLOR_ALREADY_SET', 'Your colour is already set and cannot be changed.');
    }

    // Must be one of the fixed palette entries — no custom hex.
    const color = normalizePlayerColor(data && data.color);
    if (!color) {
      return reject(ack, 'BAD_COLOR', 'That colour is not part of the available palette.');
    }

    // The exclusivity rule. The check and the write below run synchronously with
    // no await between them, so two handlers racing for the same free colour
    // cannot interleave — exactly one wins and the other gets COLOR_TAKEN. This
    // scans ALL current players, so a colour held by anyone still in the room
    // (including someone temporarily disconnected inside the grace window, since
    // their record is still in room.players) is never handed to a second player.
    if (colorHolder(room, color, player.id)) {
      console.log(`🎨 Room ${room.roomId}: colour ${color} refused for Player ${player.id} (taken)`);
      return reject(ack, 'COLOR_TAKEN', `${color} is already taken by another player.`);
    }

    player.color = color;
    // Picking a colour is what completes the lobby entry step, so from here the
    // player's NAME is also locked (see player:set-name). Unlike before, the
    // COLOUR is now locked too — see the COLOR_ALREADY_SET check above.
    player.hasEntered = true;
    persistRoom(room);
    // Everyone gets the update so their pickers grey this swatch out live —
    // including the player who just took it, which is how their own UI settles.
    io.to(room.roomId).emit('room:players', serializeRoomState(room));
    console.log(`🎨 Room ${room.roomId}: Player ${player.id} took colour ${color}`);
    if (typeof ack === 'function') ack({ ok: true, color });
  });

  // Player Movement.
  //
  // ===== THE CLIENT ASKS TO MOVE; THE SERVER DECIDES WHERE =====
  // `player:moved` no longer accepts a destination. The client sends a request
  // to move (plus the usual idempotency `actionId`); the server computes the
  // destination itself from the AUTHORITATIVE roll it generated in
  // player:rolled:
  //
  //     newPosition = (player.position + lastRoll.total) % BOARD_SIZE
  //
  // This closed the "teleport" hole: a client that rolled 2 could previously
  // send `position: 39` and be moved to Boardwalk, because the position was
  // taken from the payload and only checked against the 0..39 board range. A
  // payload `position` is now ignored entirely — it is not read at all.
  //
  // Rules enforced:
  //   - the playerId must exist in this room
  //   - the socket must be identified AS that player (no impersonation)
  //   - it must be that player's SERVER-tracked turn
  //   - an UNSPENT authoritative roll must exist, belong to THIS player, and
  //     still be current (no new roll has been issued since)
  //   - that roll is CONSUMED here, so one roll can move a player exactly once
  //   - the destination is computed from server state only
  socket.on('player:moved', withRoom((room, roomId, data, ack) => {
    if (!data || data.playerId === undefined) {
      return reject(ack, 'BAD_PAYLOAD', 'player:moved needs a playerId.');
    }
    const player = findPlayer(room, data.playerId);
    if (!player) return reject(ack, 'UNKNOWN_PLAYER', `No player ${data.playerId} in this room.`);

    // Turn + identity gate against the server's authoritative turn.
    const gateError = turnGate(room, ack, data.playerId);
    if (gateError) return gateError;

    // A bankrupt seat is out of the game for good — refuse before anything else,
    // so an eliminated player can never keep acting on a stale turn pointer.
    if (isOutOfGame(player)) {
      return reject(ack, 'PLAYER_OUT', 'You are out of the game.');
    }

    // Replay gate: a movement may be retried by the client, but it must only
    // ever be applied once. Claimed before the position is written.
    const replayError = actionGate(room, ack, data.actionId);
    if (replayError) return replayError;

    // ===== THE ROLL IS THE ONLY SOURCE OF THE DISTANCE =====
    const roll = room.lastRoll;
    if (!roll) {
      return reject(ack, 'NO_ROLL', 'Roll the dice before moving.');
    }
    if (roll.playerId !== player.id) {
      return reject(ack, 'NOT_YOUR_ROLL', `The pending roll belongs to player ${roll.playerId}, not ${player.id}.`);
    }
    if (roll.consumed === true) {
      return reject(ack, 'ROLL_ALREADY_USED', 'That roll has already been used to move.');
    }
    if (!Number.isInteger(roll.total) || roll.total <= 0) {
      return reject(ack, 'BAD_ROLL', 'The pending roll has no usable distance.');
    }

    // ===== DESTINATION COMPUTED SERVER-SIDE =====
    // Wrapping is the same modular arithmetic the board has always used, so
    // "move past the last tile" comes round to tile 0 as before. Note there is
    // no client-supplied position anywhere in this expression.
    const from = Number.isInteger(player.position) ? player.position : 0;
    const raw = from + roll.total;
    const wrapped = ((raw % board.BOARD_SIZE) + board.BOARD_SIZE) % board.BOARD_SIZE;
    const passedGo = raw >= board.BOARD_SIZE;

    // Burn the roll: one roll, one move. Set BEFORE the write so that even a
    // pathological re-entry cannot spend it twice.
    roll.consumed = true;
    player.position = wrapped;

    // ===== SALARY IS CREDITED SERVER-SIDE =====
    // Passing GO pays PASS_START_BONUS, decided here from the server's own board
    // table. The amount is NOT read from the payload: a client that sends
    // `salary: 999999` is ignored. This was previously MISSING entirely — the
    // handler computed `passedGo` and told the client about it, but no money
    // moved, so the client (which applies its own PASS_START_BONUS for display)
    // showed a balance the server did not hold. The client is not the economy.
    let salary = 0;
    if (passedGo) {
      salary = board.PASS_START_BONUS;
      player.money = (Number.isFinite(player.money) ? player.money : 0) + salary;
      // Money moved, so the new balance is worth persisting with the position.
    }
    persistRoom(room);

    // ===== MONEY IS STILL NOT TAKEN FROM THE CLIENT =====
    // A `money` field on the payload is ignored, as before. The broadcast
    // carries the SERVER's balance so every peer renders truth.
    socket.to(roomId).emit('player:moved', {
      playerId: player.id,
      position: wrapped,
      from,
      passedGo,
      rollSeq: roll.seq,
      salary,
      // Overwrite whatever the client sent with the authoritative balance. A
      // peer must never be shown a balance the server did not agree to.
      money: player.money,
      inJail: player.inJail ?? false,
      jailTurns: player.jailTurns ?? 0,
    });
    if (typeof ack === 'function') {
      ack({
        ok: true,
        position: wrapped,
        from,
        passedGo,
        salary,
        rollSeq: roll.seq,
        money: player.money,
        inJail: player.inJail ?? false,
        jailTurns: player.jailTurns ?? 0,
      });
    }
  }));

  // Two-player rent settlement. This exists because player:moved's turnGate only
  // lets a socket report state for ITS OWN seat, so the landing player's client
  // could never broadcast the OWNER's new balance (it would be rejected as
  // NOT_YOUR_PLAYER). Rather than loosen that gate — which would let a client
  // credit money to anyone — the server applies both sides itself here.
  //
  // The AMOUNT IS NOT READ FROM THE PAYLOAD. It is computed here from the
  // server's own board table (backend/game/board.js): the tile's type, its rent
  // row indexed by the house count the server holds, and — for utility-style
  // tiles — how many of that type the owner actually has. A client that sends
  // `amount: 999999999` is ignored; a client that sends `amount: 0` is ignored.
  // This closed a live exploit where one frame transferred $999,999,999.
  //
  // Rules enforced:
  //   - payerId must be the acting/turn player (same gate as every other action)
  //   - payerId/ownerId must name real seats, and be distinct
  //   - the payer must be STANDING ON the tile (you cannot pay rent for a square
  //     you are not on)
  //   - ownerId must actually own tileId per room.propertyOwnership
  //   - the tile must be one the board says charges rent
  //   - the computed rent must be > 0, else there is nothing to settle
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

    // The tile must exist on the server's board.
    if (!board.isValidTileId(data.tileId)) {
      return reject(ack, 'BAD_TILE', `Tile ${data.tileId} is not on the board.`);
    }
    // Ownership is verified against SERVER state, not the client's claim.
    if (room.propertyOwnership[data.tileId] !== data.ownerId) {
      return reject(ack, 'NOT_OWNER', `Tile ${data.tileId} is not owned by player ${data.ownerId}.`);
    }
    // The payer must be ON the tile. Without this a player could pay rent from
    // anywhere on the board, settling charges for squares it never landed on.
    if (payer.position !== data.tileId) {
      return reject(ack, 'NOT_ON_TILE', `Player is on ${payer.position}, not on tile ${data.tileId}.`);
    }

    // ===== AUTHORITATIVE AMOUNT =====
    // Computed from the board + the server's ownership/house state. The
    // payload's `amount`, if present, is never consulted.
    const owed = board.landingCharge(
      data.tileId,
      payer.id,
      room.propertyOwnership,
      room.propertyHouses
    );
    if (!owed || owed.kind !== 'rent' || !(owed.amount > 0)) {
      return reject(ack, 'NO_RENT_DUE', `No rent is due on tile ${data.tileId}.`);
    }
    // The owner computed from server state must be the one the client named, so
    // a mismatch is reported rather than silently paying a different player.
    if (owed.ownerId !== data.ownerId) {
      return reject(ack, 'OWNER_MISMATCH', `Tile ${data.tileId} is owned by player ${owed.ownerId}.`);
    }
    const amount = owed.amount;

    // Replay gate: a duplicated rent frame would move money twice, so the id is
    // claimed before either balance is touched.
    const replayError = actionGate(room, ack, data.actionId);
    if (replayError) return replayError;

    // Debit the payer and credit the owner, both by the SERVER's amount. The
    // payer cannot go below zero (the existing rule), so the transfer is capped
    // at what they actually hold — which also stops a negative balance.
    const paid = Math.min(amount, Math.max(0, payer.money));
    payer.money = Math.max(0, payer.money - paid);
    owner.money += paid;
    // A rent payment changes two balances: a meaningful state change, persist it.
    persistRoom(room);
    console.log(`💰 Room ${roomId}: Player ${payer.id} paid $${paid} rent to Player ${owner.id} (tile ${data.tileId}, official $${amount})`);
    socket.to(roomId).emit('rent:paid', {
      payerId: payer.id,
      ownerId: owner.id,
      tileId: data.tileId,
      // The SERVER's amount, so every peer renders what was actually charged.
      amount: paid,
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

    // Replay gate: a duplicated swap would put the two tokens back where they
    // started, silently undoing the card.
    const replayError = actionGate(room, ack, data.actionId);
    if (replayError) return replayError;

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

  // ===================== AUTHORITATIVE CARD ENGINE =====================
  // Chance / Community Chest (Treasure / Surprise) card draw and resolution.
  //
  // The client asks to draw a card; the SERVER:
  //   1. Validates the acting socket's identity and turn (turnGate).
  //   2. Enforces replay idempotency via actionId (actionGate).
  //   3. Validates that the player is standing on a card tile (Treasure or Surprise).
  //   4. Rolls D6 on the server to determine the card drawn — never trusts client.
  //   5. Computes all rewards and penalties (bank payouts, luxury tax, dividend)
  //      authoritatively on the server. Client-supplied money/rewards are ignored.
  //   6. Computes and executes card movement (airport advance, forward 8, jail, swap)
  //      routing through the authoritative movement/landing pipeline.
  //   7. Awards GO passing salary if applicable.
  //   8. Persists the room state (player positions and balances).
  //   9. Broadcasts the authoritative card outcome (`card:drawn`) to the room.
  socket.on('card:draw', withRoom((room, roomId, data, ack) => {
    if (!data || data.playerId === undefined) {
      return reject(ack, 'BAD_PAYLOAD', 'card:draw needs a playerId.');
    }
    const player = findPlayer(room, data.playerId);
    if (!player) return reject(ack, 'UNKNOWN_PLAYER', `No player ${data.playerId} in this room.`);

    // Turn + identity gate against the server's authoritative turn.
    const gateError = turnGate(room, ack, data.playerId);
    if (gateError) return gateError;

    if (isOutOfGame(player)) {
      return reject(ack, 'PLAYER_OUT', 'You are out of the game.');
    }

    // Replay gate: card actionId must be unique and not reused
    const replayError = actionGate(room, ack, data.actionId);
    if (replayError) return replayError;

    // Check player is standing on a card tile on the authoritative board
    const currentPos = Number.isInteger(player.position) ? player.position : 0;
    if (!cards.isCardTile(currentPos)) {
      return reject(ack, 'NOT_ON_CARD_TILE', `Player is on tile ${currentPos}, not on a card tile.`);
    }

    // Only allow test-forced roll if in test mode
    const allowTestForced = process.env.ALLOW_TEST_FORCED_CARD === 'true' || process.env.NODE_ENV === 'test';
    const forcedRoll = (allowTestForced && Number.isInteger(data._testForcedRoll)) ? data._testForcedRoll : null;

    // Authoritatively resolve card on the server
    const outcome = cards.resolveCardDraw(room, player, {
      forcedRoll,
      targetId: data.targetId,
    });
    if (!outcome || !outcome.ok) {
      return reject(ack, outcome?.code || 'CARD_ERROR', outcome?.error || 'Failed to resolve card.');
    }

    persistRoom(room);

    console.log(`🎴 Room ${roomId}: Player ${player.id} drew ${outcome.kind} card (${outcome.card.id}) roll=${outcome.roll} pos=${outcome.position} money=${outcome.money}`);

    // Broadcast authoritative outcome to peers in the room
    socket.to(roomId).emit('card:drawn', outcome);

    // Ack back to acting client
    if (typeof ack === 'function') ack(outcome);
  }));

  // ===================== SERVER-ROLLED DICE =====================
  // `player:rolled` is a REQUEST to roll, not a report of a roll.
  //
  // The client sends nothing that matters. `dice` and `total` are IGNORED
  // ENTIRELY if present — they are not read, not validated, not compared. The
  // server rolls both dice itself (rollDiceFor -> rollD6) and stores the result
  // as the room's authoritative roll, then TELLS every client what it rolled.
  //
  // This closed the "client chooses its own dice" hole: `{ dice: [6,6] }` is now
  // simply a request for a roll that happens to carry some unused extra fields,
  // exactly like sending no dice at all.
  //
  // Rules enforced:
  //   - the socket must be identified and it must be its turn (turnGate)
  //   - one roll per turn: an existing UNSPENT roll for this player is refused
  //     (ROLL_ALREADY_PENDING), so a player cannot reroll a bad number
  //   - the first roll of the game is what starts it (unchanged)
  socket.on('player:rolled', withRoom((room, roomId, data, ack) => {
    // Identity + turn. `data.playerId`, if present, is cross-checked against the
    // socket's own seat by turnGate — a spoofed id is refused there.
    const gateError = turnGate(room, ack, data && data.playerId);
    if (gateError) return gateError;

    const rollerId = actingPlayerId();

    // ===== ONE ROLL PER TURN =====
    // An unspent roll already belonging to this player means they are asking to
    // roll again before using the first one — a reroll. Refused, so a player
    // cannot fish for a better total. (A roll that has been spent is replaced
    // freely, which is what lets the client ask for a fresh roll after moving.)
    const pending = room.lastRoll;
    if (pending && pending.playerId === rollerId && pending.consumed !== true) {
      return reject(ack, 'ROLL_ALREADY_PENDING', 'You have already rolled — move before rolling again.');
    }

    // The server decides the dice. Nothing from `data` is read.
    const roll = room.rollDiceFor(rollerId, 'dice');

    // The first roll is the moment the game actually begins (the client flips
    // its own isGameStarted on the same press). Stamping it server-side is what
    // makes the name/colour lock authoritative: player:set-name / player:set-color
    // check this flag, so a client can't keep editing the roster mid-game just by
    // leaving its own local flag false.
    if (!room.isGameStarted) {
      // A game needs at least MIN_PLAYERS real seats. The client gates its own
      // Start/roll on this, but the first roll is what actually opens the game,
      // so enforce it here too — otherwise a lone client could start solo just
      // by rolling (or by leaving its local flag false).
      if (seatedCount(room) < MIN_PLAYERS) {
        // The game never started, so the roll we just made must not linger: a
        // refused roll must not be spendable later.
        room.clearRoll();
        return reject(ack, 'NOT_ENOUGH_PLAYERS', `A game needs at least ${MIN_PLAYERS} players (only ${seatedCount(room)} seated).`);
      }
      room.isGameStarted = true;
      persistRoom(room);
      console.log(`🎮 Room ${roomId}: game started — name/colour editing locked`);
      // The turn clock is gated on isGameStarted, so THIS is where it starts
      // running for real. It is armed on the ROLLER directly rather than through
      // ensureTurnClock(): that helper arms whatever turn the room holds, which
      // only equals the roller while the turn is already seeded to them. If the
      // server's seed ever points at a different seat, arming the seeded turn
      // would time that OTHER player out of a game they have not had a turn in.
      room.startTurnTimer((r) => handleTurnTimeout(r, io));
      // The clock is armed for the opening turn, so publish the deadline now.
      // Identify already happened (a player must identify before they can roll),
      // so without this broadcast the first turn would run on a live server clock
      // while advertising `turnDeadline: null` — every client would fall back to
      // its own local tick and show a countdown that matches nothing.
      io.to(roomId).emit('turn:changed', {
        currentTurnPlayerId: room.currentTurnPlayerId,
        turnDeadline: room.turnDeadline
      });
    }

    console.log(`🎲 Room ${roomId}: Player ${rollerId} rolled ${roll.dice[0]} + ${roll.dice[1]} = ${roll.total} (seq ${roll.seq})`);

    // ===== EVERYONE IS TOLD THE AUTHORITATIVE RESULT =====
    // Sent with io.to() (not socket.to()) so the ROLLER receives it too. That
    // matters now: the roller no longer generates its own dice locally, so this
    // broadcast is the only place it learns what it rolled. Clients are expected
    // to ignore the echo of their OWN roll for animation purposes (they already
    // animated it optimistically) but to adopt `dice`/`total` as truth.
    io.to(roomId).emit('player:rolled', {
      playerId: rollerId,
      dice: roll.dice,
      total: roll.total,
      seq: roll.seq,
    });
    if (typeof ack === 'function') ack({ ok: true, dice: roll.dice, total: roll.total, seq: roll.seq });
  }));

  // Skill card (Movement Card) usage. The card belongs to a PLAYER, so the user
  // is taken from the socket rather than from the payload — otherwise any client
  // could play a card "as" someone else, moving that player's token. The server
  // stamps the authenticated actor into the broadcast so every peer sees the
  // real owner, not the claimed one.
  // Skill card (Movement Card) usage. The card belongs to a PLAYER, so the user
  // is taken from the socket rather than from the payload — otherwise any client
  // could play a card "as" someone else, moving that player's token. The server
  // stamps the authenticated actor into the broadcast so every peer sees the
  // real owner, not the claimed one.
  //
  // The card's DISTANCE is a chosen value (1-6), which is different from dice,
  // but it is still a board-changing movement, so it goes through the SAME
  // authoritative roll record rather than being applied here. The chosen
  // distance becomes a 'card' roll for this player; the subsequent
  // player:moved consumes it exactly like a dice roll, which means the move
  // itself is still computed entirely server-side and can still only happen
  // once per card.
  socket.on('player:skill-card', withRoom((room, roomId, data, ack) => {
    const { actor, error } = requireActor(room, ack);
    if (error) return error;

    // Only the player whose turn it is may use a movement card, matching every
    // other board-changing action.
    const gateError = turnGate(room, ack, data && data.playerId);
    if (gateError) return gateError;

    const movement = data && data.movement;
    // Bounded to a real card value: a whole number of tiles on a six-sided
    // board. The old check only required "a non-zero integer", so a card could
    // claim to move 400 tiles.
    if (!Number.isInteger(movement) || movement < 1 || movement > 6) {
      return reject(ack, 'BAD_MOVEMENT', 'Movement card must move 1-6 whole tiles.');
    }

    // One card at a time, same rule as one roll at a time: an unspent card move
    // already pending must be used before another card can be played.
    const pending = room.lastRoll;
    if (pending && pending.playerId === actor.id && pending.consumed !== true) {
      return reject(ack, 'ROLL_ALREADY_PENDING', 'Move with your current roll before using a card.');
    }

    // The card becomes the authoritative roll for this player, so the movement
    // it produces is derived server-side by player:moved.
    const roll = room.rollDiceFor(actor.id, 'card', movement);

    socket.to(roomId).emit('player:skill-card', { ...data, playerId: actor.id, seq: roll.seq });
    if (typeof ack === 'function') ack({ ok: true, playerId: actor.id, movement, seq: roll.seq });
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

    // A tile must exist on the server's board and be ownable. Checked against
    // the board table rather than a bare 0..39 range, so a corner or a card tile
    // can no longer be "bought".
    if (!isOwnableTile(data.tileId)) {
      return reject(ack, 'BAD_TILE', `Tile ${data.tileId} is not a purchasable tile.`);
    }
    if (room.propertyOwnership[data.tileId] !== undefined) {
      return reject(ack, 'ALREADY_OWNED', `Tile ${data.tileId} is already owned.`);
    }
    // A bankrupt seat is out of the game for good.
    if (isOutOfGame(player)) {
      return reject(ack, 'PLAYER_OUT', 'You are out of the game.');
    }
    // Must be standing on the tile being bought.
    if (player.position !== data.tileId) {
      return reject(ack, 'NOT_ON_TILE', `Player is on ${player.position}, not on tile ${data.tileId}.`);
    }

    // Replay gate: a duplicated purchase frame would re-charge the player for a
    // tile it already owns (and the ALREADY_OWNED check below would then reject
    // it, so the double-charge is the real risk, not a double-own).
    const replayError = actionGate(room, ack, data.actionId);
    if (replayError) return replayError;

    // ===== AUTHORITATIVE PRICE =====
    // The price comes from the SERVER's board table, never from the payload. A
    // client that sends `price: 0` (or omits it, or sends a negative) is simply
    // ignored: the official price for this tile is what gets charged. The
    // payload's `price` field is not read at all — this is the fix for the
    // "buy California for $0" hole, where the client's number was trusted.
    const price = purchasePrice(data.tileId);
    if (price === null) {
      return reject(ack, 'BAD_TILE', `Tile ${data.tileId} has no purchase price.`);
    }

    // Affordability, enforced for EVERY balance including exactly $0. The old
    // check was `knownMoney > 0 && price > knownMoney`, which treated a zero
    // balance as "money unknown" and let a player with $0 buy anything for free.
    // Zero is a real balance; the comparison is what decides.
    const knownMoney = Number.isFinite(player.money) ? player.money : 0;
    if (price > knownMoney) {
      return reject(ack, 'INSUFFICIENT_FUNDS', `Costs $${price} but player has $${knownMoney}.`);
    }

    room.propertyOwnership[data.tileId] = data.playerId;
    // Debit the SERVER's price. `price` is a whole non-negative number straight
    // from the board table, so no further coercion is needed here.
    player.money = knownMoney - price;
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
    if (owner === undefined) {
      return reject(ack, 'NOT_OWNED', `Tile ${data.tileId} has no owner to upgrade.`);
    }
    // AUTHORIZATION: the builder must BE the owner. Identity comes from the
    // socket, never from the payload's playerId (which turnGate has already
    // cross-checked, but this is the check that actually decides ownership).
    //
    // The previous form was `actorId !== null && owner !== actorId`, so an
    // UNIDENTIFIED socket (actorId === null) skipped the comparison and could
    // upgrade anyone's property. requireActor() closes that: no actor, no build.
    const { actor, error } = requireActor(room, ack);
    if (error) return error;
    if (owner !== actor.id) {
      return reject(ack, 'NOT_OWNER', `Tile ${data.tileId} belongs to player ${owner}, not ${actor.id}.`);
    }

    // Replay gate: house counts are absolute, so a duplicate build frame is
    // idempotent in effect — but it would still be reported as a second build
    // to the log and the client's build button, so it is dropped here. A
    // duplicated frame must ALSO not be charged twice, which is what the money
    // block below depends on.
    const replayError = actionGate(room, ack, data.actionId);
    if (replayError) return replayError;

    // ===== BUILDING COSTS MONEY (SERVER-AUTHORITATIVE) =====
    // Previously this handler wrote the house count and charged NOTHING — the
    // client applied its own cost for display while the server recorded the
    // houses for free, so any player could build out the whole board at $0 and a
    // hand-rolled client could build silently. The cost now comes from the
    // server's board table (board.buildCost), never from the payload.
    //
    // House counts are ABSOLUTE (the client sends the level it wants, not a
    // delta), so the charge is the sum of the levels being added: building from
    // 1 to 3 pays for level 1 and level 2. Level 4 -> 5 is charged at hotelCost.
    //
    // A DOWNGRADE is not a sale: this handler only ever charges for added levels
    // and never credits money back, so a client cannot convert houses into cash
    // by sending a lower count. Selling is the separate `house:sold` handler.
    const currentHouses = Number.isInteger(room.propertyHouses[data.tileId])
      ? room.propertyHouses[data.tileId]
      : 0;
    if (data.houses < currentHouses) {
      return reject(ack, 'BAD_BUILD', 'Use house:sold to remove an improvement.');
    }
    let buildTotal = 0;
    for (let level = currentHouses; level < data.houses; level++) {
      const stepCost = buildCost(data.tileId, level);
      if (stepCost === null) {
        return reject(ack, 'BAD_BUILD', `Tile ${data.tileId} cannot be built to level ${level + 1}.`);
      }
      buildTotal += stepCost;
    }

    // Affordability is enforced for every balance including exactly $0, matching
    // the purchase path. Lower counts are handled only by house:sold.
    const knownMoney = Number.isFinite(actor.money) ? actor.money : 0;
    if (buildTotal > knownMoney) {
      return reject(ack,
        'INSUFFICIENT_FUNDS',
        `Building to ${data.houses} house(s) costs $${buildTotal} but player has $${knownMoney}.`);
    }

    // Debit the SERVER's cost, then write the house count. The charge happens
    // BEFORE the mutation so a rejected build cannot leave houses without a
    // payment.
    actor.money = knownMoney - buildTotal;

    room.propertyHouses[data.tileId] = data.houses;
    // A build changes the board permanently — persist it.
    persistRoom(room);
    socket.to(roomId).emit('house:upgraded', data);
    if (typeof ack === 'function') ack({ ok: true, cost: buildTotal, money: actor.money });
  }));

  // ================= SELL PROPERTY / HOUSES =================
  // A whole-tile sale returns half the official purchase price plus half of
  // each remaining improvement's cost. Only the server changes the ledger.
  socket.on('property:sold', withRoom((room, roomId, data, ack) => {
    if (!data || data.tileId === undefined) {
      return reject(ack, 'BAD_PAYLOAD', 'property:sold needs a tileId.');
    }
    const gateError = turnGate(room, ack, data.playerId);
    if (gateError) return gateError;
    if (!isOwnableTile(data.tileId)) {
      return reject(ack, 'BAD_TILE', `Tile ${data.tileId} is not a sellable tile.`);
    }
    const { actor, error } = requireActor(room, ack);
    if (error) return error;
    // Claim after identity and tile checks, before ownership changes on a sale,
    // so replaying a completed sale is reported as a duplicate.
    const replayError = actionGate(room, ack, data.actionId);
    if (replayError) return replayError;
    const owner = room.propertyOwnership[data.tileId];
    if (owner !== actor.id) {
      return reject(ack, owner === undefined ? 'NOT_OWNED' : 'NOT_OWNER',
        `Player ${actor.id} does not own tile ${data.tileId}.`);
    }
    const price = purchasePrice(data.tileId);
    const houses = room.propertyHouses[data.tileId] || 0;
    if (price === null || !Number.isInteger(houses) || houses < 0 || houses > board.MAX_HOUSES ||
        (!isPropertyTile(data.tileId) && houses !== 0)) {
      return reject(ack, 'BAD_TILE', `Tile ${data.tileId} has invalid sale state.`);
    }
    let refund = Math.floor(price / 2);
    for (let level = houses; level > 0; level--) {
      const levelRefund = sellRefund(data.tileId, level);
      if (levelRefund === null) return reject(ack, 'BAD_TILE', `Tile ${data.tileId} has invalid houses.`);
      refund += levelRefund;
    }
    actor.money = (Number.isFinite(actor.money) ? actor.money : 0) + refund;
    delete room.propertyOwnership[data.tileId];
    delete room.propertyHouses[data.tileId];
    persistRoom(room);
    io.to(roomId).emit('property:sold', {
      tileId: data.tileId, playerId: actor.id, houses: 0, ownerId: null, refund, money: actor.money,
    });
    if (typeof ack === 'function') ack({ ok: true, refund, houses: 0, ownerId: null, money: actor.money });
  }));

  // Sell exactly one level using the official board's house/hotel cost.
  //
  // Only the tile's owner may sell, on their own turn. The refund is half the
  // price paid for the level being removed, taken from the board table; a client
  // cannot name the amount.
  socket.on('house:sold', withRoom((room, roomId, data, ack) => {
    if (!data || data.tileId === undefined) {
      return reject(ack, 'BAD_PAYLOAD', 'house:sold needs a tileId.');
    }
    const gateError = turnGate(room, ack, data.playerId);
    if (gateError) return gateError;

    if (!isPropertyTile(data.tileId)) {
      return reject(ack, 'BAD_TILE', `Tile ${data.tileId} is not a sellable property.`);
    }
    const owner = room.propertyOwnership[data.tileId];
    if (owner === undefined) {
      return reject(ack, 'NOT_OWNED', `Tile ${data.tileId} has no owner to sell from.`);
    }
    const { actor, error } = requireActor(room, ack);
    if (error) return error;
    if (owner !== actor.id) {
      return reject(ack, 'NOT_OWNER', `Tile ${data.tileId} belongs to player ${owner}, not ${actor.id}.`);
    }

    // The client cannot specify a house count or refund; remove one level from
    // the server's current count (5 is a hotel).
    const currentHouses = room.propertyHouses[data.tileId] || 0;
    if (!Number.isInteger(currentHouses) || currentHouses > board.MAX_HOUSES) {
      return reject(ack, 'BAD_HOUSE_COUNT', `Tile ${data.tileId} has invalid houses.`);
    }
    if (currentHouses <= 0) {
      return reject(ack, 'NOTHING_TO_SELL', `Tile ${data.tileId} has no houses to sell.`);
    }

    const refund = sellRefund(data.tileId, currentHouses);
    if (refund === null) {
      return reject(ack, 'BAD_TILE', `Tile ${data.tileId} has no refund value.`);
    }
    const replayError = actionGate(room, ack, data.actionId);
    if (replayError) return replayError;

    // Credit the SERVER's refund, then lower the count.
    actor.money = (Number.isFinite(actor.money) ? actor.money : 0) + refund;
    room.propertyHouses[data.tileId] = currentHouses - 1;
    persistRoom(room);
    console.log(`🏚️ Room ${roomId}: Player ${actor.id} sold a house on tile ${data.tileId} (+$${refund})`);
    io.to(roomId).emit('house:sold', {
      tileId: data.tileId,
      playerId: actor.id,
      houses: room.propertyHouses[data.tileId],
      refund,
      money: actor.money,
    });
    if (typeof ack === 'function') {
      ack({ ok: true, refund, houses: room.propertyHouses[data.tileId], money: actor.money });
    }
  }));

  // ================= JAIL: PAY BAIL =================
  // Paying bail is server-authoritative:
  // 1. Gated by turnGate (must be identified, on their turn, not bankrupt).
  // 2. Gated by actionGate (must have valid, unique actionId to prevent double charge).
  // 3. Verifies player is actually in jail (inJail === true).
  // 4. Verifies affordability against server-known balance ($100).
  // 5. Deducts $100 server-side, sets inJail=false, jailTurns=0.
  // 6. Persists room state.
  // 7. Broadcasts jail:bail-paid to room peers and returns ack to actor.
  socket.on('jail:pay-bail', withRoom((room, roomId, data, ack) => {
    const { actor, error } = requireActor(room, ack);
    if (error) return error;

    const gateError = turnGate(room, ack, data && data.playerId);
    if (gateError) return gateError;

    if (isOutOfGame(actor)) {
      return reject(ack, 'PLAYER_OUT', 'You are out of the game.');
    }

    if (!actor.inJail) {
      return reject(ack, 'NOT_IN_JAIL', `Player ${actor.id} is not in jail.`);
    }

    const replayError = actionGate(room, ack, data && data.actionId);
    if (replayError) return replayError;

    const bailCost = board.JAIL_BAIL_COST || 100;
    const currentMoney = Number.isFinite(actor.money) ? actor.money : 0;
    if (currentMoney < bailCost) {
      return reject(ack, 'INSUFFICIENT_FUNDS', `Bail costs $${bailCost} but player ${actor.id} has $${currentMoney}.`);
    }

    actor.money = currentMoney - bailCost;
    actor.inJail = false;
    actor.jailTurns = 0;

    persistRoom(room);

    console.log(`🔓 Room ${roomId}: Player ${actor.id} paid $${bailCost} bail and was released from JAIL (new balance $${actor.money})`);

    const resultPayload = {
      playerId: actor.id,
      bail: bailCost,
      money: actor.money,
      inJail: false,
      jailTurns: 0,
    };

    socket.to(roomId).emit('jail:bail-paid', resultPayload);
    if (typeof ack === 'function') {
      ack({ ok: true, ...resultPayload });
    }
  }));

  // ===== CLUB FEE SETTLEMENT (TILE 30) =====
  // Server-authoritative Club fee:
  // 1. Validates actor identity and authoritative turn.
  // 2. Enforces replay idempotency via actionId (actionGate).
  // 3. Validates player is standing on tile 30 (CLUB).
  // 4. Authoritatively computes fee: cardCount * 50 + houseCount * 100.
  //    Client-supplied fee/pot/money is ignored.
  // 5. Deducts fee from actor.money, credits room.pot.
  //    If player cannot afford the fee, marks bankrupt and transfers remaining cash to pot.
  // 6. Persists room state.
  // 7. Broadcasts club:paid to room peers and returns ack to actor.
  const handleClubPay = withRoom((room, roomId, data, ack) => {
    if (!data || data.playerId === undefined) {
      return reject(ack, 'BAD_PAYLOAD', 'club:pay needs a playerId.');
    }

    const { actor, error } = requireActor(room, ack);
    if (error) return error;

    const gateError = turnGate(room, ack, data.playerId);
    if (gateError) return gateError;

    if (isOutOfGame(actor)) {
      return reject(ack, 'PLAYER_OUT', 'You are out of the game.');
    }

    if (actor.position !== board.CLUB_TILE_ID) {
      return reject(ack, 'NOT_ON_CLUB', `Player ${actor.id} is on tile ${actor.position}, not on CLUB (tile ${board.CLUB_TILE_ID}).`);
    }

    const replayError = actionGate(room, ack, data.actionId);
    if (replayError) return replayError;

    const cardCount = (actor.hasSkillCard !== false) ? 1 : 0;
    const houseCount = board.countPlayerHouses(room.propertyOwnership, room.propertyHouses, actor.id);
    const fee = board.calculateClubFee(cardCount, houseCount);

    const currentMoney = Number.isFinite(actor.money) ? actor.money : 0;
    const isBankrupt = fee > 0 && currentMoney < fee;
    const paid = Math.min(fee, Math.max(0, currentMoney));

    actor.money = Math.max(0, currentMoney - paid);
    room.pot = (room.pot || 0) + paid;
    room.restHousePot = room.pot;

    if (isBankrupt) {
      actor.isBankrupt = true;
      actor.money = 0;
      for (const [tileId, ownerId] of Object.entries(room.propertyOwnership)) {
        if (ownerId === actor.id) {
          delete room.propertyOwnership[tileId];
          delete room.propertyHouses[tileId];
        }
      }
    }

    persistRoom(room);

    console.log(`🥂 Room ${roomId}: Player ${actor.id} paid $${paid} at CLUB (${cardCount} card + ${houseCount} houses). Room pot is now $${room.pot}.`);

    const resultPayload = {
      playerId: actor.id,
      fee,
      paid,
      cardCount,
      houseCount,
      pot: room.pot,
      restHousePot: room.pot,
      money: actor.money,
      isBankrupt: !!actor.isBankrupt,
    };

    socket.to(roomId).emit('club:paid', resultPayload);
    if (typeof ack === 'function') {
      ack({ ok: true, ...resultPayload });
    }

    if (isBankrupt) {
      const survivor = findSoleSurvivor(room);
      if (survivor) declareWinner(room, io, survivor, 'last-player-standing');
    }
  });

  socket.on('club:pay', handleClubPay);
  socket.on('tile:club', handleClubPay);

  // ===== REST HOUSE RESOLUTION (TILE 20) =====
  // Server-authoritative Rest House pot collection:
  // 1. Validates actor identity and authoritative turn.
  // 2. Enforces replay idempotency via actionId (actionGate).
  // 3. Validates player is standing on tile 20 (REST HOUSE).
  // 4. Authoritatively determines fee = 0, payout = room.pot.
  //    Client-supplied fee/pot/money is ignored.
  // 5. Awards pot to actor.money, resets room.pot = 0, sets actor.isResting = true.
  // 6. Persists room state.
  // 7. Broadcasts rest-house:resolved to room peers and returns ack to actor.
  const handleRestHouseResolve = withRoom((room, roomId, data, ack) => {
    if (!data || data.playerId === undefined) {
      return reject(ack, 'BAD_PAYLOAD', 'rest-house:resolve needs a playerId.');
    }

    const { actor, error } = requireActor(room, ack);
    if (error) return error;

    const gateError = turnGate(room, ack, data.playerId);
    if (gateError) return gateError;

    if (isOutOfGame(actor)) {
      return reject(ack, 'PLAYER_OUT', 'You are out of the game.');
    }

    if (actor.position !== board.REST_HOUSE_TILE_ID) {
      return reject(ack, 'NOT_ON_REST_HOUSE', `Player ${actor.id} is on tile ${actor.position}, not on REST HOUSE (tile ${board.REST_HOUSE_TILE_ID}).`);
    }

    const replayError = actionGate(room, ack, data.actionId);
    if (replayError) return replayError;

    const fee = board.calculateRestHouseFee(); // 0
    const payout = room.pot || 0;
    const currentMoney = Number.isFinite(actor.money) ? actor.money : 0;

    actor.money = currentMoney + payout;
    actor.isResting = true;
    room.pot = 0;
    room.restHousePot = 0;

    persistRoom(room);

    console.log(`🏨 Room ${roomId}: Player ${actor.id} landed on REST HOUSE and collected $${payout} pot (new balance $${actor.money}). Pot reset to 0.`);

    const resultPayload = {
      playerId: actor.id,
      fee,
      payout,
      pot: 0,
      restHousePot: 0,
      money: actor.money,
      isResting: true,
    };

    socket.to(roomId).emit('rest-house:resolved', resultPayload);
    if (typeof ack === 'function') {
      ack({ ok: true, ...resultPayload });
    }
  });

  socket.on('rest-house:resolve', handleRestHouseResolve);
  socket.on('rest-house:collect', handleRestHouseResolve);
  socket.on('tile:rest-house', handleRestHouseResolve);

  // ===== TAX SETTLEMENT (TILES 7, 24, 34) =====
  // Server-authoritative Tax payment:
  // 1. Validates actor identity and authoritative turn.
  // 2. Enforces replay idempotency via actionId (actionGate).
  // 3. Validates player is standing on a tax tile (board.isTaxTile).
  //    Optionally cross-checks tileId with player position.
  // 4. Authoritatively computes tax amount from server board rules (board.taxAmount).
  //    Client-supplied amount/fee/money/pot is completely ignored.
  // 5. Deducts tax from actor.money, credits room.pot / restHousePot.
  //    If player cannot afford tax, marks bankrupt, transfers available money to pot.
  // 6. Persists room state.
  // 7. Broadcasts tax:paid to room peers and returns ack to actor.
  const handleTaxPay = withRoom((room, roomId, data, ack) => {
    if (!data || data.playerId === undefined) {
      return reject(ack, 'BAD_PAYLOAD', 'tax:pay needs a playerId.');
    }

    const { actor, error } = requireActor(room, ack);
    if (error) return error;

    const gateError = turnGate(room, ack, data.playerId);
    if (gateError) return gateError;

    if (isOutOfGame(actor)) {
      return reject(ack, 'PLAYER_OUT', 'You are out of the game.');
    }

    if (!board.isTaxTile(actor.position)) {
      return reject(ack, 'NOT_ON_TAX', `Player ${actor.id} is on tile ${actor.position}, which is not a TAX tile.`);
    }

    if (data.tileId !== undefined && data.tileId !== actor.position) {
      return reject(ack, 'TILE_MISMATCH', `Player ${actor.id} is on tile ${actor.position}, not tile ${data.tileId}.`);
    }

    const replayError = actionGate(room, ack, data.actionId);
    if (replayError) return replayError;

    const tax = board.taxAmount(actor.position);
    if (tax <= 0) {
      return reject(ack, 'NO_TAX_DUE', `No tax is due on tile ${actor.position}.`);
    }

    const currentMoney = Number.isFinite(actor.money) ? actor.money : 0;
    const isBankrupt = currentMoney < tax;
    const paid = Math.min(tax, Math.max(0, currentMoney));

    actor.money = Math.max(0, currentMoney - paid);
    room.pot = (room.pot || 0) + paid;
    room.restHousePot = room.pot;

    if (isBankrupt) {
      actor.isBankrupt = true;
      actor.money = 0;
      for (const [tileId, ownerId] of Object.entries(room.propertyOwnership)) {
        if (ownerId === actor.id) {
          delete room.propertyOwnership[tileId];
          delete room.propertyHouses[tileId];
        }
      }
    }

    persistRoom(room);

    console.log(`📉 Room ${roomId}: Player ${actor.id} paid $${paid} tax on tile ${actor.position} (due $${tax}). Room pot is now $${room.pot}.`);

    const resultPayload = {
      playerId: actor.id,
      tileId: actor.position,
      amount: tax,
      paid,
      pot: room.pot,
      restHousePot: room.pot,
      money: actor.money,
      isBankrupt: !!actor.isBankrupt,
    };

    socket.to(roomId).emit('tax:paid', resultPayload);
    if (typeof ack === 'function') {
      ack({ ok: true, ...resultPayload });
    }

    if (isBankrupt) {
      const survivor = findSoleSurvivor(room);
      if (survivor) declareWinner(room, io, survivor, 'last-player-standing');
    }
  });

  socket.on('tax:pay', handleTaxPay);
  socket.on('tile:tax', handleTaxPay);

  // Player Elimination / Kick Events
  // A player may only declare THEMSELVES bankrupt (you can't knock out a rival).
  socket.on('player:bankrupt', withRoom((room, roomId, data, ack) => {
    if (!data || data.playerId === undefined) {
      return reject(ack, 'BAD_PAYLOAD', 'player:bankrupt needs a playerId.');
    }
    // AUTHORIZATION: require an identified actor and require it to BE the named
    // player. The earlier form only checked `actorId !== null && actorId !==
    // data.playerId`, which meant an UNIDENTIFIED socket (actorId === null)
    // skipped the comparison entirely and could bankrupt anyone.
    const { actor, error } = requireActor(room, ack);
    if (error) return error;
    if (actor.id !== data.playerId) {
      return reject(ack, 'NOT_SELF', `Player ${actor.id} cannot bankrupt player ${data.playerId}.`);
    }
    const p = actor;

    // Replay gate: elimination releases the player's whole property portfolio,
    // so it must happen exactly once per player.
    const replayError = actionGate(room, ack, data.actionId);
    if (replayError) return replayError;

    p.isBankrupt = true;
    p.money = 0;
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

    // LAST PLAYER STANDING: reuses the SAME win path as the timeout elimination,
    // so a game can end by either route through one implementation.
    const survivor = findSoleSurvivor(room);
    if (survivor) declareWinner(room, io, survivor, 'last-player-standing');

    if (typeof ack === 'function') ack({ ok: true });
  }));

  // Kick. AUTHORIZATION: only the HOST may kick, and only a player who is
  // actually in this room. The event used to be an unvalidated pass-through —
  // any client could emit it naming any target, and every peer would apply it.
  // The requester is now the authenticated socket and the authority is the room's
  // host token, which is the project's existing authority model.
  socket.on('player:kicked', withRoom((room, roomId, data, ack) => {
    const { actor, error } = requireActor(room, ack);
    if (error) return error;

    // Host check by TOKEN (not socket id), matching player:set-max-players.
    const token = socketToken.get(socket.id) || socket.data.sessionToken;
    if (!room.hostToken || token !== room.hostToken) {
      return reject(ack, 'NOT_HOST', 'Only the host can remove a player.');
    }

    const targetId = data && data.playerId;
    if (targetId === undefined || targetId === null) {
      return reject(ack, 'BAD_PAYLOAD', 'player:kicked needs the target playerId.');
    }
    const target = findPlayer(room, targetId);
    if (!target) {
      return reject(ack, 'UNKNOWN_PLAYER', `No player ${targetId} in this room.`);
    }
    // A host removing themselves would end the room's authority with no
    // successor; that is a leave, not a kick.
    if (target.id === actor.id) {
      return reject(ack, 'CANNOT_KICK_SELF', 'Use room:leave to leave the room.');
    }

    // Stamp the real requester so peers can't be told the kick came from
    // someone else.
    const clean = { ...data, playerId: target.id, kickedBy: actor.id };
    console.log(`👢 Room ${roomId}: Player ${actor.id} removed Player ${target.id}`);
    io.to(roomId).emit('player:kicked', clean);
    if (typeof ack === 'function') ack({ ok: true, playerId: target.id });
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

    // Money must be a whole, non-negative, finite dollar amount. Checked as a
    // NUMBER rather than coerced with `Number(x) || 0`, because that coercion
    // turns garbage (NaN, "abc", undefined) into a silent $0 — which, now that
    // the accept path applies both legs unconditionally, would let a malformed
    // trade settle as a real zero-dollar transfer instead of being refused.
    const initiatorMoney = t.initiatorMoney === undefined ? 0 : t.initiatorMoney;
    const targetMoney = t.targetMoney === undefined ? 0 : t.targetMoney;
    if (!isMoneyAmount(initiatorMoney) || !isMoneyAmount(targetMoney)) {
      return { code: 'BAD_MONEY', error: 'Trade money must be a non-negative whole dollar amount.' };
    }
    // Cash must be on hand. This is now enforced for a zero balance too: a
    // player with exactly $0 cannot offer $1, where the old `money > 0` guard
    // skipped the check entirely for anyone at (or restored to) zero.
    if (initiatorMoney > initiator.money) {
      return { code: 'INSUFFICIENT_FUNDS', error: `Player ${t.initiatorId} offered $${initiatorMoney} but has $${initiator.money}.` };
    }
    if (targetMoney > target.money) {
      return { code: 'INSUFFICIENT_FUNDS', error: `Player ${t.targetId} offered $${targetMoney} but has $${target.money}.` };
    }
    return null; // valid
  };

  socket.on('trade:created', withRoom((room, roomId, trade, ack) => {
    const bad = validateTrade(room, trade);
    if (bad) return reject(ack, bad.code, bad.error);

    // AUTHORIZATION: only a party to the trade may create it. Without this, any
    // identified player could propose a deal "from" someone else — naming them
    // as initiator and offering away their property. validateTrade only proves
    // the tiles ARE owned by the named initiator; it does not prove the sender
    // IS that initiator, which is the impersonation gap.
    const party = requireTradeParty(room, ack, trade, { allowInitiator: true, allowTarget: false });
    if (party.error) return party.error;

    room.trades = [trade, ...room.trades.filter(t => t.id !== trade.id)];
    // An active trade is durable state — persist so it survives a restart.
    persistRoom(room);
    socket.to(roomId).emit('trade:created', trade);
    if (typeof ack === 'function') ack({ ok: true });
  }));

  socket.on('trade:updated', withRoom((room, roomId, trade, ack) => {
    const bad = validateTrade(room, trade);
    if (bad) return reject(ack, bad.code, bad.error);

    // AUTHORIZATION: either party may edit the terms of an open negotiation.
    const party = requireTradeParty(room, ack, trade);
    if (party.error) return party.error;

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

    // AUTHORIZATION: only the TARGET may accept. The initiator proposed the
    // deal; letting them accept it too would let one player unilaterally move
    // another player's property and cash by accepting their own offer. A third
    // player (not a party at all) is refused for the same reason.
    const party = requireTradeParty(room, ack, t, { allowInitiator: false, allowTarget: true });
    if (party.error) return party.error;

    // A trade must not be settled twice. The id is claimed BEFORE any transfer,
    // so a duplicate accept frame cannot move the same tiles and cash again.
    const replayError = actionGate(room, ack, data.actionId);
    if (replayError) return replayError;

    // Transfer only after validation, so a bad trade can't half-apply.
    room.trades = room.trades.map(x => x.id === t.id ? { ...x, status: 'accepted' } : x);
    for (const tileId of t.initiatorPropertyIds) room.propertyOwnership[tileId] = t.targetId;
    for (const tileId of t.targetPropertyIds) room.propertyOwnership[tileId] = t.initiatorId;

    const initiator = findPlayer(room, t.initiatorId);
    const target = findPlayer(room, t.targetId);
    // ===== SETTLE USING THE VALIDATED NUMBERS, NOT A RE-COERCION =====
    // validateTrade() above already proved both amounts are whole, non-negative
    // and covered by the payer's balance, and it rejected the trade otherwise.
    // The settlement therefore reads the SAME normalisation the validator used
    // (`undefined` -> 0) rather than re-running `Number(x) || 0`.
    //
    // That difference is not cosmetic: `Number("abc") || 0` is 0, so a malformed
    // amount that the validator had REFUSED would have settled as a silent zero
    // transfer if this path had been reached by another route. Both legs are
    // applied unconditionally — including $0, which is a valid amount and the
    // common case for a straight property swap.
    const im = t.initiatorMoney === undefined ? 0 : t.initiatorMoney;
    const tm = t.targetMoney === undefined ? 0 : t.targetMoney;
    if (initiator) initiator.money = initiator.money - im + tm;
    if (target) target.money = target.money - tm + im;

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
    const existing = room.trades.find(t => t.id === data.tradeId);
    if (!existing) {
      return reject(ack, 'UNKNOWN_TRADE', `No trade ${data.tradeId} in this room.`);
    }
    // AUTHORIZATION: only a party may reject. Read the trade from SERVER state
    // (not from the payload) so the party check can't be defeated by sending a
    // doctored copy of the trade alongside the id.
    const party = requireTradeParty(room, ack, existing);
    if (party.error) return party.error;

    room.trades = room.trades.map(t => t.id === data.tradeId ? { ...t, status: 'rejected' } : t);
    persistRoom(room);
    socket.to(roomId).emit('trade:rejected', data);
    if (typeof ack === 'function') ack({ ok: true });
  }));

  socket.on('trade:cancelled', withRoom((room, roomId, data, ack) => {
    if (!data || !data.tradeId) {
      return reject(ack, 'BAD_PAYLOAD', 'trade:cancelled needs a tradeId.');
    }
    const existing = room.trades.find(t => t.id === data.tradeId);
    if (!existing) {
      return reject(ack, 'UNKNOWN_TRADE', `No trade ${data.tradeId} in this room.`);
    }
    // AUTHORIZATION: only a party may cancel. Read the trade from SERVER state so
    // a doctored payload copy can't defeat the party check.
    const party = requireTradeParty(room, ack, existing);
    if (party.error) return party.error;

    room.trades = room.trades.filter(t => t.id !== data.tradeId);
    persistRoom(room);
    socket.to(roomId).emit('trade:cancelled', data);
    if (typeof ack === 'function') ack({ ok: true });
  }));

  // Real-Time Chat Engine
  // The sender identity is taken from the SOCKET, never from the payload. A
  // client that sends `senderName` is describing what it WANTS to be called; the
  // server overwrites it with the authenticated player's own name so nobody can
  // post under another player's identity. Text is length-capped and must be a
  // non-empty string; malformed payloads are dropped rather than broadcast.
  socket.on('chat:message', withRoom((room, roomId, msg, ack) => {
    const { actor, error } = requireActor(room, ack);
    if (error) return error;

    const text = normalizeChatText(msg && msg.text, CHAT_TEXT_MAX);
    if (!text) {
      return reject(ack, 'BAD_MESSAGE', `Message must be 1-${CHAT_TEXT_MAX} characters.`);
    }

    // Rebuild the message from server-known fields. `senderName` and `senderId`
    // are IGNORED if present — the authenticated actor supplies both.
    const clean = {
      id: normalizeId(msg && msg.id) || `m${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      senderId: actor.id,
      senderName: actor.name,
      text,
      at: Date.now(),
    };

    room.addChatMessage(clean);
    console.log(`💬 [Room ${roomId}] ${clean.senderName}: ${clean.text}`);
    // Echo to the sender too, so their own message renders from the SAME cleaned
    // payload everyone else receives (rather than from local optimistic state).
    io.to(roomId).emit('chat:message', clean);
    if (typeof ack === 'function') ack({ ok: true, message: clean });
  }));

  // Auction System Events
  socket.on('auction:start', withRoom((room, roomId, data, ack) => {
    if (!data || !data.auction) {
      return reject(ack, 'BAD_PAYLOAD', 'auction:start needs an auction.');
    }
    // AUTHORIZATION: only the identified player whose turn it is may open an
    // auction, matching every other board-changing action.
    const gateError = turnGate(room, ack, data.playerId);
    if (gateError) return gateError;

    if (room.activeAuction) {
      return reject(ack, 'AUCTION_IN_PROGRESS', 'An auction is already running in this room.');
    }
    if (!isOwnableTile(data.auction.tileId)) {
      return reject(ack, 'BAD_TILE', `Tile ${data.auction.tileId} cannot be auctioned.`);
    }
    if (room.propertyOwnership[data.auction.tileId] !== undefined) {
      return reject(ack, 'ALREADY_OWNED', `Tile ${data.auction.tileId} is already owned.`);
    }
    // The auction opens with NO bidder and no passed list, whatever the payload
    // claimed. A client must not be able to pre-seed itself as the highest bidder
    // or pre-pass its rivals.
    room.activeAuction = {
      ...data.auction,
      highestBidderId: null,
      passedPlayerIds: [],
      timeLeft: 15,
    };
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
  //
  // AUTHORIZATION: the bidder is the AUTHENTICATED socket, not
  // `incoming.highestBidderId`. Previously the server read the bidder id straight
  // from the payload, so any client could place a bid "as" another player —
  // committing that player's money and making them the highest bidder. The
  // payload's highestBidderId is now IGNORED and replaced with the real actor.
  socket.on('auction:bid', withRoom((room, roomId, data, ack) => {
    if (!data || !data.auction) {
      return reject(ack, 'BAD_PAYLOAD', 'auction:bid needs an auction.');
    }
    const { actor, error } = requireActor(room, ack);
    if (error) return error;

    const live = room.activeAuction;
    if (!live) return reject(ack, 'NO_AUCTION', 'There is no active auction.');

    const incoming = data.auction;
    if (incoming.id !== live.id) {
      return reject(ack, 'STALE_AUCTION', 'Bid is for a different auction than the live one.');
    }
    // The bidder is the socket's own player, whatever the payload claimed.
    const bidderId = actor.id;
    const bidder = actor;

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
    // Affordability is checked against the SERVER's balance for the real bidder.
    // Zero is a real balance: the old `money > 0` guard skipped the check for a
    // player with exactly $0, letting them bid with no funds.
    if (newBid > bidder.money) {
      return reject(ack, 'INSUFFICIENT_FUNDS', `Player ${bidderId} can't cover a $${newBid} bid with $${bidder.money}.`);
    }

    // Store the auction with the SERVER's bidder id, so a later end settles to
    // the player who really bid rather than whoever the payload named.
    const updated = { ...incoming, highestBidderId: bidderId, timeLeft: 15 };
    room.activeAuction = updated;
    room.startAuctionTimer(io);
    console.log(`🔨 Room ${roomId}: Bid $${updated.currentBid} by Player ${bidderId}`);
    socket.to(roomId).emit('auction:bid', { ...data, auction: updated });
    if (typeof ack === 'function') ack({ ok: true, bidderId, currentBid: updated.currentBid });
  }));

  // Passing: the auction must be live and the passer must be a real player.
  //
  // AUTHORIZATION: a pass is recorded for the AUTHENTICATED socket only. The
  // payload's `passedPlayerIds` used to be trusted wholesale, so one client could
  // pass on behalf of the whole table (or add anyone to the passed list) and
  // force the auction to close. Now the server appends the actor itself and
  // ignores the supplied list entirely.
  socket.on('auction:pass', withRoom((room, roomId, data, ack) => {
    if (!data || !data.auction) {
      return reject(ack, 'BAD_PAYLOAD', 'auction:pass needs an auction.');
    }
    const { actor, error } = requireActor(room, ack);
    if (error) return error;

    const live = room.activeAuction;
    if (!live) return reject(ack, 'NO_AUCTION', 'There is no active auction.');
    if (data.auction.id !== live.id) {
      return reject(ack, 'STALE_AUCTION', 'Pass is for a different auction than the live one.');
    }

    // Build the passed list from SERVER state plus this one actor. A player
    // already on it is a no-op rather than an error, so a duplicate pass frame
    // (or a double-click) is harmless.
    const alreadyPassed = Array.isArray(live.passedPlayerIds) ? live.passedPlayerIds : [];
    const passedPlayerIds = alreadyPassed.includes(actor.id)
      ? alreadyPassed
      : [...alreadyPassed, actor.id];

    const updated = { ...live, passedPlayerIds };
    room.activeAuction = updated;
    console.log(`❌ Room ${roomId}: Player ${actor.id} passed on the auction`);
    socket.to(roomId).emit('auction:pass', { ...data, auction: updated });
    if (typeof ack === 'function') ack({ ok: true, passedPlayerIds });
  }));

  // Ending an auction settles ownership, so it must not be triggered arbitrarily.
  //
  // AUTHORIZATION: the winner is read from SERVER auction state (room.activeAuction),
  // never from the payload — otherwise a client could name itself the winner and
  // be handed the property. A client may only ask to end the auction it is
  // actually in, and the server settles from its own record of the highest bid.
  socket.on('auction:end', withRoom((room, roomId, data, ack) => {
    if (!data || !data.auction) {
      return reject(ack, 'BAD_PAYLOAD', 'auction:end needs an auction.');
    }
    const { actor, error } = requireActor(room, ack);
    if (error) return error;

    if (data.actionId) {
      const replayError = actionGate(room, ack, data.actionId);
      if (replayError) return replayError;
    }

    const live = room.activeAuction;
    if (!live) return reject(ack, 'NO_AUCTION', 'There is no active auction.');
    if (data.auction.id !== live.id) {
      return reject(ack, 'STALE_AUCTION', 'End is for a different auction than the live one.');
    }

    const outcome = room.settleAuction(io);
    if (!outcome) {
      return reject(ack, 'NO_AUCTION', 'There is no active auction.');
    }

    console.log(`🔨 Room ${roomId}: Auction ended by Player ${actor.id}. Winner: ${outcome.winnerId ?? 'None'}`);
    if (typeof ack === 'function') {
      ack({
        ok: true,
        winnerId: outcome.winnerId ?? null,
        tileId: outcome.tileId,
        currentBid: outcome.settled.currentBid,
        winnerMoney: outcome.winnerMoney,
      });
    }
  }));

  // ===================== NO ARBITRARY EVENT PASSTHROUGH =====================
  //
  // There used to be a `socket.onAny(...)` fallback here that re-broadcast any
  // unrecognised event to the sender's room:
  //
  //     socket.to(roomId).emit(event, ...args);
  //
  // It was guarded by a blocklist of the server's own event names, but a blocklist
  // is the wrong shape for this: it can only ever enumerate what the server HAPPENS
  // to emit today, while the client listens for a larger set (game:over,
  // room:players, turn:changed, room:joined, auction:tick, room:error, ...). Any
  // name not on the list was relayed verbatim, with an attacker-chosen payload.
  // That is a forgery primitive: a peer could emit `game:over` and every other
  // client would receive it exactly as if the server had declared a winner.
  //
  // It is REMOVED rather than tightened. There is no legitimate use for it — every
  // state-changing event has an explicit handler above, and each of those is the
  // only place its name is broadcast. Authoritative events therefore reach clients
  // ONLY through `io.to(roomId).emit(...)` / `socket.to(roomId).emit(...)` calls
  // written by the server, which is the property this file now relies on:
  //
  //   * game:over       - declareWinner() / handleTurnTimeout() / the abandon path
  //   * room:players    - player:set-name, player:set-color, player:set-max-players
  //   * turn:changed    - beginTurn() and the first-roll start path
  //   * room:joined     - emitRoomJoined() on create / join / rejoin
  //   * auction:tick    - GameRoom.startAuctionTimer()'s 1s interval
  //   * room:error      - the room:create / room:join rejection paths
  //
  // An unrecognised event name from a client is now simply unhandled: Socket.IO
  // drops it, nothing is broadcast, and no peer is affected.

  // Socket Disconnection — hands its room back if it was the last member incl.
  // the host, and notifies only the peers in that same room.
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    // Capture who this was BEFORE leaveRoom() drops the room + token binding.
    const room = roomId ? rooms.get(roomId) : null;
    const wasInGame = !!(room && room.isGameStarted && !room.isGameOver);
    const leaverId = actingPlayerId();

    leaveRoom(socket);
    console.log(`🔴 Socket disconnected: ${socket.id}${roomId ? ` (was in Room ${roomId})` : ' (lobby)'}`);

    // A DROP-OUT FROM A LIVE GAME IS AN ELIMINATION, exactly like an explicit
    // room:leave. Without this, a player whose browser died stays a non-bankrupt
    // "player" forever: the turn can land on the empty seat and sit there until
    // the clock expires, the win check never sees a sole survivor, and the game
    // hangs in a one-sided state that can never finish.
    //
    // Runs AFTER leaveRoom() so the departing socket isn't counted as still
    // present, and only for a live game — a lobby disconnect must not bankrupt
    // anyone, and a finished game must not be reopened.
    if (wasInGame && room && leaverId !== null) {
      // ===== THE ROOM MAY ALREADY BE GONE =====
      // leaveRoom() tears a room down the moment its last socket leaves, and that
      // teardown deletes the room from `rooms` AND removes its persisted file.
      // The elimination logic below then used to call persistRoom(room) on that
      // dead object, which RECREATED the file for a room that no longer exists —
      // an orphan on disk that came back on the next boot. Bail out early when the
      // room is already torn down; there is nothing left to eliminate or persist.
      if (!rooms.has(room.roomId)) return;

      const leaver = room.players.find(p => p.id === leaverId);
      if (leaver && !leaver.isBankrupt) {
        leaver.isBankrupt = true;
        leaver.money = 0;
        for (const [tileId, ownerId] of Object.entries(room.propertyOwnership)) {
          if (ownerId === leaver.id) {
            delete room.propertyOwnership[tileId];
            delete room.propertyHouses[tileId];
          }
        }
        io.to(room.roomId).emit('player:bankrupt', { playerId: leaver.id, reason: 'disconnected' });
        persistRoom(room);

        // Nobody left holding a seat: the game is over with no winner.
        const stillSeated = room.players.filter(
          p => !p.isBankrupt && room.tokens.has(p.sessionToken || '')
        );
        if (stillSeated.length === 0) {
          room.isGameOver = true;
          room.winnerId = null;
          room.winnerReason = 'abandoned';
          room.clearTurnTimer();
          room.clearAuctionTimer();
          persistRoom(room);
          io.to(room.roomId).emit('game:over', { winnerId: null, winnerName: null, reason: 'abandoned' });
          console.log(`🏳️ Room ${room.roomId}: every player disconnected — game over (abandoned)`);
        } else {
          const survivor = findSoleSurvivor(room);
          if (survivor) declareWinner(room, io, survivor, 'last-player-standing');
        }
      }
    }
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

// ================= GRACEFUL SHUTDOWN =================
let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);

  // Persist all active/in-memory rooms before exiting
  let persistedCount = 0;
  for (const room of rooms.values()) {
    try {
      if (persistRoom(room)) {
        persistedCount++;
      }
    } catch (err) {
      console.error(`⚠️  Failed to persist room ${room && room.roomId} during shutdown: ${err.message}`);
    }
  }
  console.log(`💾 Persisted ${persistedCount} room(s) to disk.`);

  // Cleanly close Socket.IO and HTTP server
  io.close(() => {
    server.close(() => {
      console.log('🏁 Server closed cleanly. Exiting.');
      process.exit(0);
    });
  });

  // Safety fallback: if connections hang and closing takes too long, force exit
  const forceExitTimer = setTimeout(() => {
    console.error('⚠️  Graceful shutdown timed out after 5s. Forcing exit.');
    process.exit(1);
  }, 5000);
  if (typeof forceExitTimer.unref === 'function') {
    forceExitTimer.unref();
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
