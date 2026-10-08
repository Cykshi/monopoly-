// ================= TURN / MOVEMENT HELPERS =================
//
// STATUS: this module is NOT wired into the running server. The authoritative
// turn engine lives in backend/server.js (the GameRoom class: seedTurn,
// advanceTurn, startTurnTimer, beginTurn, claimAction) and that is what every
// socket handler calls. Nothing here is required by server.js or by any test.
//
// It is kept because the helpers below are useful PURE functions for exercising
// movement maths without a socket. Its comments previously claimed guarantees
// the code did not provide; those are corrected here rather than left to
// mislead the next reader:
//
//   * "replay-proof" / "auditable" - REMOVED. The old nextActionSeq() /
//     isCurrentActionSeq() pair could not reject a replay: nextActionSeq()
//     incremented `room.actionSeq` but stored it nowhere the check read, and
//     isCurrentActionSeq() compared against `room.lastActionSeq`, which
//     beginTurn() set from a DIFFERENT counter (`turnSeq`). Two counters, no
//     shared namespace, so the guard was inert. Real replay protection now
//     lives in GameRoom.claimAction() in server.js, keyed on a client-supplied
//     `actionId` recorded in `room.processedActions`.
//
//   * "preserves jail state" - REMOVED. advancePlayer() never read or wrote any
//     jail field; the comment described behaviour that did not exist.
//
//   * "the server deadline" - REMOVED. TURN_DURATION_MS was a second, unused
//     120s constant that disagreed with the enforced clock. The ONE
//     authoritative duration is TURN_TIME_LIMIT_MS in server.js.
//
// If you wire this module back in, reconcile it with server.js rather than
// trusting it as-is.

const { isIntInRange, isMoneyAmount } = require('./validation');

// Salary credited for crossing GO.
const SALARY = 200;

// ---------------------------------------------------------------- ownership

// The player at a given roster index. NOTE: the running server does NOT track
// the active player by array index — it stores `currentTurnPlayerId` on the
// room, because indices shift as players join and leave. This helper is only
// meaningful for a caller that already maintains its own turnIndex.
function getActivePlayer(room) {
  if (!room || !room.players) return undefined;
  return room.players[room.turnIndex];
}

// The player a socket is authenticated as. `socket.id` is set by Socket.IO
// itself and cannot be forged over the wire — this is the only sender identity
// we ever trust. A payload may *carry* a playerId, but it is never the basis
// for "who is asking"; it is at most a hint to be checked against this.
function getSocketPlayer(room, socket) {
  if (!room || !room.players || !socket) return undefined;
  const playerId = socket.data && socket.data.playerId;
  if (!playerId) return undefined;
  return room.players.find((p) => p && p.id === playerId);
}

// True when `socket` is the player who currently owns the turn.
function isActiveTurnPlayer(room, socket) {
  const active = getActivePlayer(room);
  const actor = getSocketPlayer(room, socket);
  return Boolean(active && actor && active.id === actor.id);
}

// ---------------------------------------------------------------- mutations

// Move a player by `steps`, wrapping at the end of the board. Passing GO is
// detected here — on the server — so the salary is credited server-side and
// never comes from a client-supplied balance. Returns a small description the
// caller can broadcast (landed index, whether GO was passed).
//
// Deliberately does NOT handle the landing consequences (rent, card, tax):
// those depend on the board module and stay in the transaction layer. Keeping
// "move" and "what the square does" separate is what lets the tests drive a
// raw move without triggering a payment.
function advancePlayer(room, player, steps, boardSize) {
  const start = player.position || 0;
  const raw = start + steps;
  // Wrapped arithmetic: we only care about the final index; the number of laps
  // matters solely to decide whether the player crossed GO.
  const wrapped = ((raw % boardSize) + boardSize) % boardSize;
  const passedGo = raw >= boardSize;

  player.position = wrapped;
  // NO JAIL STATE IS TOUCHED HERE. No jail field is read or written by this
  // function, so a caller that needs a jailed player to skip their move must
  // decide that BEFORE calling in. (The server today has no jail-skip rule on
  // the move path, so there is nothing here to preserve.)
  const result = { from: start, position: wrapped, passedGo, steps };

  if (passedGo) {
    // Salary is applied server-side. There is no client "money" field in this
    // path at all, so there is nothing for a hostile client to overwrite.
    creditPlayer(player, SALARY, 'Passed GO');
    result.salary = SALARY;
  }
  return result;
}

// ---------------------------------------------------------------- money
//
// These two mutate `player.money` directly and append a BOUNDED LOCAL LEDGER to
// the player record. The ledger is a convenience log for whoever owns the
// record — it is NOT a transaction log and carries NO idempotency key, so it
// cannot by itself prove a transaction happened exactly once. Do not describe it
// as an audit trail or as replay protection.
//
// The running server moves money through these rules directly in server.js
// rather than through this module; keep the two in step if you wire it back in.

function creditPlayer(player, amount, reason) {
  if (!player) return false;
  // Whole, non-negative dollars only: rejects NaN, Infinity, negatives,
  // fractions and non-numbers.
  if (!isMoneyAmount(amount)) return false;
  player.money += amount;
  recordLedger(player, amount, reason);
  return true;
}

function debitPlayer(player, amount, reason) {
  if (!player) return false;
  if (!isMoneyAmount(amount)) return false;
  player.money -= amount;
  recordLedger(player, -amount, reason);
  return true;
}

// Append to the player's bounded ledger. Oldest entries fall out past the cap.
// This is a LOG, not an idempotency record: see the note above creditPlayer().
const LEDGER_LIMIT = 100;

function recordLedger(player, delta, reason) {
  if (!player) return;
  if (!Array.isArray(player.ledger)) player.ledger = [];
  player.ledger.push({ delta, reason, at: Date.now() });
  if (player.ledger.length > LEDGER_LIMIT) {
    player.ledger.splice(0, player.ledger.length - LEDGER_LIMIT);
  }
}

// ---------------------------------------------------------------- turn clock
//
// NOTE: the running server does NOT use these. Its clock is armed by
// GameRoom.startTurnTimer() in server.js, which stamps `turnStartedAt` and
// derives `turnDeadline` from TURN_TIME_LIMIT_MS. The functions below are kept
// only as pure helpers over a room-shaped object; they read the SAME fields the
// server writes, so they agree with it as long as `turnDeadline` was set by the
// server. They no longer invent their own duration.

// The deadline the SERVER recorded for the current turn, or null when no turn
// clock is armed. Read straight from the room — this function does not compute a
// deadline from any constant of its own, because a second source of truth is
// exactly the bug this file used to have.
function getTurnDeadline(room) {
  if (!room) return null;
  if (!Number.isFinite(room.turnDeadline)) return null;
  return room.turnDeadline;
}

// Remaining milliseconds, floored at 0. Negative values would mean "already
// expired", which a client would render as a countdown counting upward.
function getTurnRemaining(room, now = Date.now()) {
  const deadline = getTurnDeadline(room);
  if (deadline === null) return null;
  return Math.max(0, deadline - now);
}

// Has the current turn run out, according to the SERVER's deadline and the
// SERVER's clock? Both come from the room, neither from the browser.
function isTurnExpired(room, now = Date.now()) {
  const deadline = getTurnDeadline(room);
  if (deadline === null) return false;
  return now >= deadline;
}

// NOTE: beginTurn / nextActionSeq / isCurrentActionSeq were REMOVED from this
// module. They were a second, competing turn/sequence implementation whose two
// counters (`turnSeq` and `actionSeq`) lived in different namespaces and were
// never compared to each other, so the "replay" guard they implied could not
// fire. The server owns turn advancement (GameRoom.beginTurn in server.js) and
// replay rejection (GameRoom.claimAction) instead. Leaving them here would be a
// dead implementation that still LOOKS authoritative.

// ---------------------------------------------------------------- movement

// The complete movement transaction MINUS consequences. Validates the step
// count, then moves the token and credits any GO salary.
//
// CONTRACT — read before using:
//   * `steps` must be an INTEGER. NaN, Infinity, a string or a fraction is
//     rejected with INVALID_STEPS.
//   * `steps` must be within +/- 4 laps of the board. That is a sanity bound on
//     the REQUEST, not a rules limit on a legal move — the real per-move limit
//     belongs to the caller, which knows the dice.
//   * THE RESULTING POSITION IS NOT VALIDATED, and cannot be: this function
//     computes it by wrapping, so it is always a valid index by construction. A
//     caller wanting "must land on a reachable square" must enforce that itself.
//   * The client's idea of its position is never read. Only `steps` comes in;
//     the new position is derived from the SERVER's `player.position`.
//   * Landing consequences (rent, tax, cards) are NOT applied.
function applyMovement(room, player, steps, boardSize) {
  if (!Number.isInteger(steps)) {
    return { ok: false, code: 'INVALID_STEPS', error: 'Movement must be a whole number.' };
  }
  if (!Number.isInteger(boardSize) || boardSize <= 0) {
    return { ok: false, code: 'INVALID_BOARD', error: 'Board size must be a positive integer.' };
  }
  // Four laps of slack: generous for an "advance to nearest X" card, tight
  // enough that a hostile value cannot walk the arithmetic far out of range.
  if (!isIntInRange(steps, -boardSize * 4, boardSize * 4)) {
    return { ok: false, code: 'INVALID_STEPS', error: 'Movement is out of range.' };
  }
  const info = advancePlayer(room, player, steps, boardSize);
  return { ok: true, ...info };
}

module.exports = {
  SALARY,
  getActivePlayer,
  getSocketPlayer,
  isActiveTurnPlayer,
  advancePlayer,
  creditPlayer,
  debitPlayer,
  recordLedger,
  getTurnDeadline,
  getTurnRemaining,
  isTurnExpired,
  applyMovement,
};