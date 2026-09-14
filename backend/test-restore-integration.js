// Integration test: does the SERVER's real rejoin payload match what the
// CLIENT's pure mapping (computeRestoredState) expects?
//
// This is the seam most likely to break silently: the server could rename or
// drop a field and both sides would still "work" in isolation. So rather than
// hand-crafting a mock payload, this suite:
//   1. connects a real socket to the live server,
//   2. drives a real disconnect + player:rejoin (same pattern as the grace tests),
//   3. captures the ACTUAL playerState the server sends back,
//   4. feeds that real payload into the client's pure computeRestoredState(),
//   5. asserts the produced state shape matches what the client expects.
//
// It does NOT render React or touch component state — only the pure mapping.
//
// The pure function is TypeScript, so we transpile it once to a temp .js file
// with the frontend's own tsc before requiring it. No tsx/ts-node needed.
//
// Run against a live server:  node test-restore-integration.js
//   (SERVER_URL defaults to http://localhost:3002)
const { io } = require('socket.io-client');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

// Transpile the client's pure mapping module to plain CommonJS we can require.
function loadComputeRestoredState() {
  const frontendDir = path.resolve(__dirname, '..', 'frontend');
  const src = path.join(frontendDir, 'lib', 'restore-state.ts');
  if (!fs.existsSync(src)) throw new Error(`missing ${src}`);

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-state-'));
  const tscBin = path.join(frontendDir, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(process.execPath, [
    tscBin,
    src,
    '--outDir', outDir,
    '--module', 'commonjs',
    '--target', 'es2019',
    '--moduleResolution', 'node',
    '--skipLibCheck'
  ], { stdio: 'inherit' });

  const jsPath = path.join(outDir, 'restore-state.js');
  if (!fs.existsSync(jsPath)) throw new Error(`tsc did not emit ${jsPath}`);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(jsPath).computeRestoredState;
}

(async () => {
  const computeRestoredState = loadComputeRestoredState();
  console.log(`\nLoaded client computeRestoredState from frontend/lib/restore-state.ts`);
  console.log(`Testing against live server ${URL}\n`);

  // ---- Set up a real room with real state, exactly like a live player would ----
  const owner = await connect();
  const created = await emitAck(owner, 'room:create', {});
  const roomId = created.roomId;
  const token = created.token;
  check('setup: room created', !!(created && created.ok), JSON.stringify(created));

  const peer = await connect();
  const peerJoin = await emitAck(peer, 'room:join', { roomId });
  check('setup: peer joined', !!(peerJoin && peerJoin.ok));

  // Purchases are validated server-side now, so the owner must be STANDING on
  // each tile it buys: move onto the tile, buy, then move to the next.
  await emitAck(owner, 'player:moved', { playerId: 1, position: 2, money: 2345 });
  await emitAck(owner, 'property:bought', { tileId: 2, playerId: 1, price: 0 });
  await emitAck(owner, 'player:moved', { playerId: 1, position: 4, money: 2345 });
  await emitAck(owner, 'property:bought', { tileId: 4, playerId: 1, price: 0 });
  await emitAck(owner, 'house:upgraded', { tileId: 4, houses: 3, playerId: 1 });
  owner.emit('player:moved', { playerId: 1, position: 17, money: 2345 });
  owner.emit('trade:created', {
    id: 'itrade-1', initiatorId: 1, targetId: 2,
    initiatorMoney: 50, targetMoney: 0,
    initiatorPropertyIds: [], targetPropertyIds: [],
    status: 'pending', createdAt: Date.now(), lastModifiedBy: 1
  });
  await sleep(250);

  // ---- The real refresh: drop the ONLY own-socket then rejoin with the token ----
  owner.disconnect();
  await sleep(200);
  const fresh = await connect();
  const rejoin = await emitAck(fresh, 'player:rejoin', { roomId, token });
  check('rejoin: server returned a real playerState', !!(rejoin && rejoin.ok && rejoin.playerState),
    rejoin && rejoin.playerState ? 'present' : 'MISSING');

  const realPayload = rejoin.playerState;

  // ---- Feed the REAL payload through the client's pure mapping ----
  const mapped = computeRestoredState(realPayload);

  check('map: players is an array of the real roster',
    Array.isArray(mapped.players) && mapped.players.length === 2,
    mapped.players ? `players=${mapped.players.length}` : 'null');
  check('map: myPlayerId is derived from payload.me.id',
    mapped.myPlayerId === realPayload.me.id, String(mapped.myPlayerId));
  check('map: myPlayerId === 1 (the reconnecting player)',
    mapped.myPlayerId === 1, String(mapped.myPlayerId));
  check('map: propertyOwnership carried through (has tiles 2 & 4)',
    !!(mapped.propertyOwnership && mapped.propertyOwnership[2] === 1 && mapped.propertyOwnership[4] === 1),
    JSON.stringify(mapped.propertyOwnership));
  check('map: propertyHouses carried through (tile 4 -> 3)',
    !!(mapped.propertyHouses && mapped.propertyHouses[4] === 3),
    JSON.stringify(mapped.propertyHouses));
  check('map: the owned-property list survives the round trip',
    !!(mapped.players && mapped.propertyOwnership &&
       Object.keys(mapped.propertyOwnership).filter((t) => mapped.propertyOwnership[t] === 1).length === 2),
    `owned=${JSON.stringify(realPayload.ownedPropertyIds)}`);
  check('map: trades is an array containing the in-flight trade',
    Array.isArray(mapped.trades) && mapped.trades.some((t) => t.id === 'itrade-1'),
    mapped.trades ? `${mapped.trades.length} trade(s)` : 'null');
  check('map: chatMessages is an array (present, even if empty)',
    Array.isArray(mapped.chatMessages), Array.isArray(mapped.chatMessages) ? `len=${mapped.chatMessages.length}` : 'null');
  check('map: activeAuction is null when no auction is running',
    mapped.activeAuction === null, JSON.stringify(mapped.activeAuction));
  check('map: isGameStarted is forced true on restore', mapped.isGameStarted === true);
  check('map: log line mentions the restored money ($2,345)',
    typeof mapped.logMessage === 'string' && mapped.logMessage.includes('2,345'),
    mapped.logMessage);

  // ---- And the mapping is genuinely pure: same input -> same output ----
  const again = computeRestoredState(realPayload);
  check('map: pure — identical output for identical input',
    JSON.stringify(again) === JSON.stringify(mapped));

  // ---- A sparse payload must yield nulls (leave-untouched), not empty clobbers ----
  const sparse = computeRestoredState({ me: { id: 7 } });
  check('map: sparse payload -> players null (leave untouched)', sparse.players === null);
  check('map: sparse payload -> myPlayerId from me.id', sparse.myPlayerId === 7, String(sparse.myPlayerId));
  check('map: sparse payload -> log still well-formed',
    typeof sparse.logMessage === 'string' && sparse.logMessage.includes('$0'),
    sparse.logMessage);

  peer.disconnect();
  fresh.disconnect();

  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('TEST ERROR:', err && err.message);
  process.exit(2);
});
