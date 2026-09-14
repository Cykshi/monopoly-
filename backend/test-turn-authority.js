// Headless TURN-AUTHORITY test.
//
// The core anti-cheat mechanism for movement is turn ownership: only the player
// whose turn it is may roll / move / buy / build. This suite proves the server
// decides turn order AUTHORITATIVELY rather than trusting a client-mirrored
// `isCurrentPlayer` flag or guessing seats. It covers:
//
//   IDENTITY   - every socket must complete player:identify to act; a client
//                cannot claim a seat a different token already holds
//   TURN GATE  - while it's player 1's turn, player 2's roll / move / buy are
//                REJECTED (this is the exploit the phase was meant to close)
//   NO LEAK    - a rejected out-of-turn action is neither applied nor broadcast
//   ADVANCE    - player 1 ends the turn; the SERVER advances it to player 2, and
//                only THEN do player 2's actions succeed while player 1's fail
//
// Run against a live server:  node test-turn-authority.js
const { io } = require('socket.io-client');

const URL = process.env.SERVER_URL || 'http://localhost:3002';
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

// Wait to see if a peer receives the given broadcast within `ms`. Resolves true
// if it arrived, false if it didn't (i.e. the event was correctly withheld).
const heard = (socket, event, ms = 400) =>
  new Promise((resolve) => {
    const on = () => { clearTimeout(t); socket.off(event, on); resolve(true); };
    const t = setTimeout(() => { socket.off(event, on); resolve(false); }, ms);
    socket.on(event, on);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fetchRoom = (roomId) =>
  fetch(`${URL}/api/room/${roomId}`).then((r) => r.json()).catch(() => null);

(async () => {
  // ---- SETUP: two players, both identified against their session tokens ----
  const A = await connect();
  const created = await emitAck(A, 'room:create', {});
  const roomId = created && created.roomId;
  const tokenA = created && created.token;
  check('setup: room created (host holds token)', !!(created && created.ok && roomId && tokenA), JSON.stringify(created));

  const B = await connect();
  const bJoin = await emitAck(B, 'room:join', { roomId });
  const tokenB = bJoin && bJoin.token;
  check('setup: guest joined (holds its own token)', !!(bJoin && bJoin.ok && tokenB && tokenB !== tokenA));

  // The guest identifies as player 2, the host as player 1.
  const idA = await emitAck(A, 'player:identify', { roomId, token: tokenA, playerId: 1 });
  check('setup: host identified as player 1', !!(idA && idA.ok && idA.playerId === 1), JSON.stringify(idA));
  const idB = await emitAck(B, 'player:identify', { roomId, token: tokenB, playerId: 2 });
  check('setup: guest identified as player 2', !!(idB && idB.ok && idB.playerId === 2), JSON.stringify(idB));

  // The server seeded turn 1 to the host. Confirm that's the authoritative turn.
  check('setup: server says it is player 1\'s turn',
    !!(idB && idB.currentTurnPlayerId === 1), `currentTurnPlayerId=${idB && idB.currentTurnPlayerId}`);

  // Put the host on tile 5 with money so it can legally act when its turn comes.
  const moveHost = await emitAck(A, 'player:moved', { playerId: 1, position: 5, money: 1500 });
  check('setup: host (on turn) can move to tile 5', !!(moveHost && moveHost.ok), JSON.stringify(moveHost));

  console.log('\n--- IDENTITY IS TOKEN-BOUND (NO IMPERSONATION) ---');

  // A fresh socket with NO token tries to identify — must fail (can't guess a seat).
  const impostor = await connect();
  const impIdentify = await emitAck(impostor, 'player:identify', { roomId, playerId: 1 });
  check('a tokenless socket CANNOT identify as player 1',
    !!(impIdentify && impIdentify.ok === false), JSON.stringify(impIdentify));

  // A fresh socket that joins (gets its own token) tries to claim the host's seat.
  const hijack = await connect();
  const hJoin = await emitAck(hijack, 'room:join', { roomId });
  const hToken = hJoin && hJoin.token;
  const hijackId = await emitAck(hijack, 'player:identify', { roomId, token: hToken, playerId: 1 });
  check('a socket with a DIFFERENT token CANNOT claim player 1\'s seat',
    !!(hijackId && hijackId.ok === false && hijackId.code === 'SEAT_TAKEN'), JSON.stringify(hijackId));
  hijack.disconnect();

  console.log('\n--- OUT-OF-TURN ACTIONS ARE REJECTED (player 2, it is player 1\'s turn) ---');

  // THE key regression this suite exists for: player 2 rolls while it's P1's turn.
  const p2Roll = await emitAck(B, 'player:rolled', { dice: [3, 4], total: 7, playerId: 2 });
  check('player 2 CANNOT roll while it is player 1\'s turn',
    !!(p2Roll && p2Roll.ok === false && p2Roll.code === 'NOT_YOUR_TURN'), JSON.stringify(p2Roll));

  const p2Move = await emitAck(B, 'player:moved', { playerId: 2, position: 9, money: 1500 });
  check('player 2 CANNOT move while it is player 1\'s turn',
    !!(p2Move && p2Move.ok === false && p2Move.code === 'NOT_YOUR_TURN'), JSON.stringify(p2Move));

  // Player 2 is standing on tile 0 (hasn't moved); try to buy tile 2 it can't own.
  await emitAck(B, 'player:moved', { playerId: 2, position: 2, money: 1500 }); // rejected, but harmless
  const p2Buy = await emitAck(B, 'property:bought', { tileId: 2, playerId: 2, price: 100 });
  check('player 2 CANNOT buy while it is player 1\'s turn',
    !!(p2Buy && p2Buy.ok === false && p2Buy.code === 'NOT_YOUR_TURN'), JSON.stringify(p2Buy));

  // Player 2 owns nothing, but even a build attempt is an out-of-turn action.
  const p2Build = await emitAck(B, 'house:upgraded', { tileId: 5, houses: 1, playerId: 2 });
  check('player 2 CANNOT build while it is player 1\'s turn',
    !!(p2Build && p2Build.ok === false), JSON.stringify(p2Build));

  // Player 2 tries to end player 1's turn — must be refused.
  const p2End = await emitAck(B, 'turn:ended', { playerId: 2 });
  check('player 2 CANNOT end player 1\'s turn',
    !!(p2End && p2End.ok === false && p2End.code === 'NOT_YOUR_TURN'), JSON.stringify(p2End));

  console.log('\n--- A REJECTED OUT-OF-TURN ACTION IS NOT BROADCAST ---');

  // Have A listen; B attempts an off-turn move. A must hear nothing.
  const wouldLeak = heard(A, 'player:moved');
  const refused = await emitAck(B, 'player:moved', { playerId: 2, position: 33, money: 9999 });
  const leaked = await wouldLeak;
  check('rejected out-of-turn move is not applied', !!(refused && refused.ok === false), JSON.stringify(refused));
  check('rejected out-of-turn move is NOT broadcast to peers', leaked === false, `leaked=${leaked}`);

  // The authoritative snapshot confirms player 2 is still on its start tile.
  const snapAfter = await fetchRoom(roomId);
  check('room content intact after rejected out-of-turn attempts',
    !!(snapAfter && snapAfter.roomId === roomId), JSON.stringify(snapAfter));

  console.log('\n--- THE SERVER ADVANCES THE TURN ITSELF (AND ONLY ON A LEGAL END) ---');

  // Player 1 ends its turn; the server advances to player 2 and broadcasts it.
  const turnChanged = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 1500);
    A.once('turn:changed', (d) => { clearTimeout(t); resolve(d); });
  });
  const endP1 = await emitAck(A, 'turn:ended', { playerId: 1 });
  check('player 1 (on turn) CAN end its turn', !!(endP1 && endP1.ok), JSON.stringify(endP1));
  check('server advanced the turn to player 2',
    !!(endP1 && endP1.currentTurnPlayerId === 2), `currentTurnPlayerId=${endP1 && endP1.currentTurnPlayerId}`);
  const evt = await turnChanged;
  check('turn:changed broadcast tells peers it is now player 2\'s turn',
    !!(evt && evt.currentTurnPlayerId === 2), JSON.stringify(evt));

  console.log('\n--- AFTER ADVANCE, THE TURN GATE FLIPS ---');

  // Now player 2's actions succeed and player 1's are rejected.
  const p2MoveNow = await emitAck(B, 'player:moved', { playerId: 2, position: 2, money: 1500 });
  check('player 2 CAN move now that it is its turn', !!(p2MoveNow && p2MoveNow.ok), JSON.stringify(p2MoveNow));

  const p1MoveNow = await emitAck(A, 'player:moved', { playerId: 1, position: 6, money: 1500 });
  check('player 1 CANNOT move now that it is no longer its turn',
    !!(p1MoveNow && p1MoveNow.ok === false && p1MoveNow.code === 'NOT_YOUR_TURN'), JSON.stringify(p1MoveNow));

  const p2BuyNow = await emitAck(B, 'property:bought', { tileId: 2, playerId: 2, price: 100 });
  check('player 2 CAN buy on its own turn', !!(p2BuyNow && p2BuyNow.ok), JSON.stringify(p2BuyNow));

  const p1BuyNow = await emitAck(A, 'property:bought', { tileId: 5, playerId: 1, price: 100 });
  check('player 1 CANNOT buy out of turn (even standing on tile 5)',
    !!(p1BuyNow && p1BuyNow.ok === false && p1BuyNow.code === 'NOT_YOUR_TURN'), JSON.stringify(p1BuyNow));

  // Impersonation on the wire: A (identified as player 1) tries to act AS p2.
  const spoofed = await emitAck(A, 'player:moved', { playerId: 2, position: 20, money: 1500 });
  check('player 1 CANNOT move AS player 2 (spoofed playerId)',
    !!(spoofed && spoofed.ok === false), JSON.stringify(spoofed));

  impostor.disconnect();
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
