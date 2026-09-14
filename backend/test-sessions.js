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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const A = await connect();
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
  const B = await connect();
  const joinedBPromise = waitFor(B, 'room:joined');
  const ackB = await emitAck(B, 'room:join', { roomId: codeA });
  const tokenB = ackB && ackB.token;
  check('join acks ok with a token', !!(ackB && ackB.ok && tokenB && tokenB !== tokenA),
    String(tokenB).slice(0, 12) + '…');
  const joinedB = await joinedBPromise;
  check('guest room:joined carries its token', !!(joinedB && joinedB.data && joinedB.data.token === tokenB));

  // ---- C reconnects with A's token (simulates a page refresh) ----
  const C = await connect();
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
  // A buys tile 1 and tile 3, builds 2 houses on tile 3, moves + banks up.
  // Now that the server validates purchases, A must be STANDING on each tile it
  // buys: move onto the tile, then buy it.
  await emitAck(A, 'player:moved', { playerId: 1, position: 1, money: 1750 });
  await emitAck(A, 'property:bought', { tileId: 1, playerId: 1, price: 0 });
  await emitAck(A, 'player:moved', { playerId: 1, position: 3, money: 1750 });
  await emitAck(A, 'property:bought', { tileId: 3, playerId: 1, price: 0 });
  await emitAck(A, 'house:upgraded', { tileId: 3, houses: 2, playerId: 1 });
  A.emit('player:moved', { playerId: 1, position: 12, money: 1750 });
  await sleep(250);

  // G rejoins fresh with A's token -> should get A's state back.
  // Register the room:joined listener BEFORE emitting, or we race the event.
  const G = await connect();
  const rejoinedGEvent = waitFor(G, 'room:joined');
  const rejoinG = await emitAck(G, 'player:rejoin', { roomId: codeA, token: tokenA });
  check('rejoin ack carries playerState', !!(rejoinG && rejoinG.ok && rejoinG.playerState),
    rejoinG && rejoinG.playerState ? 'present' : 'MISSING');

  const ps = rejoinG && rejoinG.playerState;
  check('restored money matches live state ($1750)', !!(ps && ps.me && ps.me.money === 1750),
    ps && ps.me ? `money=${ps.me.money}` : 'no me');
  check('restored position matches live state (12)', !!(ps && ps.me && ps.me.position === 12),
    ps && ps.me ? `position=${ps.me.position}` : 'no me');
  check('restored owned tiles = [1, 3]',
    !!(ps && Array.isArray(ps.ownedPropertyIds) &&
       ps.ownedPropertyIds.length === 2 &&
       ps.ownedPropertyIds.includes(1) && ps.ownedPropertyIds.includes(3)),
    ps ? JSON.stringify(ps.ownedPropertyIds) : 'no ps');
  const tile3 = ps && ps.ownedProperties && ps.ownedProperties.find((p) => p.tileId === 3);
  check('restored house count on tile 3 = 2', !!(tile3 && tile3.houses === 2),
    tile3 ? `houses=${tile3.houses}` : 'tile 3 not owned');
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

  const H = await connect();
  const rejoinH = await emitAck(H, 'player:rejoin', { roomId: codeA, token: tokenA });
  const psH = rejoinH && rejoinH.playerState;
  check('rejoin returns the trade this player is party to',
    !!(psH && Array.isArray(psH.trades) && psH.trades.some((t) => t.id === tradeId)),
    psH ? `${psH.trades.length} trade(s)` : 'no ps');

  // The trade's target (Player 2) IS a party, so it SHOULD come back for B...
  const I = await connect();
  const rejoinI = await emitAck(I, 'player:rejoin', { roomId: codeA, token: tokenB });
  const psI = rejoinI && rejoinI.playerState;
  check('trade TARGET (Player 2) DOES see the trade',
    !!(psI && Array.isArray(psI.trades) && psI.trades.some((t) => t.id === tradeId)),
    psI ? `${psI.trades.length} trade(s)` : 'no ps');

  // ...but a brand-new, uninvolved player must NOT see it as their own.
  const J = await connect();
  const ackJ = await emitAck(J, 'room:join', { roomId: codeA });
  const tokenJ = ackJ && ackJ.token;
  const J2 = await connect();
  const rejoinJ = await emitAck(J2, 'player:rejoin', { roomId: codeA, token: tokenJ });
  const psJ = rejoinJ && rejoinJ.playerState;
  check('uninvolved player does NOT get someone else\'s trade',
    !!(psJ && Array.isArray(psJ.trades) && !psJ.trades.some((t) => t.id === tradeId)),
    psJ ? `${psJ.trades.length} trade(s)` : 'no ps');

  J.disconnect();
  J2.disconnect();

  [G, H, I].forEach((s) => s.disconnect());

  // ---- D submits a bogus token -> must be rejected ----
  const D = await connect();
  const rejoinD = await emitAck(D, 'player:rejoin', { roomId: codeA, token: 'not-a-real-token' });
  check('bogus token is REJECTED', !!(rejoinD && rejoinD.ok === false), JSON.stringify(rejoinD));

  // ---- E submits a valid token but for the WRONG room -> rejected ----
  const E = await connect();
  const rejoinE = await emitAck(E, 'player:rejoin', { roomId: 'ZZ', token: tokenB });
  check('token for a different room is REJECTED', !!(rejoinE && rejoinE.ok === false), JSON.stringify(rejoinE));

  // ---- F: an unknown room code is a clean rejection (falls back to join) ----
  const F = await connect();
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
    const L = await connect();
    const loneCreate = await emitAck(L, 'room:create', {});
    const loneCode = loneCreate.roomId;
    const loneToken = loneCreate.token;
    check('grace: lone room created', !!(loneCreate && loneCreate.ok), JSON.stringify(loneCreate));

    // The only socket in the room disappears (the classic "refresh my own tab").
    L.disconnect();
    await sleep(300); // well within the window
    const L2 = await connect();
    const rejoinL2 = await emitAck(L2, 'player:rejoin', { roomId: loneCode, token: loneToken });
    check('grace: rejoin SUCCEEDS within the window after last socket left',
      !!(rejoinL2 && rejoinL2.ok && rejoinL2.rejoined), JSON.stringify(rejoinL2));

    // And the room is genuinely alive again (a second player can join it).
    const M = await connect();
    const joinM = await emitAck(M, 'room:join', { roomId: loneCode });
    check('grace: room is alive again (fresh join works)', !!(joinM && joinM.ok), JSON.stringify(joinM));
    L2.disconnect();
    M.disconnect();

    // --- Case 2: rejoin AFTER the TTL has expired must fail (fall back to join) ---
    const N = await connect();
    const expireCreate = await emitAck(N, 'room:create', {});
    const expireCode = expireCreate.roomId;
    const expireToken = expireCreate.token;
    check('grace: expiry room created', !!(expireCreate && expireCreate.ok), JSON.stringify(expireCreate));

    N.disconnect();
    // Wait past the TTL so the server tears the room down.
    await sleep(graceTtlMs + 800);

    const N2 = await connect();
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
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('TEST ERROR:', err && err.message);
  process.exit(2);
});
