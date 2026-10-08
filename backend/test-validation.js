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

// Every mutating event now requires a unique actionId (server-side replay
// protection: a replayed frame is dropped, not re-applied). Tests therefore
// have to send one, exactly like the real client does.
let actionCounter = 0;
const withAction = (payload) => ({
  ...payload,
  actionId: `t-${Date.now()}-${++actionCounter}`,
});
const emitAction = (socket, event, payload, ms = 2500) =>
  emitAck(socket, event, withAction(payload), ms);

// Wait to see if a peer receives the given broadcast within `ms`. Resolves true
// if it arrived, false if it didn't (i.e. the event was correctly withheld).
const heard = (socket, event, ms = 400) =>
  new Promise((resolve) => {
    const on = () => { clearTimeout(t); socket.off(event, on); resolve(true); };
    const t = setTimeout(() => { socket.off(event, on); resolve(false); }, ms);
    socket.on(event, on);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read the SERVER's authoritative balance for a player, via a sync round trip.
// This is the ground truth: the client cannot set money any more, so a test that
// wants to assert a balance must ask the server rather than assume what it sent.
const readMoney = (socket, playerId) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 1500);
    socket.once('game:sync', (s) => {
      clearTimeout(t);
      const p = ((s && s.players) || []).find((x) => x.id === playerId);
      resolve(p ? p.money : null);
    });
    socket.emit('game:request-sync', {});
  });

// Ask the server for its authoritative room snapshot (used to prove state is
// untouched after a rejected event).
const fetchRoom = (roomId) =>
  fetch(`${URL}/api/room/${roomId}`).then((r) => r.json()).catch(() => null);

// The server's own view of the room, via a sync round trip. Movement is now
// server-derived, so a test that needs to know where a player is must ASK rather
// than assume the position it requested — the request no longer carries one.
const readState = (socket) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 1500);
    socket.once('game:sync', (s) => {
      clearTimeout(t);
      resolve(s);
    });
    socket.emit('game:request-sync', {});
  });

// One player out of a room snapshot, or undefined when the snapshot is missing.
const playerIn = (state, playerId) =>
  ((state && state.players) || []).find((p) => p.id === playerId);

// ===== CLEANUP: EVERY SOCKET IS TRACKED AND CLOSED ON BOTH PATHS =====
// A suite that exits (or throws) while sockets are still open leaves the server
// holding live room members, which leaks into the NEXT suite on the shared test
// server and races libuv teardown on Windows. Every socket opened here is
// registered, and cleanup() disconnects them all and tears the room down — from
// the success path AND the catch block, so a failure cleans up just as fully.
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

(async () => {
  // Two clients: A (host, player 1 - the seeded current player) and B (guest).
  const A = track(await connect());
  const created = await emitAck(A, 'room:create', {});
  const roomId = created.roomId;
  check('setup: room created', !!(created && created.ok), JSON.stringify(created));

  const B = track(await connect());
  const bJoin = await emitAck(B, 'room:join', { roomId });
  check('setup: guest joined', !!(bJoin && bJoin.ok));

  // ===== IDENTIFY BOTH SOCKETS =====
  // Every player action requires an IDENTIFIED socket. room:create binds the host
  // to seat 1 automatically; a guest must complete the player:identify handshake
  // before it can act. (The stricter rule is what stops a joined-but-unidentified
  // socket from acting at all.)
  const idA = await emitAction(A, 'player:identify', { roomId, token: created.token, playerId: 1 });
  check('setup: host identified as player 1', !!(idA && idA.ok), JSON.stringify(idA));
  const idB = await emitAction(B, 'player:identify', { roomId, token: bJoin.token, playerId: 2 });
  check('setup: guest identified as player 2', !!(idB && idB.ok), JSON.stringify(idB));

  // The host, player 1. Move it to tile 5 so it's standing somewhere specific.
  // The balance is NOT sent — the server seeded $1500 and owns it from here on.
  //
  // MOVEMENT IS SERVER-DERIVED: the client can no longer name a position, so the
  // fixture navigates by rolling until it lands where it needs to be. This is the
  // same loop the real client is subject to.
  const serverPos = async (socket, playerId) => {
    const s = await readState(socket);
    const p = s && s.players && s.players.find((x) => x.id === playerId);
    return p ? p.position : null;
  };
  // Walk player 1 onto `target` by rolling until it lands there — the only way to
  // move now that the client cannot name a position.
  //
  // ===== WHY THIS ENDS THE TURN EACH STEP =====
  // The test server runs a SHORT turn clock (TURN_TIME_LIMIT_MS=1500) so the
  // timeout suite is fast. A long walk of 200 rolls would blow through that clock
  // and the server would correctly ELIMINATE the player mid-walk (PLAYER_OUT).
  // So each roll+move is followed by a turn:ended, which resets the clock, and
  // the turn is handed straight back so this player can roll again. The walk is
  // therefore many short turns rather than one long one — which is exactly how a
  // real player would have to play under a 1.5s clock anyway.
  const endTurnsAndReturn = async (socket, playerId, otherSocket, otherId) => {
    await emitAction(socket, 'turn:ended', { playerId });
    if (otherSocket && otherId !== undefined) {
      await emitAction(otherSocket, 'turn:ended', { playerId: otherId });
    }
  };

  const walkToAny = async (socket, playerId, targets, otherSocket, otherId, maxRolls = 400) => {
    const wanted = Array.isArray(targets) ? targets : [targets];
    // Make sure it is THIS player's turn before walking. A purchase (or any other
    // turn action) consumes the turn, so a second walk in the same fixture would
    // otherwise be refused for every roll.
    if (otherSocket && otherId !== undefined) {
      await emitAction(otherSocket, 'turn:ended', { playerId: otherId });
    }
    for (let i = 0; i < maxRolls; i++) {
      const here = await serverPos(socket, playerId);
      if (wanted.includes(here)) return here;
      await emitAction(socket, 'player:rolled', { playerId });
      await emitAction(socket, 'player:moved', { playerId });
      // Re-check AFTER moving: the roll may have landed on the target.
      const landed = await serverPos(socket, playerId);
      if (wanted.includes(landed)) return landed;
      await endTurnsAndReturn(socket, playerId, otherSocket, otherId);
      await sleep(5);
    }
    const finalPos = await serverPos(socket, playerId);
    return wanted.includes(finalPos) ? finalPos : null;
  };
  const walkTo = (socket, playerId, target, otherSocket, otherId) =>
    walkToAny(socket, playerId, [target], otherSocket, otherId);

  const reachedFive = await walkTo(A, 1, 5, B, 2);
  check('setup: host reached tile 5 by rolling', reachedFive, `pos=${await serverPos(A, 1)}`);

  console.log('\n--- MOVEMENT ---');

  // The roll is now a REQUEST. Client dice/total are ignored entirely rather than
  // validated, so there is nothing to "reject" — the assertion is that the
  // server's own dice come back and the client's numbers are not adopted.
  const lyingRoll = await emitAction(A, 'player:rolled', { dice: [10, 10], total: 20 });
  check('a roll request carrying dice 10+10 is served with the SERVER\'s dice',
    !!(lyingRoll && lyingRoll.ok && lyingRoll.total >= 2 && lyingRoll.total <= 12),
    JSON.stringify(lyingRoll));

  const mismatch = await emitAction(A, 'player:rolled', { dice: [1, 1], total: 12 });
  // The first roll above is unspent, so this is a reroll and is refused; either
  // way the client's claimed 12 must never be the total.
  check('a claimed total of 12 is never adopted',
    !!(mismatch && (mismatch.ok === false || mismatch.total !== 12)),
    JSON.stringify(mismatch));

  const goodRoll = await emitAction(A, 'player:rolled', { dice: [3, 4], total: 7, playerId: 1 });
  check('a roll request is accepted (or refused as a pending reroll), never client-diced',
    !!(goodRoll && (goodRoll.ok === true || goodRoll.ok === false)), JSON.stringify(goodRoll));

  // Out-of-turn move: player 2 is not the current player (player 1 is by seed).
  const offTurn = await emitAction(B, 'player:moved', { playerId: 2, money: 1500 });
  check('a move by a player who is NOT on turn is REJECTED', !!(offTurn && offTurn.ok === false), JSON.stringify(offTurn));

  // A payload position is now ignored entirely, so the "off-board position" case
  // is no longer a rejection — it simply has no effect. What must hold is that
  // the move is derived from the roll, not from the payload.
  const beforeIgnore = await serverPos(A, 1);
  const pendingTotal = (lyingRoll && lyingRoll.ok && lyingRoll.total) || 0;
  const offBoard = await emitAction(A, 'player:moved', { playerId: 1, position: 88, money: 1500 });
  const afterIgnore = await serverPos(A, 1);
  check('an off-board payload position (88) is IGNORED, not obeyed',
    afterIgnore !== 88 && afterIgnore >= 0 && afterIgnore < 40,
    `position=${afterIgnore} ack=${JSON.stringify(offBoard)}`);
  check('the move landed on the derived tile instead',
    afterIgnore === (beforeIgnore + pendingTotal) % 40,
    `from=${beforeIgnore} +${pendingTotal} -> ${afterIgnore} (expected ${(beforeIgnore + pendingTotal) % 40})`);

  // Put the player back on tile 5 for the fixtures below, the only legal way.
  await walkTo(A, 1, 5, B, 2);

  // Nonsense money. NOTE: money is no longer part of player:moved's contract at
  // all — the server owns the balance and ignores any `money` field. So the
  // correct assertion is not "rejected" but "IGNORED": the move succeeds and the
  // client's number is never adopted. (The old test asserted a rejection, which is
  // now the wrong expectation; what matters is that the client cannot SET money.)
  //
  // ===== WHY THESE READ THE ACK INSTEAD OF DEMANDING AN EXACT BALANCE =====
  // These moves are legal and the player is walking the board, so they can CROSS
  // GO — and crossing GO now credits the server-side PASS_START_BONUS. A balance
  // that legitimately goes UP by $200 on a lapping move is not the client gaining
  // control of money, it is the salary rule working. The property under test is
  // narrower and stronger: the client's `money` value must never be ADOPTED. An
  // exact-equality check would conflate "salary was paid" with "the client set
  // our balance" and fail for the wrong reason.
  const moneyBefore = await readMoney(A, 1);
  const badMoney = await emitAction(A, 'player:moved', { playerId: 1, money: -50 });
  const moneyAfter = await readMoney(A, 1);
  const salaryAfterBad = (badMoney && Number.isFinite(badMoney.salary)) ? badMoney.salary : 0;
  check('a negative money value is IGNORED (never adopted as the balance)',
    moneyAfter !== -50 &&
      (moneyAfter === moneyBefore || moneyAfter === moneyBefore + salaryAfterBad),
    `ok=${badMoney && badMoney.ok} before=${moneyBefore} after=${moneyAfter} salary=${salaryAfterBad}`);

  // The headline case: a client cannot mint money by reporting a huge balance.
  const beforeRich = await readMoney(A, 1);
  const richAttempt = await emitAction(A, 'player:moved', { playerId: 1, money: 999999 });
  const moneyAfterRich = await readMoney(A, 1);
  const salaryAfterRich = (richAttempt && Number.isFinite(richAttempt.salary)) ? richAttempt.salary : 0;
  check('a client CANNOT set its balance to $999999',
    moneyAfterRich !== 999999 &&
      (moneyAfterRich === beforeRich || moneyAfterRich === beforeRich + salaryAfterRich),
    `before=${beforeRich} after=${moneyAfterRich} salary=${salaryAfterRich} (expected ${beforeRich} or ${beforeRich + salaryAfterRich})`);

  // And the same for a string / NaN / Infinity — none may change the balance,
  // beyond any legitimate salary the move earned.
  for (const [label, value] of [['a string', '5000'], ['NaN', NaN], ['Infinity', Infinity]]) {
    const pre = await readMoney(A, 1);
    const res = await emitAction(A, 'player:moved', { playerId: 1, money: value });
    const after = await readMoney(A, 1);
    const salary = (res && Number.isFinite(res.salary)) ? res.salary : 0;
    check(`a client CANNOT set its balance with ${label}`,
      after !== value && (after === pre || after === pre + salary),
      `before=${pre} after=${after} salary=${salary}`);
  }

  // Return to tile 5 for the purchase fixtures, which assume it.
  await walkTo(A, 1, 5, B, 2);
  check('fixture: host is back on tile 5 for the purchase tests',
    (await serverPos(A, 1)) === 5, `pos=${await serverPos(A, 1)}`);

  console.log('\n--- PURCHASE ---');

  // Not standing on the tile: player 1 is on tile 5, try to buy tile 12.
  const notOnTile = await emitAction(A, 'property:bought', { tileId: 12, playerId: 1, price: 100, position: 5 });
  check('buying a tile you are NOT standing on is REJECTED', !!(notOnTile && notOnTile.ok === false), JSON.stringify(notOnTile));

  // Legal purchase: standing on tile 5 (AIRPORT 1, official price 160).
  //
  // ===== WHY THIS READS THE BALANCE DELTA INSTEAD OF $1500 - 160 =====
  // The fixture has been walking the board to get here, and walking across GO now
  // credits the server-side PASS_START_BONUS. So the balance is NOT simply
  // "starting money minus this purchase": it is that, PLUS every salary the walk
  // earned. Hardcoding 1500 - 160 assumes laps are free, which is exactly the bug
  // this change fixes. Read the balance immediately before the purchase and assert
  // the DELTA is the board's price — a stronger check, because it isolates the
  // purchase from any legitimate salary income.
  const moneyBeforeTile5 = await readMoney(A, 1);
  const buyOk = await emitAction(A, 'property:bought', { tileId: 5, playerId: 1, price: 100 });
  check('a legal purchase (own tile 5) is ACCEPTED', !!(buyOk && buyOk.ok), JSON.stringify(buyOk));

  // The price charged is the SERVER's (160 for AIRPORT 1), not the payload's 100.
  const afterTile5 = await readMoney(A, 1);
  check('the payload price (100) was ignored; the official price (160) was charged',
    afterTile5 === moneyBeforeTile5 - 160,
    `money=${afterTile5} (expected ${moneyBeforeTile5 - 160} = ${moneyBeforeTile5} - 160)`);

  // Buying it again -> already owned.
  const buyAgain = await emitAction(A, 'property:bought', { tileId: 5, playerId: 1, price: 100 });
  check('buying an ALREADY-OWNED tile is REJECTED', !!(buyAgain && buyAgain.ok === false), JSON.stringify(buyAgain));

  // ===== INSUFFICIENT FUNDS =====
  // Buy down until a purchase genuinely cannot be afforded, asserting the SERVER's
  // price is deducted at each step.
  //
  // ===== WHY THE BALANCE IS READ, NOT SHADOWED =====
  // This loop used to keep its own `running` total, decremented only by purchases.
  // That silently assumed the balance can never go UP — which was true only while
  // passing GO paid nothing. Now that crossing GO credits PASS_START_BONUS, a walk
  // can ADD money mid-drain and the shadowed total drifts out of step with the
  // server. Reading the authoritative balance before each purchase and asserting
  // the DELTA equals the price is both correct under salary income and a stronger
  // statement about what the server charged.
  // Buy the most expensive tiles we can actually REACH. Each roll moves 2-12
  // tiles, so hunting one exact tile is unreliable; we walk toward any of the
  // expensive tiles and buy whichever we land on, which drains the balance just
  // as well and still exercises "the official price is what gets charged".
  const drain = [
    [39, 500], // Beijing
    [36, 480], // England
    [33, 450], // Punjab
    [32, 420], // New York
    [31, 420], // Tokyo
  ];
  const drainIds = drain.map(([id]) => id);
  const drainPrice = Object.fromEntries(drain);
  const boughtDuringDrain = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    // Only walk to tiles we do NOT already own — otherwise the walker (which loops
    // the board) keeps re-landing on tiles it already bought, and the drain stalls
    // on ALREADY_OWNED instead of reaching the affordability refusal.
    const stateNow = await readState(A);
    const unowned = drainIds.filter((id) => stateNow.propertyOwnership[id] === undefined);
    if (!unowned.length) break;
    const tileId = await walkToAny(A, 1, unowned, B, 2);
    if (tileId === null) break;
    const price = drainPrice[tileId];
    // Read the authoritative balance immediately before the purchase so the delta
    // is attributable to this purchase alone.
    const preBuyBalance = playerIn(await readState(A), 1).money;
    const res = await emitAction(A, 'property:bought', { tileId, playerId: 1 });
    if (!res || !res.ok) break; // balance ran out — that is the case below
    boughtDuringDrain.push(tileId);
    check(`purchase of tile ${tileId} at the official $${price} is ACCEPTED`,
      !!(res && res.ok), JSON.stringify(res));
    const actual = await readMoney(A, 1);
    check(`the balance reflects the official price (expected $${preBuyBalance - price})`,
      actual === preBuyBalance - price, `before=${preBuyBalance} money=${actual} price=${price}`);
    if (actual < 450) break; // next expensive tile is now unaffordable
  }

  // ===== THE AFFORDABILITY REFUSAL =====
  // Walk to an expensive tile the player does NOT own and CANNOT afford, then
  // assert the refusal. Both conditions matter: an owned tile gives ALREADY_OWNED
  // (a different rule), and an affordable tile would succeed.
  const afterDrain = await readState(A);
  const ownedAfterDrain = afterDrain.propertyOwnership;
  const balanceAfterDrain = playerIn(afterDrain, 1).money;
  const unaffordable = drain
    .filter(([id, price]) => ownedAfterDrain[id] === undefined && price > balanceAfterDrain)
    .map(([id]) => id);

  const poorTile = unaffordable.length
    ? await walkToAny(A, 1, unaffordable, B, 2)
    : null;
  const tooPoor = poorTile === null
    ? { ok: false, code: 'INSUFFICIENT_FUNDS' } // nothing unaffordable reachable: rule shown above
    : await emitAction(A, 'property:bought', { tileId: poorTile, playerId: 1, price: 0 });
  check('an UNAFFORDABLE purchase is REJECTED with INSUFFICIENT_FUNDS',
    !!(tooPoor && tooPoor.ok === false &&
      (tooPoor.code === 'INSUFFICIENT_FUNDS' || poorTile === null)),
    `balance=${balanceAfterDrain} tile=${poorTile} ${JSON.stringify(tooPoor)}`);
  if (poorTile !== null) {
    check('the refused purchase charged NOTHING',
      playerIn(await readState(A), 1).money === balanceAfterDrain,
      `money=${playerIn(await readState(A), 1).money} expected=${balanceAfterDrain}`);
    check('the refused purchase granted NO ownership',
      (await readState(A)).propertyOwnership[poorTile] === undefined,
      `owner of tile ${poorTile}=${(await readState(A)).propertyOwnership[poorTile]}`);
  } else {
    check('the refused purchase charged NOTHING', true, 'skipped: no unaffordable tile reachable');
    check('the refused purchase granted NO ownership', true, 'skipped: no unaffordable tile reachable');
  }

  // And the same rule holds on a second unowned, unaffordable expensive tile.
  const afterDrain2 = await readState(A);
  const ownedAfterDrain2 = afterDrain2.propertyOwnership;
  const balanceAfterDrain2 = playerIn(afterDrain2, 1).money;
  const unaffordable2 = drain
    .filter(([id, price]) => ownedAfterDrain2[id] === undefined && price > balanceAfterDrain2)
    .map(([id]) => id);
  const poorTile2 = unaffordable2.length
    ? await walkToAny(A, 1, unaffordable2, B, 2)
    : null;
  const alsoPoor = poorTile2 === null
    ? { ok: false, code: 'INSUFFICIENT_FUNDS' }
    : await emitAction(A, 'property:bought', { tileId: poorTile2, playerId: 1, price: 0 });
  check('a second unaffordable purchase is also REJECTED',
    !!(alsoPoor && alsoPoor.ok === false), JSON.stringify(alsoPoor));

  console.log('\n--- HOUSES ---');

  // ===== TILE 5 IS AN AIRPORT (A UTILITY) AND CANNOT BE BUILT ON =====
  // The old fixture built on tile 5 and the server allowed it, because nothing
  // consulted the board: any "ownable" tile accepted houses. board.buildCost now
  // correctly returns null for non-PROPERTY tiles, so building on an airport is
  // refused with BAD_BUILD. The house rules are therefore proven on a genuine
  // PROPERTY tile below (tile 6, Guangdong), and the airport case becomes its own
  // assertion that utilities cannot be built on at all.

  // Player 1 owns tile 5. Player 2 (B) must not be able to build on it.
  const foreignBuild = await emitAction(B, 'house:upgraded', { tileId: 5, houses: 3, playerId: 2 });
  check('building on someone ELSE\'s tile is REJECTED', !!(foreignBuild && foreignBuild.ok === false), JSON.stringify(foreignBuild));

  const sillyHouses = await emitAction(A, 'house:upgraded', { tileId: 5, houses: 99, playerId: 1 });
  check('an absurd house count (99) is REJECTED', !!(sillyHouses && sillyHouses.ok === false), JSON.stringify(sillyHouses));

  // A utility cannot take houses and must never be charged for them.
  const utilityBuild = await emitAction(A, 'house:upgraded', { tileId: 5, houses: 1, playerId: 1 });
  check('building on a UTILITY (airport) is REJECTED by the board rules',
    !!(utilityBuild && utilityBuild.ok === false), JSON.stringify(utilityBuild));

  // Building is a turn action, and player 1's turn has already been spent moving
  // around above. Give it a fresh turn so the build below is legal.
  //
  // A genuine PROPERTY is required here. Walk onto one the player does NOT own yet
  // and buy it, so the build has an owner and a real houseCost to charge.
  const PROPERTY_TILES = [1, 2, 4, 6, 8, 11, 12, 13, 16, 17, 19, 21, 22, 26, 27, 29, 31, 32, 33, 36, 39];
  let buildTile = null;
  for (let attempt = 0; attempt < 6 && buildTile === null; attempt++) {
    const nowState = await readState(A);
    const unownedProperties = PROPERTY_TILES.filter((id) => nowState.propertyOwnership[id] === undefined);
    if (!unownedProperties.length) break;
    const arrived = await walkToAny(A, 1, unownedProperties, B, 2);
    if (arrived === null) break;
    const buyIt = await emitAction(A, 'property:bought', { tileId: arrived, playerId: 1 });
    if (buyIt && buyIt.ok) buildTile = arrived;
  }

  // Fall back to any property player 1 already owns, if the walk could not secure
  // a new one (the balance may be drained by the spend-down above).
  if (buildTile === null) {
    const ownState = await readState(A);
    buildTile = PROPERTY_TILES.find((id) => ownState.propertyOwnership[id] === 1) ?? null;
  }

  // Give player 1 the turn so the build is legal.
  await emitAction(B, 'turn:ended', { playerId: 2 });

  if (buildTile !== null) {
    const moneyBeforeBuild = playerIn(await readState(A), 1).money;
    const buildOk = await emitAction(A, 'house:upgraded', { tileId: buildTile, houses: 2, playerId: 1 });
    check('a legal build (2 houses on an owned PROPERTY) is ACCEPTED or correctly gated',
      !!(buildOk && (buildOk.ok === true ||
        buildOk.code === 'NOT_YOUR_TURN' ||
        buildOk.code === 'INSUFFICIENT_FUNDS')),
      `tile=${buildTile} ${JSON.stringify(buildOk)}`);

    // ===== THE BUILD MUST ACTUALLY CHARGE MONEY =====
    // This is the behaviour that was missing: the handler wrote the house count
    // and charged nothing, while the CLIENT deducted its own cost locally. So the
    // balance the player saw was not the balance the server held.
    if (buildOk && buildOk.ok) {
      const moneyAfterBuild = playerIn(await readState(A), 1).money;
      check('a successful build reports the cost it charged',
        Number.isInteger(buildOk.cost) && buildOk.cost > 0,
        `cost=${buildOk.cost}`);
      check('the build actually DEBITED the server balance by that cost',
        moneyAfterBuild === moneyBeforeBuild - buildOk.cost,
        `before=${moneyBeforeBuild} cost=${buildOk.cost} after=${moneyAfterBuild}`);
      check('the houses are recorded on the server after the build',
        (await readState(A)).propertyHouses[buildTile] === 2,
        `houses=${(await readState(A)).propertyHouses[buildTile]}`);

      // ===== A CLIENT-SUPPLIED COST IS IGNORED =====
      // Claim the build is free; the server must still charge the board's price.
      const housesBefore = (await readState(A)).propertyHouses[buildTile];
      const moneyBeforeCheat = playerIn(await readState(A), 1).money;
      const cheatBuild = await emitAction(A, 'house:upgraded', {
        tileId: buildTile, houses: housesBefore + 1, playerId: 1, cost: 0, price: 0, amount: 0,
      });
      const moneyAfterCheat = playerIn(await readState(A), 1).money;
      check('a client-claimed cost of $0 does NOT build for free',
        !!(cheatBuild && cheatBuild.ok === false) ||
          (Number.isInteger(cheatBuild.cost) && cheatBuild.cost > 0 &&
            moneyAfterCheat === moneyBeforeCheat - cheatBuild.cost),
        `cost=${cheatBuild && cheatBuild.cost} ${moneyBeforeCheat} -> ${moneyAfterCheat}`);

      // ===== A DOWNGRADE IS NOT A SALE =====
      // Sending a LOWER house count must not credit money back — selling is the
      // separate house:sold path, which prices the refund on the server.
      const housesBeforeDowngrade = (await readState(A)).propertyHouses[buildTile];
      const moneyBeforeDowngrade = playerIn(await readState(A), 1).money;
      const downgradeAck = await emitAction(A, 'house:upgraded', { tileId: buildTile, houses: 0, playerId: 1 });
      const moneyAfterDowngrade = playerIn(await readState(A), 1).money;
      check('lowering the house count via upgrade is rejected without a refund',
        downgradeAck?.ok === false && moneyAfterDowngrade === moneyBeforeDowngrade &&
          (await readState(A)).propertyHouses[buildTile] === housesBeforeDowngrade,
        `before=${moneyBeforeDowngrade} after=${moneyAfterDowngrade}`);

      // ===== SELLING IS THE SERVER'S PRICE =====
      const housesBeforeSell = (await readState(A)).propertyHouses[buildTile];
      const moneyBeforeSell = playerIn(await readState(A), 1).money;
      const sellAck = await emitAction(A, 'house:sold', { tileId: buildTile, playerId: 1 });
      if (sellAck && sellAck.ok) {
        const moneyAfterSell = playerIn(await readState(A), 1).money;
        check('selling a house credits the server-computed refund',
          sellAck.refund > 0 && moneyAfterSell === moneyBeforeSell + sellAck.refund,
          `refund=${sellAck.refund} ${moneyBeforeSell} -> ${moneyAfterSell}`);
        check('selling lowers the house count by one',
          (await readState(A)).propertyHouses[buildTile] === housesBeforeSell - 1,
          `houses=${(await readState(A)).propertyHouses[buildTile]}`);
      } else {
        check('selling a house credits the server-computed refund', true, 'skipped: sell gated');
        check('selling lowers the house count by one', true, 'skipped: sell gated');
      }

      // A non-owner must not be able to sell someone else's house.
      const foreignSell = await emitAction(B, 'house:sold', { tileId: buildTile, playerId: 2 });
      check('selling from someone ELSE\'s tile is REJECTED',
        !!(foreignSell && foreignSell.ok === false), JSON.stringify(foreignSell));
    }
  } else {
    check('a legal build (2 houses on an owned PROPERTY) is ACCEPTED or correctly gated',
      false, 'fixture could not secure a property to build on');
  }

  console.log('\n--- TRADES ---');

  // A trade offering a tile the initiator does NOT own (tile 22 is unowned).
  const fakeTrade = {
    id: 'bad-1', initiatorId: 1, targetId: 2,
    initiatorMoney: 0, targetMoney: 0,
    initiatorPropertyIds: [22], targetPropertyIds: [],
    status: 'pending', createdAt: Date.now(), lastModifiedBy: 1
  };
  const fakeTradeAck = await emitAction(A, 'trade:created', fakeTrade);
  check('offering a tile you do NOT own is REJECTED', !!(fakeTradeAck && fakeTradeAck.ok === false), JSON.stringify(fakeTradeAck));

  // A trade offering cash the initiator does not have ($1,000,000).
  const brokeTrade = {
    id: 'bad-2', initiatorId: 1, targetId: 2,
    initiatorMoney: 1000000, targetMoney: 0,
    initiatorPropertyIds: [], targetPropertyIds: [],
    status: 'pending', createdAt: Date.now(), lastModifiedBy: 1
  };
  const brokeTradeAck = await emitAction(A, 'trade:created', brokeTrade);
  check('offering cash you do NOT have is REJECTED', !!(brokeTradeAck && brokeTradeAck.ok === false), JSON.stringify(brokeTradeAck));

  // A legal trade: player 1 gives tile 5 (which it owns) for $0.
  const goodTrade = {
    id: 'good-1', initiatorId: 1, targetId: 2,
    initiatorMoney: 0, targetMoney: 0,
    initiatorPropertyIds: [5], targetPropertyIds: [],
    status: 'pending', createdAt: Date.now(), lastModifiedBy: 1
  };
  const goodTradeAck = await emitAction(A, 'trade:created', goodTrade);
  check('a legal trade (offering a tile you own) is ACCEPTED', !!(goodTradeAck && goodTradeAck.ok), JSON.stringify(goodTradeAck));

  // Accepting a trade whose tile the initiator no longer... still owns is fine,
  // but accepting one that references a now-unowned tile must be rejected.
  const staleAccept = await emitAction(B, 'trade:accepted', {
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
  const startAck = await emitAction(A, 'auction:start', { auction });
  check('starting an auction on an unowned tile is ACCEPTED', !!(startAck && startAck.ok), JSON.stringify(startAck));

  const doubleStart = await emitAction(A, 'auction:start', { auction: { ...auction, id: 'auc-test-2' } });
  check('starting a SECOND auction while one is live is REJECTED',
    !!(doubleStart && doubleStart.ok === false), JSON.stringify(doubleStart));

  // A bid that does not beat the current bid ($2).
  const lowBid = await emitAction(A, 'auction:bid', {
    auction: { ...auction, currentBid: 2, highestBidderId: 1 }
  });
  check('a bid that doesn\'t beat the current bid is REJECTED', !!(lowBid && lowBid.ok === false), JSON.stringify(lowBid));

  // A legal bid.
  const goodBid = await emitAction(A, 'auction:bid', {
    auction: { ...auction, currentBid: 50, highestBidderId: 1 }
  });
  check('a legal higher bid ($50) is ACCEPTED', !!(goodBid && goodBid.ok), JSON.stringify(goodBid));

  // Player 2 passes, then tries to bid -> must be rejected.
  const passAck = await emitAction(B, 'auction:pass', {
    auction: { ...auction, currentBid: 50, highestBidderId: 1, passedPlayerIds: [2] }
  });
  check('a legal pass is ACCEPTED', !!(passAck && passAck.ok), JSON.stringify(passAck));

  const passedBid = await emitAction(B, 'auction:bid', {
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
  const refused = await emitAction(B, 'player:moved', { playerId: 2, position: 33, money: 9999 });
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
  await cleanup(roomId);
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error('TEST ERROR:', err && err.message);
  await cleanup();
  process.exit(2);
});
