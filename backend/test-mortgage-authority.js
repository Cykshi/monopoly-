// Focused PROPERTY MORTGAGE & UNMORTGAGE AUTHORITY test suite.
// Regression tests for BUG-05:
// - Distinguish mortgage from permanent property liquidation.
// - Mortgage must retain property ownership.
// - Mortgaged properties must not collect rent (server & client).
// - Authoritative mortgage value (50% price) and unmortgage cost (mortgage value + 10% interest).
// - Enforce valid ownership, turn authority, affordability, and replay protection.
// - Ensure mortgaged properties cannot be built upon.
// - Existing houses/hotels must be sold before mortgaging (both on property and color group).
// - Persist and synchronize mortgage status across reconnects and server restarts.
// - Preserve mortgage status across trades.

const { io } = require('socket.io-client');
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
// PART 1: PURE UNIT TESTS FOR BOARD MORTGAGE, UNMORTGAGE & RENT SUPPRESSION
// ============================================================================
console.log('\n=== 1. PURE UNIT TESTS: MORTGAGE RULES ===');

// 1. Authoritative Mortgage Values
{
  // Tile 1 (Dhaka, $60)
  check('Tile 1 (Dhaka, $60) mortgage value is $30',
    board.mortgageValue(1) === 30);
  // Tile 26 (Chittagong, $380)
  check('Tile 26 (Chittagong, $380) mortgage value is $190',
    board.mortgageValue(26) === 190);
  // Airport tile 5 ($160)
  check('Airport (tile 5, $160) mortgage value is $80',
    board.mortgageValue(5) === 80);
  // Non-ownable tile (START: 0, JAIL: 10, TAX: 4, CHANCE: 7)
  check('Non-ownable tile 0 returns null for mortgage value',
    board.mortgageValue(0) === null);
  check('Non-ownable tile 10 returns null for mortgage value',
    board.mortgageValue(10) === null);
}

// 2. Authoritative Unmortgage Costs (mortgage value + 10% interest)
{
  // Tile 1: mortgage 30 + 10% (3) = 33
  check('Tile 1 unmortgage cost is $33 (30 + 10%)',
    board.unmortgageCost(1) === 33);
  // Tile 5: mortgage 80 + 10% (8) = 88
  check('Tile 5 unmortgage cost is $88 (80 + 10%)',
    board.unmortgageCost(5) === 88);
  // Non-ownable tile returns null
  check('Non-ownable tile 0 returns null for unmortgage cost',
    board.unmortgageCost(0) === null);
}

// 3. Rent suppression on mortgaged property
{
  const ownership = { 1: 1, 26: 1 };
  const houses = { 1: 0, 26: 0 };

  // When unmortgaged, calculateRent returns base rent ($10 for Dhaka)
  const rentUnmortgaged = board.calculateRent(1, 1, ownership, houses, {});
  check('Unmortgaged property calculates regular rent ($10)',
    rentUnmortgaged === 10);

  const chargeUnmortgaged = board.landingCharge(1, 2, ownership, houses, {});
  check('Unmortgaged property landingCharge is active ($10 rent due)',
    chargeUnmortgaged && chargeUnmortgaged.amount === 10 && chargeUnmortgaged.kind === 'rent');

  // When mortgaged, calculateRent returns 0 and landingCharge returns null
  const mortgagedMap = { 1: true };
  const rentMortgaged = board.calculateRent(1, 1, ownership, houses, mortgagedMap);
  check('Mortgaged property calculateRent returns 0',
    rentMortgaged === 0);

  const chargeMortgaged = board.landingCharge(1, 2, ownership, houses, mortgagedMap);
  check('Mortgaged property landingCharge returns null (no rent due)',
    chargeMortgaged === null);

  // Unmortgaged sister property in the same group still calculates rent ($120 for Chittagong)
  const rentSister = board.calculateRent(26, 1, ownership, houses, mortgagedMap);
  check('Unmortgaged sister property (tile 26) still calculates rent ($120)',
    rentSister === 120);
}

// 4. Group mortgage check
{
  check('groupHasMortgage returns false when none mortgaged',
    board.groupHasMortgage({}, 'bangladesh') === false);
  check('groupHasMortgage returns true when tile 1 is mortgaged in bangladesh group',
    board.groupHasMortgage({ 1: true }, 'bangladesh') === true);
  check('groupHasMortgage returns false for uk group when tile 1 is mortgaged',
    board.groupHasMortgage({ 1: true }, 'uk') === false);
}

// 5. Card landing on mortgaged property suppresses rent
{
  const cards = require('./game/cards');
  const dummyRoom = {
    propertyOwnership: { 5: 1 },
    propertyHouses: {},
    propertyMortgaged: { 5: true },
    players: [{ id: 1, money: 1000 }, { id: 2, money: 1000 }],
    settings: { jailCollectsRent: true },
  };
  const landing = cards.resolveCardLanding(dummyRoom, dummyRoom.players[1], 5, { rentMultiplier: 2 });
  check('resolveCardLanding on mortgaged tile returns rent amount 0',
    landing && landing.type === 'rent' && landing.amount === 0 && landing.isMortgaged === true);

  // Unmortgaged property via card calculates regular rent
  const dummyUnmort = {
    propertyOwnership: { 5: 1 },
    propertyHouses: {},
    propertyMortgaged: {},
    players: [{ id: 1, money: 1000 }, { id: 2, money: 1000 }],
    settings: { jailCollectsRent: true },
  };
  const landingUnmort = cards.resolveCardLanding(dummyUnmort, dummyUnmort.players[1], 5, { rentMultiplier: 2 });
  check('resolveCardLanding on unmortgaged tile calculates rent with multiplier',
    landingUnmort && landingUnmort.type === 'rent' && landingUnmort.amount > 0);
}

// ============================================================================
// PART 2: LIVE SOCKET SERVER INTEGRATION TESTS
// ============================================================================
console.log('\n=== 2. LIVE SERVER INTEGRATION: BUG-05 REGRESSION SUITE ===');

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
  actionId: `mort-act-${Date.now()}-${++actionCounter}`,
});
const emitAction = (socket, event, payload, ms = 2500) =>
  emitAck(socket, event, withAction(payload), ms);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readState = (socket) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 1500);
    socket.once('game:sync', (s) => {
      clearTimeout(t);
      resolve(s);
    });
    socket.emit('game:request-sync', {});
  });

const waitFor = (socket, event, ms = 3000) =>
  new Promise((resolve) => {
    const t = setTimeout(() => { socket.off(event, on); resolve(null); }, ms);
    const on = (d) => { clearTimeout(t); socket.off(event, on); resolve(d); };
    socket.once(event, on);
  });

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
  await sleep(250);
};

(async () => {
  let roomId = null;
  try {
    // -------------------------------------------------------------------------
    // SETUP: Room with Alice (Player 1) and Bob (Player 2)
    // -------------------------------------------------------------------------
    console.log('\n--- SETUP ROOM ---');
    const A = track(await connect());
    const created = await emitAck(A, 'room:create', { name: 'Alice' });
    roomId = created.roomId;
    const tokenA = created.token;

    const B = track(await connect());
    const bJoin = await emitAck(B, 'room:join', { roomId, name: 'Bob' });
    const tokenB = bJoin.token;

    await emitAck(A, 'player:identify', { roomId, token: tokenA, playerId: 1 });
    await emitAck(B, 'player:identify', { roomId, token: tokenB, playerId: 2 });

    // Start game: Player 1 rolls non-doubles
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [1, 2] });
    await emitAction(A, 'player:moved', { playerId: 1 }); // tile 3 (TREASURE)
    await emitAck(A, 'turn:ended', { playerId: 1 });

    // Helper to acquire a property for a player via auction
    const acquireTile = async (client, playerId, tileId) => {
      const aucId = `auc-mort-${tileId}-${Date.now()}`;
      await emitAck(client, 'auction:start', { playerId, auction: { id: aucId, tileId } });
      await emitAck(client, 'auction:bid', { auction: { id: aucId, tileId, currentBid: 10 } });
      await emitAck(client, 'auction:end', { auction: { id: aucId }, actionId: `act-auc-${Date.now()}` });
    };

    // End Bob's turn so Alice is on turn
    await emitAck(B, 'turn:ended', { playerId: 2 });

    // Alice acquires tile 1 (Dhaka, $60)
    await acquireTile(A, 1, 1);
    let state = await readState(A);
    check('Alice owns tile 1', state.propertyOwnership[1] === 1);

    // -------------------------------------------------------------------------
    // SCENARIO 1: MORTGAGE PROPERTY RETAINS OWNERSHIP & CREDITS VALUE
    // -------------------------------------------------------------------------
    console.log('\n--- 1. MORTGAGE PROPERTY RETAINS OWNERSHIP & CREDITS VALUE ---');
    const aliceCashPreMort = state.players.find(p => p.id === 1).money;
    const peerMortgageSpy = waitFor(B, 'property:mortgaged');

    const mortAck = await emitAction(A, 'property:mortgaged', {
      tileId: 1,
      playerId: 1,
    });
    check('Alice mortgages tile 1 successfully',
      !!(mortAck && mortAck.ok === true && mortAck.mortgageValue === 30 && mortAck.isMortgaged === true),
      JSON.stringify(mortAck));

    // Verify peer received the broadcast
    const peerEvent = await peerMortgageSpy;
    check('Bob received property:mortgaged broadcast with tileId=1, mortgageValue=30',
      !!(peerEvent && peerEvent.tileId === 1 && peerEvent.mortgageValue === 30));

    state = await readState(A);
    check('Alice RETAINS ownership of tile 1 after mortgaging',
      state.propertyOwnership[1] === 1);
    check('Server records tile 1 as mortgaged (propertyMortgaged[1] is true)',
      state.propertyMortgaged && state.propertyMortgaged[1] === true);
    check('Alice balance credited by exact authoritative mortgage value ($30)',
      state.players.find(p => p.id === 1).money === aliceCashPreMort + 30);

    // Cannot mortgage an already mortgaged property
    const dupMort = await emitAction(A, 'property:mortgaged', {
      tileId: 1,
      playerId: 1,
    });
    check('Mortgaging already mortgaged property rejected with ALREADY_MORTGAGED',
      !!(dupMort && dupMort.ok === false && dupMort.code === 'ALREADY_MORTGAGED'),
      JSON.stringify(dupMort));

    // -------------------------------------------------------------------------
    // SCENARIO 2: MORTGAGED PROPERTIES MUST NOT COLLECT RENT
    // -------------------------------------------------------------------------
    console.log('\n--- 2. MORTGAGED PROPERTIES SUPPRESS RENT ---');
    // Hand turn to Bob. Walk Bob to tile 1 so he is standing on it!
    await emitAck(A, 'turn:ended', { playerId: 1 });

    // Bob rolls 1 to land on tile 1 (starts at 0)
    await emitAck(B, 'player:rolled', { playerId: 2, _testForcedDice: [0, 1] });
    await emitAction(B, 'player:moved', { playerId: 2 });
    check('Bob moved to tile 1', (await readState(B)).players.find(p => p.id === 2).position === 1);

    const bobCashPreRent = (await readState(B)).players.find(p => p.id === 2).money;
    const aliceCashPreRent = (await readState(A)).players.find(p => p.id === 1).money;

    // Bob attempts to pay rent on Alice's mortgaged tile 1
    const rentAttempt = await emitAction(B, 'rent:paid', {
      payerId: 2,
      ownerId: 1,
      tileId: 1,
    });
    check('Rent payment on mortgaged property rejected with PROPERTY_MORTGAGED or NO_RENT_DUE',
      !!(rentAttempt && rentAttempt.ok === false &&
         (rentAttempt.code === 'PROPERTY_MORTGAGED' || rentAttempt.code === 'NO_RENT_DUE')),
      JSON.stringify(rentAttempt));

    state = await readState(A);
    check('Bob cash unchanged after suppressed rent attempt',
      state.players.find(p => p.id === 2).money === bobCashPreRent);
    check('Alice cash unchanged after suppressed rent attempt',
      state.players.find(p => p.id === 1).money === aliceCashPreRent);

    // -------------------------------------------------------------------------
    // SCENARIO 3: MORTGAGED PROPERTIES CANNOT BE BUILT UPON
    // -------------------------------------------------------------------------
    console.log('\n--- 3. MORTGAGED PROPERTIES CANNOT BE BUILT UPON ---');
    // Hand turn back to Alice. Alice acquires tile 26 so she has the color group.
    await emitAck(B, 'turn:ended', { playerId: 2 });
    await acquireTile(A, 1, 26);

    // Alice attempts to build on mortgaged tile 1
    const buildOnMortgaged = await emitAction(A, 'house:upgraded', {
      tileId: 1,
      houses: 1,
      playerId: 1,
    });
    check('Building on mortgaged property rejected with PROPERTY_MORTGAGED',
      !!(buildOnMortgaged && buildOnMortgaged.ok === false && buildOnMortgaged.code === 'PROPERTY_MORTGAGED'),
      JSON.stringify(buildOnMortgaged));

    // Alice attempts to build on unmortgaged sister tile 26 while tile 1 is mortgaged
    const buildSister = await emitAction(A, 'house:upgraded', {
      tileId: 26,
      houses: 1,
      playerId: 1,
    });
    check('Building on unmortgaged tile while group has mortgaged tile rejected with GROUP_HAS_MORTGAGE',
      !!(buildSister && buildSister.ok === false && buildSister.code === 'GROUP_HAS_MORTGAGE'),
      JSON.stringify(buildSister));

    state = await readState(A);
    check('No houses built on either tile',
      (state.propertyHouses[1] || 0) === 0 && (state.propertyHouses[26] || 0) === 0);

    // -------------------------------------------------------------------------
    // SCENARIO 4: UNMORTGAGING RESTORES RENT AND BUILDING
    // -------------------------------------------------------------------------
    console.log('\n--- 4. UNMORTGAGING RESTORES RENT AND BUILDING ---');
    const aliceCashPreUnmort = state.players.find(p => p.id === 1).money;
    const peerUnmortgageSpy = waitFor(B, 'property:unmortgaged');

    // Alice unmortgages tile 1 (cost: $30 + 10% = $33)
    const unmortAck = await emitAction(A, 'property:unmortgaged', {
      tileId: 1,
      playerId: 1,
    });
    check('Alice unmortgages tile 1 successfully',
      !!(unmortAck && unmortAck.ok === true && unmortAck.unmortgageCost === 33 && unmortAck.isMortgaged === false),
      JSON.stringify(unmortAck));

    // Verify peer received unmortgage broadcast
    const unmortPeerEvt = await peerUnmortgageSpy;
    check('Bob received property:unmortgaged broadcast with tileId=1, unmortgageCost=33',
      !!(unmortPeerEvt && unmortPeerEvt.tileId === 1 && unmortPeerEvt.unmortgageCost === 33));

    state = await readState(A);
    check('Server records tile 1 is no longer mortgaged',
      !state.propertyMortgaged || !state.propertyMortgaged[1]);
    check('Alice debited authoritative unmortgage cost ($33)',
      state.players.find(p => p.id === 1).money === aliceCashPreUnmort - 33);

    // Unmortgaging an unmortgaged property rejected with NOT_MORTGAGED
    const dupUnmort = await emitAction(A, 'property:unmortgaged', {
      tileId: 1,
      playerId: 1,
    });
    check('Unmortgaging unmortgaged property rejected with NOT_MORTGAGED',
      !!(dupUnmort && dupUnmort.ok === false && dupUnmort.code === 'NOT_MORTGAGED'),
      JSON.stringify(dupUnmort));

    // Building is now allowed again
    const buildAllowed = await emitAction(A, 'house:upgraded', {
      tileId: 1,
      houses: 1,
      playerId: 1,
    });
    check('Building on tile 1 now succeeds after unmortgaging',
      !!(buildAllowed && buildAllowed.ok === true && buildAllowed.houses === 1));

    // -------------------------------------------------------------------------
    // SCENARIO 5: BUILDINGS MUST BE SOLD BEFORE MORTGAGING
    // -------------------------------------------------------------------------
    console.log('\n--- 5. BUILDINGS MUST BE SOLD BEFORE MORTGAGING ---');
    // Tile 1 now has 1 house. Mortgaging tile 1 or tile 26 must be rejected!
    const mortWithHouse = await emitAction(A, 'property:mortgaged', {
      tileId: 1,
      playerId: 1,
    });
    check('Mortgage rejected when tile has houses (HAS_HOUSES)',
      !!(mortWithHouse && mortWithHouse.ok === false && mortWithHouse.code === 'HAS_HOUSES'),
      JSON.stringify(mortWithHouse));

    const mortSisterWithHouse = await emitAction(A, 'property:mortgaged', {
      tileId: 26,
      playerId: 1,
    });
    check('Mortgage rejected when color group has houses (HAS_HOUSES)',
      !!(mortSisterWithHouse && mortSisterWithHouse.ok === false && mortSisterWithHouse.code === 'HAS_HOUSES'),
      JSON.stringify(mortSisterWithHouse));

    // Sell the house on tile 1
    const sellHouse = await emitAction(A, 'house:sold', { tileId: 1, playerId: 1 });
    check('Alice sells house on tile 1 successfully', !!(sellHouse && sellHouse.ok));

    // Now mortgaging tile 1 succeeds
    const mortAgain = await emitAction(A, 'property:mortgaged', { tileId: 1, playerId: 1 });
    check('Mortgaging tile 1 succeeds once houses are cleared', !!(mortAgain && mortAgain.ok));

    // -------------------------------------------------------------------------
    // SCENARIO 6: INSUFFICIENT FUNDS ON UNMORTGAGE
    // -------------------------------------------------------------------------
    console.log('\n--- 6. INSUFFICIENT FUNDS ON UNMORTGAGE ---');
    state = await readState(A);
    const aliceBal = state.players.find(p => p.id === 1).money;
    const drainVal = Math.max(0, aliceBal - 10); // leave Alice with $10 (unmortgage costs $33)

    const drainTrade = {
      id: `drain-mort-${Date.now()}`,
      initiatorId: 1,
      targetId: 2,
      initiatorPropertyIds: [],
      targetPropertyIds: [],
      initiatorMoney: drainVal,
      targetMoney: 0,
    };
    await emitAck(A, 'trade:created', drainTrade);
    await emitAck(B, 'trade:accepted', { trade: drainTrade, actionId: `trade-act-${Date.now()}` });

    state = await readState(A);
    check('Alice funds drained to $10 (cannot afford $33 unmortgage cost)',
      state.players.find(p => p.id === 1).money === 10);

    const rejectNoFunds = await emitAction(A, 'property:unmortgaged', {
      tileId: 1,
      playerId: 1,
    });
    check('Unmortgaging with insufficient funds rejected with INSUFFICIENT_FUNDS',
      !!(rejectNoFunds && rejectNoFunds.ok === false && rejectNoFunds.code === 'INSUFFICIENT_FUNDS'),
      JSON.stringify(rejectNoFunds));

    state = await readState(A);
    check('Tile 1 remains mortgaged after failed unmortgage',
      state.propertyMortgaged && state.propertyMortgaged[1] === true);
    check('Alice money remains $10',
      state.players.find(p => p.id === 1).money === 10);

    // -------------------------------------------------------------------------
    // SCENARIO 7: INVALID REQUESTS, NON-OWNER & OUT-OF-TURN REJECTION
    // -------------------------------------------------------------------------
    console.log('\n--- 7. INVALID REQUESTS & AUTHORITY ---');
    // Hand turn to Bob
    await emitAck(A, 'turn:ended', { playerId: 1 });

    // Bob tries to mortgage Alice's property
    const bobMortAlice = await emitAction(B, 'property:mortgaged', {
      tileId: 26,
      playerId: 2,
    });
    check('Non-owner cannot mortgage another player\'s property (NOT_OWNER)',
      !!(bobMortAlice && bobMortAlice.ok === false && bobMortAlice.code === 'NOT_OWNER'),
      JSON.stringify(bobMortAlice));

    // Alice tries to act out-of-turn
    const aliceOutOfTurn = await emitAction(A, 'property:mortgaged', {
      tileId: 26,
      playerId: 1,
    });
    check('Out-of-turn mortgage request rejected with NOT_YOUR_TURN',
      !!(aliceOutOfTurn && aliceOutOfTurn.ok === false && aliceOutOfTurn.code === 'NOT_YOUR_TURN'),
      JSON.stringify(aliceOutOfTurn));

    // Bob tries to mortgage non-ownable tile (START: 0)
    const mortNonOwnable = await emitAction(B, 'property:mortgaged', {
      tileId: 0,
      playerId: 2,
    });
    check('Mortgage non-ownable tile rejected with BAD_TILE',
      !!(mortNonOwnable && mortNonOwnable.ok === false && mortNonOwnable.code === 'BAD_TILE'),
      JSON.stringify(mortNonOwnable));

    // -------------------------------------------------------------------------
    // SCENARIO 8: REPLAY PROTECTION
    // -------------------------------------------------------------------------
    console.log('\n--- 8. REPLAY PROTECTION ---');
    // Hand turn back to Alice, give funds back
    await emitAck(B, 'turn:ended', { playerId: 2 });
    const refundTrade = {
      id: `refund-mort-${Date.now()}`,
      initiatorId: 2,
      targetId: 1,
      initiatorPropertyIds: [],
      targetPropertyIds: [],
      initiatorMoney: 200,
      targetMoney: 0,
    };
    await emitAck(B, 'trade:created', refundTrade);
    await emitAck(A, 'trade:accepted', { trade: refundTrade, actionId: `trade-act-${Date.now()}` });

    // Mortgaging tile 26 with unique actionId
    const repActId = `replay-mort-${Date.now()}`;
    const mort26 = await emitAck(A, 'property:mortgaged', {
      tileId: 26,
      playerId: 1,
      actionId: repActId,
    });
    check('Initial mortgage of tile 26 succeeds', !!(mort26 && mort26.ok));

    const balAfterMort26 = (await readState(A)).players.find(p => p.id === 1).money;

    // Replay with identical actionId
    const mortReplay = await emitAck(A, 'property:mortgaged', {
      tileId: 26,
      playerId: 1,
      actionId: repActId,
    });
    check('Replayed property:mortgaged rejected with DUPLICATE_ACTION',
      !!(mortReplay && mortReplay.ok === false && mortReplay.code === 'DUPLICATE_ACTION'),
      JSON.stringify(mortReplay));

    state = await readState(A);
    check('Player money was NOT credited a second time on replay',
      state.players.find(p => p.id === 1).money === balAfterMort26);

    // -------------------------------------------------------------------------
    // SCENARIO 9: MORTGAGE PRESERVATION ACROSS TRADES
    // -------------------------------------------------------------------------
    console.log('\n--- 9. MORTGAGE PRESERVATION ACROSS TRADES ---');
    // Alice trades mortgaged tile 26 to Bob
    const propTrade = {
      id: `prop-trade-mort-${Date.now()}`,
      initiatorId: 1,
      targetId: 2,
      initiatorPropertyIds: [26],
      targetPropertyIds: [],
      initiatorMoney: 0,
      targetMoney: 0,
    };
    await emitAck(A, 'trade:created', propTrade);
    await emitAck(B, 'trade:accepted', { trade: propTrade, actionId: `trade-act-${Date.now()}` });

    state = await readState(A);
    check('Bob now owns tile 26 after trade',
      state.propertyOwnership[26] === 2);
    check('Tile 26 REMAINS mortgaged after trade transfer to Bob',
      state.propertyMortgaged && state.propertyMortgaged[26] === true);

    // -------------------------------------------------------------------------
    // SCENARIO 10: STATE PERSISTENCE & SYNCHRONIZATION
    // -------------------------------------------------------------------------
    console.log('\n--- 10. STATE PERSISTENCE & SYNCHRONIZATION ---');
    const syncA = await readState(A);
    const syncB = await readState(B);

    check('Both Alice and Bob observe identical propertyMortgaged state',
      syncA.propertyMortgaged[1] === true &&
      syncA.propertyMortgaged[26] === true &&
      syncB.propertyMortgaged[1] === true &&
      syncB.propertyMortgaged[26] === true);

    // Reconnection recovers authoritative mortgage state
    const A2 = track(await connect());
    const rejoinA = await emitAck(A2, 'player:rejoin', { roomId, token: tokenA });
    check('Reconnecting player recovers authoritative propertyMortgaged state',
      rejoinA && rejoinA.ok &&
      rejoinA.playerState.propertyMortgaged &&
      rejoinA.playerState.propertyMortgaged[1] === true);

    // -------------------------------------------------------------------------
    // SCENARIO 11: IN-FLIGHT TRADE INVALIDATION ON MORTGAGE STATUS CHANGE
    // -------------------------------------------------------------------------
    console.log('\n--- 11. IN-FLIGHT TRADE INVALIDATION ON MORTGAGE CHANGE ---');
    // Alice currently owns Tile 1 (mortgaged). Alice offers Tile 1 to Bob.
    // Give Alice enough money to cover unmortgaging later
    const refundTrade2 = {
      id: `refund-mort-2-${Date.now()}`,
      initiatorId: 2,
      targetId: 1,
      initiatorPropertyIds: [],
      targetPropertyIds: [],
      initiatorMoney: 100,
      targetMoney: 0,
    };
    await emitAck(B, 'trade:created', refundTrade2);
    await emitAck(A, 'trade:accepted', { trade: refundTrade2, actionId: `trade-act-ref-${Date.now()}` });

    const inFlightTrade = {
      id: `inflight-mort-${Date.now()}`,
      initiatorId: 1,
      targetId: 2,
      initiatorPropertyIds: [1],
      targetPropertyIds: [],
      initiatorMoney: 0,
      targetMoney: 0,
    };
    await emitAck(A, 'trade:created', inFlightTrade);

    // Bob sets up a listener for trade:cancelled
    const tradeCancelSpy = waitFor(B, 'trade:cancelled');

    // Alice unmortgages Tile 1 while the trade offer is in-flight!
    const unmortInFlight = await emitAction(A, 'property:unmortgaged', {
      tileId: 1,
      playerId: 1,
    });
    check('Alice unmortgages tile 1 successfully', !!(unmortInFlight && unmortInFlight.ok));

    // Bob should receive trade:cancelled broadcast because the offered property's mortgage status changed
    const cancelEvt = await tradeCancelSpy;
    check('In-flight trade is automatically cancelled when offered property mortgage changes',
      !!(cancelEvt && cancelEvt.tradeId === inFlightTrade.id && cancelEvt.reason === 'MORTGAGE_STATUS_CHANGED'));

    // Bob attempts to accept the stale in-flight trade
    const staleAccept = await emitAck(B, 'trade:accepted', {
      trade: inFlightTrade,
      actionId: `stale-trade-act-${Date.now()}`,
    });
    check('Accepting trade after mortgage status changed is rejected with TRADE_NOT_PENDING or TRADE_STALE',
      !!(staleAccept && staleAccept.ok === false &&
         (staleAccept.code === 'TRADE_NOT_PENDING' || staleAccept.code === 'TRADE_STALE')),
      JSON.stringify(staleAccept));

    state = await readState(A);
    check('Tile 1 ownership was NOT transferred to Bob on stale trade accept',
      state.propertyOwnership[1] === 1);

    // -------------------------------------------------------------------------
    // SCENARIO 12: CARD-DRIVEN MOVEMENT ON MORTGAGED PROPERTY SUPPRESSES RENT
    // -------------------------------------------------------------------------
    console.log('\n--- 12. CARD-DRIVEN MOVEMENT ON MORTGAGED PROPERTY SUPPRESSES RENT ---');
    // Alice acquires airport tile 5 and mortgages it
    await acquireTile(A, 1, 5);
    const mortAirport = await emitAction(A, 'property:mortgaged', {
      tileId: 5,
      playerId: 1,
    });
    check('Alice mortgages Airport (tile 5)', !!(mortAirport && mortAirport.ok));

    // Hand turn to Bob
    await emitAck(A, 'turn:ended', { playerId: 1 });

    // Bob rolls dice to land on Tile 3 (TREASURE): from tile 1, rolling 2 lands on tile 3
    await emitAck(B, 'player:rolled', { playerId: 2, _testForcedDice: [1, 1] });
    await emitAction(B, 'player:moved', { playerId: 2 }); // tile 3 (TREASURE)

    const bobBalBeforeCard = (await readState(B)).players.find(p => p.id === 2).money;
    const aliceBalBeforeCard = (await readState(A)).players.find(p => p.id === 1).money;

    // Bob draws a Treasure card with forced roll 5 (advances to nearest Airport: tile 5)
    const cardDrawRes = await emitAction(B, 'card:draw', {
      playerId: 2,
      _testForcedRoll: 5,
    });
    check('Bob advances to tile 5 via card',
      cardDrawRes && cardDrawRes.ok === true && cardDrawRes.position === 5,
      JSON.stringify(cardDrawRes));

    check('Landing effect on mortgaged airport specifies rent with amount 0 and isMortgaged true',
      cardDrawRes && cardDrawRes.landingEffect &&
      cardDrawRes.landingEffect.type === 'rent' &&
      cardDrawRes.landingEffect.amount === 0 &&
      cardDrawRes.landingEffect.isMortgaged === true,
      JSON.stringify(cardDrawRes?.landingEffect));

    state = await readState(A);
    check('Bob cash not deducted for rent on card landing on mortgaged property',
      state.players.find(p => p.id === 2).money === bobBalBeforeCard);
    check('Alice cash not credited for rent on mortgaged property',
      state.players.find(p => p.id === 1).money === aliceBalBeforeCard);

    // -------------------------------------------------------------------------
    // SCENARIO 13: BANK BANKRUPTCY CLEARS MORTGAGE STATUS
    // -------------------------------------------------------------------------
    console.log('\n--- 13. BANK BANKRUPTCY CLEARS MORTGAGE STATUS ---');
    // Bob owns tile 26, which is mortgaged
    check('Bob owns tile 26 and it is mortgaged before bankruptcy',
      state.propertyOwnership[26] === 2 && state.propertyMortgaged && state.propertyMortgaged[26] === true);

    // Bob declares voluntary bankruptcy (no creditor, properties revert to bank)
    const bankBob = await emitAck(B, 'player:bankrupt', {
      playerId: 2,
      actionId: `bankrupt-act-${Date.now()}`,
    });
    check('Bob voluntary bankruptcy accepted', !!(bankBob && bankBob.ok));

    state = await readState(A);
    check('Bob is marked bankrupt on server',
      state.players.find(p => p.id === 2)?.isBankrupt === true);
    check('Tile 26 ownership is released to bank (unowned)',
      state.propertyOwnership[26] === undefined);
    check('Tile 26 mortgage status is CLEARED upon return to bank',
      !state.propertyMortgaged || state.propertyMortgaged[26] === undefined);

  } catch (err) {
    check('unexpected test exception', false, err.stack || err.message);
  } finally {
    await cleanup(roomId);
  }

  console.log(`\n================================================================`);
  console.log(`TESTS: ${results.length} run, ${results.length - failed} passed, ${failed} failed`);
  console.log(`================================================================`);
  process.exit(failed > 0 ? 1 : 0);
})();
