// ============================================================================
// REGRESSION TEST SUITE: BROWSER-REFRESH STATE MUTATION BUG
// ============================================================================
// Verifies:
// 1. Refreshing in lobby (pre-game) restores the room without changing state.
// 2. Unlocked settings remain unlocked across refresh.
// 3. Locked settings remain locked across refresh.
// 4. Refresh does NOT start the game or trigger any gameplay action.
// 5. Preserves player identity, seat, color, and game state.
// 6. Lone player refresh is preserved by the empty-room grace timer.
// 7. Pure mapping computeRestoredState properly reflects server truth.
// ============================================================================

const { io } = require('socket.io-client');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const URL = process.env.SERVER_URL || 'http://localhost:3099';
const results = [];
let failed = 0;

function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

const connect = () =>
  new Promise((resolve, reject) => {
    const s = io(URL, { reconnectionAttempts: 2, timeout: 4000 });
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
  actionId: `act-${Date.now()}-${++actionCounter}`,
});
const emitAction = (socket, event, payload, ms = 2500) =>
  emitAck(socket, event, withAction(payload), ms);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sockets = [];
const track = (s) => { sockets.push(s); return s; };

async function closeAllSockets() {
  for (const s of sockets) {
    try {
      if (s && s.connected) s.disconnect();
    } catch { /* ignore */ }
  }
}

// Load frontend's computeRestoredState
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
  return require(jsPath).computeRestoredState;
}

(async () => {
  const computeRestoredState = loadComputeRestoredState();

  // =========================================================================
  // GROUP 1: PURE MAPPING UNIT TESTS (computeRestoredState)
  // =========================================================================
  console.log('\n--- GROUP 1: PURE MAPPING (computeRestoredState) TESTS ---');
  {
    // Sparse payload: isGameStarted omitted -> must be false, NOT true
    const sparse = computeRestoredState({ me: { id: 1 } });
    check('G1: sparse payload isGameStarted defaults to false', sparse.isGameStarted === false,
      `isGameStarted=${sparse.isGameStarted}`);

    // Explicit isGameStarted: false -> must be false
    const lobbyPayload = {
      me: { id: 1, name: 'Alice', color: '#00A86B' },
      isGameStarted: false,
      settings: { fastMode: true, enableTrading: false }
    };
    const mappedLobby = computeRestoredState(lobbyPayload);
    check('G1: lobby payload isGameStarted is false', mappedLobby.isGameStarted === false,
      `isGameStarted=${mappedLobby.isGameStarted}`);
    check('G1: settings preserved in lobby payload',
      mappedLobby.settings && mappedLobby.settings.fastMode === true && mappedLobby.settings.enableTrading === false);

    // Explicit isGameStarted: true -> must be true
    const startedPayload = {
      me: { id: 1, name: 'Alice', color: '#00A86B' },
      isGameStarted: true
    };
    const mappedStarted = computeRestoredState(startedPayload);
    check('G1: started payload isGameStarted is true', mappedStarted.isGameStarted === true,
      `isGameStarted=${mappedStarted.isGameStarted}`);
  }

  // =========================================================================
  // GROUP 2: REFRESH IN LOBBY PRESERVES UNLOCKED SETTINGS & IDENTITY
  // =========================================================================
  console.log('\n--- GROUP 2: LOBBY REFRESH (UNLOCKED SETTINGS & IDENTITY) ---');
  {
    const A = track(await connect());
    const created = await emitAck(A, 'room:create', { name: 'AliceHost' });
    const roomId = created.roomId;
    const tokenA = created.token;

    // Host picks color
    await emitAck(A, 'player:set-color', { color: '#00A86B' });

    // Host updates settings
    const settingsUpdate = await emitAck(A, 'room:update-settings', {
      settings: {
        fastMode: true,
        enableTrading: false,
        enableAuction: false,
        restHouseMode: 'rest'
      }
    });
    check('G2: host updated settings in lobby',
      settingsUpdate && settingsUpdate.ok && settingsUpdate.settings.fastMode === true && settingsUpdate.settings.enableTrading === false);

    // Guest joins
    const B = track(await connect());
    const bJoin = await emitAck(B, 'room:join', { roomId, name: 'BobGuest' });
    const tokenB = bJoin.token;
    await emitAck(B, 'player:identify', { roomId, token: tokenB, playerId: 2 });
    await emitAck(B, 'player:set-color', { color: '#2196F3' });

    // ---- SIMULATE HOST REFRESH ----
    // Host socket disconnects
    A.disconnect();
    await sleep(200);

    // Host reconnects with tokenA on fresh socket A2
    const A2 = track(await connect());
    const rejoinA2 = await emitAck(A2, 'player:rejoin', { roomId, token: tokenA });

    check('G2: host rejoin succeeded', !!(rejoinA2 && rejoinA2.ok && rejoinA2.rejoined));
    check('G2: host role returned as host', rejoinA2.role === 'host');
    check('G2: playerState.isGameStarted is FALSE on lobby refresh',
      rejoinA2.playerState && rejoinA2.playerState.isGameStarted === false,
      `isGameStarted=${rejoinA2.playerState?.isGameStarted}`);

    const restoredA2 = computeRestoredState(rejoinA2.playerState);
    check('G2: restored state isGameStarted is FALSE', restoredA2.isGameStarted === false);
    check('G2: host settings preserved (fastMode=true, enableTrading=false)',
      restoredA2.settings && restoredA2.settings.fastMode === true && restoredA2.settings.enableTrading === false && restoredA2.settings.enableAuction === false);
    check('G2: host identity preserved (id=1, name=AliceHost, color=#00A86B)',
      rejoinA2.playerState.me.id === 1 &&
      rejoinA2.playerState.me.name === 'AliceHost' &&
      rejoinA2.playerState.me.color === '#00A86B');

    // Re-identifying host must NOT overwrite name or start game
    const identA2 = await emitAck(A2, 'player:identify', { roomId, token: tokenA, playerId: 1, name: 'IgnoredNewName' });
    check('G2: player:identify did not mutate established name',
      identA2 && identA2.ok && identA2.name === 'AliceHost', `name=${identA2?.name}`);

    // UNLOCKED SETTINGS MUST REMAIN UNLOCKED: host can still modify settings
    const settingChangePostRefresh = await emitAck(A2, 'room:update-settings', {
      settings: { fastMode: false }
    });
    check('G2: unlocked settings remain unlocked (host can update after refresh)',
      settingChangePostRefresh && settingChangePostRefresh.ok && settingChangePostRefresh.settings.fastMode === false);

    // ---- SIMULATE GUEST REFRESH ----
    B.disconnect();
    await sleep(200);

    const B2 = track(await connect());
    const rejoinB2 = await emitAck(B2, 'player:rejoin', { roomId, token: tokenB });
    check('G2: guest rejoin succeeded', !!(rejoinB2 && rejoinB2.ok && rejoinB2.rejoined));
    check('G2: guest role is guest', rejoinB2.role === 'guest');
    check('G2: guest playerState.isGameStarted is FALSE', rejoinB2.playerState?.isGameStarted === false);
    check('G2: guest identity preserved (id=2, name=BobGuest, color=#2196F3)',
      rejoinB2.playerState.me.id === 2 &&
      rejoinB2.playerState.me.name === 'BobGuest' &&
      rejoinB2.playerState.me.color === '#2196F3');

    // Clean up room
    await emitAck(A2, 'room:leave', {});
    A2.disconnect();
    B2.disconnect();
    await sleep(200);
  }

  // =========================================================================
  // GROUP 3: LONE PLAYER TAB REFRESH (EMPTY ROOM GRACE PERIOD)
  // =========================================================================
  console.log('\n--- GROUP 3: LONE PLAYER REFRESH (EMPTY-ROOM GRACE PERIOD) ---');
  {
    const lone = track(await connect());
    const created = await emitAck(lone, 'room:create', { name: 'LoneHost' });
    const roomId = created.roomId;
    const token = created.token;

    await emitAck(lone, 'player:set-color', { color: '#E32636' });
    await emitAck(lone, 'room:update-settings', {
      settings: { fastMode: true, enableMortgage: false }
    });

    // The lone socket disconnects (browser refresh when solo in room)
    lone.disconnect();
    await sleep(350); // within the 90s grace window

    // Reconnecting socket
    const lone2 = track(await connect());
    const rejoin = await emitAck(lone2, 'player:rejoin', { roomId, token });

    check('G3: lone player refresh succeeds within grace period',
      !!(rejoin && rejoin.ok && rejoin.rejoined), JSON.stringify(rejoin));
    check('G3: lone player restored without starting game',
      rejoin && rejoin.playerState && rejoin.playerState.isGameStarted === false);
    check('G3: lone player settings intact (fastMode=true, enableMortgage=false)',
      rejoin && rejoin.playerState && rejoin.playerState.settings &&
      rejoin.playerState.settings.fastMode === true &&
      rejoin.playerState.settings.enableMortgage === false);
    check('G3: lone player name and color preserved',
      rejoin && rejoin.playerState && rejoin.playerState.me.name === 'LoneHost' &&
      rejoin.playerState.me.color === '#E32636');

    // Settings must remain unlocked
    const updatePostRefresh = await emitAck(lone2, 'room:update-settings', {
      settings: { enableMortgage: true }
    });
    check('G3: lone host can still update settings after refresh',
      updatePostRefresh && updatePostRefresh.ok && updatePostRefresh.settings.enableMortgage === true);

    await emitAck(lone2, 'room:leave', {});
    lone2.disconnect();
    await sleep(200);
  }

  // =========================================================================
  // GROUP 4: REFRESH IN STARTED GAME PRESERVES LOCKED SETTINGS & GAME STATE
  // =========================================================================
  console.log('\n--- GROUP 4: STARTED GAME REFRESH (LOCKED SETTINGS & STATE) ---');
  {
    const A = track(await connect());
    const created = await emitAck(A, 'room:create', { name: 'P1Host' });
    const roomId = created.roomId;
    const tokenA = created.token;

    const B = track(await connect());
    const bJoin = await emitAck(B, 'room:join', { roomId, name: 'P2Guest' });
    const tokenB = bJoin.token;

    await emitAck(A, 'player:set-color', { color: '#00A86B' });
    await emitAck(B, 'player:set-color', { color: '#2196F3' });

    // Start game by rolling dice as Player 1
    const roll = await emitAction(A, 'player:rolled', { playerId: 1 });
    check('G4: game started via player:rolled', roll && roll.ok);

    const move = await emitAction(A, 'player:moved', { playerId: 1 });
    check('G4: player 1 moved', move && move.ok && typeof move.position === 'number');

    // Player 1 reconnects (e.g. refresh during active game)
    const A2 = track(await connect());
    const rejoinA2 = await emitAck(A2, 'player:rejoin', { roomId, token: tokenA });

    check('G4: started game rejoin succeeded', !!(rejoinA2 && rejoinA2.ok && rejoinA2.rejoined));
    check('G4: playerState.isGameStarted is TRUE on started game refresh',
      rejoinA2.playerState && rejoinA2.playerState.isGameStarted === true);

    const restoredA2 = computeRestoredState(rejoinA2.playerState);
    check('G4: restored state isGameStarted is TRUE', restoredA2.isGameStarted === true);

    // LOCKED SETTINGS MUST REMAIN LOCKED
    const updateAttempt = await emitAck(A2, 'room:update-settings', {
      settings: { fastMode: true }
    });
    check('G4: locked settings remain locked (update rejected with GAME_STARTED)',
      updateAttempt && updateAttempt.ok === false && updateAttempt.code === 'GAME_STARTED');

    // Player position, money, seat, color preserved
    check('G4: player position and money preserved across refresh',
      rejoinA2.playerState.me.position === move.position &&
      rejoinA2.playerState.me.money === move.money &&
      rejoinA2.playerState.me.id === 1 &&
      rejoinA2.playerState.me.color === '#00A86B');

    // End turn cleanly
    await emitAction(A2, 'turn:ended', { playerId: 1 });

    await emitAck(A2, 'room:leave', {});
    A.disconnect();
    A2.disconnect();
    B.disconnect();
  }

  console.log(`\n================================================================`);
  console.log(`${results.length - failed}/${results.length} checks passed`);
  console.log(`================================================================`);
  await closeAllSockets();
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error('Test execution failed:', err);
  await closeAllSockets();
  process.exit(1);
});
