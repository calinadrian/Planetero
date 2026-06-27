// ========================
// CONFIGURATION
// ========================
const CANVAS_W = 400;
const CANVAS_H = 560;
const WALL = 20;
const GAME_TIME = 180;

const FRUITS = [
  { radius: 15, color: '#ff4757', points: 1,  label: '🍒' },
  { radius: 20, color: '#ff6b81', points: 2,  label: '🍓' },
  { radius: 26, color: '#a55eea', points: 3,  label: '🍇' },
  { radius: 32, color: '#ffa502', points: 5,  label: '🍊' },
  { radius: 39, color: '#ff4757', points: 8,  label: '🍎' },
  { radius: 46, color: '#ff6348', points: 13, label: '🍅' },
  { radius: 54, color: '#ffd32a', points: 21, label: '🍐' },
  { radius: 62, color: '#ff9ff3', points: 34, label: '🍑' },
  { radius: 72, color: '#f9ca24', points: 55, label: '🍍' },
  { radius: 82, color: '#2ecc71', points: 89, label: '🍉' },
];

// ========================
// SOCKET.IO
// ========================
const socket = io();

// ========================
// WEBRTC
// ========================
let peerConn = null;
let dataChannel = null;
let opponentSocketId = null;
let isHost = false;
let roomCode = null;

function createPeerConnection() {
  peerConn = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });
  peerConn.onicecandidate = (e) => {
    if (e.candidate && opponentSocketId) {
      socket.emit('signal', { roomCode, targetSocketId: opponentSocketId, signal: e.candidate });
    }
  };
  peerConn.ondatachannel = (e) => {
    dataChannel = e.channel;
    dataChannel.onopen = () => console.log('P2P open');
    dataChannel.onmessage = (ev) => handlePeerMessage(JSON.parse(ev.data));
  };
}

function sendPeer(msg) {
  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify(msg));
  }
}

// ========================
// DOM
// ========================
const lobbyScreen = document.getElementById('lobby-screen');
const gameScreen = document.getElementById('game-screen');
const resultScreen = document.getElementById('result-screen');
const createSection = document.getElementById('create-section');
const joinSection = document.getElementById('join-section');
const roomCodeDisplay = document.getElementById('room-code');
const playerListEl = document.getElementById('player-list');
const btnStart = document.getElementById('btn-start');

document.getElementById('btn-create').addEventListener('click', () => {
  socket.emit('create-room', (res) => {
    if (!res.success) return alert('Failed');
    roomCode = res.roomCode;
    isHost = true;
    showLobby();
    initHostWebRTC();
  });
});

document.getElementById('btn-join').addEventListener('click', () => {
  const code = document.getElementById('room-input').value.toUpperCase().trim();
  if (!code) return alert('Enter code');
  socket.emit('join-room', { roomCode: code }, (res) => {
    if (!res.success) return alert(res.error);
    roomCode = res.roomCode;
    isHost = false;
    opponentSocketId = res.hostSocketId;
    showLobby();
    initJoinerWebRTC();
  });
});

btnStart.addEventListener('click', () => socket.emit('start-game'));

function showLobby() {
  createSection.style.display = 'none';
  joinSection.style.display = 'block';
  roomCodeDisplay.textContent = roomCode;
  playerListEl.innerHTML = `<div class="player-item"><span>${isHost ? 'You (Host)' : 'You'}</span></div>`;
}

// ========================
// WEBRTC
// ========================
function initHostWebRTC() {
  createPeerConnection();
  dataChannel = peerConn.createDataChannel('game');
  dataChannel.onopen = () => console.log('Host channel open');
  dataChannel.onmessage = (ev) => handlePeerMessage(JSON.parse(ev.data));
  peerConn.createOffer().then(o => peerConn.setLocalDescription(o)).then(() => {
    setTimeout(() => {
      if (peerConn.localDescription)
        socket.emit('signal', { roomCode, targetSocketId: opponentSocketId, signal: peerConn.localDescription });
    }, 1000);
  });
}

function initJoinerWebRTC() {
  createPeerConnection();
  peerConn.ondatachannel = (e) => {
    dataChannel = e.channel;
    dataChannel.onopen = () => console.log('Joiner channel open');
    dataChannel.onmessage = (ev) => handlePeerMessage(JSON.parse(ev.data));
  };
  peerConn.onicecandidate = (e) => {
    if (e.candidate && opponentSocketId)
      socket.emit('signal', { roomCode, targetSocketId: opponentSocketId, signal: e.candidate });
  };
  socket.on('signal', (data) => {
    if (data.from !== opponentSocketId) return;
    peerConn.setRemoteDescription(new RTCSessionDescription(data.signal))
      .then(() => peerConn.createAnswer())
      .then(a => peerConn.setLocalDescription(a))
      .then(() => {
        setTimeout(() => {
          if (peerConn.localDescription)
            socket.emit('signal', { roomCode, targetSocketId: opponentSocketId, signal: peerConn.localDescription });
        }, 1000);
      });
  });
}

// ========================
// SOCKET EVENTS
// ========================
socket.on('player-joined', (data) => {
  opponentSocketId = data.socketId;
  btnStart.disabled = false;
  playerListEl.innerHTML += `<div class="player-item"><span>${data.name}</span></div>`;
});

socket.on('game-started', () => {
  lobbyScreen.style.display = 'none';
  gameScreen.style.display = 'flex';
  startGame();
});

socket.on('player-left', () => { alert('Opponent left!'); location.reload(); });

// ========================
// PHYSICS ENGINE
// ========================
const GRAVITY = 0.4;
const RESTITUTION = 0.2;
const FRICTION = 0.98;

let canvas, ctx;
let circles = []; // physics bodies
let current = null; // fruit at top
let dropping = false;
let mouseX = CANVAS_W / 2;
let score = 0, opponentScore = 0;
let timeLeft = GAME_TIME;
let timerInterval = null;
let gameActive = false;
let nextIdx = 0;
let mergeQueue = [];

function addCircle(x, y, r, idx) {
  circles.push({ x, y, vx: 0, vy: 0, r, idx, settled: false, id: Math.random() });
}

function removeCircle(id) {
  circles = circles.filter(c => c.id !== id);
}

function stepPhysics() {
  // Gravity & movement
  for (const c of circles) {
    c.vy += GRAVITY;
    c.vx *= FRICTION;
    c.x += c.vx;
    c.y += c.vy;
    c.settled = false;
  }

  // Wall collisions
  for (const c of circles) {
    // Ground
    if (c.y + c.r > CANVAS_H - WALL) {
      c.y = CANVAS_H - WALL - c.r;
      c.vy *= -RESTITUTION;
      if (Math.abs(c.vy) < 1) { c.vy = 0; c.settled = true; }
    }
    // Left wall
    if (c.x - c.r < WALL) {
      c.x = WALL + c.r;
      c.vx *= -RESTITUTION;
    }
    // Right wall
    if (c.x + c.r > CANVAS_W - WALL) {
      c.x = CANVAS_W - WALL - c.r;
      c.vx *= -RESTITUTION;
    }
  }

  // Circle-circle collisions
  for (let i = 0; i < circles.length; i++) {
    for (let j = i + 1; j < circles.length; j++) {
      const a = circles[i], b = circles[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const minDist = a.r + b.r;

      if (dist < minDist && dist > 0) {
        // Check merge
        if (a.idx === b.idx && !a.merged && !b.merged) {
          mergeQueue.push([a, b]);
          continue;
        }

        // Separate
        const nx = dx / dist, ny = dy / dist;
        const overlap = minDist - dist;
        a.x -= nx * overlap / 2;
        a.y -= ny * overlap / 2;
        b.x += nx * overlap / 2;
        b.y += ny * overlap / 2;

        // Elastic collision response
        const dvx = a.vx - b.vx, dvy = a.vy - b.vy;
        const dvDotN = dvx * nx + dvy * ny;
        if (dvDotN > 0) {
          const massA = a.r * a.r, massB = b.r * b.r;
          const totalMass = massA + massB;
          const impulse = 2 * dvDotN / totalMass;
          a.vx -= impulse * massB * nx * RESTITUTION;
          a.vy -= impulse * massB * ny * RESTITUTION;
          b.vx += impulse * massA * nx * RESTITUTION;
          b.vy += impulse * massA * ny * RESTITUTION;
        }
      }
    }
  }

  // Process merges
  for (const [a, b] of mergeQueue) {
    const newIdx = a.idx + 1;
    if (newIdx >= FRUITS.length) {
      score += FRUITS[newIdx - 1].points * 2;
      updateScoreDisplay();
      removeCircle(a.id);
      removeCircle(b.id);
      sendPeer({ type: 'merge', score });
    } else {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      removeCircle(a.id);
      removeCircle(b.id);
      addCircle(mx, my, FRUITS[newIdx].radius, newIdx);
      score += FRUITS[newIdx].points;
      updateScoreDisplay();
      sendPeer({ type: 'merge', score });
    }
  }
  mergeQueue = [];
}

// ========================
// GAME
// ========================
function startGame() {
  canvas = document.getElementById('game-canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  ctx = canvas.getContext('2d');

  score = 0; opponentScore = 0; timeLeft = GAME_TIME;
  circles = []; gameActive = true;
  updateScoreDisplay();
  updateTimerDisplay();
  setNextFruit();
  spawnCurrent();

  // Controls
  document.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    mouseX = (e.clientX - rect.left) * (CANVAS_W / rect.width);
  });
  document.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    mouseX = (e.touches[0].clientX - rect.left) * (CANVAS_W / rect.width);
  }, { passive: false });
  canvas.addEventListener('click', dropFruit);
  canvas.addEventListener('touchend', (e) => { e.preventDefault(); dropFruit(); });

  // Timer
  timerInterval = setInterval(() => {
    timeLeft--;
    updateTimerDisplay();
    if (timeLeft <= 0) endGame();
  }, 1000);

  // Game loop
  loop();
}

function loop() {
  if (!gameActive) return;
  stepPhysics();
  render();
  requestAnimationFrame(loop);
}

function spawnCurrent() {
  if (!gameActive) return;
  const f = FRUITS[nextIdx];
  current = { x: CANVAS_W / 2, y: 50, index: nextIdx, radius: f.radius };
  dropping = false;
}

function setNextFruit() {
  nextIdx = Math.floor(Math.random() * 3);
}

function dropFruit() {
  if (!gameActive || dropping) return;
  const f = FRUITS[current.index];
  const x = Math.max(f.radius + WALL + 2, Math.min(CANVAS_W - WALL - 2, mouseX));
  addCircle(x, 50, f.radius, current.index);
  dropping = true;
  setTimeout(() => { dropping = false; setNextFruit(); spawnCurrent(); }, 400);
}

function endGame() {
  gameActive = false;
  clearInterval(timerInterval);
  sendPeer({ type: 'game-over', myScore: score, opponentScore });
  gameScreen.style.display = 'none';
  resultScreen.style.display = 'flex';
  showResults();
}

function showResults() {
  const el = document.getElementById('result-scores');
  const win = score > opponentScore;
  const draw = score === opponentScore;
  el.innerHTML = `
    <div class="result-card ${win ? 'winner' : ''}"><div class="name">You</div><div class="score">${score}</div></div>
    <div class="result-card ${!win && !draw ? 'winner' : ''}"><div class="name">Opponent</div><div class="score">${opponentScore}</div></div>
  `;
}

function updateScoreDisplay() {
  document.getElementById('score-p1').textContent = score;
}

function updateTimerDisplay() {
  const m = Math.floor(timeLeft / 60);
  const s = timeLeft % 60;
  document.getElementById('timer').textContent = `${m}:${s.toString().padStart(2, '0')}`;
}

// ========================
// RENDERING
// ========================
function render() {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  // Danger line
  ctx.strokeStyle = 'rgba(255,71,87,0.5)';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 8]);
  ctx.beginPath(); ctx.moveTo(0, 80); ctx.lineTo(CANVAS_W, 80); ctx.stroke();
  ctx.setLineDash([]);

  // Walls
  ctx.fillStyle = '#333';
  ctx.fillRect(0, CANVAS_H - WALL, CANVAS_W, WALL);
  ctx.fillStyle = '#222';
  ctx.fillRect(0, 0, WALL, CANVAS_H);
  ctx.fillRect(CANVAS_W - WALL, 0, WALL, CANVAS_H);

  // Circles
  for (const c of circles) {
    drawCircle(c.x, c.y, c.r, c.idx);
  }

  // Current fruit
  if (current && !dropping) {
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(current.x, current.y + current.radius);
    ctx.lineTo(current.x, CANVAS_H - WALL); ctx.stroke();
    ctx.setLineDash([]);
    drawCircle(current.x, current.y, current.radius, current.index);
  }
}

function drawCircle(x, y, r, idx) {
  const f = FRUITS[idx];
  // Shadow
  ctx.beginPath(); ctx.arc(x + 2, y + 2, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.fill();
  // Gradient
  const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
  g.addColorStop(0, lighten(f.color, 40));
  g.addColorStop(1, f.color);
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = 1.5; ctx.stroke();
  // Emoji
  ctx.font = `${r * 0.9}px serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(f.label, x, y + 1);
}

function lighten(hex, amt) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, (n >> 16) + amt);
  const g = Math.min(255, ((n >> 8) & 0xFF) + amt);
  const b = Math.min(255, (n & 0xFF) + amt);
  return `rgb(${r},${g},${b})`;
}

// ========================
// PEER
// ========================
function handlePeerMessage(msg) {
  if (msg.type === 'merge') {
    opponentScore = msg.score;
    document.getElementById('score-p2').textContent = opponentScore;
  } else if (msg.type === 'game-over') {
    if (!gameActive) return;
    gameActive = false;
    clearInterval(timerInterval);
    opponentScore = msg.opponentScore;
    document.getElementById('score-p2').textContent = opponentScore;
    showResults();
    gameScreen.style.display = 'none';
    resultScreen.style.display = 'flex';
  }
}
