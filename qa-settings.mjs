// Confirm the board + GAME SETTINGS panel are visible on load again, i.e. the
// lobby no longer covers the page. Also confirm the game-settings controls are
// present and interactive (not replaced/hidden by the lobby).
export default async function run(page, ui) {
  await page.waitForFunction(
    () => /GAME SETTINGS/i.test(document.body.innerText),
    null,
    { timeout: 30000 }
  );

  const info = await page.evaluate(() => {
    const byText = (re) => [...document.querySelectorAll('button,span,div')].find((e) => re.test(e.textContent || ''));
    const settingsHeading = byText(/^\s*GAME SETTINGS\s*$/i);
    const playerCount = byText(/Number of Players/i);
    const startingCash = byText(/Starting Cash/i);
    const startBtn = [...document.querySelectorAll('button')].find((b) => /Start Game & Lock Settings/i.test(b.textContent));
    const createBtn = [...document.querySelectorAll('button')].find((b) => /Create a Room/i.test(b.textContent));

    const vis = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { y: Math.round(b.y), h: Math.round(b.height), onScreen: b.height > 0 && b.y < window.innerHeight };
    };

    // Is anything overlaying the page at the settings panel's location?
    let overlayAtSettings = null;
    if (settingsHeading) {
      const b = settingsHeading.getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2));
      overlayAtSettings = top ? top.tagName + '.' + String(top.className).slice(0, 60) : null;
    }

    return {
      settingsHeading: vis(settingsHeading),
      playerCountControl: vis(playerCount),
      startingCashControl: vis(startingCash),
      startGameButton: vis(startBtn),
      startGameDisabled: startBtn ? startBtn.disabled : null,
      lobbyBarPresent: !!createBtn,
      lobbyBarIsBlockingOverlay: createBtn ? createBtn.closest('.fixed') !== null : null,
      elementAtSettingsPoint: overlayAtSettings,
    };
  });

  return info;
}
