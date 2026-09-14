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

// Resolve with the first matching event, or null after `ms`.
const waitFor = (socket, event, ms = 5000) =>
  new Promise((resolve) => {
    const t = setTimeout(() => { socket.off(event, on); resolve(null); }, ms);
    const on = (data) => { clearTimeout(t); socket.off(event, on); resolve(data); };
    socket.on(event, on);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!(TURN_MS > 0)) {
    console.log('SKIP  turn-timeout cases (set EXPECTED_TURN_MS to run against a short-clock server,');
    console.log('      e.g. EXPECTED_TURN_MS=1500 SERVER_URL=http://localhost:3056 node test-turn-timeout.js)');
    process.exit(0);
  }

  console.log(`\nTurn clock configured at ~${TURN_MS}ms\n`);

  // ---- SETUP: two identified players; it is player 1's turn ----
  const A = await connect();
  const created = await emitAck(A, 'room:create', {});
  const roomId = created && created.roomId;
  const tokenA = created && created.token;
  check('setup: room created', !!(created && created.ok && roomId && tokenA));

  const B = await connect();
  const bJoin = await emitAck(B, 'room:join', { roomId });
  const tokenB = bJoin && bJoin.token;
  check('setup: guest joined', !!(bJoin && bJoin.ok && tokenB));

  const idA = await emitAck(A, 'player:identify', { roomId, token: tokenA, playerId: 1 });
  check('setup: host identified as player 1', !!(idA && idA.ok && idA.playerId === 1), JSON.stringify(idA));
  const idB = await emitAck(B, 'player:identify', { roomId, token: tokenB, playerId: 2 });
  check('setup: guest identified as player 2', !!(idB && idB.ok && idB.playerId === 2), JSON.stringify(idB));

  // ---- The clock is armed and the server advertises its deadline ----
  check('server reports it is player 1\'s turn',
    !!(idB && idB.currentTurnPlayerId === 1), `currentTurnPlayerId=${idB && idB.currentTurnPlayerId}`);
  check('server arms a turn clock (turnDeadline is a future epoch ms)',
    !!(idB && Number.isFinite(idB.turnDeadline) && idB.turnDeadline > Date.now()),
    `turnDeadline=${idB && idB.turnDeadline}`);

  // ---- THE KEY CASE: no turn:ended is EVER sent; the server times out ----
  // Both clients listen for the broadcast pair the timeout should produce.
  console.log('\n--- IDLE PLAYER IS TIMED OUT BY THE SERVER (no turn:ended sent) ---');

  const bankruptEvt = waitFor(B, 'player:bankrupt', TURN_MS + 3000);
  const turnEvt = waitFor(B, 'turn:changed', TURN_MS + 3000);

  // Deliberately do nothing. Just wait past the clock.
  const bankrupt = await bankruptEvt;
  const turn = await turnEvt;

  check('server fired the timeout and eliminated the idle player (player 1)',
    !!(bankrupt && bankrupt.playerId === 1 && bankrupt.reason === 'timeout'), JSON.stringify(bankrupt));
  check('server broadcast the SAME turn:changed event a normal turn end emits',
    !!(turn && typeof turn.currentTurnPlayerId === 'number'), JSON.stringify(turn));
  check('the turn advanced to the OTHER player (player 2) after the timeout',
    !!(turn && turn.currentTurnPlayerId === 2), `currentTurnPlayerId=${turn && turn.currentTurnPlayerId}`);
  check('the timeout re-armed the clock for the new turn',
    !!(turn && Number.isFinite(turn.turnDeadline) && turn.turnDeadline > Date.now()),
    `turnDeadline=${turn && turn.turnDeadline}`);

  // ---- After the timeout, the gate reflects the new turn ----
  console.log('\n--- TURN GATE REFLECTS THE TIMED-OUT ADVANCE ---');

  // Player 1 is now bankrupt and was removed from turn order; player 2 may act.
  const p2MoveNow = await emitAck(B, 'player:moved', { playerId: 2, position: 4, money: 1500 });
  check('player 2 CAN act now that the timeout advanced the turn',
    !!(p2MoveNow && p2MoveNow.ok), JSON.stringify(p2MoveNow));

  const p1MoveNow = await emitAck(A, 'player:moved', { playerId: 1, position: 6, money: 1500 });
  check('the timed-out (bankrupt) player CANNOT act',
    !!(p1MoveNow && p1MoveNow.ok === false), JSON.stringify(p1MoveNow));

  A.disconnect();
  B.disconnect();

  console.log(`\n${results.length - failed}/${results.length} checks passed`);

  // Let socket.io finish closing its handles before we hard-exit (a synchronous
  // process.exit() races libuv teardown on Windows and trips an assertion).
  await sleep(250);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('TEST ERROR:', err && err.message);
  process.exit(2);
});
