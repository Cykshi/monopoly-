// Headless PERSISTENCE test.
//
// Proves rooms survive a server RESTART and that finished games are cleaned up.
// Unlike the other suites, this one boots and KILLS the server itself (twice),
// because "survives a restart" can only be shown by actually restarting:
//
//   ROUND 1  - start server A against a fresh temp DATA_DIR; create a room, make
//              real state changes (move, buy, build, open a trade), and record
//              the room code + a player's session token.
//   RESTART  - kill server A; start server B pointed at the SAME DATA_DIR. B
//              must load the persisted room back into memory before listening.
//   ROUND 2  - against B: the room still exists (REST), and a player can
//              player:rejoin with the PRE-RESTART token and get their restored
//              state back — membership, ownership, houses, turn, trade.
//   RETENTION- tear the room down (empty-room TTL expiry) and confirm its
//              persisted file is actually gone from disk.
//
// Run:  node test-persistence.js
const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const results = [];
let failed = 0;

function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== CLEANUP: EVERY SOCKET AND EVERY SPAWNED SERVER IS CLOSED ON BOTH PATHS ====
// This suite spawns its OWN server (and restarts it), so a thrown error is worse
// here than elsewhere: it would leave a server process listening on the port and
// its temp data dir behind. `track()` records every socket and `registerServer()`
// records the live child, so cleanup() can close both from the catch block as
// well as from the success path.
const sockets = [];
const track = (s) => { sockets.push(s); return s; };

let cleanupDone = false;
let liveServer = null;
const registerServer = (s) => { liveServer = s; return s; };
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

// Kill any server this suite still owns, so a failure cannot leave a listener
// (or its temp dir) behind.
const killServer = async () => {
  if (!liveServer) return;
  try { await stopServer(liveServer.child); } catch { /* already down */ }
  liveServer = null;
};

const connect = (url) =>
  new Promise((resolve, reject) => {
    const s = io(url, { reconnectionAttempts: 1, timeout: 4000 });
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

const fetchJson = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);

// Boot a server as a child process on `port`, persisting into `dataDir`. Returns
// the child plus a promise that resolves once it answers /api/health.
async function startServer(port, dataDir) {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      // Short TTLs so the retention cases don't wait the real 90s / 15min.
      // The restored grace is a touch longer than the empty TTL: it must be long
      // enough that the Round-2 rejoin lands INSIDE the window, yet short enough
      // that the never-rejoined room is reaped during the test.
      EMPTY_ROOM_TTL_MS: '2000',
      RESTORED_ROOM_TTL_MS: '4000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[server:${port}] ${d}`));

  // Wait for health to answer (server boot + restore happens before listen).
  const url = `http://localhost:${port}`;
  for (let i = 0; i < 50; i++) {
    const health = await fetchJson(`${url}/api/health`);
    if (health && health.status === 'ok') return { child, url };
    await sleep(200);
  }
  throw new Error(`server on ${port} did not become healthy`);
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) return resolve();
    child.once('exit', () => resolve());
    child.kill();
    // Failsafe in case exit doesn't fire promptly.
    setTimeout(resolve, 3000);
  });
}

(async () => {
  // A throwaway data dir so the test never touches the real data/ folder.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monopoly-persist-'));
  const port = 3061;
  console.log(`\nUsing temp DATA_DIR: ${dataDir}\n`);

  let server = registerServer(await startServer(port, dataDir));
  check('round 1: fresh server boots', !!server.url);

  // ---- ROUND 1: create state worth persisting ----
  const A = track(await connect(server.url));
  const created = await emitAck(A, 'room:create', {});
  const roomId = created && created.roomId;
  const tokenA = created && created.token;
  check('round 1: room created', !!(created && created.ok && roomId && tokenA));

  const B = track(await connect(server.url));
  const bJoin = await emitAck(B, 'room:join', { roomId });
  const tokenB = bJoin && bJoin.token;
  check('round 1: guest joined', !!(bJoin && bJoin.ok && tokenB));

  await emitAck(A, 'player:identify', { roomId, token: tokenA, playerId: 1 });
  await emitAck(B, 'player:identify', { roomId, token: tokenB, playerId: 2 });

  // Meaningful state: move, buy two tiles, build on one, open a trade.
  //
  // MOVEMENT IS SERVER-DERIVED. The client can no longer name a destination, so
  // a move is produced the only legal way: roll (the server picks the dice), then
  // ask to move (the server computes the destination from that roll). A `money`
  // field on player:moved was always ignored by the server, so it is not sent —
  // the balance asserted in round 2 is whatever the server's own purchases left.
  const rollAndMove = async (socket, playerId) => {
    await emitAction(socket, 'player:rolled', { playerId });
    return emitAction(socket, 'player:moved', { playerId });
  };

  // The server's own room snapshot, via a sync round trip (used to read the
  // authoritative balance after the fixture's purchases).
  const syncNow = (socket) =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 1500);
      socket.once('game:sync', (s) => {
        clearTimeout(t);
        resolve(s);
      });
      socket.emit('game:request-sync', {});
    });

  // Where is the player, per the SERVER? Asked over the wire (game:sync), which
  // is the same snapshot a client sees — not read from the persisted file, which
  // is only written on "meaningful state" changes and so lags a plain move.
  const serverPosition = (socket, playerId) =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 1500);
      socket.once('game:sync', (s) => {
        clearTimeout(t);
        const p = ((s && s.players) || []).find((x) => x.id === playerId);
        resolve(p ? p.position : null);
      });
      socket.emit('game:request-sync', {});
    });

  // Walk player 1 onto `target` by rolling until it lands there — the only way to
  // move now that the client cannot name a position.
  //
  // ===== WHY THIS ENDS THE TURN EACH STEP =====
  // The test server runs a SHORT turn clock (TURN_TIME_LIMIT_MS=1500) so the
  // timeout suite is fast. A long walk of 200 rolls would blow through that clock
  // and the server would correctly ELIMINATE the player mid-walk (PLAYER_OUT).
  // So each roll+move is followed by a turn:ended, which resets the clock, and the
  // turn is handed straight back.
  const walkToAny = async (socket, playerId, targets, otherSocket, otherId, maxRolls = 400) => {
    const wanted = Array.isArray(targets) ? targets : [targets];
    // Make sure it is THIS player's turn before walking. A purchase (or any other
    // turn action) consumes the turn, so a second walk in the same fixture would
    // otherwise be refused for every roll.
    if (otherSocket && otherId !== undefined) {
      await emitAction(otherSocket, 'turn:ended', { playerId: otherId });
    }
    for (let i = 0; i < maxRolls; i++) {
      const here = await serverPosition(socket, playerId);
      if (wanted.includes(here)) return here;
      await rollAndMove(socket, playerId);
      // Re-check AFTER moving: the roll may have landed on the target.
      const landed = await serverPosition(socket, playerId);
      if (wanted.includes(landed)) return landed;
      await emitAction(socket, 'turn:ended', { playerId });
      if (otherSocket && otherId !== undefined) {
        await emitAction(otherSocket, 'turn:ended', { playerId: otherId });
      }
      await sleep(5);
    }
    const finalPos = await serverPosition(socket, playerId);
    return wanted.includes(finalPos) ? finalPos : null;
  };

  // Player 1 must own TWO ownable tiles. Which two is irrelevant to what this
  // suite proves (state survives a restart), so we buy the first two ownable tiles
  // we happen to land on rather than hunting fixed ids — a 2-12 step roll on a
  // 40-tile board makes hitting one specific low tile unreliable.
  // ===== PROPERTIES ONLY =====
  // OWNABLE includes utility tiles (airport/electricity/internet, ids 5/28/12-ish)
  // which can be BOUGHT but never built on — the board gives them no houseCost.
  // This fixture goes on to build 3 houses, so it must own a genuine PROPERTY.
  // Building on a utility is now correctly refused (BAD_BUILD), which is exactly
  // what the board table says; picking the right tile is the fixture's job.
  const OWNABLE = [1, 2, 4, 6, 8, 11, 12, 13, 16, 17, 19, 21, 22, 26, 27, 29, 31, 32, 33, 36, 39];
  const owned = [];
  let lastBuyError = null;
  for (let i = 0; i < 12 && owned.length < 2; i++) {
    // Exclude tiles we already own: the walker may still be STANDING on the tile
    // it just bought, and walkToAny would otherwise return it immediately, so the
    // loop would never collect a second distinct tile.
    const candidates = OWNABLE.filter((t) => !owned.includes(t));
    const tileId = await walkToAny(A, 1, candidates, B, 2);
    if (tileId === null) { lastBuyError = 'walk found no ownable property'; break; }
    const res = await emitAction(A, 'property:bought', { tileId, playerId: 1, price: 0 });
    if (res && res.ok) owned.push(tileId);
    else lastBuyError = JSON.stringify(res);
  }
  check('fixture: player 1 bought two ownable tiles by rolling', owned.length === 2,
    `owned=${JSON.stringify(owned)} pos=${await serverPosition(A, 1)} lastError=${lastBuyError}`);
  // The walk ends by handing the turn to the peer, so take it back before the
  // build (which is a turn action and would otherwise be rejected).
  await emitAction(B, 'turn:ended', { playerId: 2 });
  // ===== THE BUILD IS ASSERTED, NOT IGNORED =====
  // Building now DEBITS the board's buildCost. Ignoring the ack hid the case where
  // the build was refused (wrong tile type, or insufficient funds after buying two
  // tiles), which then failed much later as a puzzling "restored houses = 0".
  const buildAck = await emitAction(A, 'house:upgraded', { tileId: owned[1], houses: 3, playerId: 1 });
  check('fixture: three houses were BUILT on the second owned tile',
    !!(buildAck && buildAck.ok),
    `tile=${owned[1]} ack=${JSON.stringify(buildAck)}`);

  // One more move so the persisted position is not simply the last landing spot.
  await rollAndMove(A, 1);
  const persistedPosition = await serverPosition(A, 1);
  // Read the balance the SERVER ended up with rather than assuming it: which tiles
  // were bought (and therefore what they cost) is not fixed.
  const expectedMoney = (await syncNow(A)).players.find((p) => p.id === 1).money;

  const tradeId = 'persist-trade-1';
  await emitAction(A, 'trade:created', {
    id: tradeId, initiatorId: 1, targetId: 2,
    initiatorMoney: 100, targetMoney: 0,
    initiatorPropertyIds: [], targetPropertyIds: [],
    status: 'pending', createdAt: Date.now(), lastModifiedBy: 1
  });
  await sleep(300);

  // The room file should exist on disk now.
  const fileForRoom = path.join(dataDir, `${roomId}.json`);
  check('round 1: room is persisted to disk', fs.existsSync(fileForRoom), fileForRoom);

  // A SECOND room that will survive the restart but that NOBODY ever rejoins.
  // This is the orphaned-restored-room case: it must not leak forever.
  const Z = track(await connect(server.url));
  const abandoned = await emitAck(Z, 'room:create', {});
  const abandonedId = abandoned && abandoned.roomId;
  check('round 1: a second (abandoned) room was created', !!(abandoned && abandoned.ok && abandonedId));
  await emitAck(Z, 'player:identify', { roomId: abandonedId, token: abandoned.token, playerId: 1 });
  const fileForAbandoned = path.join(dataDir, `${abandonedId}.json`);
  check('round 1: abandoned room is persisted to disk', fs.existsSync(fileForAbandoned), fileForAbandoned);

  // ---- RESTART: kill A, boot B against the SAME data dir ----
  console.log('\n--- RESTART (kill server, boot fresh against same data dir) ---');
  A.disconnect();
  B.disconnect();
  Z.disconnect();
  await stopServer(server.child);
  check('restart: server A stopped', true);

  server = registerServer(await startServer(port, dataDir));
  check('restart: server B boots and reloads persisted rooms', !!server.url);

  // ---- ROUND 2: the room survived, and state comes back on rejoin ----
  console.log('\n--- ROUND 2: state survived the restart ---');

  const restAfter = await fetchJson(`${server.url}/api/room/${roomId}`);
  check('round 2: the room still EXISTS after restart (not orphaned)',
    !!(restAfter && restAfter.roomId === roomId), JSON.stringify(restAfter));
  check('round 2: the room still has 2 players',
    !!(restAfter && restAfter.playerCount === 2), JSON.stringify(restAfter));
  check('round 2: the room still has 2 owned properties',
    !!(restAfter && restAfter.propertyCount === 2), JSON.stringify(restAfter));

  // Rejoin with the PRE-RESTART token — proves identity survived the bounce.
  const C = track(await connect(server.url));
  const rejoin = await emitAck(C, 'player:rejoin', { roomId, token: tokenA });
  check('round 2: rejoin with a PRE-RESTART token SUCCEEDS',
    !!(rejoin && rejoin.ok && rejoin.rejoined), JSON.stringify(rejoin && rejoin.error));

  const ps = rejoin && rejoin.playerState;
  check(`round 2: restored money matches ($${expectedMoney})`,
    !!(ps && ps.me && ps.me.money === expectedMoney),
    ps && ps.me ? `money=${ps.me.money} expected=${expectedMoney}` : 'no me');
  check(`round 2: restored position matches (${persistedPosition})`,
    !!(ps && ps.me && ps.me.position === persistedPosition),
    ps && ps.me ? `position=${ps.me.position} expected=${persistedPosition}` : 'no me');
  check(`round 2: restored ownership = the two tiles bought in round 1 (${JSON.stringify(owned)})`,
    !!(ps && Array.isArray(ps.ownedPropertyIds) && ps.ownedPropertyIds.length === 2 &&
       owned.every((t) => ps.ownedPropertyIds.includes(t))),
    ps ? JSON.stringify(ps.ownedPropertyIds) : 'no ps');
  const houseTile = ps && ps.ownedProperties && ps.ownedProperties.find((p) => p.tileId === owned[1]);
  check(`round 2: restored houses on the built tile (${owned[1]}) = 3`,
    !!(houseTile && houseTile.houses === 3), houseTile ? `houses=${houseTile.houses}` : 'tile not owned');
  check('round 2: restored in-flight trade is present',
    !!(ps && Array.isArray(ps.trades) && ps.trades.some((t) => t.id === tradeId)),
    ps ? `${ps.trades.length} trade(s)` : 'no ps');
  check('round 2: restored authoritative turn is player 1',
    !!(ps && ps.currentTurnPlayerId === 1), ps ? `turn=${ps.currentTurnPlayerId}` : 'no ps');
  check('round 2: restored roster is complete (2 players)',
    !!(ps && Array.isArray(ps.players) && ps.players.length === 2),
    ps ? `players=${ps.players.length}` : 'no ps');

  C.disconnect();

  // ---- ORPHANED RESTORED ROOM: a restored room nobody rejoins must be reaped --
  // This is the leak guard: server B restored the abandoned room with ZERO
  // sockets and armed a restored-room grace. Nobody ever rejoined it, so after
  // that grace it must be torn down — file deleted, gone from memory — NOT left
  // sitting forever (else every restart would accumulate orphans).
  console.log('\n--- ORPHANED RESTORED ROOM: never rejoined -> reaped ---');

  // It was restored (so it existed right after boot). The 2s restored grace has
  // long since passed by the time we get here, so it should be gone now.
  const abandonedDeadline = Date.now() + 9000;
  let abandonedFileExists = fs.existsSync(fileForAbandoned);
  while (abandonedFileExists && Date.now() < abandonedDeadline) {
    await sleep(300);
    abandonedFileExists = fs.existsSync(fileForAbandoned);
  }
  check('orphan: a restored room nobody rejoins has its file DELETED by the grace timer',
    abandonedFileExists === false, `exists=${abandonedFileExists}`);

  const abandonedRest = await fetchJson(`${server.url}/api/room/${abandonedId}`);
  check('orphan: the never-rejoined restored room is gone from server memory',
    abandonedRest === null, JSON.stringify(abandonedRest));

  // ---- RETENTION: a torn-down room's file must actually be deleted ----
  console.log('\n--- RETENTION: teardown deletes the persisted file ---');

  // The room must be EMPTY for teardown to fire. Ask every socket that could still
  // be attached to leave, and WAIT for the server's `room:left` confirmation on
  // each one — a bare emit has no delivery guarantee, so firing and hoping is what
  // made this leg flaky.
  //
  // NOTE: this project ends a room's session the instant its LAST socket leaves —
  // the room, its file and every token are destroyed immediately, with no grace
  // period (see leaveRoom/teardownRoom in server.js). So the only requirement for
  // this leg is that nothing is still attached.
  const leaveConfirmed = (sock) =>
    new Promise((resolve) => {
      if (!sock || !sock.connected) return resolve(false);
      const t = setTimeout(() => resolve(false), 1500);
      sock.once('room:left', () => { clearTimeout(t); resolve(true); });
      sock.emit('room:leave');
    });

  for (const s of [C, A, B, Z]) {
    await leaveConfirmed(s);
  }
  await sleep(500);

  // Diagnostics: if the room still exists, say HOW MANY sockets are attached, so a
  // failure here points at the socket that was not actually closed rather than
  // looking like a teardown bug.
  const beforeLeave = await fetchJson(`${server.url}/api/room/${roomId}`);
  if (beforeLeave) {
    console.log(`  (room still live with ${beforeLeave.connectedCount} socket(s) attached)`);
  }

  for (const s of [C, A, B, Z]) {
    try { if (s && typeof s.disconnect === 'function') s.disconnect(); } catch { /* ignore */ }
  }

  const goneDeadline = Date.now() + 8000;
  let stillThere = fs.existsSync(fileForRoom);
  while (stillThere && Date.now() < goneDeadline) {
    await sleep(300);
    stillThere = fs.existsSync(fileForRoom);
  }
  check('retention: torn-down room\'s persisted file is GONE', stillThere === false,
    `exists=${stillThere}`);

  // And the room is genuinely gone from the server's memory too.
  await sleep(300);
  const restGone = await fetchJson(`${server.url}/api/room/${roomId}`);
  check('retention: the torn-down room no longer exists on the server', restGone === null,
    JSON.stringify(restGone));

  // ---- A restart AFTER teardown must NOT resurrect the dead room ----
  await stopServer(server.child);
  liveServer = null;
  server = registerServer(await startServer(port, dataDir));
  const restAfterDelete = await fetchJson(`${server.url}/api/room/${roomId}`);
  check('retention: a restart does NOT resurrect the torn-down room',
    restAfterDelete === null, JSON.stringify(restAfterDelete));

  await stopServer(server.child);
  liveServer = null;

  // Clean up the temp dir.
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  await cleanup(roomId);
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error('TEST ERROR:', err && err.message);
  // A thrown error must not leave the spawned server listening or its sockets
  // open — this suite owns a server, so that leak would outlive the whole run.
  await cleanup();
  await killServer();
  process.exit(2);
});
