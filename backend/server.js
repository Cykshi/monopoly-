const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

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
    this.hostId = hostSocketId;   // socket that created the room
    this.sockets = new Set();     // socket ids currently joined to this room
    this.players = [];
    this.propertyOwnership = {}; // tileId -> playerId
    this.propertyHouses = {};    // tileId -> houseCount
    this.trades = [];            // Array of TradeProposal
    this.chatMessages = [];      // Array of ChatMessage
    this.activeAuction = null;   // AuctionState | null
    this.auctionTimer = null;
    this.createdAt = Date.now();
  }

  isEmpty() {
    return this.sockets.size === 0;
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
}

// Global rooms map: roomCode -> GameRoom
const rooms = new Map();

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
    trades: room.trades,
    chatMessages: room.chatMessages,
    activeAuction: room.activeAuction
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
  socket.to(roomId).emit('room:peer-left', { socketId: socket.id, connectedCount: room.sockets.size });

  if (room.isEmpty()) {
    room.clearAuctionTimer();
    rooms.delete(roomId);
    console.log(`🧹 Room ${roomId} is empty — torn down (${rooms.size} room(s) remaining)`);
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
  const emitRoomJoined = (room, role) => {
    socket.emit('room:joined', {
      roomId: room.roomId,
      role,
      isHost: room.hostId === socket.id,
      connectedCount: room.sockets.size,
      state: serializeRoomState(room)
    });
  };

  // ---------- LOBBY: CREATE A ROOM ----------
  socket.on('room:create', (payload, ack) => {
    if (socket.data.roomId) leaveRoom(socket);

    const roomId = generateRoomCode();
    const room = getOrCreateRoom(roomId, socket.id);
    room.sockets.add(socket.id);
    socket.data.roomId = roomId;
    socket.join(roomId);

    console.log(`🏗️  Room ${roomId} created by ${socket.id}`);
    emitRoomJoined(room, 'host');
    if (typeof ack === 'function') ack({ ok: true, roomId });
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

    room.sockets.add(socket.id);
    socket.data.roomId = requested;
    socket.join(requested);

    console.log(`➡️  Socket ${socket.id} joined room ${requested} (${room.sockets.size} connected)`);
    emitRoomJoined(room, 'guest');
    socket.to(requested).emit('room:peer-joined', {
      socketId: socket.id,
      connectedCount: room.sockets.size
    });

    if (typeof ack === 'function') ack({ ok: true, roomId: requested });
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

  // ===================== ROOM-SCOPED GAME EVENTS =====================
  // Every handler below scopes to `currentRoom()`. If a socket hasn't joined a
  // room yet, the event is dropped — we never fall back to a global broadcast.
  // This is what guarantees a move in room A can't reach room B.
  //
  // `room` is the room snapshot captured at handler start; `roomId` is the
  // channel we broadcast into for that room only.
  const withRoom = (handler) => (data, ack) => {
    const room = currentRoom();
    if (!room) {
      if (typeof ack === 'function') ack({ ok: false, error: 'You are not in a room.' });
      return;
    }
    handler(room, room.roomId, data);
  };

  // Player Movement & Roll Events
  socket.on('player:moved', withRoom((room, roomId, data) => {
    if (data && data.playerId !== undefined) {
      const idx = room.players.findIndex(p => p.id === data.playerId);
      if (idx !== -1) {
        room.players[idx].position = data.position;
        if (data.money !== undefined) room.players[idx].money = data.money;
      }
    }
    socket.to(roomId).emit('player:moved', data);
  }));

  socket.on('player:rolled', withRoom((room, roomId, data) => {
    socket.to(roomId).emit('player:rolled', data);
  }));

  socket.on('player:skill-card', withRoom((room, roomId, data) => {
    socket.to(roomId).emit('player:skill-card', data);
  }));

  // Property & Upgrade Events
  socket.on('property:bought', withRoom((room, roomId, data) => {
    if (data && data.tileId !== undefined && data.playerId !== undefined) {
      room.propertyOwnership[data.tileId] = data.playerId;
      console.log(`🏠 Room ${roomId}: Tile ${data.tileId} purchased by Player ${data.playerId}`);
    }
    socket.to(roomId).emit('property:bought', data);
  }));

  socket.on('house:upgraded', withRoom((room, roomId, data) => {
    if (data && data.tileId !== undefined) {
      room.propertyHouses[data.tileId] = data.houses;
    }
    socket.to(roomId).emit('house:upgraded', data);
  }));

  // Player Elimination / Kick Events
  socket.on('player:bankrupt', withRoom((room, roomId, data) => {
    if (data && data.playerId !== undefined) {
      const p = room.players.find(x => x.id === data.playerId);
      if (p) p.isBankrupt = true;
      // Clear owned properties
      for (const [tileId, ownerId] of Object.entries(room.propertyOwnership)) {
        if (ownerId === data.playerId) {
          delete room.propertyOwnership[tileId];
          delete room.propertyHouses[tileId];
        }
      }
    }
    socket.to(roomId).emit('player:bankrupt', data);
  }));

  socket.on('player:kicked', withRoom((room, roomId, data) => {
    socket.to(roomId).emit('player:kicked', data);
  }));

  // Trading System Events
  socket.on('trade:created', withRoom((room, roomId, trade) => {
    if (trade && trade.id) {
      room.trades = [trade, ...room.trades.filter(t => t.id !== trade.id)];
    }
    socket.to(roomId).emit('trade:created', trade);
  }));

  socket.on('trade:updated', withRoom((room, roomId, trade) => {
    if (trade && trade.id) {
      room.trades = room.trades.map(t => t.id === trade.id ? trade : t);
    }
    socket.to(roomId).emit('trade:updated', trade);
  }));

  socket.on('trade:accepted', withRoom((room, roomId, data) => {
    if (data && data.trade) {
      const t = data.trade;
      room.trades = room.trades.map(x => x.id === t.id ? { ...x, status: 'accepted' } : x);
      // Transfer property ownership
      for (const tileId of t.initiatorPropertyIds) room.propertyOwnership[tileId] = t.targetId;
      for (const tileId of t.targetPropertyIds) room.propertyOwnership[tileId] = t.initiatorId;
    }
    socket.to(roomId).emit('trade:accepted', data);
  }));

  socket.on('trade:rejected', withRoom((room, roomId, data) => {
    if (data && data.tradeId) {
      room.trades = room.trades.map(t => t.id === data.tradeId ? { ...t, status: 'rejected' } : t);
    }
    socket.to(roomId).emit('trade:rejected', data);
  }));

  socket.on('trade:cancelled', withRoom((room, roomId, data) => {
    if (data && data.tradeId) {
      room.trades = room.trades.filter(t => t.id !== data.tradeId);
    }
    socket.to(roomId).emit('trade:cancelled', data);
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
  socket.on('auction:start', withRoom((room, roomId, data) => {
    if (data && data.auction) {
      room.activeAuction = { ...data.auction, timeLeft: data.auction.timeLeft || 15 };
      room.startAuctionTimer(io);
      console.log(`🔨 Room ${roomId}: Auction started for Tile ${data.auction.tileId}`);
    }
    socket.to(roomId).emit('auction:start', data);
  }));

  socket.on('auction:bid', withRoom((room, roomId, data) => {
    if (data && data.auction) {
      room.activeAuction = { ...data.auction, timeLeft: 15 }; // Reset timer to 15s on new bid
      room.startAuctionTimer(io);
      console.log(`🔨 Room ${roomId}: Bid $${data.auction.currentBid} by Player ${data.auction.highestBidderId}`);
    }
    socket.to(roomId).emit('auction:bid', data);
  }));

  socket.on('auction:pass', withRoom((room, roomId, data) => {
    if (data && data.auction) {
      room.activeAuction = data.auction;
    }
    socket.to(roomId).emit('auction:pass', data);
  }));

  socket.on('auction:end', withRoom((room, roomId, data) => {
    room.clearAuctionTimer();
    if (data && data.auction) {
      if (data.auction.highestBidderId !== null) {
        room.propertyOwnership[data.auction.tileId] = data.auction.highestBidderId;
      }
    }
    room.activeAuction = null;
    socket.to(roomId).emit('auction:end', data);
  }));

  // Generic Passthrough Fallback — also room-scoped. Lobby/room-control events
  // are excluded so they never get re-broadcast as game traffic.
  socket.onAny((event, ...args) => {
    const internalEvents = [
      'room:create', 'room:join', 'room:leave',
      'player:moved', 'player:rolled', 'player:skill-card', 'property:bought',
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

// Start Server on Port 3001
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`================================================`);
  console.log(`🚀 Monopoly Multiplayer Server running on http://localhost:${PORT}`);
  console.log(`📡 Socket.IO Real-time Engine active on port ${PORT}`);
  console.log(`================================================`);
});