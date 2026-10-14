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

async function testAllViewports() {
  const viewports = [
    { width: 320, height: 568, name: '320px' },
    { width: 360, height: 740, name: '360px' },
    { width: 375, height: 667, name: '375px' },
    { width: 390, height: 844, name: '390px' },
    { width: 414, height: 896, name: '414px' },
    { width: 768, height: 1024, name: 'tablet-768px' },
    { width: 1280, height: 800, name: 'desktop-1280px' },
    { width: 1920, height: 1080, name: 'desktop-1920px' },
  ];

  const browser = await chromium.launch({
    headless: true,
    channel: 'chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
  });

  for (const vp of viewports) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    const consoleMsgs = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleMsgs.push(m.text());
    });

    await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(800);

    // Test 1: Lobby modal & page overflow
    const lobbyTest = await page.evaluate(() => {
      const docW = document.documentElement.scrollWidth;
      const winW = window.innerWidth;
      const bodyW = document.body.scrollWidth;
      const modal = document.querySelector('.fixed.inset-0 > div');
      const modalRect = modal ? modal.getBoundingClientRect() : null;
      return {
        docW,
        winW,
        hasDocScroll: docW > winW || bodyW > winW,
        modalW: modalRect ? Math.round(modalRect.width) : 0,
        modalH: modalRect ? Math.round(modalRect.height) : 0,
        modalFitsX: modalRect ? modalRect.width <= winW : true,
        modalFitsY: modalRect ? modalRect.height <= window.innerHeight : true,
      };
    });

    // Test 2: Enter name, create room, pick color
    await page.fill('#lobby-name', 'Sakshi');
    await page.click('button:has-text("CREATE A ROOM")');
    await page.waitForTimeout(800);

    // Check color picker modal
    const colorPickerCheck = await page.evaluate(() => {
      const modal = document.querySelector('.fixed.inset-0 > div');
      const modalRect = modal ? modal.getBoundingClientRect() : null;
      return {
        hasModal: !!modal,
        fitsX: modalRect ? modalRect.width <= window.innerWidth : true,
        fitsY: modalRect ? modalRect.height <= window.innerHeight : true,
        size: modalRect ? `${Math.round(modalRect.width)}x${Math.round(modalRect.height)}` : 'none',
      };
    });

    // Pick first available color swatch
    const colorSwatches = await page.$$('button[title^="Choose"]');
    if (colorSwatches.length > 0) {
      await colorSwatches[0].click();
      await page.waitForTimeout(800);
    }

    // Now in-game!
    const inGameTest = await page.evaluate(() => {
      const docW = document.documentElement.scrollWidth;
      const winW = window.innerWidth;
      const bodyW = document.body.scrollWidth;

      const elements = Array.from(document.querySelectorAll('*'));
      const overflowing = [];
      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && (rect.right > winW + 1 || rect.left < -1)) {
          overflowing.push({
            tag: el.tagName,
            cls: (el.className || '').toString().slice(0, 50),
            rect: { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) }
          });
        }
      }

      const mobileTabs = document.querySelector('.flex.lg\\:hidden.w-full');
      const mobileTabsVisible = mobileTabs ? getComputedStyle(mobileTabs).display !== 'none' : false;

      const board = document.querySelector('.aspect-square');
      const boardRect = board ? board.getBoundingClientRect() : null;

      const centerConsole = document.querySelector('.relative.z-0');
      const consoleRect = centerConsole ? centerConsole.getBoundingClientRect() : null;

      // Check center console elements overlapping
      const fsBtn = document.querySelector('button[title*="Fullscreen"]');
      const turnTimer = centerConsole ? centerConsole.querySelector('.font-mono') : null;
      const connBadge = centerConsole ? centerConsole.querySelector('.truncate') : null;

      const fsRect = fsBtn ? fsBtn.getBoundingClientRect() : null;
      const timerRect = turnTimer ? turnTimer.getBoundingClientRect() : null;
      const connRect = connBadge ? connBadge.getBoundingClientRect() : null;

      const topRowOverlap = fsRect && timerRect && connRect ? {
        fsRight: Math.round(fsRect.right),
        timerLeft: Math.round(timerRect.left),
        timerRight: Math.round(timerRect.right),
        connLeft: Math.round(connRect.left),
        fsOverlapsTimer: fsRect.right > timerRect.left,
        timerOverlapsConn: timerRect.right > connRect.left,
      } : null;

      return {
        docW,
        winW,
        hasDocScroll: docW > winW || bodyW > winW,
        overflowingCount: overflowing.length,
        overflowingSample: overflowing.slice(0, 3),
        mobileTabsVisible,
        boardWidth: boardRect ? Math.round(boardRect.width) : 0,
        boardHeight: boardRect ? Math.round(boardRect.height) : 0,
        consoleWidth: consoleRect ? Math.round(consoleRect.width) : 0,
        consoleHeight: consoleRect ? Math.round(consoleRect.height) : 0,
        topRowOverlap,
      };
    });

    // Take screenshot for visual inspection on 375px
    if (vp.width === 375) {
      await page.screenshot({ path: join(imagesDir, 'screenshot-375.png') });
    }

    console.log(`=== VIEWPORT: ${vp.name} (${vp.width}x${vp.height}) ===`);
    console.log(`  Lobby: DocScroll=${lobbyTest.hasDocScroll}, Modal FitsX=${lobbyTest.modalFitsX}, FitsY=${lobbyTest.modalFitsY} (${lobbyTest.modalW}x${lobbyTest.modalH})`);
    console.log(`  ColorPicker: FitsX=${colorPickerCheck.fitsX}, FitsY=${colorPickerCheck.fitsY} (${colorPickerCheck.size})`);
    console.log(`  In-Game: DocScroll=${inGameTest.hasDocScroll}, Board=${inGameTest.boardWidth}x${inGameTest.boardHeight}, Console=${inGameTest.consoleWidth}x${inGameTest.consoleHeight}, MobileTabsVisible=${inGameTest.mobileTabsVisible}`);
    if (inGameTest.topRowOverlap) {
      console.log(`  Console Top Row: fsOverlapsTimer=${inGameTest.topRowOverlap.fsOverlapsTimer}, timerOverlapsConn=${inGameTest.topRowOverlap.timerOverlapsConn}`, inGameTest.topRowOverlap);
    }

    await context.close();
  }

  await browser.close();
}

testAllViewports().catch(console.error);
