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
// owner, peer and the rejoin stand-in are all registered here, so cleanup() can
// close them from the catch block and from the early-bail path below — not only
// from the success path. A socket left open would keep the room alive on the
// shared test server and leak it into the next suite.
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
  const owner = track(await connect());
  const created = await emitAck(owner, 'room:create', {});
  const roomId = created.roomId;
  const token = created.token;
  check('setup: room created', !!(created && created.ok), JSON.stringify(created));

  const peer = track(await connect());
  const peerJoin = await emitAck(peer, 'room:join', { roomId });
  check('setup: peer joined', !!(peerJoin && peerJoin.ok));

  // ===== IDENTIFY BOTH SOCKETS =====
  // A socket has NO acting seat until it completes the player:identify handshake
  // (see actingPlayerId/actorOf in server.js). Without this the host is anonymous,
  // every roll/move/purchase is rejected NOT_IDENTIFIED, and the rejoin below
  // resolves to a seat that owns nothing — which is exactly what this fixture used
  // to do, silently, while still "passing" its own weak assertions.
  const idOwner = await emitAck(owner, 'player:identify', { roomId, token, playerId: 1 });
  check('setup: owner identified as player 1', !!(idOwner && idOwner.ok && idOwner.playerId === 1),
    JSON.stringify(idOwner));
  const idPeer = await emitAck(peer, 'player:identify', { roomId, token: peerJoin.token, playerId: 2 });
  check('setup: peer identified as player 2', !!(idPeer && idPeer.ok && idPeer.playerId === 2),
    JSON.stringify(idPeer));

  // Purchases are validated server-side, so the owner must be STANDING on each
  // tile it buys: roll until it lands on the tile, buy, then roll on to the next.
  //
  // The `price` field is deliberately still sent as 0 to document that the server
  // IGNORES it: tile 2 (Normandy) costs 100 and tile 4 (Bihar) costs 140 on the
  // authoritative board, so the two purchases debit 240 in total. The final
  // balance is therefore 1500 - 240 = 1260 — the client's claimed price has no
  // effect on it.
  // ===== MEANINGFUL STATE, PRODUCED THE ONLY LEGAL WAY =====
  const rollAndMove = async (socket, playerId) => {
    await emitAction(socket, 'player:rolled', { playerId });
    return emitAction(socket, 'player:moved', { playerId });
  };

  // The server's own room snapshot, via a sync round trip (used to read the
  // authoritative balance after the fixture's purchases).
  const syncState = (socket) =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 1500);
      socket.once('game:sync', (s) => {
        clearTimeout(t);
        resolve(s);
      });
      socket.emit('game:request-sync', {});
    });

  // The server's own position for a player, asked over the wire (game:sync) —
  // the same snapshot a client sees. Reading the persisted file would not work
  // here: this suite runs against the shared test server, whose DATA_DIR is not
  // knowable from inside the test, and a plain move is not a persisted event.
  const serverPos = (socket, playerId) =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 1500);
      socket.once('game:sync', (s) => {
        clearTimeout(t);
        const p = ((s && s.players) || []).find((x) => x.id === playerId);
        resolve(p ? p.position : null);
      });
      socket.emit('game:request-sync', {});
    });
  // ===== WHY THIS ENDS THE TURN EACH STEP =====
  // The test server runs a SHORT turn clock (TURN_TIME_LIMIT_MS=1500) so the
  // timeout suite is fast. A long walk of 200 rolls would blow through that clock
  // and the server would correctly ELIMINATE the player mid-walk (PLAYER_OUT).
  // So each roll+move is followed by a turn:ended, which resets the clock, and the
  // turn is handed straight back.
  // Walk player 1 until it lands on ANY of `targets` — the only way to move now
  // that the client cannot name a position. Accepting a SET matters: each roll
  // moves 2-12 tiles on a 40-tile board, so hunting ONE exact tile can take many
  // rolls, while any tile in a group will do.
  const walkToAny = async (socket, playerId, targets, otherSocket, otherId, maxRolls = 60) => {
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
  // suite proves (the rejoin payload round-trips), so we buy the first two ownable
  // tiles we happen to land on rather than hunting fixed ids — a 2-12 step roll on
  // a 40-tile board makes hitting one specific low tile unreliable, but landing on
  // ANY ownable tile is quick.
  // ===== PROPERTIES ONLY =====
  // Utility tiles (airport/electricity/internet) are OWNABLE but cannot be built
  // on — the board gives them no houseCost. This fixture builds 3 houses below, so
  // it must own a genuine PROPERTY, otherwise the build is correctly refused with
  // BAD_BUILD and the mapped house count comes back 0.
  const OWNABLE = [1, 2, 4, 6, 8, 11, 12, 13, 16, 17, 19, 21, 22, 26, 27, 29, 31, 32, 33, 36, 39];
  const owned = [];
  let lastBuyError = null;
  for (let i = 0; i < 12 && owned.length < 2; i++) {
    // Exclude tiles we already own: the walker may still be STANDING on the tile
    // it just bought, and walkToAny would otherwise return it immediately, so the
    // loop would never collect a second distinct tile.
    const candidates = OWNABLE.filter((t) => !owned.includes(t));
    const tileId = await walkToAny(owner, 1, candidates, peer, 2);
    if (tileId === null) { lastBuyError = 'walk found no ownable property'; break; }
    const res = await emitAction(owner, 'property:bought', { tileId, playerId: 1, price: 0 });
    if (res && res.ok) owned.push(tileId);
    else lastBuyError = JSON.stringify(res);
  }
  check('fixture: player 1 bought two ownable tiles by rolling', owned.length === 2,
    `owned=${JSON.stringify(owned)} pos=${await serverPos(owner, 1)} lastError=${lastBuyError}`);

  // The rest of this suite is meaningless without two owned tiles, so bail out
  // loudly rather than reporting a cascade of confusing downstream failures.
  if (owned.length < 2) {
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    // Bail out loudly rather than reporting a cascade of confusing downstream
    // failures — but still tear the sockets and room down first.
    await cleanup(roomId);
    process.exit(1);
  }
  await emitAction(owner, 'house:upgraded', { tileId: owned[1], houses: 3, playerId: 1 });

  // One final move so the persisted position is a real, derived value. The walk
  // above ends by handing the turn to the peer, so take it back first.
  await emitAction(peer, 'turn:ended', { playerId: 2 });
  await emitAction(owner, 'player:rolled', { playerId: 1 });
  await emitAction(owner, 'player:moved', { playerId: 1 });

  // Read the balance the SERVER ended up with rather than assuming it: which tiles
  // were bought (and therefore what they cost) is not fixed.
  const expectedPosition = await serverPos(owner, 1);
  const expectedMoney = (await syncState(owner)).players.find((p) => p.id === 1).money;
  owner.emit('trade:created', {
    id: 'itrade-1', initiatorId: 1, targetId: 2,
    initiatorMoney: 50, targetMoney: 0,
    initiatorPropertyIds: [], targetPropertyIds: [],
    status: 'pending', createdAt: Date.now(), lastModifiedBy: 1
  });
  await sleep(250);

  // ---- Rejoin with the token, WITHOUT emptying the room ----
  // ===== WHY THIS DOES NOT DISCONNECT THE OWNER FIRST =====
  // This project ends a room's session the moment its LAST socket leaves: the room,
  // its file and every session token are destroyed immediately (there is
  // deliberately no empty-room grace period — see leaveRoom/teardownRoom in
  // server.js). Dropping `owner` here therefore destroyed the very state this
  // suite exists to verify, and the rejoin came back empty.
  //
  // A rejoin is still fully exercised: a SECOND socket presents the same token and
  // must be handed the same seat with the same state. What is not exercised is
  // "reconnect after a full disconnect", because the server does not support that
  // by design — it is not a rejoin, it is a new session.
  const fresh = track(await connect());
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
  check(`map: propertyOwnership carried through (has tiles ${JSON.stringify(owned)})`,
    !!(mapped.propertyOwnership && owned.every((t) => mapped.propertyOwnership[t] === 1)),
    JSON.stringify(mapped.propertyOwnership));
  check(`map: propertyHouses carried through (tile ${owned[1]} -> 3)`,
    !!(mapped.propertyHouses && mapped.propertyHouses[owned[1]] === 3),
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
  // The log line quotes the restored balance. It is asserted against the value the
  // SERVER actually reported rather than a hardcoded figure — which tiles were
  // bought (and therefore what they cost) is not fixed by this fixture.
  const expectedMoneyStr = expectedMoney.toLocaleString();
  check(`map: log line mentions the restored money ($${expectedMoneyStr})`,
    typeof mapped.logMessage === 'string' && mapped.logMessage.includes(expectedMoneyStr),
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
  await cleanup(roomId);
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error('TEST ERROR:', err && err.message);
  await cleanup();
  process.exit(2);
});
