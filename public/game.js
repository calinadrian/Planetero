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
// Opponent's preview state (received via P2P)
let enemyCurrent = null;
let enemyDropping = false;
let score = 0, opponentScore = 0;
let timeLeft = GAME_TIME;
let timerInterval = null;
let gameActive = false;
let nextIdx = 0;
let mergeQueue = [];
let opponentBlocked = false;

function addCircle(arr, x, y, r, idx) {
  arr.push({ x, y, vx: 0, vy: 0, r, idx, settled: false, id: Math.random() });
}

function removeCircle(arr, id) {
  const i = arr.findIndex(c => c.id === id);
  if (i !== -1) arr.splice(i, 1);
}

const DANGER_LINE = 80;

function checkDangerLine(arr) {
  // Check if any circle is settled above the danger line
  for (const c of arr) {
    if (c.y - c.r < DANGER_LINE && c.settled) {
      return true;
    }
  }
  return false;
}

function lockCirclesAboveLine(arr) {
  // Lock (freeze) circles that are above the danger line so they can't move anymore
  for (const c of arr) {
    if (c.y - c.r < DANGER_LINE && c.settled) {
      c.locked = true;
      c.vx = 0;
      c.vy = 0;
    }
  }
}

function stepPhysics(arr) {
  // Skip physics for locked circles (but still apply gravity/walls to non-locked)
  for (const c of arr) {
    if (c.locked) continue;
    c.vy += GRAVITY;
    c.vx *= FRICTION;
    c.x += c.vx;
    c.y += c.vy;
  }

  for (const c of arr) {
    if (c.locked) continue;
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
      // Locked circles don't participate in collisions as movers, but act as solid obstacles
      const aLocked = a.locked || false;
      const bLocked = b.locked || false;
      
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const minDist = a.r + b.r;

      if (dist < minDist && dist > 0) {
        if (a.idx === b.idx && !a.merged && !b.merged && !aLocked && !bLocked) {
          mergeQueue.push([arr, a, b]);
          continue;
        }

        const nx = dx / dist, ny = dy / dist;
        const overlap = minDist - dist;
        
        // Only move non-locked circles
        if (!aLocked && !bLocked) {
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
        } else if (!aLocked && bLocked) {
          // Push non-locked circle out of locked circle
          a.x -= nx * overlap;
          const dvx = a.vx - b.vx, dvy = a.vy - b.vy;
          const dvDotN = dvx * nx + dvy * ny;
          if (dvDotN > 0) {
            a.vx -= 2 * dvDotN * nx * 0.5;
            a.vy -= 2 * dvDotN * ny * 0.5;
          }
        } else if (aLocked && !bLocked) {
          b.x += nx * overlap;
          const dvx = a.vx - b.vx, dvy = a.vy - b.vy;
          const dvDotN = dvx * nx + dvy * ny;
          if (dvDotN > 0) {
            b.vx -= 2 * dvDotN * nx * 0.5;
            b.vy -= 2 * dvDotN * ny * 0.5;
          }
        }
      }
    }
  }

  let merged = [];
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
      merged.push(FRUITS[newIdx].points);
    }
  }
  mergeQueue = [];
  return merged;
}

function settleCircles(arr) {
  // Mark circles that are settled (resting on bottom or on top of other settled circles)
  const settled = new Set();
  let changed = true;
  
  while (changed) {
    changed = false;
    for (const c of arr) {
      if (settled.has(c.id)) continue;
      
      // Check if circle is resting on the bottom wall
      if (c.y + c.r >= CANVAS_H - WALL - 1 && Math.abs(c.vy) < 0.5) {
        settled.add(c.id);
        c.settled = true;
        changed = true;
        continue;
      }
      
      // Check if circle is resting on settled circles
      for (const other of arr) {
        if (!settled.has(other.id)) continue;
        const dx = c.x - other.x, dy = c.y - other.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= c.r + other.r + 1) {
          settled.add(c.id);
          c.settled = true;
          changed = true;
          break;
        }
      }
    }
  }
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
    // Immediately send preview position for real-time updates
    if (current && !dropping && dataChannel && dataChannel.readyState === 'open') {
      const previewX = Math.max(current.radius + WALL, Math.min(CANVAS_W - WALL - current.radius, mouseX));
      sendPeer({ type: 'preview', x: previewX, y: current.y, index: current.index, radius: current.radius });
    }
  });
  canvasMy.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const rect = canvasMy.getBoundingClientRect();
    mouseX = (e.touches[0].clientX - rect.left) * (CANVAS_W / rect.width);
    // Immediately send preview position for real-time updates
    if (current && !dropping && dataChannel && dataChannel.readyState === 'open') {
      const previewX = Math.max(current.radius + WALL, Math.min(CANVAS_W - WALL - current.radius, mouseX));
      sendPeer({ type: 'preview', x: previewX, y: current.y, index: current.index, radius: current.radius });
    }
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
  const myMerged = stepPhysics(myCircles);
  stepPhysics(enemyCircles);
  
  // Settle circles and lock any that exceed the danger line
  settleCircles(myCircles);
  if (checkDangerLine(myCircles)) {
    lockCirclesAboveLine(myCircles);
  }
  
  // Settle circles and lock enemy circles that exceed the danger line
  settleCircles(enemyCircles);
  if (checkDangerLine(enemyCircles)) {
    lockCirclesAboveLine(enemyCircles);
  }
  
  // Check if opponent has locked circles (notify opponent about my blocked state)
  const myBlocked = myCircles.some(c => c.locked);
  if (myBlocked !== opponentBlocked) {
    opponentBlocked = myBlocked;
    sendPeer({ type: 'my-blocked', blocked: myBlocked });
    
    // Check instant win condition: if I'm locked and opponent has more points
    if (myBlocked && opponentScore > score) {
      sendPeer({ type: 'opponent-wins', myScore: score, opponentScore: opponentScore });
      endGame();
      return;
    }
  }
  
  // Add points from merges and notify opponent
  for (const pts of myMerged) {
    score += pts;
    updateScoreDisplay();
    sendPeer({ type: 'merge', score: score });
    
    // Check instant win condition: if opponent is locked and I now have more points
    if (opponentBlocked && score > opponentScore) {
      endGame();
      return;
    }
  }
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
  
  // Check if any circles are locked (above the danger line)
  // If so, prevent placing more fruits
  const hasLockedCircles = myCircles.some(c => c.locked);
  if (hasLockedCircles) return;
  
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
  renderBoard(ctxMy, myCircles, true, null);
  renderBoard(ctxEnemy, enemyCircles, false, enemyCurrent, enemyDropping);
}

function renderBoard(ctx, circles, isMy, previewCurrent, previewDropping) {
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
    drawCircle(ctx, c.x, c.y, c.r, c.idx, c.locked || false);
  }

  // Current fruit preview (my board)
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

  // Opponent's current fruit preview (on enemy board)
  if (!isMy && previewCurrent && !previewDropping) {
    const f = FRUITS[previewCurrent.index];
    const previewX = Math.max(previewCurrent.radius + WALL, Math.min(CANVAS_W - WALL - previewCurrent.radius, previewCurrent.x));
    ctx.globalAlpha = 0.7;
    drawCircle(ctx, previewX, previewCurrent.y, previewCurrent.radius, previewCurrent.index);
    ctx.globalAlpha = 1.0;
  }
}

function drawCircle(ctx, x, y, r, idx, locked) {
  const f = FRUITS[idx];
  ctx.beginPath(); ctx.arc(x + 2, y + 2, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.fill();
  const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
  g.addColorStop(0, lighten(f.color, 40));
  g.addColorStop(1, f.color);
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = 1.5; ctx.stroke();
  
  // Draw lock indicator for circles above the danger line
  if (locked) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 2; ctx.stroke();
    
    // Draw X mark to indicate locked
    const markSize = r * 0.3;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - markSize, y - markSize);
    ctx.lineTo(x + markSize, y + markSize);
    ctx.moveTo(x + markSize, y - markSize);
    ctx.lineTo(x - markSize, y + markSize);
    ctx.stroke();
  }
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
    // Check if opponent is locked and I have more points → I win
    if (opponentBlocked && score > opponentScore) {
      endGame();
    }
  } else if (msg.type === 'danger-over') {
    // Opponent exceeded the danger line - I win
    if (!gameActive) return;
    gameActive = false;
    clearInterval(timerInterval);
    // My score stays, opponent gets 0 additional
    updateScoreDisplay();
    showResults();
    gameScreen.style.display = 'none';
    resultScreen.style.display = 'flex';
  } else if (msg.type === 'opponent-danger') {
    // I exceeded the danger line - opponent wins
    if (!gameActive) return;
    gameActive = false;
    clearInterval(timerInterval);
    updateScoreDisplay();
    showResults();
    gameScreen.style.display = 'none';
    resultScreen.style.display = 'flex';
  } else if (msg.type === 'game-over') {
    // Only process game-over if game is still active.
    if (!gameActive) return;
    gameActive = false;
    clearInterval(timerInterval);
    // game-over contains sender's perspective: myScore=their score, opponentScore=my score
    // Swap them so they display correctly from receiver's perspective
    score = msg.opponentScore;    // My score = sender's view of me
    opponentScore = msg.myScore;  // Their score = sender's view of themselves
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
  } else if (msg.type === 'lock-update') {
    // Sync locked circles state
    if (msg.lockedIds) {
      for (const id of msg.lockedIds) {
        const circle = enemyCircles.find(c => c.id === id);
        if (circle) {
          circle.locked = true;
          circle.vx = 0;
          circle.vy = 0;
        }
      }
    }
  } else if (msg.type === 'my-locked-update') {
    // Sync my locked circles to opponent
    if (msg.lockedIds) {
      for (const id of msg.lockedIds) {
        const circle = myCircles.find(c => c.id === id);
        if (circle) {
          circle.locked = true;
          circle.vx = 0;
          circle.vy = 0;
        }
      }
    }
  } else if (msg.type === 'opponent-blocked') {
    // Opponent is blocked from placing more fruits
    opponentBlocked = msg.blocked;
    
    // Check instant win: if opponent is locked and I have more points
    if (opponentBlocked && score > opponentScore) {
      endGame();
    }
  } else if (msg.type === 'opponent-wins') {
    // Opponent triggered win because I'm locked and they have more points
    if (!gameActive) return;
    gameActive = false;
    clearInterval(timerInterval);
    // Update scores from opponent's perspective
    score = msg.opponentScore;   // My score = opponent's view of me
    opponentScore = msg.myScore; // Opponent's score = opponent's view of themselves
    updateScoreDisplay();
    showResults();
    gameScreen.style.display = 'none';
    resultScreen.style.display = 'flex';
  } else if (msg.type === 'preview') {
    // Real-time preview position update (from mouse move)
    enemyCurrent = msg;
    enemyDropping = false;
  } else if (msg.type === 'my-state') {
    // Only update preview state from periodic messages (circles run on independent physics)
    if (msg.current !== undefined) {
      enemyCurrent = msg.current;
      enemyDropping = msg.dropping;
    }
  }
}

// Track previously locked IDs to detect new locks
let prevLockedIds = new Set();

// Periodically send my state to opponent
setInterval(() => {
  if (gameActive && dataChannel && dataChannel.readyState === 'open') {
    // Calculate the preview X (same logic as rendering)
    let previewX = null;
    if (current && !dropping) {
      previewX = Math.max(current.radius + WALL, Math.min(CANVAS_W - WALL - current.radius, mouseX));
    }
    
    // Find newly locked circles
    const currentLockedIds = myCircles.filter(c => c.locked).map(c => c.id);
    const newLockedIds = currentLockedIds.filter(id => !prevLockedIds.has(id));
    if (newLockedIds.length > 0) {
      sendPeer({ type: 'lock-update', lockedIds: newLockedIds });
    }
    prevLockedIds = new Set(currentLockedIds);
    
    // Sync opponent blocked status
    const myBlocked = myCircles.some(c => c.locked);
    if (myBlocked !== opponentBlocked) {
      sendPeer({ type: 'my-blocked', blocked: myBlocked });
      opponentBlocked = myBlocked;
    }
    
    sendPeer({
      type: 'my-state',
      circles: myCircles.map(c => ({ x: c.x, y: c.y, vx: c.vx, vy: c.vy, r: c.r, idx: c.idx, locked: c.locked })),
      current: current ? { x: previewX, y: current.y, index: current.index, radius: current.radius } : null,
      dropping: dropping
    });
  }
}, 100);
