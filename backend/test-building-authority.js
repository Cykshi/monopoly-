// Focused MONOPOLY OWNERSHIP & EVEN-BUILDING AUTHORITY test suite.
// Regression tests for BUG-04:
// - A player may build houses/hotels only if they own every property in that color group.
// - Enforce even-building rules server-side: cannot build if another property in the group has fewer houses.
// - Enforce valid house/hotel transitions (1 level at a time: 0->1, 1->2, 2->3, 3->4, 4->5).
// - Enforce available bank building supply (32 houses, 12 hotels).
// - Enforce property ownership, non-property tile rejection, and correct server building costs.
// - Enforce sufficient player cash (affordability check).
// - Reject forged, out-of-turn, invalid, or duplicate upgrade requests without state corruption.
// - Authoritative building state broadcasts to peers and persists across sync/rejoin.

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
// PART 1: PURE UNIT TESTS FOR BOARD MONOPOLY & BUILDING RULES
// ============================================================================
console.log('\n=== 1. PURE UNIT TESTS: MONOPOLY, EVEN-BUILDING, AND SUPPLY RULES ===');

// 1. Monopoly evaluation
{
  const emptyOwnership = {};
  check('hasMonopoly returns false when no properties owned',
    board.hasMonopoly(emptyOwnership, 1, 'bangladesh') === false);

  // Partial ownership: player 1 owns tile 1 (Dhaka) but tile 26 (Chittagong) is unowned
  const partialOwnership = { 1: 1 };
  check('hasMonopoly returns false for partial group ownership (1 of 2 Bangladesh tiles)',
    board.hasMonopoly(partialOwnership, 1, 'bangladesh') === false);

  // Split ownership: player 1 owns tile 1, player 2 owns tile 26
  const splitOwnership = { 1: 1, 26: 2 };
  check('hasMonopoly returns false when group is split between players',
    board.hasMonopoly(splitOwnership, 1, 'bangladesh') === false);

  // Complete 2-tile monopoly: player 1 owns 1 and 26
  const fullBangladesh = { 1: 1, 26: 1 };
  check('hasMonopoly returns true when player owns all tiles in 2-property group (Bangladesh)',
    board.hasMonopoly(fullBangladesh, 1, 'bangladesh') === true);

  // Complete 3-tile monopoly: player 1 owns 11, 22, 36 (UK group)
  const partialUK = { 11: 1, 22: 1 };
  check('hasMonopoly returns false for 2 of 3 UK tiles',
    board.hasMonopoly(partialUK, 1, 'uk') === false);

  const fullUK = { 11: 1, 22: 1, 36: 1 };
  check('hasMonopoly returns true when player owns all 3 UK tiles (11, 22, 36)',
    board.hasMonopoly(fullUK, 1, 'uk') === true);

  // Non-property types have no monopoly building
  check('hasMonopoly returns false for airport type',
    board.hasMonopoly({ 5: 1, 15: 1, 25: 1, 35: 1 }, 1, 'airport') === false);
}

// 2. Even-building evaluation
{
  // 2-tile group: Bangladesh (tiles 1 and 26)
  const housesEmpty = {};
  check('canBuildEvenly allows building on tile 1 when both have 0 houses',
    board.canBuildEvenly(housesEmpty, 1, 'bangladesh') === true);
  check('canBuildEvenly allows building on tile 26 when both have 0 houses',
    board.canBuildEvenly(housesEmpty, 26, 'bangladesh') === true);

  // Tile 1 has 1 house, Tile 26 has 0 houses
  const houses1on1 = { 1: 1, 26: 0 };
  check('canBuildEvenly REJECTS building on tile 1 when tile 26 has fewer houses (1 vs 0)',
    board.canBuildEvenly(houses1on1, 1, 'bangladesh') === false);
  check('canBuildEvenly ALLOWS building on tile 26 when tile 1 has 1 house (catching up)',
    board.canBuildEvenly(houses1on1, 26, 'bangladesh') === true);

  // Both have 1 house
  const houses1Both = { 1: 1, 26: 1 };
  check('canBuildEvenly allows building on tile 1 when both have 1 house',
    board.canBuildEvenly(houses1Both, 1, 'bangladesh') === true);
  check('canBuildEvenly allows building on tile 26 when both have 1 house',
    board.canBuildEvenly(houses1Both, 26, 'bangladesh') === true);

  // 3-tile group: UK (tiles 11, 22, 36)
  // 11 has 2, 22 has 1, 36 has 1
  const housesUK = { 11: 2, 22: 1, 36: 1 };
  check('canBuildEvenly rejects building on tile 11 when 22 and 36 have 1 house',
    board.canBuildEvenly(housesUK, 11, 'uk') === false);
  check('canBuildEvenly allows building on tile 22 when 36 has 1 house',
    board.canBuildEvenly(housesUK, 22, 'uk') === true);
  check('canBuildEvenly allows building on tile 36 when 22 has 1 house',
    board.canBuildEvenly(housesUK, 36, 'uk') === true);
}

// 3. Bank building supply evaluation
{
  const emptyHouses = {};
  const supplyInit = board.getBankBuildingSupply(emptyHouses);
  check('Initial bank supply has 32 houses and 12 hotels',
    supplyInit.availableHouses === 32 && supplyInit.availableHotels === 12);

  // 8 houses on board across various properties
  const someHouses = { 1: 3, 26: 3, 11: 2 }; // total 8 houses
  const supplySome = board.getBankBuildingSupply(someHouses);
  check('Supply reflects houses in use (32 - 8 = 24 available)',
    supplySome.availableHouses === 24 && supplySome.housesInUse === 8 && supplySome.availableHotels === 12);

  // 2 hotels on board (level 5), 4 houses on another property
  const someHotels = { 1: 5, 26: 5, 11: 4 }; // 2 hotels, 4 houses
  const supplyHotels = board.getBankBuildingSupply(someHotels);
  check('Supply reflects hotels in use (12 - 2 = 10 available, 4 houses in use)',
    supplyHotels.availableHotels === 10 && supplyHotels.hotelsInUse === 2 && supplyHotels.availableHouses === 28);
}

// 4. Building costs from board table
{
  // Tile 1 (Dhaka): houseCost 50, hotelCost 50
  check('Tile 1 buildCost for house levels 0..3 is $50',
    board.buildCost(1, 0) === 50 && board.buildCost(1, 1) === 50 && board.buildCost(1, 2) === 50 && board.buildCost(1, 3) === 50);
  check('Tile 1 buildCost for hotel level (4->5) is $50',
    board.buildCost(1, 4) === 50);
  check('Tile 1 buildCost for already maxed (5) is null',
    board.buildCost(1, 5) === null);

  // Airport (utility) cannot be built on
  check('Airport (tile 5) buildCost returns null',
    board.buildCost(5, 0) === null);
}

// ============================================================================
// PART 2: LIVE SOCKET SERVER INTEGRATION TESTS
// ============================================================================
console.log('\n=== 2. LIVE SERVER INTEGRATION: BUG-04 REGRESSION SUITE ===');

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
  actionId: `build-act-${Date.now()}-${++actionCounter}`,
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

    // Helper to acquire a property for Player 1 via auction
    const acquireTile = async (client, playerId, tileId) => {
      const aucId = `auc-build-${tileId}-${Date.now()}`;
      await emitAck(client, 'auction:start', { playerId, auction: { id: aucId, tileId } });
      await emitAck(client, 'auction:bid', { auction: { id: aucId, tileId, currentBid: 10 } });
      await emitAck(client, 'auction:end', { auction: { id: aucId }, actionId: `act-auc-${Date.now()}` });
    };

    // -------------------------------------------------------------------------
    // SCENARIO 1: PARTIAL MONOPOLY REJECTION
    // Alice acquires tile 1 (Dhaka), but does NOT own tile 26 (Chittagong).
    // Attempts to upgrade tile 1 must be rejected with NOT_MONOPOLY.
    // -------------------------------------------------------------------------
    console.log('\n--- 1. PARTIAL MONOPOLY BUILDING REJECTION ---');
    // It's Bob's turn, end it so it's Alice's turn
    await emitAck(B, 'turn:ended', { playerId: 2 });

    // Alice acquires tile 1 (Dhaka)
    await acquireTile(A, 1, 1);
    let state = await readState(A);
    check('Alice owns tile 1 (Dhaka)', state.propertyOwnership[1] === 1);
    check('Tile 26 (Chittagong) is unowned', state.propertyOwnership[26] === undefined);

    const aliceCashBeforeBuild = state.players.find(p => p.id === 1).money;

    // Alice attempts to build on tile 1 without owning tile 26
    const rejectNoMonopoly = await emitAction(A, 'house:upgraded', {
      tileId: 1,
      houses: 1,
      playerId: 1,
    });
    check('build without full group monopoly is REJECTED with NOT_MONOPOLY',
      !!(rejectNoMonopoly && rejectNoMonopoly.ok === false && rejectNoMonopoly.code === 'NOT_MONOPOLY'),
      JSON.stringify(rejectNoMonopoly));

    // Assert NO game state corruption
    state = await readState(A);
    check('No houses were placed on tile 1 after rejection',
      (state.propertyHouses[1] || 0) === 0);
    check('Alice money is unchanged after rejection',
      state.players.find(p => p.id === 1).money === aliceCashBeforeBuild);

    // -------------------------------------------------------------------------
    // SCENARIO 2: FULL MONOPOLY VALID UPGRADE (0 -> 1)
    // Alice acquires tile 26 completing the Bangladesh monopoly.
    // Building 1 house on tile 1 succeeds, debits authoritative cost ($50).
    // -------------------------------------------------------------------------
    console.log('\n--- 2. VALID MONOPOLY UPGRADE (LEVEL 1) ---');
    await acquireTile(A, 1, 26);
    state = await readState(A);
    check('Alice owns both Bangladesh tiles (1 and 26) - Monopoly complete',
      state.propertyOwnership[1] === 1 && state.propertyOwnership[26] === 1);

    const aliceCashPreBuild = state.players.find(p => p.id === 1).money;
    const guestHouseSpy = waitFor(B, 'house:upgraded');

    // Alice builds 1 house on tile 1 (cost $50)
    const build1Ack = await emitAction(A, 'house:upgraded', {
      tileId: 1,
      houses: 1,
      playerId: 1,
    });
    check('Valid build of 1 house on tile 1 succeeds',
      !!(build1Ack && build1Ack.ok === true && build1Ack.houses === 1 && build1Ack.cost === 50),
      JSON.stringify(build1Ack));

    // Verify broadcast received by guest
    const guestEvent = await guestHouseSpy;
    check('Guest received house:upgraded broadcast with houses=1 and cost=50',
      !!(guestEvent && guestEvent.tileId === 1 && guestEvent.houses === 1 && guestEvent.cost === 50));

    // Verify authoritative state and cash deduction
    state = await readState(A);
    check('Server records 1 house on tile 1', state.propertyHouses[1] === 1);
    check('Alice money debited by exactly authoritative cost ($50)',
      state.players.find(p => p.id === 1).money === aliceCashPreBuild - 50);

    // -------------------------------------------------------------------------
    // SCENARIO 3: UNEVEN BUILDING REJECTION
    // Tile 1 has 1 house, tile 26 has 0 houses.
    // Building a 2nd house on tile 1 must be rejected with UNEVEN_BUILDING.
    // -------------------------------------------------------------------------
    console.log('\n--- 3. UNEVEN BUILDING REJECTION ---');
    const cashBeforeUneven = state.players.find(p => p.id === 1).money;

    const rejectUneven = await emitAction(A, 'house:upgraded', {
      tileId: 1,
      houses: 2,
      playerId: 1,
    });
    check('Attempt to build 2nd house on tile 1 while tile 26 has 0 is REJECTED with UNEVEN_BUILDING',
      !!(rejectUneven && rejectUneven.ok === false && rejectUneven.code === 'UNEVEN_BUILDING'),
      JSON.stringify(rejectUneven));

    state = await readState(A);
    check('Tile 1 house count remains 1 after uneven build rejection',
      state.propertyHouses[1] === 1);
    check('Alice cash unchanged after uneven build rejection',
      state.players.find(p => p.id === 1).money === cashBeforeUneven);

    // -------------------------------------------------------------------------
    // SCENARIO 4: EVEN-BUILDING TRANSITIONS UP TO HOTELS
    // Build evenly:
    // 1. Build tile 26 to 1 house (both now have 1)
    // 2. Build tile 1 to 2 houses, then tile 26 to 2 houses
    // 3. Build tile 1 to 3 houses, then tile 26 to 3 houses
    // 4. Build tile 1 to 4 houses, then tile 26 to 4 houses
    // -------------------------------------------------------------------------
    console.log('\n--- 4. EVEN BUILDING TRANSITIONS ---');
    // Build tile 26 to 1 house
    const build26_1 = await emitAction(A, 'house:upgraded', { tileId: 26, houses: 1, playerId: 1 });
    check('Build 1st house on tile 26 succeeds (catching up)', !!(build26_1 && build26_1.ok));

    // Build levels 2, 3, 4 evenly
    for (let lvl = 2; lvl <= 4; lvl++) {
      const b1 = await emitAction(A, 'house:upgraded', { tileId: 1, houses: lvl, playerId: 1 });
      check(`Build level ${lvl} on tile 1 succeeds`, !!(b1 && b1.ok && b1.houses === lvl));
      const b26 = await emitAction(A, 'house:upgraded', { tileId: 26, houses: lvl, playerId: 1 });
      check(`Build level ${lvl} on tile 26 succeeds`, !!(b26 && b26.ok && b26.houses === lvl));
    }

    state = await readState(A);
    check('Both Bangladesh properties now have exactly 4 houses',
      state.propertyHouses[1] === 4 && state.propertyHouses[26] === 4);

    // -------------------------------------------------------------------------
    // SCENARIO 5: INVALID MULTI-LEVEL JUMP REJECTION
    // Cannot skip levels (e.g. from 4 directly to an illegal level)
    // -------------------------------------------------------------------------
    console.log('\n--- 5. INVALID TRANSITIONS REJECTION ---');
    // Attempt to set houses=2 on tile 1 (downgrade via house:upgraded)
    const rejectDowngrade = await emitAction(A, 'house:upgraded', { tileId: 1, houses: 2, playerId: 1 });
    check('Downgrade via house:upgraded rejected with BAD_BUILD',
      !!(rejectDowngrade && rejectDowngrade.ok === false && rejectDowngrade.code === 'BAD_BUILD'));

    // Attempt to jump beyond hotel (houses=6)
    const rejectBeyondMax = await emitAction(A, 'house:upgraded', { tileId: 1, houses: 6, playerId: 1 });
    check('Houses count > 5 rejected with BAD_HOUSE_COUNT',
      !!(rejectBeyondMax && rejectBeyondMax.ok === false && rejectBeyondMax.code === 'BAD_HOUSE_COUNT'));

    // -------------------------------------------------------------------------
    // SCENARIO 6: HOTEL UPGRADE (LEVEL 4 -> 5)
    // Upgrade tile 1 to hotel (houses=5).
    // -------------------------------------------------------------------------
    console.log('\n--- 6. HOTEL UPGRADE (4 -> 5) ---');
    const cashBeforeHotel = (await readState(A)).players.find(p => p.id === 1).money;

    const buildHotel = await emitAction(A, 'house:upgraded', { tileId: 1, houses: 5, playerId: 1 });
    check('Upgrade to hotel (level 5) on tile 1 succeeds',
      !!(buildHotel && buildHotel.ok === true && buildHotel.houses === 5 && buildHotel.cost === 50));

    state = await readState(A);
    check('Server records hotel (5 houses) on tile 1', state.propertyHouses[1] === 5);
    check('Hotel cost ($50) debited from player money',
      state.players.find(p => p.id === 1).money === cashBeforeHotel - 50);

    // Attempt to build further on maxed hotel tile rejected with ALREADY_MAXED
    const rejectMaxed = await emitAction(A, 'house:upgraded', { tileId: 1, houses: 5, playerId: 1 });
    check('Attempt to build on already maxed hotel tile rejected with ALREADY_MAXED or BAD_BUILD',
      !!(rejectMaxed && rejectMaxed.ok === false &&
         (rejectMaxed.code === 'ALREADY_MAXED' || rejectMaxed.code === 'BAD_BUILD')));

    // -------------------------------------------------------------------------
    // SCENARIO 7: INSUFFICIENT CASH REJECTION
    // Drain Alice cash to $10, then attempt to upgrade tile 26 to hotel ($50).
    // -------------------------------------------------------------------------
    console.log('\n--- 7. INSUFFICIENT CASH REJECTION ---');
    state = await readState(A);
    const aliceCurMoney = state.players.find(p => p.id === 1).money;
    const drainAmount = Math.max(0, aliceCurMoney - 10);

    // Trade cash away to Bob so Alice has only $10
    const drainTrade = {
      id: `drain-b4-${Date.now()}`,
      initiatorId: 1,
      targetId: 2,
      initiatorPropertyIds: [],
      targetPropertyIds: [],
      initiatorMoney: drainAmount,
      targetMoney: 0,
    };
    await emitAck(A, 'trade:created', drainTrade);
    await emitAck(B, 'trade:accepted', { trade: drainTrade, actionId: `trade-act-${Date.now()}` });

    state = await readState(A);
    check('Alice money drained to $10 (cannot afford $50 hotel)',
      state.players.find(p => p.id === 1).money === 10);

    const rejectNoCash = await emitAction(A, 'house:upgraded', {
      tileId: 26,
      houses: 5,
      playerId: 1,
    });
    check('Upgrade rejected when player has insufficient funds (INSUFFICIENT_FUNDS)',
      !!(rejectNoCash && rejectNoCash.ok === false && rejectNoCash.code === 'INSUFFICIENT_FUNDS'),
      JSON.stringify(rejectNoCash));

    state = await readState(A);
    check('Tile 26 house count remains 4 after insufficient funds rejection',
      state.propertyHouses[26] === 4);
    check('Alice money remains $10',
      state.players.find(p => p.id === 1).money === 10);

    // -------------------------------------------------------------------------
    // SCENARIO 8: FORGED & UNAUTHORIZED REQUESTS REJECTION
    // -------------------------------------------------------------------------
    console.log('\n--- 8. FORGED & UNAUTHORIZED REQUESTS REJECTION ---');
    // Non-owner (Bob) attempts to upgrade Alice's tile 1
    // (Hand turn to Bob first so turnGate passes for Bob, but NOT_OWNER catches him)
    await emitAck(A, 'turn:ended', { playerId: 1 });

    const bobNonOwnerBuild = await emitAction(B, 'house:upgraded', {
      tileId: 1,
      houses: 2,
      playerId: 2,
    });
    check('Non-owner upgrade attempt is rejected with NOT_OWNER',
      !!(bobNonOwnerBuild && bobNonOwnerBuild.ok === false && bobNonOwnerBuild.code === 'NOT_OWNER'),
      JSON.stringify(bobNonOwnerBuild));

    // Out-of-turn upgrade attempt: Alice attempts to build during Bob's turn
    const outOfTurnBuild = await emitAction(A, 'house:upgraded', {
      tileId: 1,
      houses: 2,
      playerId: 1,
    });
    check('Out-of-turn upgrade attempt is rejected with NOT_YOUR_TURN',
      !!(outOfTurnBuild && outOfTurnBuild.ok === false && outOfTurnBuild.code === 'NOT_YOUR_TURN'),
      JSON.stringify(outOfTurnBuild));

    // Non-property tile upgrade attempt: Bob attempts to build on Airport (tile 5)
    await acquireTile(B, 2, 5);
    const airportBuild = await emitAction(B, 'house:upgraded', {
      tileId: 5,
      houses: 1,
      playerId: 2,
    });
    check('Upgrade attempt on non-property tile (Airport) is rejected with BAD_TILE',
      !!(airportBuild && airportBuild.ok === false && airportBuild.code === 'BAD_TILE'),
      JSON.stringify(airportBuild));

    // -------------------------------------------------------------------------
    // SCENARIO 9: REPLAY / DUPLICATE ACTIONID PROTECTION
    // -------------------------------------------------------------------------
    console.log('\n--- 9. REPLAY / DUPLICATE ACTIONID PROTECTION ---');
    // End Bob's turn, give funds back to Alice to test valid upgrade + replay
    await emitAck(B, 'turn:ended', { playerId: 2 });

    const refundTrade = {
      id: `refund-b4-${Date.now()}`,
      initiatorId: 2,
      targetId: 1,
      initiatorPropertyIds: [],
      targetPropertyIds: [],
      initiatorMoney: 200,
      targetMoney: 0,
    };
    await emitAck(B, 'trade:created', refundTrade);
    await emitAck(A, 'trade:accepted', { trade: refundTrade, actionId: `trade-act-${Date.now()}` });

    // Alice now has enough money to upgrade tile 26 to hotel (5)
    const replayActId = `replay-build-${Date.now()}`;
    const validHotel26 = await emitAck(A, 'house:upgraded', {
      tileId: 26,
      houses: 5,
      playerId: 1,
      actionId: replayActId,
    });
    check('First upgrade of tile 26 to hotel succeeds',
      !!(validHotel26 && validHotel26.ok === true && validHotel26.houses === 5));

    const aliceMoneyAfterHotel26 = (await readState(A)).players.find(p => p.id === 1).money;

    // Replay with identical actionId
    const replayedBuild = await emitAck(A, 'house:upgraded', {
      tileId: 26,
      houses: 5,
      playerId: 1,
      actionId: replayActId,
    });
    check('Replayed house:upgraded with same actionId is rejected with DUPLICATE_ACTION',
      !!(replayedBuild && replayedBuild.ok === false && replayedBuild.code === 'DUPLICATE_ACTION'),
      JSON.stringify(replayedBuild));

    state = await readState(A);
    check('Alice money was NOT charged a second time on replay',
      state.players.find(p => p.id === 1).money === aliceMoneyAfterHotel26);

    // -------------------------------------------------------------------------
    // SCENARIO 10: STATE PERSISTENCE & SYNCHRONIZATION
    // -------------------------------------------------------------------------
    console.log('\n--- 10. STATE PERSISTENCE & SYNCHRONIZATION ---');
    const syncStateA = await readState(A);
    const syncStateB = await readState(B);

    check('Both Alice and Bob observe identical house counts across the board',
      syncStateA.propertyHouses[1] === 5 &&
      syncStateA.propertyHouses[26] === 5 &&
      syncStateB.propertyHouses[1] === 5 &&
      syncStateB.propertyHouses[26] === 5);

    // Reconnect as Alice to verify state recovery
    const A2 = track(await connect());
    const rejoinA = await emitAck(A2, 'player:rejoin', { roomId, token: tokenA });
    check('Reconnected player recovers authoritative house state',
      rejoinA && rejoinA.ok &&
      rejoinA.playerState.propertyHouses[1] === 5 &&
      rejoinA.playerState.propertyHouses[26] === 5);

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
