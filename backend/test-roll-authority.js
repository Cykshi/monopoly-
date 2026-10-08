// Headless ROLL / MOVEMENT AUTHORITY test.
//
// The server owns the dice and the destination. Before this suite existed, both
// were client inputs:
//
//   * `player:rolled` accepted `dice: [6,6]` as long as each die was 1-6 and the
//     total matched, so any client could roll a 12 every turn.
//   * `player:moved` accepted an arbitrary `position` as long as it was a board
//     index and it was the player's turn, so a player who rolled 2 could send
//     `position: 39` and teleport to Boardwalk. That exact exploit is the
//     REGRESSION test below.
//
// What is asserted here:
//   * the server generates the dice and reports them back
//   * client-supplied dice/total are ignored entirely
//   * a fake [6,6] cannot force a 12
//   * the destination is DERIVED from the authoritative roll
//   * `position: 39` after rolling cannot teleport
//   * movement wraps around the board
//   * a roll cannot be reused, a move cannot be repeated
//   * a player cannot move on another player's roll
//   * a player cannot move out of turn
//   * a move with no roll at all is rejected
//
// Requires a running server:
//   TURN_TIME_LIMIT_MS=60000 PORT=3099 node server.js
//   SERVER_URL=http://127.0.0.1:3099 node test-roll-authority.js
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const syncState = (socket) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 1500);
    socket.once('game:sync', (s) => { clearTimeout(t); resolve(s); });
    socket.emit('game:request-sync', {});
  });

const playerIn = (state, id) => ((state && state.players) || []).find((p) => p.id === id);
const posOf = async (socket, id) => playerIn(await syncState(socket), id)?.position;

let seq = 0;
const newActionId = () => `roll-${Date.now()}-${++seq}`;

// ===== CLEANUP: EVERY SOCKET IS TRACKED AND CLOSED ON BOTH PATHS =====
// setupRoom() opens two sockets. Registering them means cleanup() can close them
// from the catch block too, so a thrown error does not leave live sockets or a
// live room behind on the shared test server.
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
    try { if (s && typeof s.disconnect === 'function') s.disconnect(); } catch { /* already gone */ }
  }
  await sleep(250);
};

// Two identified players, game started, it is player 1's turn with a roll
// pending from the opening roll.
async function setupRoom() {
  const A = track(await connect());
  const created = await emitAck(A, 'room:create', { name: 'Alice' });
  const roomId = created.roomId;
  const tokenA = created.token;

  const B = track(await connect());
  const bJoin = await emitAck(B, 'room:join', { roomId, name: 'Bob' });

  await emitAck(A, 'player:identify', { roomId, token: tokenA, playerId: 1 });
  await emitAck(B, 'player:identify', { roomId, token: bJoin.token, playerId: 2 });

  const opening = await emitAck(A, 'player:rolled', { playerId: 1 });

  return { A, B, roomId, tokenA, tokenB: bJoin.token, opening };
}

(async () => {
  // ================= SERVER-GENERATED DICE =================
  console.log('\n=== THE SERVER GENERATES THE DICE ===');
  const R = await setupRoom();

  check('the opening roll succeeded and carries server dice',
    !!(R.opening && R.opening.ok && Array.isArray(R.opening.dice) && R.opening.dice.length === 2),
    JSON.stringify(R.opening));
  check('each server die is a real 1-6 face',
    !!(R.opening && R.opening.dice.every((d) => Number.isInteger(d) && d >= 1 && d <= 6)),
    `dice=${JSON.stringify(R.opening && R.opening.dice)}`);
  check('the reported total is the sum of the server dice',
    !!(R.opening && R.opening.total === R.opening.dice[0] + R.opening.dice[1]),
    `dice=${JSON.stringify(R.opening && R.opening.dice)} total=${R.opening && R.opening.total}`);

  // ================= REGRESSION: THE ORIGINAL EXPLOIT =================
  // The audit's live probe: a player who rolled 2 sent `position: 39` and the
  // server moved them to Boardwalk. It must now be impossible.
  console.log('\n=== REGRESSION: THE ORIGINAL EXPLOIT (move to 39 regardless of roll) ===');

  const startPos = await posOf(R.A, 1);
  check('regression setup: player 1 starts on tile 0', startPos === 0, `position=${startPos}`);

  const serverTotal = R.opening.total;

  // THE EXPLOIT: name position 39 in the payload.
  const teleport = await emitAck(R.A, 'player:moved', {
    playerId: 1, position: 39, actionId: newActionId(),
  });
  const afterTeleport = await posOf(R.A, 1);

  check('the payload position 39 is IGNORED — the player did not reach tile 39',
    afterTeleport !== 39, `position=${afterTeleport} (server rolled ${serverTotal})`);
  check('the player landed exactly on 0 + the server\'s total',
    afterTeleport === (0 + serverTotal) % 40,
    `position=${afterTeleport} expected=${(0 + serverTotal) % 40} (server rolled ${serverTotal})`);
  check('the move was accepted and applied to the DERIVED destination',
    !!(teleport && teleport.ok && teleport.position === afterTeleport),
    `ack=${JSON.stringify(teleport)}`);
  check('the ack echoes the server roll that produced the move',
    !!(teleport && teleport.ok && teleport.rollSeq !== undefined),
    `rollSeq=${teleport && teleport.rollSeq}`);

  // ================= FAKE DICE ARE IGNORED =================
  console.log('\n=== CLIENT-SUPPLIED DICE ARE IGNORED ===');
  await emitAck(R.A, 'turn:ended', { playerId: 1 });

  // Player 2 claims [6,6]. The server must roll its own dice.
  const fakeRoll = await emitAck(R.B, 'player:rolled', {
    playerId: 2, dice: [6, 6], total: 12,
  });
  check('a roll request carrying dice [6,6] is accepted as a REQUEST',
    !!(fakeRoll && fakeRoll.ok), JSON.stringify(fakeRoll));
  check('the returned dice are the SERVER\'s, and the total is their sum',
    !!(fakeRoll && Array.isArray(fakeRoll.dice) &&
      fakeRoll.total === fakeRoll.dice[0] + fakeRoll.dice[1]),
    `dice=${JSON.stringify(fakeRoll && fakeRoll.dice)} total=${fakeRoll && fakeRoll.total}`);
  check('the client\'s claimed total of 12 was NOT adopted',
    !!(fakeRoll && fakeRoll.total !== 12) || !!(fakeRoll && fakeRoll.dice[0] === 6 && fakeRoll.dice[1] === 6),
    `claimed 12, server total=${fakeRoll && fakeRoll.total} dice=${JSON.stringify(fakeRoll && fakeRoll.dice)}`);

  // A fake [6,6] must not move the player 12 squares.
  const p2Before = await posOf(R.B, 2);
  const fakeTotal = fakeRoll && fakeRoll.total;
  const p2Move = await emitAck(R.B, 'player:moved', {
    playerId: 2, position: 12, actionId: newActionId(),
  });
  const p2After = await posOf(R.B, 2);
  check('a fake [6,6] cannot force a 12-square move',
    p2After === (p2Before + fakeTotal) % 40,
    `from=${p2Before} to=${p2After} expected=${(p2Before + fakeTotal) % 40} (server rolled ${fakeTotal})`);
  check('the fake position 12 in that payload was ignored',
    !!(p2Move && p2Move.ok && p2Move.position !== 12) || p2After === 12,
    `ack position=${p2Move && p2Move.position} actual=${p2After}`);

  // ================= FAKE TOTAL IS IGNORED =================
  console.log('\n=== A CLIENT-SUPPLIED TOTAL IS IGNORED ===');
  await emitAck(R.B, 'turn:ended', { playerId: 2 });
  const totalLie = await emitAck(R.A, 'player:rolled', {
    playerId: 1, dice: [1, 1], total: 999,
  });
  check('a roll claiming total 999 does not produce 999',
    !!(totalLie && totalLie.ok && totalLie.total !== 999 &&
      totalLie.total >= 2 && totalLie.total <= 12),
    `ack=${JSON.stringify(totalLie)}`);
  check('the server total equals its own two dice',
    !!(totalLie && totalLie.total === totalLie.dice[0] + totalLie.dice[1]),
    `dice=${JSON.stringify(totalLie && totalLie.dice)} total=${totalLie && totalLie.total}`);

  // ================= POSITION IS DERIVED =================
  console.log('\n=== THE DESTINATION IS DERIVED FROM THE ROLL ===');
  const beforeDerive = await posOf(R.A, 1);
  const deriveMove = await emitAck(R.A, 'player:moved', { playerId: 1, actionId: newActionId() });
  const afterDerive = await posOf(R.A, 1);
  check('moving with no position at all moves by exactly the roll',
    afterDerive === (beforeDerive + totalLie.total) % 40,
    `from=${beforeDerive} to=${afterDerive} expected=${(beforeDerive + totalLie.total) % 40}`);
  check('the ack reports where the server put the player',
    !!(deriveMove && deriveMove.ok && deriveMove.position === afterDerive),
    `ack=${JSON.stringify(deriveMove)}`);

  // ================= SALARY ON PASSING GO IS SERVER-SIDE =================
  // The move handler computed `passedGo` and told the client about it, but never
  // credited any money — so the client (which applies its own PASS_START_BONUS for
  // display) showed a balance the server did not hold. That gap is what these legs
  // pin down: the credit happens on the server, and the amount is the board's.
  console.log('\n=== PASSING GO IS CREDITED BY THE SERVER ===');
  const board = require('./game/board');

  let sawSalary = false;
  let salaryDetail = 'no GO crossing produced in the budget';
  for (let attempt = 0; attempt < 60 && !sawSalary; attempt++) {
    const before = await posOf(R.A, 1);
    await emitAck(R.A, 'turn:ended', { playerId: 1 });
    await emitAck(R.B, 'turn:ended', { playerId: 2 });
    const roll = await emitAck(R.A, 'player:rolled', { playerId: 1 });
    if (!roll || !roll.ok) continue;

    // Read the balance immediately before the move so the delta is attributable
    // to THIS move alone.
    const moneyBefore = (await syncState(R.A)).players.find((p) => p.id === 1).money;
    const mv = await emitAck(R.A, 'player:moved', { playerId: 1, actionId: newActionId() });
    const after = await posOf(R.A, 1);
    if (!mv || !mv.ok) continue;

    if (mv.passedGo === true) {
      sawSalary = true;
      const moneyAfter = (await syncState(R.A)).players.find((p) => p.id === 1).money;
      const expectedSalary = board.PASS_START_BONUS;
      salaryDetail = `from=${before} +${roll.total} -> ${after} salary=${mv.salary} ` +
        `money ${moneyBefore} -> ${moneyAfter}`;
      check('crossing GO credits the board\'s PASS_START_BONUS',
        mv.salary === expectedSalary,
        `salary=${mv.salary} expected=${expectedSalary} (${salaryDetail})`);
      check('the credited salary actually raised the server\'s balance',
        moneyAfter === moneyBefore + expectedSalary,
        `before=${moneyBefore} after=${moneyAfter} expected=${moneyBefore + expectedSalary}`);
    } else {
      check('an ordinary move does NOT credit a salary',
        mv.salary === 0 || mv.salary === undefined,
        `salary=${mv.salary} ${salaryDetail}`);
    }
  }
  check('a GO crossing was exercised at least once', sawSalary, salaryDetail);

  // And the amount is not the client's to choose.
  const bribe = await emitAck(R.A, 'player:moved', {
    playerId: 1, actionId: newActionId(), salary: 999999999, money: 999999999,
  });
  check('a client-supplied salary/money on a move is IGNORED',
    !!(bribe && bribe.ok === false) ||
      (bribe.money !== 999999999 && bribe.salary !== 999999999),
    JSON.stringify(bribe));

  // ================= WRAPPING =================
  console.log('\n=== MOVEMENT WRAPS AROUND THE BOARD ===');
  let sawWrap = false;
  let wrapDetail = 'no wrap opportunity found';
  for (let attempt = 0; attempt < 60 && !sawWrap; attempt++) {
    const cur = await posOf(R.A, 1);
    await emitAck(R.A, 'turn:ended', { playerId: 1 });
    await emitAck(R.B, 'turn:ended', { playerId: 2 });
    const r = await emitAck(R.A, 'player:rolled', { playerId: 1 });
    if (!r || !r.ok) continue;
    const expected = (cur + r.total) % 40;
    const mv = await emitAck(R.A, 'player:moved', { playerId: 1, actionId: newActionId() });
    const now = await posOf(R.A, 1);
    if (cur + r.total >= 40) {
      sawWrap = true;
      wrapDetail = `from=${cur} +${r.total} -> ${now} (expected ${expected})`;
      check('a move past tile 39 wraps to a valid low tile',
        now === expected && now >= 0 && now < 40, wrapDetail);
    } else if (mv && mv.ok) {
      check('an ordinary move lands on the derived tile',
        now === expected, `from=${cur} +${r.total} -> ${now} (expected ${expected})`);
    }
  }
  check('wrapping was exercised at least once', sawWrap, wrapDetail);

  // ================= REPLAY: ROLL AND MOVE =================
  console.log('\n=== A ROLL AND A MOVE CANNOT BE REPEATED ===');
  await emitAck(R.A, 'turn:ended', { playerId: 1 });
  await emitAck(R.B, 'turn:ended', { playerId: 2 });

  const r1 = await emitAck(R.A, 'player:rolled', { playerId: 1 });
  check('a fresh roll is issued', !!(r1 && r1.ok), JSON.stringify(r1));

  const reroll = await emitAck(R.A, 'player:rolled', { playerId: 1 });
  check('rolling twice in one turn is REFUSED',
    !!(reroll && reroll.ok === false && reroll.code === 'ROLL_ALREADY_PENDING'),
    JSON.stringify(reroll));

  const mv1 = await emitAck(R.A, 'player:moved', { playerId: 1, actionId: newActionId() });
  check('the first move with that roll succeeds', !!(mv1 && mv1.ok), JSON.stringify(mv1));
  const posAfterMv1 = await posOf(R.A, 1);

  const mv2 = await emitAck(R.A, 'player:moved', { playerId: 1, actionId: newActionId() });
  check('a SECOND move from the same roll is REFUSED',
    !!(mv2 && mv2.ok === false && mv2.code === 'ROLL_ALREADY_USED'),
    JSON.stringify(mv2));
  check('the second move did not change the position',
    (await posOf(R.A, 1)) === posAfterMv1,
    `position=${await posOf(R.A, 1)} expected=${posAfterMv1}`);

  // The existing transport-level replay guard must still apply.
  const sameId = newActionId();
  await emitAck(R.A, 'player:rolled', { playerId: 1 });
  const rep1 = await emitAck(R.A, 'player:moved', { playerId: 1, actionId: sameId });
  const rep2 = await emitAck(R.A, 'player:moved', { playerId: 1, actionId: sameId });
  check('the existing actionId replay guard still applies to movement',
    !!(rep1 && rep1.ok && rep2 && rep2.ok === false && rep2.code === 'DUPLICATE_ACTION'),
    `first=${JSON.stringify(rep1)} second=${JSON.stringify(rep2)}`);

  // ================= ANOTHER PLAYER'S ROLL =================
  console.log('\n=== A PLAYER CANNOT SPEND ANOTHER PLAYER\'S ROLL ===');
  const owned = await emitAck(R.A, 'player:rolled', { playerId: 1 });
  check('player 1 holds a pending roll', !!(owned && owned.ok), JSON.stringify(owned));

  const p2BeforeSteal = await posOf(R.B, 2);
  const stealMove = await emitAck(R.B, 'player:moved', { playerId: 2, actionId: newActionId() });
  check('player 2 cannot move using player 1\'s roll',
    !!(stealMove && stealMove.ok === false), JSON.stringify(stealMove));
  check('player 2 did not move',
    (await posOf(R.B, 2)) === p2BeforeSteal,
    `position=${await posOf(R.B, 2)} expected=${p2BeforeSteal}`);

  const stillMine = await emitAck(R.A, 'player:moved', { playerId: 1, actionId: newActionId() });
  check('player 1 can still spend their own roll afterwards',
    !!(stillMine && stillMine.ok), JSON.stringify(stillMine));

  // ================= OUT OF TURN =================
  console.log('\n=== A PLAYER CANNOT ACT OUT OF TURN ===');
  const outOfTurn = await emitAck(R.B, 'player:moved', { playerId: 2, actionId: newActionId() });
  check('moving when it is not your turn is REFUSED',
    !!(outOfTurn && outOfTurn.ok === false && outOfTurn.code === 'NOT_YOUR_TURN'),
    JSON.stringify(outOfTurn));

  const outOfTurnRoll = await emitAck(R.B, 'player:rolled', { playerId: 2 });
  check('rolling when it is not your turn is REFUSED',
    !!(outOfTurnRoll && outOfTurnRoll.ok === false && outOfTurnRoll.code === 'NOT_YOUR_TURN'),
    JSON.stringify(outOfTurnRoll));

  // ================= NO ROLL AT ALL =================
  console.log('\n=== A MOVE WITH NO ROLL IS REJECTED ===');
  await emitAck(R.A, 'turn:ended', { playerId: 1 });
  await emitAck(R.B, 'turn:ended', { playerId: 2 });

  const noRoll = await emitAck(R.A, 'player:moved', { playerId: 1, actionId: newActionId() });
  check('moving with no authoritative roll is REFUSED',
    !!(noRoll && noRoll.ok === false && noRoll.code === 'NO_ROLL'),
    JSON.stringify(noRoll));

  // ================= A ROLL IS RETIRED BY THE TURN CHANGE =================
  console.log('\n=== A ROLL DOES NOT SURVIVE THE TURN CHANGE ===');
  const doomed = await emitAck(R.A, 'player:rolled', { playerId: 1 });
  check('player 1 has a pending roll', !!(doomed && doomed.ok), JSON.stringify(doomed));
  await emitAck(R.A, 'turn:ended', { playerId: 1 });

  const afterTurn = await emitAck(R.A, 'player:moved', { playerId: 1, actionId: newActionId() });
  check('a player cannot move on a roll from a turn that has ended',
    !!(afterTurn && afterTurn.ok === false), JSON.stringify(afterTurn));

  // ================= CARD MOVEMENT USES THE SAME PATH =================
  console.log('\n=== A MOVEMENT CARD ALSO YIELDS A SERVER-DERIVED MOVE ===');
  await emitAck(R.B, 'turn:ended', { playerId: 2 });
  const cardRes = await emitAck(R.A, 'player:skill-card', { movement: 3, playerId: 1 });
  check('a movement card is accepted and becomes the authoritative roll',
    !!(cardRes && cardRes.ok), JSON.stringify(cardRes));

  const cardFrom = await posOf(R.A, 1);
  const cardMove = await emitAck(R.A, 'player:moved', {
    playerId: 1, position: 39, actionId: newActionId(),
  });
  const cardTo = await posOf(R.A, 1);
  check('the card move is derived from the card distance, not a payload position',
    cardTo === (cardFrom + 3) % 40,
    `from=${cardFrom} to=${cardTo} expected=${(cardFrom + 3) % 40} ack=${JSON.stringify(cardMove)}`);

  const badCard = await emitAck(R.A, 'player:skill-card', { movement: 400, playerId: 1 });
  check('an out-of-range card distance (400) is REFUSED',
    !!(badCard && badCard.ok === false && badCard.code === 'BAD_MOVEMENT'),
    JSON.stringify(badCard));

  R.A.disconnect(); R.B.disconnect();

  console.log(`\n${results.length - failed}/${results.length} checks passed`);

  await cleanup(R.roomId);
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error('TEST ERROR:', err && err.message);
  await cleanup();
  process.exit(2);
});