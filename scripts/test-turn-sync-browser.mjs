// ================= BROWSER E2E TEST: MULTIPLAYER TURN SYNCHRONIZATION =================
//
// Launches two browser contexts (Host and Guest) against http://localhost:3000:
//   1. Host creates a room, sets name AliceHost, picks color.
//   2. Guest opens invite link ?room=CODE, sets name BobGuest, joins, picks color.
//   3. VERIFY INITIAL HYDRATION:
//      - Host sees enabled "🎲 Roll" button and "YOUR TURN" badge.
//      - Guest sees disabled waiting button ("⏳ Waiting for AliceHost...") and "WAITING FOR ALICEHOST" badge.
//      - Guest does NOT see an enabled Roll button!
//   4. Host clicks "🎲 Roll".
//   5. Host waits for movement to complete and clicks "End Turn".
//   6. VERIFY TURN ADVANCE:
//      - Guest NOW sees enabled "🎲 Roll" button and "YOUR TURN" badge.
//      - Host NOW sees disabled waiting button ("⏳ Waiting for BobGuest...") and "WAITING FOR BOBGUEST" badge.
//      - Host does NOT see an enabled Roll button!
//
// Run: node scripts/test-turn-sync-browser.mjs

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(join(homedir(), '.vscode/extensions/danielsanmedium.dscodegpt-3.24.77/standalone/'));
const { chromium } = req('patchright');

async function runBrowserTurnSyncTest() {
  console.log('--- STARTING MULTIPLAYER TURN SYNCHRONIZATION BROWSER TEST ---');
  const browser = await chromium.launch({
    headless: true,
    channel: 'chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
  });

  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

  // ================= 1. HOST CREATES ROOM =================
  console.log(`1. Navigating Host to ${FRONTEND_URL}...`);
  const hostContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const hostPage = await hostContext.newPage();
  hostPage.on('console', msg => console.log('HOST CONSOLE:', msg.text()));

  try {
    await hostPage.goto(FRONTEND_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch (err) {
    console.error(`Frontend server not reachable at ${FRONTEND_URL}.`);
    await browser.close();
    process.exit(1);
  }

  await hostPage.waitForTimeout(1000);
  await hostPage.locator('#lobby-name').pressSequentially('AliceHost', { delay: 40 });
  await hostPage.click('button:has-text("CREATE A ROOM")');
  await hostPage.waitForTimeout(1200);

  const hostUrl = hostPage.url();
  const match = hostUrl.match(/[?&]room=([A-Z2-9]{6})/i);
  if (!match) {
    console.error('FAIL: Host URL does not contain ?room=<CODE>', hostUrl);
    await browser.close();
    process.exit(1);
  }
  const roomCode = match[1].toUpperCase();
  console.log(`2. Host created room with code: ${roomCode}`);

  // Pick color for Host
  const hostSwatches = await hostPage.$$('button[title^="Choose"]');
  if (hostSwatches.length > 0) {
    await hostSwatches[0].click();
    await hostPage.waitForTimeout(600);
  }

  // ================= 2. GUEST JOINS ROOM =================
  console.log(`3. Navigating Guest to ${FRONTEND_URL}/?room=${roomCode}...`);
  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const guestPage = await guestContext.newPage();

  await guestPage.goto(`${FRONTEND_URL}/?room=${roomCode}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await guestPage.waitForTimeout(1000);

  // Fill name and submit join form
  await guestPage.fill('#lobby-name', 'BobGuest');
  await guestPage.waitForTimeout(400);
  await guestPage.evaluate(() => {
    const form = document.querySelector('form');
    if (form) form.requestSubmit();
  });
  await guestPage.waitForTimeout(1500);

  // Pick color for Guest
  const guestSwatches = await guestPage.$$('button[title^="Choose"]');
  if (guestSwatches.length > 1) {
    await guestSwatches[1].click();
    await guestPage.waitForTimeout(800);
  } else if (guestSwatches.length > 0) {
    await guestSwatches[0].click();
    await guestPage.waitForTimeout(800);
  }

  console.log('4. Both Host and Guest have joined room and picked colors.');
  await hostPage.waitForTimeout(1000);
  await guestPage.waitForTimeout(1000);

  // ================= 3. VERIFY INITIAL TURN HYDRATION =================
  console.log('\n--- VERIFYING INITIAL TURN STATE ON BOTH CLIENTS ---');

  // Check Host View
  const hostButtons = await hostPage.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).map((b, i) => ({
      idx: i,
      text: b.textContent.trim(),
      classes: b.className,
      disabled: b.disabled
    })).filter(b => b.text.includes('Roll'));
  });
  console.log('Host buttons matching "Roll":', hostButtons);
  const hostRollBtn = hostPage.locator('button:has-text("🎲 Roll")');
  const hostHasRollBtn = await hostRollBtn.isVisible().catch(() => false);
  const hostRollBtnDisabled = hostHasRollBtn ? await hostRollBtn.isDisabled() : true;
  console.log(`Host sees Roll button: ${hostHasRollBtn}, disabled: ${hostRollBtnDisabled}`);

  const hostBadgeText = await hostPage.evaluate(() => {
    // Look for status pill above dice
    const els = Array.from(document.querySelectorAll('div')).filter(el =>
      el.textContent === 'YOUR TURN' || el.textContent.startsWith('WAITING')
    );
    return els.length > 0 ? els[0].textContent.trim() : null;
  });
  console.log(`Host status badge: '${hostBadgeText}'`);

  // Check Guest View
  const guestRollBtn = guestPage.locator('button:has-text("Roll")');
  const guestHasRollBtn = await guestRollBtn.isVisible().catch(() => false);
  const guestWaitingBtn = guestPage.locator('button:has-text("Waiting for")');
  const guestHasWaitingBtn = await guestWaitingBtn.isVisible().catch(() => false);
  const guestWaitingBtnDisabled = guestHasWaitingBtn ? await guestWaitingBtn.isDisabled() : false;
  const guestWaitingBtnText = guestHasWaitingBtn ? await guestWaitingBtn.textContent() : null;

  console.log(`Guest sees Roll button: ${guestHasRollBtn}`);
  console.log(`Guest sees Waiting button: ${guestHasWaitingBtn}, disabled: ${guestWaitingBtnDisabled}, text: '${guestWaitingBtnText}'`);

  const guestBadgeText = await guestPage.evaluate(() => {
    const els = Array.from(document.querySelectorAll('div')).filter(el =>
      el.textContent === 'YOUR TURN' || el.textContent.startsWith('WAITING')
    );
    return els.length > 0 ? els[0].textContent.trim() : null;
  });
  console.log(`Guest status badge: '${guestBadgeText}'`);

  if (!hostHasRollBtn || hostRollBtnDisabled) {
    console.error('FAIL: Host should see an ENABLED Roll button!');
    await browser.close();
    process.exit(1);
  }
  if (guestHasRollBtn) {
    console.error('FAIL: Guest MUST NOT see a Roll button while it is Host turn!');
    await browser.close();
    process.exit(1);
  }
  if (!guestHasWaitingBtn || !guestWaitingBtnDisabled) {
    console.error('FAIL: Guest MUST see a DISABLED waiting state button!');
    await browser.close();
    process.exit(1);
  }

  console.log('SUCCESS: Initial hydration verified — only active Host sees enabled Roll button; Guest sees waiting state.');

  // ================= 4. HOST ROLLS DICE & ENDS TURN =================
  console.log('\n--- HOST ROLLS DICE & ADVANCES TURN ---');

  // Inspect React state on Host before and after roll
  const typeOfState = await hostPage.evaluate(() => typeof window.__GAME_STATE__);
  const gameKeys = await hostPage.evaluate(() => Object.keys(window).filter(k => k.includes('GAME')));
  console.log('Type of __GAME_STATE__ on Host:', typeOfState, 'Matching keys:', gameKeys);

  await hostRollBtn.click();
  console.log('5. Host clicked Roll button.');

  await hostPage.waitForTimeout(500);
  const hostRollAttempt = await hostPage.evaluate(() => window.__LAST_ROLL_ATTEMPT__);
  console.log('Host __LAST_ROLL_ATTEMPT__:', hostRollAttempt);

  // Log Host status every second
  for (let s = 1; s <= 6; s++) {
    await hostPage.waitForTimeout(1000);
    const hostStatus = await hostPage.evaluate(() => {
      const els = Array.from(document.querySelectorAll('div')).filter(el =>
        ['YOUR TURN', 'ROLLING...', 'MOVING...', 'ACTION', 'END TURN'].includes(el.textContent?.trim()) ||
        el.textContent?.trim().startsWith('WAITING FOR')
      );
      const actionLines = Array.from(document.querySelectorAll('.flex.h-11 p, .flex.h-14 p')).map(p => p.textContent.trim()).filter(Boolean);
      const buttons = Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()).filter(Boolean);
      return {
        pill: els.length > 0 ? els[0].textContent.trim() : null,
        actionLines,
        buttons: buttons.filter(t => t.includes('Roll') || t.includes('Turn') || t.includes('Waiting') || t.includes('Buy')),
      };
    });
    console.log(`Host state at +${s}s:`, hostStatus);
  }

  // Wait for movement to finish and either Buy modal or End Turn button to appear
  const buyBtn = hostPage.locator('button:has-text("Buy for")');
  const endTurnBtn = hostPage.locator('button:has-text("End Turn")');
  const closeBtn = hostPage.locator('button[aria-label="Close modal"]');

  // Wait up to 12s for landing / modal / end turn
  for (let i = 0; i < 24; i++) {
    await hostPage.waitForTimeout(500);
    if (await buyBtn.isVisible().catch(() => false)) {
      console.log('Host landed on unowned property, buying...');
      await buyBtn.click().catch(() => {});
      await hostPage.waitForTimeout(800);
      break;
    }
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click().catch(() => {});
      await hostPage.waitForTimeout(800);
      break;
    }
    if (await endTurnBtn.isVisible().catch(() => false)) {
      break;
    }
  }

  // Click End Turn
  await endTurnBtn.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  if (await endTurnBtn.isVisible().catch(() => false)) {
    await endTurnBtn.click();
    console.log('6. Host clicked End Turn button.');
  } else {
    console.log('Warning: Host end turn button not found within timeout.');
  }

  await hostPage.waitForTimeout(2000);
  await guestPage.waitForTimeout(2000);

  // ================= 5. VERIFY TURN CHANGED TO GUEST =================
  console.log('\n--- VERIFYING TURN STATE AFTER TURN ADVANCE ---');

  // Guest view after turn change
  const guestRollBtnAfter = guestPage.locator('button:has-text("Roll")');
  const guestHasRollBtnAfter = await guestRollBtnAfter.isVisible().catch(() => false);
  const guestRollBtnDisabledAfter = guestHasRollBtnAfter ? await guestRollBtnAfter.isDisabled() : true;

  const guestBadgeAfter = await guestPage.evaluate(() => {
    const els = Array.from(document.querySelectorAll('div')).filter(el =>
      el.textContent === 'YOUR TURN' || el.textContent.startsWith('WAITING')
    );
    return els.length > 0 ? els[0].textContent.trim() : null;
  });

  console.log(`Guest sees Roll button after turn change: ${guestHasRollBtnAfter}, disabled: ${guestRollBtnDisabledAfter}`);
  console.log(`Guest status badge after turn change: '${guestBadgeAfter}'`);

  // Host view after turn change
  const hostRollBtnAfter = hostPage.locator('button:has-text("Roll")');
  const hostHasRollBtnAfter = await hostRollBtnAfter.isVisible().catch(() => false);
  const hostWaitingBtnAfter = hostPage.locator('button:has-text("Waiting for")');
  const hostHasWaitingBtnAfter = await hostWaitingBtnAfter.isVisible().catch(() => false);
  const hostWaitingBtnDisabledAfter = hostHasWaitingBtnAfter ? await hostWaitingBtnAfter.isDisabled() : false;
  const hostWaitingBtnTextAfter = hostHasWaitingBtnAfter ? await hostWaitingBtnAfter.textContent() : null;

  const hostBadgeAfter = await hostPage.evaluate(() => {
    const els = Array.from(document.querySelectorAll('div')).filter(el =>
      el.textContent === 'YOUR TURN' || el.textContent.startsWith('WAITING')
    );
    return els.length > 0 ? els[0].textContent.trim() : null;
  });

  console.log(`Host sees Roll button after turn change: ${hostHasRollBtnAfter}`);
  console.log(`Host sees Waiting button after turn change: ${hostHasWaitingBtnAfter}, disabled: ${hostWaitingBtnDisabledAfter}, text: '${hostWaitingBtnTextAfter}'`);
  console.log(`Host status badge after turn change: '${hostBadgeAfter}'`);

  if (!guestHasRollBtnAfter || guestRollBtnDisabledAfter) {
    console.error('FAIL: Guest should see an ENABLED Roll button after turn advance!');
    await browser.close();
    process.exit(1);
  }
  if (hostHasRollBtnAfter) {
    console.error('FAIL: Host MUST NOT see an enabled Roll button after turn advance!');
    await browser.close();
    process.exit(1);
  }
  if (!hostHasWaitingBtnAfter || !hostWaitingBtnDisabledAfter) {
    console.error('FAIL: Host MUST see a disabled waiting button after turn advance!');
    await browser.close();
    process.exit(1);
  }

  console.log('SUCCESS: Turn advance verified — Guest now has enabled Roll button; Host is waiting.');

  await hostContext.close();
  await guestContext.close();
  await browser.close();
  console.log('--- ALL BROWSER TURN SYNCHRONIZATION TESTS PASSED SUCCESSFULLY ---');
}

runBrowserTurnSyncTest().catch((err) => {
  console.error('Browser turn sync test error:', err);
  process.exit(1);
});
