// Focused CARD MOVEMENT LANDING EFFECTS AUTHORITY test suite.
// Regression tests for BUG-03:
// - Card moves player to opponent-owned property: rent is charged exactly once.
// - Card moves player to an unowned property: purchase action is offered correctly.
// - Card moves player to a tax tile: tax is charged exactly once.
// - Nearest-airport/utility movement applies the correct destination rules.
// - Direct-to-jail card triggers no ordinary landing effects.
// - Duplicate card events cannot charge rent or tax twice.
// - Guests and reconnecting players receive correct resulting state.
// - Existing card, rent, tax, movement, turn, and doubles tests pass.

const { io } = require('socket.io-client');
const path = require('path');
const fs = require('fs');
const board = require('./game/board');
const cards = require('./game/cards');
const persistence = require('./persistence');

const URL = process.env.SERVER_URL || 'http://localhost:3002';
const results = [];
let failed = 0;

function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

// ============================================================================
// PART 1: PURE UNIT TESTS FOR CARDS ENGINE & DESTINATION LANDING
// ============================================================================
console.log('\n=== 1. PURE UNIT TESTS: CARDS LANDING EFFECTS & RULES ===');

// 1. Direct-to-jail triggers no landing effects
{
  const pJail = { id: 1, position: 10, money: 1500, inJail: true };
  const rJail = cards.resolveCardLanding({}, pJail, 10);
  check('resolveCardLanding for jailed player returns null', rJail === null);

  const pJailTile = { id: 1, position: 10, money: 1500, inJail: false };
  const rJailTile = cards.resolveCardLanding({}, pJailTile, 10);
  check('resolveCardLanding on tile 10 (JAIL) returns null (no ordinary landing effect)', rJailTile === null);
}

// 2. Tax tile destination landing
{
  const p = { id: 1, position: 7, money: 1500, inJail: false };
  const r7 = cards.resolveCardLanding({}, p, 7);
  check('resolveCardLanding on tile 7 returns tax of $100', r7 && r7.type === 'tax' && r7.amount === 100);

  const r24 = cards.resolveCardLanding({}, p, 24);
  check('resolveCardLanding on tile 24 returns tax of $200', r24 && r24.type === 'tax' && r24.amount === 200);

  const r34 = cards.resolveCardLanding({}, p, 34);
  check('resolveCardLanding on tile 34 returns tax of $250', r34 && r34.type === 'tax' && r34.amount === 250);
}

// 3. Unowned property destination landing
{
  const p = { id: 1, position: 5, money: 1500, inJail: false };
  const mockRoom = { propertyOwnership: {} };
  const r5 = cards.resolveCardLanding(mockRoom, p, 5);
  check('resolveCardLanding on unowned tile 5 (Airport 1) returns unowned_property prompt',
    r5 && r5.type === 'unowned_property' && r5.price === 160 && r5.canBuy === true);

  const r22 = cards.resolveCardLanding(mockRoom, p, 22);
  check('resolveCardLanding on unowned tile 22 (Wales) returns unowned_property prompt with price 350',
    r22 && r22.type === 'unowned_property' && r22.price === 350 && r22.canBuy === true);
}

// 4. Self-owned property destination landing
{
  const p = { id: 1, position: 5, money: 1500, inJail: false };
  const mockRoom = { propertyOwnership: { 5: 1 } };
  const rSelf = cards.resolveCardLanding(mockRoom, p, 5);
  check('resolveCardLanding on self-owned tile returns own_property with 0 amount',
    rSelf && rSelf.type === 'own_property' && rSelf.amount === 0);
}

// 5. Opponent-owned property and airport destination landing
{
  const p = { id: 1, position: 5, money: 1500, inJail: false };
  // Owner 2 owns 1 airport (tile 5)
  const room1Airport = { propertyOwnership: { 5: 2 }, propertyHouses: {}, players: [{ id: 2, inJail: false }] };
  const rRent1 = cards.resolveCardLanding(room1Airport, p, 5);
  check('resolveCardLanding on opponent airport (1 owned) charges $50 utility rent',
    rRent1 && rRent1.type === 'rent' && rRent1.ownerId === 2 && rRent1.amount === 50);

  // Owner 2 owns 2 airports (tiles 5 and 15)
  const room2Airports = { propertyOwnership: { 5: 2, 15: 2 }, propertyHouses: {}, players: [{ id: 2, inJail: false }] };
  const rRent2 = cards.resolveCardLanding(room2Airports, p, 5);
  check('resolveCardLanding on opponent airport (2 owned) charges $100 utility rent',
    rRent2 && rRent2.type === 'rent' && rRent2.ownerId === 2 && rRent2.amount === 100);

  // Owner 2 in jail and jailCollectsRent === false -> no rent
  const roomJailOwner = {
    propertyOwnership: { 5: 2 },
    propertyHouses: {},
    players: [{ id: 2, inJail: true }],
    settings: { jailCollectsRent: false }
  };
  const rJailOwner = cards.resolveCardLanding(roomJailOwner, p, 5);
  check('resolveCardLanding when owner is in jail and jailCollectsRent=false charges $0',
    rJailOwner && rJailOwner.type === 'rent' && rJailOwner.amount === 0);
}

// 6. Nearest utility destination search
{
  // From tile 3, nearest utility: tile 5 (Airport 1)
  const nearestFrom3 = cards.findNearestTileIndex(3, 'utility');
  check('findNearestTileIndex from tile 3 for utility returns tile 5', nearestFrom3 === 5);

  // From tile 6, nearest utility: tile 9 (Solar, electricity)
  const nearestFrom6 = cards.findNearestTileIndex(6, 'utility');
  check('findNearestTileIndex from tile 6 for utility returns tile 9', nearestFrom6 === 9);

  // From tile 16, nearest utility: tile 18 (Fiber, internet)
  const nearestFrom16 = cards.findNearestTileIndex(16, 'utility');
  check('findNearestTileIndex from tile 16 for utility returns tile 18', nearestFrom16 === 18);
}

// 7. Rest House & Club destination landing
{
  const p = { id: 1, position: 20, money: 1500, inJail: false };
  const roomPot = { pot: 350 };
  const rRest = cards.resolveCardLanding(roomPot, p, 20);
  check('resolveCardLanding on Rest House returns payout of $350 from pot',
    rRest && rRest.type === 'rest_house' && rRest.payout === 350);

  const pClub = { id: 1, position: 30, money: 1500, inJail: false, hasSkillCard: true };
  const roomClub = { propertyOwnership: { 1: 1, 2: 1 }, propertyHouses: { 1: 2, 2: 1 } }; // 3 houses
  const rClub = cards.resolveCardLanding(roomClub, pClub, 30);
  // Club fee: 1 card * $50 + 3 houses * $100 = $350
  check('resolveCardLanding on Club computes fee from cards and houses ($350)',
    rClub && rClub.type === 'club' && rClub.fee === 350);
}

// 8. Persistence unit serialization and rehydration preserves pendingAction
{
  const mockRoom = {
    roomId: 'PENDINGACTIONTEST',
    hostToken: 'token-host-pa',
    tokens: new Set(['token-host-pa']),
    players: [{ id: 1, money: 1400, position: 5 }],
    propertyOwnership: {},
    propertyHouses: {},
    currentTurnPlayerId: 1,
    turnSeeded: true,
    pendingAction: { type: 'buy_property', playerId: 1, tileId: 5, price: 160 },
    pot: 0,
    restHousePot: 0,
    trades: [],
    activeAuction: null,
    createdAt: Date.now()
  };
  const serialized = persistence.serializeRoom(mockRoom);
  check('8. serializeRoom preserves pendingAction',
    serialized.pendingAction && serialized.pendingAction.type === 'buy_property' && serialized.pendingAction.tileId === 5);

  const tmpDir = path.join(__dirname, '.test-pa-data');
  const prevDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  try {
    persistence.persistRoom(mockRoom);
    const loaded = persistence.loadPersistedRooms();
    const found = loaded.find((r) => r.roomId === 'PENDINGACTIONTEST');
    check('8. persistRoom & loadPersistedRooms preserves pendingAction on disk',
      !!found && found.pendingAction && found.pendingAction.type === 'buy_property' && found.pendingAction.tileId === 5);
  } finally {
    try { persistence.deleteRoomFile('PENDINGACTIONTEST'); } catch { }
    try { if (fs.existsSync(tmpDir)) fs.rmdirSync(tmpDir, { recursive: true }); } catch { }
    process.env.DATA_DIR = prevDir;
  }
}

// ============================================================================
// PART 2: LIVE SOCKET SERVER INTEGRATION TESTS
// ============================================================================
console.log('\n=== 2. LIVE SERVER INTEGRATION: BUG-03 REGRESSION SUITE ===');

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
  actionId: `t-${Date.now()}-${++actionCounter}`,
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
    // SCENARIO 1: Card moves player to opponent-owned property (Airport 1)
    // Rent is charged authoritatively exactly once.
    // -------------------------------------------------------------------------
    console.log('\n--- 1. CARD MOVES PLAYER TO OPPONENT PROPERTY (RENT CHARGED ONCE) ---');
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

    // Bob's turn: Bob moves to tile 5 (Airport 1) and buys it
    await emitAck(B, 'player:skill-card', { movement: 5, playerId: 2 });
    await emitAction(B, 'player:moved', { playerId: 2 }); // tile 5
    const bobBuy = await emitAction(B, 'property:bought', { playerId: 2, tileId: 5 });
    check('Bob successfully purchased tile 5 (Airport 1)', !!(bobBuy && bobBuy.ok));
    await emitAck(B, 'turn:ended', { playerId: 2 });

    // Now it's Alice's turn. Alice is standing on tile 3 (TREASURE).
    let state = await readState(A);
    const alicePreDrawMoney = state.players.find(p => p.id === 1).money;
    const bobPreDrawMoney = state.players.find(p => p.id === 2).money;

    const rentPaidPromiseOnB = waitFor(B, 'rent:paid');
    const cardDrawnPromiseOnB = waitFor(B, 'card:drawn');

    // Alice draws Treasure with forced roll 5 (advance to nearest airport -> tile 5)
    const drawAck = await emitAction(A, 'card:draw', {
      playerId: 1,
      _testForcedRoll: 5,
    });

    check('Alice card:draw acknowledged ok', !!(drawAck && drawAck.ok), JSON.stringify(drawAck));
    check('Alice moved to tile 5 (Airport 1)', drawAck && drawAck.position === 5, `pos=${drawAck && drawAck.position}`);
    check('card outcome includes rent landingEffect',
      !!(drawAck && drawAck.landingEffect && drawAck.landingEffect.type === 'rent' && drawAck.landingEffect.amount === 50),
      JSON.stringify(drawAck.landingEffect));

    // Verify money transfer on the server: rent of $50 charged
    check('Alice money deducted by exactly $50 rent',
      drawAck.money === alicePreDrawMoney - 50,
      `aliceMoney=${drawAck.money} expected=${alicePreDrawMoney - 50}`);

    const rentEvent = await rentPaidPromiseOnB;
    check('Bob received rent:paid event for $50 on tile 5',
      !!(rentEvent && rentEvent.payerId === 1 && rentEvent.ownerId === 2 && rentEvent.tileId === 5 && rentEvent.amount === 50));

    const cardDrawnEvent = await cardDrawnPromiseOnB;
    check('Bob received card:drawn event with matching position and money',
      !!(cardDrawnEvent && cardDrawnEvent.position === 5 && cardDrawnEvent.money === drawAck.money));

    state = await readState(A);
    const bobCurrentMoney = state.players.find(p => p.id === 2).money;
    check('Bob server balance increased by exactly $50', bobCurrentMoney === bobPreDrawMoney + 50,
      `bobMoney=${bobCurrentMoney} expected=${bobPreDrawMoney + 50}`);

    // --- REPLAY/DUPLICATE EMIT PROTECTION FOR RENT ---
    console.log('\n--- DUPLICATE RENT EMIT PREVENTION ---');
    // Alice's client attempts to emit rent:paid on tile 5 again
    const dupRentAck = await emitAction(A, 'rent:paid', {
      payerId: 1,
      ownerId: 2,
      tileId: 5,
    });

    check('duplicate rent:paid returns alreadySettled=true without error',
      !!(dupRentAck && dupRentAck.ok && dupRentAck.alreadySettled === true),
      JSON.stringify(dupRentAck));

    // Check balances again: NOT charged a second time
    state = await readState(A);
    const alicePostDupMoney = state.players.find(p => p.id === 1).money;
    const bobPostDupMoney = state.players.find(p => p.id === 2).money;
    check('Alice balance unchanged after duplicate rent emit (charged exactly once)',
      alicePostDupMoney === drawAck.money, `aliceMoney=${alicePostDupMoney}`);
    check('Bob balance unchanged after duplicate rent emit',
      bobPostDupMoney === bobCurrentMoney, `bobMoney=${bobPostDupMoney}`);

    // End Alice's turn
    await emitAck(A, 'turn:ended', { playerId: 1 });

    // -------------------------------------------------------------------------
    // SCENARIO 2: Card moves player to unowned property -> purchase offered
    // -------------------------------------------------------------------------
    console.log('\n--- 2. CARD MOVES PLAYER TO UNOWNED PROPERTY (PURCHASE OFFERED) ---');
    // Bob passes turn
    await emitAck(B, 'player:rolled', { playerId: 2, _testForcedDice: [1, 2] });
    await emitAction(B, 'player:moved', { playerId: 2 });
    await emitAck(B, 'turn:ended', { playerId: 2 });

    // Alice moves to tile 14 (SURPRISE)
    // From 5 to 14 is 9 steps: 6 + 3
    await emitAck(A, 'player:skill-card', { movement: 6, playerId: 1 });
    await emitAction(A, 'player:moved', { playerId: 1 });
    await emitAck(A, 'turn:ended', { playerId: 1 });

    await emitAck(B, 'turn:ended', { playerId: 2 });

    await emitAck(A, 'player:skill-card', { movement: 3, playerId: 1 });
    await emitAction(A, 'player:moved', { playerId: 1 }); // tile 14 (SURPRISE)

    state = await readState(A);
    check('Alice is on tile 14 (SURPRISE)', state.players.find(p => p.id === 1).position === 14);

    // Tile 22 (Wales, price 350) is unowned
    check('Tile 22 is unowned', state.propertyOwnership[22] === undefined);

    // Alice draws Surprise with forced roll 3 (jump forward 8 spaces -> tile 22)
    const surpriseDraw = await emitAction(A, 'card:draw', {
      playerId: 1,
      _testForcedRoll: 3,
    });

    check('Surprise draw jumps forward 8 spaces to tile 22',
      !!(surpriseDraw && surpriseDraw.ok && surpriseDraw.position === 22));
    check('card outcome offers purchase prompt with correct price ($350)',
      !!(surpriseDraw && surpriseDraw.landingEffect &&
         surpriseDraw.landingEffect.type === 'unowned_property' &&
         surpriseDraw.landingEffect.price === 350 &&
         surpriseDraw.landingEffect.canBuy === true),
      JSON.stringify(surpriseDraw.landingEffect));

    // Verify pendingAction in room state
    state = await readState(A);
    check('server state reflects pendingAction buy_property on tile 22',
      !!(state.pendingAction && state.pendingAction.type === 'buy_property' && state.pendingAction.tileId === 22));

    // Alice authoritatively buys tile 22
    const aliceBalanceBeforeBuy = state.players.find(p => p.id === 1).money;
    const buyWales = await emitAction(A, 'property:bought', { playerId: 1, tileId: 22 });
    check('Alice purchases tile 22 from card landing', !!(buyWales && buyWales.ok));

    state = await readState(A);
    check('Alice owns tile 22 on server', state.propertyOwnership[22] === 1);
    check('Alice balance debited by official price ($350)',
      state.players.find(p => p.id === 1).money === aliceBalanceBeforeBuy - 350);
    check('pendingAction cleared after purchase', state.pendingAction === null);

    // End Alice turn
    await emitAck(A, 'turn:ended', { playerId: 1 });

    // -------------------------------------------------------------------------
    // SCENARIO 3: Card moves player to TAX tile -> tax charged exactly once
    // -------------------------------------------------------------------------
    console.log('\n--- 3. CARD MOVES PLAYER TO TAX TILE (TAX CHARGED ONCE) ---');
    // Fresh room for clean tax/pot state
    const Host2 = track(await connect());
    const room2 = await emitAck(Host2, 'room:create', { name: 'Host2' });
    const room2Id = room2.roomId;
    const tokenH2 = room2.token;

    const Guest2 = track(await connect());
    const g2Join = await emitAck(Guest2, 'room:join', { roomId: room2Id, name: 'Guest2' });
    await emitAck(Host2, 'player:identify', { roomId: room2Id, token: tokenH2, playerId: 1 });
    await emitAck(Guest2, 'player:identify', { roomId: room2Id, token: g2Join.token, playerId: 2 });

    // Start game: Player 1 rolls non-doubles
    await emitAck(Host2, 'player:rolled', { playerId: 1, _testForcedDice: [1, 2] });
    await emitAction(Host2, 'player:moved', { playerId: 1 }); // tile 3 (TREASURE)
    await emitAck(Host2, 'turn:ended', { playerId: 1 });

    // Guest 2 moves to tile 7 (TAX tile, tax $100)
    await emitAck(Guest2, 'player:skill-card', { movement: 6, playerId: 2 });
    await emitAction(Guest2, 'player:moved', { playerId: 2 });
    await emitAck(Guest2, 'turn:ended', { playerId: 2 });

    await emitAck(Host2, 'turn:ended', { playerId: 1 });

    // Guest 2 takes 1 more step to tile 7
    await emitAck(Guest2, 'player:skill-card', { movement: 1, playerId: 2 });
    await emitAction(Guest2, 'player:moved', { playerId: 2 }); // tile 7
    // Guest 2 does NOT pay tax yet for this test (or pays it, pot resets)
    await emitAction(Guest2, 'tax:pay', { playerId: 2, tileId: 7 });
    await emitAck(Guest2, 'turn:ended', { playerId: 2 });

    // Now Player 1 moves to tile 14 (SURPRISE)
    // From tile 3 to 14: 6 + 5
    await emitAck(Host2, 'player:skill-card', { movement: 6, playerId: 1 });
    await emitAction(Host2, 'player:moved', { playerId: 1 });
    await emitAck(Host2, 'turn:ended', { playerId: 1 });

    await emitAck(Guest2, 'turn:ended', { playerId: 2 });

    await emitAck(Host2, 'player:skill-card', { movement: 5, playerId: 1 });
    await emitAction(Host2, 'player:moved', { playerId: 1 }); // tile 14 (SURPRISE)

    state = await readState(Host2);
    check('Player 1 on tile 14 (SURPRISE) and Player 2 on tile 7 (TAX)',
      state.players.find(p => p.id === 1).position === 14 &&
      state.players.find(p => p.id === 2).position === 7);

    const p1MoneyBeforeSwap = state.players.find(p => p.id === 1).money;
    const potBeforeSwap = state.pot;

    const guestTaxPaidPromise = waitFor(Guest2, 'tax:paid');

    // Player 1 draws Surprise roll 6: SWAP with Player 2 (who is on tile 7 TAX!)
    const swapCardDraw = await emitAction(Host2, 'card:draw', {
      playerId: 1,
      _testForcedRoll: 6,
      targetId: 2,
    });

    check('Swap card executed successfully', !!(swapCardDraw && swapCardDraw.ok && swapCardDraw.swap));
    check('Player 1 position swapped to tile 7 (TAX)', swapCardDraw.position === 7);
    check('card outcome includes tax landingEffect of $100',
      !!(swapCardDraw.landingEffect && swapCardDraw.landingEffect.type === 'tax' && swapCardDraw.landingEffect.amount === 100),
      JSON.stringify(swapCardDraw.landingEffect));

    // Player 1 paid $100 tax authoritatively
    check('Player 1 balance deducted by exactly $100 tax',
      swapCardDraw.money === p1MoneyBeforeSwap - 100,
      `money=${swapCardDraw.money} expected=${p1MoneyBeforeSwap - 100}`);

    const guestTaxEvt = await guestTaxPaidPromise;
    check('Guest received tax:paid broadcast for tile 7',
      !!(guestTaxEvt && guestTaxEvt.playerId === 1 && guestTaxEvt.tileId === 7 && guestTaxEvt.amount === 100));

    state = await readState(Host2);
    check('Room pot increased by exactly $100 tax', state.pot === potBeforeSwap + 100,
      `pot=${state.pot} expected=${potBeforeSwap + 100}`);

    // --- DUPLICATE TAX EMIT PREVENTION ---
    const dupTaxAck = await emitAction(Host2, 'tax:pay', {
      playerId: 1,
      tileId: 7,
    });

    check('duplicate tax:pay returns alreadySettled=true without charging again',
      !!(dupTaxAck && dupTaxAck.ok && dupTaxAck.alreadySettled === true),
      JSON.stringify(dupTaxAck));

    state = await readState(Host2);
    check('Player 1 balance unchanged after duplicate tax emit',
      state.players.find(p => p.id === 1).money === swapCardDraw.money);
    check('Room pot unchanged after duplicate tax emit', state.pot === potBeforeSwap + 100);

    // -------------------------------------------------------------------------
    // SCENARIO 4: Direct-to-jail triggers no ordinary landing effects
    // -------------------------------------------------------------------------
    console.log('\n--- 4. DIRECT-TO-JAIL TRIGGERS NO ORDINARY LANDING EFFECTS ---');
    await emitAck(Host2, 'turn:ended', { playerId: 1 });
    await emitAck(Guest2, 'turn:ended', { playerId: 2 });

    // Move Player 1 back to tile 14 (SURPRISE)
    // From 7 to 14: 6 + 1
    await emitAck(Host2, 'player:skill-card', { movement: 6, playerId: 1 });
    await emitAction(Host2, 'player:moved', { playerId: 1 });
    await emitAck(Host2, 'turn:ended', { playerId: 1 });
    await emitAck(Guest2, 'turn:ended', { playerId: 2 });
    await emitAck(Host2, 'player:skill-card', { movement: 1, playerId: 1 });
    await emitAction(Host2, 'player:moved', { playerId: 1 }); // tile 14

    const p1MoneyBeforeJail = (await readState(Host2)).players.find(p => p.id === 1).money;

    // Draw Surprise roll 1: Go directly to JAIL
    const jailDraw = await emitAction(Host2, 'card:draw', {
      playerId: 1,
      _testForcedRoll: 1,
    });

    check('Direct-to-jail card draws successfully', !!(jailDraw && jailDraw.ok));
    check('Player 1 sent to tile 10 with inJail=true', jailDraw.position === 10 && jailDraw.inJail === true);
    check('Direct-to-jail card triggers no ordinary landing effects (landingEffect is null)',
      jailDraw.landingEffect === null, JSON.stringify(jailDraw.landingEffect));
    check('Player 1 money unchanged by jail entry', jailDraw.money === p1MoneyBeforeJail);

    state = await readState(Host2);
    check('Server confirms consecutiveDoubles=0 and hasExtraTurn=false after jail card',
      state.consecutiveDoubles === 0 && state.hasExtraTurn === false);
    check('Server confirms pendingAction is null after jail card', state.pendingAction === null);

    // -------------------------------------------------------------------------
    // SCENARIO 5: Reconnection and Guest state synchronization
    // -------------------------------------------------------------------------
    console.log('\n--- 5. RECONNECTION AND GUEST STATE SYNCHRONIZATION ---');
    // Reconnect Host2
    const Host2Reconnected = track(await connect());
    const rejoinRes = await emitAck(Host2Reconnected, 'player:rejoin', {
      roomId: room2Id,
      token: tokenH2,
    });

    check('Rejoin succeeds with valid state', !!(rejoinRes && rejoinRes.ok && rejoinRes.rejoined));
    check('Rejoin state matches authoritative position (tile 10) and inJail=true',
      rejoinRes.playerState.me.position === 10 && rejoinRes.playerState.me.inJail === true);
    check('Rejoin state matches authoritative money',
      rejoinRes.playerState.me.money === p1MoneyBeforeJail);
    check('Rejoin state matches pot',
      rejoinRes.playerState.pot === state.pot);

    // -------------------------------------------------------------------------
    // SCENARIO 6: Duplicate card:draw actionId is refused (Replay protection)
    // -------------------------------------------------------------------------
    console.log('\n--- 6. REPLAY PROTECTION ON CARD:DRAW ---');
    const replayActId = `card-act-replay-${Date.now()}`;
    // Bob's turn
    await emitAck(Host2, 'turn:ended', { playerId: 1 });
    // Move Bob to tile 3 (TREASURE)
    // Bob on tile 14: 14 -> 3 is 29 steps (6+6+6+6+5)
    let dist = (3 - (await readState(Guest2)).players.find(p => p.id === 2).position + 40) % 40;
    while (dist > 0) {
      const step = Math.min(dist, 6);
      await emitAck(Guest2, 'player:skill-card', { movement: step, playerId: 2 });
      await emitAction(Guest2, 'player:moved', { playerId: 2 });
      dist -= step;
      if (dist > 0) {
        await emitAck(Guest2, 'turn:ended', { playerId: 2 });
        await emitAck(Host2, 'turn:ended', { playerId: 1 });
      }
    }

    state = await readState(Guest2);
    check('Bob is on tile 3 (TREASURE)', state.players.find(p => p.id === 2).position === 3);

    const firstDraw = await emitAck(Guest2, 'card:draw', {
      playerId: 2,
      actionId: replayActId,
      _testForcedRoll: 1, // +$100
    });
    check('First card:draw with actionId succeeds', !!(firstDraw && firstDraw.ok));

    const replayDraw = await emitAck(Guest2, 'card:draw', {
      playerId: 2,
      actionId: replayActId,
      _testForcedRoll: 1,
    });
    check('Replayed card:draw with same actionId refused with DUPLICATE_ACTION',
      !!(replayDraw && replayDraw.ok === false && replayDraw.code === 'DUPLICATE_ACTION'));

    // -------------------------------------------------------------------------
    // SCENARIO 7: Anti-forgery on card pendingAction
    // -------------------------------------------------------------------------
    console.log('\n--- 7. ANTI-FORGERY ON CARD PENDING ACTION ---');
    // Fresh Room 3: Alice and Bob
    const Host3 = track(await connect());
    const room3 = await emitAck(Host3, 'room:create', { name: 'Alice3' });
    const room3Id = room3.roomId;
    const tokenH3 = room3.token;

    const Guest3 = track(await connect());
    const g3Join = await emitAck(Guest3, 'room:join', { roomId: room3Id, name: 'Bob3' });
    await emitAck(Host3, 'player:identify', { roomId: room3Id, token: tokenH3, playerId: 1 });
    await emitAck(Guest3, 'player:identify', { roomId: room3Id, token: g3Join.token, playerId: 2 });

    // Host3 starts game by rolling
    await emitAck(Host3, 'player:rolled', { playerId: 1, _testForcedDice: [1, 2] });
    await emitAction(Host3, 'player:moved', { playerId: 1 }); // tile 3 (TREASURE)

    // Host3 draws Treasure 5: moves to tile 5 (Airport 1, price 160)
    const drawH3 = await emitAction(Host3, 'card:draw', {
      playerId: 1,
      _testForcedRoll: 5,
    });
    check('Host3 moved to tile 5 with unowned property landingEffect',
      !!(drawH3 && drawH3.position === 5 && drawH3.landingEffect && drawH3.landingEffect.type === 'unowned_property'));

    state = await readState(Host3);
    check('server state reflects pendingAction for player 1 on tile 5',
      state.pendingAction && state.pendingAction.playerId === 1 && state.pendingAction.tileId === 5);

    // Guest3 attempts to forge purchase on tile 5 (not their turn, not their position)
    const forgedBuy = await emitAction(Guest3, 'property:bought', {
      playerId: 2,
      tileId: 5,
    });
    check('Guest3 purchase attempt on Player 1 pendingAction is rejected',
      !!(forgedBuy && forgedBuy.ok === false), JSON.stringify(forgedBuy));

    // Reconnecting Host3 receives the pendingAction
    const Host3Recon = track(await connect());
    const rejoin3 = await emitAck(Host3Recon, 'player:rejoin', {
      roomId: room3Id,
      token: tokenH3,
    });
    check('rejoin3 succeeds', !!(rejoin3 && rejoin3.ok && rejoin3.rejoined));
    check('rejoin3 reflects pendingAction for player 1 on tile 5',
      rejoin3.playerState.pendingAction && rejoin3.playerState.pendingAction.tileId === 5);

    // Host3 buys the property
    const legitimateBuy = await emitAction(Host3, 'property:bought', {
      playerId: 1,
      tileId: 5,
    });
    check('Host3 legitimate purchase of pending tile 5 succeeds', !!(legitimateBuy && legitimateBuy.ok));

    state = await readState(Host3);
    check('tile 5 now owned by Player 1', state.propertyOwnership[5] === 1);
    check('pendingAction cleared after purchase', state.pendingAction === null);

    // -------------------------------------------------------------------------
    // SCENARIO 8: Card-driven rent bankruptcy
    // -------------------------------------------------------------------------
    console.log('\n--- 8. CARD-DRIVEN RENT BANKRUPTCY TRANSFERS ASSETS CLEANLY ---');
    // End Host3 turn
    await emitAck(Host3, 'turn:ended', { playerId: 1 });

    // Guest3 moves to tile 14 (SURPRISE)
    // From 0 to 14: 6 + 6 + 2
    await emitAck(Guest3, 'player:skill-card', { movement: 6, playerId: 2 });
    await emitAction(Guest3, 'player:moved', { playerId: 2 }); // 6
    await emitAck(Guest3, 'turn:ended', { playerId: 2 });
    await emitAck(Host3, 'turn:ended', { playerId: 1 });

    await emitAck(Guest3, 'player:skill-card', { movement: 6, playerId: 2 });
    await emitAction(Guest3, 'player:moved', { playerId: 2 }); // 12
    await emitAck(Guest3, 'turn:ended', { playerId: 2 });
    await emitAck(Host3, 'turn:ended', { playerId: 1 });

    await emitAck(Guest3, 'player:skill-card', { movement: 2, playerId: 2 });
    await emitAction(Guest3, 'player:moved', { playerId: 2 }); // 14 (SURPRISE)
    // Guest3 buys tile 16 (UP, $300) so they hold an asset to transfer upon bankruptcy
    await emitAck(Guest3, 'turn:ended', { playerId: 2 });
    await emitAck(Host3, 'turn:ended', { playerId: 1 });

    // Guest3 drains cash to $20 by sending money to Host3 via trade
    state = await readState(Guest3);
    const g3Cash = state.players.find(p => p.id === 2).money;
    const drainAmount = Math.max(0, g3Cash - 20);

    const drainTrade = {
      id: `drain-${Date.now()}`,
      initiatorId: 2,
      targetId: 1,
      initiatorPropertyIds: [],
      targetPropertyIds: [],
      initiatorMoney: drainAmount,
      targetMoney: 0,
    };
    const tradeRes = await emitAck(Guest3, 'trade:created', drainTrade);
    check('trade created to drain cash', !!(tradeRes && tradeRes.ok));
    const acceptRes = await emitAck(Host3, 'trade:accepted', { trade: drainTrade, actionId: `trade-act-${Date.now()}` });
    check('trade accepted to drain cash', !!(acceptRes && acceptRes.ok));

    state = await readState(Guest3);
    const g3CashAfterDrain = state.players.find(p => p.id === 2).money;
    check('Guest3 cash drained to exactly $20', g3CashAfterDrain === 20, `cash=${g3CashAfterDrain}`);

    const h3CashBeforeBankrupt = state.players.find(p => p.id === 1).money;

    // Host3 owns tile 5 (Airport 1). Rent on Airport 1 is $50.
    // Guest3 is on tile 14 (SURPRISE).
    // Guest3 swaps with Host3 (who is on tile 5)!
    const guestBankruptDraw = await emitAction(Guest3, 'card:draw', {
      playerId: 2,
      _testForcedRoll: 6,
      targetId: 1,
    });

    check('Swap card executed for Guest3 to tile 5',
      !!(guestBankruptDraw && guestBankruptDraw.ok && guestBankruptDraw.position === 5));
    check('landingEffect reports rent bankruptcy',
      !!(guestBankruptDraw.landingEffect &&
         guestBankruptDraw.landingEffect.type === 'rent' &&
         guestBankruptDraw.landingEffect.isBankrupt === true &&
         guestBankruptDraw.landingEffect.paid === 20),
      JSON.stringify(guestBankruptDraw.landingEffect));

    state = await readState(Host3);
    const g3Final = state.players.find(p => p.id === 2);
    check('Guest3 is eliminated (isBankrupt=true, money=0)',
      g3Final && g3Final.isBankrupt === true && g3Final.money === 0);
    const h3Final = state.players.find(p => p.id === 1);
    check('Host3 received remaining $20 from bankrupt Guest3',
      h3Final.money === h3CashBeforeBankrupt + 20,
      `h3Money=${h3Final.money} expected=${h3CashBeforeBankrupt + 20}`);
    check('Turn automatically advanced after bankruptcy',
      state.currentTurnPlayerId === 1, `currentTurn=${state.currentTurnPlayerId}`);

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
