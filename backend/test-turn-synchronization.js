// ================= REGRESSION SUITE: AUDIT-A01 TURN SYNCHRONIZATION =================
//
// Regression tests for multiplayer turn synchronization:
//   1. TWO CLIENTS & INITIAL HYDRATION:
//      Host (Client A) creates room, guest (Client B) joins.
//      room:joined and identify ack deliver authoritative currentTurnPlayerId === 1.
//      Client A is active; Client B is inactive waiting.
//   2. UNAUTHORIZED ROLL ATTEMPTS:
//      Client B attempting to roll while it's Player 1's turn is rejected (NOT_YOUR_TURN).
//      Client B attempting to spoof Player 1 is rejected (NOT_YOUR_PLAYER).
//      An unidentified socket attempting to roll is rejected (NOT_IDENTIFIED).
//   3. AUTHORITATIVE ROLL & TURN ADVANCE:
//      Client A rolls and moves successfully.
//      Client B cannot end Client A's turn (NOT_YOUR_TURN).
//      Client A ends turn -> server broadcasts turn:changed to BOTH clients.
//      Both clients receive currentTurnPlayerId === 2.
//   4. POST-ADVANCE ROLLS & UNAUTHORIZED ROLLS:
//      Client A attempting to roll during Player 2's turn is rejected (NOT_YOUR_TURN).
//      Client B rolls successfully during Player 2's turn.
//   5. RECONNECT / REJOIN RESTORATION:
//      Active player (Client B) reconnects and rejoins:
//        playerState and room:joined restore currentTurnPlayerId === 2, me.id === 2.
//        Reconnected Client B can roll.
//      Non-active player (Client A) reconnects and rejoins:
//        playerState and room:joined restore currentTurnPlayerId === 2, me.id === 1.
//        Reconnected Client A cannot roll (rejected NOT_YOUR_TURN).
//
// Run against a live server:  node test-turn-synchronization.js
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

let actionCounter = 0;
const withAction = (payload) => ({
  ...payload,
  actionId: `tsync-${Date.now()}-${++actionCounter}`,
});
const emitAction = (socket, event, payload, ms = 2500) =>
  emitAck(socket, event, withAction(payload), ms);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    try { if (s && typeof s.disconnect === 'function') s.disconnect(); } catch { /* ignore */ }
  }
  await sleep(200);
};

(async () => {
  console.log(`\n=== AUDIT-A01 MULTIPLAYER TURN SYNCHRONIZATION REGRESSION SUITE ===`);
  console.log(`Testing against server ${URL}\n`);

  // ================= 1. INITIAL ROOM HYDRATION (TWO CLIENTS) =================
  console.log('--- 1. INITIAL ROOM HYDRATION FOR TWO CLIENTS ---');
  const clientA = track(await connect());
  const created = await emitAck(clientA, 'room:create', { name: 'AliceHost' });
  const roomId = created && created.roomId;
  const tokenA = created && created.token;
  check('host: room created', !!(created && created.ok && roomId && tokenA), JSON.stringify(created));

  const clientB = track(await connect());
  const joinedB = await emitAck(clientB, 'room:join', { roomId, name: 'BobGuest' });
  const tokenB = joinedB && joinedB.token;
  check('guest: joined room', !!(joinedB && joinedB.ok && tokenB), JSON.stringify(joinedB));

  // Identify Host
  const idA = await emitAck(clientA, 'player:identify', { roomId, token: tokenA, playerId: 1, name: 'AliceHost' });
  check('host: identified as player 1', !!(idA && idA.ok && idA.playerId === 1), JSON.stringify(idA));
  check('host: identify ack delivers authoritative currentTurnPlayerId === 1',
    idA && idA.currentTurnPlayerId === 1, `currentTurnPlayerId=${idA && idA.currentTurnPlayerId}`);

  // Identify Guest
  const idB = await emitAck(clientB, 'player:identify', { roomId, token: tokenB, playerId: 2, name: 'BobGuest' });
  check('guest: identified as player 2', !!(idB && idB.ok && idB.playerId === 2), JSON.stringify(idB));
  check('guest: identify ack delivers authoritative currentTurnPlayerId === 1',
    idB && idB.currentTurnPlayerId === 1, `currentTurnPlayerId=${idB && idB.currentTurnPlayerId}`);

  // Both pick colors so game can start cleanly
  await emitAck(clientA, 'player:set-color', { color: '#00A86B' });
  await emitAck(clientB, 'player:set-color', { color: '#E32636' });

  // ================= 2. UNAUTHORIZED ROLL ATTEMPTS =================
  console.log('\n--- 2. UNAUTHORIZED ROLL ATTEMPTS ARE REJECTED ---');
  // Client B attempts to roll claiming its own id (player 2) while turn is player 1
  const bRollOwn = await emitAck(clientB, 'player:rolled', { playerId: 2 });
  check('guest CANNOT roll out of turn with own seat',
    !!(bRollOwn && bRollOwn.ok === false && bRollOwn.code === 'NOT_YOUR_TURN'),
    JSON.stringify(bRollOwn));

  // Client B attempts to roll spoofing player 1's id
  const bRollSpoof = await emitAck(clientB, 'player:rolled', { playerId: 1 });
  check('guest CANNOT roll out of turn spoofing active seat (NOT_YOUR_PLAYER)',
    !!(bRollSpoof && bRollSpoof.ok === false && bRollSpoof.code === 'NOT_YOUR_PLAYER'),
    JSON.stringify(bRollSpoof));

  // A third anonymous/unidentified socket attempts to roll
  const anonSocket = track(await connect());
  const anonRoll = await emitAck(anonSocket, 'player:rolled', { playerId: 1 });
  check('unidentified socket CANNOT roll',
    !!(anonRoll && anonRoll.ok === false && (anonRoll.code === 'NOT_IDENTIFIED' || anonRoll.error === 'You are not in a room.')),
    JSON.stringify(anonRoll));
  anonSocket.disconnect();

  // ================= 3. AUTHORITATIVE ROLL & TURN ADVANCE =================
  console.log('\n--- 3. AUTHORITATIVE ROLL & TURN ADVANCE ---');
  // Client A (Player 1) rolls authorized
  const aRoll = await emitAck(clientA, 'player:rolled', { playerId: 1 });
  check('host (Player 1) roll succeeds',
    !!(aRoll && aRoll.ok && Array.isArray(aRoll.dice) && aRoll.dice.length === 2),
    JSON.stringify(aRoll));

  // Client A moves
  const aMove = await emitAction(clientA, 'player:moved', { playerId: 1 });
  check('host (Player 1) move succeeds', !!(aMove && aMove.ok), JSON.stringify(aMove));

  // Client B attempts to end Player 1's turn
  const bEndTurn = await emitAck(clientB, 'turn:ended', { playerId: 1 });
  check('guest CANNOT end active player turn (NOT_YOUR_PLAYER or NOT_YOUR_TURN)',
    !!(bEndTurn && bEndTurn.ok === false),
    JSON.stringify(bEndTurn));

  // Listen for turn:changed on both clients
  const turnChangedA = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 3000);
    clientA.once('turn:changed', (d) => { clearTimeout(t); resolve(d); });
  });
  const turnChangedB = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 3000);
    clientB.once('turn:changed', (d) => { clearTimeout(t); resolve(d); });
  });

  // Client A legitimately ends turn
  const aEndTurn = await emitAck(clientA, 'turn:ended', { playerId: 1 });
  check('host ends turn successfully', !!(aEndTurn && aEndTurn.ok), JSON.stringify(aEndTurn));

  const evtA = await turnChangedA;
  const evtB = await turnChangedB;
  check('turn:changed broadcast received by host with currentTurnPlayerId === 2',
    !!(evtA && evtA.currentTurnPlayerId === 2), JSON.stringify(evtA));
  check('turn:changed broadcast received by guest with currentTurnPlayerId === 2',
    !!(evtB && evtB.currentTurnPlayerId === 2), JSON.stringify(evtB));

  // ================= 4. POST-ADVANCE ROLLS & UNAUTHORIZED ROLLS =================
  console.log('\n--- 4. POST-ADVANCE ROLLS & UNAUTHORIZED ROLLS ---');
  // Now it is Player 2's turn. Player 1 must NOT be allowed to roll.
  const aRollOutOfTurn = await emitAck(clientA, 'player:rolled', { playerId: 1 });
  check('previous player (Player 1) CANNOT roll now that it is Player 2 turn',
    !!(aRollOutOfTurn && aRollOutOfTurn.ok === false && aRollOutOfTurn.code === 'NOT_YOUR_TURN'),
    JSON.stringify(aRollOutOfTurn));

  // ================= 5. RECONNECT / REJOIN RESTORATION =================
  console.log('\n--- 5. RECONNECT / REJOIN RESTORATION ---');
  // Case 5A: Rejoin by ACTIVE player (Player 2)
  // Present the same token from a new socket connection (simulating refresh/rejoin without dropping live room)
  const clientB2 = track(await connect());
  const rejoinB = await emitAck(clientB2, 'player:rejoin', { roomId, token: tokenB });

  check('guest rejoins successfully', !!(rejoinB && rejoinB.ok && rejoinB.rejoined), JSON.stringify(rejoinB));
  check('guest rejoin restores playerId === 2', rejoinB && rejoinB.playerId === 2, `playerId=${rejoinB && rejoinB.playerId}`);
  check('guest playerState snapshot reflects me.id === 2 and currentTurnPlayerId === 2',
    !!(rejoinB && rejoinB.playerState && rejoinB.playerState.me && rejoinB.playerState.me.id === 2 && rejoinB.playerState.currentTurnPlayerId === 2),
    JSON.stringify(rejoinB && rejoinB.playerState && { meId: rejoinB.playerState.me && rejoinB.playerState.me.id, turn: rejoinB.playerState.currentTurnPlayerId }));

  // Reconnected active player can roll!
  const b2Roll = await emitAck(clientB2, 'player:rolled', { playerId: 2 });
  check('reconnected active player 2 can roll',
    !!(b2Roll && b2Roll.ok && Array.isArray(b2Roll.dice)), JSON.stringify(b2Roll));
  const b2Move = await emitAction(clientB2, 'player:moved', { playerId: 2 });
  check('reconnected active player 2 can move', !!(b2Move && b2Move.ok), JSON.stringify(b2Move));

  // Case 5B: Rejoin by NON-ACTIVE player (Player 1) while it's still Player 2's turn
  const clientA2 = track(await connect());
  const rejoinA = await emitAck(clientA2, 'player:rejoin', { roomId, token: tokenA });
  check('host rejoins successfully', !!(rejoinA && rejoinA.ok && rejoinA.rejoined), JSON.stringify(rejoinA));
  check('host rejoin restores playerId === 1', rejoinA && rejoinA.playerId === 1, `playerId=${rejoinA && rejoinA.playerId}`);
  check('host playerState snapshot reflects authoritative currentTurnPlayerId === 2 (still guest turn)',
    !!(rejoinA && rejoinA.playerState && rejoinA.playerState.currentTurnPlayerId === 2),
    `currentTurnPlayerId=${rejoinA && rejoinA.playerState && rejoinA.playerState.currentTurnPlayerId}`);

  // Reconnected non-active player CANNOT roll
  const a2Roll = await emitAck(clientA2, 'player:rolled', { playerId: 1 });
  check('reconnected non-active player CANNOT roll (NOT_YOUR_TURN)',
    !!(a2Roll && a2Roll.ok === false && a2Roll.code === 'NOT_YOUR_TURN'), JSON.stringify(a2Roll));

  // ================= 6. ADVANCE BACK TO HOST (FULL CYCLE) =================
  console.log('\n--- 6. ADVANCE BACK TO HOST (FULL CYCLE) ---');
  const turnCycleA = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 3000);
    clientA2.once('turn:changed', (d) => { clearTimeout(t); resolve(d); });
  });
  const turnCycleB = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 3000);
    clientB2.once('turn:changed', (d) => { clearTimeout(t); resolve(d); });
  });

  const bEnd = await emitAck(clientB2, 'turn:ended', { playerId: 2 });
  check('guest ends turn successfully', !!(bEnd && bEnd.ok), JSON.stringify(bEnd));

  const cycleA = await turnCycleA;
  const cycleB = await turnCycleB;
  check('turn:changed cycle received by host with currentTurnPlayerId === 1',
    !!(cycleA && cycleA.currentTurnPlayerId === 1), JSON.stringify(cycleA));
  check('turn:changed cycle received by guest with currentTurnPlayerId === 1',
    !!(cycleB && cycleB.currentTurnPlayerId === 1), JSON.stringify(cycleB));

  // Now Host can roll again
  const aCycleRoll = await emitAck(clientA2, 'player:rolled', { playerId: 1 });
  check('host can roll again on cycled turn',
    !!(aCycleRoll && aCycleRoll.ok && Array.isArray(aCycleRoll.dice)), JSON.stringify(aCycleRoll));

  // Disconnect remaining sockets
  clientA2.disconnect();
  clientB2.disconnect();

  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  await cleanup(roomId);
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error('TEST ERROR:', err && err.message);
  await cleanup();
  process.exit(2);
});
