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

  let server = await startServer(port, dataDir);
  check('round 1: fresh server boots', !!server.url);

  // ---- ROUND 1: create state worth persisting ----
  const A = await connect(server.url);
  const created = await emitAck(A, 'room:create', {});
  const roomId = created && created.roomId;
  const tokenA = created && created.token;
  check('round 1: room created', !!(created && created.ok && roomId && tokenA));

  const B = await connect(server.url);
  const bJoin = await emitAck(B, 'room:join', { roomId });
  const tokenB = bJoin && bJoin.token;
  check('round 1: guest joined', !!(bJoin && bJoin.ok && tokenB));

  await emitAck(A, 'player:identify', { roomId, token: tokenA, playerId: 1 });
  await emitAck(B, 'player:identify', { roomId, token: tokenB, playerId: 2 });

  // Meaningful state: move, buy two tiles, build on one, open a trade.
  await emitAck(A, 'player:moved', { playerId: 1, position: 2, money: 1750 });
  await emitAck(A, 'property:bought', { tileId: 2, playerId: 1, price: 0 });
  await emitAck(A, 'player:moved', { playerId: 1, position: 4, money: 1750 });
  await emitAck(A, 'property:bought', { tileId: 4, playerId: 1, price: 0 });
  await emitAck(A, 'house:upgraded', { tileId: 4, houses: 3, playerId: 1 });
  await emitAck(A, 'player:moved', { playerId: 1, position: 17, money: 1650 });

  const tradeId = 'persist-trade-1';
  await emitAck(A, 'trade:created', {
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
  const Z = await connect(server.url);
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

  server = await startServer(port, dataDir);
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
  const C = await connect(server.url);
  const rejoin = await emitAck(C, 'player:rejoin', { roomId, token: tokenA });
  check('round 2: rejoin with a PRE-RESTART token SUCCEEDS',
    !!(rejoin && rejoin.ok && rejoin.rejoined), JSON.stringify(rejoin && rejoin.error));

  const ps = rejoin && rejoin.playerState;
  check('round 2: restored money matches ($1650)',
    !!(ps && ps.me && ps.me.money === 1650), ps && ps.me ? `money=${ps.me.money}` : 'no me');
  check('round 2: restored position matches (17)',
    !!(ps && ps.me && ps.me.position === 17), ps && ps.me ? `position=${ps.me.position}` : 'no me');
  check('round 2: restored ownership = tiles [2,4]',
    !!(ps && Array.isArray(ps.ownedPropertyIds) && ps.ownedPropertyIds.length === 2 &&
       ps.ownedPropertyIds.includes(2) && ps.ownedPropertyIds.includes(4)),
    ps ? JSON.stringify(ps.ownedPropertyIds) : 'no ps');
  const tile4 = ps && ps.ownedProperties && ps.ownedProperties.find((p) => p.tileId === 4);
  check('round 2: restored houses on tile 4 = 3',
    !!(tile4 && tile4.houses === 3), tile4 ? `houses=${tile4.houses}` : 'tile 4 not owned');
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

  // The room is now empty (C disconnected). The short EMPTY_ROOM_TTL_MS (2s)
  // should tear it down, which deletes its file. Wait past the TTL.
  const goneDeadline = Date.now() + 6000;
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
  server = await startServer(port, dataDir);
  const restAfterDelete = await fetchJson(`${server.url}/api/room/${roomId}`);
  check('retention: a restart does NOT resurrect the torn-down room',
    restAfterDelete === null, JSON.stringify(restAfterDelete));

  await stopServer(server.child);

  // Clean up the temp dir.
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  await sleep(250);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('TEST ERROR:', err && err.message);
  process.exit(2);
});
