const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors()); // Allows your frontend to talk to this backend

const server = http.createServer(app);

// Set up Socket.io for real-time multiplayer
const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000", // Your Next.js frontend URL
    methods: ["GET", "POST"]
  }
});

// Listen for players connecting
io.on('connection', (socket) => {
  console.log(`🟢 A player connected: ${socket.id}`);

  // Listen for players disconnecting
  socket.on('disconnect', () => {
    console.log(`🔴 A player disconnected: ${socket.id}`);
  });
});

// Start the server on port 3001
const PORT = 3001;
server.listen(PORT, () => {
  console.log(`🚀 Game Server running on http://localhost:${PORT}`);
});