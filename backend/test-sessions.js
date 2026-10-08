// Headless session-token test.
//
// Verifies the persistent session token plumbing WITHOUT a browser:
//   1. room:create issues a token (in the ack AND room:joined)
//   2. room:join  issues a token (in the ack AND room:joined)
//   3. a NEW socket can player:rejoin with a valid token and is rebound
//   4. rejoin with a bogus token is rejected (so client can fall back)
//   5. rejoin with a token from a DIFFERENT room is rejected
//   6. STATE RESTORE: a successful rejoin carries that player's money, position,
//      owned properties + house counts, and any trade/auction they're party to
//
// Run against a live server:  node test-sessions.js
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

const waitFor = (socket, event, ms = 2500) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    socket.once(event, (data) => {
      clearTimeout(t);
      resolve({ data });
    });
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== CLEANUP: EVERY SOCKET IS TRACKED AND CLOSED ON BOTH PATHS =====
// This suite opens a lot of sockets (rejoin stand-ins, grace-period clients) and
// several of them are deliberately disconnected mid-test. Any socket still open
// when the suite throws would linger on the shared test server and leak into the
// next suite. Registering each one lets cleanup() close the survivors from the
// catch block as well as from the success path.
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

// The server's own room snapshot, via a sync round trip. Movement is now
// server-derived, so a test that needs a player's position must ASK for it —
// the move request no longer carries one.
const syncNow = (socket) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 1500);
    socket.once('game:sync', (s) => {
      clearTimeout(t);
      resolve(s);
    });
    socket.emit('game:request-sync', {});
  });

(async () => {
  const A = track(await connect());
  console.log(`\nConnected client A to ${URL}\n`);

  // ---- A creates a room; expect a token ----
  const joinedAPromise = waitFor(A, 'room:joined');
  const created = await emitAck(A, 'room:create', {});
  check('create acks ok', !!(created && created.ok), JSON.stringify(created));
  const tokenA = created && created.token;
  const codeA = created && created.roomId;
  check('create returns a token', typeof tokenA === 'string' && tokenA.length > 20, String(tokenA).slice(0, 12) + '…');

  const joinedA = await joinedAPromise;
  check('room:joined carries the SAME token',
    !!(joinedA && joinedA.data && joinedA.data.token === tokenA));
  check('room:joined marks host via token', !!(joinedA && joinedA.data && joinedA.data.isHost === true));

  // ---- A second socket joins as guest; expect its OWN token ----
  const B = track(await connect());
  const joinedBPromise = waitFor(B, 'room:joined');
  const ackB = await emitAck(B, 'room:join', { roomId: codeA });
  const tokenB = ackB && ackB.token;
  check('join acks ok with a token', !!(ackB && ackB.ok && tokenB && tokenB !== tokenA),
    String(tokenB).slice(0, 12) + '…');
  const joinedB = await joinedBPromise;
  check('guest room:joined carries its token', !!(joinedB && joinedB.data && joinedB.data.token === tokenB));

  // ---- C reconnects with A's token (simulates a page refresh) ----
  const C = track(await connect());
  // Register the listener BEFORE emitting, or we race the event.
  const rejoinedEvent = waitFor(C, 'room:joined');
  const rejoinC = await emitAck(C, 'player:rejoin', { roomId: codeA, token: tokenA });
  check('valid rejoin acks ok+rejoined', !!(rejoinC && rejoinC.ok && rejoinC.rejoined), JSON.stringify(rejoinC));
  const evtC = await rejoinedEvent;
  check('rejoined socket gets room:joined as host',
    !!(evtC && evtC.data && evtC.data.role === 'host'), evtC ? `role=${evtC.data && evtC.data.role}` : 'no event');
  check('rejoined socket is told its playerId', !!(rejoinC && rejoinC.playerId === 1), String(rejoinC && rejoinC.playerId));

  // ---- STATE RESTORE: mutate the room via A, then rejoin as a fresh socket
  //      with A's token and confirm the payload reflects the live state. ----
  // A buys two ownable tiles, builds 3 houses on the second, moves
  // and banks up. Now that the server validates purchases, A must be STANDING on
  // each tile it buys: move onto the tile, then buy it.
  // Tile ids here are REAL purchasable properties. Tile 3 is TREASURE and tile 1
  // is Dhaka: the old code allowed buying ANY square 0..39 (it had no board
  // table), so this setup used to "own" the TREASURE tile. The server now
  // consults backend/game/board.js, which correctly refuses corners, cards and
  // taxes, so the fixture buys Dhaka (1) and Bihar (4) — both genuine properties.
  // ===== MEANINGFUL STATE, PRODUCED THE ONLY LEGAL WAY =====
  // Movement is server-derived: the client rolls (the server picks the dice) and
  // then asks to move (the server computes the destination from that roll). The
  // fixture walks player 1 onto tiles 1 and 4 by rolling, because naming a
  // position is no longer possible.
  const rollAndMove = async (socket, playerId) => {
    await emitAction(socket, 'player:rolled', { playerId });
    return emitAction(socket, 'player:moved', { playerId });
  };

  // The server's own position for a player, read via a sync round trip.
  const serverPos = async (socket, playerId) => {
    const s = await syncNow(socket);
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
  // So each roll+move is followed by a turn:ended, which resets the clock, and the
  // turn is handed straight back. The walk is therefore many short turns rather
  // than one long one.
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
      await rollAndMove(socket, playerId);
      // Re-check AFTER moving: the roll may have landed on the target.
      const landed = await serverPos(socket, playerId);
      if (wanted.includes(landed)) return landed;
      await emitAction(socket, 'turn:ended', { playerId });
      if (otherSocket && otherId !== undefined) {
        await emitAction(otherSocket, 'turn:ended', { playerId: otherId });
      }
      await sleep(5);
    }
    const finalPos = await serverPos(socket, playerId);
    return wanted.includes(finalPos) ? finalPos : null;
  };

  // Player 1 must own TWO ownable tiles. Which two is irrelevant to what this
  // suite proves (state survives a restart), so we buy the first two ownable tiles
  // we happen to land on rather than hunting fixed ids — a 2-12 step roll on a
  // 40-tile board makes hitting one specific low tile unreliable, but landing on
  // ANY ownable tile is quick.
  // ===== PROPERTIES ONLY =====
  // Utility tiles (airport/electricity/internet) are OWNABLE but cannot be built
  // on — the board gives them no houseCost. This fixture builds 3 houses below, so
  // it must own a genuine PROPERTY or the build is correctly refused with
  // BAD_BUILD and the restored house count comes back 0.
  const OWNABLE = [1, 2, 4, 6, 8, 11, 12, 13, 16, 17, 19, 21, 22, 26, 27, 29, 31, 32, 33, 36, 39];
  const owned = [];
  for (let i = 0; i < 12 && owned.length < 2; i++) {
    // Exclude tiles we already own: the walker may still be STANDING on the tile
    // it just bought, and walkToAny would otherwise return it immediately, so the
    // loop would never collect a second distinct tile.
    const candidates = OWNABLE.filter((t) => !owned.includes(t));
    const tileId = await walkToAny(A, 1, candidates, B, 2);
    if (tileId === null) break;
    const res = await emitAction(A, 'property:bought', { tileId, playerId: 1, price: 0 });
    if (res && res.ok) owned.push(tileId);
  }
  check('fixture: player 1 bought two ownable tiles by rolling', owned.length === 2,
    `owned=${JSON.stringify(owned)} pos=${await serverPos(A, 1)}`);
  // The build now costs money, so assert it actually applied — otherwise the
  // restored house-count check below fails with a confusing "houses=0".
  const buildAck = await emitAction(A, 'house:upgraded', { tileId: owned[1], houses: 3, playerId: 1 });
  check('fixture: three houses were built on the second owned tile',
    !!(buildAck && buildAck.ok), `tile=${owned[1]} ack=${JSON.stringify(buildAck)}`);

  // One final move so the persisted position is a real, derived value.
  await rollAndMove(A, 1);

  // Read the balance the SERVER ended up with rather than assuming it: which
  // tiles we bought (and therefore what they cost) is not fixed.
  const expectedPosition = await serverPos(A, 1);
  const expectedMoney = (await syncNow(A)).players.find((p) => p.id === 1).money;
  await sleep(250);

  // G rejoins fresh with A's token -> should get A's state back.
  // Register the room:joined listener BEFORE emitting, or we race the event.
  const G = track(await connect());
  const rejoinedGEvent = waitFor(G, 'room:joined');
  const rejoinG = await emitAck(G, 'player:rejoin', { roomId: codeA, token: tokenA });
  check('rejoin ack carries playerState', !!(rejoinG && rejoinG.ok && rejoinG.playerState),
    rejoinG && rejoinG.playerState ? 'present' : 'MISSING');

  const ps = rejoinG && rejoinG.playerState;
  check(`restored money matches live state ($${expectedMoney})`,
    !!(ps && ps.me && ps.me.money === expectedMoney),
    ps && ps.me ? `money=${ps.me.money} expected=${expectedMoney}` : 'no me');
  check(`restored position matches live state (${expectedPosition})`,
    !!(ps && ps.me && ps.me.position === expectedPosition),
    ps && ps.me ? `position=${ps.me.position} expected=${expectedPosition}` : 'no me');
  check(`restored owned tiles = ${JSON.stringify(owned)}`,
    !!(ps && Array.isArray(ps.ownedPropertyIds) &&
       ps.ownedPropertyIds.length === 2 &&
       owned.every((t) => ps.ownedPropertyIds.includes(t))),
    ps ? JSON.stringify(ps.ownedPropertyIds) : 'no ps');
  const houseTile = ps && ps.ownedProperties && ps.ownedProperties.find((p) => p.tileId === owned[1]);
  check(`restored house count on tile ${owned[1]} = 3`, !!(houseTile && houseTile.houses === 3),
    houseTile ? `houses=${houseTile.houses}` : `tile ${owned[1]} not owned`);
  const gEvent = await rejoinedGEvent; // must await — rejoinedGEvent is a promise
  check('restored room:joined ALSO carries playerState',
    !!(gEvent && gEvent.data && gEvent.data.playerState),
    gEvent && gEvent.data
      ? (gEvent.data.playerState ? 'present' : 'MISSING on event')
      : 'no event');
  check('restored roster is complete (A + B = 2 players)',
    !!(ps && Array.isArray(ps.players) && ps.players.length === 2),
    ps ? `players=${ps.players.length}` : 'no ps');

  // ---- A trade where A is the initiator should come back on rejoin ----
  const tradeId = 'trade-test-1';
  A.emit('trade:created', {
    id: tradeId,
    initiatorId: 1,
    targetId: 2,
    initiatorMoney: 100,
    targetMoney: 0,
    initiatorPropertyIds: [],
    targetPropertyIds: [],
    status: 'pending',
    createdAt: Date.now(),
    lastModifiedBy: 1
  });
  await sleep(200);

  const H = track(await connect());
  const rejoinH = await emitAck(H, 'player:rejoin', { roomId: codeA, token: tokenA });
  const psH = rejoinH && rejoinH.playerState;
  check('rejoin returns the trade this player is party to',
    !!(psH && Array.isArray(psH.trades) && psH.trades.some((t) => t.id === tradeId)),
    psH ? `${psH.trades.length} trade(s)` : 'no ps');

  // The trade's target (Player 2) IS a party, so it SHOULD come back for B...
  const I = track(await connect());
  const rejoinI = await emitAck(I, 'player:rejoin', { roomId: codeA, token: tokenB });
  const psI = rejoinI && rejoinI.playerState;
  check('trade TARGET (Player 2) DOES see the trade',
    !!(psI && Array.isArray(psI.trades) && psI.trades.some((t) => t.id === tradeId)),
    psI ? `${psI.trades.length} trade(s)` : 'no ps');

  // ...but a brand-new, uninvolved player must NOT see it as their own.
  const J = track(await connect());
  const ackJ = await emitAck(J, 'room:join', { roomId: codeA });
  const tokenJ = ackJ && ackJ.token;
  const J2 = track(await connect());
  const rejoinJ = await emitAck(J2, 'player:rejoin', { roomId: codeA, token: tokenJ });
  const psJ = rejoinJ && rejoinJ.playerState;
  check('uninvolved player does NOT get someone else\'s trade',
    !!(psJ && Array.isArray(psJ.trades) && !psJ.trades.some((t) => t.id === tradeId)),
    psJ ? `${psJ.trades.length} trade(s)` : 'no ps');

  J.disconnect();
  J2.disconnect();

  [G, H, I].forEach((s) => s.disconnect());

  // ---- D submits a bogus token -> must be rejected ----
  const D = track(await connect());
  const rejoinD = await emitAck(D, 'player:rejoin', { roomId: codeA, token: 'not-a-real-token' });
  check('bogus token is REJECTED', !!(rejoinD && rejoinD.ok === false), JSON.stringify(rejoinD));

  // ---- E submits a valid token but for the WRONG room -> rejected ----
  const E = track(await connect());
  const rejoinE = await emitAck(E, 'player:rejoin', { roomId: 'ZZ', token: tokenB });
  check('token for a different room is REJECTED', !!(rejoinE && rejoinE.ok === false), JSON.stringify(rejoinE));

  // ---- F: an unknown room code is a clean rejection (falls back to join) ----
  const F = track(await connect());
  const rejoinF = await emitAck(F, 'player:rejoin', { roomId: 'ZZ', token: tokenA });
  check('unknown room is REJECTED cleanly', !!(rejoinF && rejoinF.ok === false), JSON.stringify(rejoinF));

  // ================= EMPTY-ROOM GRACE PERIOD =================
  // These need a short TTL server. Run it with:
  //   EMPTY_ROOM_TTL_MS=3000 PORT=3003 node server.js
  // and point the suite at it (SERVER_URL=http://localhost:3003). If the TTL is
  // left at the 90s default the expiry case would make this suite crawl, so we
  // skip it and say so loudly rather than hang.
  const graceTtlMs = Number(process.env.EXPECTED_TTL_MS) || 0;

  if (graceTtlMs > 0) {
    // --- Case 1: lone player refreshes; rejoin INSIDE the window succeeds ---
    const L = track(await connect());
    const loneCreate = await emitAck(L, 'room:create', {});
    const loneCode = loneCreate.roomId;
    const loneToken = loneCreate.token;
    check('grace: lone room created', !!(loneCreate && loneCreate.ok), JSON.stringify(loneCreate));

    // The only socket in the room disappears (the classic "refresh my own tab").
    L.disconnect();
    await sleep(300); // well within the window
    const L2 = track(await connect());
    const rejoinL2 = await emitAck(L2, 'player:rejoin', { roomId: loneCode, token: loneToken });
    check('grace: rejoin SUCCEEDS within the window after last socket left',
      !!(rejoinL2 && rejoinL2.ok && rejoinL2.rejoined), JSON.stringify(rejoinL2));

    // And the room is genuinely alive again (a second player can join it).
    const M = track(await connect());
    const joinM = await emitAck(M, 'room:join', { roomId: loneCode });
    check('grace: room is alive again (fresh join works)', !!(joinM && joinM.ok), JSON.stringify(joinM));
    L2.disconnect();
    M.disconnect();

    // --- Case 2: rejoin AFTER the TTL has expired must fail (fall back to join) ---
    const N = track(await connect());
    const expireCreate = await emitAck(N, 'room:create', {});
    const expireCode = expireCreate.roomId;
    const expireToken = expireCreate.token;
    check('grace: expiry room created', !!(expireCreate && expireCreate.ok), JSON.stringify(expireCreate));

    N.disconnect();
    // Wait past the TTL so the server tears the room down.
    await sleep(graceTtlMs + 800);

    const N2 = track(await connect());
    const rejoinN2 = await emitAck(N2, 'player:rejoin', { roomId: expireCode, token: expireToken });
    check('grace: rejoin FAILS after the TTL expired (falls back to join)',
      !!(rejoinN2 && rejoinN2.ok === false), JSON.stringify(rejoinN2));

    // The torn-down room is truly gone: a normal join also fails.
    const joinN2 = await emitAck(N2, 'room:join', { roomId: expireCode });
    check('grace: torn-down room rejects a normal join too',
      !!(joinN2 && joinN2.ok === false), JSON.stringify(joinN2));
    N2.disconnect();
  } else {
    console.log('SKIP  grace-period cases (set EXPECTED_TTL_MS to run against a short-TTL server)');
  }

  [A, B, C, D, E, F].forEach((s) => s.disconnect());

  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  await cleanup(codeA);
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error('TEST ERROR:', err && err.message);
  await cleanup();
  process.exit(2);
});
