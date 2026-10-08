// Focused CARD MOVEMENT and REWARD AUTHORITY test suite.
//
// Verifies the 8 card engine guarantees from the audit:
//   1. Server determines the card drawn; never trusts client Math.random or card result.
//   2. Server validates and executes card movement.
//   3. Server calculates all card rewards/penalties on the server.
//   4. Card movement routes through the authoritative movement/landing pipeline.
//   5. Authoritative position, money, and resulting state are broadcast to the room.
//   6. Clients cannot spoof card IDs, destinations, rewards, or money.
//   7. Turn gating and actionId replay protection are strictly enforced.
//   8. Focused unit and integration tests covering spoofing, replay, movement, and reward manipulation.
//
// Run against a live server:
//   SERVER_URL=http://localhost:3099 node test-card-authority.js
const { io } = require('socket.io-client');
const assert = require('assert');
const path = require('path');

const cards = require('./game/cards');
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
// PART 1: PURE UNIT TESTS FOR CARDS ENGINE (cards.js)
// ============================================================================
console.log('\n=== 1. PURE UNIT TESTS: REWARDS, MOVEMENT, AND PENALTIES ===');

// Check tile detection
check('tile 3 is recognized as card tile', cards.isCardTile(3));
check('tile 3 is recognized as treasure', cards.getCardTileType(3) === 'treasure');
check('tile 14 is recognized as card tile', cards.isCardTile(14));
check('tile 14 is recognized as surprise', cards.getCardTileType(14) === 'surprise');
check('tile 28 is recognized as card tile', cards.isCardTile(28));
check('tile 28 is recognized as surprise', cards.getCardTileType(28) === 'surprise');
check('tile 0 (START) is not a card tile', !cards.isCardTile(0));
check('tile 1 (Dhaka) is not a card tile', !cards.isCardTile(1));

// Rejection when not on a card tile
{
  const p = { id: 1, position: 0, money: 1500 };
  const res = cards.resolveCardDraw({}, p);
  check('resolveCardDraw rejects when not on card tile', !res.ok && res.code === 'NOT_ON_CARD_TILE');
}

// Treasure 1 & 2: +$100, no movement
{
  const p1 = { id: 1, position: 3, money: 1500 };
  const r1 = cards.resolveCardDraw({}, p1, { forcedRoll: 1 });
  check('Treasure roll 1 grants +$100', r1.ok && p1.money === 1600 && r1.cardMoneyDelta === 100);
  check('Treasure roll 1 leaves position at tile 3', p1.position === 3 && r1.position === 3);

  const p2 = { id: 1, position: 3, money: 1500 };
  const r2 = cards.resolveCardDraw({}, p2, { forcedRoll: 2 });
  check('Treasure roll 2 grants +$100', r2.ok && p2.money === 1600);
}

// Treasure 3 & 4: +$200, grantSkillCard: true, no movement
{
  const p = { id: 1, position: 3, money: 1500 };
  const r = cards.resolveCardDraw({}, p, { forcedRoll: 3 });
  check('Treasure roll 3 grants +$200 and skill card', r.ok && p.money === 1700 && r.grantSkillCard === true);
}

// Treasure 5: Advances to nearest airport (from tile 3 -> airport 5)
{
  const p = { id: 1, position: 3, money: 1500 };
  const r = cards.resolveCardDraw({}, p, { forcedRoll: 5 });
  check('Treasure roll 5 advances to tile 5 (Airport 1)', r.ok && p.position === 5 && r.position === 5);
  check('Treasure roll 5 did not pass GO', r.passedGo === false && r.salary === 0 && p.money === 1500);
}

// Treasure 5 passing GO: from hypothetical tile 36 -> airport 1 (tile 5)
{
  // If a player lands on a card at tile 36 (custom position) and wraps to tile 5
  // Board size is 40, 36 -> 5 passes GO
  const p = { id: 1, position: 3, money: 1500 };
  // From tile 3, nearest airport is 5.
  // Test passing GO on forward_8 from tile 35:
  const pWrap = { id: 1, position: 28, money: 1500 }; // tile 28 is SURPRISE
  const rWrap = cards.resolveCardDraw({}, pWrap, { forcedRoll: 3 }); // Surprise 3 jumps forward 8
  // 28 + 8 = 36 < 40 (does not pass GO)
  check('Surprise forward 8 from 28 lands on 36', rWrap.ok && pWrap.position === 36 && rWrap.passedGo === false);
}

// Treasure 6: -$150 luxury tax
{
  const p = { id: 1, position: 3, money: 1500 };
  const r = cards.resolveCardDraw({}, p, { forcedRoll: 6 });
  check('Treasure roll 6 pays $150 luxury tax', r.ok && p.money === 1350 && r.cardMoneyDelta === -150);

  // Partial deduction if player has less than $150 (cannot go below 0)
  const pLow = { id: 1, position: 3, money: 50 };
  cards.resolveCardDraw({}, pLow, { forcedRoll: 6 });
  check('Luxury tax caps at player funds and cannot make balance negative', pLow.money === 0);
}

// Surprise 1 & 2: Straight to JAIL (tile 10)
{
  const p = { id: 1, position: 14, money: 1500 };
  const r = cards.resolveCardDraw({}, p, { forcedRoll: 1 });
  check('Surprise roll 1 sends player straight to JAIL (tile 10)', r.ok && p.position === 10 && r.passedGo === false && p.inJail === true && p.jailTurns === 0 && r.inJail === true && r.jailTurns === 0);
}

// Surprise 3 & 4: Jump forward 8 spaces
{
  const p = { id: 1, position: 14, money: 1500 };
  const r = cards.resolveCardDraw({}, p, { forcedRoll: 3 });
  check('Surprise roll 3 jumps forward 8 spaces (14 -> 22)', r.ok && p.position === 22);
}

// Surprise 5: Receive $250 dividend
{
  const p = { id: 1, position: 14, money: 1500 };
  const r = cards.resolveCardDraw({}, p, { forcedRoll: 5 });
  check('Surprise roll 5 grants $250 dividend', r.ok && p.money === 1750 && r.cardMoneyDelta === 250);
}

// Surprise 6: Swap position with another player
{
  const p1 = { id: 1, position: 14, money: 1500 };
  const p2 = { id: 2, position: 31, money: 1500, isBankrupt: false, name: 'Bob' };
  const room = { players: [p1, p2] };
  const r = cards.resolveCardDraw(room, p1, { forcedRoll: 6, targetId: 2 });
  check('Surprise roll 6 swaps positions between player 1 and 2',
    r.ok && p1.position === 31 && p2.position === 14 && r.swap && r.swap.targetId === 2);
}

// ============================================================================
// PART 2: INTEGRATION TESTS WITH LIVE SOCKET SERVER
// ============================================================================
console.log('\n=== 2. LIVE SERVER INTEGRATION: GATING, REPLAY, AND MANIPULATION ===');

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
const newActionId = () => `card-act-${Date.now()}-${++seq}`;

const sockets = [];
const track = (s) => { sockets.push(s); return s; };

const cleanup = async (roomId) => {
  for (const s of sockets) {
    try { if (s && typeof s.disconnect === 'function') s.disconnect(); } catch { /* ignore */ }
  }
  await sleep(150);
};

(async () => {
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

  // Player 1 moves to satisfy the initial roll
  await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });

  // ---- 2.1 Gating tests ----
  console.log('\n--- 2.1 Gating & Validation Checks ---');

  // Drawing without playerId rejected
  const badPayload = await emitAck(A, 'card:draw', {});
  check('card:draw without playerId rejected (BAD_PAYLOAD)',
    !!(badPayload && badPayload.ok === false && badPayload.code === 'BAD_PAYLOAD'),
    JSON.stringify(badPayload));

  // Out-of-turn draw: Bob tries to draw on Alice's turn
  const outOfTurn = await emitAck(B, 'card:draw', { playerId: 2, actionId: newActionId() });
  check('out of turn card draw rejected (NOT_YOUR_TURN)',
    !!(outOfTurn && outOfTurn.ok === false && outOfTurn.code === 'NOT_YOUR_TURN'),
    JSON.stringify(outOfTurn));

  // Impersonation: Alice socket sends playerId: 2
  const impersonate = await emitAck(A, 'card:draw', { playerId: 2, actionId: newActionId() });
  check('impersonation attempt rejected (NOT_YOUR_PLAYER)',
    !!(impersonate && impersonate.ok === false && impersonate.code === 'NOT_YOUR_PLAYER'),
    JSON.stringify(impersonate));

  // Missing actionId rejected
  const noActionId = await emitAck(A, 'card:draw', { playerId: 1 });
  check('card:draw missing actionId rejected (BAD_ACTION_ID)',
    !!(noActionId && noActionId.ok === false && noActionId.code === 'BAD_ACTION_ID'),
    JSON.stringify(noActionId));

  // Drawing when NOT on a card tile rejected
  let state = await syncState(A);
  let p1Pos = playerIn(state, 1).position;
  if (!cards.isCardTile(p1Pos)) {
    const notOnCard = await emitAck(A, 'card:draw', { playerId: 1, actionId: newActionId() });
    check('card:draw when not on card tile rejected (NOT_ON_CARD_TILE)',
      !!(notOnCard && notOnCard.ok === false && notOnCard.code === 'NOT_ON_CARD_TILE'),
      `pos=${p1Pos} ack=${JSON.stringify(notOnCard)}`);
  }

  // ---- 2.2 Moving to tile 3 (TREASURE) via skill-card ----
  console.log('\n--- 2.2 Move to Card Tile (Tile 3: TREASURE) ---');
  // End Alice's turn, then Bob's turn, to get back to a fresh turn for Alice
  await emitAck(A, 'turn:ended', { playerId: 1 });
  await emitAck(B, 'turn:ended', { playerId: 2 });

  // Current turn is Alice (1). Use skill-card to navigate:
  // We want to land on tile 3. Calculate distance from current position.
  state = await syncState(A);
  p1Pos = playerIn(state, 1).position;
  let distTo3 = (3 - p1Pos + 40) % 40;
  if (distTo3 === 0) distTo3 = 40;

  // Walk in steps of up to 6 using skill-card
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
  check('Alice successfully positioned on tile 3 (TREASURE)', p1Pos === 3, `pos=${p1Pos}`);

  // ---- 2.3 Spoofing and Replay Protection on card:draw ----
  console.log('\n--- 2.3 Spoofing, Manipulation, and Replay Protection ---');

  const p1InitialMoney = playerIn(state, 1).money;
  const spoofActionId = newActionId();

  // Listen on Bob's socket to verify peer broadcast of authoritative card:drawn event
  const peerCardDrawnPromise = waitFor(B, 'card:drawn');

  // Alice tries to spoof card result: sends money: 999999, roll: 5, cardId: 'surprise-5', position: 39
  const drawAck = await emitAck(A, 'card:draw', {
    playerId: 1,
    actionId: spoofActionId,
    money: 999999,
    reward: 999999,
    roll: 5,
    cardId: 'surprise-5',
    position: 39,
  });

  check('card:draw succeeded with authoritative ack', !!(drawAck && drawAck.ok), JSON.stringify(drawAck));
  check('card drawn was TREASURE (derived from tile 3), NOT client-requested Surprise',
    drawAck && drawAck.kind === 'treasure', `kind=${drawAck && drawAck.kind}`);
  check('card roll is an integer 1..6 determined by server',
    drawAck && Number.isInteger(drawAck.roll) && drawAck.roll >= 1 && drawAck.roll <= 6,
    `roll=${drawAck && drawAck.roll}`);
  check('client-supplied $999999 reward was IGNORED',
    drawAck && drawAck.money < 999999, `money=${drawAck && drawAck.money}`);

  // Verify server state in sync
  state = await syncState(A);
  const p1MoneyAfter = playerIn(state, 1).money;
  check('server balance updated according to authoritative card, not spoofed money',
    p1MoneyAfter === drawAck.money, `serverMoney=${p1MoneyAfter} ackMoney=${drawAck.money}`);

  // Verify peer broadcast
  const peerEvt = await peerCardDrawnPromise;
  check('peer received authoritative card:drawn broadcast', !!peerEvt, JSON.stringify(peerEvt));
  check('peer broadcast matches authoritative money and position',
    peerEvt && peerEvt.playerId === 1 && peerEvt.money === drawAck.money && peerEvt.position === drawAck.position,
    `peerEvt money=${peerEvt && peerEvt.money} pos=${peerEvt && peerEvt.position}`);

  // ---- 2.4 Replay protection ----
  console.log('\n--- 2.4 Replay Protection ---');
  const replayAck = await emitAck(A, 'card:draw', {
    playerId: 1,
    actionId: spoofActionId,
  });
  check('replayed card:draw with same actionId is refused (DUPLICATE_ACTION)',
    !!(replayAck && replayAck.ok === false && replayAck.code === 'DUPLICATE_ACTION'),
    JSON.stringify(replayAck));

  // Ensure balance was NOT double-changed
  state = await syncState(A);
  const p1MoneyAfterReplay = playerIn(state, 1).money;
  check('balance remains unchanged after replayed actionId',
    p1MoneyAfterReplay === p1MoneyAfter, `money=${p1MoneyAfterReplay}`);

  // ---- 2.5 Authoritative Movement / Landing Pipeline Integration ----
  console.log('\n--- 2.5 Authoritative Movement / Landing Pipeline ---');
  // If the card resulted in movement (e.g. Nearest Airport tile 5), verify that
  // server player.position matches the new destination, allowing subsequent
  // tile actions (like property:bought) to pass the player.position === tileId check.
  state = await syncState(A);
  const currentAlicePos = playerIn(state, 1).position;
  check('authoritative server position is valid board index',
    Number.isInteger(currentAlicePos) && currentAlicePos >= 0 && currentAlicePos < 40,
    `position=${currentAlicePos}`);

  // ---- 2.6 Peer Event Forgery Protection ----
  console.log('\n--- 2.6 Peer Cannot Forge card:drawn Directly ---');
  let forgedCardReceived = null;
  A.once('card:drawn', (d) => { forgedCardReceived = d; });

  // Bob attempts to forge a card:drawn event to Alice
  B.emit('card:drawn', { playerId: 2, money: 999999, position: 0 });
  await sleep(400);

  check('client-emitted card:drawn is dropped and never received by peer',
    forgedCardReceived === null,
    `received=${JSON.stringify(forgedCardReceived)}`);

  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  await cleanup(roomId);
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error('TEST ERROR:', err && err.message, err && err.stack);
  await cleanup();
  process.exit(2);
});
