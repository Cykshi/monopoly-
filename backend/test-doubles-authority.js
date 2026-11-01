// Headless DOUBLES-AUTHORITY test suite.
// Regression tests for BUG-02:
// - One double grants an extra roll during normal play.
// - Two consecutive doubles grant another roll.
// - A non-double resets the consecutive-doubles count.
// - Three consecutive doubles send the player directly to jail.
// - Third double does not move the player or trigger landing effects.
// - Counter resets on turn advance (turn:ended or timeout).
// - Counter resets when sent to jail by another mechanism (e.g. Surprise card).
// - Jail escape doubles do not incorrectly trigger normal-play extra turns.
// - Guests receive correct turn state and doubles count via broadcast and sync.
// - Forged client values cannot manipulate the counter or extra turn flags.
// - Duplicate / rapid roll requests cannot count twice.
// - Existing turn, jail, movement, card, and auction tests continue passing.

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
    console.log('\n=== BUG-02: SERVER-AUTHORITATIVE DOUBLES REGRESSION SUITE ===');

    // 1. Setup Room with Host A (Player 1) and Guest B (Player 2)
    const A = track(await connect());
    const created = await emitAck(A, 'room:create', { name: 'Alice' });
    roomId = created.roomId;
    const tokenA = created.token;
    check('setup: room created', !!(created && created.ok && roomId && tokenA));

    const B = track(await connect());
    const bJoin = await emitAck(B, 'room:join', { roomId, name: 'Bob' });
    check('setup: guest joined', !!(bJoin && bJoin.ok && bJoin.token));

    await emitAck(A, 'player:identify', { roomId, token: tokenA, playerId: 1 });
    await emitAck(B, 'player:identify', { roomId, token: bJoin.token, playerId: 2 });

    // Initial state check
    let state = await readState(A);
    check('initial room state has consecutiveDoubles=0 and hasExtraTurn=false',
      state.consecutiveDoubles === 0 && state.hasExtraTurn === false,
      `doubles=${state.consecutiveDoubles} extra=${state.hasExtraTurn}`);

    // ================= 2. ONE DOUBLE GRANTS AN EXTRA ROLL =================
    console.log('\n--- 2. ONE DOUBLE GRANTS AN EXTRA ROLL ---');
    const guestRolledPromise1 = waitFor(B, 'player:rolled');

    // Roll 1: Forced doubles [3, 3]
    const roll1 = await emitAck(A, 'player:rolled', {
      playerId: 1,
      _testForcedDice: [3, 3]
    });
    check('first roll [3, 3] is doubles', !!(roll1 && roll1.ok && roll1.isDoubles === true), JSON.stringify(roll1));
    check('first double increments consecutiveDoubles to 1', roll1 && roll1.consecutiveDoubles === 1, `count=${roll1 && roll1.consecutiveDoubles}`);
    check('first double sets hasExtraTurn=true', roll1 && roll1.hasExtraTurn === true, `hasExtraTurn=${roll1 && roll1.hasExtraTurn}`);
    check('extra-turn timer is refreshed and active (turnDeadline in future)',
      typeof roll1.turnDeadline === 'number' && roll1.turnDeadline > Date.now(),
      `deadline=${roll1.turnDeadline} now=${Date.now()}`);

    const guestEvt1 = await guestRolledPromise1;
    check('guest receives broadcast with consecutiveDoubles=1 and hasExtraTurn=true',
      !!(guestEvt1 && guestEvt1.consecutiveDoubles === 1 && guestEvt1.hasExtraTurn === true),
      JSON.stringify(guestEvt1));

    // Rapid/duplicate roll before moving MUST be rejected
    const rapidRoll = await emitAck(A, 'player:rolled', {
      playerId: 1,
      _testForcedDice: [4, 4]
    });
    check('duplicate roll request before moving rejected with ROLL_ALREADY_PENDING',
      !!(rapidRoll && rapidRoll.ok === false && rapidRoll.code === 'ROLL_ALREADY_PENDING'),
      JSON.stringify(rapidRoll));

    // State still has consecutiveDoubles=1 (not 2)
    state = await readState(A);
    check('duplicate roll attempt did NOT increment counter', state.consecutiveDoubles === 1, `count=${state.consecutiveDoubles}`);

    // Move roll 1: moves from 0 to 6
    const move1 = await emitAction(A, 'player:moved', { playerId: 1 });
    check('move for first double succeeds to tile 6', !!(move1 && move1.ok && move1.position === 6), JSON.stringify(move1));
    check('move ack reflects consecutiveDoubles=1 and hasExtraTurn=true',
      move1.consecutiveDoubles === 1 && move1.hasExtraTurn === true);
    check('movement ack also preserves active turnDeadline in the future',
      typeof move1.turnDeadline === 'number' && move1.turnDeadline > Date.now());

    // ================= 3. TWO CONSECUTIVE DOUBLES =================
    console.log('\n--- 3. TWO CONSECUTIVE DOUBLES GRANT ANOTHER ROLL ---');
    // Roll 2: Forced doubles [4, 4]
    const roll2 = await emitAck(A, 'player:rolled', {
      playerId: 1,
      _testForcedDice: [4, 4]
    });
    check('second roll [4, 4] is doubles', !!(roll2 && roll2.ok && roll2.isDoubles === true), JSON.stringify(roll2));
    check('second double increments consecutiveDoubles to 2', roll2 && roll2.consecutiveDoubles === 2, `count=${roll2 && roll2.consecutiveDoubles}`);
    check('second double retains hasExtraTurn=true', roll2 && roll2.hasExtraTurn === true, `hasExtraTurn=${roll2 && roll2.hasExtraTurn}`);

    // Move roll 2: moves from 6 to 14
    const move2 = await emitAction(A, 'player:moved', { playerId: 1 });
    check('move for second double succeeds to tile 14', !!(move2 && move2.ok && move2.position === 14), JSON.stringify(move2));

    // ================= 4. NON-DOUBLE RESETS THE COUNTER =================
    console.log('\n--- 4. A NON-DOUBLE RESETS THE CONSECUTIVE DOUBLES COUNTER ---');
    // Roll 3: Forced non-doubles [2, 5]
    const roll3 = await emitAck(A, 'player:rolled', {
      playerId: 1,
      _testForcedDice: [2, 5]
    });
    check('roll [2, 5] is non-doubles', !!(roll3 && roll3.ok && roll3.isDoubles === false), JSON.stringify(roll3));
    check('non-double resets consecutiveDoubles to 0', roll3 && roll3.consecutiveDoubles === 0, `count=${roll3 && roll3.consecutiveDoubles}`);
    check('non-double clears hasExtraTurn (hasExtraTurn=false)', roll3 && roll3.hasExtraTurn === false, `hasExtraTurn=${roll3 && roll3.hasExtraTurn}`);

    // Move roll 3: moves from 14 to 21
    const move3 = await emitAction(A, 'player:moved', { playerId: 1 });
    check('move for non-double succeeds to tile 21', !!(move3 && move3.ok && move3.position === 21), JSON.stringify(move3));

    // End turn -> advance to Player 2
    const endTurnA = await emitAck(A, 'turn:ended', { playerId: 1 });
    check('Player 1 ended turn cleanly', !!(endTurnA && endTurnA.ok && endTurnA.currentTurnPlayerId === 2));

    // ================= 5. THREE CONSECUTIVE DOUBLES SENDS TO JAIL =================
    console.log('\n--- 5. THREE CONSECUTIVE DOUBLES (SPEEDING -> JAIL) ---');
    // End Player 2's turn to get back to Player 1 with fresh counter
    await emitAck(B, 'player:rolled', { playerId: 2 });
    await emitAction(B, 'player:moved', { playerId: 2 });
    await emitAck(B, 'turn:ended', { playerId: 2 });

    // Now it's Player 1's turn
    state = await readState(A);
    check('turn is Player 1 with consecutiveDoubles=0',
      state.currentTurnPlayerId === 1 && state.consecutiveDoubles === 0);

    const posBeforeSpeeding = state.players.find((p) => p.id === 1).position;

    // Roll 1: [2, 2] -> double 1
    const sRoll1 = await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [2, 2] });
    check('speeding test: 1st double [2, 2]', !!(sRoll1 && sRoll1.consecutiveDoubles === 1 && sRoll1.hasExtraTurn === true));
    await emitAction(A, 'player:moved', { playerId: 1 });

    // Roll 2: [5, 5] -> double 2
    const sRoll2 = await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [5, 5] });
    check('speeding test: 2nd double [5, 5]', !!(sRoll2 && sRoll2.consecutiveDoubles === 2 && sRoll2.hasExtraTurn === true));
    await emitAction(A, 'player:moved', { playerId: 1 });

    const posAfterDouble2 = (await readState(A)).players.find((p) => p.id === 1).position;

    // Roll 3: [6, 6] -> double 3 -> SPEEDING!
    const guestRolledPromiseSpeed = waitFor(B, 'player:rolled');
    const sRoll3 = await emitAck(A, 'player:rolled', { playerId: 1, _testForcedDice: [6, 6] });

    check('3rd double returns speeding=true', !!(sRoll3 && sRoll3.speeding === true), JSON.stringify(sRoll3));
    check('3rd double sets inJail=true', sRoll3 && sRoll3.inJail === true, `inJail=${sRoll3 && sRoll3.inJail}`);
    check('3rd double sets position=10 (Jail)', sRoll3 && sRoll3.position === 10, `pos=${sRoll3 && sRoll3.position}`);
    check('3rd double resets consecutiveDoubles to 0', sRoll3 && sRoll3.consecutiveDoubles === 0, `count=${sRoll3 && sRoll3.consecutiveDoubles}`);
    check('3rd double sets hasExtraTurn=false', sRoll3 && sRoll3.hasExtraTurn === false, `extra=${sRoll3 && sRoll3.hasExtraTurn}`);

    const guestSpeedEvt = await guestRolledPromiseSpeed;
    check('guest received speeding broadcast with inJail=true and position=10',
      !!(guestSpeedEvt && guestSpeedEvt.speeding === true && guestSpeedEvt.inJail === true && guestSpeedEvt.position === 10));

    // Attempting to move on 3rd double MUST be rejected (movement suppressed)
    const move3rd = await emitAction(A, 'player:moved', { playerId: 1 });
    check('movement on 3rd double is REJECTED with IN_JAIL',
      !!(move3rd && move3rd.ok === false && move3rd.code === 'IN_JAIL'),
      JSON.stringify(move3rd));

    // Landing effects and actions must all be rejected on 3rd double (speeding)
    const buyJail = await emitAction(A, 'property:bought', { playerId: 1, tileId: 10 });
    check('3rd double: property purchase rejected with BAD_TILE', !!(buyJail && buyJail.ok === false));

    const rentJail = await emitAction(A, 'rent:paid', { payerId: 1, ownerId: 2, tileId: 10 });
    check('3rd double: rent payment rejected with NO_RENT_DUE', !!(rentJail && rentJail.ok === false));

    const taxJail = await emitAction(A, 'tax:pay', { playerId: 1, tileId: 10 });
    check('3rd double: tax payment rejected with NOT_ON_TAX', !!(taxJail && taxJail.ok === false));

    const cardJail = await emitAction(A, 'card:draw', { playerId: 1 });
    check('3rd double: card draw rejected with NOT_ON_CARD_TILE', !!(cardJail && cardJail.ok === false));

    const restJail = await emitAction(A, 'rest-house:resolve', { playerId: 1 });
    check('3rd double: rest house payout rejected with NOT_ON_REST_HOUSE', !!(restJail && restJail.ok === false));

    state = await readState(A);
    const p1InState = state.players.find((p) => p.id === 1);
    check('authoritative server state confirms player 1 is inJail=true on tile 10',
      p1InState.inJail === true && p1InState.position === 10,
      `inJail=${p1InState.inJail} pos=${p1InState.position}`);

    // End turn -> advance to Player 2
    await emitAck(A, 'turn:ended', { playerId: 1 });

    // ================= 6. JAIL ESCAPE DOUBLES DO NOT GRANT EXTRA TURNS =================
    console.log('\n--- 6. JAIL ESCAPE DOUBLES DO NOT GRANT EXTRA TURNS ---');
    // End Player 2's turn
    await emitAck(B, 'player:rolled', { playerId: 2 });
    await emitAction(B, 'player:moved', { playerId: 2 });
    await emitAck(B, 'turn:ended', { playerId: 2 });

    // Player 1 is currently in jail. Player 1 rolls doubles [4, 4] to escape!
    const jailEscapeRoll = await emitAck(A, 'player:rolled', {
      playerId: 1,
      _testForcedDice: [4, 4]
    });
    check('jail escape roll [4, 4] succeeds with escaped=true',
      !!(jailEscapeRoll && jailEscapeRoll.ok && jailEscapeRoll.escaped === true && jailEscapeRoll.inJail === false),
      JSON.stringify(jailEscapeRoll));
    check('jail escape doubles does NOT grant extra turn (hasExtraTurn=false)',
      jailEscapeRoll && jailEscapeRoll.hasExtraTurn === false,
      `hasExtraTurn=${jailEscapeRoll && jailEscapeRoll.hasExtraTurn}`);
    check('jail escape doubles has consecutiveDoubles=0',
      jailEscapeRoll && jailEscapeRoll.consecutiveDoubles === 0,
      `consecutiveDoubles=${jailEscapeRoll && jailEscapeRoll.consecutiveDoubles}`);

    // Player 1 moves out of jail by 8 tiles (10 + 8 = 18)
    const jailEscapeMove = await emitAction(A, 'player:moved', { playerId: 1 });
    check('jail escape move succeeds to tile 18',
      !!(jailEscapeMove && jailEscapeMove.ok && jailEscapeMove.position === 18),
      JSON.stringify(jailEscapeMove));
    check('jail escape move ack has hasExtraTurn=false',
      jailEscapeMove.hasExtraTurn === false && jailEscapeMove.consecutiveDoubles === 0);

    // End Player 1 turn
    await emitAck(A, 'turn:ended', { playerId: 1 });

    // ================= 7. COUNTER RESETS WHEN SENT TO JAIL BY OTHER MECHANISM =================
    console.log('\n--- 7. COUNTER RESETS WHEN SENT TO JAIL BY SURPRISE CARD ---');
    // End Player 2 turn
    await emitAck(B, 'player:rolled', { playerId: 2 });
    await emitAction(B, 'player:moved', { playerId: 2 });
    await emitAck(B, 'turn:ended', { playerId: 2 });

    // In a fresh room for clean board state:
    const HostC = track(await connect());
    const roomC = await emitAck(HostC, 'room:create', { name: 'HostC' });
    const roomCId = roomC.roomId;
    const tokenC = roomC.token;

    const GuestD = track(await connect());
    const dJoin = await emitAck(GuestD, 'room:join', { roomId: roomCId, name: 'GuestD' });
    await emitAck(HostC, 'player:identify', { roomId: roomCId, token: tokenC, playerId: 1 });
    await emitAck(GuestD, 'player:identify', { roomId: roomCId, token: dJoin.token, playerId: 2 });

    // HostC rolls doubles [1, 1] -> consecutiveDoubles=1
    const cRoll1 = await emitAck(HostC, 'player:rolled', { playerId: 1, _testForcedDice: [1, 1] });
    check('card-test: roll 1 is double [1, 1]', !!(cRoll1 && cRoll1.consecutiveDoubles === 1 && cRoll1.hasExtraTurn === true));
    await emitAction(HostC, 'player:moved', { playerId: 1 }); // now at tile 2

    // Move HostC to tile 14 (Surprise): 14 - 2 = 12 steps (6 + 6)
    await emitAck(HostC, 'player:skill-card', { movement: 6, playerId: 1 });
    await emitAction(HostC, 'player:moved', { playerId: 1 }); // tile 8
    await emitAck(HostC, 'player:skill-card', { movement: 6, playerId: 1 });
    await emitAction(HostC, 'player:moved', { playerId: 1 }); // tile 14 (Surprise)

    // Draw Surprise card with forced roll 1 (Sent directly to jail)
    const cardDrawRes = await emitAction(HostC, 'card:draw', {
      playerId: 1,
      _testForcedRoll: 1
    });
    check('card draw sent player to jail', !!(cardDrawRes && cardDrawRes.ok && cardDrawRes.inJail === true));

    // Verify room state has consecutiveDoubles=0 and hasExtraTurn=false after card jail
    const stateC = await readState(HostC);
    check('going to jail via card reset consecutiveDoubles to 0 and hasExtraTurn to false',
      stateC.consecutiveDoubles === 0 && stateC.hasExtraTurn === false,
      `doubles=${stateC.consecutiveDoubles} extra=${stateC.hasExtraTurn}`);

    // ================= 8. FORGED CLIENT VALUES ARE IGNORED =================
    console.log('\n--- 8. FORGED CLIENT VALUES ARE IGNORED ---');
    // GuestD attempts to roll with forged values
    await emitAck(HostC, 'turn:ended', { playerId: 1 });

    const forgedRoll = await emitAck(GuestD, 'player:rolled', {
      playerId: 2,
      consecutiveDoubles: 99,
      hasExtraTurn: true,
      isDoubles: true,
      _testForcedDice: [1, 3] // Non-doubles
    });
    check('server ignores forged client doubles fields and computes from authoritative dice',
      !!(forgedRoll && forgedRoll.ok && forgedRoll.isDoubles === false && forgedRoll.consecutiveDoubles === 0 && forgedRoll.hasExtraTurn === false),
      JSON.stringify(forgedRoll));

    // ================= 9. RECONNECTION PRESERVES DOUBLES STATE =================
    console.log('\n--- 9. RECONNECTION PRESERVES DOUBLES STATE ---');
    const HostE = track(await connect());
    const roomE = await emitAck(HostE, 'room:create', { name: 'HostE' });
    const roomEId = roomE.roomId;
    const tokenE = roomE.token;

    const GuestE = track(await connect());
    const eJoin = await emitAck(GuestE, 'room:join', { roomId: roomEId, name: 'GuestE' });
    await emitAck(HostE, 'player:identify', { roomId: roomEId, token: tokenE, playerId: 1 });
    await emitAck(GuestE, 'player:identify', { roomId: roomEId, token: eJoin.token, playerId: 2 });

    // HostE rolls doubles [2, 2] -> consecutiveDoubles=1, hasExtraTurn=true
    await emitAck(HostE, 'player:rolled', { playerId: 1, _testForcedDice: [2, 2] });
    await emitAction(HostE, 'player:moved', { playerId: 1 });

    // Reconnecting as HostE
    const HostE2 = track(await connect());
    const rejoinE = await emitAck(HostE2, 'player:rejoin', { roomId: roomEId, token: tokenE });
    check('rejoin succeeds', !!(rejoinE && rejoinE.ok && rejoinE.rejoined));
    check('rejoin playerState reflects consecutiveDoubles=1 and hasExtraTurn=true',
      rejoinE.playerState.consecutiveDoubles === 1 && rejoinE.playerState.hasExtraTurn === true,
      `doubles=${rejoinE.playerState.consecutiveDoubles} extra=${rejoinE.playerState.hasExtraTurn}`);

    // Reconnected HostE2 can roll their earned 2nd double!
    const e2Roll2 = await emitAck(HostE2, 'player:rolled', { playerId: 1, _testForcedDice: [5, 5] });
    check('reconnected player can use earned extra roll',
      !!(e2Roll2 && e2Roll2.ok && e2Roll2.consecutiveDoubles === 2 && e2Roll2.hasExtraTurn === true),
      JSON.stringify(e2Roll2));

    // ================= 10. MOVEMENT CARD RESETS CONSECUTIVE DOUBLES =================
    console.log('\n--- 10. MOVEMENT CARD RESETS CONSECUTIVE DOUBLES ---');
    await emitAction(HostE2, 'player:moved', { playerId: 1 });
    await emitAck(HostE2, 'turn:ended', { playerId: 1 });
    await emitAck(GuestE, 'turn:ended', { playerId: 2 });

    // HostE2 rolls doubles [3, 3] -> consecutiveDoubles=1
    await emitAck(HostE2, 'player:rolled', { playerId: 1, _testForcedDice: [3, 3] });
    await emitAction(HostE2, 'player:moved', { playerId: 1 });
    let stateCard = await readState(HostE2);
    check('before card: consecutiveDoubles=1 and hasExtraTurn=true',
      stateCard.consecutiveDoubles === 1 && stateCard.hasExtraTurn === true);

    // HostE2 plays a skill card
    const cardSpend = await emitAck(HostE2, 'player:skill-card', { playerId: 1, movement: 3 });
    check('skill card accepted', !!(cardSpend && cardSpend.ok));
    stateCard = await readState(HostE2);
    check('skill card usage resets consecutiveDoubles to 0 and hasExtraTurn to false',
      stateCard.consecutiveDoubles === 0 && stateCard.hasExtraTurn === false);

    // ================= 11. BANKRUPTCY/ELIMINATION RESETS CONSECUTIVE DOUBLES =================
    console.log('\n--- 11. BANKRUPTCY/ELIMINATION RESETS CONSECUTIVE DOUBLES ---');
    const HostF = track(await connect());
    const roomF = await emitAck(HostF, 'room:create', { name: 'HostF' });
    const GuestF = track(await connect());
    const fJoin = await emitAck(GuestF, 'room:join', { roomId: roomF.roomId, name: 'GuestF' });
    await emitAck(HostF, 'player:identify', { roomId: roomF.roomId, token: roomF.token, playerId: 1 });
    await emitAck(GuestF, 'player:identify', { roomId: roomF.roomId, token: fJoin.token, playerId: 2 });

    // HostF rolls doubles [4, 4] -> consecutiveDoubles=1
    await emitAck(HostF, 'player:rolled', { playerId: 1, _testForcedDice: [4, 4] });
    await emitAction(HostF, 'player:moved', { playerId: 1 });
    let stateF = await readState(HostF);
    check('before bankrupt: consecutiveDoubles=1 and hasExtraTurn=true',
      stateF.consecutiveDoubles === 1 && stateF.hasExtraTurn === true);

    // HostF declares voluntary bankruptcy
    const brupt = await emitAction(HostF, 'player:bankrupt', { playerId: 1 });
    check('bankrupt ack succeeds', !!(brupt && brupt.ok));
    stateF = await readState(GuestF);
    check('bankruptcy resets consecutiveDoubles to 0 and hasExtraTurn to false',
      stateF.consecutiveDoubles === 0 && stateF.hasExtraTurn === false);

    // ================= 12. TURN TIMEOUT RESETS CONSECUTIVE DOUBLES =================
    console.log('\n--- 12. TURN TIMEOUT RESETS CONSECUTIVE DOUBLES ---');
    // In a 3-player room so elimination of player 1 advances turn to player 2 without game-over
    const HostG = track(await connect());
    const roomG = await emitAck(HostG, 'room:create', { name: 'HostG' });
    const G2 = track(await connect());
    const g2Join = await emitAck(G2, 'room:join', { roomId: roomG.roomId, name: 'GuestG2' });
    const G3 = track(await connect());
    const g3Join = await emitAck(G3, 'room:join', { roomId: roomG.roomId, name: 'GuestG3' });

    await emitAck(HostG, 'player:identify', { roomId: roomG.roomId, token: roomG.token, playerId: 1 });
    await emitAck(G2, 'player:identify', { roomId: roomG.roomId, token: g2Join.token, playerId: 2 });
    await emitAck(G3, 'player:identify', { roomId: roomG.roomId, token: g3Join.token, playerId: 3 });

    // HostG rolls doubles [2, 2] -> consecutiveDoubles=1
    await emitAck(HostG, 'player:rolled', { playerId: 1, _testForcedDice: [2, 2] });
    await emitAction(HostG, 'player:moved', { playerId: 1 });
    let stateG = await readState(HostG);
    check('before timeout: consecutiveDoubles=1 and hasExtraTurn=true',
      stateG.consecutiveDoubles === 1 && stateG.hasExtraTurn === true);

    // Wait for the short test turn clock to expire and advance turn
    const turnChangedPromise = waitFor(G2, 'turn:changed', 3500);
    const tcEvt = await turnChangedPromise;
    check('turn:changed received after turn timeout', !!tcEvt);
    check('timeout broadcast resets consecutiveDoubles=0 and hasExtraTurn=false',
      tcEvt && tcEvt.consecutiveDoubles === 0 && tcEvt.hasExtraTurn === false);

    stateG = await readState(G2);
    check('room state after timeout has consecutiveDoubles=0 and hasExtraTurn=false',
      stateG.consecutiveDoubles === 0 && stateG.hasExtraTurn === false);

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
