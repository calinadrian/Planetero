const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/node_modules', express.static(path.join(__dirname, 'node_modules')));

// Lobby management
const rooms = new Map();

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function createRoom() {
  const roomCode = generateRoomCode();
  rooms.set(roomCode, {
    id: roomCode,
    players: [],
    gameStarted: false,
    host: null
  });
  return roomCode;
}

function getRoom(roomCode) {
  return rooms.get(roomCode);
}

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Create a new room
  socket.on('create-room', (callback) => {
    const roomCode = createRoom();
    const room = getRoom(roomCode);
    room.players.push({
      socketId: socket.id,
      name: `Player 1`,
      score: 0,
      isHost: true
    });
    room.host = socket.id;
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    console.log(`Room created: ${roomCode}`);
    callback({ success: true, roomCode });
  });

  // Join an existing room
  socket.on('join-room', ({ roomCode }, callback) => {
    const room = getRoom(roomCode);
    if (!room) {
      return callback({ success: false, error: 'Room not found' });
    }
    if (room.players.length >= 2) {
      return callback({ success: false, error: 'Room is full' });
    }
    if (room.gameStarted) {
      return callback({ success: false, error: 'Game already started' });
    }

    room.players.push({
      socketId: socket.id,
      name: `Player 2`,
      score: 0,
      isHost: false
    });
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    console.log(`Player joined room: ${roomCode}`);

    // Notify the host with joiner info
    io.to(room.host).emit('player-joined', {
      socketId: socket.id,
      name: 'Player 2'
    });

    // Send host info to joiner so they can initiate WebRTC
    callback({ success: true, roomCode, hostSocketId: room.host });
  });

  // Start the game
  socket.on('start-game', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.players.length < 2) return;
    room.gameStarted = true;
    io.to(room.id).emit('game-started', {
      players: room.players.map(p => ({ socketId: p.socketId, name: p.name, isHost: p.isHost }))
    });
    console.log(`Game started in room: ${room.id}`);
  });

  // Handle WebRTC signaling
  socket.on('signal', ({ roomCode, targetSocketId, signal }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    io.to(targetSocketId).emit('signal', { from: socket.id, signal });
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    for (const [code, room] of rooms) {
      room.players = room.players.filter(p => p.socketId !== socket.id);
      if (room.players.length === 0) {
        rooms.delete(code);
      } else if (room.host === socket.id) {
        room.host = room.players[0].socketId;
        room.players[0].isHost = true;
      }
      io.to(code).emit('player-left', { socketId: socket.id });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
