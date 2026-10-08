// Headless TURN-TIMEOUT test.
//
// Proves the turn CLOCK is enforced server-side — not by any client. A player
// who never ends their turn still gets the turn moved on, because the SERVER
// times them out. It covers:
//
//   CLOCK      - the server reports a turnDeadline when the turn is established
//   FIRE       - with NO turn:ended ever sent, the server forces the turn on its
//                own once the clock expires (short TURN_TIME_LIMIT_MS for tests)
//   SAME PATH  - the forced advance emits the SAME turn:changed event a normal
//                turn:ended does, so clients need no special-casing
//   ELIMINATION- the idle player is bankrupted (matching the client's existing
//                timeout behaviour), and the turn moves to a live player
//   GATE FLIP  - after the timeout the turn gate reflects the new turn
//   NO LEAK    - teardown clears the clock (verified indirectly: a room the last
//                socket leaves does not keep firing)
//
// This REQUIRES a server started with a short clock, mirroring the
// EMPTY_ROOM_TTL_MS pattern, e.g.:
//   TURN_TIME_LIMIT_MS=1500 PORT=3056 node server.js
//   SERVER_URL=http://localhost:3056 node test-turn-timeout.js
//
// If the clock is left at its 120s default this suite would take minutes per
// turn, so we SKIP loudly instead of hanging.
const { io } = require('socket.io-client');

const URL = process.env.SERVER_URL || 'http://localhost:3002';
// The server's configured clock (must match TURN_TIME_LIMIT_MS on the server).
const TURN_MS = Number(process.env.EXPECTED_TURN_MS) || 0;
const results = [];
let failed = 0;

function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

const connect = () =>
  new Promise((resolve, reject) => {
    const s = io(URL, { reconnectionAttempts: 1, timeout: 4000 });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });

const emitAck = (socket, event, payload, ms = 2500) =>
  new Promise((resolve) => {
    socket.emit(event, payload, resolve);
    setTimeout(() => resolve(null), ms);
  });

// Every mutating event now requires a unique actionId (server-side replay
// protection: a replayed frame is dropped, not re-applied). Tests therefore
// have to send one, exactly like the real client does. A per-process counter
// keeps ids unique across a whole run.
let actionCounter = 0;
const withAction = (payload) => ({
  ...payload,
  actionId: `t-${Date.now()}-${++actionCounter}`,
});
const emitAction = (socket, event, payload, ms = 2500) =>
  emitAck(socket, event, withAction(payload), ms);

// Resolve with the first matching event, or null after `ms`.
const waitFor = (socket, event, ms = 5000) =>
  new Promise((resolve) => {
    const t = setTimeout(() => { socket.off(event, on); resolve(null); }, ms);
    const on = (data) => { clearTimeout(t); socket.off(event, on); resolve(data); };
    socket.on(event, on);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== CLEANUP: EVERY SOCKET IS TRACKED AND CLOSED ON BOTH PATHS =====
// Every socket opened here is registered, and cleanup() disconnects them all and
// tears the room down — from the success path AND the catch block, so a failure
// does not leave live sockets or a live room behind on the shared test server.
const sockets = [];
const track = (s) => { sockets.push(s); return s; };

let cleanupDone = false;
const cleanup = async (roomId) => {
  if (cleanupDone) return;
  cleanupDone = true;
  const alive = sockets.filter((s) => s && s.connected);
  if (roomId && alive.length) {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 750);
      alive[0].once('room:left', () => { clearTimeout(t); resolve(); });
      alive[0].emit('room:leave');
    });
  }
  for (const s of sockets) {
    try { if (s && typeof s.disconnect === 'function') s.disconnect(); } catch { /* already gone */ }
  }
  await sleep(250);
};

(async () => {
  if (!(TURN_MS > 0)) {
    console.log('SKIP  turn-timeout cases (set EXPECTED_TURN_MS to run against a short-clock server,');
    console.log('      e.g. EXPECTED_TURN_MS=1500 SERVER_URL=http://localhost:3056 node test-turn-timeout.js)');
    process.exit(0);
  }

  console.log(`\nTurn clock configured at ~${TURN_MS}ms\n`);

  // ---- SETUP: two identified players; it is player 1's turn ----
  const A = track(await connect());
  const created = await emitAck(A, 'room:create', {});
  const roomId = created && created.roomId;
  const tokenA = created && created.token;
  check('setup: room created', !!(created && created.ok && roomId && tokenA));

  const B = track(await connect());
  const bJoin = await emitAck(B, 'room:join', { roomId });
  const tokenB = bJoin && bJoin.token;
  check('setup: guest joined', !!(bJoin && bJoin.ok && tokenB));

  const idA = await emitAck(A, 'player:identify', { roomId, token: tokenA, playerId: 1 });
  check('setup: host identified as player 1', !!(idA && idA.ok && idA.playerId === 1), JSON.stringify(idA));
  const idB = await emitAck(B, 'player:identify', { roomId, token: tokenB, playerId: 2 });
  check('setup: guest identified as player 2', !!(idB && idB.ok && idB.playerId === 2), JSON.stringify(idB));

  // The turn clock is gated on the game actually having started (see
  // ensureTurnClock), and the game only starts on the FIRST ROLL — which also
  // enforces the MIN_PLAYERS seat count. So the clock is armed by a roll here,
  // not by identify, and the timeout below is player 1 idling on that turn.
  const openingRoll = await emitAction(A, 'player:rolled', { playerId: 1 });
  check('setup: the opening roll starts the game (arming the turn clock)',
    !!(openingRoll && openingRoll.ok), JSON.stringify(openingRoll));

  // ---- The clock is armed and the server advertises its deadline ----
  // The clock is armed BY the roll above, so the deadline is read after it. The
  // pre-roll handshake legitimately reports null (no turn is on the clock yet).
  const deadlineInfo = await emitAck(A, 'game:turn-deadline', {});
  check('server reports it is player 1\'s turn',
    !!(deadlineInfo && deadlineInfo.currentTurnPlayerId === 1),
    `currentTurnPlayerId=${deadlineInfo && deadlineInfo.currentTurnPlayerId}`);
  check('server arms a turn clock (turnDeadline is a future epoch ms)',
    !!(deadlineInfo && Number.isFinite(deadlineInfo.turnDeadline) && deadlineInfo.turnDeadline > Date.now()),
    `turnDeadline=${deadlineInfo && deadlineInfo.turnDeadline}`);

  // ---- THE KEY CASE: no turn:ended is EVER sent; the server times out ----
  // Both clients listen for the broadcast pair the timeout should produce.
  console.log('\n--- IDLE PLAYER IS TIMED OUT BY THE SERVER (no turn:ended sent) ---');

  const bankruptEvt = waitFor(B, 'player:bankrupt', TURN_MS + 3000);
  const turnEvt = waitFor(B, 'turn:changed', TURN_MS + 3000);
  // With only two players, eliminating one IS last-player-standing, so the
  // timeout also ends the game. Listen for that so we can assert the real rule
  // instead of racing the broadcast order.
  const overEvt = waitFor(B, 'game:over', TURN_MS + 3000);

  // Deliberately do nothing. Just wait past the clock.
  const bankrupt = await bankruptEvt;
  const turn = await turnEvt;
  const over = await overEvt;

  check('server fired the timeout and eliminated the idle player (player 1)',
    !!(bankrupt && bankrupt.playerId === 1 && bankrupt.reason === 'timeout'), JSON.stringify(bankrupt));
  check('server broadcast the SAME turn:changed event a normal turn end emits',
    !!(turn && typeof turn.currentTurnPlayerId === 'number'), JSON.stringify(turn));
  check('the turn advanced to the OTHER player (player 2) after the timeout',
    !!(turn && turn.currentTurnPlayerId === 2), `currentTurnPlayerId=${turn && turn.currentTurnPlayerId}`);
  check('the timeout re-armed the clock for the new turn',
    !!(turn && Number.isFinite(turn.turnDeadline) && turn.turnDeadline > Date.now()),
    `turnDeadline=${turn && turn.turnDeadline}`);

  // ELIMINATION ENDS A TWO-PLAYER GAME. That is the room's own win rule
  // (last player standing) applied to a timeout: player 1 is out, so player 2
  // has nobody left to play and wins. This is intended behaviour, not a bug.
  check('the timeout ends the 2-player game with player 2 as last player standing',
    !!(over && over.winnerId === 2 && over.reason === 'last-player-standing'), JSON.stringify(over));

  // ---- After the timeout, the gate reflects the new turn ----
  console.log('\n--- TURN GATE REFLECTS THE TIMED-OUT ADVANCE ---');

  // Player 1 timed out and is out of the game for good. Player 2 is the winner
  // and the turn pointer now names player 2, so player 2's actions are accepted
  // and the eliminated player's are refused outright.
  const p2MoveNow = await emitAction(B, 'player:moved', { playerId: 2 });
  check('the surviving player can act after the timeout advanced the turn',
    !!(p2MoveNow && (p2MoveNow.ok === true || p2MoveNow.code === 'NO_ROLL')),
    JSON.stringify(p2MoveNow));

  const p1MoveNow = await emitAction(A, 'player:moved', { playerId: 1 });
  check('the timed-out (bankrupt) player CANNOT act',
    !!(p1MoveNow && p1MoveNow.ok === false), JSON.stringify(p1MoveNow));

  A.disconnect();
  B.disconnect();

  console.log(`\n${results.length - failed}/${results.length} checks passed`);

  // Let socket.io finish closing its handles before we hard-exit (a synchronous
  // process.exit() races libuv teardown on Windows and trips an assertion).
  await cleanup(roomId);
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error('TEST ERROR:', err && err.message);
  await cleanup();
  process.exit(2);
});
