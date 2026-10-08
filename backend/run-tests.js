// ================= BACKEND TEST RUNNER =================
//
// `npm test` used to be `echo "Error: no test specified" && exit 1` — so the
// seven working suites in this directory could not be run through npm at all.
// This runner is the one command that executes them, in dependency order.
//
// The suites fall into two kinds, and they are run differently:
//
//   OFFLINE (no server needed)
//     test-persistence.js        - room file write/load/delete, against a temp dir
//     These are plain scripts that exit 0/1 and are run directly.
//
//   LIVE-SERVER (need a running server, and some need env config)
//     test-validation.js         - anti-cheat checks driven over the wire, so it
//                                  needs a real room and real sockets
//     test-rooms.js              - room create/join/leave, room scoping
//     test-sessions.js           - token identity + rejoin (+ TTL legs, which SKIP
//                                  unless EXPECTED_TTL_MS matches the server)
//     test-turn-authority.js     - turn ownership / anti-impersonation
//     test-turn-timeout.js       - the server-side turn clock (SKIPS unless
//                                  EXPECTED_TURN_MS is set)
//     test-action-integrity.js   - replay protection, authoritative price/rent,
//                                  movement validation, the turn deadline
//     test-roll-authority.js     - the server owns the dice AND the destination:
//                                  client dice/total are ignored, movement is
//                                  derived from the authoritative roll, and the
//                                  "roll 2 then send position 39" teleport is
//                                  pinned down as a regression
//     test-event-forgery.js      - a peer cannot forge a server-only event: the
//                                  arbitrary onAny passthrough is gone, so
//                                  emitting game:over / room:players / etc.
//                                  reaches nobody, while the REAL server emits
//                                  for those names still arrive
//     test-identity-security.js  - impersonation: no event may act as another
//                                  player, and no socket may act outside its room
//     test-restore-integration.js- restart/rehydrate round trip
//
// For the live-server suites this runner starts its OWN server on a free port
// with a SHORT turn clock, so `npm test` is self-contained and fast rather than
// requiring the developer to have a server already running (and to remember
// which env vars each suite wants).
//
// Usage:
//   npm test                 - everything
//   npm test -- --offline    - only the self-contained suites
//   npm test -- --keep       - leave the spawned server running for debugging
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const HERE = __dirname;
const NODE = process.execPath;

// A short turn clock keeps the timeout suite fast (it would otherwise wait 120s
// per turn). Both the server and the timeout suite read the same number.
const TURN_MS = 1500;
const PORT = Number(process.env.TEST_PORT) || 3099;

const OFFLINE_SUITES = [
  'test-movement-unit.js',
  'test-persistence.js',
];

const ONLINE_SUITES = [
  'test-validation.js',
  'test-rooms.js',
  'test-sessions.js',
  'test-turn-authority.js',
  'test-turn-timeout.js',
  'test-action-integrity.js',
  'test-roll-authority.js',
  'test-event-forgery.js',
  'test-identity-security.js',
  'test-restore-integration.js',
  'test-auction-payment.js',
  'test-property-selling.js',
  'test-card-authority.js',
  'test-jail-entry.js',
  'test-pot-authority.js',
  'test-tax-authority.js',
];

const onlyOffline = process.argv.includes('--offline');
const keepServer = process.argv.includes('--keep');

// A suite that HANGS must not hang the whole run. spawnSync would otherwise wait
// forever, so `npm test` could never finish and CI would sit until it was killed
// — with no indication of which suite was stuck. Every suite therefore gets a
// wall-clock budget; on expiry the child is killed and the suite is recorded as
// a timeout (a failure), and the run moves on to the next suite.
//
// The budget is generous: the slowest suites here (the long board walks, and
// test-persistence's three server boots) run in well under a minute, while a
// genuine hang is unbounded. Override with TEST_SUITE_TIMEOUT_MS for slow CI.
const SUITE_TIMEOUT_MS = Number(process.env.TEST_SUITE_TIMEOUT_MS) || 120000;

function runSuite(file, env) {
  const full = path.join(HERE, file);
  if (!fs.existsSync(full)) {
    console.log(`\nSKIP  ${file}  (not present)`);
    return { file, status: 'skip' };
  }
  console.log(`\n${'='.repeat(64)}\n▶ ${file}\n${'='.repeat(64)}`);
  const res = spawnSync(NODE, [full], {
    cwd: HERE,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    timeout: SUITE_TIMEOUT_MS,
    // spawnSync kills the child with SIGTERM by default on timeout, but on
    // Windows that can leave the process tree (and any server it spawned)
    // alive. killSignal + a SIGKILL follow-up is the most portable way to
    // guarantee the hanging suite actually dies.
    killSignal: 'SIGKILL',
  });

  // `res.error` is set to ETIMEDOUT by spawnSync when the timeout fires, and
  // `res.signal` names the signal that killed the child. Either is proof the
  // suite did not exit on its own.
  const timedOut = !!(res.error && res.error.code === 'ETIMEDOUT') || !!res.signal;
  if (timedOut) {
    console.log(`\n✖ ${file} TIMED OUT after ${SUITE_TIMEOUT_MS}ms and was killed`);
    return { file, status: 'fail', timedOut: true };
  }

  const ok = res.status === 0;
  return { file, status: ok ? 'pass' : 'fail' };
}

// Wait until the spawned server answers its health endpoint (or give up).
function waitForServer(port, timeoutMs = 15000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const attempt = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - started > timeoutMs) resolve(false);
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

(async () => {
  const results = [];
  const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));

  // ---- self-contained suites first: they fail fast and need nothing ----
  const offlineToRun = filter ? OFFLINE_SUITES.filter((s) => s.includes(filter)) : OFFLINE_SUITES;
  for (const file of offlineToRun) {
    results.push(runSuite(file, { DATA_DIR: path.join(HERE, '.test-data') }));
  }

  if (onlyOffline || (filter && offlineToRun.length > 0 && !ONLINE_SUITES.some((s) => s.includes(filter)))) {
    return finish(results);
  }

  // ---- start a private server for the live suites ----
  console.log(`\n${'='.repeat(64)}\n▶ starting test server on :${PORT} (turn clock ${TURN_MS}ms)\n${'='.repeat(64)}`);
  const server = spawn(NODE, ['server.js'], {
    cwd: HERE,
    env: {
      ...process.env,
      PORT: String(PORT),
      TURN_TIME_LIMIT_MS: String(TURN_MS),
      // Keep restored-room files out of the developer's real data dir.
      DATA_DIR: path.join(HERE, '.test-data'),
      ALLOW_TEST_FORCED_CARD: 'true',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverOutput = '';
  server.stdout.on('data', (d) => { serverOutput += d.toString(); });
  server.stderr.on('data', (d) => { serverOutput += d.toString(); });

  const up = await waitForServer(PORT);
  if (!up) {
    console.error(`\n✖ The test server never came up on :${PORT}. Output:\n${serverOutput}`);
    server.kill();
    results.push({ file: '(test server)', status: 'fail' });
    return finish(results);
  }

  const env = {
    SERVER_URL: `http://127.0.0.1:${PORT}`,
    EXPECTED_TURN_MS: String(TURN_MS),
    EXPECTED_TTL_MS: process.env.EXPECTED_TTL_MS || '',
    DATA_DIR: path.join(HERE, '.test-data'),
  };

  const onlineToRun = filter ? ONLINE_SUITES.filter((s) => s.includes(filter)) : ONLINE_SUITES;
  for (const file of onlineToRun) {
    results.push(runSuite(file, env));
  }

  if (!keepServer) server.kill();

  finish(results);
})();

function finish(results) {
  const failed = results.filter((r) => r.status === 'fail');
  const passed = results.filter((r) => r.status === 'pass');
  const skipped = results.filter((r) => r.status === 'skip');

  console.log(`\n${'='.repeat(64)}\nSUMMARY\n${'='.repeat(64)}`);
  for (const r of results) {
    console.log(`  ${r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'SKIP'}  ${r.file}`);
  }
  console.log(`\n  ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped\n`);

  // A timeout is a failure, but say WHICH suite hung so the cause is obvious
  // rather than leaving the reader to infer it from a bare FAIL line.
  const timedOut = results.filter((r) => r.timedOut);
  if (timedOut.length) {
    console.log('  TIMED OUT (killed, treated as failed):');
    for (const r of timedOut) console.log(`    ${r.file}`);
    console.log('');
  }

  // A suite that SKIPs its live legs is not a failure, but it is not proof
  // either — say so rather than letting a silent skip read as a pass.
  if (skipped.length) {
    console.log('  NOTE: skipped suites were not exercised. Set the env they need');
    console.log('        (EXPECTED_TURN_MS / EXPECTED_TTL_MS) to run them.\n');
  }

  process.exit(failed.length === 0 ? 0 : 1);
}