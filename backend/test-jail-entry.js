// Focused SERVER-AUTHORITATIVE JAIL ENTRY test suite.
//
// Verifies the 5 requirements:
//   1. When an existing Go-To-Jail rule/card sends a player to jail, set inJail=true and jailTurns=0 on the SERVER.
//   2. Broadcast the updated jail state to every player.
//   3. Landing normally on tile 10 must NOT jail the player — it is "Just Visiting".
//   4. Remove/stop any client-only jail state mutation for these entry cases.
//   5. Focused unit and integration tests covering Go-To-Jail and normal landing on tile 10.
//
// Run standalone or via test runner:
//   SERVER_URL=http://localhost:3099 node test-jail-entry.js
const { io } = require('socket.io-client');
const assert = require('assert');
const path = require('path');

const cards = require('./game/cards');
const board = require('./game/board');

const URL = process.env.SERVER_URL || 'http://localhost:3002';
const results = [];
let failed = 0;

function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

// ============================================================================
// PART 1: PURE UNIT TESTS FOR JAIL ENTRY & JUST VISITING
// ============================================================================
console.log('\n=== 1. PURE UNIT TESTS: GO-TO-JAIL CARD & TILE 10 JUST VISITING ===');

// Tile 10 properties
check('tile 10 is JAIL on the authoritative board', board.TILES[10] && board.TILES[10].name === 'JAIL');
check('tile 10 is corner type', board.TILES[10] && board.TILES[10].type === 'corner');
check('tile 10 is NOT a card tile', !cards.isCardTile(10));

// Surprise card 1: Straight to JAIL
{
  const p = { id: 1, position: 14, money: 1500, inJail: false, jailTurns: 0 };
  const r = cards.resolveCardDraw({}, p, { forcedRoll: 1 });
  check('Surprise roll 1 sets position to 10', r.ok && p.position === 10 && r.position === 10);
  check('Surprise roll 1 sets inJail=true on player', p.inJail === true);
  check('Surprise roll 1 sets jailTurns=0 on player', p.jailTurns === 0);
  check('Surprise roll 1 returns inJail=true in outcome', r.inJail === true);
  check('Surprise roll 1 returns jailTurns=0 in outcome', r.jailTurns === 0);
  check('Surprise roll 1 does not pass GO', r.passedGo === false && r.salary === 0);
}

// Surprise card 2: Straight to JAIL
{
  const p = { id: 2, position: 28, money: 1500, inJail: false, jailTurns: 0 };
  const r = cards.resolveCardDraw({}, p, { forcedRoll: 2 });
  check('Surprise roll 2 sets position to 10', r.ok && p.position === 10 && r.position === 10);
  check('Surprise roll 2 sets inJail=true on player', p.inJail === true);
  check('Surprise roll 2 sets jailTurns=0 on player', p.jailTurns === 0);
  check('Surprise roll 2 returns inJail=true in outcome', r.inJail === true);
  check('Surprise roll 2 returns jailTurns=0 in outcome', r.jailTurns === 0);
}

// Surprise cards 3-6: Do NOT jail player
{
  for (const roll of [3, 4, 5, 6]) {
    const p1 = { id: 1, position: 14, money: 1500, inJail: false, jailTurns: 0 };
    const p2 = { id: 2, position: 31, money: 1500, inJail: false, jailTurns: 0, isBankrupt: false, name: 'Bob' };
    const room = { players: [p1, p2] };
    const r = cards.resolveCardDraw(room, p1, { forcedRoll: roll, targetId: 2 });
    check(`Surprise roll ${roll} does NOT jail player`, r.ok && p1.inJail === false && r.inJail === false);
  }
}

// Treasure cards: Do NOT jail player
{
  for (let roll = 1; roll <= 6; roll++) {
    const p = { id: 1, position: 3, money: 1500, inJail: false, jailTurns: 0 };
    const r = cards.resolveCardDraw({}, p, { forcedRoll: roll });
    check(`Treasure roll ${roll} does NOT jail player`, r.ok && p.inJail === false && r.inJail === false);
  }
}

// ============================================================================
// PART 2: LIVE SOCKET SERVER INTEGRATION TESTS
// ============================================================================
console.log('\n=== 2. LIVE SERVER INTEGRATION: JAIL ENTRY & JUST VISITING ===');

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

const waitFor = (socket, event, ms = 3000) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    socket.once(event, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const syncState = (socket) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 1500);
    socket.once('game:sync', (s) => { clearTimeout(t); resolve(s); });
    socket.emit('game:request-sync', {});
  });

const playerIn = (state, id) => ((state && state.players) || []).find((p) => p.id === id);

let seq = 0;
const newActionId = () => `jail-act-${Date.now()}-${++seq}`;

const sockets = [];
const track = (s) => { sockets.push(s); return s; };

const cleanup = async () => {
  for (const s of sockets) {
    try { if (s && typeof s.disconnect === 'function') s.disconnect(); } catch { /* ignore */ }
  }
  await sleep(150);
};

(async () => {
  const A = track(await connect());
  const created = await emitAck(A, 'room:create', { name: 'Alice' });
  const roomId = created.roomId;
  const tokenA = created.token;
  check('setup: room created', !!(created && created.ok && roomId));

  const B = track(await connect());
  const bJoin = await emitAck(B, 'room:join', { roomId, name: 'Bob' });
  const tokenB = bJoin.token;
  check('setup: Bob joined room', !!(bJoin && bJoin.ok && tokenB));

  // Identify players
  const idA = await emitAck(A, 'player:identify', { roomId, token: tokenA, playerId: 1, name: 'Alice' });
  const idB = await emitAck(B, 'player:identify', { roomId, token: tokenB, playerId: 2, name: 'Bob' });
  check('setup: both players identified', !!(idA && idA.ok && idB && idB.ok));

  // Start the game by having Player 1 roll
  const firstRoll = await emitAck(A, 'player:rolled', { playerId: 1 });
  check('setup: game started via player:rolled', !!(firstRoll && firstRoll.ok));

  // Player 1 moves to satisfy initial roll
  await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });

  // ---- 2.1 Normal Landing on Tile 10: "Just Visiting" ----
  console.log('\n--- 2.1 Normal Landing on Tile 10 ("Just Visiting") ---');

  // End turns to get to a fresh turn for Alice
  await emitAck(A, 'turn:ended', { playerId: 1 });
  await emitAck(B, 'turn:ended', { playerId: 2 });

  // Navigate Alice to Tile 10 using skill-card movement steps
  let state = await syncState(A);
  let p1Pos = playerIn(state, 1).position;
  let distTo10 = (10 - p1Pos + 40) % 40;
  if (distTo10 === 0) distTo10 = 40;

  while (distTo10 > 0) {
    const step = Math.min(distTo10, 6);
    await emitAck(A, 'player:skill-card', { movement: step, playerId: 1 });

    // Set up peer listener on Bob for the final step to tile 10
    const isFinalStep = (distTo10 - step === 0);
    const peerMovedPromise = isFinalStep ? waitFor(B, 'player:moved') : null;

    const moveAck = await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });
    distTo10 -= step;

    if (isFinalStep) {
      check('Alice move to tile 10 succeeded on server', moveAck && moveAck.ok && moveAck.position === 10,
        JSON.stringify(moveAck));
      check('move ack confirms inJail=false for normal landing on tile 10',
        moveAck && moveAck.inJail === false, `inJail=${moveAck && moveAck.inJail}`);

      // Check peer broadcast
      const peerMoved = await peerMovedPromise;
      check('peer received player:moved broadcast for landing on tile 10', !!peerMoved, JSON.stringify(peerMoved));
      check('peer broadcast confirms inJail=false (Just Visiting)',
        peerMoved && peerMoved.position === 10 && peerMoved.inJail === false,
        `pos=${peerMoved && peerMoved.position} inJail=${peerMoved && peerMoved.inJail}`);
    }

    if (distTo10 > 0) {
      await emitAck(A, 'turn:ended', { playerId: 1 });
      await emitAck(B, 'turn:ended', { playerId: 2 });
    }
  }

  // Verify server state in sync
  state = await syncState(A);
  const aliceOn10 = playerIn(state, 1);
  check('Alice authoritative position is tile 10', aliceOn10.position === 10, `pos=${aliceOn10.position}`);
  check('Alice authoritative inJail is FALSE (Just Visiting)', aliceOn10.inJail === false, `inJail=${aliceOn10.inJail}`);
  check('Alice authoritative jailTurns is 0', aliceOn10.jailTurns === 0, `jailTurns=${aliceOn10.jailTurns}`);

  // Tile 10 is NOT a card tile: drawing here must be rejected
  const drawOn10 = await emitAck(A, 'card:draw', { playerId: 1, actionId: newActionId() });
  check('card:draw on tile 10 is rejected (NOT_ON_CARD_TILE)',
    drawOn10 && drawOn10.ok === false && drawOn10.code === 'NOT_ON_CARD_TILE',
    JSON.stringify(drawOn10));

  // ---- 2.2 Go-To-Jail Card Authority & Room Broadcast ----
  console.log('\n--- 2.2 Go-To-Jail Card Authority & Room Broadcast ---');

  // End Alice's turn, then Bob's turn
  await emitAck(A, 'turn:ended', { playerId: 1 });
  await emitAck(B, 'turn:ended', { playerId: 2 });

  // Move Alice from tile 10 to tile 14 (SURPRISE card tile)
  // Distance 10 -> 14 is 4 steps
  await emitAck(A, 'player:skill-card', { movement: 4, playerId: 1 });
  const move14Ack = await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });
  check('Alice moved to tile 14 (SURPRISE)', move14Ack && move14Ack.position === 14, JSON.stringify(move14Ack));

  state = await syncState(A);
  check('Alice authoritative position is 14 before draw', playerIn(state, 1).position === 14);

  // Bob listens for authoritative card:drawn broadcast
  const peerCardDrawnPromise = waitFor(B, 'card:drawn');

  // Alice draws card on tile 14 with forced roll 1 (Sent straight to JAIL)
  const jailDrawAck = await emitAck(A, 'card:draw', {
    playerId: 1,
    actionId: newActionId(),
    _testForcedRoll: 1,
    // Spoofed client claims to verify server ignores them
    inJail: false,
    position: 14,
  });

  check('card:draw with Go-To-Jail succeeded', !!(jailDrawAck && jailDrawAck.ok), JSON.stringify(jailDrawAck));
  check('card:draw ack confirms position is tile 10', jailDrawAck && jailDrawAck.position === 10,
    `pos=${jailDrawAck && jailDrawAck.position}`);
  check('card:draw ack confirms inJail=true', jailDrawAck && jailDrawAck.inJail === true,
    `inJail=${jailDrawAck && jailDrawAck.inJail}`);
  check('card:draw ack confirms jailTurns=0', jailDrawAck && jailDrawAck.jailTurns === 0,
    `jailTurns=${jailDrawAck && jailDrawAck.jailTurns}`);

  // Verify peer broadcast received by Bob
  const peerCardEvt = await peerCardDrawnPromise;
  check('Bob received authoritative card:drawn broadcast', !!peerCardEvt, JSON.stringify(peerCardEvt));
  check('peer broadcast carries playerId=1', peerCardEvt && peerCardEvt.playerId === 1);
  check('peer broadcast carries position=10', peerCardEvt && peerCardEvt.position === 10);
  check('peer broadcast carries inJail=true', peerCardEvt && peerCardEvt.inJail === true);
  check('peer broadcast carries jailTurns=0', peerCardEvt && peerCardEvt.jailTurns === 0);

  // Verify authoritative server state via game:sync
  state = await syncState(A);
  const aliceAfterJail = playerIn(state, 1);
  check('server state confirms Alice inJail=true', aliceAfterJail.inJail === true);
  check('server state confirms Alice jailTurns=0', aliceAfterJail.jailTurns === 0);
  check('server state confirms Alice position=10', aliceAfterJail.position === 10);

  // ---- 2.3 Peer Normal Visit while Another Player is in Jail ----
  console.log('\n--- 2.3 Bob Visits Tile 10 while Alice is in Jail ---');

  // End Alice's turn to pass turn to Bob
  await emitAck(A, 'turn:ended', { playerId: 1 });

  // Move Bob to tile 10 using skill-card
  state = await syncState(B);
  let p2Pos = playerIn(state, 2).position;
  let distBobTo10 = (10 - p2Pos + 40) % 40;
  if (distBobTo10 === 0) distBobTo10 = 40;

  while (distBobTo10 > 0) {
    const step = Math.min(distBobTo10, 6);
    await emitAck(B, 'player:skill-card', { movement: step, playerId: 2 });
    await emitAck(B, 'player:moved', { playerId: 2, actionId: newActionId() });
    distBobTo10 -= step;
    if (distBobTo10 > 0) {
      await emitAck(B, 'turn:ended', { playerId: 2 });
      await emitAck(A, 'turn:ended', { playerId: 1 });
    }
  }

  state = await syncState(B);
  const bobOn10 = playerIn(state, 2);
  const aliceStillInJail = playerIn(state, 1);
  check('Bob authoritative position is tile 10', bobOn10.position === 10);
  check('Bob is NOT in jail on tile 10 (Just Visiting: inJail=false)', bobOn10.inJail === false);
  check('Bob jailTurns is 0', bobOn10.jailTurns === 0);
  check('Alice remains inJail=true on tile 10', aliceStillInJail.inJail === true);

  // ============================================================================
  // PART 3: SERVER-AUTHORITATIVE JAIL BAIL TESTS
  // ============================================================================
  console.log('\n=== 3. SERVER-AUTHORITATIVE JAIL BAIL (jail:pay-bail) ===');

  // ---- 3.1 Bob cannot pay bail when NOT in jail ----
  console.log('\n--- 3.1 Not in Jail Rejection ---');
  // It is Bob's turn right now
  const bobBailAck = await emitAck(B, 'jail:pay-bail', { playerId: 2, actionId: newActionId() });
  check('Bob paying bail when NOT in jail is rejected (NOT_IN_JAIL)',
    bobBailAck && bobBailAck.ok === false && bobBailAck.code === 'NOT_IN_JAIL',
    JSON.stringify(bobBailAck));

  // ---- 3.2 Out of turn bail attempt ----
  console.log('\n--- 3.2 Out of Turn Rejection ---');
  // Alice is in jail, but it is currently BOB's turn!
  const aliceOutOfTurnBail = await emitAck(A, 'jail:pay-bail', { playerId: 1, actionId: newActionId() });
  check('Alice paying bail out of turn is rejected (NOT_YOUR_TURN)',
    aliceOutOfTurnBail && aliceOutOfTurnBail.ok === false && aliceOutOfTurnBail.code === 'NOT_YOUR_TURN',
    JSON.stringify(aliceOutOfTurnBail));

  // Pass turn back to Alice
  await emitAck(B, 'turn:ended', { playerId: 2 });

  // ---- 3.3 Alice cannot pay bail for Bob (impersonation) ----
  console.log('\n--- 3.3 Impersonation Rejection ---');
  const aliceSpoofBail = await emitAck(A, 'jail:pay-bail', { playerId: 2, actionId: newActionId() });
  check('Alice spoofing playerId=2 is rejected (NOT_YOUR_PLAYER)',
    aliceSpoofBail && aliceSpoofBail.ok === false && aliceSpoofBail.code === 'NOT_YOUR_PLAYER',
    JSON.stringify(aliceSpoofBail));

  // ---- 3.4 Alice pays bail successfully ----
  console.log('\n--- 3.4 Alice Successful Bail Payment ---');
  state = await syncState(A);
  const alicePreBail = playerIn(state, 1);
  const aliceMoneyBefore = alicePreBail.money;
  const bailActionId = newActionId();

  // Bob listens for peer broadcast of bail payment
  const peerBailPromise = waitFor(B, 'jail:bail-paid');

  const aliceBailAck = await emitAck(A, 'jail:pay-bail', { playerId: 1, actionId: bailActionId });
  check('Alice paying bail succeeds', !!(aliceBailAck && aliceBailAck.ok), JSON.stringify(aliceBailAck));
  check('Alice ack confirms bail=$100', aliceBailAck && aliceBailAck.bail === 100);
  check('Alice ack confirms inJail=false', aliceBailAck && aliceBailAck.inJail === false);
  check('Alice ack confirms jailTurns=0', aliceBailAck && aliceBailAck.jailTurns === 0);
  check('Alice ack confirms money deducted by $100', aliceBailAck && aliceBailAck.money === aliceMoneyBefore - 100);

  // Peer receives broadcast
  const peerBailEvt = await peerBailPromise;
  check('Bob received peer jail:bail-paid broadcast', !!peerBailEvt, JSON.stringify(peerBailEvt));
  check('peer bail broadcast has playerId=1', peerBailEvt && peerBailEvt.playerId === 1);
  check('peer bail broadcast has inJail=false', peerBailEvt && peerBailEvt.inJail === false);
  check('peer bail broadcast has jailTurns=0', peerBailEvt && peerBailEvt.jailTurns === 0);
  check('peer bail broadcast has updated money', peerBailEvt && peerBailEvt.money === aliceMoneyBefore - 100);

  // Authoritative server state check
  state = await syncState(A);
  const aliceAfterBail = playerIn(state, 1);
  check('authoritative state confirms Alice inJail=false', aliceAfterBail.inJail === false);
  check('authoritative state confirms Alice money updated', aliceAfterBail.money === aliceMoneyBefore - 100);

  // ---- 3.5 Duplicate / Replay protection ----
  console.log('\n--- 3.5 Duplicate Replay Protection ---');
  const duplicateBailAck = await emitAck(A, 'jail:pay-bail', { playerId: 1, actionId: bailActionId });
  check('duplicate jail:pay-bail request is rejected',
    duplicateBailAck && duplicateBailAck.ok === false && (duplicateBailAck.code === 'DUPLICATE_ACTION' || duplicateBailAck.code === 'NOT_IN_JAIL'),
    JSON.stringify(duplicateBailAck));

  // ---- 3.6 Alice cannot pay bail again now that she is free ----
  const secondBailAck = await emitAck(A, 'jail:pay-bail', { playerId: 1, actionId: newActionId() });
  check('Alice paying bail again is rejected (NOT_IN_JAIL)',
    secondBailAck && secondBailAck.ok === false && secondBailAck.code === 'NOT_IN_JAIL',
    JSON.stringify(secondBailAck));

  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  await cleanup();
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error('TEST ERROR:', err && err.message, err && err.stack);
  await cleanup();
  process.exit(2);
});
