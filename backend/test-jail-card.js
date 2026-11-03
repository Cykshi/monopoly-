// Focused GET OUT OF JAIL FREE CARD test suite (BUG-07).
//
// Verifies:
//   1. Card engine awards Get Out of Jail Free card on appropriate Chance/Community Chest draw (grantJailCard).
//   2. Authoritative per-player jailCards inventory initialized to 0 and synced.
//   3. Jailed player holding a card can use jail:use-card to escape jail.
//   4. Card is consumed exactly once (inventory decremented by 1).
//   5. jail:use-card is rejected with NO_JAIL_CARD when player has 0 cards.
//   6. jail:use-card is rejected with NOT_IN_JAIL when player is not in jail.
//   7. Gating: turnGate rejects non-turn player, actionGate rejects replayed actionId.
//   8. Escape resets consecutiveDoubles, hasExtraTurn, jailTurns, and roll state.
//   9. Persistence and reconnect restore player's jailCards inventory.
//  10. Elimination / bankruptcy clears jailCards to 0.
//
// Run against a live server:
//   SERVER_URL=http://localhost:3099 node test-jail-card.js
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
// PART 1: PURE UNIT TESTS FOR CARD ENGINE (cards.js)
// ============================================================================
console.log('\n=== 1. PURE UNIT TESTS: GET OUT OF JAIL FREE CARD REWARD ===');

// Treasure roll 4: awards +$200, skill card, AND Get Out of Jail Free card
{
  const p = { id: 1, position: 3, money: 1500, jailCards: 0 };
  const r = cards.resolveCardDraw({}, p, { forcedRoll: 4 });
  check('Treasure roll 4 grants Get Out of Jail Free card (grantJailCard: true)', r.ok && r.grantJailCard === true);
  check('Treasure roll 4 increments player.jailCards to 1', p.jailCards === 1 && r.jailCards === 1);
  check('Treasure roll 4 preserves existing money reward (+$200)', p.money === 1700 && r.cardMoneyDelta === 200);
  check('Treasure roll 4 preserves existing skill card reward', r.grantSkillCard === true);
}

// Treasure roll 3: awards +$200 and skill card, but grantJailCard is false
{
  const p = { id: 1, position: 3, money: 1500, jailCards: 0 };
  const r = cards.resolveCardDraw({}, p, { forcedRoll: 3 });
  check('Treasure roll 3 does NOT grant jail card', r.grantJailCard === false && p.jailCards === 0);
  check('Treasure roll 3 preserves money (+$200)', p.money === 1700);
  check('Treasure roll 3 preserves skill card', r.grantSkillCard === true);
}

// Surprise roll 4: jumps forward 8 spaces AND awards Get Out of Jail Free card
{
  const p = { id: 1, position: 14, money: 1500, jailCards: 0 };
  const r = cards.resolveCardDraw({}, p, { forcedRoll: 4 });
  check('Surprise roll 4 grants Get Out of Jail Free card', r.ok && r.grantJailCard === true);
  check('Surprise roll 4 increments player.jailCards to 1', p.jailCards === 1 && r.jailCards === 1);
  check('Surprise roll 4 preserves movement forward 8 (14 -> 22)', p.position === 22 && r.position === 22);
}

// Surprise roll 1: sends straight to JAIL, grantJailCard is false
{
  const p = { id: 1, position: 14, money: 1500, jailCards: 1 };
  const r = cards.resolveCardDraw({}, p, { forcedRoll: 1 });
  check('Surprise roll 1 sends to jail without granting jail card', r.inJail === true && r.grantJailCard === false);
  check('Surprise roll 1 does not alter existing jailCards', p.jailCards === 1);
}

// Multiple card awards accumulate
{
  const p = { id: 1, position: 3, money: 1500, jailCards: 1 };
  const r = cards.resolveCardDraw({}, p, { forcedRoll: 4 });
  check('Accumulating multiple jail cards increases count to 2', p.jailCards === 2 && r.jailCards === 2);
}

// ============================================================================
// PART 2: LIVE SOCKET INTEGRATION TESTS
// ============================================================================
console.log('\n=== 2. LIVE SERVER INTEGRATION: USE CARD, GATING, REPLAY, RECONNECT ===');

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
const newActionId = () => `jail-card-act-${Date.now()}-${++actionSeq}`;

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
  // --------------------------------------------------------------------------
  // TEST GROUP 1: INITIALIZATION, CARD DRAW AWARD, AND BROADCAST
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 1: CARD DRAW AWARD & JAILCARDS INVENTORY ---');
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

    let state = await syncState(A);
    check('G1: player 1 initialized with jailCards = 0', playerIn(state, 1)?.jailCards === 0);
    check('G1: player 2 initialized with jailCards = 0', playerIn(state, 2)?.jailCards === 0);

    // P1 rolls 1+2 = 3 to land directly on tile 3 (TREASURE)
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [1, 2] });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });

    state = await syncState(A);
    check('G1: P1 moved to tile 3 (TREASURE)', playerIn(state, 1)?.position === 3);

    // Setup listener on B for card:drawn
    const cardDrawnPromise = waitFor(B, 'card:drawn');

    // P1 draws card with forced roll 4 (awards Get Out of Jail Free card)
    const drawRes = await emitAck(A, 'card:draw', {
      playerId: 1,
      actionId: newActionId(),
      _testForcedRoll: 4,
    });

    check('G1: draw-card ack ok', !!(drawRes && drawRes.ok));
    check('G1: draw-card ack contains grantJailCard: true', drawRes?.grantJailCard === true);
    check('G1: draw-card ack reflects jailCards: 1', drawRes?.jailCards === 1);

    const bEvt = await cardDrawnPromise;
    check('G1: card:drawn broadcast to peer B carries grantJailCard: true', bEvt?.grantJailCard === true);
    check('G1: card:drawn broadcast carries jailCards: 1', bEvt?.jailCards === 1);

    state = await syncState(A);
    check('G1: server room state confirms P1 has jailCards = 1', playerIn(state, 1)?.jailCards === 1);

    await cleanupRoom(A, roomId);
  }

  // --------------------------------------------------------------------------
  // TEST GROUP 2: USE CARD TO ESCAPE JAIL & EXACT CONSUMPTION
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 2: USE CARD ESCAPE, CONSUMPTION & BROADCAST ---');
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

    // P1 lands on tile 3 and draws card to acquire 1 jailCard
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [1, 2] });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });
    await emitAck(A, 'card:draw', { playerId: 1, actionId: newActionId(), _testForcedRoll: 4 });

    // End P1 turn
    await emitAck(A, 'turn:ended', { playerId: 1 });

    // P2 rolls and moves onto tile 14 (SURPRISE) and draws straight to JAIL (roll 1)
    await emitAck(B, 'player:rolled', { playerId: 2, _testForcedDice: [7, 7] }); // Lands on 14
    await emitAck(B, 'player:moved', { playerId: 2, actionId: newActionId() });
    await emitAck(B, 'card:draw', { playerId: 2, actionId: newActionId(), _testForcedRoll: 1 });

    let state = await syncState(A);
    check('G2: P2 is in jail', playerIn(state, 2)?.inJail === true && playerIn(state, 2)?.position === 10);
    // End P2 turn
    await emitAck(B, 'turn:ended', { playerId: 2 });

    // P1's turn again. P1 rolls 7, then rolls doubles to speed into jail:
    // P1 rolls 3 consecutive doubles to land in jail for speeding
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [2, 2] }); // double 1
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [3, 3] }); // double 2
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [4, 4] }); // double 3 -> Speeding to JAIL!

    state = await syncState(A);
    check('G2: P1 is now in jail for speeding', playerIn(state, 1)?.inJail === true);
    check('G2: P1 still holds 1 jailCard', playerIn(state, 1)?.jailCards === 1);

    // End P1 turn so P1 starts fresh turn in jail
    await emitAck(A, 'turn:ended', { playerId: 1 });
    // P2 passes turn
    await emitAck(B, 'turn:ended', { playerId: 2 });

    state = await syncState(A);
    check('G2: P1 owns turn while jailed', state?.currentTurnPlayerId === 1 && playerIn(state, 1)?.inJail === true);

    // Setup listener on B for jail:card-used broadcast
    const cardUsedPromise = waitFor(B, 'jail:card-used');

    // P1 uses Get Out of Jail Free card!
    const useActId = newActionId();
    const useRes = await emitAck(A, 'jail:use-card', {
      playerId: 1,
      actionId: useActId,
    });

    check('G2: jail:use-card accepted', !!(useRes && useRes.ok));
    check('G2: ack confirms inJail: false', useRes?.inJail === false);
    check('G2: ack confirms jailTurns: 0', useRes?.jailTurns === 0);
    check('G2: ack confirms jailCards: 0 (consumed)', useRes?.jailCards === 0);

    const bCardEvt = await cardUsedPromise;
    check('G2: jail:card-used broadcast to peer B', !!bCardEvt && bCardEvt.playerId === 1);
    check('G2: broadcast carries inJail: false, jailCards: 0', bCardEvt?.inJail === false && bCardEvt?.jailCards === 0);

    state = await syncState(A);
    check('G2: server state confirms P1 is out of jail', playerIn(state, 1)?.inJail === false);
    check('G2: server state confirms P1 jailCards is 0', playerIn(state, 1)?.jailCards === 0);
    check('G2: consecutiveDoubles reset to 0', state?.consecutiveDoubles === 0);

    // P1 can now roll normally to move after card escape
    const rollAfterEscape = await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [1, 2] });
    check('G2: P1 can roll normally after escaping jail via card', !!(rollAfterEscape && rollAfterEscape.ok));

    // EXACT CONSUMPTION: Attempting to use card a second time fails with NO_JAIL_CARD
    const secondUse = await emitAck(A, 'jail:use-card', {
      playerId: 1,
      actionId: newActionId(),
    });
    check('G2: second card use rejected (already consumed)', secondUse?.ok === false);

    await cleanupRoom(A, roomId);
  }

  // --------------------------------------------------------------------------
  // TEST GROUP 3: VALIDATION: NO_JAIL_CARD AND NOT_IN_JAIL
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 3: VALIDATION CHECKS (NO_JAIL_CARD & NOT_IN_JAIL) ---');
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

    // P1 is on turn and not in jail, with 0 cards
    const resNotInJailNoCard = await emitAck(A, 'jail:use-card', {
      playerId: 1,
      actionId: newActionId(),
    });
    check('G3: rejected with NOT_IN_JAIL when player is not in jail',
      resNotInJailNoCard?.ok === false && resNotInJailNoCard?.code === 'NOT_IN_JAIL');

    // P1 speeds to jail
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [1, 1] });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [2, 2] });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [3, 3] }); // jailed for speeding

    // End turn and cycle back to P1
    await emitAck(A, 'turn:ended', { playerId: 1 });
    await emitAck(B, 'turn:ended', { playerId: 2 });

    let state = await syncState(A);
    check('G3: P1 is in jail with 0 cards', playerIn(state, 1)?.inJail === true && playerIn(state, 1)?.jailCards === 0);

    // P1 in jail with 0 cards tries to use card
    const resInJailNoCard = await emitAck(A, 'jail:use-card', {
      playerId: 1,
      actionId: newActionId(),
    });
    check('G3: rejected with NO_JAIL_CARD when player has 0 cards',
      resInJailNoCard?.ok === false && resInJailNoCard?.code === 'NO_JAIL_CARD');

    state = await syncState(A);
    check('G3: P1 remains in jail', playerIn(state, 1)?.inJail === true);

    await cleanupRoom(A, roomId);
  }

  // --------------------------------------------------------------------------
  // TEST GROUP 4: TURN GATING AND ACTION REPLAY PROTECTION
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 4: TURN GATING AND REPLAY IDEMPOTENCY ---');
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

    // P1 acquires card on tile 3
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [1, 2] });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });
    await emitAck(A, 'card:draw', { playerId: 1, actionId: newActionId(), _testForcedRoll: 4 });

    // P1 speeds to jail
    await emitAck(A, 'turn:ended', { playerId: 1 });
    await emitAck(B, 'turn:ended', { playerId: 2 });

    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [1, 1] });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [2, 2] });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [3, 3] }); // jailed

    await emitAck(A, 'turn:ended', { playerId: 1 });

    // It is now Player 2's turn. P1 is in jail and has a card, but it is NOT P1's turn.
    let state = await syncState(A);
    check('G4: current turn belongs to P2', state?.currentTurnPlayerId === 2);

    const nonTurnAttempt = await emitAck(A, 'jail:use-card', {
      playerId: 1,
      actionId: newActionId(),
    });
    check('G4: turnGate rejects non-turn player using card', nonTurnAttempt?.ok === false);

    // Advance to P1's turn
    await emitAck(B, 'turn:ended', { playerId: 2 });

    state = await syncState(A);
    check('G4: now P1 turn', state?.currentTurnPlayerId === 1);

    // Replay protection: P1 uses card with fixed actionId
    const fixedActionId = newActionId();
    const firstUse = await emitAck(A, 'jail:use-card', {
      playerId: 1,
      actionId: fixedActionId,
    });
    check('G4: first card use succeeds', !!(firstUse && firstUse.ok));

    // Replay same actionId
    const replayAttempt = await emitAck(A, 'jail:use-card', {
      playerId: 1,
      actionId: fixedActionId,
    });
    check('G4: replayed actionId rejected by actionGate',
      replayAttempt?.ok === false && replayAttempt?.code === 'DUPLICATE_ACTION');

    await cleanupRoom(A, roomId);
  }

  // --------------------------------------------------------------------------
  // TEST GROUP 5: PERSISTENCE, RECONNECT & REHYDRATION
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 5: PERSISTENCE AND RECONNECT RESTORATION ---');
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

    // P1 acquires card on tile 3
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [1, 2] });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });
    await emitAck(A, 'card:draw', { playerId: 1, actionId: newActionId(), _testForcedRoll: 4 });

    let state = await syncState(A);
    check('G5: P1 has jailCards: 1', playerIn(state, 1)?.jailCards === 1);

    // Reconnect simulation (page refresh) with tokenA
    const A2 = track(await connect());
    const rejoinRes = await emitAck(A2, 'player:rejoin', { roomId, token: tokenA });
    check('G5: A2 reconnected successfully', !!(rejoinRes && rejoinRes.ok && rejoinRes.rejoined));
    check('G5: playerState carries restored jailCards: 1',
      rejoinRes?.playerState?.me?.jailCards === 1 || playerIn(rejoinRes?.playerState, 1)?.jailCards === 1);

    await emitAck(A2, 'player:identify', { roomId, token: tokenA, playerId: 1 });

    const restoredState = await syncState(A2);
    check('G5: synced state on reconnected socket verifies jailCards: 1', playerIn(restoredState, 1)?.jailCards === 1);

    await cleanupRoom(A2, roomId);
  }

  // --------------------------------------------------------------------------
  // TEST GROUP 6: BANKRUPTCY AND ELIMINATION INVENTORY CLEANUP
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 6: BANKRUPTCY / ELIMINATION CLEARS INVENTORY ---');
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

    // P1 acquires card on tile 3
    await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [1, 2] });
    await emitAck(A, 'player:moved', { playerId: 1, actionId: newActionId() });
    await emitAck(A, 'card:draw', { playerId: 1, actionId: newActionId(), _testForcedRoll: 4 });

    let state = await syncState(A);
    check('G6: P1 holds 1 jailCard', playerIn(state, 1)?.jailCards === 1);

    // P1 declares voluntary bankruptcy
    await emitAck(A, 'player:bankrupt', { playerId: 1, actionId: newActionId() });

    state = await syncState(B);
    check('G6: P1 is bankrupt', playerIn(state, 1)?.isBankrupt === true);
    check('G6: P1 jailCards cleared to 0 upon elimination', playerIn(state, 1)?.jailCards === 0);

    await cleanupRoom(B, roomId);
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
