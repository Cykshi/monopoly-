// Test: Card Draw Privacy
// Verifies that when a player draws a Chance/Community Chest card:
//   1. Only the drawing player receives private card details (title, description, roll)
//      via targeted 'card:details' event and ack.
//   2. Other players receive only public game-state changes (position, money)
//      via 'card:drawn' broadcast, and NEVER receive private title, description, or roll.
//   3. Other players cannot forge or listen to private card details.
//   4. Auctions triggered after landing on an unowned property via a card are visible to all players.

const { io } = require('socket.io-client');
const assert = require('assert');

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

let seq = 0;
const newActionId = () => `card-priv-${Date.now()}-${++seq}`;

const syncState = (socket) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 1500);
    socket.once('game:sync', (s) => { clearTimeout(t); resolve(s); });
    socket.emit('game:request-sync', {});
  });

const playerIn = (state, id) => ((state && state.players) || []).find((p) => p.id === id);

const sockets = [];
const track = (s) => { sockets.push(s); return s; };

const cleanup = async () => {
  for (const s of sockets) {
    try { if (s && typeof s.disconnect === 'function') s.disconnect(); } catch { /* ignore */ }
  }
  await sleep(150);
};

(async () => {
  console.log('\n=== CARD DRAW PRIVACY REGRESSION TEST ===\n');

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

  // Start the game by having Player 1 roll
  const firstRoll = await emitAck(A, 'player:rolled', { playerId: 1 });
  check('setup: game started via player:rolled', !!(firstRoll && firstRoll.ok));

  // Player 1 moves to satisfy initial roll
  await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });

  // Cycle turns to get fresh turn for Alice
  await emitAck(A, 'turn:ended', { playerId: 1 });
  await emitAck(B, 'turn:ended', { playerId: 2 });

  // Navigate Alice to Tile 3 (TREASURE) using skill cards
  let state = await syncState(A);
  let p1Pos = playerIn(state, 1).position;
  let distTo3 = (3 - p1Pos + 40) % 40;
  if (distTo3 === 0) distTo3 = 40;

  while (distTo3 > 0) {
    const step = Math.min(distTo3, 6);
    await emitAck(A, 'player:skill-card', { movement: step, playerId: 1 });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });
    distTo3 -= step;
    if (distTo3 > 0) {
      await emitAck(A, 'turn:ended', { playerId: 1 });
      await emitAck(B, 'turn:ended', { playerId: 2 });
    }
  }

  state = await syncState(A);
  p1Pos = playerIn(state, 1).position;
  check('Alice positioned on tile 3 (TREASURE)', p1Pos === 3, `pos=${p1Pos}`);

  // =========================================================================
  // TEST 1: Drawing player receives private details via targeted event & ack
  // =========================================================================
  console.log('\n--- Test 1: Drawing player receives private card details ---');

  let alicePrivateEvent = null;
  A.once('card:details', (data) => {
    alicePrivateEvent = data;
  });

  let bobPrivateEvent = null;
  B.once('card:details', (data) => {
    bobPrivateEvent = data;
  });

  let bobPublicEvent = null;
  B.once('card:drawn', (data) => {
    bobPublicEvent = data;
  });

  const drawAck = await emitAck(A, 'card:draw', {
    playerId: 1,
    actionId: newActionId(),
  });

  check('Alice card draw ack succeeded', !!(drawAck && drawAck.ok), JSON.stringify(drawAck));
  check('Alice ack contains private card object', !!(drawAck && drawAck.card));
  check('Alice ack contains card title', !!(drawAck && drawAck.card && drawAck.card.title), `title=${drawAck?.card?.title}`);
  check('Alice ack contains card description', !!(drawAck && drawAck.card && drawAck.card.description), `desc=${drawAck?.card?.description}`);
  check('Alice ack contains roll number', Number.isInteger(drawAck && drawAck.roll));

  await sleep(400);

  check('Alice received targeted card:details event', !!alicePrivateEvent);
  check('Alice card:details has card title', !!(alicePrivateEvent && alicePrivateEvent.card && alicePrivateEvent.card.title));
  check('Alice card:details has card description', !!(alicePrivateEvent && alicePrivateEvent.card && alicePrivateEvent.card.description));

  // =========================================================================
  // TEST 2: Peer (Bob) does NOT receive private card details
  // =========================================================================
  console.log('\n--- Test 2: Peer does NOT receive private card details ---');

  check('Bob NEVER received card:details event', bobPrivateEvent === null, `bobPrivateEvent=${JSON.stringify(bobPrivateEvent)}`);
  check('Bob received public card:drawn broadcast', !!bobPublicEvent);
  check('Bob public card:drawn has playerId 1', bobPublicEvent && bobPublicEvent.playerId === 1);
  check('Bob public card:drawn has position', bobPublicEvent && Number.isInteger(bobPublicEvent.position));
  check('Bob public card:drawn has money', bobPublicEvent && Number.isInteger(bobPublicEvent.money));
  check('Bob public card:drawn OMITTED roll', bobPublicEvent && bobPublicEvent.roll === undefined, `roll=${bobPublicEvent?.roll}`);
  check('Bob public card:drawn OMITTED card object', bobPublicEvent && bobPublicEvent.card === undefined, `card=${JSON.stringify(bobPublicEvent?.card)}`);
  check('Bob public card:drawn OMITTED card title', !bobPublicEvent?.card?.title);
  check('Bob public card:drawn OMITTED card description', !bobPublicEvent?.card?.description);

  // =========================================================================
  // TEST 3: Auction triggered after card draw is visible to EVERY player
  // =========================================================================
  console.log('\n--- Test 3: Auction triggered after card movement is visible to all ---');

  // Navigate Alice to tile 28 (SURPRISE tile)
  await emitAck(A, 'turn:ended', { playerId: 1 });
  await emitAck(B, 'turn:ended', { playerId: 2 });

  state = await syncState(A);
  p1Pos = playerIn(state, 1).position;
  let distTo28 = (28 - p1Pos + 40) % 40;
  if (distTo28 === 0) distTo28 = 40;

  while (distTo28 > 0) {
    const step = Math.min(distTo28, 6);
    await emitAck(A, 'player:skill-card', { movement: step, playerId: 1 });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });
    distTo28 -= step;
    if (distTo28 > 0) {
      await emitAck(A, 'turn:ended', { playerId: 1 });
      await emitAck(B, 'turn:ended', { playerId: 2 });
    }
  }

  state = await syncState(A);
  p1Pos = playerIn(state, 1).position;
  check('Alice positioned on tile 28 (SURPRISE)', p1Pos === 28, `pos=${p1Pos}`);

  // Force roll 3: Jump forward 8 spaces -> lands on tile 36 (custom/unowned or property)
  // Or tile 3: Treasure roll 5 -> advances to nearest Airport (Tile 5).
  // Let's draw card with forcedRoll: 3 on SURPRISE (tile 28): 28 + 8 = 36 (tile 36 is unowned).
  const surpriseAck = await emitAck(A, 'card:draw', {
    playerId: 1,
    actionId: newActionId(),
    _testForcedRoll: 3,
  });

  check('Alice drew Surprise card jumping forward 8 spaces', surpriseAck && surpriseAck.ok && surpriseAck.position === 36, `pos=${surpriseAck?.position}`);

  // Alice now lands on tile 36 (unowned). Alice starts an auction for tile 36.
  let bobAuctionStart = null;
  B.once('auction:start', (data) => {
    bobAuctionStart = data;
  });

  const auctionId = `auc-${Date.now()}`;
  const auctionRes = await emitAck(A, 'auction:start', {
    playerId: 1,
    auction: {
      id: auctionId,
      tileId: 36,
      currentBid: 2,
    },
  });

  check('Alice successfully started auction for landed tile', !!(auctionRes && auctionRes.ok));

  await sleep(400);

  check('Bob received auction:start broadcast', !!bobAuctionStart);
  check('Bob sees the auctioned tileId 36', bobAuctionStart && bobAuctionStart.auction && bobAuctionStart.auction.tileId === 36);

  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  await cleanup();
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error('TEST ERROR:', err && err.message, err && err.stack);
  await cleanup();
  process.exit(2);
});
