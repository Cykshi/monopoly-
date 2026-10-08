// Focused TAX TILE FEES & POT AUTHORITY test suite.
//
// Verifies the 8 guarantees requested:
//   1. correct tax amount (from server board rules: tile 7 is $100, tile 24 is $200, tile 34 is $250)
//   2. server-side money deduction (client cannot alter tax or balance)
//   3. pot increase (tax payment adds to pot / restHousePot)
//   4. peer synchronization (tax:paid emitted to room with updated pot and balances)
//   5. forged client amount ignored/rejected (spoofed amount/pot/money ignored)
//   6. wrong tile rejected (cannot pay tax when not on a tax tile, or tileId mismatch)
//   7. duplicate action rejected (actionGate prevents double deductions or replay)
//   8. persistence/restore (room pot survives serialization, disk persist, and rehydrate/sync)
//
// Run against a live server:
//   SERVER_URL=http://localhost:3099 node test-tax-authority.js
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
console.log('\n=== 1. PURE UNIT TESTS: TAX AMOUNTS & PERSISTENCE ===');

// 1. Correct tax amounts on authoritative board
check('1. Tile 7 is a tax tile', board.isTaxTile(7));
check('1. Tile 7 tax amount is $100', board.taxAmount(7) === 100);

check('1. Tile 24 is a tax tile', board.isTaxTile(24));
check('1. Tile 24 tax amount is $200', board.taxAmount(24) === 200);

check('1. Tile 34 is a tax tile', board.isTaxTile(34));
check('1. Tile 34 tax amount is $250', board.taxAmount(34) === 250);

check('1. Tile 0 (START) is not a tax tile', !board.isTaxTile(0));
check('1. Tile 20 (REST HOUSE) is not a tax tile', !board.isTaxTile(20));
check('1. Tile 30 (CLUB) is not a tax tile', !board.isTaxTile(30));

// 8. Persistence unit serialization and rehydration with tax-fed pot
{
  const mockRoom = {
    roomId: 'TAXTEST',
    hostToken: 'token-host',
    tokens: new Set(['token-host']),
    players: [{ id: 1, money: 1400, hasSkillCard: true, isResting: false }],
    propertyOwnership: {},
    propertyHouses: {},
    currentTurnPlayerId: 1,
    turnSeeded: true,
    pot: 100, // received $100 from tax
    restHousePot: 100,
    trades: [],
    activeAuction: null,
    createdAt: Date.now()
  };
  const serialized = persistence.serializeRoom(mockRoom);
  check('8. serializeRoom preserves tax-fed pot', serialized.pot === 100 && serialized.restHousePot === 100);

  const tmpDir = path.join(__dirname, '.test-tax-data');
  process.env.DATA_DIR = tmpDir;
  try {
    persistence.persistRoom(mockRoom);
    const loaded = persistence.loadPersistedRooms();
    const found = loaded.find((r) => r.roomId === 'TAXTEST');
    check('8. persistRoom & loadPersistedRooms preserves tax pot on disk', !!found && found.pot === 100 && found.restHousePot === 100);
  } finally {
    try { persistence.deleteRoomFile('TAXTEST'); } catch {}
    try { if (fs.existsSync(tmpDir)) fs.rmdirSync(tmpDir, { recursive: true }); } catch {}
  }
}

// ============================================================================
// PART 2: LIVE SOCKET SERVER INTEGRATION TESTS
// ============================================================================
console.log('\n=== 2. LIVE SERVER INTEGRATION: TAX & POT AUTHORITY ===');

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
const newActionId = () => `tax-act-${Date.now()}-${++seq}`;

const sockets = [];
const track = (s) => { sockets.push(s); return s; };

const cleanup = async () => {
  for (const s of sockets) {
    try { if (s && typeof s.disconnect === 'function') s.disconnect(); } catch {}
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

    // Initial state: pot is 0
    let state = await syncState(A);
    check('setup: initial room pot is 0', state && state.pot === 0);

    // Start game via initial roll and move
    const firstRoll = await emitAck(A, 'player:rolled', { playerId: 1 });
    check('setup: game started via player:rolled', !!(firstRoll && firstRoll.ok));
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });

    // ------------------------------------------------------------------------
    // Step Alice to tile 7 (TAX: $100)
    // ------------------------------------------------------------------------
    console.log('\n--- Stepping Alice to tile 7 (TAX: $100) ---');
    state = await syncState(A);
    let p1Pos = playerIn(state, 1).position;
    let distTo7 = (7 - p1Pos + 40) % 40;

    while (distTo7 > 0) {
      const step = Math.min(distTo7, 6);
      await emitAck(A, 'player:skill-card', { movement: step, playerId: 1 });
      await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });
      distTo7 -= step;
    }

    state = await syncState(A);
    p1Pos = playerIn(state, 1).position;
    check('Alice successfully landed on tile 7 (TAX)', p1Pos === 7, `pos=${p1Pos}`);

    const aliceMoneyBeforeTax = playerIn(state, 1).money;

    // ------------------------------------------------------------------------
    // Scenarios: Correct tax amount, money deduction, pot increase, peer sync, forged amount
    // ------------------------------------------------------------------------
    console.log('\n--- TAX PAYMENT, DEDUCTION, POT INCREASE & PEER SYNC ---');

    // Bob listens for peer broadcast of tax:paid
    const peerTaxPaidPromise = waitFor(B, 'tax:paid');

    // Alice calls tax:pay with forged client parameters (amount: 0, pot: 0, money: 999999)
    const taxActionId = newActionId();
    const taxAck = await emitAck(A, 'tax:pay', {
      playerId: 1,
      tileId: 7,
      actionId: taxActionId,
      amount: 0,      // FORGERY ATTEMPT: client asks to pay $0
      pot: 0,         // FORGERY ATTEMPT
      money: 999999,  // FORGERY ATTEMPT
    });

    // 1. Correct tax amount
    check('1. Tax amount calculated authoritatively as $100 for tile 7',
      taxAck && taxAck.ok && taxAck.amount === 100 && taxAck.paid === 100,
      JSON.stringify(taxAck));

    // 2. Server-side money deduction
    check('2. Alice money deducted by server by exactly $100',
      taxAck && taxAck.money === aliceMoneyBeforeTax - 100,
      `expected=${aliceMoneyBeforeTax - 100} actual=${taxAck && taxAck.money}`);

    // 3. Pot increase
    check('3. Pot increased on server from $0 to $100',
      taxAck && taxAck.pot === 100 && taxAck.restHousePot === 100);

    // 4. Peer synchronization
    const peerTaxPaid = await peerTaxPaidPromise;
    check('4. Peer Bob received tax:paid broadcast with authoritative balances',
      peerTaxPaid && peerTaxPaid.playerId === 1 && peerTaxPaid.amount === 100 && peerTaxPaid.pot === 100 && peerTaxPaid.money === taxAck.money,
      JSON.stringify(peerTaxPaid));

    // 5. Forged client amount ignored
    check('5. Forged client amount ignored: amount remained $100, money remained authoritative',
      taxAck && taxAck.amount === 100 && taxAck.money !== 999999);

    // 7. Duplicate action rejected
    console.log('\n--- 7. DUPLICATE ACTION REJECTION ---');
    const duplicateTaxPay = await emitAck(A, 'tax:pay', {
      playerId: 1,
      tileId: 7,
      actionId: taxActionId, // Same actionId replayed
    });
    check('7. Replayed tax:pay rejected with DUPLICATE_ACTION',
      duplicateTaxPay && duplicateTaxPay.ok === false && duplicateTaxPay.code === 'DUPLICATE_ACTION',
      JSON.stringify(duplicateTaxPay));

    // Verify balance and pot did not change on duplicate attempt
    state = await syncState(A);
    check('7. Replayed tax:pay did not deduct money or add to pot again',
      playerIn(state, 1).money === taxAck.money && state.pot === 100);

    // 6. Wrong tile rejected
    console.log('\n--- 6. WRONG TILE REJECTION ---');
    // Alice is on tile 7. Sending tax:pay with tileId: 24 (mismatch) must be rejected!
    const mismatchTile = await emitAck(A, 'tax:pay', {
      playerId: 1,
      tileId: 24, // Mismatch with position 7
      actionId: newActionId(),
    });
    check('6. tax:pay with tileId mismatch rejected with TILE_MISMATCH',
      mismatchTile && mismatchTile.ok === false && mismatchTile.code === 'TILE_MISMATCH',
      JSON.stringify(mismatchTile));

    // Move Alice to tile 8 (California, property). Calling tax:pay must be rejected!
    await emitAck(A, 'player:skill-card', { movement: 1, playerId: 1 });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });

    state = await syncState(A);
    p1Pos = playerIn(state, 1).position;
    check('Alice moved to tile 8 (California, property)', p1Pos === 8);

    const nonTaxTile = await emitAck(A, 'tax:pay', {
      playerId: 1,
      tileId: 8,
      actionId: newActionId(),
    });
    check('6. Calling tax:pay when on non-tax tile rejected with NOT_ON_TAX',
      nonTaxTile && nonTaxTile.ok === false && nonTaxTile.code === 'NOT_ON_TAX',
      JSON.stringify(nonTaxTile));

    // 8. Persistence / restore of tax-fed pot
    console.log('\n--- 8. PERSISTENCE & RESTORE OF TAX-FED POT ---');
    // Pot has $100 from tile 7 tax.
    const syncRes = await syncState(A);
    check('8. game:sync carries authoritative tax-fed pot ($100)',
      syncRes && syncRes.pot === 100 && syncRes.restHousePot === 100);

    const rejoinAck = await emitAck(B, 'player:rejoin', { token: tokenB, roomId });
    check('8. player:rejoin playerState includes authoritative tax-fed pot ($100)',
      rejoinAck && rejoinAck.ok && rejoinAck.playerState && rejoinAck.playerState.pot === 100,
      JSON.stringify(rejoinAck && rejoinAck.playerState && rejoinAck.playerState.pot));

    // Now step Alice to tile 20 (REST HOUSE) and collect the $100 tax pot!
    console.log('\n--- Collecting tax pot at REST HOUSE ---');
    let distTo20 = (20 - 8 + 40) % 40; // 12 steps
    while (distTo20 > 0) {
      const step = Math.min(distTo20, 6);
      await emitAck(A, 'player:skill-card', { movement: step, playerId: 1 });
      await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });
      distTo20 -= step;
    }

    state = await syncState(A);
    check('Alice reached tile 20 (REST HOUSE)', playerIn(state, 1).position === 20);

    const aliceBeforeCollect = playerIn(state, 1).money;
    const restAck = await emitAck(A, 'rest-house:resolve', {
      playerId: 1,
      actionId: newActionId(),
    });
    check('Alice collects the $100 tax pot at REST HOUSE',
      restAck && restAck.ok && restAck.payout === 100 && restAck.pot === 0 && restAck.money === aliceBeforeCollect + 100);

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
