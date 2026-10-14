# Monopoly Online

A real-time multiplayer board game built with Next.js, React, TypeScript, Three.js, Node.js, Express, and Socket.IO. The application features room-based lobbies, server-authoritative game actions, 3D physics-driven dice rolling, property management, auctions, trading, jail rules, vote-kicking, and automatic game-state persistence.

**[🎮 Live Demo](https://monopoly-pied-seven.vercel.app/)** · [Source Code](https://github.com/Cykshi/monopoly-) · [Report an Issue](https://github.com/Cykshi/monopoly-/issues)

---

## Gameplay

![Monopoly Online Gameplay](docs/images/gameplay.png)

---

## Key Features

- **Real-Time Multiplayer:** Create private 6-character room codes or join existing games with live player rosters and real-time state synchronization via Socket.IO.
- **Server-Authoritative Game Engine:**
  - Dice roll values and movement paths are generated and validated on the backend to prevent teleportation and client tampering.
  - Turn timers (120s by default) enforce pacing with automatic turn progression and timeout handling.
  - Action integrity guards protect against replayed or spoofed events using unique action IDs and authenticated seat tokens.
- **Interactive 3D Physics Dice:** Realistic 3D dice rolling rendered with Three.js (`@react-three/fiber` and `@react-three/cannon`) that seamlessly settle onto the server's authoritative roll values.
- **Property & Asset Management:**
  - Board landing charges, rent calculation (including utility multipliers and house levels), property purchases, and upgrades.
  - Insolvency and bankruptcy handling with automatic asset transfer to creditors or liquidation to the bank.
- **Live Auctions & Player Trading:**
  - Multiplayer timed auctions with real-time bidding, passing, and anti-sniping timers.
  - Bilateral player-to-player trade proposals offering properties and cash with cryptographic party verification.
- **Jail & Special Tiles:**
  - Jail turn tracking, bail payment, doubles roll escape, and third-turn forced bail or bankruptcy.
  - Tax tiles, Skill Cards, Surprise/Treasure cards, and shared Rest House pot payouts.
- **Democratic Vote-Kick & Host Moderation:**
  - Server-authoritative vote-kick system requiring unanimous consensus among active non-target players (minimum 3 players).
  - Protected host controls for room setup and capacity.
- **Resilient State Persistence:**
  - Active game sessions, rosters, balances, and board states are persisted to disk, allowing players to reconnect and restore active games after browser refresh or server reboot.
- **Responsive Adaptive Interface:**
  - Full-screen desktop board layout with side-by-side management panels.
  - Mobile layout with tabbed navigation (Board, Properties, Players), sticky floating chat, and touch-optimized action buttons.

---

## Tech Stack

| Layer | Technologies |
|---|---|
| **Frontend Framework** | Next.js 16 (App Router), React 19, TypeScript |
| **3D Graphics & Physics** | Three.js, `@react-three/fiber`, `@react-three/cannon`, `@react-three/drei` |
| **Styling & UI** | Tailwind CSS v4 |
| **Backend Runtime** | Node.js (CommonJS), Express |
| **Real-Time Transport** | Socket.IO |
| **Persistence** | File-backed JSON session store (`DATA_DIR`), atomic state writes |
| **Hosting & Deployment** | Vercel (Frontend), Render (Backend) |

---

## Architecture

```text
┌────────────────────────────────────────────────────────┐
│                   Next.js Frontend                     │
│  React 19 · Tailwind CSS · Three.js 3D Dice Simulation │
│  Client State Machine · Sound FX · Responsive Layouts  │
└───────────────────────────▲────────────────────────────┘
                            │
               WebSocket / Socket.IO Events
          (Authenticated via per-seat UUID tokens)
                            │
┌───────────────────────────▼────────────────────────────┐
│                    Express Backend                     │
│  Authoritative Game Loop · Anti-Cheat & Action Gates   │
│  Turn Timers · Board Calculations · Persistence Engine │
└───────────────────────────▲────────────────────────────┘
                            │
             JSON File-System Storage (DATA_DIR)
```

---

## Project Structure

```text
monopoly-/
├── backend/                     # Node.js/Express + Socket.IO server and automated test suites
│   ├── game/                    # Authoritative board definitions and game rules
│   ├── server.js                # Main server, socket event handlers, and room lifecycle
│   ├── persistence.js           # Disk persistence and room restoration logic
│   ├── run-tests.js             # Test runner orchestration script
│   └── test-*.js                # 19 standalone regression and security test suites
├── frontend/                    # Next.js 16 frontend application
│   ├── app/                     # Next.js App Router pages, components, and 3D dice canvas
│   ├── lib/                     # Client state helpers and restoration utilities
│   └── public/                  # Static assets and sounds
├── docs/
│   └── images/                  # Gameplay screenshot and media assets
├── scripts/                     # Standalone developer tools, BOM cleaners, and verification scripts
│   ├── README.md                # Documentation of development tools and scripts
│   ├── check-state.js           # UI layout marker diagnostic tool
│   ├── strip-bom.js             # UTF-8 BOM cleanup utility
│   └── test-*.mjs               # Headless browser verification and responsive viewport scripts
├── README.md                    # Project documentation
└── .gitignore                   # Version control exclusions
```

---

## Run Locally

### Prerequisites

- **Node.js**: v18.0.0 or higher
- **npm**: v9.0.0 or higher
- **Git**

### 1. Clone the Repository

```bash
git clone https://github.com/Cykshi/monopoly-.git
cd monopoly-
```

### 2. Start the Backend Server

```bash
cd backend
npm install
```

Copy the environment example and start the server:

```bash
cp .env.example .env
npm start
```

For live development with auto-reloading:

```bash
npm run dev
```

The backend server will listen on `http://localhost:3001` by default.

### 3. Start the Frontend Application

Open a second terminal window in the project root:

```bash
cd frontend
npm install
```

Configure your local environment variables in `frontend/.env.local`:

```env
NEXT_PUBLIC_SOCKET_URL=http://localhost:3001
```

Start the Next.js development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your web browser.

---

## Testing

The project includes an extensive automated backend test suite covering anti-cheat validation, roll authority, turn progression, trade verification, auction settlements, jail rules, vote-kicking, and persistence.

### Run All Backend Tests

From the `backend/` directory:

```bash
cd backend

# Run the complete test suite (spawns an automated isolated server instance)
npm test

# Run offline unit suites only (movement and disk persistence)
npm run test:offline
```

### Run Targeted Test Suites

You can run individual test suites using the test runner filter:

```bash
# Test voluntary bankruptcy, vote-kicking, and rent settlement
node run-tests.js bankruptcy-votekick

# Test turn management and timeout elimination
node run-tests.js turn-timeout

# Test roll derivation and anti-teleportation checks
node run-tests.js roll-authority

# Test player identity and impersonation protections
node run-tests.js identity-security

# Test auction bidding and payment integrity
node run-tests.js auction-payment
```

### Frontend Production Build

From the `frontend/` directory, verify TypeScript compilation and Next.js production bundling:

```bash
cd frontend
npm run build
```

---

## Developer Scripts

Utility and browser verification scripts are organized in [`scripts/`](scripts/). See [`scripts/README.md`](scripts/README.md) for full instructions on running responsive layout audits and diagnostic tools.

---

## Author

**Cykshi** · [GitHub Profile](https://github.com/Cykshi)
