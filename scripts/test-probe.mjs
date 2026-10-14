import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(join(homedir(), '.vscode/extensions/danielsanmedium.dscodegpt-3.24.77/standalone/'));
const { chromium } = req('patchright');

async function runTest() {
  const browser = await chromium.launch({
    headless: true,
    channel: 'chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({
    viewport: { width: 375, height: 667 },
  });
  const page = await context.newPage();
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(1000);
  console.log('Title:', await page.title());
  await browser.close();
}

runTest().catch(console.error);
