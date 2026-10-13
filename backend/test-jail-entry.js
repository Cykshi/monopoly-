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

  // ============================================================================
  // PART 4: JAIL BYPASS PREVENTION (MOVEMENT & SKILL-CARD BLOCKED WHILE JAILED)
  // ============================================================================
  console.log('\n=== 4. JAIL BYPASS PREVENTION ===');

  // Alice is on turn and currently in jail.
  // 4.1 Skill card attempt while in jail must be rejected with IN_JAIL
  const aliceSkillCardInJail = await emitAck(A, 'player:skill-card', { movement: 3, playerId: 1 });
  check('Alice using movement card while jailed is rejected (IN_JAIL)',
    aliceSkillCardInJail && aliceSkillCardInJail.ok === false && aliceSkillCardInJail.code === 'IN_JAIL',
    JSON.stringify(aliceSkillCardInJail));

  // 4.2 Roll non-doubles dice while in jail, then attempt player:moved.
  // Player is jailed, so player:moved must be rejected with IN_JAIL.
  const aliceRollInJail = await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [1, 2] });
  check('Alice roll in jail accepted on server', !!(aliceRollInJail && aliceRollInJail.ok), JSON.stringify(aliceRollInJail));

  const aliceMoveWhileJailed = await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });
  check('Alice player:moved while in jail is rejected (IN_JAIL)',
    aliceMoveWhileJailed && aliceMoveWhileJailed.ok === false && aliceMoveWhileJailed.code === 'IN_JAIL',
    JSON.stringify(aliceMoveWhileJailed));

  // Verify Alice did NOT move on server
  state = await syncState(A);
  const aliceStillTile10 = playerIn(state, 1);
  check('Alice position remains tile 10', aliceStillTile10 && aliceStillTile10.position === 10);
  check('Alice remains inJail=true', aliceStillTile10 && aliceStillTile10.inJail === true);

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

  // ---- 3.7 Valid Movement after Bail ----
  console.log('\n--- 3.7 Valid Movement after Bail ---');
  // Now that Alice has paid bail and is released (inJail=false), movement is authorized
  const aliceMoveAfterBail = await emitAck(A, 'player:skill-card', { movement: 2, playerId: 1 });
  check('Alice using movement card after bail succeeds', !!(aliceMoveAfterBail && aliceMoveAfterBail.ok), JSON.stringify(aliceMoveAfterBail));

  const aliceMoveAck = await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });
  check('Alice moves normally after bail', !!(aliceMoveAck && aliceMoveAck.ok && aliceMoveAck.position === 12), JSON.stringify(aliceMoveAck));

  state = await syncState(A);
  const aliceFree = playerIn(state, 1);
  check('Alice authoritative position updated after bail movement', aliceFree && aliceFree.position === 12);
  check('Alice authoritative inJail is false', aliceFree && aliceFree.inJail === false);

  // ============================================================================
  // HELPER FOR NEW ROOM CREATION & JAIL PLACEMENT
  // ============================================================================
  const setupFreshRoom = async (p1Name = 'Alice', p2Name = 'Bob') => {
    const s1 = track(await connect());
    const c1 = await emitAck(s1, 'room:create', { name: p1Name });
    const roomId = c1.roomId;
    const token1 = c1.token;

    const s2 = track(await connect());
    const c2 = await emitAck(s2, 'room:join', { roomId, name: p2Name });
    const token2 = c2.token;

    await emitAck(s1, 'player:identify', { roomId, token: token1, playerId: 1, name: p1Name });
    await emitAck(s2, 'player:identify', { roomId, token: token2, playerId: 2, name: p2Name });

    // Opening roll to start game
    await emitAck(s1, 'player:rolled', { playerId: 1 });
    await emitAck(s1, 'player:moved', { playerId: 1, actionId: newActionId() });

    return { s1, s2, roomId, token1, token2 };
  };

  const walkAndJailPlayer = async (s1, s2, playerId = 1) => {
    let s = await syncState(s1);
    let pos = playerIn(s, playerId).position;
    let dist = (14 - pos + 40) % 40;
    while (dist > 0) {
      const step = Math.min(dist, 6);
      await emitAck(s1, 'player:skill-card', { movement: step, playerId });
      await emitAck(s1, 'player:moved', { playerId, actionId: newActionId() });
      dist -= step;
      if (dist > 0) {
        await emitAck(s1, 'turn:ended', { playerId });
        await emitAck(s2, 'turn:ended', { playerId: 3 - playerId });
      }
    }
    const drawRes = await emitAck(s1, 'card:draw', { playerId, actionId: newActionId(), _testForcedRoll: 1 });
    return drawRes;
  };

  // ============================================================================
  // PART 5: ROLL DOUBLES WHILE JAILED (ESCAPE & AUTHORIZED MOVEMENT)
  // ============================================================================
  console.log('\n=== 5. ROLL DOUBLES WHILE JAILED (ESCAPE & AUTHORIZED MOVEMENT) ===');
  {
    const { s1, s2, roomId } = await setupFreshRoom('AliceDoubles', 'BobDoubles');
    const jailRes = await walkAndJailPlayer(s1, s2, 1);
    check('Alice sent to jail via Go-To-Jail card', jailRes && jailRes.ok && jailRes.position === 10 && jailRes.inJail === true);

    // End Alice's turn, then Bob's turn, so Alice starts fresh turn in jail
    await emitAck(s1, 'turn:ended', { playerId: 1 });
    await emitAck(s2, 'turn:ended', { playerId: 2 });

    let s = await syncState(s1);
    let p1 = playerIn(s, 1);
    check('Alice is in jail at start of turn (pos 10, inJail=true, jailTurns=0)',
      p1.position === 10 && p1.inJail === true && p1.jailTurns === 0);

    // Bob listens for player:rolled broadcast
    const bobRolledPromise = waitFor(s2, 'player:rolled');

    // Alice rolls doubles [4, 4] while jailed
    const rollAck = await emitAck(s1, 'player:rolled', { playerId: 1, _testForcedDice: [4, 4] });
    check('doubles roll accepted on server', !!(rollAck && rollAck.ok), JSON.stringify(rollAck));
    check('doubles roll returns inJail=false', rollAck && rollAck.inJail === false);
    check('doubles roll returns jailTurns=0', rollAck && rollAck.jailTurns === 0);
    check('doubles roll returns escaped=true', rollAck && rollAck.escaped === true);
    check('doubles roll total is sum of dice (8)', rollAck && rollAck.total === 8);

    const bobRolledEvt = await bobRolledPromise;
    check('Bob received player:rolled broadcast with inJail=false on doubles',
      bobRolledEvt && bobRolledEvt.inJail === false && bobRolledEvt.escaped === true);

    // Authoritative state confirms Alice is freed
    s = await syncState(s1);
    check('server state confirms Alice inJail=false after doubles', playerIn(s, 1).inJail === false);
    check('server state confirms Alice jailTurns=0 after doubles', playerIn(s, 1).jailTurns === 0);

    // Re-rolling before moving is rejected
    const rerollAck = await emitAck(s1, 'player:rolled', { playerId: 1 });
    check('rolling again before moving is rejected (ROLL_ALREADY_PENDING)',
      rerollAck && rerollAck.ok === false && rerollAck.code === 'ROLL_ALREADY_PENDING',
      JSON.stringify(rerollAck));

    // Bob listens for player:moved broadcast
    const bobMovedPromise = waitFor(s2, 'player:moved');

    // Alice moves: 10 + 8 = 18
    const moveActionId = newActionId();
    const moveAck = await emitAck(s1, 'player:moved', { playerId: 1, actionId: moveActionId });
    check('Alice moves by dice total (10 + 8 = 18)', moveAck && moveAck.ok && moveAck.position === 18, JSON.stringify(moveAck));
    check('Alice move ack confirms inJail=false', moveAck && moveAck.inJail === false);

    const bobMovedEvt = await bobMovedPromise;
    check('Bob received player:moved broadcast with position 18', bobMovedEvt && bobMovedEvt.position === 18);

    // Replay protection: same actionId rejected
    const replayAck = await emitAck(s1, 'player:moved', { playerId: 1, actionId: moveActionId });
    check('replaying same movement actionId is rejected (DUPLICATE_ACTION)',
      replayAck && replayAck.ok === false && replayAck.code === 'DUPLICATE_ACTION',
      JSON.stringify(replayAck));

    // Roll single-use: new actionId rejected because roll was already consumed
    const reUseAck = await emitAck(s1, 'player:moved', { playerId: 1, actionId: newActionId() });
    check('moving again with same roll is rejected (ROLL_ALREADY_USED)',
      reUseAck && reUseAck.ok === false && reUseAck.code === 'ROLL_ALREADY_USED',
      JSON.stringify(reUseAck));

    // Turn flow: Alice ends turn, Bob is on turn
    const endTurnAck = await emitAck(s1, 'turn:ended', { playerId: 1 });
    check('Alice ends turn cleanly after doubles escape and move', endTurnAck && endTurnAck.ok && endTurnAck.currentTurnPlayerId === 2);
  }

  // ============================================================================
  // PART 6: FIRST AND SECOND FAILED ATTEMPTS (INCREMENT JAIL TURNS, BLOCK MOVEMENT, TURN ADVANCE)
  // ============================================================================
  console.log('\n=== 6. FIRST AND SECOND FAILED ATTEMPTS (JAIL TURNS INCREMENT, BLOCK MOVEMENT) ===');
  {
    const { s1, s2, roomId } = await setupFreshRoom('AliceTurns', 'BobTurns');
    await walkAndJailPlayer(s1, s2, 1);

    await emitAck(s1, 'turn:ended', { playerId: 1 });
    await emitAck(s2, 'turn:ended', { playerId: 2 });

    let s = await syncState(s1);
    check('Alice starts in jail (pos 10, inJail=true, jailTurns=0)',
      playerIn(s, 1).position === 10 && playerIn(s, 1).inJail === true && playerIn(s, 1).jailTurns === 0);

    // ----- ATTEMPT 1: Non-doubles [1, 2] -----
    console.log('\n--- 6.1 Attempt 1: Non-doubles ---');
    const bobAttempt1Promise = waitFor(s2, 'player:rolled');
    const roll1 = await emitAck(s1, 'player:rolled', { playerId: 1, _testForcedDice: [1, 2] });
    check('Attempt 1 roll accepted on server', !!(roll1 && roll1.ok), JSON.stringify(roll1));
    check('Attempt 1 keeps inJail=true', roll1 && roll1.inJail === true);
    check('Attempt 1 increments jailTurns to 1', roll1 && roll1.jailTurns === 1);
    check('Attempt 1 escaped is false', roll1 && roll1.escaped === false);

    const bobAttempt1Evt = await bobAttempt1Promise;
    check('Bob received Attempt 1 broadcast with inJail=true, jailTurns=1',
      bobAttempt1Evt && bobAttempt1Evt.inJail === true && bobAttempt1Evt.jailTurns === 1);

    s = await syncState(s1);
    check('authoritative state confirms jailTurns=1 after Attempt 1', playerIn(s, 1).jailTurns === 1 && playerIn(s, 1).inJail === true);

    // Movement must NOT be authorized on failed roll
    const move1Attempt = await emitAck(s1, 'player:moved', { playerId: 1, actionId: newActionId() });
    check('movement rejected on Attempt 1 (IN_JAIL)',
      move1Attempt && move1Attempt.ok === false && move1Attempt.code === 'IN_JAIL',
      JSON.stringify(move1Attempt));

    s = await syncState(s1);
    check('Alice position remains tile 10 after rejected move', playerIn(s, 1).position === 10);

    // Rolling again in same turn rejected
    const rerollAttempt1 = await emitAck(s1, 'player:rolled', { playerId: 1 });
    check('reroll in same turn rejected after failed Attempt 1 (ROLL_ALREADY_PENDING)',
      rerollAttempt1 && rerollAttempt1.ok === false && rerollAttempt1.code === 'ROLL_ALREADY_PENDING');

    // Turn flow: Alice ends turn, Bob takes and ends turn
    await emitAck(s1, 'turn:ended', { playerId: 1 });
    await emitAck(s2, 'turn:ended', { playerId: 2 });

    // Verify jailTurns persists into Alice's next turn
    s = await syncState(s1);
    check('Alice begins Turn 2 in jail with jailTurns=1 preserved',
      playerIn(s, 1).inJail === true && playerIn(s, 1).jailTurns === 1);

    // ----- ATTEMPT 2: Non-doubles [2, 3] -----
    console.log('\n--- 6.2 Attempt 2: Non-doubles ---');
    const bobAttempt2Promise = waitFor(s2, 'player:rolled');
    const roll2 = await emitAck(s1, 'player:rolled', { playerId: 1, _testForcedDice: [2, 3] });
    check('Attempt 2 roll accepted on server', !!(roll2 && roll2.ok), JSON.stringify(roll2));
    check('Attempt 2 keeps inJail=true', roll2 && roll2.inJail === true);
    check('Attempt 2 increments jailTurns to 2', roll2 && roll2.jailTurns === 2);
    check('Attempt 2 escaped is false', roll2 && roll2.escaped === false);

    const bobAttempt2Evt = await bobAttempt2Promise;
    check('Bob received Attempt 2 broadcast with inJail=true, jailTurns=2',
      bobAttempt2Evt && bobAttempt2Evt.inJail === true && bobAttempt2Evt.jailTurns === 2);

    s = await syncState(s1);
    check('authoritative state confirms jailTurns=2 after Attempt 2', playerIn(s, 1).jailTurns === 2 && playerIn(s, 1).inJail === true);

    // Movement must NOT be authorized on failed roll 2
    const move2Attempt = await emitAck(s1, 'player:moved', { playerId: 1, actionId: newActionId() });
    check('movement rejected on Attempt 2 (IN_JAIL)',
      move2Attempt && move2Attempt.ok === false && move2Attempt.code === 'IN_JAIL',
      JSON.stringify(move2Attempt));

    // Turn flow: Alice ends turn, Bob takes and ends turn
    await emitAck(s1, 'turn:ended', { playerId: 1 });
    await emitAck(s2, 'turn:ended', { playerId: 2 });

    s = await syncState(s1);
    check('Alice begins Turn 3 in jail with jailTurns=2 preserved',
      playerIn(s, 1).inJail === true && playerIn(s, 1).jailTurns === 2);

    // ----- ATTEMPT 3: Third failed attempt with sufficient funds ($100 forced bail) -----
    console.log('\n--- 6.3 Attempt 3: Third failed attempt with sufficient funds ---');
    const moneyBeforeForced = playerIn(s, 1).money;
    const bobForcedBailPromise = waitFor(s2, 'jail:bail-paid');
    const bobAttempt3Promise = waitFor(s2, 'player:rolled');

    const roll3 = await emitAck(s1, 'player:rolled', { playerId: 1, _testForcedDice: [3, 4] });
    check('Attempt 3 roll accepted on server', !!(roll3 && roll3.ok), JSON.stringify(roll3));
    check('Attempt 3 confirms forcedBail=true', roll3 && roll3.forcedBail === true);
    check('Attempt 3 confirms inJail=false', roll3 && roll3.inJail === false);
    check('Attempt 3 confirms jailTurns=0', roll3 && roll3.jailTurns === 0);
    check('Attempt 3 deducted exactly $100 bail', roll3 && roll3.money === moneyBeforeForced - 100);

    const bobForcedBailEvt = await bobForcedBailPromise;
    check('Bob received jail:bail-paid broadcast for forced bail', !!bobForcedBailEvt, JSON.stringify(bobForcedBailEvt));
    check('forced bail broadcast carries playerId=1', bobForcedBailEvt && bobForcedBailEvt.playerId === 1);
    check('forced bail broadcast carries forced=true', bobForcedBailEvt && bobForcedBailEvt.forced === true);
    check('forced bail broadcast carries bail=$100', bobForcedBailEvt && bobForcedBailEvt.bail === 100);

    s = await syncState(s1);
    const p1AfterForced = playerIn(s, 1);
    check('authoritative state confirms Alice inJail=false after forced bail', p1AfterForced.inJail === false);
    check('authoritative state confirms Alice jailTurns=0 after forced bail', p1AfterForced.jailTurns === 0);
    check('authoritative state confirms Alice money deducted by $100', p1AfterForced.money === moneyBeforeForced - 100);

    // "The player must not move on that failed roll."
    const moveAfterForced = await emitAck(s1, 'player:moved', { playerId: 1, actionId: newActionId() });
    check('player MUST NOT move on the failed roll that triggered forced bail',
      moveAfterForced && moveAfterForced.ok === false && moveAfterForced.code === 'IN_JAIL',
      JSON.stringify(moveAfterForced));

    s = await syncState(s1);
    check('Alice position remains tile 10 (did not move on failed roll)', playerIn(s, 1).position === 10);

    // Cannot pay bail again now that player is free
    const bailAgain = await emitAck(s1, 'jail:pay-bail', { playerId: 1, actionId: newActionId() });
    check('paying bail again after forced bail is rejected (NOT_IN_JAIL)',
      bailAgain && bailAgain.ok === false && bailAgain.code === 'NOT_IN_JAIL',
      JSON.stringify(bailAgain));

    // Turn flow: Alice ends turn, Bob ends turn, Alice is free on next turn
    await emitAck(s1, 'turn:ended', { playerId: 1 });
    await emitAck(s2, 'turn:ended', { playerId: 2 });

    s = await syncState(s1);
    check('Alice is completely free on next turn (inJail=false)', playerIn(s, 1).inJail === false);

    // Alice rolls and moves normally on her next turn
    const normalRoll = await emitAck(s1, 'player:rolled', { playerId: 1 });
    check('Alice rolls normally on turn after forced bail', !!(normalRoll && normalRoll.ok));
    const normalMove = await emitAck(s1, 'player:moved', { playerId: 1, actionId: newActionId() });
    check('Alice moves normally on turn after forced bail', !!(normalMove && normalMove.ok));
    s = await syncState(s1);
    check('Alice moved away from tile 10', playerIn(s, 1).position !== 10);
  }

  // ============================================================================
  // PART 7: THIRD FAILED ATTEMPT WITH INSUFFICIENT FUNDS (BANKRUPTCY INTEGRATION)
  // ============================================================================
  console.log('\n=== 7. THIRD FAILED ATTEMPT WITH INSUFFICIENT FUNDS (BANKRUPTCY INTEGRATION) ===');
  {
    const { s1, s2, roomId } = await setupFreshRoom('CharlieBroke', 'DaveRich');

    // Transfer $1450 from Charlie to Dave via authoritative trade so Charlie has only $50 (< $100 bail)
    const tradeObj = {
      id: `trade-drain-${Date.now()}`,
      initiatorId: 1,
      targetId: 2,
      initiatorPropertyIds: [],
      targetPropertyIds: [],
      initiatorMoney: 1450,
      targetMoney: 0,
    };
    const propRes = await emitAck(s1, 'trade:created', tradeObj);
    check('trade created to drain Charlie to $50', !!(propRes && propRes.ok), JSON.stringify(propRes));
    const accRes = await emitAck(s2, 'trade:accepted', { trade: tradeObj, actionId: newActionId() });
    check('trade accepted by Dave', !!(accRes && accRes.ok), JSON.stringify(accRes));

    let s = await syncState(s1);
    check('Charlie balance is exactly $50 (< $100 bail)', playerIn(s, 1).money === 50, `money=${playerIn(s, 1).money}`);

    // Send Charlie to jail via card
    await walkAndJailPlayer(s1, s2, 1);

    await emitAck(s1, 'turn:ended', { playerId: 1 });
    await emitAck(s2, 'turn:ended', { playerId: 2 });

    s = await syncState(s1);
    check('Charlie in jail with $50 (jailTurns=0)',
      playerIn(s, 1).inJail === true && playerIn(s, 1).jailTurns === 0 && playerIn(s, 1).money === 50);

    // Manual bail attempt with $50 must be refused with INSUFFICIENT_FUNDS
    const manualBailRefused = await emitAck(s1, 'jail:pay-bail', { playerId: 1, actionId: newActionId() });
    check('Charlie paying manual bail with $50 is REFUSED (INSUFFICIENT_FUNDS)',
      manualBailRefused && manualBailRefused.ok === false && manualBailRefused.code === 'INSUFFICIENT_FUNDS',
      JSON.stringify(manualBailRefused));

    s = await syncState(s1);
    check('Charlie balance remains $50 after refused bail (charged NOTHING)', playerIn(s, 1).money === 50);

    // Attempt 1: non-doubles
    await emitAck(s1, 'player:rolled', { playerId: 1, _testForcedDice: [1, 2] });
    await emitAck(s1, 'turn:ended', { playerId: 1 });
    await emitAck(s2, 'turn:ended', { playerId: 2 });

    // Attempt 2: non-doubles
    await emitAck(s1, 'player:rolled', { playerId: 1, _testForcedDice: [2, 3] });
    await emitAck(s1, 'turn:ended', { playerId: 1 });
    await emitAck(s2, 'turn:ended', { playerId: 2 });

    s = await syncState(s1);
    check('Charlie ready for Attempt 3 (jailTurns=2, money=50)',
      playerIn(s, 1).jailTurns === 2 && playerIn(s, 1).money === 50);

    // Dave listens for bankruptcy and game:over broadcasts
    const daveBankruptPromise = waitFor(s2, 'player:bankrupt');
    const daveGameOverPromise = waitFor(s2, 'game:over');

    // Attempt 3: non-doubles roll when unable to pay $100 forced bail
    const roll3Bankrupt = await emitAck(s1, 'player:rolled', { playerId: 1, _testForcedDice: [3, 4] });
    check('Attempt 3 roll acknowledges bankruptcy',
      roll3Bankrupt && roll3Bankrupt.ok && roll3Bankrupt.isBankrupt === true,
      JSON.stringify(roll3Bankrupt));

    // Verify peer received player:bankrupt broadcast
    const daveBankruptEvt = await daveBankruptPromise;
    check('Dave received player:bankrupt broadcast for Charlie', !!daveBankruptEvt, JSON.stringify(daveBankruptEvt));
    check('bankruptcy broadcast carries playerId=1', daveBankruptEvt && daveBankruptEvt.playerId === 1);

    // Verify game:over broadcast for last-player-standing
    const daveGameOverEvt = await daveGameOverPromise;
    check('Dave received game:over broadcast', !!daveGameOverEvt, JSON.stringify(daveGameOverEvt));
    check('Dave is declared winner', daveGameOverEvt && daveGameOverEvt.winnerId === 2);

    // Authoritative state checks: Charlie is bankrupt, balance is 0 (not negative!)
    s = await syncState(s2);
    const charlieAfter = playerIn(s, 1);
    check('Charlie isBankrupt is true', charlieAfter && charlieAfter.isBankrupt === true);
    check('Charlie balance is exactly $0 (NO negative money permitted)', charlieAfter && charlieAfter.money === 0);
    check('Charlie properties released (none owned)',
      !Object.values(s.propertyOwnership || {}).includes(1));

    // Bankrupt player cannot act
    const bankruptMove = await emitAck(s1, 'player:moved', { playerId: 1, actionId: newActionId() });
    check('bankrupt player movement is rejected (PLAYER_OUT)',
      bankruptMove && bankruptMove.ok === false && bankruptMove.code === 'PLAYER_OUT',
      JSON.stringify(bankruptMove));
  }

  // ============================================================================
  // PART 8: FORGED PAYLOADS & TAMPERING PREVENTION
  // ============================================================================
  console.log('\n=== 8. FORGED PAYLOADS & TAMPERING PREVENTION ===');
  {
    const { s1, s2, roomId } = await setupFreshRoom('AliceTamper', 'BobTamper');
    await walkAndJailPlayer(s1, s2, 1);

    await emitAck(s1, 'turn:ended', { playerId: 1 });
    await emitAck(s2, 'turn:ended', { playerId: 2 });

    // 8.1 Spoofed client-provided inJail=false or position on player:moved is ignored
    const forgedMove = await emitAck(s1, 'player:moved', {
      playerId: 1,
      actionId: newActionId(),
      inJail: false,
      position: 25,
      money: 999999,
      dice: [6, 6],
    });
    check('forged player:moved claiming inJail=false/pos=25 is rejected (IN_JAIL)',
      forgedMove && forgedMove.ok === false && forgedMove.code === 'IN_JAIL',
      JSON.stringify(forgedMove));

    // 8.2 Client-provided dice/total on player:rolled is ignored
    const fakeDiceRoll = await emitAck(s1, 'player:rolled', {
      playerId: 1,
      dice: [6, 6],
      total: 12,
      _testForcedDice: [1, 2],
    });
    check('player:rolled ignores claimed dice: [6, 6] in favour of server dice',
      fakeDiceRoll && fakeDiceRoll.dice[0] === 1 && fakeDiceRoll.dice[1] === 2 && fakeDiceRoll.total === 3);

    // 8.3 Forged bail payload: price: 0, bail: 0, money: 999999 ignored on jail:pay-bail
    const moneyBeforeForgedBail = playerIn(await syncState(s1), 1).money;
    const forgedBail = await emitAck(s1, 'jail:pay-bail', {
      playerId: 1,
      actionId: newActionId(),
      bail: 0,
      price: 0,
      money: 999999,
    });
    check('jail:pay-bail succeeds but charges OFFICIAL $100 (ignores claimed $0)',
      forgedBail && forgedBail.ok && forgedBail.bail === 100);
    check('authoritative money deducted by official $100, not claimed $0',
      playerIn(await syncState(s1), 1).money === moneyBeforeForgedBail - 100);
  }

  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  await cleanup();
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error('TEST ERROR:', err && err.message, err && err.stack);
  await cleanup();
  process.exit(2);
});
