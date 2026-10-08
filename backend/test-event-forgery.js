// Headless EVENT-FORGERY test.
//
// The server used to have a `socket.onAny(...)` fallback that re-broadcast any
// event it did not recognise to the sender's room:
//
//     socket.to(roomId).emit(event, ...args);
//
// It was guarded by a BLOCKLIST of the server's own event names. A blocklist can
// only enumerate what the server happens to emit today, while a client listens
// for more than that — so any name missing from the list was relayed verbatim
// with an attacker-chosen payload. That is a forgery primitive: a peer could emit
// `game:over` and every other client would receive it exactly as if the server
// had declared a winner.
//
// The passthrough is now REMOVED, so an unrecognised event name is simply
// unhandled. This suite pins that down from the attacker's side:
//
//   * a peer cannot forge `game:over` (the audit's confirmed exploit)
//   * a peer cannot forge `room:players`, `turn:changed`, `room:joined`,
//     `auction:tick`, `room:error` or any other server-only event
//   * a peer cannot relay an arbitrary unknown event name at all
//   * the REAL server events still arrive, through their real handlers
//
// Requires a running server:
//   TURN_TIME_LIMIT_MS=60000 PORT=3099 node server.js
//   SERVER_URL=http://127.0.0.1:3099 node test-event-forgery.js
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const syncState = (socket) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 1500);
    socket.once('game:sync', (s) => { clearTimeout(t); resolve(s); });
    socket.emit('game:request-sync', {});
  });

let seq = 0;
const newActionId = () => `forge-${Date.now()}-${++seq}`;

// ===== CLEANUP: EVERY SOCKET IS TRACKED AND CLOSED ON BOTH PATHS =====
// Besides A and B this suite opens a throwaway socket C for the bad-join leg.
// Registering each socket lets cleanup() close the survivors from the catch block
// as well as the success path, so a failure cannot leave a live room behind.
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

// The events the SERVER owns. A client must never be able to make a peer receive
// any of these by emitting them itself.
const SERVER_ONLY_EVENTS = [
  'game:over',
  'room:players',
  'turn:changed',
  'room:joined',
  'auction:tick',
  'room:error',
  'room:peer-joined',
  'room:peer-left',
  'game:sync',
  'room:left',
  'card:drawn',
  'jail:bail-paid',
  'club:paid',
  'rest-house:resolved',
  'tax:paid',
];

(async () => {
  // ---- SETUP: two identified players in one room ----
  const A = track(await connect());
  const created = await emitAck(A, 'room:create', { name: 'Alice' });
  const roomId = created.roomId;
  const tokenA = created.token;
  check('setup: room created', !!(created && created.ok && roomId), JSON.stringify(created));

  const B = track(await connect());
  const bJoin = await emitAck(B, 'room:join', { roomId, name: 'Bob' });
  check('setup: peer joined', !!(bJoin && bJoin.ok), JSON.stringify(bJoin));

  await emitAck(A, 'player:identify', { roomId, token: tokenA, playerId: 1 });
  await emitAck(B, 'player:identify', { roomId, token: bJoin.token, playerId: 2 });

  // ================= THE AUDIT'S EXPLOIT =================
  console.log('\n=== A PEER CANNOT FORGE game:over ===');

  let forgedGameOver = null;
  A.once('game:over', (d) => { forgedGameOver = d; });

  // Player 2 tries to declare a win for itself.
  B.emit('game:over', { winnerId: 2, winnerName: 'Bob', reason: 'forged-by-peer' });
  await sleep(600);

  check('a peer emitting game:over does NOT reach the other client',
    forgedGameOver === null,
    `received=${JSON.stringify(forgedGameOver)}`);

  // And the game is genuinely still running — the forged event changed nothing.
  const stateAfterForge = await syncState(A);
  check('the forged game:over did not end the game server-side',
    !!(stateAfterForge && stateAfterForge.isGameOver !== true),
    `isGameOver=${stateAfterForge && stateAfterForge.isGameOver}`);
  check('no winner was declared by the forgery',
    !!(stateAfterForge && (stateAfterForge.winnerId === null || stateAfterForge.winnerId === undefined)),
    `winnerId=${stateAfterForge && stateAfterForge.winnerId}`);

  // ================= EVERY SERVER-ONLY EVENT =================
  console.log('\n=== A PEER CANNOT FORGE ANY SERVER-ONLY EVENT ===');

  for (const eventName of SERVER_ONLY_EVENTS) {
    let received = null;
    const listener = (d) => { received = d; };
    A.on(eventName, listener);

    // A payload shaped like the real one, so this is not defeated by shape alone.
    B.emit(eventName, {
      winnerId: 2, winnerName: 'Bob', reason: 'forged',
      players: [{ id: 1, name: 'HACKED' }],
      currentTurnPlayerId: 2,
      roomId, turnDeadline: Date.now() + 999999,
      ok: false, error: 'forged error',
      auction: { id: 'forged', tileId: 39, currentBid: 0 },
    });
    await sleep(350);

    A.off(eventName, listener);
    check(`forged ${eventName} does not reach the peer`, received === null,
      `received=${JSON.stringify(received)}`);
  }

  // ================= ARBITRARY UNKNOWN EVENT NAMES =================
  console.log('\n=== A PEER CANNOT RELAY AN ARBITRARY EVENT NAME ===');

  const arbitraryNames = [
    'totally:made:up',
    'game:over ',           // trailing space — a blocklist would miss this
    'Game:Over',            // different case
    'game:over:fake',
    '__proto__',
    'constructor',
  ];
  for (const name of arbitraryNames) {
    let received = null;
    const listener = (d) => { received = d; };
    A.on(name, listener);
    B.emit(name, { winnerId: 2, reason: 'forged', marker: 'ARBITRARY-RELAY' });
    await sleep(300);
    A.off(name, listener);
    check(`arbitrary event "${name}" is not relayed`, received === null,
      `received=${JSON.stringify(received)}`);
  }

  // A catch-all listener is the strongest form of this check: it would observe
  // ANY relayed event, whatever its name.
  const relayedAnything = [];
  const catchAll = (name) => { relayedAnything.push(name); };
  A.onAny(catchAll);
  B.emit('game:over', { winnerId: 2, reason: 'forged' });
  B.emit('room:players', { players: [] });
  B.emit('some:unknown:event', { x: 1 });
  B.emit('turn:changed', { currentTurnPlayerId: 2 });
  await sleep(700);
  A.offAny(catchAll);

  const serverOnlyRelayed = relayedAnything.filter((n) => SERVER_ONLY_EVENTS.includes(n));
  check('a catch-all listener sees NO relayed server-only event',
    serverOnlyRelayed.length === 0,
    `relayed=${JSON.stringify(relayedAnything)}`);

  // ================= THE REAL EVENTS STILL WORK =================
  // Removing the passthrough must not have removed the server's OWN emits. Each of
  // these is produced by a real handler, so they are asserted to still arrive.
  console.log('\n=== THE REAL SERVER EVENTS STILL ARRIVE ===');

  // room:error — triggered by a genuine bad join, from the server's own path.
  const C = track(await connect());
  const badJoin = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 2000);
    C.once('room:error', (d) => { clearTimeout(t); resolve(d); });
  });
  await emitAck(C, 'room:join', { roomId: 'ZZZZZZ', name: 'Nobody' });
  const roomErr = await badJoin;
  check('room:error still arrives from the server (bad room code)',
    !!(roomErr && typeof roomErr.error === 'string'), JSON.stringify(roomErr));
  C.disconnect();

  // room:players — triggered by a real player:set-name.
  const playersEvt = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 2000);
    B.once('room:players', (d) => { clearTimeout(t); resolve(d); });
  });
  await emitAck(A, 'player:set-name', { name: 'AliceRenamed' });
  const roster = await playersEvt;
  check('room:players still arrives from the server (real name change)',
    !!(roster && Array.isArray(roster.players)), JSON.stringify(roster && roster.players && roster.players.length));

  // turn:changed — triggered by a real roll (the first roll starts the game and
  // publishes the opening turn deadline).
  const turnEvt = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 2500);
    B.once('turn:changed', (d) => { clearTimeout(t); resolve(d); });
  });
  await emitAck(A, 'player:rolled', { playerId: 1 });
  const turnChanged = await turnEvt;
  check('turn:changed still arrives from the server (real roll)',
    !!(turnChanged && typeof turnChanged.currentTurnPlayerId === 'number'),
    JSON.stringify(turnChanged));

  // game:over — triggered by a REAL win, not a forgery. Player 1 surrenders,
  // which in a two-player game is last-player-standing for player 2.
  const realGameOver = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 2500);
    A.once('game:over', (d) => { clearTimeout(t); resolve(d); });
  });
  await emitAck(A, 'player:bankrupt', { playerId: 1, actionId: newActionId() });
  const over = await realGameOver;
  check('game:over still arrives from the server on a REAL win',
    !!(over && over.winnerId === 2), JSON.stringify(over));

  A.disconnect();
  B.disconnect();

  console.log(`\n${results.length - failed}/${results.length} checks passed`);

  await cleanup(roomId);
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error('TEST ERROR:', err && err.message);
  await cleanup();
  process.exit(2);
});