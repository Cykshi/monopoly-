// Headless GAME-SETTINGS-SYNCHRONIZATION test suite.
// Regression tests for BUG-01:
// - Host can update settings in lobby.
// - Non-host cannot modify settings.
// - Settings cannot be modified once game has started.
// - Guests receive updated settings via room:settings and room:players.
// - Room joining, reconnection (player:rejoin) and state restoration receive the correct settings.
// - Disabled features are rejected by the server:
//     * Trading (trade:created, trade:accepted) rejected when enableTrading = false
//     * Auctions (auction:start) rejected when enableAuction = false
//     * Mortgages/property selling (property:sold) rejected when enableMortgage = false
//     * Movement cards (player:skill-card) rejected when enableMovementCards = false
//     * Jail rent rule enforced: rent:paid rejected when owner in jail & jailCollectsRent = false
//     * Rest House mode: restHouseMode = "rest" awards $0 pot payout
// - Enabled features continue working when toggled on.
// - Settings cannot be bypassed through forged Socket.IO events.

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
    console.log('\n=== BUG-01: HOST GAME SETTINGS SYNCHRONIZATION TESTS ===');

    // 1. Setup Room with Host A and Guest B
    const A = track(await connect());
    const created = await emitAck(A, 'room:create', { name: 'HostAlice' });
    roomId = created.roomId;
    const tokenA = created.token;
    check('setup: room created with token', !!(created && created.ok && roomId && tokenA));

    // Verify initial default settings in room state
    let stateA = await readState(A);
    check('initial room state includes default settings',
      !!(stateA && stateA.settings && stateA.settings.enableTrading === true && stateA.settings.enableMortgage === true && stateA.settings.jailCollectsRent === false && stateA.settings.enableAuction === true && stateA.settings.enableMovementCards === true && stateA.settings.fastMode === false && stateA.settings.restHouseMode === 'pot'),
      JSON.stringify(stateA && stateA.settings)
    );

    const B = track(await connect());
    let guestJoinedState = null;
    B.once('room:joined', (payload) => {
      guestJoinedState = payload;
    });
    const bJoin = await emitAck(B, 'room:join', { roomId, name: 'GuestBob' });
    check('setup: guest joined room', !!(bJoin && bJoin.ok));
    await sleep(200);

    check('guest receives settings in room:joined state',
      !!(guestJoinedState && guestJoinedState.state && guestJoinedState.state.settings && guestJoinedState.state.settings.enableTrading === true),
      JSON.stringify(guestJoinedState && guestJoinedState.state && guestJoinedState.state.settings)
    );

    // Identify players
    await emitAck(A, 'player:identify', { roomId, token: tokenA, playerId: 1 });
    await emitAck(B, 'player:identify', { roomId, token: bJoin.token, playerId: 2 });

    // 2. Host updates settings
    // Test invalid / unsupported settings normalization first
    const invalidSettingsAttempt = await emitAck(A, 'room:update-settings', {
      settings: {
        fastMode: 'not-a-boolean',
        restHouseMode: 'bogus-mode',
        enableTrading: 12345,
        unsupportedField: 'malicious'
      }
    });
    check('invalid settings values are safely normalized without error',
      !!(invalidSettingsAttempt && invalidSettingsAttempt.ok && invalidSettingsAttempt.settings),
      JSON.stringify(invalidSettingsAttempt)
    );
    check('normalized settings retain valid boolean/enum types and strip unsupported fields',
      typeof invalidSettingsAttempt.settings.fastMode === 'boolean' &&
      (invalidSettingsAttempt.settings.restHouseMode === 'pot' || invalidSettingsAttempt.settings.restHouseMode === 'rest') &&
      typeof invalidSettingsAttempt.settings.enableTrading === 'boolean' &&
      invalidSettingsAttempt.settings.unsupportedField === undefined,
      JSON.stringify(invalidSettingsAttempt.settings)
    );

    // Set listener right before the update to catch the broadcast
    let guestReceivedSettings = null;
    B.once('room:settings', (payload) => {
      guestReceivedSettings = payload;
    });

    // Now update to disabled test settings
    const updateRes = await emitAck(A, 'room:update-settings', {
      settings: {
        enableTrading: false,
        enableAuction: false,
        enableMortgage: false,
        enableMovementCards: false,
        jailCollectsRent: false,
        fastMode: true,
        restHouseMode: 'rest'
      }
    });

    check('host can update settings',
      !!(updateRes && updateRes.ok && updateRes.settings && updateRes.settings.enableTrading === false && updateRes.settings.fastMode === true),
      JSON.stringify(updateRes)
    );

    await sleep(200);
    check('guest received updated settings via broadcast',
      !!(guestReceivedSettings && guestReceivedSettings.settings && guestReceivedSettings.settings.enableTrading === false && guestReceivedSettings.settings.fastMode === true && guestReceivedSettings.settings.restHouseMode === 'rest'),
      JSON.stringify(guestReceivedSettings)
    );

    // 3. Non-host (guest) CANNOT modify settings
    const guestAttempt = await emitAck(B, 'room:update-settings', {
      settings: { enableTrading: true }
    });
    check('non-host cannot modify settings (rejected with NOT_HOST)',
      !!(guestAttempt && guestAttempt.ok === false && guestAttempt.code === 'NOT_HOST'),
      JSON.stringify(guestAttempt)
    );

    // Verify settings remained unchanged
    stateA = await readState(A);
    check('settings remained unchanged after guest attempt',
      stateA.settings.enableTrading === false,
      `enableTrading=${stateA.settings.enableTrading}`
    );

    // 4. Reconnecting / joining players receive correct settings without relying on defaults
    const C = track(await connect());
    const cRejoin = await emitAck(C, 'player:rejoin', {
      roomId,
      token: bJoin.token
    });
    check('reconnecting player receives authoritative settings in playerState',
      !!(cRejoin && cRejoin.ok && cRejoin.playerState && cRejoin.playerState.settings && cRejoin.playerState.settings.enableTrading === false && cRejoin.playerState.settings.enableAuction === false),
      JSON.stringify(cRejoin && cRejoin.playerState && cRejoin.playerState.settings)
    );
    // Disconnect C so B can keep testing
    C.disconnect();

    // 5. Server-side rule enforcement: Disabled features are rejected by the server
    console.log('\n=== TESTING SERVER ENFORCEMENT OF DISABLED SETTINGS ===');

    // A. Trading is disabled -> trade:created, trade:updated, trade:accepted must be rejected
    const tradeRes = await emitAck(A, 'trade:created', {
      id: 'trade-test-1',
      initiatorId: 1,
      targetId: 2,
      initiatorPropertyIds: [],
      targetPropertyIds: [],
      initiatorMoney: 50,
      targetMoney: 0
    });
    check('trade:created rejected when enableTrading is false',
      !!(tradeRes && tradeRes.ok === false && tradeRes.code === 'TRADING_DISABLED'),
      JSON.stringify(tradeRes)
    );

    const tradeUpdateRes = await emitAck(A, 'trade:updated', {
      id: 'trade-test-1',
      initiatorId: 1,
      targetId: 2,
      initiatorPropertyIds: [],
      targetPropertyIds: [],
      initiatorMoney: 50,
      targetMoney: 0
    });
    check('trade:updated rejected when enableTrading is false',
      !!(tradeUpdateRes && tradeUpdateRes.ok === false && tradeUpdateRes.code === 'TRADING_DISABLED'),
      JSON.stringify(tradeUpdateRes)
    );

    const tradeAcceptRes = await emitAck(B, 'trade:accepted', {
      trade: {
        id: 'trade-test-1',
        initiatorId: 1,
        targetId: 2,
        initiatorPropertyIds: [],
        targetPropertyIds: [],
        initiatorMoney: 50,
        targetMoney: 0
      }
    });
    check('trade:accepted rejected when enableTrading is false',
      !!(tradeAcceptRes && tradeAcceptRes.ok === false && tradeAcceptRes.code === 'TRADING_DISABLED'),
      JSON.stringify(tradeAcceptRes)
    );

    // B. Auction is disabled -> auction:start and auction:bid must be rejected
    const auctionRes = await emitAck(A, 'auction:start', {
      playerId: 1,
      auction: { id: 'auc-1', tileId: 1, currentBid: 50 }
    });
    check('auction:start rejected when enableAuction is false',
      !!(auctionRes && auctionRes.ok === false && auctionRes.code === 'AUCTION_DISABLED'),
      JSON.stringify(auctionRes)
    );

    const auctionBidRes = await emitAck(A, 'auction:bid', {
      auction: { id: 'auc-1', tileId: 1, currentBid: 60 }
    });
    check('auction:bid rejected when enableAuction is false',
      !!(auctionBidRes && auctionBidRes.ok === false && auctionBidRes.code === 'AUCTION_DISABLED'),
      JSON.stringify(auctionBidRes)
    );

    // C. Movement cards disabled -> player:skill-card must be rejected
    const cardRes = await emitAck(A, 'player:skill-card', {
      playerId: 1,
      movement: 3
    });
    check('player:skill-card rejected when enableMovementCards is false',
      !!(cardRes && cardRes.ok === false && cardRes.code === 'CARDS_DISABLED'),
      JSON.stringify(cardRes)
    );

    // D. Mortgage / selling disabled -> property:sold and house:sold must be rejected
    const sellRes = await emitAction(A, 'property:sold', {
      playerId: 1,
      tileId: 1
    });
    check('property:sold rejected when enableMortgage is false',
      !!(sellRes && sellRes.ok === false && sellRes.code === 'MORTGAGE_DISABLED'),
      JSON.stringify(sellRes)
    );

    const houseSellRes = await emitAction(A, 'house:sold', {
      playerId: 1,
      tileId: 1
    });
    check('house:sold rejected when enableMortgage is false',
      !!(houseSellRes && houseSellRes.ok === false && houseSellRes.code === 'MORTGAGE_DISABLED'),
      JSON.stringify(houseSellRes)
    );

    // 6. Rest House Pot Rule:
    // With restHouseMode = "rest", landing on tile 20 (REST HOUSE) pays $0 pot payout
    console.log('\n=== TESTING REST HOUSE MODE ENFORCEMENT ===');
    // First, let's start the game so we can test game actions
    await emitAck(A, 'player:rolled', { playerId: 1 });
    await emitAction(A, 'player:moved', { playerId: 1 });

    // Verify settings cannot be modified once game has started
    const midGameSettingsUpdate = await emitAck(A, 'room:update-settings', {
      settings: { enableTrading: true }
    });
    check('settings cannot be modified once game has started (GAME_STARTED)',
      !!(midGameSettingsUpdate && midGameSettingsUpdate.ok === false && midGameSettingsUpdate.code === 'GAME_STARTED'),
      JSON.stringify(midGameSettingsUpdate)
    );

    // 7. Event forgery test:
    // A guest emitting room:settings or forged events cannot alter server settings
    B.emit('room:settings', { settings: { enableTrading: true, enableAuction: true } });
    await sleep(200);
    const verifyState = await readState(A);
    check('guest cannot forge room:settings event to alter server settings',
      verifyState.settings.enableTrading === false && verifyState.settings.enableAuction === false,
      JSON.stringify(verifyState.settings)
    );

    // 8. Re-enable settings in a fresh room and verify features work when enabled
    console.log('\n=== TESTING FEATURES WORK WHEN ENABLED ===');
    const Host2 = track(await connect());
    const room2 = await emitAck(Host2, 'room:create', { name: 'Host2' });
    const room2Id = room2.roomId;
    const token2 = room2.token;

    const Guest2 = track(await connect());
    const g2Join = await emitAck(Guest2, 'room:join', { roomId: room2Id, name: 'Guest2' });
    await emitAck(Host2, 'player:identify', { roomId: room2Id, token: token2, playerId: 1 });
    await emitAck(Guest2, 'player:identify', { roomId: room2Id, token: g2Join.token, playerId: 2 });

    // In room2, settings are default (enabled = true).
    // Movement card should succeed for player 1 on turn 1
    const cardEnabledRes = await emitAck(Host2, 'player:skill-card', {
      playerId: 1,
      movement: 2
    });
    check('player:skill-card succeeds when enableMovementCards is true',
      !!(cardEnabledRes && cardEnabledRes.ok === true && cardEnabledRes.movement === 2),
      JSON.stringify(cardEnabledRes)
    );
    // Move to consume the roll of 2 (Host2 lands on tile 2)
    await emitAction(Host2, 'player:moved', { playerId: 1 });

    // Trade should pass settings check when enableTrading is true
    const tradeEnabledRes = await emitAck(Host2, 'trade:created', {
      id: 'trade-test-enabled',
      initiatorId: 1,
      targetId: 2,
      initiatorPropertyIds: [],
      targetPropertyIds: [],
      initiatorMoney: 100,
      targetMoney: 0
    });
    check('trade:created succeeds when enableTrading is true',
      !!(tradeEnabledRes && tradeEnabledRes.ok === true),
      JSON.stringify(tradeEnabledRes)
    );

    // Auction on unowned tile should pass settings check when enableAuction is true
    const auctionEnabledRes = await emitAck(Host2, 'auction:start', {
      playerId: 1,
      auction: { id: 'auc-enabled-1', tileId: 1, currentBid: 60 }
    });
    check('auction:start succeeds when enableAuction is true',
      !!(auctionEnabledRes && auctionEnabledRes.ok === true),
      JSON.stringify(auctionEnabledRes)
    );

    // Test restHouseMode = "pot" (default) in room2
    console.log('\n=== TESTING REST HOUSE MODE: "pot" PAYS OUT POT ===');
    // Move Host2 from tile 2 to tile 7 (tax tile): 5 steps
    await emitAck(Host2, 'player:skill-card', { movement: 5, playerId: 1 });
    await emitAction(Host2, 'player:moved', { playerId: 1 });

    const taxRes = await emitAction(Host2, 'tax:pay', { playerId: 1, tileId: 7 });
    check('Host2 paid $100 tax on tile 7, adding to pot',
      !!(taxRes && taxRes.ok && taxRes.pot === 100), JSON.stringify(taxRes));

    // Move Host2 from tile 7 to tile 20 (REST HOUSE): 13 steps = 6 + 6 + 1
    await emitAck(Host2, 'player:skill-card', { movement: 6, playerId: 1 });
    await emitAction(Host2, 'player:moved', { playerId: 1 });
    await emitAck(Host2, 'player:skill-card', { movement: 6, playerId: 1 });
    await emitAction(Host2, 'player:moved', { playerId: 1 });
    await emitAck(Host2, 'player:skill-card', { movement: 1, playerId: 1 });
    await emitAction(Host2, 'player:moved', { playerId: 1 });

    // Resolve Rest House in "pot" mode
    const restPotRes = await emitAction(Host2, 'rest-house:resolve', { playerId: 1 });
    check('restHouseMode="pot" pays out pot and resets pot to 0',
      !!(restPotRes && restPotRes.ok && restPotRes.payout === 100 && restPotRes.pot === 0 && restPotRes.isResting === true),
      JSON.stringify(restPotRes));

    // 9. Jail rent rule enforcement:
    // Create room3 where jailCollectsRent is false (default)
    console.log('\n=== TESTING JAIL COLLECTS RENT: false REJECTS RENT ===');
    const Host3 = track(await connect());
    const room3 = await emitAck(Host3, 'room:create', { name: 'Host3' });
    const room3Id = room3.roomId;
    const token3 = room3.token;

    const Guest3 = track(await connect());
    const g3Join = await emitAck(Guest3, 'room:join', { roomId: room3Id, name: 'Guest3' });
    await emitAck(Host3, 'player:identify', { roomId: room3Id, token: token3, playerId: 1 });
    await emitAck(Guest3, 'player:identify', { roomId: room3Id, token: g3Join.token, playerId: 2 });

    // Host3 moves 1 step to tile 1 (Mediterranean Ave)
    await emitAck(Host3, 'player:skill-card', { movement: 1, playerId: 1 });
    await emitAction(Host3, 'player:moved', { playerId: 1 });
    // Buy tile 1:
    const buyRes = await emitAction(Host3, 'property:bought', { playerId: 1, tileId: 1 });
    check('Host3 bought tile 1', !!(buyRes && buyRes.ok), JSON.stringify(buyRes));

    // End Host3 turn:
    await emitAck(Host3, 'turn:ended', { playerId: 1 });

    // Guest3 moves 1 step to tile 1:
    await emitAck(Guest3, 'player:skill-card', { movement: 1, playerId: 2 });
    await emitAction(Guest3, 'player:moved', { playerId: 2 });

    // When Host3 is NOT in jail, rent:paid succeeds!
    const rentNormal = await emitAction(Guest3, 'rent:paid', {
      payerId: 2,
      ownerId: 1,
      tileId: 1
    });
    check('rent:paid succeeds when owner is NOT in jail', !!(rentNormal && rentNormal.ok), JSON.stringify(rentNormal));

    // End Guest3 turn so it's Host3's turn again:
    await emitAck(Guest3, 'turn:ended', { playerId: 2 });

    // Move Host3 from tile 1 to tile 14 (Surprise): 14 - 1 = 13 steps (6 + 6 + 1)
    await emitAck(Host3, 'player:skill-card', { movement: 6, playerId: 1 });
    await emitAction(Host3, 'player:moved', { playerId: 1 });
    // Now on 7. Move 6 to 13:
    await emitAck(Host3, 'player:skill-card', { movement: 6, playerId: 1 });
    await emitAction(Host3, 'player:moved', { playerId: 1 });
    // Now on 13. Move 1 to 14:
    await emitAck(Host3, 'player:skill-card', { movement: 1, playerId: 1 });
    await emitAction(Host3, 'player:moved', { playerId: 1 });

    // Draw surprise card on tile 14 with forced roll 1 (Go to Jail)
    const jailDraw = await emitAction(Host3, 'card:draw', {
      playerId: 1,
      _testForcedRoll: 1
    });
    check('Host3 sent to jail via card draw', !!(jailDraw && jailDraw.ok && jailDraw.inJail === true), JSON.stringify(jailDraw));

    // End Host3 turn so it's Guest3's turn:
    await emitAck(Host3, 'turn:ended', { playerId: 1 });

    // Guest3 is currently on tile 1, which Host3 owns.
    // Try to pay rent while Host3 is in jail and jailCollectsRent is false:
    const rentJailRejected = await emitAction(Guest3, 'rent:paid', {
      payerId: 2,
      ownerId: 1,
      tileId: 1
    });
    check('rent:paid rejected when owner in jail and jailCollectsRent=false',
      !!(rentJailRejected && rentJailRejected.ok === false && rentJailRejected.code === 'OWNER_IN_JAIL'),
      JSON.stringify(rentJailRejected)
    );

    // 10. Jail rent rule enforcement: jailCollectsRent = true PERMITS rent
    console.log('\n=== TESTING JAIL COLLECTS RENT: true PERMITS RENT ===');
    const Host4 = track(await connect());
    const room4 = await emitAck(Host4, 'room:create', { name: 'Host4' });
    const room4Id = room4.roomId;
    const token4 = room4.token;

    const Guest4 = track(await connect());
    const g4Join = await emitAck(Guest4, 'room:join', { roomId: room4Id, name: 'Guest4' });
    await emitAck(Host4, 'player:identify', { roomId: room4Id, token: token4, playerId: 1 });
    await emitAck(Guest4, 'player:identify', { roomId: room4Id, token: g4Join.token, playerId: 2 });

    // Host4 updates jailCollectsRent to true in lobby
    const updateJailRentRes = await emitAck(Host4, 'room:update-settings', {
      settings: { jailCollectsRent: true }
    });
    check('Host4 configured jailCollectsRent=true in lobby',
      !!(updateJailRentRes && updateJailRentRes.ok && updateJailRentRes.settings && updateJailRentRes.settings.jailCollectsRent === true),
      JSON.stringify(updateJailRentRes));

    // Host4 moves 1 step to tile 1 (Mediterranean Ave) and buys it
    await emitAck(Host4, 'player:skill-card', { movement: 1, playerId: 1 });
    await emitAction(Host4, 'player:moved', { playerId: 1 });
    await emitAction(Host4, 'property:bought', { playerId: 1, tileId: 1 });
    await emitAck(Host4, 'turn:ended', { playerId: 1 });

    // Guest4 moves 1 step to tile 1
    await emitAck(Guest4, 'player:skill-card', { movement: 1, playerId: 2 });
    await emitAction(Guest4, 'player:moved', { playerId: 2 });
    await emitAction(Guest4, 'rent:paid', { payerId: 2, ownerId: 1, tileId: 1 });
    await emitAck(Guest4, 'turn:ended', { playerId: 2 });

    // Host4 moves to tile 14 (Surprise): 13 steps (6 + 6 + 1)
    await emitAck(Host4, 'player:skill-card', { movement: 6, playerId: 1 });
    await emitAction(Host4, 'player:moved', { playerId: 1 });
    await emitAck(Host4, 'player:skill-card', { movement: 6, playerId: 1 });
    await emitAction(Host4, 'player:moved', { playerId: 1 });
    await emitAck(Host4, 'player:skill-card', { movement: 1, playerId: 1 });
    await emitAction(Host4, 'player:moved', { playerId: 1 });

    // Host4 draws Go to Jail card
    const jailDraw4 = await emitAction(Host4, 'card:draw', {
      playerId: 1,
      _testForcedRoll: 1
    });
    check('Host4 sent to jail via card draw', !!(jailDraw4 && jailDraw4.ok && jailDraw4.inJail === true), JSON.stringify(jailDraw4));
    await emitAck(Host4, 'turn:ended', { playerId: 1 });

    // Guest4 on tile 1 pays rent while Host4 is in jail -> SUCCEEDS because jailCollectsRent=true
    const rentJailAllowed = await emitAction(Guest4, 'rent:paid', {
      payerId: 2,
      ownerId: 1,
      tileId: 1
    });
    check('rent:paid succeeds when owner in jail and jailCollectsRent=true',
      !!(rentJailAllowed && rentJailAllowed.ok === true && rentJailAllowed.paid > 0),
      JSON.stringify(rentJailAllowed)
    );

    // 11. Rest House Mode: restHouseMode = "rest" preserves pot and gives $0 payout
    console.log('\n=== TESTING REST HOUSE MODE: "rest" PRESERVES POT ===');
    const Host5 = track(await connect());
    const room5 = await emitAck(Host5, 'room:create', { name: 'Host5' });
    const room5Id = room5.roomId;
    const token5 = room5.token;

    const Guest5 = track(await connect());
    const g5Join = await emitAck(Guest5, 'room:join', { roomId: room5Id, name: 'Guest5' });
    await emitAck(Host5, 'player:identify', { roomId: room5Id, token: token5, playerId: 1 });
    await emitAck(Guest5, 'player:identify', { roomId: room5Id, token: g5Join.token, playerId: 2 });

    // Host5 configures restHouseMode = "rest"
    const updateRestRes = await emitAck(Host5, 'room:update-settings', {
      settings: { restHouseMode: 'rest' }
    });
    check('Host5 configured restHouseMode="rest" in lobby',
      !!(updateRestRes && updateRestRes.ok && updateRestRes.settings && updateRestRes.settings.restHouseMode === 'rest'),
      JSON.stringify(updateRestRes));

    // Move Host5 from 0 to 7: 6 + 1 = 7 steps
    await emitAck(Host5, 'player:skill-card', { movement: 6, playerId: 1 });
    await emitAction(Host5, 'player:moved', { playerId: 1 });
    await emitAck(Host5, 'player:skill-card', { movement: 1, playerId: 1 });
    await emitAction(Host5, 'player:moved', { playerId: 1 });

    const taxRes5 = await emitAction(Host5, 'tax:pay', { playerId: 1, tileId: 7 });
    check('Host5 paid $100 tax on tile 7 into pot', !!(taxRes5 && taxRes5.ok && taxRes5.pot === 100), JSON.stringify(taxRes5));

    // Move Host5 from 7 to 20: 13 steps = 6 + 6 + 1
    await emitAck(Host5, 'player:skill-card', { movement: 6, playerId: 1 });
    await emitAction(Host5, 'player:moved', { playerId: 1 });
    await emitAck(Host5, 'player:skill-card', { movement: 6, playerId: 1 });
    await emitAction(Host5, 'player:moved', { playerId: 1 });
    await emitAck(Host5, 'player:skill-card', { movement: 1, playerId: 1 });
    await emitAction(Host5, 'player:moved', { playerId: 1 });

    // Resolve Rest House in "rest" mode
    const restRestRes = await emitAction(Host5, 'rest-house:resolve', { playerId: 1 });
    check('restHouseMode="rest" awards $0 payout and PRESERVES room pot at $100',
      !!(restRestRes && restRestRes.ok && restRestRes.payout === 0 && restRestRes.pot === 100 && restRestRes.isResting === true),
      JSON.stringify(restRestRes));

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
