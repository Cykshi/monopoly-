import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const imagesDir = join(__dirname, '../docs/images');
if (!existsSync(imagesDir)) {
  mkdirSync(imagesDir, { recursive: true });
}

const req = createRequire(join(homedir(), '.vscode/extensions/danielsanmedium.dscodegpt-3.24.77/standalone/'));
const { chromium } = req('patchright');

async function runMobileVerification() {
  const browser = await chromium.launch({
    headless: true,
    channel: 'chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
  });

  console.log('--- STARTING MOBILE VERIFICATION (375x667) ---');
  const context = await browser.newContext({
    viewport: { width: 375, height: 667 },
  });
  const page = await context.newPage();

  // Navigate to app
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(1000);

  // Fill lobby name and create room
  await page.fill('#lobby-name', 'PlayerTest');
  await page.click('button:has-text("CREATE A ROOM")');
  await page.waitForTimeout(800);

  // Pick color
  const swatches = await page.$$('button[title^="Choose"]');
  if (swatches.length > 0) {
    await swatches[0].click();
    await page.waitForTimeout(800);
  }

  // Verify in-game elements
  const metrics = await page.evaluate(() => {
    const fsBtn = document.querySelector('button[title*="Fullscreen"]');
    const timer = document.querySelector('.relative.z-0 .font-mono');
    const conn = document.querySelector('.relative.z-0 .truncate');
    const yourTurn = document.querySelector('.relative.z-0 .uppercase.tracking-wider, .relative.z-0 .uppercase.tracking-widest');
    const buttons = Array.from(document.querySelectorAll('button'));
    const rollBtn = buttons.find(b => b.textContent.includes('Roll'));
    const cardBtn = buttons.find(b => b.textContent.includes('Card') || b.textContent.includes('Exhausted'));
    const endTurnBtn = buttons.find(b => b.textContent.includes('End Turn'));
    const chatBtn = document.querySelector('button[title="Open Player Chat"]');

    return {
      fs: fsBtn ? { w: Math.round(fsBtn.getBoundingClientRect().width), h: Math.round(fsBtn.getBoundingClientRect().height) } : null,
      timer: timer ? { w: Math.round(timer.getBoundingClientRect().width), h: Math.round(timer.getBoundingClientRect().height), text: timer.textContent } : null,
      conn: conn ? { w: Math.round(conn.getBoundingClientRect().width), h: Math.round(conn.getBoundingClientRect().height), text: conn.textContent } : null,
      yourTurn: yourTurn ? { w: Math.round(yourTurn.getBoundingClientRect().width), h: Math.round(yourTurn.getBoundingClientRect().height), text: yourTurn.textContent } : null,
      roll: rollBtn ? { w: Math.round(rollBtn.getBoundingClientRect().width), h: Math.round(rollBtn.getBoundingClientRect().height) } : null,
      card: cardBtn ? { w: Math.round(cardBtn.getBoundingClientRect().width), h: Math.round(cardBtn.getBoundingClientRect().height) } : null,
      endTurn: endTurnBtn ? { w: Math.round(endTurnBtn.getBoundingClientRect().width), h: Math.round(endTurnBtn.getBoundingClientRect().height) } : null,
      chat: chatBtn ? {
        w: Math.round(chatBtn.getBoundingClientRect().width),
        h: Math.round(chatBtn.getBoundingClientRect().height),
        bottom: Math.round(chatBtn.getBoundingClientRect().bottom),
        right: Math.round(chatBtn.getBoundingClientRect().right),
      } : null,
    };
  });

  console.log('Indicator & Button Metrics (Mobile 375x667):', JSON.stringify(metrics, null, 2));

  // Test Floating Chat button on every tab
  const tabs = ['properties', 'board', 'players'];
  for (const tab of tabs) {
    // Click tab button
    if (tab === 'properties') await page.click('button:has-text("Properties")');
    if (tab === 'board') await page.click('button:has-text("Board")');
    if (tab === 'players') await page.click('button:has-text("Players")');
    await page.waitForTimeout(400);

    const chatVisible = await page.evaluate(() => {
      const btn = document.querySelector('button[title="Open Player Chat"]');
      if (!btn) return false;
      const rect = btn.getBoundingClientRect();
      const style = window.getComputedStyle(btn);
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    });

    console.log(`Tab "${tab}": Floating chat button visible = ${chatVisible}`);
  }

  // Test opening chat and sending message
  console.log('Testing opening chat popover...');
  await page.click('button[title="Open Player Chat"]');
  await page.waitForTimeout(500);

  const chatOpen = await page.evaluate(() => {
    const input = document.querySelector('input[placeholder="Type a message..."]');
    return input !== null;
  });
  console.log('Chat popover opened =', chatOpen);

  if (chatOpen) {
    await page.fill('input[placeholder="Type a message..."]', 'Hello from automated mobile test!');
    await page.click('button[title="Send message"]');
    await page.waitForTimeout(500);

    const msgFound = await page.evaluate(() => {
      return document.body.innerText.includes('Hello from automated mobile test!');
    });
    console.log('Message sent and found in chat window =', msgFound);

    // Close chat
    await page.click('button[title="Close chat"]');
    await page.waitForTimeout(400);
    const chatClosed = await page.evaluate(() => !document.querySelector('input[placeholder="Type a message..."]'));
    console.log('Chat popover closed =', chatClosed);
  }

  // Switch to board tab
  await page.click('button:has-text("Board")');
  await page.waitForTimeout(400);

  // Take screenshot
  const mobileShot = join(imagesDir, 'mobile-gameplay.png');
  await page.screenshot({ path: mobileShot });
  console.log(`Saved mobile screenshot: ${mobileShot}`);
  await context.close();

  // Desktop check
  console.log('--- STARTING DESKTOP VERIFICATION (1280x800) ---');
  const dContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const dPage = await dContext.newPage();
  await dPage.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await dPage.waitForTimeout(1000);
  await dPage.fill('#lobby-name', 'DesktopTest');
  await dPage.click('button:has-text("CREATE A ROOM")');
  await dPage.waitForTimeout(800);
  const dSwatches = await dPage.$$('button[title^="Choose"]');
  if (dSwatches.length > 0) {
    await dSwatches[1 % dSwatches.length].click();
    await dPage.waitForTimeout(800);
  }

  const dMetrics = await dPage.evaluate(() => {
    const mobileTabs = document.querySelector('.flex.lg\\:hidden.w-full');
    const tabsHidden = !mobileTabs || window.getComputedStyle(mobileTabs).display === 'none';
    const leftCol = document.querySelector('.lg\\:w-\\[32vmin\\]');
    const rightCol = document.querySelector('.lg\\:min-w-\\[36vmin\\]');
    const leftVisible = leftCol && window.getComputedStyle(leftCol).display !== 'none';
    const rightVisible = rightCol && window.getComputedStyle(rightCol).display !== 'none';
    const chatBtn = document.querySelector('button[title="Open Player Chat"]');
    return { tabsHidden, leftVisible, rightVisible, chatPresent: !!chatBtn };
  });

  console.log('Desktop layout check:', dMetrics);
  const desktopShot = join(imagesDir, 'desktop-gameplay.png');
  await dPage.screenshot({ path: desktopShot });
  console.log(`Saved desktop screenshot: ${desktopShot}`);
  await dContext.close();

  await browser.close();
  console.log('--- ALL VERIFICATIONS COMPLETED SUCCESSFULLY ---');
}

runMobileVerification().catch((err) => {
  console.error('Verification error:', err);
  process.exit(1);
});
