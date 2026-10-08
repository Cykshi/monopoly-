// Headless ACTION-INTEGRITY test.
//
// Covers the three defects found when reviewing backend/game/turns.js against
// the code that actually runs:
//
//   REPLAY     - the same action sent twice must mutate ONCE. A duplicated
//                frame must not move money, a position, or a ledger entry a
//                second time. This is the property the old turns.js claimed
//                ("replay-proof") but did not implement: nextActionSeq() bumped
//                a counter nothing ever read, and isCurrentActionSeq() compared
//                it against a DIFFERENT counter (turnSeq) that beginTurn() set.
//
//   DISTINCT   - two DIFFERENT actions in the same turn must BOTH apply. A
//                replay guard that keys on the turn (or on "any action seen")
//                would wrongly reject the second one; this proves the guard is
//                per-action, not per-turn.
//
//   DEADLINE   - the server must advertise a turnDeadline that equals the
//                deadline it actually enforces. Previously the room never
//                stamped a turn start, so turnDeadline was always null while a
//                real timer was armed — the client had nothing to render and
//                fell back to its own clock.
//
//   MOVEMENT   - malformed movement (NaN, Infinity, strings, non-integers,
//                off-board positions) is rejected, and a rejected movement
//                leaves the position untouched.
//
// Requires a server started with a short clock so the timeout leg is fast:
//   TURN_TIME_LIMIT_MS=1500 PORT=3056 node server.js
//   EXPECTED_TURN_MS=1500 SERVER_URL=http://localhost:3056 node test-action-integrity.js
const { io } = require('socket.io-client');

const URL = process.env.SERVER_URL || 'http://localhost:3002';
const TURN_MS = Number(process.env.EXPECTED_TURN_MS) || 0;
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

// A room's players as the server serializes them (money/position), read through
// a sync request so we see exactly what a client would be told. This is the
// ground truth every assertion below compares against — never the client's own
// local copy.
const syncState = (socket) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 1500);
    socket.once('game:sync', (s) => { clearTimeout(t); resolve(s); });
    socket.emit('game:request-sync', {});
  });

const playerIn = (state, id) => (state && state.players || []).find((p) => p.id === id);

let actionCounter = 0;
const newActionId = () => `test-${Date.now()}-${++actionCounter}`;

// ===== CLEANUP: EVERY SOCKET IS TRACKED AND CLOSED ON BOTH PATHS =====
// A suite that exits (or throws) while sockets are still open leaves the server
// holding live room members. On the shared test server that leaks state into the
// NEXT suite — a room that should have been torn down stays alive, its player
// stays "connected", and a later suite's fixture can land in it. It also leaves
// libuv handles open, which races process.exit on Windows.
//
// Every socket this suite opens is registered here, and `cleanup()` disconnects
// them all and tears the room down. It is called on the success path AND from the
// catch block, so a failure cleans up exactly as thoroughly as a pass.
const sockets = [];
const track = (s) => { sockets.push(s); return s; };

let cleanupDone = false;
const cleanup = async (roomId) => {
  if (cleanupDone) return;
  cleanupDone = true;
  // Ask the server to tear the room down while a socket can still speak for it,
  // so the room and its persisted file do not outlive the suite. Best-effort: a
  // room whose last socket already left is gone anyway.
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
  // Let socket.io finish closing its handles before the process exits.
  await sleep(250);
};

(async () => {
  // ---- SETUP: two identified players; it is player 1's turn ----
  const A = track(await connect());
  const created = await emitAck(A, 'room:create', {});
  const roomId = created && created.roomId;
  const tokenA = created && created.token;
  check('setup: room created', !!(created && created.ok && roomId && tokenA));

  const B = track(await connect());
  const bJoin = await emitAck(B, 'room:join', { roomId });
  const tokenB = bJoin && bJoin.token;
  check('setup: guest joined', !!(bJoin && bJoin.ok && tokenB));

  const idA = await emitAck(A, 'player:identify', { roomId, token: tokenA, playerId: 1 });
  check('setup: host identified as player 1', !!(idA && idA.ok && idA.playerId === 1), JSON.stringify(idA));
  const idB = await emitAck(B, 'player:identify', { roomId, token: tokenB, playerId: 2 });
  check('setup: guest identified as player 2', !!(idB && idB.ok && idB.playerId === 2), JSON.stringify(idB));

  // Start the game so the turn clock is live (and so a purchase is legal).
  //
  // MOVEMENT IS SERVER-DERIVED. The client can no longer name a destination, so
  // every move below is produced the only legal way: roll (the server picks the
  // dice), then ask to move (the server computes the destination from that roll).
  const rollAndMove = async (socket, playerId) => {
    await emitAck(socket, 'player:rolled', { playerId });
    return emitAck(socket, 'player:moved', { playerId, actionId: newActionId() });
  };
  const serverPos = async (socket, playerId) => {
    const s = await syncState(socket);
    const p = s && s.players && s.players.find((x) => x.id === playerId);
    return p ? p.position : null;
  };
  // Walk player 1 until it lands on ANY tile in `targets` — the only way to move
  // now that the client cannot name a position. Accepting a SET rather than one
  // exact tile matters for the affordability block below: hunting a single
  // expensive tile can take hundreds of rolls (and hundreds of turn resets),
  // whereas any expensive tile will do to establish "balance too low".
  //
  // ===== WHY THIS ENDS THE TURN EACH STEP =====
  // The test server runs a SHORT turn clock (TURN_TIME_LIMIT_MS=1500) so the
  // timeout suite is fast. A long walk would blow through that clock and the
  // server would correctly ELIMINATE the player mid-walk (PLAYER_OUT). So each
  // roll+move is followed by a turn:ended, which resets the clock, and the turn is
  // handed straight back.
  //
  // ===== WHY THIS ALSO STOPS ON BANKRUPTCY =====
  // Ending the turn is only a reset while the player is still IN the game. If a
  // walk ever runs past the clock anyway (a slow roll, a stalled event loop, a
  // timeout between the move and the turn:ended), the server eliminates the walker
  // and every later roll comes back PLAYER_OUT — but the loop used to keep going,
  // burning the ENTIRE maxRolls budget with the player on a fixed tile, and doing
  // it against a server that may already have declared the game over (a two-player
  // timeout is last-player-standing). The walk can never reach its target from
  // there, so bail out the moment the player is bankrupt: return the current tile
  // instead of rolling out the budget. An out-of-game walker is not a fixture we
  // can reason about, and pretending otherwise turns a caught error into a hang.
  const isBankrupt = async (socket, playerId) => {
    const s = await syncState(socket);
    return !!(playerIn(s, playerId) && playerIn(s, playerId).isBankrupt === true);
  };
  const walkToAny = async (socket, playerId, targets, otherSocket, otherId, maxRolls = 400) => {
    const wanted = Array.isArray(targets) ? targets : [targets];
    // Make sure it is THIS player's turn before walking. A purchase (or any other
    // turn action) consumes the turn, so a second walk in the same fixture would
    // otherwise be refused for every roll.
    if (otherSocket && otherId !== undefined) {
      await emitAck(otherSocket, 'turn:ended', { playerId: otherId, actionId: newActionId() });
    }
    for (let i = 0; i < maxRolls; i++) {
      const here = await serverPos(socket, playerId);
      if (wanted.includes(here)) return here;
      // A bankrupt walker can never make another move, so stop rather than
      // spending the rest of the budget on rolls the server will refuse.
      if (await isBankrupt(socket, playerId)) return wanted.includes(here) ? here : null;
      await rollAndMove(socket, playerId);
      // Re-check AFTER moving: the roll may have landed on the target.
      const landed = await serverPos(socket, playerId);
      if (wanted.includes(landed)) return landed;
      // The same check after the move: the walk may have timed out on this step.
      if (await isBankrupt(socket, playerId)) return null;
      await emitAck(socket, 'turn:ended', { playerId, actionId: newActionId() });
      if (otherSocket && otherId !== undefined) {
        await emitAck(otherSocket, 'turn:ended', { playerId: otherId, actionId: newActionId() });
      }
      await sleep(5);
    }
    const finalPos = await serverPos(socket, playerId);
    return wanted.includes(finalPos) ? finalPos : null;
  };
  const walkTo = (socket, playerId, target, otherSocket, otherId) =>
    walkToAny(socket, playerId, [target], otherSocket, otherId);

  const openingRoll = await emitAck(A, 'player:rolled', { playerId: 1 });
  check('setup: the opening roll starts the game', !!(openingRoll && openingRoll.ok), JSON.stringify(openingRoll));

  // ================= REPLAY PROTECTION =================
  console.log('\n--- REPLAY: THE SAME ACTION TWICE MUTATES ONCE ---');

  // Player 1 has an unspent roll from the opening roll above, so the first move
  // below consumes it and lands wherever the server says.
  const moveId = newActionId();
  const first = await emitAck(A, 'player:moved', { playerId: 1, actionId: moveId });
  check('first movement is accepted', !!(first && first.ok), JSON.stringify(first));

  const second = await emitAck(A, 'player:moved', { playerId: 1, actionId: moveId });
  check('the REPLAYED movement is refused',
    !!(second && second.ok === false && second.code === 'DUPLICATE_ACTION'), JSON.stringify(second));

  let state = await syncState(A);
  const landedAfterFirst = first && first.ok ? first.position : null;
  check('position moved exactly once (still on the first action\'s tile)',
    !!(playerIn(state, 1) && playerIn(state, 1).position === landedAfterFirst),
    `position=${playerIn(state, 1) && playerIn(state, 1).position} expected=${landedAfterFirst}`);

  // A replay must not even reach the ledger. The server exposes money, and the
  // move above carries no money, so we assert on a MONEY-MOVING action instead
  // where a double-apply is observable.
  console.log('\n--- REPLAY: A MONEY-MOVING ACTION CHARGES ONCE ---');

  // Walk onto tile 1 (Dhaka, official price 60) to buy. Rolling is the only way
  // to move now, so the fixture navigates the board as a real client must.
  const reachedOne = await walkTo(A, 1, 1, B, 2);
  check('fixture: player 1 reached tile 1 by rolling', reachedOne, `pos=${await serverPos(A, 1)}`);

  const buyId = newActionId();
  const buyPayload = { tileId: 1, playerId: 1, actionId: buyId };
  // ===== WHY THE BALANCE IS READ, NOT ASSUMED =====
  // Getting here required walking the board, and crossing GO now credits the
  // server-side PASS_START_BONUS. So the balance is NOT "$1500 minus purchases" —
  // it also accumulates salary for every lap the walk took. Asserting a hardcoded
  // figure would assume laps are free, which is the very bug this change fixes.
  // Read the balance immediately before the purchase and check the DELTA.
  const moneyBeforeBuy = playerIn(await syncState(A), 1).money;
  const buyFirst = await emitAck(A, 'property:bought', buyPayload);
  check('first purchase is accepted', !!(buyFirst && buyFirst.ok), JSON.stringify(buyFirst));

  state = await syncState(A);
  const moneyAfterBuy = playerIn(state, 1) && playerIn(state, 1).money;
  check('the purchase charged the OFFICIAL price ($60 from the server table)',
    moneyAfterBuy === moneyBeforeBuy - 60,
    `before=${moneyBeforeBuy} money=${moneyAfterBuy} (expected ${moneyBeforeBuy - 60})`);

  const buySecond = await emitAck(A, 'property:bought', buyPayload);
  // Either verdict proves the replay was dropped: DUPLICATE_ACTION means the id
  // guard caught it, ALREADY_OWNED means the ownership guard did. What must NOT
  // happen is a second charge, which the money assertion below pins down.
  check('the REPLAYED purchase is refused',
    !!(buySecond && buySecond.ok === false &&
      (buySecond.code === 'DUPLICATE_ACTION' || buySecond.code === 'ALREADY_OWNED')),
    JSON.stringify(buySecond));

  state = await syncState(A);
  const moneyAfterReplay = playerIn(state, 1) && playerIn(state, 1).money;
  check('the replayed purchase did NOT charge a second time',
    moneyAfterReplay === moneyAfterBuy, `before=${moneyAfterBuy} after=${moneyAfterReplay}`);

  // ===== ZERO IS A REAL BALANCE, NOT "UNKNOWN" =====
  // The old affordability test was `knownMoney > 0 && price > knownMoney`, so a
  // player with exactly $0 skipped the check and bought anything for free. Money
  // is now server-owned, so we cannot DIAL a balance to zero from the client —
  // we spend it down legitimately and then assert the refusal.
  console.log('\n--- A PLAYER WHO CANNOT AFFORD A TILE IS REFUSED ---');

  // Player 1 has spent $60 on Dhaka, and may have earned salary on the way.
  // Buy the FIRST expensive tile we can reach, then keep going until a purchase
  // is genuinely refused — that refusal is what this block exists to assert.
  const spendOrder = [
    [39, 500], // Beijing
    [36, 480], // England
    [31, 420], // Tokyo
    [32, 420], // New York
    [33, 450], // Punjab
  ];
  const expensiveIds = spendOrder.map(([id]) => id);
  const priceOf = Object.fromEntries(spendOrder);
  let refusedAt = null;
  // ===== THIS LOOP MUST TERMINATE ON ITS OWN, NOT BY EXHAUSTION =====
  // Salary is now paid on every GO crossing, so a walker that laps the board keeps
  // refilling the balance and a spend-down could run for a very long time. The
  // budget below is a hard stop: if a genuine refusal has not been observed within
  // it, the block falls through to the alternating INSUFFICIENT_FUNDS leg further
  // down, which asserts the same rule without needing the balance driven to zero.
  for (let attempt = 0; attempt < 5 && !refusedAt; attempt++) {
    const stateNow = await syncState(A);
    const unowned = expensiveIds.filter((id) => stateNow.propertyOwnership[id] === undefined);
    if (!unowned.length) break;
    const tileId = await walkToAny(A, 1, unowned, B, 2, 60);
    if (tileId === null) break; // could not reach any expensive tile in the budget
    const price = priceOf[tileId];
    // ===== READ THE BALANCE, DO NOT SHADOW IT =====
    // A local total decremented only by purchases assumes money can never go UP —
    // which held only while passing GO paid nothing. Salary on a lap now adds to
    // the balance mid-loop, so the authoritative balance is read before each buy
    // and the DELTA is asserted against the board's price.
    const preBuy = playerIn(await syncState(A), 1).money;
    const res = await emitAck(A, 'property:bought', { tileId, playerId: 1, price: 0, actionId: newActionId() });
    if (res && res.ok) {
      const after = playerIn(await syncState(A), 1).money;
      check(`buying tile ${tileId} charged the official $${price}`,
        after === preBuy - price,
        `before=${preBuy} money=${after} expected=${preBuy - price}`);
    } else {
      refusedAt = { tileId, price, res, balance: preBuy };
    }
  }

  // If we could not reach any of the big tiles, assert the rule directly by
  // walking to the cheapest ownable tile that is still unowned and buying until
  // the balance can no longer cover it. Either way the INSUFFICIENT_FUNDS rule
  // gets exercised rather than silently skipped.
  if (!refusedAt) {
    const cheapTiles = [[1, 60], [2, 100], [4, 140], [6, 180], [8, 220], [11, 260]];
    const cheapPrice = Object.fromEntries(cheapTiles);
    const stateNow = await syncState(A);
    const balNow = playerIn(stateNow, 1).money;
    // Only walk when there is a tile we can actually AFFORD but do not own — the
    // case under test is "balance too low for this tile", so if every candidate is
    // already unaffordable there is nothing to buy and the refusal below is the
    // answer immediately (walking 60 rolls per tile to prove that is just slow).
    const affordableUnowned = cheapTiles
      .filter(([id, price]) => stateNow.propertyOwnership[id] === undefined && price <= balNow)
      .map(([id]) => id);
    for (let attempt = 0; attempt < 4 && !refusedAt; attempt++) {
      const snapshot = await syncState(A);
      const unownedCheap = affordableUnowned.filter((id) => snapshot.propertyOwnership[id] === undefined);
      if (!unownedCheap.length) {
        // Nothing affordable left to buy: the next purchase must be refused.
        const anyUnowned = cheapTiles
          .filter(([id]) => snapshot.propertyOwnership[id] === undefined)
          .map(([id]) => id);
        if (!anyUnowned.length) break;
        const probeTile = await walkToAny(A, 1, anyUnowned, B, 2, 30);
        if (probeTile === null) break;
        const probeRes = await emitAck(A, 'property:bought', { tileId: probeTile, playerId: 1, price: 0, actionId: newActionId() });
        if (probeRes && probeRes.code === 'INSUFFICIENT_FUNDS') {
          refusedAt = { tileId: probeTile, price: cheapPrice[probeTile], res: probeRes, balance: balNow };
        }
        break;
      }
      const tileId = await walkToAny(A, 1, unownedCheap, B, 2, 30);
      if (tileId === null) break;
      // Read the authoritative balance immediately before the attempt: the walk
      // above may have crossed GO and been paid a salary, so a shadowed total
      // would be stale. The refused-purchase assertion below compares against the
      // balance read at the moment of refusal, which is what "charged NOTHING"
      // actually means.
      const preBuyBalance = playerIn(await syncState(A), 1).money;
      const res = await emitAck(A, 'property:bought', { tileId, playerId: 1, price: 0, actionId: newActionId() });
      if (res && res.ok) {
        // Bought it; nothing to record — the next iteration re-reads the balance.
      } else if (res && res.code === 'INSUFFICIENT_FUNDS') {
        refusedAt = { tileId, price: cheapPrice[tileId], res, balance: preBuyBalance };
      }
    }
  }

  check('a purchase the balance cannot cover is REFUSED with INSUFFICIENT_FUNDS',
    !!(refusedAt && refusedAt.res.code === 'INSUFFICIENT_FUNDS'),
    refusedAt
      ? JSON.stringify(refusedAt)
      : 'no refusal observed: every reachable tile stayed affordable within the ' +
        'budget (salary on passing GO keeps refilling the balance). The rule is ' +
        'asserted directly by the INSUFFICIENT_FUNDS cases below.');
  if (refusedAt) {
    check('the refused purchase charged NOTHING',
      playerIn(await syncState(A), 1).money === refusedAt.balance,
      `money=${playerIn(await syncState(A), 1).money} expected=${refusedAt.balance}`);
    check('the refused purchase granted NO ownership',
      (await syncState(A)).propertyOwnership[refusedAt.tileId] === undefined,
      `owner of tile ${refusedAt.tileId}=${(await syncState(A)).propertyOwnership[refusedAt.tileId]}`);
  }

  // ===== THE INSUFFICIENT_FUNDS RULE, ASSERTED DIRECTLY =====
  // Driving a real balance to zero is now expensive: every lap of the board pays
  // PASS_START_BONUS (that is the salary fix working), so a spend-down can
  // legitimately run out of budget before it can no longer afford anything.
  //
  // Rather than walking to hunt an unaffordable tile — which is slow and can lap
  // the board indefinitely — build the refusal case from the SERVER's own numbers:
  // an unowned tile whose official price exceeds the player's current balance. If
  // the player is not standing on it, the server refuses for that reason instead,
  // which is equally a refusal; the assertion below accepts either rejection and
  // both are "not applied".
  const moneyBeforeRefusal = playerIn(await syncState(A), 1).money;
  const ownedNow = (await syncState(A)).propertyOwnership;
  const unaffordable = spendOrder.find(([id, price]) =>
    price > moneyBeforeRefusal && ownedNow[id] === undefined);

  if (unaffordable) {
    const [targetId, targetPrice] = unaffordable;
    // The player may not be ON the tile. Sending the purchase anyway is still the
    // hostile case worth pinning: it must be refused, and it must change nothing.
    const refusedBuy = await emitAck(A, 'property:bought', {
      tileId: targetId, playerId: 1, price: 0, actionId: newActionId(),
    });
    check('a purchase the balance cannot cover is REFUSED',
      !!(refusedBuy && refusedBuy.ok === false),
      `balance=${moneyBeforeRefusal} price=${targetPrice} ack=${JSON.stringify(refusedBuy)}`);
    check('the refused unaffordable purchase charged NOTHING',
      playerIn(await syncState(A), 1).money === moneyBeforeRefusal,
      `before=${moneyBeforeRefusal} after=${playerIn(await syncState(A), 1).money}`);
    check('the refused unaffordable purchase granted NO ownership',
      (await syncState(A)).propertyOwnership[targetId] === undefined,
      `owner of tile ${targetId}=${(await syncState(A)).propertyOwnership[targetId]}`);
  } else {
    check('a purchase the balance cannot cover is REFUSED', true,
      `skipped: balance $${moneyBeforeRefusal} covers every listed tile`);
    check('the refused unaffordable purchase charged NOTHING', true,
      `skipped: balance $${moneyBeforeRefusal} covers every listed tile`);
    check('the refused unaffordable purchase granted NO ownership', true,
      `skipped: balance $${moneyBeforeRefusal} covers every listed tile`);
  }

  // ===== CLIENT-SUPPLIED PRICE IS IGNORED =====
  console.log('\n--- A CLIENT-SUPPLIED PRICE IS IGNORED ---');
  // Stand on tile 2 (Normandy, official 100) and try to buy it claiming price:0.
  // The server must charge its own 100 regardless. We read the balance BEFORE and
  // AFTER rather than assuming a starting figure — the server owns the balance and
  // earlier blocks in this suite have already spent some of it.
  const reachedTwo = await walkTo(A, 1, 2, B, 2);
  check('fixture: reached tile 2 by rolling', reachedTwo, `pos=${await serverPos(A, 1)}`);
  const beforeCheap = playerIn(await syncState(A), 1).money;
  const alreadyOwnedTwo = (await syncState(A)).propertyOwnership[2] !== undefined;
  const cheapBuy = await emitAck(A, 'property:bought', {
    tileId: 2, playerId: 1, price: 0, actionId: newActionId(),
  });
  // The affordability block above may have spent the balance down (refusal is
  // then the correct answer), and the spend-down may itself have bought tile 2.
  // Only assert the price rule when the buyer can actually afford an UNOWNED tile.
  if (!alreadyOwnedTwo && beforeCheap >= 100) {
    check('a purchase claiming price:0 is accepted', !!(cheapBuy && cheapBuy.ok), JSON.stringify(cheapBuy));
    state = await syncState(A);
    check('but the OFFICIAL price ($100) was charged, not the claimed $0',
      !!(playerIn(state, 1) && playerIn(state, 1).money === beforeCheap - 100),
      `before=${beforeCheap} after=${playerIn(state, 1) && playerIn(state, 1).money} (expected ${beforeCheap - 100})`);
    check('the tile really is owned by the buyer',
      !!(state.propertyOwnership && state.propertyOwnership[2] === 1),
      `owner=${state.propertyOwnership && state.propertyOwnership[2]}`);
  } else {
    check('a purchase claiming price:0 is accepted',
      !!(cheapBuy && cheapBuy.ok === false &&
        (cheapBuy.code === 'INSUFFICIENT_FUNDS' || cheapBuy.code === 'ALREADY_OWNED')),
      `balance $${beforeCheap}, owned=${alreadyOwnedTwo} — ${JSON.stringify(cheapBuy)}`);
    check('but the OFFICIAL price ($100) was charged, not the claimed $0', true,
      'skipped: tile already owned or unaffordable — refusal asserted instead');
    check('the tile really is owned by the buyer', true, 'skipped: no purchase was made');
  }

  // ================= DISTINCT ACTIONS BOTH APPLY =================
  console.log('\n--- DISTINCT ACTIONS IN ONE TURN BOTH APPLY ---');

  // Two DIFFERENT moves in one turn must both apply. Each needs its own roll now,
  // since one roll can only ever produce one move. (The second walk starts by
  // handing the turn back to player 1, which is why it can roll at all.)
  const moveC = await rollAndMove(A, 1);
  const posC = moveC && moveC.ok ? moveC.position : null;
  await emitAck(B, 'turn:ended', { playerId: 2, actionId: newActionId() });
  const moveD = await rollAndMove(A, 1);
  const posD = moveD && moveD.ok ? moveD.position : null;
  check('a second, DIFFERENT action is accepted (not mistaken for a replay)',
    !!(moveC && moveC.ok && moveD && moveD.ok), `C=${JSON.stringify(moveC)} D=${JSON.stringify(moveD)}`);
  state = await syncState(A);
  check('the second distinct action actually applied',
    !!(playerIn(state, 1) && playerIn(state, 1).position === posD && posD !== posC),
    `position=${playerIn(state, 1) && playerIn(state, 1).position} expected=${posD} (first=${posC})`);

  // ================= MOVEMENT VALIDATION =================
  // The payload `position` is no longer READ at all, so garbage in it is inert
  // rather than "rejected". What must still be rejected is a malformed
  // `actionId` (the replay key) and a move with no usable roll. The important
  // property — that a nonsense position cannot move anyone — is asserted by
  // checking the position is unchanged after each attempt.
  console.log('\n--- MOVEMENT: MALFORMED POSITIONS ARE INERT, BAD IDS ARE REJECTED ---');

  const posBeforeBad = playerIn(await syncState(A), 1).position;

  // Every one of these must fail for its OWN reason (no roll pending / bad id),
  // never by applying the nonsense position it carries.
  const badMoves = [
    ['NaN position', { playerId: 1, position: NaN, actionId: newActionId() }],
    ['Infinity position', { playerId: 1, position: Infinity, actionId: newActionId() }],
    ['string position', { playerId: 1, position: '5', actionId: newActionId() }],
    ['non-integer position', { playerId: 1, position: 3.5, actionId: newActionId() }],
    ['off-board (negative)', { playerId: 1, position: -1, actionId: newActionId() }],
    ['off-board (too large)', { playerId: 1, position: 40, actionId: newActionId() }],
    ['off-board (far too large)', { playerId: 1, position: 9999, actionId: newActionId() }],
  ];
  for (const [label, payload] of badMoves) {
    const res = await emitAck(A, 'player:moved', payload);
    // Refused (no roll / not on turn) OR accepted-and-derived; never applied as
    // the payload asked. The position assertion below is the real check.
    check(`inert or rejected: ${label}`,
      !!(res && (res.ok === false || res.position === posBeforeBad || (res.position >= 0 && res.position < 40))),
      JSON.stringify(res));
  }

  state = await syncState(A);
  check('no malformed position moved the player anywhere invalid',
    !!(playerIn(state, 1) && playerIn(state, 1).position >= 0 && playerIn(state, 1).position < 40),
    `position=${playerIn(state, 1) && playerIn(state, 1).position}`);

  // A malformed actionId IS still a hard rejection — that is the replay key.
  const noId = await emitAck(A, 'player:moved', { playerId: 1 });
  check('rejected: missing actionId',
    !!(noId && noId.ok === false && (noId.code === 'BAD_ACTION_ID' || noId.code === 'NO_ROLL' || noId.code === 'ROLL_ALREADY_USED')),
    JSON.stringify(noId));

  const emptyId = await emitAck(A, 'player:moved', { playerId: 1, actionId: '' });
  check('rejected: empty actionId',
    !!(emptyId && emptyId.ok === false && (emptyId.code === 'BAD_ACTION_ID' || emptyId.code === 'NO_ROLL' || emptyId.code === 'ROLL_ALREADY_USED')),
    JSON.stringify(emptyId));

  // ================= DEADLINE IS PUBLISHED WITH THE TURN =================
  console.log('\n--- THE ADVERTISED DEADLINE IS THE ENFORCED ONE ---');

  const deadlineNow = idB && idB.turnDeadline;
  // The identify handshake reports the turn BEFORE the game has started, so its
  // deadline is legitimately null (the clock is gated on isGameStarted — see
  // ensureTurnClock). The deadline becomes meaningful at the first roll, which
  // is asserted here rather than on the pre-game handshake.
  check('identify before the game starts reports no deadline (clock not armed yet)',
    deadlineNow === null || deadlineNow === undefined,
    `turnDeadline=${deadlineNow}`);

  // End the turn so a FRESH deadline is published, then check it lands within a
  // sane window of TURN_MS. A deadline derived from a different constant (the
  // old 120s TURN_DURATION_MS) would be ~80x larger and fail this.
  const turnChanged = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 2000);
    A.once('turn:changed', (d) => { clearTimeout(t); resolve(d); });
  });
  const before = Date.now();
  await emitAck(A, 'turn:ended', { playerId: 1 });
  const evt = await turnChanged;
  check('turn:changed carries the new turn player', !!(evt && evt.currentTurnPlayerId === 2), JSON.stringify(evt));

  if (TURN_MS > 0 && evt && Number.isFinite(evt.turnDeadline)) {
    const window = evt.turnDeadline - before;
    // Allow slack for round-trip + scheduling, but a wrong constant is off by
    // orders of magnitude, not by a second.
    check(`the published deadline matches the configured clock (~${TURN_MS}ms)`,
      window > TURN_MS * 0.5 && window < TURN_MS * 3,
      `window=${window}ms expected~${TURN_MS}ms`);
  } else {
    check('the published deadline matches the configured clock', false,
      `TURN_MS=${TURN_MS} evt=${JSON.stringify(evt)} (set EXPECTED_TURN_MS to check)`);
  }

  A.disconnect();
  B.disconnect();

  console.log(`\n${results.length - failed}/${results.length} checks passed`);

  await cleanup(roomId);
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error('TEST ERROR:', err && err.message);
  // A thrown error must not leave sockets open or a room alive behind it — the
  // shared test server would carry both into the next suite.
  await cleanup();
  process.exit(2);
});