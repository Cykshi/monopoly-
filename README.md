# Monopoly Online

A real-time multiplayer board game built with Next.js, TypeScript, Node.js, Express, and Socket.IO. The application supports multiplayer rooms, property management, auctions, trading, and server-authoritative game actions.

**[Live Demo](https://monopoly-pied-seven.vercel.app/)** · [Source Code](https://github.com/Cykshi/monopoly-) · [Report an Issue](https://github.com/Cykshi/monopoly-/issues)

## Gameplay

![Monopoly Online Gameplay](docs/images/gameplay.png)

## Key Features

- **Real-Time Multiplayer:** Room-based gameplay with synchronized player and game-state updates using Socket.IO.
- **Server-Authoritative Game Logic:** Server-side validation of critical actions to maintain game-state integrity.
- **Property Management:** Property purchases, rent collection, and property upgrades.
- **Auctions and Trading:** Multiplayer bidding and player-to-player asset transactions.
- **Turn and Jail Mechanics:** Turn management, dice rolls, movement rules, and jail-related actions.
- **Game State Persistence:** Support for saving and restoring game sessions.
- **Responsive UI:** Interactive browser-based interface built with React and Tailwind CSS.

## Tech Stack

| Layer | Technologies |
|---|---|
| Frontend | Next.js, React, TypeScript |
| Styling | Tailwind CSS |
| Backend | Node.js, Express |
| Real-Time Communication | Socket.IO |
| Deployment | Vercel, Render |

## Architecture

The application follows a client-server architecture. The Next.js frontend provides the user interface, while the Express backend manages game actions, validation, multiplayer communication, and persistence. Socket.IO enables real-time communication and game-state updates between connected players.

## Run Locally

### Prerequisites

- Node.js and npm
- Git

### 1. Clone the Repository

```bash
git clone https://github.com/Cykshi/monopoly-.git
cd monopoly-
```

### 2. Start the Backend

Open a terminal and run:

```bash
cd backend
npm install
```

Configure the environment variables using `backend/.env.example`, then start the backend using the appropriate script defined in `backend/package.json`.

### 3. Start the Frontend

Open a second terminal from the repository root and run:

```bash
cd frontend
npm install
```

Create `frontend/.env.local` and configure the backend URL:

```env
NEXT_PUBLIC_SOCKET_URL=http://localhost:3001
```

Start the frontend:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Testing

The backend includes tests covering game-action validation, turn authority, player identity, auctions, jail mechanics, and game-state restoration.

Run the relevant test scripts from the `backend` directory according to the project configuration.

## Author

**Cykshi** · [GitHub Profile](https://github.com/Cykshi)
