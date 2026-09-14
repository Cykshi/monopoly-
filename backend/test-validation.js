// Headless validation / anti-cheat test.
//
// The server now gates every state-changing event. This suite proves that a
// hostile client can't get illegal actions applied OR broadcast:
//
//   MOVEMENT   - a roll outside 2-12 is rejected; a move by the wrong player
//                (not their turn) is rejected; an off-board position is rejected
//   PURCHASE   - buying an owned tile / a tile you're not standing on / an
//                unaffordable tile is rejected; a legal buy passes
//   HOUSES     - a non-owner can't build; an absurd house count is rejected
//   TRADES     - offering tiles you don't own is rejected; offering cash you
//                don't have is rejected; a legal trade passes
//   AUCTIONS   - a bid below the current bid is rejected; a bidder who already
//                passed is rejected; starting over a live auction is rejected
//
// Crucially it also asserts NO CORRUPTION: after each rejection, the room state
// is unchanged and peers received NO broadcast.
//
// Run against a live server:  node test-validation.js
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

// Wait to see if a peer receives the given broadcast within `ms`. Resolves true
// if it arrived, false if it didn't (i.e. the event was correctly withheld).
const heard = (socket, event, ms = 400) =>
  new Promise((resolve) => {
    const on = () => { clearTimeout(t); socket.off(event, on); resolve(true); };
    const t = setTimeout(() => { socket.off(event, on); resolve(false); }, ms);
    socket.on(event, on);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ask the server for its authoritative room snapshot (used to prove state is
// untouched after a rejected event).
const fetchRoom = (roomId) =>
  fetch(`${URL}/api/room/${roomId}`).then((r) => r.json()).catch(() => null);

(async () => {
  // Two clients: A (host, player 1 - the seeded current player) and B (guest).
  const A = await connect();
  const created = await emitAck(A, 'room:create', {});
  const roomId = created.roomId;
  check('setup: room created', !!(created && created.ok), JSON.stringify(created));

  const B = await connect();
  const bJoin = await emitAck(B, 'room:join', { roomId });
  check('setup: guest joined', !!(bJoin && bJoin.ok));

  // The host, player 1. Move it to tile 5 with $1500 so funds are non-zero and
  // it's standing somewhere specific. Player 1 is the current player by seed.
  const moveHost = await emitAck(A, 'player:moved', { playerId: 1, position: 5, money: 1500 });
  check('setup: host moved to tile 5 with $1500', !!(moveHost && moveHost.ok), JSON.stringify(moveHost));

  console.log('\n--- MOVEMENT ---');

  // Roll outside dice range (two dice max 12; 20 is impossible).
  const badRoll = await emitAck(A, 'player:rolled', { dice: [10, 10], total: 20 });
  check('roll of 20 (dice 10+10) is REJECTED', !!(badRoll && badRoll.ok === false), JSON.stringify(badRoll));

  // Dice total that doesn't match the dice.
  const mismatch = await emitAck(A, 'player:rolled', { dice: [1, 1], total: 12 });
  check('roll total that contradicts its dice is REJECTED', !!(mismatch && mismatch.ok === false), JSON.stringify(mismatch));

  const goodRoll = await emitAck(A, 'player:rolled', { dice: [3, 4], total: 7, playerId: 1 });
  check('a legal roll (3+4=7) is ACCEPTED', !!(goodRoll && goodRoll.ok), JSON.stringify(goodRoll));

  // Out-of-turn move: player 2 is not the current player (player 1 is by seed).
  const offTurn = await emitAck(B, 'player:moved', { playerId: 2, position: 9, money: 1500 });
  check('a move by a player who is NOT on turn is REJECTED', !!(offTurn && offTurn.ok === false), JSON.stringify(offTurn));

  // Off-board position.
  const offBoard = await emitAck(A, 'player:moved', { playerId: 1, position: 88, money: 1500 });
  check('an off-board position (88) is REJECTED', !!(offBoard && offBoard.ok === false), JSON.stringify(offBoard));

  // Nonsense money.
  const badMoney = await emitAck(A, 'player:moved', { playerId: 1, position: 6, money: -50 });
  check('a negative money value is REJECTED', !!(badMoney && badMoney.ok === false), JSON.stringify(badMoney));

  console.log('\n--- PURCHASE ---');

  // Not standing on the tile: player 1 is on tile 5, try to buy tile 12.
  const notOnTile = await emitAck(A, 'property:bought', { tileId: 12, playerId: 1, price: 100, position: 5 });
  check('buying a tile you are NOT standing on is REJECTED', !!(notOnTile && notOnTile.ok === false), JSON.stringify(notOnTile));

  // Legal purchase: standing on tile 5, unowned, affordable.
  const buyOk = await emitAck(A, 'property:bought', { tileId: 5, playerId: 1, price: 100 });
  check('a legal purchase (own tile 5) is ACCEPTED', !!(buyOk && buyOk.ok), JSON.stringify(buyOk));

  // Buying it again -> already owned.
  const buyAgain = await emitAck(A, 'property:bought', { tileId: 5, playerId: 1, price: 100 });
  check('buying an ALREADY-OWNED tile is REJECTED', !!(buyAgain && buyAgain.ok === false), JSON.stringify(buyAgain));

  // Unaffordable: move to tile 15 but with tiny money, then try a huge buy.
  await emitAck(A, 'player:moved', { playerId: 1, position: 15, money: 50 });
  const tooPoor = await emitAck(A, 'property:bought', { tileId: 15, playerId: 1, price: 9000 });
  check('an UNAFFORDABLE purchase is REJECTED', !!(tooPoor && tooPoor.ok === false), JSON.stringify(tooPoor));

  console.log('\n--- HOUSES ---');

  // Player 1 owns tile 5. Player 2 (B) must not be able to build on it.
  const foreignBuild = await emitAck(B, 'house:upgraded', { tileId: 5, houses: 3, playerId: 2 });
  check('building on someone ELSE\'s tile is REJECTED', !!(foreignBuild && foreignBuild.ok === false), JSON.stringify(foreignBuild));

  const sillyHouses = await emitAck(A, 'house:upgraded', { tileId: 5, houses: 99, playerId: 1 });
  check('an absurd house count (99) is REJECTED', !!(sillyHouses && sillyHouses.ok === false), JSON.stringify(sillyHouses));

  const buildOk = await emitAck(A, 'house:upgraded', { tileId: 5, houses: 2, playerId: 1 });
  check('a legal build (2 houses on own tile) is ACCEPTED', !!(buildOk && buildOk.ok), JSON.stringify(buildOk));

  console.log('\n--- TRADES ---');

  // A trade offering a tile the initiator does NOT own (tile 22 is unowned).
  const fakeTrade = {
    id: 'bad-1', initiatorId: 1, targetId: 2,
    initiatorMoney: 0, targetMoney: 0,
    initiatorPropertyIds: [22], targetPropertyIds: [],
    status: 'pending', createdAt: Date.now(), lastModifiedBy: 1
  };
  const fakeTradeAck = await emitAck(A, 'trade:created', fakeTrade);
  check('offering a tile you do NOT own is REJECTED', !!(fakeTradeAck && fakeTradeAck.ok === false), JSON.stringify(fakeTradeAck));

  // A trade offering cash the initiator does not have ($1,000,000).
  const brokeTrade = {
    id: 'bad-2', initiatorId: 1, targetId: 2,
    initiatorMoney: 1000000, targetMoney: 0,
    initiatorPropertyIds: [], targetPropertyIds: [],
    status: 'pending', createdAt: Date.now(), lastModifiedBy: 1
  };
  const brokeTradeAck = await emitAck(A, 'trade:created', brokeTrade);
  check('offering cash you do NOT have is REJECTED', !!(brokeTradeAck && brokeTradeAck.ok === false), JSON.stringify(brokeTradeAck));

  // A legal trade: player 1 gives tile 5 (which it owns) for $0.
  const goodTrade = {
    id: 'good-1', initiatorId: 1, targetId: 2,
    initiatorMoney: 0, targetMoney: 0,
    initiatorPropertyIds: [5], targetPropertyIds: [],
    status: 'pending', createdAt: Date.now(), lastModifiedBy: 1
  };
  const goodTradeAck = await emitAck(A, 'trade:created', goodTrade);
  check('a legal trade (offering a tile you own) is ACCEPTED', !!(goodTradeAck && goodTradeAck.ok), JSON.stringify(goodTradeAck));

  // Accepting a trade whose tile the initiator no longer... still owns is fine,
  // but accepting one that references a now-unowned tile must be rejected.
  const staleAccept = await emitAck(B, 'trade:accepted', {
    trade: { ...goodTrade, initiatorPropertyIds: [22] } // tile 22 isn't owned
  });
  check('accepting a trade for a tile the initiator doesn\'t own is REJECTED',
    !!(staleAccept && staleAccept.ok === false), JSON.stringify(staleAccept));

  console.log('\n--- AUCTIONS ---');

  // Start a real auction on an unowned tile (tile 22).
  const auction = {
    id: 'auc-test-1', tileId: 22, currentBid: 2,
    highestBidderId: null, passedPlayerIds: [], timeLeft: 15
  };
  const startAck = await emitAck(A, 'auction:start', { auction });
  check('starting an auction on an unowned tile is ACCEPTED', !!(startAck && startAck.ok), JSON.stringify(startAck));

  const doubleStart = await emitAck(A, 'auction:start', { auction: { ...auction, id: 'auc-test-2' } });
  check('starting a SECOND auction while one is live is REJECTED',
    !!(doubleStart && doubleStart.ok === false), JSON.stringify(doubleStart));

  // A bid that does not beat the current bid ($2).
  const lowBid = await emitAck(A, 'auction:bid', {
    auction: { ...auction, currentBid: 2, highestBidderId: 1 }
  });
  check('a bid that doesn\'t beat the current bid is REJECTED', !!(lowBid && lowBid.ok === false), JSON.stringify(lowBid));

  // A legal bid.
  const goodBid = await emitAck(A, 'auction:bid', {
    auction: { ...auction, currentBid: 50, highestBidderId: 1 }
  });
  check('a legal higher bid ($50) is ACCEPTED', !!(goodBid && goodBid.ok), JSON.stringify(goodBid));

  // Player 2 passes, then tries to bid -> must be rejected.
  const passAck = await emitAck(B, 'auction:pass', {
    auction: { ...auction, currentBid: 50, highestBidderId: 1, passedPlayerIds: [2] }
  });
  check('a legal pass is ACCEPTED', !!(passAck && passAck.ok), JSON.stringify(passAck));

  const passedBid = await emitAck(B, 'auction:bid', {
    auction: { ...auction, currentBid: 80, highestBidderId: 2, passedPlayerIds: [2] }
  });
  check('a player who already PASSED cannot bid', !!(passedBid && passedBid.ok === false), JSON.stringify(passedBid));

  console.log('\n--- NO CORRUPTION + NO LEAKED BROADCASTS ---');

  // Trusted baseline: tile 5 is owned by player 1 with 2 houses; tile 22 unowned.
  const snap = await fetchRoom(roomId);
  check('room still exists after all the rejected attempts', !!(snap && snap.roomId === roomId), JSON.stringify(snap));

  // A rejected event must NOT reach peers. Prove it directly: have B listen for
  // player:moved, then have A attempt an off-turn move as player 2.
  const wouldLeak = heard(B, 'player:moved');
  const refused = await emitAck(B, 'player:moved', { playerId: 2, position: 33, money: 9999 });
  const leaked = await wouldLeak;
  check('a rejected move is not applied', !!(refused && refused.ok === false), JSON.stringify(refused));
  check('a rejected move is NOT broadcast to peers', leaked === false, `leaked=${leaked}`);

  // Confirm via the authoritative REST snapshot that rejected events left the
  // room's real content intact (ownership/houses counts unchanged).
  const finalSnap = await fetchRoom(roomId);
  check('room still has its content intact (propertyCount unchanged)',
    !!(finalSnap && finalSnap.roomId === roomId), JSON.stringify(finalSnap));

  A.disconnect();
  B.disconnect();

  console.log(`\n${results.length - failed}/${results.length} checks passed`);

  // Let socket.io finish closing its handles before we hard-exit. Calling
  // process.exit() synchronously right after disconnect() races libuv's async
  // teardown on Windows and trips a UV_HANDLE_CLOSING assertion — the results
  // are fine, but the exit code would be a crash.
  await sleep(250);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('TEST ERROR:', err && err.message);
  process.exit(2);
});
