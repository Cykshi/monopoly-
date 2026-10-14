// ================= FRONTEND TURN STATE AUTOMATED REGRESSION SUITE =================
//
// Tests turn synchronization and UI state computation headlessly:
//   1. computeIsMyTurn identity gating & null-safety
//   2. computeTurnControls UI permission derivation
//   3. Verification that local phase string alone never grants roll permission
//   4. Initial room hydration simulation for two clients
//   5. Turn change simulation updating both clients
//   6. Reconnect state restoration simulation
//
// Run: node scripts/test-turn-state.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dynamically import or evaluate computeIsMyTurn and computeTurnControls
// Since frontend/lib/turn-state.ts is TypeScript, we transpile or evaluate it cleanly.
const turnStateSource = readFileSync(join(__dirname, '../frontend/lib/turn-state.ts'), 'utf8');

// Strip TypeScript type annotations to evaluate as standard JavaScript
const jsSource = turnStateSource
  .replace(/export interface[\s\S]*?}\n/g, '')
  .replace(/export function /g, 'function ')
  .replace(/: boolean/g, '')
  .replace(/: string \| null/g, '')
  .replace(/: number \| null \| undefined/g, '')
  .replace(/: number \| null/g, '')
  .replace(/: TurnControlsParams/g, '')
  .replace(/: TurnControlsResult/g, '') + '\nexports.computeIsMyTurn = computeIsMyTurn; exports.computeTurnControls = computeTurnControls;';

const moduleExports = {};
const fn = new Function('exports', jsSource);
fn(moduleExports);
const { computeIsMyTurn, computeTurnControls } = moduleExports;

const results = [];
let failed = 0;

function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

console.log('=== FRONTEND TURN STATE AUTOMATED REGRESSION TESTS ===\n');

// ================= 1. computeIsMyTurn GATING =================
console.log('--- 1. computeIsMyTurn GATING & IDENTITY SAFETY ---');

check('no room -> isMyTurn is false',
  computeIsMyTurn(null, 1, 1) === false);

check('missing myPlayerId (null) -> isMyTurn is false (loading/unidentified socket never gets turn)',
  computeIsMyTurn('ABCDEF', null, 1) === false);

check('missing currentTurnPlayerId (null) -> isMyTurn is false',
  computeIsMyTurn('ABCDEF', 1, null) === false);

check('missing currentTurnPlayerId (undefined) -> isMyTurn is false',
  computeIsMyTurn('ABCDEF', 1, undefined) === false);

check('guest player 2 when it is player 1 turn -> isMyTurn is false',
  computeIsMyTurn('ABCDEF', 2, 1) === false);

check('host player 1 when it is player 1 turn -> isMyTurn is true',
  computeIsMyTurn('ABCDEF', 1, 1) === true);

check('guest player 2 when it is player 2 turn -> isMyTurn is true',
  computeIsMyTurn('ABCDEF', 2, 2) === true);

check('host player 1 when it is player 2 turn -> isMyTurn is false',
  computeIsMyTurn('ABCDEF', 1, 2) === false);


// ================= 2. NON-ACTIVE PLAYER WAITING STATE =================
console.log('\n--- 2. NON-ACTIVE PLAYER WAITING STATE & PERMISSION GATING ---');

// Critical test: local gamePhase is "YOUR TURN", but isMyTurn is false
const inactiveWithYourTurnPhase = computeTurnControls({
  isMyTurn: false,
  gamePhase: 'YOUR TURN',
  isRolling: false,
  isMoving: false,
  currentPlayerName: 'AliceHost',
  currentPlayerId: 1,
});

check('non-active player NEVER sees Roll button (even if gamePhase === "YOUR TURN")',
  inactiveWithYourTurnPhase.showRollButton === false);

check('non-active player CANNOT roll (canRoll === false)',
  inactiveWithYourTurnPhase.canRoll === false);

check('non-active player shows waiting state (showWaitingState === true)',
  inactiveWithYourTurnPhase.showWaitingState === true);

check('waiting state text names the active player',
  inactiveWithYourTurnPhase.waitingText === '⏳ Waiting for AliceHost...',
  inactiveWithYourTurnPhase.waitingText);

check('status badge displays WAITING FOR <ACTIVE_PLAYER>',
  inactiveWithYourTurnPhase.badgeText === 'WAITING FOR ALICEHOST',
  inactiveWithYourTurnPhase.badgeText);

// When active player is rolling, inactive player sees rolling indicator
const inactiveWhilePeerRolling = computeTurnControls({
  isMyTurn: false,
  gamePhase: 'YOUR TURN',
  isRolling: true,
  isMoving: false,
  currentPlayerName: 'AliceHost',
  currentPlayerId: 1,
});
check('inactive player sees "🎲 Rolling..." when active peer is rolling',
  inactiveWhilePeerRolling.waitingText === '🎲 Rolling...' && inactiveWhilePeerRolling.badgeText === 'ROLLING...',
  `waitingText=${inactiveWhilePeerRolling.waitingText}, badgeText=${inactiveWhilePeerRolling.badgeText}`);

// When active player is moving, inactive player sees moving indicator
const inactiveWhilePeerMoving = computeTurnControls({
  isMyTurn: false,
  gamePhase: 'YOUR TURN',
  isRolling: false,
  isMoving: true,
  currentPlayerName: 'AliceHost',
  currentPlayerId: 1,
});
check('inactive player sees "🚶 Moving..." when active peer is moving',
  inactiveWhilePeerMoving.waitingText === '🚶 Moving...' && inactiveWhilePeerMoving.badgeText === 'MOVING...',
  `waitingText=${inactiveWhilePeerMoving.waitingText}, badgeText=${inactiveWhilePeerMoving.badgeText}`);


// ================= 3. ACTIVE PLAYER CONTROLS =================
console.log('\n--- 3. ACTIVE PLAYER CONTROLS THROUGH TURN LIFECYCLE ---');

// Phase 1: Before roll
const activeBeforeRoll = computeTurnControls({
  isMyTurn: true,
  gamePhase: 'YOUR TURN',
  isRolling: false,
  isMoving: false,
  currentPlayerName: 'AliceHost',
  currentPlayerId: 1,
});
check('active player sees Roll button', activeBeforeRoll.showRollButton === true);
check('active player Roll button is enabled (canRoll === true)', activeBeforeRoll.canRoll === true);
check('active player does not see waiting state', activeBeforeRoll.showWaitingState === false);
check('active player badge is "YOUR TURN"', activeBeforeRoll.badgeText === 'YOUR TURN');

// Phase 2: Rolling in progress
const activeRolling = computeTurnControls({
  isMyTurn: true,
  gamePhase: 'ROLLING...',
  isRolling: true,
  isMoving: false,
  currentPlayerName: 'AliceHost',
  currentPlayerId: 1,
});
check('active player Roll button is disabled while rolling', activeRolling.canRoll === false);
check('active player badge is "ROLLING..."', activeRolling.badgeText === 'ROLLING...');

// Phase 3: Moving in progress
const activeMoving = computeTurnControls({
  isMyTurn: true,
  gamePhase: 'MOVING...',
  isRolling: false,
  isMoving: true,
  currentPlayerName: 'AliceHost',
  currentPlayerId: 1,
});
check('active player Roll button is disabled while moving', activeMoving.canRoll === false);
check('active player badge is "MOVING..."', activeMoving.badgeText === 'MOVING...');

// Phase 4: Action / End turn
const activeAction = computeTurnControls({
  isMyTurn: true,
  gamePhase: 'ACTION',
  isRolling: false,
  isMoving: false,
  currentPlayerName: 'AliceHost',
  currentPlayerId: 1,
});
check('active player switches from Roll button to End Turn button on ACTION phase',
  activeAction.showRollButton === false && activeAction.showEndTurnButton === true);
check('active player can end turn', activeAction.canEndTurn === true);
check('active player badge is "ACTION"', activeAction.badgeText === 'ACTION');

// Game Over state
const activeGameOver = computeTurnControls({
  isMyTurn: true,
  gamePhase: 'YOUR TURN',
  isRolling: false,
  isMoving: false,
  hasWinner: true,
});
check('active player cannot roll if game has a winner', activeGameOver.canRoll === false);


// ================= 4. MULTIPLAYER TWO-CLIENT LIFECYCLE SIMULATION =================
console.log('\n--- 4. TWO-CLIENT LIFECYCLE: HYDRATION -> TURN CHANGE -> RECONNECT ---');

const roomId = 'ROOM99';

// Client 1 (Host Alice, seat 1) and Client 2 (Guest Bob, seat 2)
let client1 = { myPlayerId: null, currentTurnPlayerId: 1, gamePhase: 'YOUR TURN', name: 'AliceHost' };
let client2 = { myPlayerId: null, currentTurnPlayerId: 1, gamePhase: 'YOUR TURN', name: 'BobGuest' };

// Step 4.1: Initial Hydration
// Host identifies as 1
client1.myPlayerId = 1;
// Guest has not identified yet (loading)
let c1Turn = computeIsMyTurn(roomId, client1.myPlayerId, client1.currentTurnPlayerId);
let c2Turn = computeIsMyTurn(roomId, client2.myPlayerId, client2.currentTurnPlayerId);
check('initial hydration: host is active', c1Turn === true);
check('initial hydration: guest with null identity is NOT active', c2Turn === false);

// Guest identifies as 2
client2.myPlayerId = 2;
c2Turn = computeIsMyTurn(roomId, client2.myPlayerId, client2.currentTurnPlayerId);
check('initial hydration: guest identified as player 2 is still NOT active (waiting for host)', c2Turn === false);

let c1Controls = computeTurnControls({ isMyTurn: c1Turn, gamePhase: client1.gamePhase, isRolling: false, isMoving: false, currentPlayerName: client1.name });
let c2Controls = computeTurnControls({ isMyTurn: c2Turn, gamePhase: client2.gamePhase, isRolling: false, isMoving: false, currentPlayerName: client1.name });
check('simulated UI: host sees enabled Roll button', c1Controls.showRollButton === true && c1Controls.canRoll === true);
check('simulated UI: guest sees waiting state', c2Controls.showWaitingState === true && c2Controls.showRollButton === false);

// Step 4.2: Turn Changes to Player 2
// Server broadcasts turn:changed with currentTurnPlayerId: 2
const newTurnId = 2;
client1.currentTurnPlayerId = newTurnId;
client2.currentTurnPlayerId = newTurnId;
client1.gamePhase = 'YOUR TURN';
client2.gamePhase = 'YOUR TURN';

c1Turn = computeIsMyTurn(roomId, client1.myPlayerId, client1.currentTurnPlayerId);
c2Turn = computeIsMyTurn(roomId, client2.myPlayerId, client2.currentTurnPlayerId);

check('turn changed: host is now inactive', c1Turn === false);
check('turn changed: guest is now active', c2Turn === true);

c1Controls = computeTurnControls({ isMyTurn: c1Turn, gamePhase: client1.gamePhase, isRolling: false, isMoving: false, currentPlayerName: client2.name });
c2Controls = computeTurnControls({ isMyTurn: c2Turn, gamePhase: client2.gamePhase, isRolling: false, isMoving: false, currentPlayerName: client2.name });
check('turn changed UI: host now sees waiting state', c1Controls.showWaitingState === true && c1Controls.showRollButton === false);
check('turn changed UI: guest now sees enabled Roll button', c2Controls.showRollButton === true && c2Controls.canRoll === true);

// Step 4.3: Guest Reconnects Mid-Turn
// Rejoin payload delivers me.id = 2 and currentTurnPlayerId = 2
const reconnectedGuest = { myPlayerId: 2, currentTurnPlayerId: 2, gamePhase: 'YOUR TURN' };
const reconnectedTurn = computeIsMyTurn(roomId, reconnectedGuest.myPlayerId, reconnectedGuest.currentTurnPlayerId);
const reconnectedControls = computeTurnControls({ isMyTurn: reconnectedTurn, gamePhase: reconnectedGuest.gamePhase, isRolling: false, isMoving: false });
check('reconnected active player restores active turn state', reconnectedTurn === true);
check('reconnected active player sees enabled Roll button', reconnectedControls.showRollButton === true && reconnectedControls.canRoll === true);

console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
