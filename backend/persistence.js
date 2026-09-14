// ================= ROOM PERSISTENCE (SURVIVES A RESTART) =================
//
// Scope: keep enough of each room on disk that a server restart doesn't silently
// orphan live games. We persist ONE JSON file per room under DATA_DIR. That's
// deliberately simple — the whole point is to survive a process bounce, not to
// be a queryable database. No external service, no schema migrations.
//
// What we persist is the durable GAME state (below), NOT live transport state
// (socket ids). On boot we rebuild the in-memory GameRoom from these files, so a
// returning player can player:rejoin with a token that was issued before the
// restart and land back in the same seat.
//
// We do NOT write on every event. Writes are triggered at MEANINGFUL state
// changes (room create, turn advance, purchase/build, trade lifecycle, auction
// lifecycle, elimination, seat binding) via persistRoom(room) in server.js.
// Chat, movement and dice rolls are transient and intentionally not persisted.
const fs = require('fs');
const path = require('path');

// Where room files live. Overridable so tests can point at a throwaway dir.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

// Name of a room's file. Room codes are already [A-Z2-9]{6}, so this is a safe
// filename with no extra escaping needed — but we still guard on read.
function roomFile(roomId) {
  return path.join(DATA_DIR, `${roomId}.json`);
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Reduce a GameRoom to the durable subset we care about. Anything omitted here
// is transport/derived state that is rebuilt on boot (e.g. timers, socket sets).
function serializeRoom(room) {
  return {
    roomId: room.roomId,
    hostToken: room.hostToken,
    // Tokens are persisted so a pre-restart session can still rejoin: resolveSession
    // checks `sessions`, which we repopulate from this list on load.
    tokens: Array.from(room.tokens || []),
    players: room.players,
    propertyOwnership: room.propertyOwnership,
    propertyHouses: room.propertyHouses,
    currentTurnPlayerId: room.currentTurnPlayerId,
    turnSeeded: room.turnSeeded,
    trades: room.trades,
    activeAuction: room.activeAuction,
    createdAt: room.createdAt,
    // Bumped on every write. Useful for tests/debugging to prove a write landed.
    savedAt: Date.now()
  };
}

// Write a room to disk atomically (temp file + rename) so a crash mid-write can
// never leave a half-written, unparseable file behind — the old good copy stays
// until the new one is fully on disk.
function persistRoom(room) {
  if (!room || !room.roomId) return false;
  try {
    ensureDataDir();
    const target = roomFile(room.roomId);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(serializeRoom(room)));
    fs.renameSync(tmp, target);
    return true;
  } catch (err) {
    console.error(`⚠️  Failed to persist room ${room.roomId}: ${err.message}`);
    return false;
  }
}

// Remove a room's persisted file. Called from teardownRoom so a normally-finished
// (or abandoned past the empty-room TTL) game doesn't accumulate on disk forever.
function deleteRoomFile(roomId) {
  if (!roomId) return false;
  try {
    const target = roomFile(roomId);
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
      return true;
    }
  } catch (err) {
    console.error(`⚠️  Failed to delete persisted room ${roomId}: ${err.message}`);
  }
  return false;
}

// Load every persisted room as plain objects. Returns an array of the serialized
// shapes; the caller rehydrates them into live GameRoom instances. A corrupt or
// unreadable file is skipped (and reported) rather than taking the whole boot
// down — one bad room must not stop the server from starting.
function loadPersistedRooms() {
  const loaded = [];
  if (!fs.existsSync(DATA_DIR)) return loaded;

  for (const name of fs.readdirSync(DATA_DIR)) {
    if (!name.endsWith('.json')) continue; // ignore stray .tmp / other files
    const full = path.join(DATA_DIR, name);
    try {
      const raw = fs.readFileSync(full, 'utf8');
      const data = JSON.parse(raw);
      if (data && data.roomId) {
        loaded.push(data);
      } else {
        console.error(`⚠️  Skipping ${name}: no roomId`);
      }
    } catch (err) {
      console.error(`⚠️  Skipping unreadable room file ${name}: ${err.message}`);
    }
  }
  return loaded;
}

module.exports = {
  DATA_DIR,
  roomFile,
  serializeRoom,
  persistRoom,
  deleteRoomFile,
  loadPersistedRooms
};
