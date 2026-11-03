// Regression and integration test suite for BUG-06:
// High Auction Bidder Disconnect & Payment Handling.
//
// Verifies:
//   1. Highest bidder disconnect: clears bidder ID, resets currentBid to 0, resets timeLeft to 15s,
//      re-arms auction timer, and emits 'auction:reopened' instead of a fake bid.
//   2. Remaining players can bid after leader disconnect, and winning bidder pays correctly.
//   3. Disconnect when all remaining rivals have passed settles auction as no-sale (no ownership/payment).
//   4. turn:ended is rejected with error code 'AUCTION_IN_PROGRESS' while room.activeAuction exists,
//      and permitted once the auction settles.
//   5. Auction state restoration after reconnect preserves the reset auction state.
//   6. Multiple bidder disconnects ensure no incorrect payment or ownership transfer.
//
// Run against a live test server:
//   SERVER_URL=http://localhost:3099 node test-auction-disconnect.js
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

const waitFor = (socket, event, ms = 3500) =>
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
const newActionId = () => `auc-dis-${Date.now()}-${++actionSeq}`;

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
  // =========================================================================
  // TEST GROUP 1: LEADER DISCONNECT WITH MULTIPLE ACTIVE BIDDERS & TIMER RESET
  // =========================================================================
  console.log('\n--- TEST GROUP 1: LEADER DISCONNECT WITH MULTIPLE ACTIVE BIDDERS ---');
  {
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

    // P1 rolls to start the game
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [1, 2] });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });

    // P1 opens auction for tile 2 (Normandy, ownable)
    const auctionId = `auc-grp1-${Date.now()}`;
    const openRes = await emitAck(A, 'auction:start', {
      playerId: 1,
      auction: { id: auctionId, tileId: 2, currentBid: 0, highestBidderId: null, passedPlayerIds: [] },
    });
    check('G1: auction started for tile 2', !!(openRes && openRes.ok));

    // P2 bids $50 -> P2 is leading bidder
    const bidRes = await emitAck(B, 'auction:bid', {
      auction: { id: auctionId, tileId: 2, currentBid: 50 },
    });
    check('G1: P2 placed $50 bid', !!(bidRes && bidRes.ok && bidRes.currentBid === 50));

    let state = await syncState(A);
    check('G1: P2 is highest bidder in room state', state?.activeAuction?.highestBidderId === 2);
    check('G1: currentBid is $50', state?.activeAuction?.currentBid === 50);

    // Setup listener on client A & C for auction:reopened
    const reopenPromiseA = waitFor(A, 'auction:reopened');
    const reopenPromiseC = waitFor(C, 'auction:reopened');

    // Bob (P2, highest bidder) disconnects while auction is active
    B.disconnect();

    const reopenEvtA = await reopenPromiseA;
    const reopenEvtC = await reopenPromiseC;
    check('G1: auction:reopened broadcast to client A', !!reopenEvtA);
    check('G1: auction:reopened broadcast to client C', !!reopenEvtC);
    check('G1: previousLeaderId is 2', reopenEvtA?.previousLeaderId === 2);
    check('G1: activeAuction highestBidderId cleared to null', reopenEvtA?.auction?.highestBidderId === null);
    check('G1: activeAuction currentBid reset to opening amount (0)', reopenEvtA?.auction?.currentBid === 0);
    check('G1: activeAuction timeLeft reset to 15s', reopenEvtA?.auction?.timeLeft === 15);

    // Verify server state
    state = await syncState(A);
    check('G1: P2 eliminated / bankrupt', playerIn(state, 2)?.isBankrupt === true);
    check('G1: server activeAuction highestBidderId is null', state?.activeAuction?.highestBidderId === null);
    check('G1: server activeAuction currentBid is 0', state?.activeAuction?.currentBid === 0);
    check('G1: server activeAuction passedPlayerIds includes P2', state?.activeAuction?.passedPlayerIds?.includes(2));

    // Verify timer is re-armed and ticking: wait for auction:tick
    const tickEvt = await waitFor(A, 'auction:tick', 3000);
    check('G1: timer re-armed (auction:tick received)', !!tickEvt && typeof tickEvt.auction?.timeLeft === 'number');

    // Verify remaining player C can place a valid bid
    const cBid = await emitAck(C, 'auction:bid', {
      auction: { id: auctionId, tileId: 2, currentBid: 40 },
    });
    check('G1: remaining player C can bid after reopen', !!(cBid && cBid.ok && cBid.currentBid === 40));

    state = await syncState(A);
    check('G1: C is now leading bidder ($40)', state?.activeAuction?.highestBidderId === 3 && state?.activeAuction?.currentBid === 40);

    // End auction via auction:end
    const endPromise = waitFor(A, 'auction:end');
    const endAck = await emitAck(A, 'auction:end', {
      auction: { id: auctionId },
      actionId: newActionId(),
    });
    check('G1: auction:end acknowledged', !!(endAck && endAck.ok));

    const endEvt = await endPromise;
    check('G1: C won auction for tile 2', endEvt?.winnerId === 3 && endEvt?.currentBid === 40);
    check('G1: winnerMoney matches server balance ($1460)', endEvt?.winnerMoney === 1460);

    state = await syncState(A);
    check('G1: tile 2 owned by C (3)', state?.propertyOwnership?.[2] === 3);
    check('G1: C charged $40 ($1460 remaining)', playerIn(state, 3)?.money === 1460);
    check('G1: P2 is eliminated and does not own tile 2', state?.propertyOwnership?.[2] !== 2);
    check('G1: P1 was NOT charged ($1500)', playerIn(state, 1)?.money === 1500);

    await cleanupRoom(A, roomId);
  }

  // =========================================================================
  // TEST GROUP 2: DISCONNECT WHEN ALL REMAINING RIVALS HAVE PASSED (NO-SALE)
  // =========================================================================
  console.log('\n--- TEST GROUP 2: DISCONNECT WHEN ALL REMAINING RIVALS HAVE PASSED ---');
  {
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

    // P1 rolls & moves
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [1, 2] });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });

    // P1 starts auction for tile 6
    const auctionId = `auc-grp2-${Date.now()}`;
    await emitAck(A, 'auction:start', {
      playerId: 1,
      auction: { id: auctionId, tileId: 6, currentBid: 0, highestBidderId: null, passedPlayerIds: [] },
    });

    // P2 bids $80
    await emitAck(B, 'auction:bid', {
      auction: { id: auctionId, tileId: 6, currentBid: 80 },
    });

    // P1 passes
    await emitAck(A, 'auction:pass', {
      auction: { id: auctionId },
    });

    // P3 passes
    await emitAck(C, 'auction:pass', {
      auction: { id: auctionId },
    });

    // Now all remaining rivals (P1 and P3) have passed!
    // Set up auction:end listener on A
    const endPromise = waitFor(A, 'auction:end');

    // Bob (P2, the sole remaining active bidder and highest bidder) disconnects
    B.disconnect();

    const endEvt = await endPromise;
    check('G2: auction auto-settled with auction:end on leader disconnect', !!endEvt);
    check('G2: auction ended with NO winner (winnerId is null)', endEvt?.winnerId === null);
    check('G2: winnerMoney is null', endEvt?.winnerMoney === null);

    const state = await syncState(A);
    check('G2: tile 6 remains unowned', state?.propertyOwnership?.[6] === undefined);
    check('G2: activeAuction is cleared (null)', state?.activeAuction === null);
    check('G2: P1 money untouched ($1500)', playerIn(state, 1)?.money === 1500);
    check('G2: P3 money untouched ($1500)', playerIn(state, 3)?.money === 1500);
    check('G2: P2 is eliminated and does not own tile 6', state?.propertyOwnership?.[6] !== 2);

    await cleanupRoom(A, roomId);
  }

  // =========================================================================
  // TEST GROUP 3: PREVENT TURN ADVANCEMENT DURING AUCTIONS (AUCTION_IN_PROGRESS)
  // =========================================================================
  console.log('\n--- TEST GROUP 3: PREVENT TURN ADVANCEMENT DURING AUCTIONS ---');
  {
    const A = track(await connect());
    const B = track(await connect());

    const c1 = await emitAck(A, 'room:create', { name: 'Alice' });
    const roomId = c1.roomId;
    const tokenA = c1.token;

    const j2 = await emitAck(B, 'room:join', { roomId, name: 'Bob' });
    const tokenB = j2.token;

    await emitAck(A, 'player:identify', { roomId, token: tokenA, playerId: 1 });
    await emitAck(B, 'player:identify', { roomId, token: tokenB, playerId: 2 });

    // P1 rolls & moves (it is P1's turn)
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [1, 2] });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });

    let state = await syncState(A);
    check('G3: P1 has current turn', state?.currentTurnPlayerId === 1);

    // P1 starts auction on tile 8
    const auctionId = `auc-grp3-${Date.now()}`;
    await emitAck(A, 'auction:start', {
      playerId: 1,
      auction: { id: auctionId, tileId: 8, currentBid: 0, highestBidderId: null, passedPlayerIds: [] },
    });

    state = await syncState(A);
    check('G3: auction is active', state?.activeAuction !== null);

    // P1 (current turn player) attempts to end turn while auction is active
    const turnEndAttempt1 = await emitAck(A, 'turn:ended', { playerId: 1 });
    check('G3: turn:ended rejected for current player while auction active', turnEndAttempt1?.ok === false);
    check('G3: error code is AUCTION_IN_PROGRESS', turnEndAttempt1?.code === 'AUCTION_IN_PROGRESS');

    // P2 (non-turn player) attempts to end turn while auction is active
    const turnEndAttempt2 = await emitAck(B, 'turn:ended', { playerId: 2 });
    check('G3: turn:ended rejected for non-turn player while auction active', turnEndAttempt2?.ok === false);
    check('G3: non-turn player also rejected with AUCTION_IN_PROGRESS', turnEndAttempt2?.code === 'AUCTION_IN_PROGRESS');

    // Turn did NOT advance
    state = await syncState(A);
    check('G3: currentTurnPlayerId is still P1', state?.currentTurnPlayerId === 1);

    // End/settle auction
    await emitAck(B, 'auction:bid', {
      auction: { id: auctionId, tileId: 8, currentBid: 30 },
    });
    await emitAck(A, 'auction:end', {
      auction: { id: auctionId },
      actionId: newActionId(),
    });

    state = await syncState(A);
    check('G3: auction settled and cleared', state?.activeAuction === null);

    // P1 ends turn legally after auction settlement
    const legalTurnEnd = await emitAck(A, 'turn:ended', { playerId: 1 });
    check('G3: turn:ended succeeds once auction has settled', !!(legalTurnEnd && legalTurnEnd.ok));

    state = await syncState(A);
    check('G3: turn advanced to P2', state?.currentTurnPlayerId === 2);

    await cleanupRoom(A, roomId);
  }

  // =========================================================================
  // TEST GROUP 4: AUCTION STATE RESTORATION AFTER RECONNECT
  // =========================================================================
  console.log('\n--- TEST GROUP 4: AUCTION STATE RESTORATION AFTER RECONNECT ---');
  {
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

    // P1 rolls & moves
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [1, 2] });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });

    // P1 opens auction for tile 11
    const auctionId = `auc-grp4-${Date.now()}`;
    await emitAck(A, 'auction:start', {
      playerId: 1,
      auction: { id: auctionId, tileId: 11, currentBid: 0, highestBidderId: null, passedPlayerIds: [] },
    });

    // P2 bids $100
    await emitAck(B, 'auction:bid', {
      auction: { id: auctionId, tileId: 11, currentBid: 100 },
    });

    // P2 disconnects (eliminated as leader)
    B.disconnect();
    await sleep(200);

    // C reconnects on a fresh socket presenting tokenC (page refresh pattern, see test-restore-integration.js)
    const C2 = track(await connect());
    const cRejoin = await emitAck(C2, 'player:rejoin', { roomId, token: tokenC });
    check('G4: C reconnected and rejoined room', !!(cRejoin && cRejoin.ok && cRejoin.rejoined));

    await emitAck(C2, 'player:identify', { roomId, token: tokenC, playerId: 3 });

    const restoredState = await syncState(C2);
    check('G4: activeAuction restored on reconnected client', !!restoredState?.activeAuction);
    check('G4: restored auction tileId is 11', restoredState?.activeAuction?.tileId === 11);
    check('G4: restored auction highestBidderId is null', restoredState?.activeAuction?.highestBidderId === null);
    check('G4: restored auction currentBid is 0', restoredState?.activeAuction?.currentBid === 0);
    check('G4: restored auction passedPlayerIds contains P2', restoredState?.activeAuction?.passedPlayerIds?.includes(2));
    check('G4: restored auction timeLeft is positive', (restoredState?.activeAuction?.timeLeft || 0) > 0);

    // Reconnected player C can place a bid on the restored auction
    const bidAfterReconnect = await emitAck(C2, 'auction:bid', {
      auction: { id: auctionId, tileId: 11, currentBid: 45 },
    });
    check('G4: reconnected player C placed bid $45', !!(bidAfterReconnect && bidAfterReconnect.ok));

    await cleanupRoom(A, roomId);
  }

  // =========================================================================
  // TEST GROUP 5: MULTIPLE BIDDER DISCONNECTS & NO INCORRECT CHARGES
  // =========================================================================
  console.log('\n--- TEST GROUP 5: MULTIPLE BIDDER DISCONNECTS & NO INCORRECT CHARGES ---');
  {
    const A = track(await connect());
    const B = track(await connect());
    const C = track(await connect());
    const D = track(await connect());

    const c1 = await emitAck(A, 'room:create', { name: 'Alice' });
    const roomId = c1.roomId;
    const tokenA = c1.token;

    const j2 = await emitAck(B, 'room:join', { roomId, name: 'Bob' });
    const tokenB = j2.token;

    const j3 = await emitAck(C, 'room:join', { roomId, name: 'Carol' });
    const tokenC = j3.token;

    const j4 = await emitAck(D, 'room:join', { roomId, name: 'Dave' });
    const tokenD = j4.token;

    await emitAck(A, 'player:identify', { roomId, token: tokenA, playerId: 1 });
    await emitAck(B, 'player:identify', { roomId, token: tokenB, playerId: 2 });
    await emitAck(C, 'player:identify', { roomId, token: tokenC, playerId: 3 });
    await emitAck(D, 'player:identify', { roomId, token: tokenD, playerId: 4 });

    // P1 rolls & moves
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [1, 2] });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });

    // P1 opens auction for tile 13
    const auctionId = `auc-grp5-${Date.now()}`;
    await emitAck(A, 'auction:start', {
      playerId: 1,
      auction: { id: auctionId, tileId: 13, currentBid: 0, highestBidderId: null, passedPlayerIds: [] },
    });

    // P2 bids $50
    await emitAck(B, 'auction:bid', {
      auction: { id: auctionId, tileId: 13, currentBid: 50 },
    });

    // P3 bids $70 (P3 is leader)
    await emitAck(C, 'auction:bid', {
      auction: { id: auctionId, tileId: 13, currentBid: 70 },
    });

    // P3 (first leader) disconnects!
    const reopenP1 = waitFor(A, 'auction:reopened');
    C.disconnect();
    const rEvt1 = await reopenP1;
    check('G5: first leader C disconnected and auction reopened', !!rEvt1 && rEvt1.previousLeaderId === 3);

    // P4 bids $80 (P4 is new leader)
    const dRes = await emitAck(D, 'auction:bid', {
      auction: { id: auctionId, tileId: 13, currentBid: 80 },
    });
    check('G5: P4 placed bid $80 after first reopen', !!(dRes && dRes.ok && dRes.currentBid === 80));

    // P4 (second leader) disconnects!
    const reopenP2 = waitFor(A, 'auction:reopened');
    D.disconnect();
    const rEvt2 = await reopenP2;
    check('G5: second leader D disconnected and auction reopened', !!rEvt2 && rEvt2.previousLeaderId === 4);

    // P2 bids $90 (P2 is final leader)
    const bFinal = await emitAck(B, 'auction:bid', {
      auction: { id: auctionId, tileId: 13, currentBid: 90 },
    });
    check('G5: P2 placed final bid $90 after second reopen', !!(bFinal && bFinal.ok && bFinal.currentBid === 90));

    // P1 passes
    await emitAck(A, 'auction:pass', {
      auction: { id: auctionId },
    });

    // Settle auction via auction:end
    const endPromise = waitFor(A, 'auction:end');
    await emitAck(A, 'auction:end', {
      auction: { id: auctionId },
      actionId: newActionId(),
    });

    const endEvt = await endPromise;
    check('G5: P2 won auction for $90', endEvt?.winnerId === 2 && endEvt?.currentBid === 90);
    check('G5: P2 winnerMoney is $1410', endEvt?.winnerMoney === 1410);

    const state = await syncState(A);
    check('G5: tile 13 owned by P2', state?.propertyOwnership?.[13] === 2);
    check('G5: P2 balance deducted exactly once ($1410)', playerIn(state, 2)?.money === 1410);
    check('G5: P3 (disconnected) was eliminated and does not own tile 13', state?.propertyOwnership?.[13] !== 3 && playerIn(state, 3)?.isBankrupt === true);
    check('G5: D (disconnected) was eliminated and does not own tile 13', state?.propertyOwnership?.[13] !== 4 && playerIn(state, 4)?.isBankrupt === true);
    check('G5: P1 was NOT charged ($1500)', playerIn(state, 1)?.money === 1500);

    await cleanupRoom(A, roomId);
  }

  // =========================================================================
  // TEST GROUP 6: SOLE SURVIVOR WIN WHEN ALL OTHER BIDDERS DISCONNECT
  // =========================================================================
  console.log('\n--- TEST GROUP 6: SOLE SURVIVOR ON AUCTION LEADER DISCONNECT ---');
  {
    const A = track(await connect());
    const B = track(await connect());

    const c1 = await emitAck(A, 'room:create', { name: 'Alice' });
    const roomId = c1.roomId;
    const tokenA = c1.token;

    const j2 = await emitAck(B, 'room:join', { roomId, name: 'Bob' });
    const tokenB = j2.token;

    await emitAck(A, 'player:identify', { roomId, token: tokenA, playerId: 1 });
    await emitAck(B, 'player:identify', { roomId, token: tokenB, playerId: 2 });

    // P1 rolls & moves
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [1, 2] });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });

    // P1 opens auction for tile 16
    const auctionId = `auc-grp6-${Date.now()}`;
    await emitAck(A, 'auction:start', {
      playerId: 1,
      auction: { id: auctionId, tileId: 16, currentBid: 0, highestBidderId: null, passedPlayerIds: [] },
    });

    // P2 bids $100 (P2 is leader)
    await emitAck(B, 'auction:bid', {
      auction: { id: auctionId, tileId: 16, currentBid: 100 },
    });

    // Bob disconnects -> Bob is eliminated.
    // Alice is sole survivor. Auction must settle with no-sale, tile 16 unowned,
    // and Alice declared winner of the game.
    const gameOverPromise = waitFor(A, 'game:over');
    B.disconnect();

    const goEvt = await gameOverPromise;
    check('G6: game:over declared with Alice as sole survivor', goEvt?.winnerId === 1);

    const state = await syncState(A);
    check('G6: tile 16 unowned', state?.propertyOwnership?.[16] === undefined);
    check('G6: activeAuction is cleared', state?.activeAuction === null);
    check('G6: Alice not charged for tile ($1500)', playerIn(state, 1)?.money === 1500);
    check('G6: Bob was eliminated and does not own tile 16', state?.propertyOwnership?.[16] !== 2);

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
