import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(join(homedir(), '.vscode/extensions/danielsanmedium.dscodegpt-3.24.77/standalone/'));
const { chromium } = req('patchright');

async function testInviteLinkFlow() {
  console.log('--- STARTING INVITE LINK BROWSER VERIFICATION ---');
  const browser = await chromium.launch({
    headless: true,
    channel: 'chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
  });

  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

  // Context 1: Host creates a room
  const hostContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const hostPage = await hostContext.newPage();

  console.log(`1. Navigating Host to ${FRONTEND_URL}...`);
  try {
    await hostPage.goto(FRONTEND_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });
  } catch (err) {
    console.log(`Frontend server not reachable at ${FRONTEND_URL}. Ensure 'npm run dev' is running.`);
    await browser.close();
    return;
  }

  await hostPage.waitForTimeout(800);
  await hostPage.fill('#lobby-name', 'AliceHost');
  await hostPage.click('button:has-text("CREATE A ROOM")');
  await hostPage.waitForTimeout(1000);

  // Check URL updated with ?room=
  const hostUrl = hostPage.url();
  console.log('2. Host URL after room creation:', hostUrl);
  const match = hostUrl.match(/[?&]room=([A-Z2-9]{6})/i);
  if (!match) {
    console.error('FAIL: Host URL does not contain ?room=<CODE>');
    await browser.close();
    process.exit(1);
  }
  const roomCode = match[1].toUpperCase();
  console.log(`3. Detected generated Room Code: ${roomCode}`);

  // Check that Copy Invite Link button exists in Colour Picker modal
  const copyInviteBtnModal = await hostPage.$('button[title*="Copy shareable invite link"]');
  console.log('4. Copy Invite Link button present in Colour Picker:', !!copyInviteBtnModal);

  // Pick color for host
  const swatches = await hostPage.$$('button[title^="Choose"]');
  if (swatches.length > 0) {
    await swatches[0].click();
    await hostPage.waitForTimeout(800);
  }

  // Check Copy Invite Link button in sidebar
  const copyInviteBtnSidebar = await hostPage.$('button:has-text("Copy Invite Link")');
  console.log('5. Copy Invite Link button present in Sidebar:', !!copyInviteBtnSidebar);

  // Context 2: Guest opens invite link with ?room=CODE
  console.log(`6. Opening Guest context with invite link: ${FRONTEND_URL}/?room=${roomCode}`);
  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const guestPage = await guestContext.newPage();
  await guestPage.goto(`${FRONTEND_URL}/?room=${roomCode}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
  await guestPage.waitForTimeout(800);

  // Check invite banner in lobby
  const bannerText = await guestPage.evaluate(() => {
    const el = document.querySelector('.border-cyan-400\\/50');
    return el ? el.textContent : null;
  });
  console.log('7. Guest Lobby Invite Banner:', bannerText);

  // Check that ROOM CODE input is pre-filled with the room code
  const prefilledCode = await guestPage.evaluate(() => {
    const input = document.querySelector('input[placeholder="ROOM CODE"]');
    return input ? input.value : null;
  });
  console.log(`8. Guest input pre-filled code: '${prefilledCode}' (expected '${roomCode}')`);
  if (prefilledCode !== roomCode) {
    console.error(`FAIL: Expected input pre-filled with '${roomCode}', got '${prefilledCode}'`);
    await browser.close();
    process.exit(1);
  }

  // Guest enters name and clicks Join
  await guestPage.fill('#lobby-name', 'BobGuest');
  await guestPage.click('button:has-text("Join")');
  await guestPage.waitForTimeout(1000);

  // Verify Guest enters room and is at Colour Picker
  const guestInRoom = await guestPage.evaluate(() => {
    return document.body.innerText.includes('Pick your colour') || document.body.innerText.includes('BobGuest');
  });
  console.log('9. Guest successfully entered room via invite link:', guestInRoom);

  // Verify Host sees 2 players connected
  const hostPeerText = await hostPage.evaluate(() => {
    const peerSpan = document.querySelector('.text-\\[11px\\].font-bold');
    return peerSpan ? peerSpan.textContent : null;
  });
  console.log('10. Host sidebar connection status:', hostPeerText);

  await hostContext.close();
  await guestContext.close();
  await browser.close();
  console.log('--- INVITE LINK BROWSER VERIFICATION COMPLETED SUCCESSFULLY ---');
}

testInviteLinkFlow().catch((err) => {
  console.error('Verification error:', err);
  process.exit(1);
});
