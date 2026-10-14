# Standalone Development & Verification Scripts

This directory contains standalone utility, diagnostic, and end-to-end browser verification scripts used during development.

---

## Script Inventory

| Script | Type | Description | Usage |
|---|---|---|---|
| `check-state.js` | Diagnostic (Node.js) | Scans `frontend/app/page.tsx` for required UI state markers (lobby modal, full-screen gate, navigation classes). Safe to run from root or `scripts/`. | `node scripts/check-state.js` |
| `strip-bom.js` | Utility (Node.js) | Inspects and strips leading UTF-8 Byte Order Marks (BOM) from target files without altering other bytes. | `node scripts/strip-bom.js <path-to-file>` |
| `run-suite-current.mjs` | Browser Verification (Playwright / Patchright) | Tests responsive layout rendering across 8 standard viewports (320px, 360px, 375px, 390px, 414px, 768px, 1280px, 1920px). | `node scripts/run-suite-current.mjs` |
| `test-mobile-ui-check.mjs` | Browser Verification (Playwright / Patchright) | Automates mobile (375×667) and desktop (1280×800) verification: room creation, color selection, floating chat toggling, tab switching, and indicator geometry. | `node scripts/test-mobile-ui-check.mjs` |
| `test-chat-btn.mjs` | Browser Verification (Playwright / Patchright) | Verifies computed bounding box, visibility, and layout position of the mobile floating chat button across tabs. | `node scripts/test-chat-btn.mjs` |
| `test-probe.mjs` | Browser Verification (Playwright / Patchright) | Fast browser probe verifying frontend connectivity and document title. | `node scripts/test-probe.mjs` |

---

## Environment & Dependency Requirements

- **Diagnostic & Utility Scripts (`check-state.js`, `strip-bom.js`):**
  Require only standard Node.js runtime (`node >= 18`). No external npm dependencies required.
- **Browser Verification Scripts (`*.mjs`):**
  Require a running frontend server at `http://localhost:3000` (started via `cd frontend && npm run dev`).
  These scripts leverage the local headless browser driver (`patchright`) configured in developer environments for automated layout checks.
