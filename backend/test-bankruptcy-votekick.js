// ================= BANKRUPTCY & VOTE-KICK REGRESSION TEST SUITE =================
// Covers:
// 1. Voluntary bankruptcy advances turn when player owns it.
// 2. Voluntary bankruptcy does not advance another player's turn.
// 3. Duplicate bankruptcy requests do not advance turns twice.
// 4. Insufficient rent results in consistent server/client bankruptcy and creditor property transfer.
// 5. Tax and club-fee bankruptcy advance the turn correctly without requiring turn:ended.
// 6. Vote counts synchronize across connected clients.
// 7. A player cannot vote more than once or vote for themselves.
// 8. Vote-kick threshold removes target exactly once and updates every client.
// 9. Non-authorized direct kick attempts (non-host) are rejected.
// 10. Pending trades involving an eliminated player are canceled.
// 11. Bankruptcy during an auction does not leave an invalid winner or stuck auction.

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

let actionSeq = 0;
const newActionId = () => `act-${Date.now()}-${++actionSeq}`;

const sockets = [];
const track = (s) => { sockets.push(s); return s; };

async function cleanupRoom(roomLeaderSocket, roomId) {
  if (roomLeaderSocket && roomLeaderSocket.connected) {
    await emitAck(roomLeaderSocket, 'room:leave', {});
  }
}

async function closeAllSockets() {
  for (const s of sockets) {
    try {
      if (s && s.connected) s.disconnect();
    } catch { /* ignore */ }
  }
}

(async () => {
  console.log('--- TEST GROUP 1: VOLUNTARY BANKRUPTCY & TURN PROGRESSION ---');
  {
    // Setup 3-player room
    const A = track(await connect());
    const B = track(await connect());
    const C = track(await connect());

    const c1 = await emitAck(A, 'room:create', { name: 'Alice' });
    const roomId = c1.roomId;
    const tokenA = c1.token;

    const j2 = await emitAck(B, 'room:join', { roomId, name: 'Bob' });
    const tokenB = j2.token;

    const j3 = await emitAck(C, 'room:join', { roomId, name: 'Carol' });
    const tokenC = j3.token;

    await emitAck(A, 'player:identify', { roomId, token: tokenA, playerId: 1 });
    await emitAck(B, 'player:identify', { roomId, token: tokenB, playerId: 2 });
    await emitAck(C, 'player:identify', { roomId, token: tokenC, playerId: 3 });

    // Start game: Player 1 rolls to open the game
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [1, 2] });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });

    let state = await syncState(A);
    check('P1 owns current turn before voluntary bankruptcy', state?.currentTurnPlayerId === 1);

    // Setup listener for turn:changed on B
    const turnChangePromise = waitFor(B, 'turn:changed');
    const bankruptPromise = waitFor(B, 'player:bankrupt');

    // Item 1: P1 declares voluntary bankruptcy while owning the turn
    const bank1 = await emitAck(A, 'player:bankrupt', { playerId: 1, actionId: newActionId() });
    check('P1 voluntary bankruptcy accepted', !!(bank1 && bank1.ok), JSON.stringify(bank1));

    const bankEvt = await bankruptPromise;
    check('player:bankrupt broadcast carries playerId 1', bankEvt && bankEvt.playerId === 1);

    const turnEvt = await turnChangePromise;
    check('turn:changed emitted and advanced to P2', turnEvt && turnEvt.currentTurnPlayerId === 2);

    state = await syncState(B);
    const p1 = playerIn(state, 1);
    check('P1 is marked bankrupt on server', p1 && p1.isBankrupt === true && p1.money === 0);
    check('P2 now authoritatively owns the turn', state?.currentTurnPlayerId === 2);

    // Item 2: P3 declares voluntary bankruptcy while P2 owns the turn
    const turnShouldNotChange = waitFor(B, 'turn:changed', 500);
    const bank3 = await emitAck(C, 'player:bankrupt', { playerId: 3, actionId: newActionId() });
    check('P3 voluntary bankruptcy accepted', !!(bank3 && bank3.ok));

    const unexpectedTurn = await turnShouldNotChange;
    check('voluntary bankruptcy of non-turn player does NOT advance the turn', unexpectedTurn === null);

    state = await syncState(B);
    check('turn remains on P2 after P3 bankrupt', state?.currentTurnPlayerId === 2);
    const p3 = playerIn(state, 3);
    check('P3 is marked bankrupt', p3 && p3.isBankrupt === true);

    // Item 3: Duplicate bankruptcy requests do not advance turns twice
    const dupBank1 = await emitAck(A, 'player:bankrupt', { playerId: 1, actionId: newActionId() });
    check('duplicate bankruptcy request from P1 is rejected', dupBank1 && dupBank1.ok === false && (dupBank1.code === 'ALREADY_BANKRUPT' || dupBank1.code === 'PLAYER_OUT'), JSON.stringify(dupBank1));

    state = await syncState(B);
    check('turn still on P2 after duplicate bankruptcy attempt', state?.currentTurnPlayerId === 2);

    await cleanupRoom(A, roomId);
  }

  console.log('\n--- TEST GROUP 2: INSUFFICIENT RENT BANKRUPTCY & PROPERTY TRANSFER ---');
  {
    // Setup 3-player room: P1, P2, P3
    const A = track(await connect());
    const B = track(await connect());
    const C = track(await connect());

    const c1 = await emitAck(A, 'room:create', { name: 'Alice' });
    const roomId = c1.roomId;
    const tokenA = c1.token;

    const j2 = await emitAck(B, 'room:join', { roomId, name: 'Bob' });
    const tokenB = j2.token;

    const j3 = await emitAck(C, 'room:join', { roomId, name: 'Carol' });
    const tokenC = j3.token;

    await emitAck(A, 'player:identify', { roomId, token: tokenA, playerId: 1 });
    await emitAck(B, 'player:identify', { roomId, token: tokenB, playerId: 2 });
    await emitAck(C, 'player:identify', { roomId, token: tokenC, playerId: 3 });

    // Open game: P1 rolls [1, 1] = 2 -> lands on tile 2 (Normandy, costs $100).
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [1, 1] });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });
    // P1 buys tile 2
    const buyTile2 = await emitAck(A, 'property:bought', { playerId: 1, tileId: 2, actionId: newActionId() });
    check('P1 bought tile 2', !!(buyTile2 && buyTile2.ok));
    await emitAck(A, 'turn:ended', { playerId: 1 });

    // P2's turn: rolls [0, 1] = 1 -> lands on tile 1 (Dhaka, costs $60).
    await emitAck(B, 'player:rolled', { playerId: 2, _testForcedDice: [0, 1] });
    await emitAck(B, 'player:moved', { playerId: 2, actionId: newActionId() });
    // P2 buys tile 1
    const buyTile1 = await emitAck(B, 'property:bought', { playerId: 2, tileId: 1, actionId: newActionId() });
    check('P2 bought tile 1', !!(buyTile1 && buyTile1.ok));
    await emitAck(B, 'turn:ended', { playerId: 2 });

    // P3 ends turn
    await emitAck(C, 'turn:ended', { playerId: 3 });

    // Now it is P1's turn again!
    let state = await syncState(A);
    check('Turn returned to P1', state?.currentTurnPlayerId === 1);
    check('P1 owns tile 2', state?.propertyOwnership?.[2] === 1);
    check('P2 owns tile 1', state?.propertyOwnership?.[1] === 2);

    // P1 rolls to tile 1 (owned by P2). From tile 2, 39 spaces wraps to tile 1: (2 + 39) % 40 = 1.
    // (Note: passing GO awards $200 salary, so we drain money AFTER moving onto tile 1).
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [19, 20] });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });

    state = await syncState(A);
    check('P1 is on tile 1 (owned by P2)', playerIn(state, 1)?.position === 1);

    // P1 transfers almost all money to P3 via trade so P1 cannot afford rent ($10 on tile 1)
    const p1Money = playerIn(state, 1)?.money || 1600;
    const tradeId = 'drain-p1';
    await emitAck(A, 'trade:created', {
      id: tradeId, initiatorId: 1, targetId: 3,
      initiatorMoney: p1Money - 1, targetMoney: 0,
      initiatorPropertyIds: [], targetPropertyIds: [],
      status: 'pending', createdAt: Date.now(),
    });
    await emitAck(C, 'trade:accepted', {
      trade: {
        id: tradeId, initiatorId: 1, targetId: 3,
        initiatorMoney: p1Money - 1, targetMoney: 0,
        initiatorPropertyIds: [], targetPropertyIds: [],
      },
      actionId: newActionId(),
    });

    state = await syncState(A);
    const p1AfterTrade = playerIn(state, 1);
    check('P1 money drained to $1', p1AfterTrade && p1AfterTrade.money === 1, `money=${p1AfterTrade?.money}`);

    // Listen for events
    const rentPaidPromise = waitFor(B, 'rent:paid');
    const bankruptPromise = waitFor(B, 'player:bankrupt');
    const turnChangePromise = waitFor(B, 'turn:changed');

    // P1 pays rent on tile 1 (rent is $10, P1 has $1).
    const rentRes = await emitAck(A, 'rent:paid', {
      payerId: 1, ownerId: 2, tileId: 1, actionId: newActionId(),
    });
    check('rent:paid settled with isBankrupt: true', rentRes && rentRes.ok && rentRes.isBankrupt === true, JSON.stringify(rentRes));

    const rentEvt = await rentPaidPromise;
    check('rent:paid broadcast indicates bankruptcy and creditorId 2', rentEvt && rentEvt.isBankrupt === true && rentEvt.creditorId === 2);

    const bankEvt = await bankruptPromise;
    check('player:bankrupt carries creditorId 2 and reason rent', bankEvt && bankEvt.creditorId === 2 && bankEvt.reason === 'rent');

    const turnEvt = await turnChangePromise;
    check('turn advanced to P2 following rent bankruptcy', turnEvt && turnEvt.currentTurnPlayerId === 2);

    // Check authoritative ownership and balance state
    state = await syncState(B);
    const p1Final = playerIn(state, 1);
    check('P1 is bankrupt with $0 balance', p1Final && p1Final.isBankrupt === true && p1Final.money === 0);
    check('P1\'s property (tile 2) transferred to creditor P2', state?.propertyOwnership?.[2] === 2);
    check('P2 still owns tile 1', state?.propertyOwnership?.[1] === 2);
    check('Authoritative turn is on P2', state?.currentTurnPlayerId === 2);

    // Item 2 duplicate/replayed rent charge cannot execute again
    const replayRent = await emitAck(A, 'rent:paid', {
      payerId: 1, ownerId: 2, tileId: 1, actionId: newActionId(),
    });
    check('bankrupt payer cannot pay rent again (PLAYER_OUT)', replayRent && replayRent.ok === false && replayRent.code === 'PLAYER_OUT', JSON.stringify(replayRent));

    await cleanupRoom(A, roomId);
  }

  console.log('\n--- TEST GROUP 3: TAX & CLUB-FEE BANKRUPTCY TURN PROGRESSION ---');
  {
    // Tax bankruptcy
    const A = track(await connect());
    const B = track(await connect());
    const C = track(await connect());

    const c1 = await emitAck(A, 'room:create', { name: 'Alice' });
    const roomId = c1.roomId;
    const tokenA = c1.token;

    const j2 = await emitAck(B, 'room:join', { roomId, name: 'Bob' });
    const tokenB = j2.token;

    const j3 = await emitAck(C, 'room:join', { roomId, name: 'Carol' });
    const tokenC = j3.token;

    await emitAck(A, 'player:identify', { roomId, token: tokenA, playerId: 1 });
    await emitAck(B, 'player:identify', { roomId, token: tokenB, playerId: 2 });
    await emitAck(C, 'player:identify', { roomId, token: tokenC, playerId: 3 });

    // P1 drains money to $10 via trade
    const tradeId = 'drain-tax';
    await emitAck(A, 'trade:created', {
      id: tradeId, initiatorId: 1, targetId: 2,
      initiatorMoney: 1490, targetMoney: 0,
      initiatorPropertyIds: [], targetPropertyIds: [],
      status: 'pending', createdAt: Date.now(),
    });
    await emitAck(B, 'trade:accepted', {
      trade: {
        id: tradeId, initiatorId: 1, targetId: 2,
        initiatorMoney: 1490, targetMoney: 0,
        initiatorPropertyIds: [], targetPropertyIds: [],
      },
      actionId: newActionId(),
    });

    // Tile 7 is TAX on the board. P1 rolls [3, 4] = 7 -> lands on tile 7.
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [3, 4] });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });

    const turnChangePromise = waitFor(B, 'turn:changed');
    const bankruptPromise = waitFor(B, 'player:bankrupt');

    // Pay tax with $10 < $200
    const taxRes = await emitAck(A, 'tax:pay', { playerId: 1, actionId: newActionId() });
    check('tax:pay acknowledged with isBankrupt: true', taxRes && taxRes.ok && taxRes.isBankrupt === true, JSON.stringify(taxRes));

    const bankEvt = await bankruptPromise;
    check('player:bankrupt emitted for tax bankruptcy', bankEvt && bankEvt.playerId === 1 && bankEvt.reason === 'tax');

    const turnEvt = await turnChangePromise;
    check('tax bankruptcy advanced turn to P2', turnEvt && turnEvt.currentTurnPlayerId === 2);

    let state = await syncState(B);
    check('P1 is bankrupt on server after tax', playerIn(state, 1)?.isBankrupt === true);
    check('P2 owns turn after P1 tax bankruptcy', state?.currentTurnPlayerId === 2);

    // P2 can take turn without P1 needing to emit turn:ended
    const p2Roll = await emitAck(B, 'player:rolled', { playerId: 2, _testForcedDice: [1, 2] });
    check('P2 can immediately roll on their turn', !!(p2Roll && p2Roll.ok), JSON.stringify(p2Roll));

    await cleanupRoom(A, roomId);
  }

  {
    // Club fee bankruptcy
    const A = track(await connect());
    const B = track(await connect());
    const C = track(await connect());

    const c1 = await emitAck(A, 'room:create', { name: 'Alice' });
    const roomId = c1.roomId;
    const tokenA = c1.token;

    const j2 = await emitAck(B, 'room:join', { roomId, name: 'Bob' });
    const tokenB = j2.token;

    const j3 = await emitAck(C, 'room:join', { roomId, name: 'Carol' });
    const tokenC = j3.token;

    await emitAck(A, 'player:identify', { roomId, token: tokenA, playerId: 1 });
    await emitAck(B, 'player:identify', { roomId, token: tokenB, playerId: 2 });
    await emitAck(C, 'player:identify', { roomId, token: tokenC, playerId: 3 });

    // P1 drains money to $10
    const tradeId = 'drain-club';
    await emitAck(A, 'trade:created', {
      id: tradeId, initiatorId: 1, targetId: 2,
      initiatorMoney: 1490, targetMoney: 0,
      initiatorPropertyIds: [], targetPropertyIds: [],
      status: 'pending', createdAt: Date.now(),
    });
    await emitAck(B, 'trade:accepted', {
      trade: {
        id: tradeId, initiatorId: 1, targetId: 2,
        initiatorMoney: 1490, targetMoney: 0,
        initiatorPropertyIds: [], targetPropertyIds: [],
      },
      actionId: newActionId(),
    });

    // P1 rolls [15, 15] = 30 -> lands on tile 30 (CLUB)
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [15, 15] });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });

    const turnChangePromise = waitFor(B, 'turn:changed');
    const bankruptPromise = waitFor(B, 'player:bankrupt');

    const clubRes = await emitAck(A, 'club:pay', { playerId: 1, actionId: newActionId() });
    check('club:pay acknowledged with isBankrupt: true', clubRes && clubRes.ok && clubRes.isBankrupt === true, JSON.stringify(clubRes));

    const bankEvt = await bankruptPromise;
    check('player:bankrupt emitted for club fee bankruptcy', bankEvt && bankEvt.playerId === 1 && bankEvt.reason === 'club');

    const turnEvt = await turnChangePromise;
    check('club bankruptcy advanced turn to P2', turnEvt && turnEvt.currentTurnPlayerId === 2);

    const state = await syncState(B);
    check('P1 is bankrupt on server after club fee', playerIn(state, 1)?.isBankrupt === true);
    check('P2 owns turn after P1 club fee bankruptcy', state?.currentTurnPlayerId === 2);

    await cleanupRoom(A, roomId);
  }

  console.log('\n--- TEST GROUP 4: SERVER-AUTHORITATIVE VOTE-KICK ---');
  {
    // Setup 3-player room: P1 (host), P2, P3
    const A = track(await connect());
    const B = track(await connect());
    const C = track(await connect());

    const c1 = await emitAck(A, 'room:create', { name: 'Alice' });
    const roomId = c1.roomId;
    const tokenA = c1.token;

    const j2 = await emitAck(B, 'room:join', { roomId, name: 'Bob' });
    const tokenB = j2.token;

    const j3 = await emitAck(C, 'room:join', { roomId, name: 'Carol' });
    const tokenC = j3.token;

    await emitAck(A, 'player:identify', { roomId, token: tokenA, playerId: 1 });
    await emitAck(B, 'player:identify', { roomId, token: tokenB, playerId: 2 });
    await emitAck(C, 'player:identify', { roomId, token: tokenC, playerId: 3 });

    // Item 9: Non-authorized direct kick attempts are rejected
    const directKickByGuest = await emitAck(B, 'player:kicked', { playerId: 3 });
    check('non-host direct kick attempt rejected with NOT_HOST', directKickByGuest && directKickByGuest.ok === false && directKickByGuest.code === 'NOT_HOST', JSON.stringify(directKickByGuest));

    // Item 7: Cannot vote for self
    const voteSelf = await emitAck(A, 'player:kick-vote', { targetId: 1 });
    check('player cannot vote to kick themselves', voteSelf && voteSelf.ok === false && voteSelf.code === 'CANNOT_VOTE_SELF', JSON.stringify(voteSelf));

    // Item 6: Vote counts synchronize across connected clients
    const p2VotePromise = waitFor(B, 'player:kick-vote');
    const p3VotePromise = waitFor(C, 'player:kick-vote');

    const vote1 = await emitAck(A, 'player:kick-vote', { targetId: 3, vote: true });
    check('P1 vote for P3 acknowledged with voteCount: 1', vote1 && vote1.ok && vote1.voteCount === 1 && vote1.threshold === 2, JSON.stringify(vote1));

    const p2VoteEvt = await p2VotePromise;
    check('P2 received vote-kick update (voteCount=1, threshold=2)', p2VoteEvt && p2VoteEvt.targetId === 3 && p2VoteEvt.voteCount === 1 && p2VoteEvt.threshold === 2);

    const p3VoteEvt = await p3VotePromise;
    check('target P3 also received vote-kick update', p3VoteEvt && p3VoteEvt.targetId === 3 && p3VoteEvt.voteCount === 1);

    // Item 7: Cannot vote more than once (duplicate vote check)
    const voteDup = await emitAck(A, 'player:kick-vote', { targetId: 3, vote: true });
    check('duplicate vote by P1 does not increment count beyond 1', voteDup && voteDup.ok && voteDup.voteCount === 1);

    // Item 8: Vote-kick threshold removes target exactly once and updates every client
    const p1KickedPromise = waitFor(A, 'player:kicked');
    const p2KickedPromise = waitFor(B, 'player:kicked');
    const p3KickedPromise = waitFor(C, 'player:kicked');
    const p3BankruptPromise = waitFor(C, 'player:bankrupt');

    // P2 casts 2nd vote (2/2 reaches threshold)
    const vote2 = await emitAck(B, 'player:kick-vote', { targetId: 3, vote: true });
    check('P2 vote for P3 acknowledged', vote2 && vote2.ok);

    const p1Kicked = await p1KickedPromise;
    const p2Kicked = await p2KickedPromise;
    const p3Kicked = await p3KickedPromise;
    const p3Bankrupt = await p3BankruptPromise;

    check('P1 received player:kicked broadcast for target 3', p1Kicked && (p1Kicked.playerId === 3 || p1Kicked.targetId === 3));
    check('P2 received player:kicked broadcast for target 3', p2Kicked && (p2Kicked.playerId === 3 || p2Kicked.targetId === 3));
    check('P3 received player:kicked broadcast', p3Kicked && (p3Kicked.playerId === 3 || p3Kicked.targetId === 3));
    check('P3 received player:bankrupt broadcast with reason vote-kick', p3Bankrupt && p3Bankrupt.playerId === 3 && p3Bankrupt.reason === 'vote-kick');

    const state = await syncState(A);
    const p3Final = playerIn(state, 3);
    check('target P3 is marked bankrupt on server', p3Final && p3Final.isBankrupt === true);

    await cleanupRoom(A, roomId);
  }

  console.log('\n--- TEST GROUP 5: PENDING TRADES CANCELED ON ELIMINATION ---');
  {
    // Item 10: Pending trades involving an eliminated player are canceled
    const A = track(await connect());
    const B = track(await connect());
    const C = track(await connect());

    const c1 = await emitAck(A, 'room:create', { name: 'Alice' });
    const roomId = c1.roomId;
    const tokenA = c1.token;

    const j2 = await emitAck(B, 'room:join', { roomId, name: 'Bob' });
    const tokenB = j2.token;

    const j3 = await emitAck(C, 'room:join', { roomId, name: 'Carol' });
    const tokenC = j3.token;

    await emitAck(A, 'player:identify', { roomId, token: tokenA, playerId: 1 });
    await emitAck(B, 'player:identify', { roomId, token: tokenB, playerId: 2 });
    await emitAck(C, 'player:identify', { roomId, token: tokenC, playerId: 3 });

    // P1 rolls to start game
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [1, 2] });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });

    // P1 proposes trade to P2
    const tradeId = 'pending-trade-elim';
    const tradeOk = await emitAck(A, 'trade:created', {
      id: tradeId, initiatorId: 1, targetId: 2,
      initiatorMoney: 100, targetMoney: 0,
      initiatorPropertyIds: [], targetPropertyIds: [],
      status: 'pending', createdAt: Date.now(),
    });
    check('trade created between P1 and P2', !!(tradeOk && tradeOk.ok));

    let state = await syncState(A);
    check('trade exists in room state', (state?.trades || []).some((t) => t.id === tradeId));

    // Listen for trade:cancelled on P1
    const tradeCancelPromise = waitFor(A, 'trade:cancelled');

    // P2 is eliminated via voluntary bankruptcy
    await emitAck(B, 'player:bankrupt', { playerId: 2, actionId: newActionId() });

    const cancelEvt = await tradeCancelPromise;
    check('trade:cancelled received for the pending trade', cancelEvt && cancelEvt.tradeId === tradeId);

    state = await syncState(A);
    check('trade is removed from server room.trades', !(state?.trades || []).some((t) => t.id === tradeId));

    await cleanupRoom(A, roomId);
  }

  console.log('\n--- TEST GROUP 6: BANKRUPTCY DURING AUCTION ---');
  {
    // Item 11: Bankruptcy during auction does not leave invalid winner or stuck auction
    const A = track(await connect());
    const B = track(await connect());
    const C = track(await connect());

    const c1 = await emitAck(A, 'room:create', { name: 'Alice' });
    const roomId = c1.roomId;
    const tokenA = c1.token;

    const j2 = await emitAck(B, 'room:join', { roomId, name: 'Bob' });
    const tokenB = j2.token;

    const j3 = await emitAck(C, 'room:join', { roomId, name: 'Carol' });
    const tokenC = j3.token;

    await emitAck(A, 'player:identify', { roomId, token: tokenA, playerId: 1 });
    await emitAck(B, 'player:identify', { roomId, token: tokenB, playerId: 2 });
    await emitAck(C, 'player:identify', { roomId, token: tokenC, playerId: 3 });

    // P1 rolls to start game
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [1, 2] });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });

    // P1 opens auction for tile 1
    const auctionId = `auc-${Date.now()}`;
    const aucStart = await emitAck(A, 'auction:start', {
      playerId: 1,
      auction: { id: auctionId, tileId: 1, currentBid: 10, highestBidderId: null },
    });
    check('auction started for tile 1', !!(aucStart && aucStart.ok));

    // P2 bids $100
    const bidRes = await emitAck(B, 'auction:bid', {
      auction: { id: auctionId, tileId: 1, currentBid: 100 },
    });
    check('P2 bid $100 accepted', !!(bidRes && bidRes.ok && bidRes.currentBid === 100));

    let state = await syncState(A);
    check('P2 is highest bidder in activeAuction', state?.activeAuction?.highestBidderId === 2);

    // P2 goes bankrupt while being highest bidder
    await emitAck(B, 'player:bankrupt', { playerId: 2, actionId: newActionId() });

    state = await syncState(A);
    check('P2 is marked bankrupt', playerIn(state, 2)?.isBankrupt === true);
    check('activeAuction cleared P2 as highest bidder', state?.activeAuction?.highestBidderId === null);
    check('auction currentBid reset to 0', state?.activeAuction?.currentBid === 0);

    // P3 now bids $50
    const p3Bid = await emitAck(C, 'auction:bid', {
      auction: { id: auctionId, tileId: 1, currentBid: 50 },
    });
    check('P3 can place valid bid after bankrupt bidder cleared', !!(p3Bid && p3Bid.ok && p3Bid.currentBid === 50));

    // Settle auction via auction:end
    const endPromise = waitFor(A, 'auction:end');
    const aucEnd = await emitAck(C, 'auction:end', {
      auction: { id: auctionId },
      actionId: newActionId(),
    });
    check('auction:end succeeded', !!(aucEnd && aucEnd.ok));

    const endEvt = await endPromise;
    check('auction ended with P3 as valid winner', endEvt && endEvt.winnerId === 3);

    state = await syncState(A);
    check('P3 was awarded tile 1', state?.propertyOwnership?.[1] === 3);
    check('auction is no longer active', state?.activeAuction === null);

    await cleanupRoom(A, roomId);
  }

  await closeAllSockets();

  console.log(`\n================================================`);
  console.log(`RESULTS: ${results.length - failed}/${results.length} checks passed`);
  console.log(`================================================`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error('TEST ERROR:', err);
  await closeAllSockets();
  process.exit(1);
});
