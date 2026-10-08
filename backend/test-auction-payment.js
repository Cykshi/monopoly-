// Focused AUCTION PAYMENT and SETTLEMENT test suite.
//
// Verifies the 6 auction settlement guarantees:
//   1. Identify the authoritative winning player (server highestBidderId, never client payload).
//   2. Verify the winning bid is affordable against winner's server money.
//   3. Deduct the winning bid from winner.money.
//   4. Assign the property only after successful payment.
//   5. Persist and broadcast the updated money + ownership.
//   6. Handle both auction timer completion and auction:end safely without double-charging.
//
// Also checks identity, turn, and actionId protections.
//
// Run against a live server:
//   SERVER_URL=http://localhost:3099 node test-auction-payment.js
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

let seq = 0;
const newActionId = () => `auc-act-${Date.now()}-${++seq}`;

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
  console.log(`\n=== SETUP: 2-PLAYER ROOM ===`);
  const A = track(await connect());
  const created = await emitAck(A, 'room:create', {});
  const roomId = created && created.roomId;
  const tokenA = created && created.token;
  check('setup: room created', !!(created && created.ok && roomId && tokenA));

  const B = track(await connect());
  const bJoin = await emitAck(B, 'room:join', { roomId });
  const tokenB = bJoin && bJoin.token;
  check('setup: player B joined', !!(bJoin && bJoin.ok && tokenB));

  const idA = await emitAck(A, 'player:identify', { roomId, token: tokenA, playerId: 1, name: 'Alice' });
  const idB = await emitAck(B, 'player:identify', { roomId, token: tokenB, playerId: 2, name: 'Bob' });
  check('setup: both players identified', !!(idA && idA.ok && idB && idB.ok));

  let state = await syncState(A);
  const p1InitMoney = playerIn(state, 1).money;
  const p2InitMoney = playerIn(state, 2).money;
  check('setup: starting balances are $1500', p1InitMoney === 1500 && p2InitMoney === 1500,
    `p1=${p1InitMoney} p2=${p2InitMoney}`);

  // ================= 1. EXPLICIT AUCTION:END WITH AFFORDABLE WINNING BID =================
  console.log(`\n=== 1. AUCTION:END DEDUCTS WINNING BID AND ASSIGNS OWNERSHIP ===`);
  // Player 1's turn can open an auction on unowned ownable tile 2 (Normandy, $100)
  const openAuc1 = await emitAck(A, 'auction:start', {
    playerId: 1,
    auction: { id: 'auc-leg-1', tileId: 2, currentBid: 0, highestBidderId: null, passedPlayerIds: [] },
  });
  check('auction 1 started on tile 2', !!(openAuc1 && openAuc1.ok), JSON.stringify(openAuc1));

  // Player 2 bids $120
  const bidB = await emitAck(B, 'auction:bid', {
    auction: { id: 'auc-leg-1', tileId: 2, currentBid: 120 },
  });
  check('player 2 places legal bid of $120', !!(bidB && bidB.ok && bidB.bidderId === 2));

  // Set up broadcast listener on client A to verify broadcast of money + ownership
  const aucEndBroadcastPromise = waitFor(A, 'auction:end');

  // End the auction via auction:end
  const actId1 = newActionId();
  const endAck1 = await emitAck(A, 'auction:end', {
    auction: { id: 'auc-leg-1' },
    actionId: actId1,
  });
  check('auction:end acks ok with winnerId=2', !!(endAck1 && endAck1.ok && endAck1.winnerId === 2), JSON.stringify(endAck1));
  check('auction:end ack reports updated winnerMoney ($1380)', endAck1 && endAck1.winnerMoney === 1380,
    `winnerMoney=${endAck1 && endAck1.winnerMoney}`);

  const broadcastEvt = await aucEndBroadcastPromise;
  check('auction:end event broadcast to peers', !!broadcastEvt, JSON.stringify(broadcastEvt));
  check('broadcast carries updated propertyOwnership with tile 2 owned by player 2',
    broadcastEvt && broadcastEvt.propertyOwnership && broadcastEvt.propertyOwnership[2] === 2,
    `owner=${broadcastEvt && broadcastEvt.propertyOwnership && broadcastEvt.propertyOwnership[2]}`);
  check('broadcast carries updated winnerMoney ($1380)', broadcastEvt && broadcastEvt.winnerMoney === 1380,
    `winnerMoney=${broadcastEvt && broadcastEvt.winnerMoney}`);

  state = await syncState(A);
  const p2MoneyAfter1 = playerIn(state, 2).money;
  const p1MoneyAfter1 = playerIn(state, 1).money;
  check('server balance for winner (player 2) deducted by exactly $120 (1500 -> 1380)',
    p2MoneyAfter1 === 1380, `p2.money=${p2MoneyAfter1}`);
  check('non-winner (player 1) money untouched ($1500)', p1MoneyAfter1 === 1500, `p1.money=${p1MoneyAfter1}`);
  check('tile 2 ownership assigned to player 2 in authoritative server state',
    state.propertyOwnership[2] === 2, `owner=${state.propertyOwnership[2]}`);

  // ================= 2. DOUBLE-CHARGING / REPLAY PROTECTION =================
  console.log(`\n=== 2. NO DOUBLE-CHARGING ON REPLAY OR SUBSEQUENT AUCTION:END ===`);
  // Replaying the exact same actionId must be rejected
  const replayAck = await emitAck(A, 'auction:end', {
    auction: { id: 'auc-leg-1' },
    actionId: actId1,
  });
  check('replayed auction:end with same actionId is refused (DUPLICATE_ACTION)',
    !!(replayAck && replayAck.ok === false && replayAck.code === 'DUPLICATE_ACTION'),
    JSON.stringify(replayAck));

  // A fresh call to auction:end when auction is already settled must be refused (NO_AUCTION)
  const duplicateAck = await emitAck(A, 'auction:end', {
    auction: { id: 'auc-leg-1' },
    actionId: newActionId(),
  });
  check('calling auction:end after auction already settled is refused (NO_AUCTION)',
    !!(duplicateAck && duplicateAck.ok === false && duplicateAck.code === 'NO_AUCTION'),
    JSON.stringify(duplicateAck));

  state = await syncState(A);
  check('winner balance remained $1380 (no double-charging)',
    playerIn(state, 2).money === 1380, `p2.money=${playerIn(state, 2).money}`);

  // ================= 3. AUTHORITATIVE WINNER: SPOOFED WINNER IN PAYLOAD IS IGNORED =================
  console.log(`\n=== 3. SPOOFED WINNER IN PAYLOAD CANNOT STEAL PROPERTY OR MONEY ===`);
  const openAuc2 = await emitAck(A, 'auction:start', {
    playerId: 1,
    auction: { id: 'auc-leg-2', tileId: 6, currentBid: 0, highestBidderId: null, passedPlayerIds: [] },
  });
  check('auction 2 started on tile 6', !!(openAuc2 && openAuc2.ok));

  // Player 1 bids $150
  const bidA2 = await emitAck(A, 'auction:bid', {
    auction: { id: 'auc-leg-2', tileId: 6, currentBid: 150 },
  });
  check('player 1 places real bid of $150', !!(bidA2 && bidA2.ok && bidA2.bidderId === 1));

  // Player 2 tries to end auction claiming Player 2 is highestBidderId
  const spoofEndAck = await emitAck(B, 'auction:end', {
    auction: { id: 'auc-leg-2', tileId: 6, highestBidderId: 2, currentBid: 5 },
  });
  check('spoofed winner payload is ignored — server awards to real bidder (player 1)',
    !!(spoofEndAck && spoofEndAck.ok && spoofEndAck.winnerId === 1), JSON.stringify(spoofEndAck));

  state = await syncState(A);
  const p1MoneyAfter2 = playerIn(state, 1).money;
  const p2MoneyAfter2 = playerIn(state, 2).money;
  check('player 1 was charged $150 (1500 -> 1350)', p1MoneyAfter2 === 1350, `p1.money=${p1MoneyAfter2}`);
  check('player 2 balance was NOT charged (still 1380)', p2MoneyAfter2 === 1380, `p2.money=${p2MoneyAfter2}`);
  check('tile 6 assigned to player 1, NOT player 2', state.propertyOwnership[6] === 1, `owner=${state.propertyOwnership[6]}`);

  // ================= 4. NO-BIDS AUCTION SETTLEMENT =================
  console.log(`\n=== 4. AUCTION WITH NO BIDS ASSIGNS NO OWNER AND CHARGES NO MONEY ===`);
  const openAuc3 = await emitAck(A, 'auction:start', {
    playerId: 1,
    auction: { id: 'auc-leg-3', tileId: 8, currentBid: 0, highestBidderId: null, passedPlayerIds: [] },
  });
  check('auction 3 started on tile 8 (no bids placed)', !!(openAuc3 && openAuc3.ok));

  const noBidsEnd = await emitAck(A, 'auction:end', {
    auction: { id: 'auc-leg-3' },
  });
  check('auction with no bids settles with winnerId=null',
    !!(noBidsEnd && noBidsEnd.ok && noBidsEnd.winnerId === null), JSON.stringify(noBidsEnd));

  state = await syncState(A);
  check('tile 8 remains unowned', state.propertyOwnership[8] === undefined, `owner=${state.propertyOwnership[8]}`);
  check('p1 money unchanged ($1350)', playerIn(state, 1).money === 1350);
  check('p2 money unchanged ($1380)', playerIn(state, 2).money === 1380);

  // ================= 5. AFFORDABILITY CHECK AT SETTLEMENT =================
  console.log(`\n=== 5. UNAFFORDABLE WINNING BID IS REFUSED AT SETTLEMENT ===`);
  // If a player bids, but before auction ends their money becomes insufficient:
  // Open auction on tile 11
  const openAuc4 = await emitAck(A, 'auction:start', {
    playerId: 1,
    auction: { id: 'auc-leg-4', tileId: 11, currentBid: 0, highestBidderId: null, passedPlayerIds: [] },
  });
  check('auction 4 started on tile 11', !!(openAuc4 && openAuc4.ok));

  // Player 1 bids $1300 (affordable at bid time: $1300 <= $1350)
  const bidA4 = await emitAck(A, 'auction:bid', {
    auction: { id: 'auc-leg-4', tileId: 11, currentBid: 1300 },
  });
  check('player 1 bids $1300 (affordable with balance $1350)', !!(bidA4 && bidA4.ok));

  // Transfer $200 from player 1 to player 2 via trade so player 1 has only $1150 (< $1300 bid)
  const tradeObj = {
    id: 'trade-auc-drain',
    initiatorId: 1,
    targetId: 2,
    initiatorPropertyIds: [],
    targetPropertyIds: [],
    initiatorMoney: 200,
    targetMoney: 0,
  };
  const tradeProp = await emitAck(A, 'trade:created', tradeObj);
  check('trade proposed to transfer $200 from player 1 to player 2', !!(tradeProp && tradeProp.ok), JSON.stringify(tradeProp));

  const tradeAcc = await emitAck(B, 'trade:accepted', {
    trade: tradeObj,
    actionId: newActionId(),
  });
  check('trade accepted: player 1 balance is now $1150 (< $1300 bid)', !!(tradeAcc && tradeAcc.ok), JSON.stringify(tradeAcc));

  state = await syncState(A);
  const p1DrainedMoney = playerIn(state, 1).money;
  check('confirmed player 1 balance is $1150', p1DrainedMoney === 1150, `p1=${p1DrainedMoney}`);

  // Now end the auction where winning bid ($1300) > player 1's balance ($1150)
  const unaffordableEnd = await emitAck(A, 'auction:end', {
    auction: { id: 'auc-leg-4' },
    actionId: newActionId(),
  });
  check('auction:end completes with NO winner (unaffordable bid cannot pay)',
    !!(unaffordableEnd && unaffordableEnd.ok && unaffordableEnd.winnerId === null),
    JSON.stringify(unaffordableEnd));

  state = await syncState(A);
  check('tile 11 was NOT assigned to player 1 (still unowned)',
    state.propertyOwnership[11] === undefined, `owner=${state.propertyOwnership[11]}`);
  check('player 1 balance was NOT deducted (still $1150)',
    playerIn(state, 1).money === 1150, `p1.money=${playerIn(state, 1).money}`);

  // ================= 6. TIMER COMPLETION SETTLEMENT =================
  console.log(`\n=== 6. TIMER COMPLETION AUTO-SETTLES AND DEDUCTS WINNING BID ===`);
  const openAuc5 = await emitAck(A, 'auction:start', {
    playerId: 1,
    auction: { id: 'auc-leg-5', tileId: 13, currentBid: 0, highestBidderId: null, passedPlayerIds: [] },
  });
  check('auction 5 started on tile 13', !!(openAuc5 && openAuc5.ok));

  // Player 2 bids $100
  const bidB5 = await emitAck(B, 'auction:bid', {
    auction: { id: 'auc-leg-5', tileId: 13, currentBid: 100 },
  });
  check('player 2 bids $100 on tile 13', !!(bidB5 && bidB5.ok));

  const p2MoneyBeforeTimer = playerIn(await syncState(A), 2).money; // 1380 + 200 = 1580

  // Listen for the timer-driven auction:end broadcast
  const timerEndPromise = waitFor(A, 'auction:end', 20000);

  // Wait past auction timeLeft (default is 15s)
  console.log('Waiting for auction countdown timer to expire (~15s)...');
  const timerEndEvt = await timerEndPromise;
  check('received timer-driven auction:end broadcast', !!timerEndEvt, JSON.stringify(timerEndEvt));
  check('timer-driven winner is player 2', timerEndEvt && timerEndEvt.winnerId === 2);
  check('timer-driven winning tile is 13', timerEndEvt && timerEndEvt.tileId === 13);
  check('timer-driven broadcast reports updated winnerMoney ($1480)',
    timerEndEvt && timerEndEvt.winnerMoney === p2MoneyBeforeTimer - 100,
    `winnerMoney=${timerEndEvt && timerEndEvt.winnerMoney}`);

  state = await syncState(A);
  const p2MoneyAfterTimer = playerIn(state, 2).money;
  check('player 2 money deducted by $100 via timer auto-settle',
    p2MoneyAfterTimer === p2MoneyBeforeTimer - 100,
    `before=${p2MoneyBeforeTimer} after=${p2MoneyAfterTimer}`);
  check('tile 13 owned by player 2 in server state',
    state.propertyOwnership[13] === 2, `owner=${state.propertyOwnership[13]}`);

  // Now, try calling auction:end immediately AFTER timer completed: must be NO_AUCTION and must NOT charge again
  const postTimerEnd = await emitAck(A, 'auction:end', {
    auction: { id: 'auc-leg-5' },
    actionId: newActionId(),
  });
  check('calling auction:end after timer completed is rejected (NO_AUCTION)',
    !!(postTimerEnd && postTimerEnd.ok === false && postTimerEnd.code === 'NO_AUCTION'),
    JSON.stringify(postTimerEnd));

  state = await syncState(A);
  check('player 2 balance was NOT charged a second time',
    playerIn(state, 2).money === p2MoneyAfterTimer, `p2.money=${playerIn(state, 2).money}`);

  // ================= 7. IDENTITY SECURITY: UNIDENTIFIED SOCKET CANNOT END AUCTION =================
  console.log(`\n=== 7. UNIDENTIFIED SOCKET CANNOT END AUCTION ===`);
  const outsider = track(await connect());
  const outJoin = await emitAck(outsider, 'room:join', { roomId });
  check('outsider joined room', !!(outJoin && outJoin.ok));

  const unidentEnd = await emitAck(outsider, 'auction:end', {
    auction: { id: 'auc-leg-6' },
  });
  check('unidentified socket cannot call auction:end',
    !!(unidentEnd && unidentEnd.ok === false && unidentEnd.code === 'NOT_IDENTIFIED'),
    JSON.stringify(unidentEnd));

  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  await cleanup(roomId);
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error('TEST ERROR:', err && err.message);
  await cleanup();
  process.exit(2);
});
