import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(join(homedir(), '.vscode/extensions/danielsanmedium.dscodegpt-3.24.77/standalone/'));
const { chromium } = req('patchright');

async function checkChatBtn() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 375, height: 667 } });
  await page.goto('http://localhost:3000');
  await page.fill('#lobby-name', 'Sakshi');
  await page.click('button:has-text("CREATE A ROOM")');
  await page.waitForTimeout(600);
  const swatches = await page.$$('button[title^="Choose"]');
  if (swatches.length > 0) await swatches[0].click();
  await page.waitForTimeout(600);

  const btnInfo = await page.evaluate(() => {
    const el = document.querySelector('button[title="Open Player Chat"]');
    if (!el) return 'NOT FOUND';
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return {
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height, bottom: rect.bottom, right: rect.right },
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      position: style.position,
      parent: el.parentElement ? el.parentElement.tagName + '.' + el.parentElement.className : 'null'
    };
  });
  console.log('Floating chat btn details:', btnInfo);

  // Check top nav chat btn
  const topChatBtn = await page.$('button[title="Toggle Chat"]');
  console.log('Top chat btn found:', !!topChatBtn);
  if (topChatBtn) {
    const box = await topChatBtn.boundingBox();
    console.log('Top chat btn box:', box);
  }

  await browser.close();
}

checkChatBtn().catch(console.error);
