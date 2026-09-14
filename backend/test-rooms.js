// Headless room-scoping test.
//
// Reproduces the two-tab scenario at the socket level, WITHOUT the browser:
//   client A creates a room
//   client B joins with A's code   -> should share A's game
//   client C joins a BOGUS code    -> should be rejected
//   client D never joins anything  -> should receive nothing
//
// Then it verifies isolation: a move emitted by A must reach B and must NOT
// reach C or D.
//
// Run against a live server:  node test-rooms.js
const { io } = require('socket.io-client');

const URL = process.env.SERVER_URL || 'http://localhost:3001';
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

const waitFor = (socket, event, ms = 2500) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    socket.once(event, (data) => {
      clearTimeout(t);
      resolve({ data });
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const A = await connect();
  const B = await connect();
  const C = await connect();
  const D = await connect();
  console.log(`\nConnected 4 clients to ${URL}\n`);

  // ---- A creates a room ----
  // Register the listener BEFORE emitting, or we race the event.
  const joinedAPromise = waitFor(A, 'room:joined');
  const created = await new Promise((resolve) => {
    A.emit('room:create', {}, resolve);
    setTimeout(() => resolve(null), 2500);
  });
  check('A: room:create acks ok', !!(created && created.ok), JSON.stringify(created));
  const codeA = created && created.roomId;
  check('A: create returns a 6-char code', typeof codeA === 'string' && codeA.length === 6, String(codeA));

  const joinedA = await joinedAPromise;
  check('A: receives room:joined as host', !!(joinedA && joinedA.data && joinedA.data.role === 'host'),
    joinedA ? `role=${joinedA.data && joinedA.data.role}` : 'no event');
  check('A: room:joined carries the same code', !!(joinedA && joinedA.data && joinedA.data.roomId === codeA));

  // ---- B joins A's room ----
  const joinedB = waitFor(B, 'room:joined');
  await sleep(50);
  const ackB = await new Promise((resolve) => {
    B.emit('room:join', { roomId: codeA }, resolve);
    setTimeout(() => resolve(null), 2500);
  });
  check('B: room:join with real code acks ok', !!(ackB && ackB.ok), JSON.stringify(ackB));
  const bEvt = await joinedB;
  check('B: receives room:joined as guest', !!(bEvt && bEvt.data && bEvt.data.role === 'guest'),
    bEvt ? `role=${bEvt.data && bEvt.data.role}` : 'no event');

  // ---- C tries a bogus code ----
  const ackC = await new Promise((resolve) => {
    C.emit('room:join', { roomId: 'ZZ' }, resolve);
    setTimeout(() => resolve(null), 2500);
  });
  check('C: bogus code is REJECTED', !!(ackC && ackC.ok === false), JSON.stringify(ackC));

  // ---- D stays in the lobby; C is still roomless ----
  await sleep(150);

  // ---- Isolation: A emits a move; only B should hear it ----
  const got = { B: false, C: false, D: false };
  B.on('player:moved', () => { got.B = true; });
  C.on('player:moved', () => { got.C = true; });
  D.on('player:moved', () => { got.D = true; });

  A.emit('player:moved', { playerId: 1, position: 7, money: 1500 });
  await sleep(600);

  check('B (same room) RECEIVED the move', got.B === true, `got.B=${got.B}`);
  check('C (rejected join) did NOT receive it', got.C === false, `got.C=${got.C}`);
  check('D (never joined) did NOT receive it', got.D === false, `got.D=${got.D}`);

  // ---- A roomless client's game event must be dropped, not globally broadcast ----
  const gotRoomless = { A: false, B: false };
  A.on('player:moved', () => { gotRoomless.A = true; });
  B.on('player:moved', () => { gotRoomless.B = true; });
  D.emit('player:moved', { playerId: 1, position: 99, money: 1 });
  await sleep(600);
  check('roomless D\'s event reaches nobody', gotRoomless.A === false && gotRoomless.B === false,
    `A=${gotRoomless.A} B=${gotRoomless.B}`);

  // ---- Peer count / leave semantics ----
  const count = await fetch(`${URL}/api/room/${codeA}`).then((r) => r.json()).catch(() => null);
  check('REST reports the right room back', !!(count && count.roomId === codeA), JSON.stringify(count));

  const peerLeft = waitFor(A, 'room:peer-left');
  B.emit('room:leave');
  const pl = await peerLeft;
  check('A is told when B leaves the room', !!pl, pl ? JSON.stringify(pl.data) : 'no event');

  [A, B, C, D].forEach((s) => s.disconnect());

  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('TEST ERROR:', err && err.message);
  process.exit(2);
});
