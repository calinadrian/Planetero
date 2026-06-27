// ========================
// CONFIGURATION
// ========================
const CANVAS_W = 380;
const CANVAS_H = 520;
const WALL = 20;
const GAME_TIME = 180;

const FRUITS = [
  { radius: 14, color: '#ff4757', points: 1 },
  { radius: 19, color: '#ff6b81', points: 2 },
  { radius: 25, color: '#a55eea', points: 3 },
  { radius: 31, color: '#ffa502', points: 5 },
  { radius: 38, color: '#ff4757', points: 8 },
  { radius: 44, color: '#ff6348', points: 13 },
  { radius: 52, color: '#ffd32a', points: 21 },
  { radius: 60, color: '#ff9ff3', points: 34 },
  { radius: 70, color: '#f9ca24', points: 55 },
  { radius: 80, color: '#2ecc71', points: 89 },
  { radius: 90, color: '#00d2d3', points: 144 },
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
let hostLocalDescription = null;

function handleIncomingSignal(signalData) {
  if (!peerConn || !signalData.from) return;
  peerConn.setRemoteDescription(new RTCSessionDescription(signalData.signal))
    .then(() => {
      // If we already have a local description (we sent an offer), we need to set our answer
      if (peerConn.localDescription) return;
      // If we don't have a local description yet, we need to create an answer
      return peerConn.createAnswer();
    })
    .then(answer => {
      if (answer) {
        return peerConn.setLocalDescription(answer);
      }
    })
    .then(() => {
      setTimeout(() => {
        if (peerConn.localDescription && opponentSocketId) {
          socket.emit('signal', { roomCode, targetSocketId: opponentSocketId, signal: peerConn.localDescription });
        }
      }, 500);
    })
    .catch(err => console.error('Signal handling error:', err));
}

function initHostWebRTC() {
  createPeerConnection();
  dataChannel = peerConn.createDataChannel('game');
  dataChannel.onopen = () => console.log('Host channel open');
  dataChannel.onmessage = (ev) => handlePeerMessage(JSON.parse(ev.data));
  peerConn.createOffer().then(o => peerConn.setLocalDescription(o)).then(() => {
    hostLocalDescription = peerConn.localDescription;
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
}

// ========================
// SOCKET EVENTS
// ========================
socket.on('player-joined', (data) => {
  opponentSocketId = data.socketId;
  btnStart.disabled = false;
  playerListEl.innerHTML += `<div class="player-item"><span>${data.name}</span></div>`;
  // Send stored SDP offer now that we know the target
  if (hostLocalDescription) {
    socket.emit('signal', { roomCode, targetSocketId: opponentSocketId, signal: hostLocalDescription });
    hostLocalDescription = null;
  }
});

socket.on('signal', (data) => {
  handleIncomingSignal(data);
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
const GRAVITY = 0.015;
const RESTITUTION = 0.15;
const FRICTION = 0.995;

let canvasMy, ctxMy, canvasEnemy, ctxEnemy;
let myCircles = [];
let enemyCircles = [];
let current = null;
let dropping = false;
let mouseX = CANVAS_W / 2;
let score = 0, opponentScore = 0;
let timeLeft = GAME_TIME;
let timerInterval = null;
let gameActive = false;
let nextIdx = 0;
let mergeQueue = [];

function addCircle(arr, x, y, r, idx) {
  arr.push({ x, y, vx: 0, vy: 0, r, idx, settled: false, id: Math.random() });
}

function removeCircle(arr, id) {
  const i = arr.findIndex(c => c.id === id);
  if (i !== -1) arr.splice(i, 1);
}

function stepPhysics(arr) {
  for (const c of arr) {
    c.vy += GRAVITY;
    c.vx *= FRICTION;
    c.x += c.vx;
    c.y += c.vy;
  }

  for (const c of arr) {
    if (c.y + c.r > CANVAS_H - WALL) {
      c.y = CANVAS_H - WALL - c.r;
      c.vy *= -RESTITUTION;
      if (Math.abs(c.vy) < 0.5) { c.vy = 0; }
    }
    if (c.x - c.r < WALL) {
      c.x = WALL + c.r;
      c.vx *= -RESTITUTION;
    }
    if (c.x + c.r > CANVAS_W - WALL) {
      c.x = CANVAS_W - WALL - c.r;
      c.vx *= -RESTITUTION;
    }
    // Dampen tiny velocities to prevent jitter
    if (Math.abs(c.vx) < 0.01) c.vx = 0;
    if (Math.abs(c.vy) < 0.01 && c.y + c.r >= CANVAS_H - WALL - 1) c.vy = 0;
  }

  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i], b = arr[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const minDist = a.r + b.r;

      if (dist < minDist && dist > 0) {
        if (a.idx === b.idx && !a.merged && !b.merged) {
          mergeQueue.push([arr, a, b]);
          continue;
        }

        const nx = dx / dist, ny = dy / dist;
        const overlap = minDist - dist;
        a.x -= nx * overlap / 2;
        a.y -= ny * overlap / 2;
        b.x += nx * overlap / 2;
        b.y += ny * overlap / 2;

        const dvx = a.vx - b.vx, dvy = a.vy - b.vy;
        const dvDotN = dvx * nx + dvy * ny;
        if (dvDotN > 0) {
          const massA = a.r * a.r, massB = b.r * b.r;
          const totalMass = massA + massB;
          const impulse = (1 + RESTITUTION) * dvDotN / totalMass;
          a.vx -= impulse * massB * nx;
          a.vy -= impulse * massB * ny;
          b.vx += impulse * massA * nx;
          b.vy += impulse * massA * ny;
        }
      }
    }
  }

  for (const [arr, a, b] of mergeQueue) {
    const newIdx = a.idx + 1;
    if (newIdx >= FRUITS.length) {
      removeCircle(arr, a.id);
      removeCircle(arr, b.id);
    } else {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      removeCircle(arr, a.id);
      removeCircle(arr, b.id);
      addCircle(arr, mx, my, FRUITS[newIdx].radius, newIdx);
    }
  }
  mergeQueue = [];
}

// ========================
// GAME
// ========================
function startGame() {
  canvasMy = document.getElementById('canvas-my');
  canvasMy.width = CANVAS_W;
  canvasMy.height = CANVAS_H;
  ctxMy = canvasMy.getContext('2d');

  canvasEnemy = document.getElementById('canvas-enemy');
  canvasEnemy.width = CANVAS_W;
  canvasEnemy.height = CANVAS_H;
  ctxEnemy = canvasEnemy.getContext('2d');

  score = 0; opponentScore = 0; timeLeft = GAME_TIME;
  myCircles = []; enemyCircles = []; gameActive = true;
  updateScoreDisplay();
  updateTimerDisplay();
  setNextFruit();
  spawnCurrent();

  // My board controls
  canvasMy.addEventListener('mousemove', (e) => {
    const rect = canvasMy.getBoundingClientRect();
    mouseX = (e.clientX - rect.left) * (CANVAS_W / rect.width);
  });
  canvasMy.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const rect = canvasMy.getBoundingClientRect();
    mouseX = (e.touches[0].clientX - rect.left) * (CANVAS_W / rect.width);
  }, { passive: false });
  canvasMy.addEventListener('click', dropFruit);
  canvasMy.addEventListener('touchend', (e) => { e.preventDefault(); dropFruit(); });

  // Timer
  timerInterval = setInterval(() => {
    timeLeft--;
    updateTimerDisplay();
    if (timeLeft <= 0) endGame();
  }, 1000);

  loop();
}

function loop() {
  if (!gameActive) return;
  mergeQueue = [];
  stepPhysics(myCircles);
  stepPhysics(enemyCircles);
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
  nextIdx = Math.floor(Math.random() * 5);
}

function dropFruit() {
  if (!gameActive || dropping) return;
  const f = FRUITS[current.index];
  const x = Math.max(f.radius + WALL, Math.min(CANVAS_W - WALL - f.radius, mouseX));
  addCircle(myCircles, x, 50, f.radius, current.index);
  sendPeer({ type: 'drop', x: x, y: 50, index: current.index });
  dropping = true;
  setTimeout(() => { dropping = false; setNextFruit(); spawnCurrent(); }, 700);
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
  document.getElementById('score-p2').textContent = opponentScore;
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
  renderBoard(ctxMy, myCircles, true);
  renderBoard(ctxEnemy, enemyCircles, false);
}

function renderBoard(ctx, circles, isMy) {
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
    drawCircle(ctx, c.x, c.y, c.r, c.idx);
  }

  // Current fruit (only on my board)
  if (isMy && current && !dropping) {
    const previewX = Math.max(current.radius + WALL, Math.min(CANVAS_W - WALL - current.radius, mouseX));
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(previewX, current.y + current.radius);
    ctx.lineTo(previewX, CANVAS_H - WALL); ctx.stroke();
    ctx.setLineDash([]);
    drawCircle(ctx, previewX, current.y, current.radius, current.index);
  }
}

function drawCircle(ctx, x, y, r, idx) {
  const f = FRUITS[idx];
  ctx.beginPath(); ctx.arc(x + 2, y + 2, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.fill();
  const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
  g.addColorStop(0, lighten(f.color, 40));
  g.addColorStop(1, f.color);
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = 1.5; ctx.stroke();
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
    updateScoreDisplay();
  } else if (msg.type === 'game-over') {
    if (!gameActive) return;
    gameActive = false;
    clearInterval(timerInterval);
    opponentScore = msg.opponentScore;
    updateScoreDisplay();
    showResults();
    gameScreen.style.display = 'none';
    resultScreen.style.display = 'flex';
  } else if (msg.type === 'drop') {
    // Sync opponent's dropped fruit
    addCircle(enemyCircles, msg.x, msg.y, FRUITS[msg.index].radius, msg.index);
  } else if (msg.type === 'enemy-state') {
    // Full state sync
    enemyCircles = msg.circles;
  } else if (msg.type === 'my-state') {
    // Sync opponent's full circle state (periodic updates)
    enemyCircles = msg.circles.map(c => ({ ...c, vx: 0, vy: 0, settled: false, id: Math.random() }));
  }
}

// Periodically send my state to opponent
setInterval(() => {
  if (gameActive && dataChannel && dataChannel.readyState === 'open') {
    sendPeer({ type: 'my-state', circles: myCircles.map(c => ({ x: c.x, y: c.y, r: c.r, idx: c.idx })) });
  }
}, 500);
