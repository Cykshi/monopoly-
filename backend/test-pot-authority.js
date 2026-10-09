// Focused REST HOUSE & CLUB TILE FEES & POT AUTHORITY test suite.
//
// Verifies the 8 guarantees requested:
//   1. correct Rest House fee (fee is $0; awards pot)
//   2. correct Club fee (cardCount * 50 + houseCount * 100)
//   3. server-authoritative money deduction (client cannot alter fee or balance)
//   4. pot update (club fee adds to pot, rest house pays out and resets pot)
//   5. peer broadcast (club:paid and rest-house:resolved emitted to room)
//   6. forged client amounts being ignored/rejected (spoofed fee/pot/money/destination ignored or rejected)
//   7. duplicate/replay protection (actionGate prevents double deductions or payouts)
//   8. persistence/restore (room pot survives serialization, disk persist, and rehydrate/sync)
//
// Run against a live server:
//   SERVER_URL=http://localhost:3099 node test-pot-authority.js
const { io } = require('socket.io-client');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const board = require('./game/board');
const persistence = require('./persistence');

const URL = process.env.SERVER_URL || 'http://localhost:3099';
const results = [];
let failed = 0;

function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

// ============================================================================
// PART 1: PURE UNIT TESTS
// ============================================================================
console.log('\n=== 1. PURE UNIT TESTS: FEES, POT FORMULAS & PERSISTENCE ===');

// 1. Correct Rest House fee
check('1. Rest House fee is strictly 0', board.calculateRestHouseFee() === 0);

// 2. Correct Club fee formula: cardCount * 50 + houseCount * 100
check('2. Club fee: 0 cards, 0 houses = $0', board.calculateClubFee(0, 0) === 0);
check('2. Club fee: 1 card, 0 houses = $50', board.calculateClubFee(1, 0) === 50);
check('2. Club fee: 0 cards, 2 houses = $200', board.calculateClubFee(0, 2) === 200);
check('2. Club fee: 1 card, 3 houses = $350 (1*50 + 3*100)', board.calculateClubFee(1, 3) === 350);
check('2. Club fee: boolean card count (true = 1 card) with 1 house = $150', board.calculateClubFee(true, 1) === 150);

// House count helper
{
  const ownership = { 1: 10, 2: 10, 4: 20 };
  const houses = { 1: 2, 2: 3, 4: 4 };
  const p1Houses = board.countPlayerHouses(ownership, houses, 10);
  const p2Houses = board.countPlayerHouses(ownership, houses, 20);
  const p3Houses = board.countPlayerHouses(ownership, houses, 99);
  check('countPlayerHouses correctly sums player houses', p1Houses === 5 && p2Houses === 4 && p3Houses === 0);
}

// 8. Persistence unit serialization and rehydration
{
  const mockRoom = {
    roomId: 'POTTEST',
    hostToken: 'token-host',
    tokens: new Set(['token-host']),
    players: [{ id: 1, money: 1450, hasSkillCard: true, isResting: false }],
    propertyOwnership: {},
    propertyHouses: {},
    currentTurnPlayerId: 1,
    turnSeeded: true,
    pot: 250,
    restHousePot: 250,
    trades: [],
    activeAuction: null,
    createdAt: Date.now()
  };
  const serialized = persistence.serializeRoom(mockRoom);
  check('8. serializeRoom preserves pot', serialized.pot === 250 && serialized.restHousePot === 250);

  // Persistence to disk round trip
  const tmpDir = path.join(__dirname, '.test-pot-data');
  process.env.DATA_DIR = tmpDir;
  try {
    persistence.persistRoom(mockRoom);
    const loaded = persistence.loadPersistedRooms();
    const found = loaded.find((r) => r.roomId === 'POTTEST');
    check('8. persistRoom & loadPersistedRooms preserves pot on disk', !!found && found.pot === 250 && found.restHousePot === 250);
  } finally {
    try { persistence.deleteRoomFile('POTTEST'); } catch { }
    try { if (fs.existsSync(tmpDir)) fs.rmdirSync(tmpDir, { recursive: true }); } catch { }
  }
}

// ============================================================================
// PART 2: LIVE SOCKET SERVER INTEGRATION TESTS
// ============================================================================
console.log('\n=== 2. LIVE SERVER INTEGRATION: REST HOUSE, CLUB & POT AUTHORITY ===');

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
const newActionId = () => `pot-act-${Date.now()}-${++seq}`;

const sockets = [];
const track = (s) => { sockets.push(s); return s; };

const cleanup = async () => {
  for (const s of sockets) {
    try { if (s && typeof s.disconnect === 'function') s.disconnect(); } catch { }
  }
  await sleep(150);
};

(async () => {
  try {
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

    // Initial state check: pot is 0
    let state = await syncState(A);
    check('setup: initial room pot is 0', state && state.pot === 0);

    // Start the game by having Player 1 roll and move
    const firstRoll = await emitAck(A, 'player:rolled', { playerId: 1 });
    check('setup: game started via player:rolled', !!(firstRoll && firstRoll.ok));
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });

    // ------------------------------------------------------------------------
    // Step Alice to tile 30 (CLUB)
    // ------------------------------------------------------------------------
    console.log('\n--- Stepping Alice to tile 30 (CLUB) ---');
    state = await syncState(A);
    let p1Pos = playerIn(state, 1).position;
    let distTo30 = (30 - p1Pos + 40) % 40;

    while (distTo30 > 0) {
      const step = Math.min(distTo30, 6);
      await emitAck(A, 'player:skill-card', { movement: step, playerId: 1 });
      await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });
      distTo30 -= step;
    }

    state = await syncState(A);
    p1Pos = playerIn(state, 1).position;
    check('Alice successfully landed on tile 30 (CLUB)', p1Pos === 30, `pos=${p1Pos}`);

    const aliceMoneyBeforeClub = playerIn(state, 1).money;

    // ------------------------------------------------------------------------
    // Scenario 2, 3, 4, 5, 6: Club fee, deduction, pot update, broadcast, forgery
    // ------------------------------------------------------------------------
    console.log('\n--- 2. CLUB FEE, MONEY DEDUCTION, POT UPDATE & BROADCAST ---');

    // Bob listens for peer broadcast of club:paid
    const peerClubPaidPromise = waitFor(B, 'club:paid');

    // Alice calls club:pay with forged parameters (fee: 0, pot: 0, money: 999999)
    const clubActionId = newActionId();
    const clubAck = await emitAck(A, 'club:pay', {
      playerId: 1,
      actionId: clubActionId,
      fee: 0,             // FORGERY ATTEMPT: client asks for 0 fee
      amount: 0,          // FORGERY ATTEMPT
      pot: 0,             // FORGERY ATTEMPT
      money: 999999,      // FORGERY ATTEMPT
    });

    check('2. Club fee calculated authoritatively as $50 (1 card, 0 houses)',
      clubAck && clubAck.ok && clubAck.fee === 50 && clubAck.paid === 50,
      JSON.stringify(clubAck));

    // 3. Server-authoritative money deduction
    check('3. Alice money deducted by server by exactly $50',
      clubAck && clubAck.money === aliceMoneyBeforeClub - 50,
      `expected=${aliceMoneyBeforeClub - 50} actual=${clubAck && clubAck.money}`);

    // 4. Pot update
    check('4. Pot updated on server to $50',
      clubAck && clubAck.pot === 50 && clubAck.restHousePot === 50);

    // 5. Peer broadcast
    const peerClubPaid = await peerClubPaidPromise;
    check('5. Peer Bob received club:paid broadcast with authoritative balances',
      peerClubPaid && peerClubPaid.playerId === 1 && peerClubPaid.fee === 50 && peerClubPaid.pot === 50 && peerClubPaid.money === clubAck.money,
      JSON.stringify(peerClubPaid));

    // 6. Forged client amounts were ignored (Alice balance was NOT 999999, fee was NOT 0)
    check('6. Forged client amounts ignored: fee remained 50, money remained authoritative',
      clubAck && clubAck.fee === 50 && clubAck.money !== 999999);

    // 7. Duplicate/replay protection on club:pay
    console.log('\n--- 7. DUPLICATE / REPLAY PROTECTION ---');
    const duplicateClubPay = await emitAck(A, 'club:pay', {
      playerId: 1,
      actionId: clubActionId, // Same actionId replayed
    });
    check('7. Replayed club:pay rejected with DUPLICATE_ACTION',
      duplicateClubPay && duplicateClubPay.ok === false && duplicateClubPay.code === 'DUPLICATE_ACTION',
      JSON.stringify(duplicateClubPay));

    // Verify balance and pot did NOT change on duplicate attempt
    state = await syncState(A);
    check('7. Replayed club:pay did not deduct money or add to pot again',
      playerIn(state, 1).money === clubAck.money && state.pot === 50);

    // ------------------------------------------------------------------------
    // Step Alice from tile 30 to tile 20 (REST HOUSE)
    // Distance from 30 to 20 is 30 steps
    // ------------------------------------------------------------------------
    console.log('\n--- Stepping Alice to tile 20 (REST HOUSE) ---');
    let distTo20 = (20 - 30 + 40) % 40; // 30 steps
    while (distTo20 > 0) {
      const step = Math.min(distTo20, 6);
      await emitAck(A, 'player:skill-card', { movement: step, playerId: 1 });
      await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });
      distTo20 -= step;
    }

    state = await syncState(A);
    p1Pos = playerIn(state, 1).position;
    check('Alice successfully landed on tile 20 (REST HOUSE)', p1Pos === 20, `pos=${p1Pos}`);

    const aliceMoneyBeforeRest = playerIn(state, 1).money;
    const potBeforeRest = state.pot;
    check('Pot before Rest House collection is $50', potBeforeRest === 50);

    // ------------------------------------------------------------------------
    // Scenario 1, 3, 4, 5, 6: Rest House fee, pot payout, pot update, broadcast, forgery
    // ------------------------------------------------------------------------
    console.log('\n--- 1. REST HOUSE FEE, POT PAYOUT & BROADCAST ---');

    // Bob listens for peer broadcast of rest-house:resolved
    const peerRestPromise = waitFor(B, 'rest-house:resolved');

    // Alice calls rest-house:resolve with forged amounts
    const restActionId = newActionId();
    const restAck = await emitAck(A, 'rest-house:resolve', {
      playerId: 1,
      actionId: restActionId,
      payout: 999999, // FORGERY ATTEMPT: client requests huge payout
      pot: 999999,    // FORGERY ATTEMPT
      fee: 500,       // FORGERY ATTEMPT: fee should remain 0
    });

    // 1. Correct Rest House fee
    check('1. Rest House fee is strictly $0 and payout is authoritative pot ($50)',
      restAck && restAck.ok && restAck.fee === 0 && restAck.payout === 50,
      JSON.stringify(restAck));

    // 3. Money addition from pot
    check('3. Alice balance increased by authoritative pot ($50)',
      restAck && restAck.money === aliceMoneyBeforeRest + 50,
      `expected=${aliceMoneyBeforeRest + 50} actual=${restAck && restAck.money}`);

    // 4. Pot update
    check('4. Pot reset to $0 after Rest House collection',
      restAck && restAck.pot === 0 && restAck.restHousePot === 0);

    // 5. Peer broadcast
    const peerRest = await peerRestPromise;
    check('5. Peer Bob received rest-house:resolved broadcast with fee 0 and payout 50',
      peerRest && peerRest.playerId === 1 && peerRest.fee === 0 && peerRest.payout === 50 && peerRest.pot === 0 && peerRest.money === restAck.money,
      JSON.stringify(peerRest));

    // 6. Forged payout was ignored
    check('6. Forged payout ignored: payout was 50, not 999999',
      restAck && restAck.payout === 50);

    // 7. Duplicate/replay protection on rest-house:resolve
    const duplicateRest = await emitAck(A, 'rest-house:resolve', {
      playerId: 1,
      actionId: restActionId, // Same actionId replayed
    });
    check('7. Replayed rest-house:resolve rejected with DUPLICATE_ACTION',
      duplicateRest && duplicateRest.ok === false && duplicateRest.code === 'DUPLICATE_ACTION',
      JSON.stringify(duplicateRest));

    // 6. Landing forgery rejection tests: wrong tiles
    console.log('\n--- 6. REJECTION OF ACTION ON WRONG TILES ---');
    // Alice is currently on tile 20. Calling club:pay must be rejected!
    const wrongClub = await emitAck(A, 'club:pay', {
      playerId: 1,
      actionId: newActionId(),
    });
    check('6. Calling club:pay when on tile 20 rejected with NOT_ON_CLUB',
      wrongClub && wrongClub.ok === false && wrongClub.code === 'NOT_ON_CLUB',
      JSON.stringify(wrongClub));

    // End Alice's turn, then Bob's turn: Bob is at tile 0 (or wherever Bob moved).
    // Bob calling rest-house:resolve when at tile 0 must be rejected!
    await emitAck(A, 'turn:ended', { playerId: 1 });
    const wrongRest = await emitAck(B, 'rest-house:resolve', {
      playerId: 2,
      actionId: newActionId(),
    });
    check('6. Calling rest-house:resolve when not on tile 20 rejected with NOT_ON_REST_HOUSE',
      wrongRest && wrongRest.ok === false && wrongRest.code === 'NOT_ON_REST_HOUSE',
      JSON.stringify(wrongRest));

    // 8. Reconnect and sync state test
    console.log('\n--- 8. RECONNECT & RESTORE POT SYNCHRONIZATION ---');
    // Step Bob to tile 30 (CLUB) so pot accumulates again
    let bobDistTo30 = (30 - 0 + 40) % 40;
    while (bobDistTo30 > 0) {
      const step = Math.min(bobDistTo30, 6);
      await emitAck(B, 'player:skill-card', { movement: step, playerId: 2 });
      await emitAck(B, 'player:moved', { playerId: 2, actionId: newActionId() });
      bobDistTo30 -= step;
    }
    const bobClubAck = await emitAck(B, 'club:pay', {
      playerId: 2,
      actionId: newActionId(),
    });
    check('Bob paid club fee, pot now $50', bobClubAck && bobClubAck.ok && bobClubAck.pot === 50);

    // Request sync from socket A: should carry pot: 50
    const syncRes = await syncState(A);
    check('8. game:sync carries authoritative pot ($50)', syncRes && syncRes.pot === 50 && syncRes.restHousePot === 50);

    // Rejoining Bob with pre-existing tokenB: playerState should carry pot: 50
    const rejoinAck = await emitAck(B, 'player:rejoin', { token: tokenB, roomId });
    check('8. player:rejoin playerState includes authoritative pot ($50)',
      rejoinAck && rejoinAck.ok && rejoinAck.playerState && rejoinAck.playerState.pot === 50,
      JSON.stringify(rejoinAck && rejoinAck.playerState && rejoinAck.playerState.pot));

  } catch (err) {
    check('unexpected test runner error', false, err.stack || err.message);
  } finally {
    await cleanup();
  }

  console.log(`\n================================================================`);
  console.log(`RESULTS: ${results.length - failed} passed, ${failed} failed`);
  console.log(`================================================================`);
  process.exit(failed > 0 ? 1 : 0);
})();
