// Unit tests for the pure movement helpers in backend/game/turns.js.
//
// These are OFFLINE: no server, no sockets. They pin the movement CONTRACT that
// the module's comments now claim, so the comments cannot drift from the code
// again:
//
//   * `steps` must be an integer — NaN, Infinity, strings and fractions are
//     rejected rather than silently coerced or producing NaN positions.
//   * `steps` is bounded to +/- 4 laps of the board.
//   * the resulting position is derived from the SERVER's copy of the player's
//     position and wrapped into range, so it can never leave the board.
//   * the GO salary is credited on the server side, once, on crossing.
//   * jail state is NOT touched (the module makes no jail claim any more).
const assert = require('assert');
const path = require('path');

const turns = require(path.join(__dirname, 'game', 'turns'));
const board = require(path.join(__dirname, 'game', 'board'));

const BOARD = board.BOARD_SIZE; // 40
let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}  -> ${err.message}`);
  }
}

const mkPlayer = (position = 0, money = 1500) => ({ id: 1, position, money });

// ---- accepted movement ----------------------------------------------------

check('steps = 0 leaves the player where they are', () => {
  const p = mkPlayer(5);
  const res = turns.applyMovement({}, p, 0, BOARD);
  assert.strictEqual(res.ok, true, 'should be accepted');
  assert.strictEqual(p.position, 5, 'position must not change');
  assert.strictEqual(res.passedGo, false);
});

check('steps = 1 advances exactly one square', () => {
  const p = mkPlayer(5);
  const res = turns.applyMovement({}, p, 1, BOARD);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(p.position, 6);
});

check('a normal dice roll (12) advances by 12', () => {
  const p = mkPlayer(3);
  const res = turns.applyMovement({}, p, 12, BOARD);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(p.position, 15);
  assert.strictEqual(res.passedGo, false);
});

check('negative movement is supported and moves backwards', () => {
  const p = mkPlayer(10);
  const res = turns.applyMovement({}, p, -4, BOARD);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(p.position, 6);
});

check('backwards past the start wraps to the end of the board', () => {
  const p = mkPlayer(2);
  const res = turns.applyMovement({}, p, -5, BOARD);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(p.position, BOARD - 3);
  assert.ok(p.position >= 0 && p.position < BOARD, 'must stay on the board');
});

// ---- wrap + GO ------------------------------------------------------------

check('movement past the last square wraps to the start', () => {
  const p = mkPlayer(BOARD - 2);
  const res = turns.applyMovement({}, p, 5, BOARD);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(p.position, 3);
  assert.strictEqual(res.passedGo, true, 'crossing the end passes GO');
});

check('landing exactly on START (position 0) passes GO', () => {
  const p = mkPlayer(BOARD - 4);
  const res = turns.applyMovement({}, p, 4, BOARD);
  assert.strictEqual(p.position, 0);
  assert.strictEqual(res.passedGo, true);
});

check('crossing GO credits the salary exactly once, server-side', () => {
  const p = mkPlayer(BOARD - 1, 1000);
  const res = turns.applyMovement({}, p, 2, BOARD);
  assert.strictEqual(res.salary, turns.SALARY);
  assert.strictEqual(p.money, 1000 + turns.SALARY, 'salary must be applied once');
});

// ===== THE TWO SALARY CONSTANTS MUST AGREE =====
// There are two names for one rule: `turns.SALARY` (used by this module) and
// `board.PASS_START_BONUS` (the board's economy table, and what the live server
// now credits in its player:moved handler). They are separate literals, so a
// change to one would silently disagree with the other — whichever path ran would
// pay a different amount. Pin them together here so the drift fails loudly.
check('turns.SALARY agrees with board.PASS_START_BONUS', () => {
  assert.strictEqual(turns.SALARY, board.PASS_START_BONUS,
    `turns.SALARY=${turns.SALARY} but board.PASS_START_BONUS=${board.PASS_START_BONUS}`);
});

check('not crossing GO credits nothing', () => {
  const p = mkPlayer(1, 1000);
  const res = turns.applyMovement({}, p, 3, BOARD);
  assert.strictEqual(res.salary, undefined);
  assert.strictEqual(p.money, 1000);
});

// ---- rejected movement ----------------------------------------------------

const rejected = [
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['a string', '5'],
  ['a numeric string', '5'],
  ['undefined', undefined],
  ['null', null],
  ['a fraction', 3.5],
  ['a boolean', true],
  ['an object', {}],
  ['an array', [5]],
  ['excessively large', BOARD * 5],
  ['excessively negative', -BOARD * 5],
];

for (const [label, value] of rejected) {
  check(`rejects ${label} movement`, () => {
    const p = mkPlayer(5, 1500);
    const res = turns.applyMovement({}, p, value, BOARD);
    assert.strictEqual(res.ok, false, `should reject, got ${JSON.stringify(res)}`);
    assert.strictEqual(res.code, 'INVALID_STEPS');
    // The crucial part: a rejected move must not mutate the player at all.
    assert.strictEqual(p.position, 5, 'position must be untouched');
    assert.strictEqual(p.money, 1500, 'money must be untouched');
  });
}

check('rejects a nonsensical board size rather than producing NaN', () => {
  const p = mkPlayer(5);
  const res = turns.applyMovement({}, p, 3, 0);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'INVALID_BOARD');
  assert.strictEqual(p.position, 5);
});

// ---- position can never leave the board -----------------------------------

check('the resulting position is always a valid board index', () => {
  for (let start = 0; start < BOARD; start++) {
    for (const steps of [0, 1, 5, 12, BOARD - 1, BOARD, BOARD + 7, -1, -BOARD, -BOARD - 3]) {
      const p = mkPlayer(start);
      const res = turns.applyMovement({}, p, steps, BOARD);
      assert.strictEqual(res.ok, true, `steps=${steps} from ${start} should be allowed`);
      assert.ok(
        Number.isInteger(p.position) && p.position >= 0 && p.position < BOARD,
        `steps=${steps} from ${start} produced ${p.position}`
      );
    }
  }
});

// ---- jail is NOT touched --------------------------------------------------

check('movement does not read or write any jail field', () => {
  const p = mkPlayer(5);
  // A caller's own jail bookkeeping must survive a move untouched, because this
  // module makes no jail claim and must not silently clear one.
  p.inJail = true;
  p.jailTurns = 2;
  turns.applyMovement({}, p, 3, BOARD);
  assert.strictEqual(p.inJail, true, 'inJail must be preserved');
  assert.strictEqual(p.jailTurns, 2, 'jailTurns must be preserved');
});

// ---- money guards ---------------------------------------------------------

check('creditPlayer rejects NaN, Infinity, negatives and fractions', () => {
  for (const bad of [NaN, Infinity, -Infinity, -5, 1.5, '10', null, undefined]) {
    const p = mkPlayer(0, 100);
    assert.strictEqual(turns.creditPlayer(p, bad, 'test'), false, `should reject ${bad}`);
    assert.strictEqual(p.money, 100, `money must be untouched for ${bad}`);
  }
});

check('creditPlayer accepts zero (a valid amount)', () => {
  const p = mkPlayer(0, 100);
  assert.strictEqual(turns.creditPlayer(p, 0, 'zero'), true);
  assert.strictEqual(p.money, 100, 'crediting 0 must not change the balance');
});

check('the ledger is bounded', () => {
  const p = mkPlayer(0, 100);
  for (let i = 0; i < 250; i++) turns.creditPlayer(p, 1, `entry-${i}`);
  assert.ok(p.ledger.length <= 100, `ledger should be capped, got ${p.ledger.length}`);
});

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);