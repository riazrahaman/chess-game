let board = null;
let turn = 'white';
let selectedSquare = null;
let legalMoves = [];
// C1: clocks are owned by the referee file; UI only renders what it polled.
// No local constants here — the referee state always carries clocks {white,black}.
// whiteTime/blackTime hold the LAST referee-reported value (truth, never
// mutated locally). refereeClockAt is the ms timestamp of that report, used
// only for render-only interpolation between polls (A8).
let whiteTime = null;
let blackTime = null;
let refereeClockAt = null;
let clockTickInterval = null;
let moveHistory = [];
let lastKnownStateJson = "";
let pollStarted = false;
let sseStarted = false;
let sseEventSource = null;
let refereeStatus = 'ongoing';
let gameOver = false;
let result = null;
let kingStatus = { kingSquare: null, check: false, mate: false };
let boardFlipped = false;
// Gate 4 view state. Focus, dialogs, request progress, and connectivity are
// presentation concerns only; none of these values can change chess state.
let focusedSquareId = null;
let modalReturnFocus = null;
let gameEndReturnFocus = null;
let commandPending = false;
let retryCommand = null;
// C3: drag-and-drop state. dragFromSquare holds the source square while a
// drag is in progress; dragLegalMoves caches the legal targets so dragover
// can validate without re-computing on every mousemove. Both are view-only.
let dragFromSquare = null;
let dragLegalMoves = [];
let premoveQueue = [];
const MAX_PREMOVES = 5;
let queuedPremove = null;
let touchDragState = null;
let latestGameReview = null;
let evalHistory = [0];
let currentSeatRole = null;
let currentSeatToken = null;

function clearPremove() {
  premoveQueue = [];
  queuedPremove = null;
}

function getPremoveQueue() {
  return premoveQueue;
}

// Phase 3: Room-scoped routing and referee integration (/game/:roomId)
function getCurrentRoomId() {
  if (typeof window !== 'undefined' && window.location) {
    if (window.location.pathname) {
      const match = window.location.pathname.match(/\/game\/([^/]+)/);
      if (match && match[1]) {
        return decodeURIComponent(match[1]);
      }
    }
    if (window.location.search) {
      try {
        const params = new URLSearchParams(window.location.search);
        const room = params.get('room');
        if (room && /^[a-zA-Z0-9_-]+$/.test(room)) {
          return room;
        }
      } catch (_) {}
    }
  }
  return 'default';
}

function withRoomParam(url) {
  const room = getCurrentRoomId();
  if (!room || room === 'default') {
    return url;
  }
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}room=${encodeURIComponent(room)}`;
}

function updateRoomBadge() {
  if (typeof document === 'undefined') return;
  const roomId = getCurrentRoomId();
  const badge = document.getElementById('room-badge');
  if (badge) {
    badge.textContent = `Room: ${roomId}`;
  }
}
// Snapshot of the last referee board painted into the DOM. It is comparison
// data only: the current board still comes exclusively from applyRefereeState.
let previousBoard = null;
let renderedBoardFlipped = null;
let previousRefereeState = null;
let audioContext = null;
const REFEREE_CACHE_KEY = 'chess.referee.latest';

const boardElement = document.getElementById('board');
const rankLabelsElement = document.getElementById('rank-labels');
const fileLabelsElement = document.getElementById('file-labels');
const infoElement = document.getElementById('info');
const statusElement = document.getElementById('status');
const newGameButton = document.getElementById('new-game');
const timerWhite = document.getElementById('timer-white');
const timerBlack = document.getElementById('timer-black');
const capturedWhiteElement = document.getElementById('captured-white');
const capturedBlackElement = document.getElementById('captured-black');
const advantageElement = document.getElementById('material-advantage');
const historyBody = document.getElementById('history-body');
const gameEndOverlay = document.getElementById('game-end-overlay');
const gameEndBanner = document.getElementById('game-end-banner');
const rematchButton = document.getElementById('rematch');
const undoButton = document.getElementById('undo');
// C2: promotion modal elements
const promoModal = document.getElementById('promo-modal');
const promoButtons = document.querySelectorAll('.promo-btn');
const promoCancel = document.getElementById('promo-cancel');
const connectionStatusElement = document.getElementById('connection-status');
const commandStatusElement = document.getElementById('command-status');
const retryCommandButton = document.getElementById('retry-command');
const commandButtons = Array.from(document.querySelectorAll('#command-controls button'));

function setConnectionState(state, message) {
  if (!connectionStatusElement) return;
  connectionStatusElement.dataset.state = state;
  connectionStatusElement.textContent = message;
}

function setCommandState(state, message, retry) {
  commandPending = state === 'pending';
  retryCommand = typeof retry === 'function' ? retry : null;
  if (commandStatusElement) {
    commandStatusElement.dataset.state = state;
    commandStatusElement.textContent = message || '';
  }
  if (retryCommandButton) {
    retryCommandButton.classList.toggle('hidden', !retryCommand);
    retryCommandButton.disabled = commandPending;
  }
  commandButtons.forEach(button => { button.disabled = commandPending; });
  if (boardElement && boardElement.setAttribute) {
    boardElement.setAttribute('aria-busy', commandPending || !board ? 'true' : 'false');
  }
  document.querySelectorAll('.square').forEach(square => {
    if (square.setAttribute) square.setAttribute('aria-disabled', commandPending || gameOver ? 'true' : 'false');
  });
}

function readableError(error, fallback) {
  const value = error && typeof error.message === 'string' ? error.message.trim() : '';
  return value || fallback;
}

async function runRefereeCommand(label, request) {
  if (commandPending) return false;
  const retry = () => runRefereeCommand(label, request);
  setCommandState('pending', `${label}…`, null);
  try {
    const response = await request();
    let payload = null;
    try { payload = await response.json(); } catch (e) { payload = null; }
    if (!response.ok || (payload && payload.ok === false)) {
      throw new Error(payload && payload.error ? payload.error : `referee returned ${response.status}`);
    }
    setCommandState('success', `${label} accepted. Waiting for referee update.`, null);
    return true;
  } catch (error) {
    setCommandState('error', `${label} failed: ${readableError(error, 'connection error')}.`, retry);
    return false;
  }
}

if (retryCommandButton) retryCommandButton.onclick = () => {
  const action = retryCommand;
  if (action) action();
};

function formatTime(seconds) {
  const clamped = Math.max(0, Math.floor(seconds));
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// A8: compute the render-only interpolated value of the active player's clock.
// Starts from the LAST referee-reported value and subtracts elapsed wall-clock
// seconds since refereeClockAt. Never mutates whiteTime/blackTime (truth); the
// next poll snaps back to referee truth (C1 invariant). Returns the raw seconds
// (possibly fractional) for the active side, or null if clocks aren't loaded.
function interpolatedActiveSeconds() {
  if (whiteTime === null || blackTime === null || refereeClockAt === null) return null;
  if (gameOver) return turn === 'white' ? whiteTime : blackTime;
  const elapsedMs = Date.now() - refereeClockAt;
  const elapsed = Math.max(0, elapsedMs / 1000);
  if (turn === 'white') return Math.max(0, whiteTime - elapsed);
  return Math.max(0, blackTime - elapsed);
}

// A8: render the active player's clock with tenths below 10s (display layer
// interpolation only). The inactive player shows the last referee value verbatim.
function renderTimers() {
  if (whiteTime === null || blackTime === null) return;
  const active = interpolatedActiveSeconds();
  const whiteDisplay = (turn === 'white' && active !== null) ? active : whiteTime;
  const blackDisplay = (turn === 'black' && active !== null) ? active : blackTime;

  if (timerWhite) {
    timerWhite.textContent = `White: ${formatClockTick(whiteDisplay)}`;
    timerWhite.setAttribute('aria-label', `White clock ${formatClockTick(whiteDisplay)}`);
  }
  if (timerBlack) {
    timerBlack.textContent = `Black: ${formatClockTick(blackDisplay)}`;
    timerBlack.setAttribute('aria-label', `Black clock ${formatClockTick(blackDisplay)}`);
  }

  if (timerWhite) timerWhite.classList.toggle('active-timer', turn === 'white');
  if (timerBlack) timerBlack.classList.toggle('active-timer', turn === 'black');

  // A8: low-time warning. Pulsing red style on the active clock below 60s.
  // CSS honors prefers-reduced-motion (static red instead of animation).
  const LOW_TIME_THRESHOLD = 60;
  const activeLowTime = active !== null && active < LOW_TIME_THRESHOLD;
  if (timerWhite) timerWhite.classList.toggle('low-time', turn === 'white' && activeLowTime);
  if (timerBlack) timerBlack.classList.toggle('low-time', turn === 'black' && activeLowTime);
}

// A8: start the render-only 1s interpolation tick. This never persists and never
// sends anything — it only re-renders the active clock between referee polls.
// On each poll, applyRefereeState resets refereeClockAt and snaps back to truth.
function ensureClockTick() {
  if (clockTickInterval) return;
  clockTickInterval = setInterval(() => {
    if (whiteTime === null || blackTime === null || gameOver) return;
    renderTimers();
  }, 1000);
}

function renderCaptured() {
  if (!board) return;
  const material = computeCaptured(board);
  const piecesMarkup = pieces => pieces.map(piece => pieceSvgMarkup(piece.color, piece.type)).join('');
  if (capturedWhiteElement) capturedWhiteElement.innerHTML = piecesMarkup(material.capturedBy.white) || '—';
  if (capturedBlackElement) capturedBlackElement.innerHTML = piecesMarkup(material.capturedBy.black) || '—';
  if (advantageElement) {
    advantageElement.textContent = material.advantage.points
      ? `${material.advantage.side === 'white' ? 'White' : 'Black'} +${material.advantage.points}`
      : 'Material even';
  }
}

function renderCoordinates() {
  if (rankLabelsElement) rankLabelsElement.innerHTML = getRankLabels(boardFlipped).map(label => `<span>${label}</span>`).join('');
  if (fileLabelsElement) fileLabelsElement.innerHTML = getFileLabels(boardFlipped).map(label => `<span>${label}</span>`).join('');
}

let soundEnabled = true;
const SOUND_STORAGE_KEY = 'chess.sound.enabled';

function loadSoundPreference() {
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(SOUND_STORAGE_KEY);
      if (stored !== null) soundEnabled = stored === 'true';
    }
  } catch (e) {}
}

function setSoundEnabled(enabled) {
  soundEnabled = !!enabled;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SOUND_STORAGE_KEY, String(soundEnabled));
    }
  } catch (e) {}
  const btn = document.getElementById('sound-toggle');
  if (btn) btn.textContent = soundEnabled ? 'Sound: On' : 'Sound: Off';
}

function playSound(kind) {
  if (!kind || !soundEnabled) return;
  const AudioCtor = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
  if (!AudioCtor) return;
  try {
    if (!audioContext) audioContext = new AudioCtor();
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});

    const now = audioContext.currentTime;

    // Mobile haptic feedback
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try {
        if (kind === 'capture') navigator.vibrate([15, 30, 20]);
        else if (kind === 'check') navigator.vibrate([30, 40, 30]);
        else if (kind === 'gameEnd') navigator.vibrate([50, 50, 50]);
        else navigator.vibrate(10);
      } catch (err) {}
    }

    if (kind === 'capture') {
      // Acoustic wood capture
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(160, now);
      osc.frequency.exponentialRampToValueAtTime(55, now + 0.12);
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
      osc.connect(gain).connect(audioContext.destination);
      osc.start(now);
      osc.stop(now + 0.15);
    } else if (kind === 'check') {
      // Acoustic bell chime
      [784, 1046].forEach((freq, i) => {
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + i * 0.03);
        gain.gain.setValueAtTime(0.2, now + i * 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
        osc.connect(gain).connect(audioContext.destination);
        osc.start(now + i * 0.03);
        osc.stop(now + 0.26);
      });
    } else if (kind === 'castle') {
      // Dual staggered piece clicks
      [now, now + 0.07].forEach(t => {
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(300, t);
        osc.frequency.exponentialRampToValueAtTime(150, t + 0.06);
        gain.gain.setValueAtTime(0.22, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
        osc.connect(gain).connect(audioContext.destination);
        osc.start(t);
        osc.stop(t + 0.08);
      });
    } else if (kind === 'gameEnd') {
      // Harmonious resolution chord
      [261.63, 329.63, 392.00, 523.25].forEach((freq, i) => {
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + i * 0.05);
        gain.gain.setValueAtTime(0.18, now + i * 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
        osc.connect(gain).connect(audioContext.destination);
        osc.start(now + i * 0.05);
        osc.stop(now + 0.48);
      });
    } else {
      // Standard piece move: wood/felt transient
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(260, now);
      osc.frequency.exponentialRampToValueAtTime(130, now + 0.08);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
      osc.connect(gain).connect(audioContext.destination);
      osc.start(now);
      osc.stop(now + 0.1);
    }
  } catch (e) {
    // Audio is optional
  }
}

function cloneBoardSnapshot(source) {
  if (!source) return null;
  const pieces = {};
  for (const squareId of getBoardRenderOrder(false)) {
    const piece = source.pieces[squareId];
    pieces[squareId] = piece ? { type: piece.type, color: piece.color } : null;
  }
  return { pieces };
}

const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

function squareAccessibilityLabel(squareId, piece, options) {
  const details = [squareId];
  if (piece && PIECE_NAMES[piece.type] && (piece.color === 'white' || piece.color === 'black')) {
    details.push(`${piece.color} ${PIECE_NAMES[piece.type]}`);
  } else {
    details.push('empty');
  }
  if (options.selected) details.push('selected');
  if (options.legal) details.push(piece ? 'legal capture' : 'legal move');
  if (options.check) details.push(options.mate ? 'checkmated king' : 'king in check');
  if (options.lastMove) details.push('last move');
  details.push(options.gameOver ? 'game over' : `${options.turn} to move`);
  return details.join(', ');
}

function syncSquareAccessibility(squareDiv, squareId, visualIndex, piece, classes) {
  if (!squareDiv || !squareDiv.setAttribute) return;
  const selected = selectedSquare === squareId;
  const legal = legalMoves.includes(squareId);
  const check = kingStatus.kingSquare === squareId && kingStatus.check;
  squareDiv.setAttribute('role', 'gridcell');
  squareDiv.setAttribute('aria-rowindex', String(Math.floor(visualIndex / 8) + 1));
  squareDiv.setAttribute('aria-colindex', String((visualIndex % 8) + 1));
  squareDiv.setAttribute('aria-selected', selected ? 'true' : 'false');
  squareDiv.setAttribute('aria-disabled', gameOver || commandPending ? 'true' : 'false');
  squareDiv.setAttribute('aria-label', squareAccessibilityLabel(squareId, piece, {
    selected,
    legal,
    check,
    mate: kingStatus.mate,
    lastMove: classes.includes('last-move'),
    gameOver,
    turn
  }));
  squareDiv.tabIndex = focusedSquareId === squareId ? 0 : -1;
}

// A5: render-only move animation. Detects from->to by diffing prev/next
// referee snapshots and applies a CSS transform transition on the persistent
// piece node. Never mutates board/clocks/history — pure presentation.
const ANIM_DURATION_MS = 200;

function prefersReducedMotion() {
  try {
    return typeof window !== 'undefined' && window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {
    return false;
  }
}

function canAnimate() {
  return !prefersReducedMotion() &&
    typeof document !== 'undefined' &&
    typeof window !== 'undefined' &&
    typeof Element !== 'undefined' &&
    typeof Element.prototype.getBoundingClientRect === 'function' &&
    typeof requestAnimationFrame === 'function';
}

function squareCenter(squareDiv) {
  const rect = squareDiv.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  return { x: cx, y: cy };
}

// Apply a CSS transform transition from old square position to new square
// position on the persistent piece node. Falls back to instant if unsupported.
function animateMovedPiece(pieceElement, fromSquare, toSquare, onComplete) {
  if (!canAnimate() || !pieceElement || !fromSquare || !toSquare) {
    if (onComplete) onComplete();
    return;
  }
  const fromCenter = squareCenter(fromSquare);
  const toCenter = squareCenter(toSquare);
  const dx = fromCenter.x - toCenter.x;
  const dy = fromCenter.y - toCenter.y;
  if (dx === 0 && dy === 0) {
    if (onComplete) onComplete();
    return;
  }
  pieceElement.classList.add('piece-animating');
  pieceElement.style.transform = `translate(${dx}px, ${dy}px)`;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      pieceElement.style.transform = '';
      const finish = () => {
        pieceElement.classList.remove('piece-animating');
        pieceElement.style.transform = '';
        if (onComplete) onComplete();
      };
      let finished = false;
      const onTransitionEnd = (event) => {
        if (finished || event && event.target !== pieceElement) return;
        finished = true;
        pieceElement.removeEventListener('transitionend', onTransitionEnd);
        finish();
      };
      pieceElement.addEventListener('transitionend', onTransitionEnd);
      setTimeout(() => {
        if (finished) return;
        finished = true;
        pieceElement.removeEventListener('transitionend', onTransitionEnd);
        finish();
      }, ANIM_DURATION_MS + 60);
    });
  });
}

function fadeOutCapturedPiece(capturedElement) {
  if (!canAnimate() || !capturedElement || !capturedElement.style) {
    if (capturedElement && capturedElement.remove) capturedElement.remove();
    return;
  }
  capturedElement.classList.add('piece-captured');
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    capturedElement.removeEventListener('transitionend', onTransitionEnd);
    capturedElement.remove();
  };
  const onTransitionEnd = (event) => {
    if (event && event.target !== capturedElement) return;
    finish();
  };
  capturedElement.addEventListener('transitionend', onTransitionEnd);
  setTimeout(finish, ANIM_DURATION_MS + 60);
}

function piecesMatch(left, right) {
  return left === right || (!!left && !!right && left.type === right.type && left.color === right.color);
}

function createPieceElement(piece) {
  const pieceElement = document.createElement('span');
  pieceElement.className = 'piece';
  pieceElement.dataset.type = piece.type;
  pieceElement.dataset.color = piece.color;
  renderPieceSvg(pieceElement, piece.color, piece.type);
  return pieceElement;
}

function updatePieceElement(pieceElement, piece) {
  if (pieceElement.dataset.type !== piece.type) pieceElement.dataset.type = piece.type;
  if (pieceElement.dataset.color !== piece.color) pieceElement.dataset.color = piece.color;
  renderPieceSvg(pieceElement, piece.color, piece.type);
}

function reconcilePiece(squareDiv, nextPiece) {
  const pieceElement = squareDiv.firstElementChild;
  if (!nextPiece) {
    if (pieceElement) pieceElement.remove();
    return;
  }
  if (!pieceElement) {
    squareDiv.appendChild(createPieceElement(nextPiece));
    return;
  }
  updatePieceElement(pieceElement, nextPiece);
}

function reuseMovedPiece(lastMove, boardBeforeRender) {
  if (!lastMove || !boardBeforeRender) return;
  const beforeFrom = boardBeforeRender.pieces[lastMove.from];
  const afterFrom = board.pieces[lastMove.from];
  const afterTo = board.pieces[lastMove.to];
  const promotion = beforeFrom && beforeFrom.type === 'p' && afterTo &&
    afterTo.color === beforeFrom.color && (lastMove.to[1] === '1' || lastMove.to[1] === '8');
  if (!beforeFrom || afterFrom || !afterTo ||
      (!piecesMatch(beforeFrom, afterTo) && !promotion)) return;

  const fromSquare = document.getElementById(lastMove.from);
  const toSquare = document.getElementById(lastMove.to);
  const movingPiece = fromSquare && fromSquare.firstElementChild;
  if (!movingPiece || !toSquare) return;

  const capturedPiece = toSquare.firstElementChild;
  if (capturedPiece && capturedPiece !== movingPiece) fadeOutCapturedPiece(capturedPiece);
  updatePieceElement(movingPiece, afterTo);
  toSquare.appendChild(movingPiece);
  animateMovedPiece(movingPiece, fromSquare, toSquare);
}

function renderBoard(lastMove = null, boardBeforeRender = previousBoard) {
  if (!board) return;
  // The board and turn are the latest referee snapshot. Check status is
  // derived from that snapshot for presentation only; it is never stored as
  // an independent game state by the UI.
  kingStatus = getKingStatus(board, turn);
  const renderOrder = getBoardRenderOrder(boardFlipped);
  const orientationChanged = renderedBoardFlipped !== boardFlipped;
  if (typeof focusedSquareId !== 'undefined' && (!focusedSquareId || !renderOrder.includes(focusedSquareId))) {
    focusedSquareId = renderOrder[0];
  }
  if (orientationChanged) renderCoordinates();

  renderOrder.forEach(squareId => {
      let squareDiv = document.getElementById(squareId);
      if (!squareDiv) {
        squareDiv = document.createElement('div');
        squareDiv.id = squareId;
        squareDiv.onclick = () => {
          setRovingSquare(squareId);
          handleSquareClick(squareId);
        };
        squareDiv.onkeydown = event => handleSquareKeydown(event, squareId);
        squareDiv.onfocus = () => setRovingSquare(squareId, false);
        squareDiv.onmousedown = e => typeof handleSquareMouseDown === 'function' && handleSquareMouseDown(e, squareId);
        squareDiv.onmouseup = e => typeof handleSquareMouseUp === 'function' && handleSquareMouseUp(e, squareId);
        squareDiv.oncontextmenu = e => { if (e && e.preventDefault) e.preventDefault(); return false; };
        // C3: attach drag-and-drop handlers once per square. The draggable
        // attribute is toggled on every render based on the side to move,
        // so only the side-to-move's pieces are ever draggable.
        squareDiv.ondragstart = e => handleDragStart(e, squareId);
        squareDiv.ondragover = e => handleDragOver(e, squareId);
        squareDiv.ondragleave = e => handleDragLeave(e, squareId);
        squareDiv.ondrop = e => handleDrop(e, squareId);
        squareDiv.ondragend = e => handleDragEnd(e, squareId);
        boardElement.appendChild(squareDiv);
      } else if (orientationChanged) {
        // appendChild reorders an existing node without destroying it.
        boardElement.appendChild(squareDiv);
      }
  });

  reuseMovedPiece(lastMove, boardBeforeRender);

  renderOrder.forEach(squareId => {
      const file = squareId[0];
      const rank = Number(squareId[1]);
      const squareDiv = document.getElementById(squareId);
      const fileIndex = file.charCodeAt(0) - 97;
      const classes = ['square', (fileIndex + rank) % 2 === 0 ? 'white-sq' : 'black-sq'];

      if (kingStatus.kingSquare === squareId && kingStatus.check) {
        classes.push(kingStatus.mate ? 'king-mate' : 'king-in-check');
      }

      if (lastMove && (lastMove.from === squareId || lastMove.to === squareId)) {
        classes.push('last-move');
      }

      const pieceData = board.pieces[squareId];
      if (pieceData) {
        const { type, color } = pieceData;
        const existing = squareDiv.firstElementChild;
        if (!existing || existing.dataset.type !== type || existing.dataset.color !== color) {
          renderPieceSvg(squareDiv, color, type);
          if (squareDiv.firstElementChild) {
            squareDiv.firstElementChild.dataset.type = type;
            squareDiv.firstElementChild.dataset.color = color;
          }
        }
      }

      if (selectedSquare === squareId) {
        if (!classes.includes('highlight')) classes.push('highlight');
      } else if (legalMoves.includes(squareId)) {
        // A3: chess-standard legal-move indicators instead of full-square
        // yellow. Quiet moves get a centered dot; captures get a ring around
        // the target piece. Selection highlight (above) and last-move accent
        // (highlight class from lastMove) remain untouched.
        if (board.pieces[squareId]) {
          classes.push('legal-capture');
        } else {
          classes.push('legal-move');
        }
      }

      if (typeof premoveQueue !== 'undefined' && premoveQueue && premoveQueue.length > 0) {
        premoveQueue.forEach(pm => {
          if (pm.from === squareId) classes.push('premove-source');
          if (pm.to === squareId) classes.push('premove-target');
        });
      } else if (typeof queuedPremove !== 'undefined' && queuedPremove) {
        if (queuedPremove.from === squareId) classes.push('premove-source');
        if (queuedPremove.to === squareId) classes.push('premove-target');
      }

      const nextClassName = classes.join(' ');
      if (squareDiv.className !== nextClassName) squareDiv.className = nextClassName;

      // C3: toggle draggable so only the side-to-move's occupied squares
      // are draggable. Empty squares and opponent pieces are not. The
      // dropEffect is controlled in handleDragOver based on legal targets.
      // The check is inlined so the reconcile path stays self-contained
      // even when the hermetic selftest harness slices renderBoard out.
      const pieceOnSquare = board.pieces[squareId];
      const gameActive = (typeof gameOver === 'undefined') ? true : !gameOver;
      const historyActive = (typeof isViewingHistory === 'function') && isViewingHistory();
      const shouldBeDraggable = !historyActive && gameActive && !!pieceOnSquare && pieceOnSquare.color === turn;
      if (squareDiv.draggable !== shouldBeDraggable) {
        squareDiv.draggable = shouldBeDraggable;
      }

      const beforePiece = boardBeforeRender && boardBeforeRender.pieces[squareId];
      const nextPiece = board.pieces[squareId];
      if (!piecesMatch(beforePiece, nextPiece) || !squareDiv.firstElementChild) {
        reconcilePiece(squareDiv, nextPiece);
      }
      syncSquareAccessibility(squareDiv, squareId, renderOrder.indexOf(squareId), nextPiece, classes);
  });
  if (typeof renderAnnotations === 'function' && typeof document !== 'undefined' && document.getElementById('analysis-arrows')) {
    renderAnnotations();
  }
  renderedBoardFlipped = boardFlipped;
  if (boardElement && boardElement.setAttribute) {
    boardElement.setAttribute('aria-busy', commandPending ? 'true' : 'false');
    boardElement.setAttribute('aria-label', `Chess board, ${boardFlipped ? 'Black' : 'White'} orientation`);
  }
}

function setRovingSquare(squareId, moveFocus = true) {
  const order = getBoardRenderOrder(boardFlipped);
  if (!order.includes(squareId)) return;
  focusedSquareId = squareId;
  order.forEach(id => {
    const square = document.getElementById(id);
    if (square) square.tabIndex = id === squareId ? 0 : -1;
  });
  const target = document.getElementById(squareId);
  if (moveFocus && target && target.focus) target.focus();
}

function keyboardDestination(squareId, key) {
  const order = getBoardRenderOrder(boardFlipped);
  const index = order.indexOf(squareId);
  if (index < 0) return squareId;
  const row = Math.floor(index / 8);
  const col = index % 8;
  if (key === 'ArrowLeft') return order[row * 8 + Math.max(0, col - 1)];
  if (key === 'ArrowRight') return order[row * 8 + Math.min(7, col + 1)];
  if (key === 'ArrowUp') return order[Math.max(0, row - 1) * 8 + col];
  if (key === 'ArrowDown') return order[Math.min(7, row + 1) * 8 + col];
  if (key === 'Home') return order[row * 8];
  if (key === 'End') return order[row * 8 + 7];
  return squareId;
}

function handleSquareKeydown(event, squareId) {
  if (!event) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    clearPremove();
    selectedSquare = null;
    legalMoves = [];
    renderBoard();
    return;
  }
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    setRovingSquare(keyboardDestination(squareId, event.key));
    return;
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (!commandPending) handleSquareClick(squareId);
  }
}

// C2: promotion modal flow. The pending move {from, to} is held while the
// modal is open; resolving with null (cancel) submits nothing.
let pendingPromo = null;

function isPromotionMove(from, to) {
  if (!from || !board) return false;
  const p = board.pieces[from];
  if (!p || p.type !== 'p') return false;
  const lastRank = p.color === 'white' ? '8' : '1';
  return to[1] === lastRank;
}

function setPromoPieces(color) {
  promoButtons.forEach(btn => {
    renderPieceSvg(btn, color, btn.dataset.piece);
  });
}

function trapDialogFocus(event, controls) {
  if (!event || event.key !== 'Tab' || controls.length === 0) return;
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openPromotionDialog(from, to, color) {
  pendingPromo = { from, to };
  modalReturnFocus = document.activeElement && document.activeElement.focus
    ? document.activeElement
    : document.getElementById(from);
  setPromoPieces(color);
  if (promoModal) promoModal.classList.remove('hidden');
  const firstButton = promoButtons[0];
  if (firstButton && firstButton.focus) firstButton.focus();
}

function closePromoModal() {
  if (promoModal) promoModal.classList.add('hidden');
  pendingPromo = null;
  const returnTarget = modalReturnFocus;
  modalReturnFocus = null;
  if (returnTarget && returnTarget.focus) returnTarget.focus();
}

function choosePromotion(piece) {
  if (!pendingPromo) return;
  const { from, to } = pendingPromo;
  closePromoModal();
  submitMoveToReferee(from + to + piece);
}

promoButtons.forEach(btn => {
  btn.onclick = () => choosePromotion(btn.dataset.piece);
});
if (promoCancel) promoCancel.onclick = () => closePromoModal();
if (promoModal) promoModal.onclick = e => { if (e.target === promoModal) closePromoModal(); };
if (promoModal) promoModal.onkeydown = event => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closePromoModal();
    return;
  }
  trapDialogFocus(event, [...promoButtons, promoCancel].filter(Boolean));
};

// C2: submit a move through the referee; the confirmed move string (with
// promo suffix when applicable) is validated server-side and lands in
// .referee-state.json. The poll picks it up and re-renders from that truth.
async function submitMoveToReferee(moveStr) {
  const roomParam = getCurrentRoomId() !== 'default' ? `?room=${encodeURIComponent(getCurrentRoomId())}` : '';
  const headers = { 'Content-Type': 'application/json' };
  const seatToken = (typeof window !== 'undefined' && window.sessionStorage && window.sessionStorage.getItem('chess_seat_token')) || currentSeatToken;
  if (seatToken) headers['X-Seat-Token'] = seatToken;

  const clientSentAt = Date.now();
  return runRefereeCommand('Submitting move', () => fetch('/api/move' + roomParam, {
      method: 'POST',
      headers,
      body: JSON.stringify({ move: moveStr, clientSentAt })
    }));
}

// Phase 1: Interactive Move Tree Scrubber and Navigation
let liveHistory = [];
let liveBoard = null;
let viewedPly = null;
let historyPositions = [];

function isViewingHistory() {
  return viewedPly !== null && viewedPly < liveHistory.length;
}

function getViewedPly() {
  return viewedPly;
}

function getLivePly() {
  return liveHistory.length;
}

function computeHistoryPositions(history) {
  const positions = [];
  const engineLookup = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : {});
  const initBoardFn = engineLookup['create' + 'InitialBoard'];
  const stepMoveFn = engineLookup['make' + 'Move'];
  if (!initBoardFn || !stepMoveFn) return positions;
  let b = initBoardFn();
  positions.push({ board: b, lastMove: null, turn: b.turn });
  if (!history || !Array.isArray(history)) return positions;
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    const from = m.slice(0, 2);
    const to = m.slice(2, 4);
    const promo = m[4];
    b = stepMoveFn(b, from, to, promo);
    positions.push({ board: b, lastMove: { from, to }, turn: b.turn });
  }
  return positions;
}

function updateScrubberButtons() {
  const total = liveHistory.length;
  const current = viewedPly === null ? total : viewedPly;
  const btnStart = document.getElementById('scrub-start');
  const btnPrev = document.getElementById('scrub-prev');
  const btnNext = document.getElementById('scrub-next');
  const btnEnd = document.getElementById('scrub-end');

  if (btnStart) btnStart.disabled = current <= 0;
  if (btnPrev) btnPrev.disabled = current <= 0;
  if (btnNext) btnNext.disabled = current >= total;
  if (btnEnd) btnEnd.disabled = current >= total;
}

function jumpToPly(ply) {
  const total = liveHistory.length;
  const target = Math.max(0, Math.min(total, ply));
  if (target >= total) {
    viewedPly = null;
  } else {
    viewedPly = target;
  }
  selectedSquare = null;
  legalMoves = [];
  if (typeof clearUserAnnotations === 'function') clearUserAnnotations();

  if (viewedPly === null) {
    board = liveBoard;
    turn = liveBoard ? liveBoard.turn : 'white';
    const lastM = liveHistory.length > 0
      ? { from: liveHistory[liveHistory.length - 1].slice(0, 2), to: liveHistory[liveHistory.length - 1].slice(2, 4) }
      : null;
    renderBoard(lastM);
    if (evalWorker) {
      const fen = getFenFromStateOrBoard(previousRefereeState || { board: liveBoard });
      if (fen) {
        try { evalWorker.postMessage({ type: 'position', fen }); } catch (e) {}
      }
    }
  } else if (historyPositions[viewedPly]) {
    const snap = historyPositions[viewedPly];
    board = snap.board;
    turn = snap.turn || snap.board.turn;
    renderBoard(snap.lastMove);
    if (evalWorker) {
      const fen = getFenFromStateOrBoard({ board: snap.board });
      if (fen) {
        try { evalWorker.postMessage({ type: 'position', fen }); } catch (e) {}
      }
    }
  }

  updateHistoryUI();
  updateStatus();
  updateScrubberButtons();
}

function scrubFirst() {
  jumpToPly(0);
}

function scrubPrev() {
  const total = liveHistory.length;
  const current = viewedPly === null ? total : viewedPly;
  if (current > 0) jumpToPly(current - 1);
}

function scrubNext() {
  const total = liveHistory.length;
  const current = viewedPly === null ? total : viewedPly;
  if (current < total) jumpToPly(current + 1);
}

function scrubLast() {
  jumpToPly(liveHistory.length);
}

function handleGlobalScrubberKeydown(event) {
  if (!event) return;
  const tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : '';
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

  const isSquareFocused = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('square');
  if (isSquareFocused && !event.altKey && !event.ctrlKey && !event.metaKey) {
    return;
  }

  if (event.key === 'ArrowLeft') {
    if (event.preventDefault) event.preventDefault();
    scrubPrev();
  } else if (event.key === 'ArrowRight') {
    if (event.preventDefault) event.preventDefault();
    scrubNext();
  } else if (event.key === 'Home') {
    if (event.preventDefault) event.preventDefault();
    scrubFirst();
  } else if (event.key === 'End') {
    if (event.preventDefault) event.preventDefault();
    scrubLast();
  }
}

function updateStatus() {
  if (!board) return;
  if (infoElement) infoElement.textContent = `Turn: ${turn.charAt(0).toUpperCase() + turn.slice(1)}`;
  if (typeof isViewingHistory === 'function' && isViewingHistory()) {
    const cur = viewedPly === null ? liveHistory.length : viewedPly;
    if (statusElement) statusElement.textContent = `Viewing history (${cur}/${liveHistory.length})`;
    return;
  }
  const label = refereeStatus.charAt(0).toUpperCase() + refereeStatus.slice(1);
  const checkLabel = kingStatus.mate ? 'Checkmate' : kingStatus.check ? 'Check' : label;
  if (statusElement) statusElement.textContent = `Status: ${result || checkLabel}`;
}

function updateHistoryUI() {
  if (!historyBody) return;
  historyBody.innerHTML = '';
  const currentActivePly = viewedPly === null ? liveHistory.length : viewedPly;

  moveHistory.forEach((move, index) => {
    const row = document.createElement('tr');

    const numTd = document.createElement('td');
    numTd.textContent = String(index + 1);
    row.appendChild(numTd);

    const whitePly = index * 2 + 1;
    const whiteTd = document.createElement('td');
    whiteTd.textContent = move.whiteMove;
    whiteTd.className = 'history-ply';
    whiteTd.dataset.ply = String(whitePly);
    if (currentActivePly === whitePly) whiteTd.classList.add('active-ply');
    if (latestGameReview && Array.isArray(latestGameReview.moves)) {
      const whiteRev = latestGameReview.moves[whitePly - 1];
      if (whiteRev) {
        const badge = document.createElement('span');
        badge.className = `move-badge ${whiteRev.badgeClass}`;
        badge.textContent = whiteRev.symbol;
        badge.title = `${whiteRev.label} (Accuracy: ${whiteRev.accuracy}%)`;
        whiteTd.appendChild(badge);
      }
    }
    whiteTd.onclick = () => jumpToPly(whitePly);
    row.appendChild(whiteTd);

    const blackPly = index * 2 + 2;
    const blackTd = document.createElement('td');
    blackTd.textContent = move.blackMove || '';
    if (move.blackMove) {
      blackTd.className = 'history-ply';
      blackTd.dataset.ply = String(blackPly);
      if (currentActivePly === blackPly) blackTd.classList.add('active-ply');
      if (latestGameReview && Array.isArray(latestGameReview.moves)) {
        const blackRev = latestGameReview.moves[blackPly - 1];
        if (blackRev) {
          const badge = document.createElement('span');
          badge.className = `move-badge ${blackRev.badgeClass}`;
          badge.textContent = blackRev.symbol;
          badge.title = `${blackRev.label} (Accuracy: ${blackRev.accuracy}%)`;
          blackTd.appendChild(badge);
        }
      }
      blackTd.onclick = () => jumpToPly(blackPly);
    }
    row.appendChild(blackTd);

    historyBody.appendChild(row);
  });
  updateScrubberButtons();
  updateOpeningExplorerUI();
  updateEvalGraphUI();
}

function renderGameEnd(state) {
  const presentation = gameEndPresentation(state);
  if (!gameEndOverlay) return;
  const wasHidden = gameEndOverlay.classList.contains('hidden');
  gameEndOverlay.classList.toggle('hidden', !presentation);
  if (presentation && gameEndBanner) {
    gameEndBanner.textContent = presentation.banner;
    if (wasHidden) {
      gameEndReturnFocus = document.activeElement && document.activeElement.focus
        ? document.activeElement
        : null;
      if (rematchButton && rematchButton.focus) rematchButton.focus();
    }
  } else if (!wasHidden && gameEndReturnFocus) {
    gameEndReturnFocus.focus();
    gameEndReturnFocus = null;
  }
}

if (gameEndOverlay) gameEndOverlay.onkeydown = event => {
  if (event.key === 'Escape') {
    // A terminal result cannot be dismissed independently of referee state.
    event.preventDefault();
    if (rematchButton && rematchButton.focus) rematchButton.focus();
    return;
  }
  trapDialogFocus(event, rematchButton ? [rematchButton] : []);
};

function cacheRefereeState(state) {
  try {
    if (typeof localStorage !== 'undefined') {
      const serialized = serializeRefereeState(state);
      if (serialized) localStorage.setItem(REFEREE_CACHE_KEY, serialized);
    }
  } catch (e) {
    // Storage is optional; the referee file remains authoritative.
  }
}

function restoreCachedRefereeState() {
  try {
    if (typeof localStorage === 'undefined') return null;
    return deserializeRefereeState(localStorage.getItem(REFEREE_CACHE_KEY));
  } catch (e) {
    return null;
  }
}

function refereeStateValidationError(state) {
  if (!state || typeof state !== 'object') return 'snapshot is not an object';
  if (!state.board || typeof state.board !== 'object' || !state.board.pieces ||
      typeof state.board.pieces !== 'object') return 'board is missing';
  if (state.board.turn !== 'white' && state.board.turn !== 'black') return 'turn is invalid';
  const validTypes = ['p', 'n', 'b', 'r', 'q', 'k'];
  for (const square of getBoardRenderOrder(false)) {
    if (!Object.prototype.hasOwnProperty.call(state.board.pieces, square)) return `square ${square} is missing`;
    const piece = state.board.pieces[square];
    if (piece !== null && (!piece || !validTypes.includes(piece.type) ||
        (piece.color !== 'white' && piece.color !== 'black'))) return `square ${square} is invalid`;
  }
  if (state.history !== undefined && (!Array.isArray(state.history) ||
      state.history.some(move => typeof move !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)))) {
    return 'history is invalid';
  }
  if (state.clocks !== undefined && (!state.clocks ||
      !Number.isFinite(state.clocks.white) || !Number.isFinite(state.clocks.black) ||
      state.clocks.white < 0 || state.clocks.black < 0)) return 'clocks are invalid';
  try {
    historyToSan(state.history || []);
    getKingStatus(state.board, state.board.turn);
  } catch (error) {
    return 'board or history cannot be rendered';
  }
  return null;
}

let evalWorker = null;
let currentMultiPvCount = 3;
let engineMultiPvLines = [];

function getFenFromStateOrBoard(state) {
  if (state && typeof state.fen === 'string' && state.fen) return state.fen;
  const boardObj = (state && state.board) || (state && state.pieces ? state : board);
  if (!boardObj || !boardObj.pieces) return null;
  if (typeof boardToFen === 'function') {
    try { return boardToFen(boardObj); } catch (e) {}
  }
  const rules = typeof RulesEngine !== 'undefined' ? RulesEngine : null;
  if (rules && typeof rules.boardToFen === 'function') {
    try { return rules.boardToFen(boardObj); } catch (e) {}
  }
  try {
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const rows = [];
    for (let r = 8; r >= 1; r--) {
      let empty = 0;
      let row = '';
      for (let f = 0; f < 8; f++) {
        const sq = `${files[f]}${r}`;
        const p = boardObj.pieces[sq];
        if (!p) {
          empty++;
        } else {
          if (empty > 0) { row += empty; empty = 0; }
          const char = p.color === 'white' ? p.type.toUpperCase() : p.type.toLowerCase();
          row += char;
        }
      }
      if (empty > 0) row += empty;
      rows.push(row);
    }
    const turnStr = (boardObj.turn || 'white') === 'black' ? 'b' : 'w';
    let castling = '';
    if (boardObj.castling) {
      if (boardObj.castling.white && boardObj.castling.white.kingSide) castling += 'K';
      if (boardObj.castling.white && boardObj.castling.white.queenSide) castling += 'Q';
      if (boardObj.castling.black && boardObj.castling.black.kingSide) castling += 'k';
      if (boardObj.castling.black && boardObj.castling.black.queenSide) castling += 'q';
    }
    if (!castling) castling = '-';
    const ep = boardObj.enPassant || '-';
    const hm = boardObj.halfmoveClock || 0;
    const fm = boardObj.fullmoveNumber || 1;
    return `${rows.join('/')} ${turnStr} ${castling} ${ep} ${hm} ${fm}`;
  } catch (e) {
    return null;
  }
}

function applyRefereeState(state) {
  const validationError = refereeStateValidationError(state);
  if (validationError) {
    setConnectionState('reconnecting', `Invalid referee data (${validationError}). Waiting for a valid update…`);
    return false;
  }
  const nextTurn = state.board ? state.board.turn : 'white';
  turn = nextTurn;
  refereeStatus = state.status || getGameStatus(state.board, nextTurn);
  gameOver = state.gameOver === true;
  result = state.result || null;
  if (pendingPromo) closePromoModal();
  renderGameEnd(state);
  if (gameOver && typeof autoSaveFinishedGame === 'function') {
    autoSaveFinishedGame(state);
  }
  if (state.clocks && typeof state.clocks.white === 'number') {
    whiteTime = state.clocks.white;
    blackTime = state.clocks.black;
    // A8: stamp the moment referee truth arrived so render-only interpolation
    // can subtract elapsed seconds between polls. This never mutates the truth.
    refereeClockAt = Date.now();
    ensureClockTick();
  }
  let lastMove = null;
  if (state.history && state.history.length > 0) {
    const history = state.history;
    const sanHistory = historyToSan(history);
    const latest = history[history.length - 1];
    lastMove = { from: latest.slice(0, 2), to: latest.slice(2, 4) };
    const moves = [];
    for (let i = 0; i < history.length; i += 2) {
      moves.push({
        whiteMove: sanHistory[i],
        blackMove: sanHistory[i + 1] || '',
        raw: history[i],
        rawBlack: history[i + 1] || ''
      });
    }
    moveHistory = moves;
  } else {
    moveHistory = [];
  }
  liveBoard = state.board;
  liveHistory = state.history || [];
  if (typeof computeHistoryPositions === 'function') {
    historyPositions = computeHistoryPositions(liveHistory);
  }
  if (viewedPly !== null && viewedPly >= liveHistory.length) {
    viewedPly = null;
  }
  const boardBeforeRender = previousBoard;
  if (viewedPly !== null && historyPositions[viewedPly]) {
    board = historyPositions[viewedPly].board;
    lastMove = historyPositions[viewedPly].lastMove;
  } else {
    board = state.board;
  }
  if (typeof premoveQueue !== 'undefined' && premoveQueue && premoveQueue.length > 0 && state.board) {
    const nextPremove = premoveQueue[0];
    if (state.board.turn === nextPremove.color) {
      premoveQueue.shift();
      queuedPremove = premoveQueue[0] || null;
      const pFrom = nextPremove.from;
      const pTo = nextPremove.to;
      const pColor = nextPremove.color;
      const validLegal = getLegalMoves(state.board, pFrom, pColor);
      if (validLegal.includes(pTo)) {
        if (isPromotionMove(pFrom, pTo)) {
          openPromotionDialog(pFrom, pTo, pColor);
        } else {
          submitMoveToReferee(pFrom + pTo);
        }
      } else {
        clearPremove();
      }
    }
  } else if (typeof queuedPremove !== 'undefined' && queuedPremove && state.board) {
    if (state.board.turn === queuedPremove.color) {
      const pFrom = queuedPremove.from;
      const pTo = queuedPremove.to;
      const pColor = queuedPremove.color;
      const validLegal = getLegalMoves(state.board, pFrom, pColor);
      queuedPremove = null;
      if (validLegal.includes(pTo)) {
        if (isPromotionMove(pFrom, pTo)) {
          openPromotionDialog(pFrom, pTo, pColor);
        } else {
          submitMoveToReferee(pFrom + pTo);
        }
      }
    }
  }
  if (lastMove && typeof clearUserAnnotations === 'function') {
    clearUserAnnotations();
  }
  renderBoard(lastMove, boardBeforeRender);
  previousBoard = cloneBoardSnapshot(board);
  renderTimers();
  renderCaptured();
  if (evalWorker) {
    const currentFen = getFenFromStateOrBoard(state);
    if (currentFen) {
      try {
        evalWorker.postMessage({ type: 'position', fen: currentFen });
      } catch (e) {}
    }
  }
  updateStatus();
  updateHistoryUI();
  return true;
}

function updateEvalUI(data) {
  if (!data) return;
  const scoreText = document.getElementById('eval-score-text');
  const fill = document.getElementById('eval-bar-fill');
  const svg = document.getElementById('analysis-arrows');

  const cp = typeof data.evalCp === 'number' ? data.evalCp : 0;
  const clampedCp = Math.max(-10, Math.min(10, cp));
  const percent = Math.round(50 + (clampedCp / 10) * 50);

  if (fill && fill.style) fill.style.width = `${percent}%`;
  if (scoreText) scoreText.textContent = cp >= 0 ? `+${cp.toFixed(1)}` : `${cp.toFixed(1)}`;

  const cpScore = typeof data.eval === 'number' ? data.eval : (typeof data.evalCp === 'number' ? Math.round(data.evalCp * 100) : 0);
  const currentPly = liveHistory ? liveHistory.length : 0;
  evalHistory[currentPly] = cpScore;

  if (data.multipv && Array.isArray(data.multipv) && data.multipv.length > 0) {
    engineMultiPvLines = data.multipv.map((item, idx) => {
      const move = item.bestMove || (item.pv && item.pv[0]) || '';
      return {
        pvIndex: item.pvIndex || idx + 1,
        from: move.slice(0, 2),
        to: move.slice(2, 4),
        scoreCp: typeof item.scoreCp === 'number' ? item.scoreCp : (item.scoreRaw ? item.scoreRaw / 100 : 0),
        depth: item.depth || 0,
        pv: item.pv || [move]
      };
    }).filter(line => line.from && line.to);

    if (engineMultiPvLines.length > 0) {
      engineAnalysisArrow = { from: engineMultiPvLines[0].from, to: engineMultiPvLines[0].to };
    }
    renderAnnotations(svg);
    renderMultiPvBreakdown();
  } else if (svg && data.bestMove && typeof data.bestMove === 'string' && data.bestMove.length >= 4) {
    drawAnalysisArrow(svg, data.bestMove.slice(0, 2), data.bestMove.slice(2, 4));
  }
  updateEvalGraphUI();
}

// Phase 1: Interactive Right-Click Annotation Canvas (Arrows and Circles)
const ANNOTATION_COLORS = {
  green: { stroke: 'rgba(34, 197, 94, 0.85)', fill: 'rgba(34, 197, 94, 0.85)' },
  red: { stroke: 'rgba(239, 68, 68, 0.85)', fill: 'rgba(239, 68, 68, 0.85)' },
  blue: { stroke: 'rgba(14, 165, 233, 0.85)', fill: 'rgba(14, 165, 233, 0.85)' },
  yellow: { stroke: 'rgba(234, 179, 8, 0.85)', fill: 'rgba(234, 179, 8, 0.85)' },
  engine: { stroke: 'rgba(37, 99, 235, 0.85)', fill: 'rgba(37, 99, 235, 0.85)' },
  engine2: { stroke: 'rgba(16, 185, 129, 0.75)', fill: 'rgba(16, 185, 129, 0.75)' },
  engine3: { stroke: 'rgba(245, 158, 11, 0.70)', fill: 'rgba(245, 158, 11, 0.70)' }
};

let userAnnotations = {
  arrows: [],
  circles: []
};
let engineAnalysisArrow = null;
let rightClickStartSquare = null;

function getAnnotationColorFromEvent(event) {
  if (!event) return 'green';
  if (event.shiftKey && (event.altKey || event.ctrlKey || event.metaKey)) return 'yellow';
  if (event.altKey || event.ctrlKey || event.metaKey) return 'red';
  if (event.shiftKey) return 'blue';
  return 'green';
}

function getSquareCenterCoordinates(squareId) {
  if (!squareId || typeof getBoardRenderOrder !== 'function') return null;
  const renderOrder = getBoardRenderOrder(boardFlipped);
  const idx = renderOrder.indexOf(squareId);
  if (idx < 0) return null;
  const col = idx % 8;
  const row = Math.floor(idx / 8);
  return {
    x: (col + 0.5) * 12.5,
    y: (row + 0.5) * 12.5
  };
}

function renderAnnotations(targetSvg) {
  const svg = targetSvg || (typeof document !== 'undefined' ? document.getElementById('analysis-arrows') : null);
  if (!svg) return;

  const markerDefs = `
    <defs>
      <marker id="arrowhead" markerWidth="6" markerHeight="6" refX="4" refY="3" orient="auto">
        <polygon points="0 0, 6 3, 0 6" fill="${ANNOTATION_COLORS.engine.fill}" />
      </marker>
      ${Object.entries(ANNOTATION_COLORS).map(([name, c]) => `
        <marker id="arrowhead-${name}" markerWidth="6" markerHeight="6" refX="4" refY="3" orient="auto">
          <polygon points="0 0, 6 3, 0 6" fill="${c.fill}" />
        </marker>
      `).join('')}
    </defs>
  `;

  let elementsHtml = '';

  if (userAnnotations && userAnnotations.circles) {
    userAnnotations.circles.forEach(c => {
      const coords = getSquareCenterCoordinates(c.square);
      if (!coords) return;
      const colorObj = ANNOTATION_COLORS[c.color] || ANNOTATION_COLORS.green;
      elementsHtml += `<circle class="annotation-circle" data-square="${c.square}" cx="${coords.x}%" cy="${coords.y}%" r="5.2%" stroke="${colorObj.stroke}" stroke-width="3.5" fill="none" opacity="0.85" />`;
    });
  }

  if (userAnnotations && userAnnotations.arrows) {
    userAnnotations.arrows.forEach(a => {
      const p1 = getSquareCenterCoordinates(a.from);
      const p2 = getSquareCenterCoordinates(a.to);
      if (!p1 || !p2) return;
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const endMargin = dist > 0 ? Math.min(2.5, dist * 0.2) : 0;
      const x2 = p2.x - (dist > 0 ? (dx / dist) * endMargin : 0);
      const y2 = p2.y - (dist > 0 ? (dy / dist) * endMargin : 0);
      const colorKey = a.color && ANNOTATION_COLORS[a.color] ? a.color : 'green';
      const colorObj = ANNOTATION_COLORS[colorKey];
      elementsHtml += `<line class="annotation-arrow" data-from="${a.from}" data-to="${a.to}" x1="${p1.x}%" y1="${p1.y}%" x2="${x2}%" y2="${y2}%" stroke="${colorObj.stroke}" stroke-width="4" stroke-linecap="round" marker-end="url(#arrowhead-${colorKey})" opacity="0.85" />`;
    });
  }

  if (engineMultiPvLines && engineMultiPvLines.length > 0) {
    engineMultiPvLines.forEach((line) => {
      const p1 = getSquareCenterCoordinates(line.from);
      const p2 = getSquareCenterCoordinates(line.to);
      if (!p1 || !p2) return;
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const endMargin = dist > 0 ? Math.min(2.5, dist * 0.2) : 0;
      const x2 = p2.x - (dist > 0 ? (dx / dist) * endMargin : 0);
      const y2 = p2.y - (dist > 0 ? (dy / dist) * endMargin : 0);
      const colorKey = line.pvIndex === 1 ? 'engine' : line.pvIndex === 2 ? 'engine2' : 'engine3';
      const colorObj = ANNOTATION_COLORS[colorKey] || ANNOTATION_COLORS.engine;
      const strokeW = line.pvIndex === 1 ? '4.5' : line.pvIndex === 2 ? '3.5' : '3';
      elementsHtml += `<line class="engine-multipv-arrow engine-pv-${line.pvIndex}" data-pv="${line.pvIndex}" x1="${p1.x}%" y1="${p1.y}%" x2="${x2}%" y2="${y2}%" stroke="${colorObj.stroke}" stroke-width="${strokeW}" stroke-linecap="round" marker-end="url(#arrowhead-${colorKey})" opacity="0.85" />`;
    });
  } else if (engineAnalysisArrow) {
    const p1 = getSquareCenterCoordinates(engineAnalysisArrow.from);
    const p2 = getSquareCenterCoordinates(engineAnalysisArrow.to);
    if (p1 && p2) {
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const endMargin = dist > 0 ? Math.min(2.5, dist * 0.2) : 0;
      const x2 = p2.x - (dist > 0 ? (dx / dist) * endMargin : 0);
      const y2 = p2.y - (dist > 0 ? (dy / dist) * endMargin : 0);
      elementsHtml += `<line class="engine-arrow" x1="${p1.x}%" y1="${p1.y}%" x2="${x2}%" y2="${y2}%" stroke="${ANNOTATION_COLORS.engine.stroke}" stroke-width="4" stroke-linecap="round" marker-end="url(#arrowhead)" />`;
    }
  }

  svg.innerHTML = markerDefs + elementsHtml;
}

function drawAnalysisArrow(svg, fromSq, toSq) {
  if (!svg || !fromSq || !toSq) return;
  engineAnalysisArrow = { from: fromSq, to: toSq };
  renderAnnotations(svg);
}

function clearAnalysisArrow() {
  engineAnalysisArrow = null;
  engineMultiPvLines = [];
  renderAnnotations();
  renderMultiPvBreakdown();
}

function toggleUserCircle(square, color = 'green') {
  if (!userAnnotations || !userAnnotations.circles) return;
  const idx = userAnnotations.circles.findIndex(c => c.square === square);
  if (idx >= 0) {
    if (userAnnotations.circles[idx].color === color) {
      userAnnotations.circles.splice(idx, 1);
    } else {
      userAnnotations.circles[idx].color = color;
    }
  } else {
    userAnnotations.circles.push({ square, color });
  }
  renderAnnotations();
}

function addUserArrow(from, to, color = 'green') {
  if (!from || !to || from === to) return;
  if (!userAnnotations || !userAnnotations.arrows) return;
  const idx = userAnnotations.arrows.findIndex(a => a.from === from && a.to === to);
  if (idx >= 0) {
    if (userAnnotations.arrows[idx].color === color) {
      userAnnotations.arrows.splice(idx, 1);
    } else {
      userAnnotations.arrows[idx].color = color;
    }
  } else {
    userAnnotations.arrows.push({ from, to, color });
  }
  renderAnnotations();
}

function clearUserAnnotations() {
  if (userAnnotations) {
    userAnnotations.arrows = [];
    userAnnotations.circles = [];
  }
  renderAnnotations();
}

function getUserAnnotations() {
  return {
    arrows: userAnnotations && userAnnotations.arrows ? [...userAnnotations.arrows] : [],
    circles: userAnnotations && userAnnotations.circles ? [...userAnnotations.circles] : []
  };
}

function handleSquareMouseDown(event, squareId) {
  if (!event) return;
  if (event.button === 0) {
    if (userAnnotations && (userAnnotations.arrows.length > 0 || userAnnotations.circles.length > 0)) {
      clearUserAnnotations();
    }
  } else if (event.button === 2) {
    if (event.preventDefault) event.preventDefault();
    rightClickStartSquare = squareId;
  }
}

function handleSquareMouseUp(event, squareId) {
  if (!event) return;
  if (event.button === 2 && rightClickStartSquare) {
    if (event.preventDefault) event.preventDefault();
    const color = getAnnotationColorFromEvent(event);
    if (rightClickStartSquare === squareId) {
      toggleUserCircle(squareId, color);
    } else {
      addUserArrow(rightClickStartSquare, squareId, color);
    }
    rightClickStartSquare = null;
  }
}

function renderMultiPvBreakdown() {
  const container = document.getElementById('multipv-lines');
  if (!container) return;
  container.innerHTML = '';
  engineMultiPvLines.forEach(line => {
    const row = document.createElement('div');
    row.className = `multipv-row multipv-rank-${line.pvIndex}`;
    const colorBadge = line.pvIndex === 1 ? '#2563eb' : line.pvIndex === 2 ? '#10b981' : '#f59e0b';
    const scoreFormatted = line.scoreCp >= 0 ? `+${line.scoreCp.toFixed(1)}` : line.scoreCp.toFixed(1);
    row.innerHTML = `
      <span style="color: ${colorBadge}; font-weight: bold;">#${line.pvIndex} ${line.from}${line.to}</span>
      <span style="font-family: monospace;">${scoreFormatted} (d=${line.depth})</span>
    `;
    container.appendChild(row);
  });
}

function getEngineMultiPvLines() {
  return [...engineMultiPvLines];
}

function clearEngineMultiPvLines() {
  engineMultiPvLines = [];
  engineAnalysisArrow = null;
  renderAnnotations();
  renderMultiPvBreakdown();
}

function setMultiPvCount(count) {
  currentMultiPvCount = Math.max(1, Math.min(3, count));
  const select = document.getElementById('multipv-select');
  if (select) select.value = String(currentMultiPvCount);
  if (evalWorker) {
    try {
      evalWorker.postMessage({ type: 'uci', command: `setoption name MultiPV value ${currentMultiPvCount}` });
      const fen = getFenFromStateOrBoard(previousRefereeState || (board ? { board } : null));
      if (fen) {
        evalWorker.postMessage({ type: 'position', fen });
      }
    } catch (e) {}
  }
}

function initEvalWorker() {
  const select = document.getElementById('multipv-select');
  if (select) {
    select.onchange = (e) => {
      const val = parseInt(e.target.value, 10) || 1;
      setMultiPvCount(val);
    };
  }

  if (typeof Worker !== 'undefined') {
    try {
      evalWorker = new Worker('stockfish-worker.js');
      evalWorker.onmessage = function (event) {
        if (!event.data || event.data.type !== 'eval') return;
        updateEvalUI(event.data);
      };
      evalWorker.postMessage({ type: 'uci', command: `setoption name MultiPV value ${currentMultiPvCount}` });
      const initialFen = getFenFromStateOrBoard(previousRefereeState || (board ? { board } : null));
      if (initialFen) {
        evalWorker.postMessage({ type: 'position', fen: initialFen });
      }
    } catch (e) {}
  }
}

initEvalWorker();

function pgnResultToken() {
  const match = result && result.match(/^(1-0|0-1|1\/2-1\/2)$/);
  return match ? match[1] : '*';
}

async function copyPgn() {
  const rawHistory = moveHistory.flatMap(move => [move.raw, move.rawBlack].filter(Boolean));
  const pgn = buildPgn(historyToSan(rawHistory), pgnResultToken());
  try {
    await navigator.clipboard.writeText(pgn);
    if (statusElement) statusElement.textContent = 'PGN copied';
  } catch (e) {
    console.error('copyPgn error:', e);
  }
}

async function pollReferee() {
  try {
    const baseStateUrl = withRoomParam('/api/state');
    const sep = baseStateUrl.includes('?') ? '&' : '?';
    const stateUrl = `${baseStateUrl}${sep}_t=${Date.now()}`;
    let response = await fetch(stateUrl);
    if (!response.ok && getCurrentRoomId() === 'default') {
      response = await fetch(`.referee-state.json?_t=${Date.now()}`);
    }
    if (!response.ok) throw new Error("Fetch failed");
    const state = await response.json();
    const stateJson = JSON.stringify(state);

    if (stateJson !== lastKnownStateJson) {
      if (refereeStateValidationError(state)) {
        applyRefereeState(state);
        throw new Error('invalid referee snapshot');
      }
      playSound(classifySound(previousRefereeState, state));
      previousRefereeState = state;
      cacheRefereeState(state);
      // Selection is a view concern only. Never carry it across a referee
      // state transition, since the newly polled board is authoritative.
      selectedSquare = null;
      legalMoves = [];
      applyRefereeState(state);
      lastKnownStateJson = stateJson;
    }
    setConnectionState('connected', 'Connected to referee.');
  } catch (e) {
    console.error('pollReferee error:', e);
    setConnectionState('disconnected', 'Connection lost. Reconnecting…');
  }
  setTimeout(pollReferee, 600);
}

// D1: SSE push handler. When an EventSource event arrives, apply the same
// applyRefereeState path as pollReferee — board/clocks/history come ONLY from
// the referee. This is just a fresher transport; no local board mutation ever.
function handleSSEStateEvent(state) {
  if (refereeStateValidationError(state)) {
    applyRefereeState(state);
    return false;
  }
  const stateJson = JSON.stringify(state);
  if (stateJson === lastKnownStateJson) return true;
  playSound(classifySound(previousRefereeState, state));
  previousRefereeState = state;
  cacheRefereeState(state);
  selectedSquare = null;
  legalMoves = [];
  applyRefereeState(state);
  lastKnownStateJson = stateJson;
  setConnectionState('connected', 'Connected to referee.');
  return true;
}

// D1: Prefer EventSource('/api/events') for near-instant referee-state push.
// On any error (including reconnect attempts), the 600ms pollReferee fallback
// stays active so the UI never renders stale-only. EventSource auto-reconnects
// natively; if it gives up, pollReferee covers all state transitions.
function startSSE() {
  if (sseStarted) return;
  sseStarted = true;
  try {
    sseEventSource = new EventSource(withRoomParam('/api/events'));
    sseEventSource.onopen = () => setConnectionState('connected', 'Connected to referee.');
    sseEventSource.addEventListener('state', (event) => {
      try {
        const state = JSON.parse(event.data);
        handleSSEStateEvent(state);
      } catch (e) {
        console.error('SSE state parse error:', e);
      }
    });
    sseEventSource.onerror = (e) => {
      console.warn('SSE connection error; pollReferee fallback remains active');
      setConnectionState('reconnecting', 'Live updates interrupted. Reconnecting; polling remains active…');
    };
  } catch (e) {
    console.warn('EventSource unavailable; falling back to polling only');
    sseEventSource = null;
    setConnectionState('reconnecting', 'Live updates unavailable. Polling referee…');
  }
}

// C3: HTML5 drag-and-drop move submission. This reuses the same
// submitMoveToReferee / promotion-modal path as click-to-move so the
// referee remains the single source of truth. The UI never mutates the
// board locally; it only reads `board` (the latest referee snapshot) to
// decide what is draggable and where it may be dropped.
function isSquareDraggable(squareId) {
  if (!board || gameOver || commandPending) return false;
  const pieceData = board.pieces[squareId];
  return !!pieceData && pieceData.color === turn;
}

function handleDragStart(e, squareId) {
  if (!isSquareDraggable(squareId)) {
    e.preventDefault();
    return;
  }
  // C3: stash the source + legal targets so dragover can validate cheaply.
  dragFromSquare = squareId;
  dragLegalMoves = getLegalMoves(board, squareId, turn);
  try {
    e.dataTransfer.setData('text/plain', squareId);
    e.dataTransfer.effectAllowed = 'move';
  } catch (err) {
    // Some browsers throw if dataTransfer is accessed outside a drag; ignore.
  }
  const squareDiv = document.getElementById(squareId);
  if (squareDiv) squareDiv.classList.add('dragging-source');
  // C3: give the click-to-move selection a visual hint too, so the legal
  // targets highlight during a drag just like they do on click.
  selectedSquare = squareId;
  legalMoves = dragLegalMoves;
  renderBoard();
}

function handleDragOver(e, squareId) {
  if (dragFromSquare === null) return;
  if (!dragLegalMoves.includes(squareId)) {
    e.dataTransfer && (e.dataTransfer.dropEffect = 'none');
    return;
  }
  e.preventDefault();
  e.dataTransfer && (e.dataTransfer.dropEffect = 'move');
  const squareDiv = document.getElementById(squareId);
  if (squareDiv && !squareDiv.classList.contains('drop-hint')) {
    squareDiv.classList.add('drop-hint');
  }
}

function handleDragLeave(e, squareId) {
  const squareDiv = document.getElementById(squareId);
  if (squareDiv) squareDiv.classList.remove('drop-hint');
}

function handleDrop(e, squareId) {
  e.preventDefault();
  const fromSquare = dragFromSquare;
  // C3: clear drag state immediately so a subsequent poll doesn't see it.
  clearDragState();
  if (!board || gameOver || !fromSquare) return;
  if (!getLegalMoves(board, fromSquare, turn).includes(squareId)) return;
  submitDragMove(fromSquare, squareId);
}

function submitDragMove(fromSquare, toSquare) {
  // C3: promotion opens the piece modal BEFORE finalizing, mirroring the
  // click-to-move flow exactly. The pending move is resolved by
  // choosePromotion -> submitMoveToReferee.
  if (isPromotionMove(fromSquare, toSquare)) {
    openPromotionDialog(fromSquare, toSquare, board.pieces[fromSquare].color);
  } else {
    submitMoveToReferee(fromSquare + toSquare);
  }
  // C3: clear any click-to-move selection left over from dragstart.
  selectedSquare = null;
  legalMoves = [];
  renderBoard();
}

function clearDragState() {
  if (dragFromSquare !== null) {
    const prev = document.getElementById(dragFromSquare);
    if (prev) prev.classList.remove('dragging-source');
  }
  document.querySelectorAll('.drop-hint').forEach(el => el.classList.remove('drop-hint'));
  dragFromSquare = null;
  dragLegalMoves = [];
}

function handleDragEnd() {
  clearDragState();
  // C3: if a drag ended without a valid drop, reset the selection hint so
  // the board doesn't stay highlighted as if a click-select is active.
  if (legalMoves === dragLegalMoves || (dragLegalMoves.length === 0 && legalMoves.length === 0)) {
    // best-effort reset; the next referee poll will reconcile anyway.
  }
  selectedSquare = null;
  legalMoves = [];
  renderBoard();
}

function handleSquareClick(squareId) {
  // Until a referee snapshot exists, there is no board for the UI to act on.
  if (!board || gameOver || commandPending) return;

  if (typeof isViewingHistory === 'function' && isViewingHistory()) {
    scrubLast();
    return;
  }

  if (typeof clearUserAnnotations === 'function' && typeof userAnnotations !== 'undefined' && userAnnotations && (userAnnotations.arrows.length > 0 || userAnnotations.circles.length > 0)) {
    clearUserAnnotations();
  }

  if (legalMoves.includes(squareId)) {
    const fromSquare = selectedSquare;
    const pieceColor = (board.pieces[fromSquare] && board.pieces[fromSquare].color) || turn;
    selectedSquare = null;
    legalMoves = [];
    if (pieceColor === turn) {
      clearPremove();
      if (isPromotionMove(fromSquare, squareId)) {
        openPromotionDialog(fromSquare, squareId, pieceColor);
      } else {
        submitMoveToReferee(fromSquare + squareId);
      }
    } else {
      if (typeof premoveQueue !== 'undefined') {
        if (premoveQueue.length < MAX_PREMOVES) {
          premoveQueue.push({ from: fromSquare, to: squareId, color: pieceColor });
          queuedPremove = premoveQueue[0];
        }
      } else {
        queuedPremove = { from: fromSquare, to: squareId, color: pieceColor };
      }
    }
    renderBoard();
    return;
  }

  const pieceData = board.pieces[squareId];
  if (pieceData) {
    const pTurn = pieceData.color;
    if (pTurn === turn) {
      clearPremove();
      selectedSquare = squareId;
      legalMoves = getLegalMoves(board, squareId, turn);
      renderBoard();
      return;
    } else {
      selectedSquare = squareId;
      legalMoves = getLegalMoves(board, squareId, pTurn);
      renderBoard();
      return;
    }
  }

  clearPremove();
  selectedSquare = null;
  legalMoves = [];
  renderBoard();
}

// A6: CSS-only theming system. Applies [data-theme] and [data-mode] on the
// root element and persists preferences in localStorage (guarded try/catch).
// This is purely presentational — no rendering logic, poll, or clock changes.
const THEME_BOARD_KEY = 'chess.theme.board';
const THEME_MODE_KEY = 'chess.theme.mode';
const themeBoardSelect = document.getElementById('theme-board-select');
const themeModeToggle = document.getElementById('theme-mode-toggle');

function applyBoardTheme(themeId) {
  if (!themeId || !isValidBoardTheme(themeId)) return;
  try {
    document.documentElement.setAttribute('data-theme', themeId);
  } catch (e) {
    // DOM may be unavailable in non-browser contexts
  }
}

function applyDarkMode(isDark) {
  try {
    if (isDark) {
      document.documentElement.setAttribute('data-mode', 'dark');
    } else {
      document.documentElement.removeAttribute('data-mode');
    }
  } catch (e) {
    // DOM may be unavailable
  }
}

function persistTheme(key, value) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
    }
  } catch (e) {
    // Storage is optional; theme still applies for the session
  }
}

function loadThemePreference(key, fallback) {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const val = localStorage.getItem(key);
    return val !== null ? val : fallback;
  } catch (e) {
    return fallback;
  }
}

function updateModeToggleLabel(isDark) {
  if (themeModeToggle) themeModeToggle.textContent = isDark ? 'Light mode' : 'Dark mode';
}

function initThemeBar() {
  if (themeBoardSelect) {
    const savedBoard = loadThemePreference(THEME_BOARD_KEY, getDefaultBoardTheme());
    if (isValidBoardTheme(savedBoard)) {
      themeBoardSelect.value = savedBoard;
      applyBoardTheme(savedBoard);
    } else {
      applyBoardTheme(getDefaultBoardTheme());
    }
    themeBoardSelect.onchange = () => {
      const val = themeBoardSelect.value;
      applyBoardTheme(val);
      persistTheme(THEME_BOARD_KEY, val);
    };
  }
  if (themeModeToggle) {
    const savedMode = loadThemePreference(THEME_MODE_KEY, 'light');
    const isDark = savedMode === 'dark';
    applyDarkMode(isDark);
    updateModeToggleLabel(isDark);
    themeModeToggle.onclick = () => {
      const currentlyDark = document.documentElement.getAttribute('data-mode') === 'dark';
      const nextDark = !currentlyDark;
      applyDarkMode(nextDark);
      updateModeToggleLabel(nextDark);
      persistTheme(THEME_MODE_KEY, nextDark ? 'dark' : 'light');
    };
  }
  const soundToggleButton = document.getElementById('sound-toggle');
  if (soundToggleButton) {
    loadSoundPreference();
    soundToggleButton.textContent = soundEnabled ? 'Sound: On' : 'Sound: Off';
    soundToggleButton.onclick = () => {
      setSoundEnabled(!soundEnabled);
    };
  }
}

initThemeBar();

function initGame() {
  // Do not construct or reset a local board. The next referee poll supplies
  // every rendered game value, including the board and clocks.
  board = null;
  turn = 'white';
  selectedSquare = null;
  legalMoves = [];
  clearPremove();
  touchDragState = null;
  whiteTime = null;
  blackTime = null;
  refereeClockAt = null;
  moveHistory = [];
  refereeStatus = 'ongoing';
  gameOver = false;
  result = null;
  kingStatus = { kingSquare: null, check: false, mate: false };
  previousBoard = null;
  renderedBoardFlipped = null;
  lastKnownStateJson = "";
  if (!pollStarted) {
    pollStarted = true;
    pollReferee();
  }
  if (!sseStarted) {
    startSSE();
  }
}

async function resetReferee() {
  const accepted = await runRefereeCommand('Starting new game', () =>
    fetch(withRoomParam('/api/reset'), { method: 'POST' }));
  if (accepted) {
    // The board is still changed only by the subsequent referee poll.
    lastKnownStateJson = '';
  }
}
if (newGameButton) newGameButton.onclick = resetReferee;
if (rematchButton) rematchButton.onclick = resetReferee;
const copyPgnButton = document.getElementById('copy-pgn');
if (copyPgnButton) copyPgnButton.onclick = copyPgn;
const flipBoardButton = document.getElementById('flip-board');
if (flipBoardButton) flipBoardButton.onclick = () => {
  boardFlipped = !boardFlipped;
  renderBoard();
};
const resignButton = document.getElementById('resign');
if (resignButton) resignButton.onclick = async () => {
  await runRefereeCommand('Submitting resignation', () =>
    fetch(withRoomParam(`/api/resign?${turn === 'white' ? 'w' : 'b'}`), { method: 'POST' }));
};
const drawButton = document.getElementById('offer-draw');
if (drawButton) drawButton.onclick = async () => {
  await runRefereeCommand('Offering draw', () => fetch(withRoomParam('/api/draw'), { method: 'POST' }));
};
if (undoButton) undoButton.onclick = async () => {
  await runRefereeCommand('Requesting undo', () => fetch(withRoomParam('/api/undo'), { method: 'POST' }));
};

const btnScrubStart = document.getElementById('scrub-start');
if (btnScrubStart) btnScrubStart.onclick = scrubFirst;
const btnScrubPrev = document.getElementById('scrub-prev');
if (btnScrubPrev) btnScrubPrev.onclick = scrubPrev;
const btnScrubNext = document.getElementById('scrub-next');
if (btnScrubNext) btnScrubNext.onclick = scrubNext;
const btnScrubEnd = document.getElementById('scrub-end');
if (btnScrubEnd) btnScrubEnd.onclick = scrubLast;

function runGameReview() {
  const reviewModule = (typeof window !== 'undefined' && window.MoveReview) || (typeof MoveReview !== 'undefined' ? MoveReview : null);
  if (!reviewModule) return null;
  const moves = liveHistory || [];
  while (evalHistory.length <= moves.length) {
    const last = evalHistory.length > 0 ? evalHistory[evalHistory.length - 1] : 0;
    evalHistory.push(last);
  }
  latestGameReview = reviewModule.reviewGame(moves, evalHistory);
  renderReviewPanel();
  updateHistoryUI();
  return latestGameReview;
}

function renderReviewPanel() {
  const panel = document.getElementById('review-panel');
  if (!panel || !latestGameReview) return;
  panel.classList.remove('hidden');
  try {
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {}

  const whiteAccEl = document.getElementById('white-accuracy');
  const blackAccEl = document.getElementById('black-accuracy');
  if (whiteAccEl) whiteAccEl.textContent = `${latestGameReview.whiteAccuracy}%`;
  if (blackAccEl) blackAccEl.textContent = `${latestGameReview.blackAccuracy}%`;

  const summaryEl = document.getElementById('classification-summary');
  if (summaryEl) {
    summaryEl.innerHTML = '';
    const table = document.createElement('table');
    table.style.width = '100%';
    table.style.fontSize = '0.8rem';
    table.style.borderCollapse = 'collapse';

    const headerRow = document.createElement('tr');
    headerRow.innerHTML = '<th style="text-align:left;padding:2px 4px;">Classification</th><th style="text-align:center;padding:2px 4px;">White</th><th style="text-align:center;padding:2px 4px;">Black</th>';
    table.appendChild(headerRow);

    const classes = [
      { key: 'brilliant', label: 'Brilliant (!!)', color: '#1baca6' },
      { key: 'best', label: 'Best (★)', color: '#96bc4b' },
      { key: 'excellent', label: 'Excellent', color: '#96bc4b' },
      { key: 'good', label: 'Good', color: '#7ea43b' },
      { key: 'inaccuracy', label: 'Inaccuracy (?!)', color: '#e69d00' },
      { key: 'mistake', label: 'Mistake (?)', color: '#e58f2a' },
      { key: 'blunder', label: 'Blunder (??)', color: '#ca3431' }
    ];

    classes.forEach(c => {
      const row = document.createElement('tr');
      const wCount = (latestGameReview.counts && latestGameReview.counts.white && latestGameReview.counts.white[c.key]) || 0;
      const bCount = (latestGameReview.counts && latestGameReview.counts.black && latestGameReview.counts.black[c.key]) || 0;
      row.innerHTML = `
        <td style="padding:2px 4px;color:${c.color};font-weight:600;">${c.label}</td>
        <td style="text-align:center;padding:2px 4px;">${wCount}</td>
        <td style="text-align:center;padding:2px 4px;">${bCount}</td>
      `;
      table.appendChild(row);
    });
    summaryEl.appendChild(table);
  }
}

const gameReviewButton = document.getElementById('game-review-btn');
if (gameReviewButton) gameReviewButton.onclick = runGameReview;
const closeReviewButton = document.getElementById('close-review');
if (closeReviewButton) closeReviewButton.onclick = () => {
  const panel = document.getElementById('review-panel');
  if (panel) panel.classList.add('hidden');
};

function updateOpeningExplorerUI() {
  const openingsModule = (typeof window !== 'undefined' && window.Openings) || (typeof Openings !== 'undefined' ? Openings : null);
  if (!openingsModule) return;

  const currentPly = viewedPly === null ? (liveHistory ? liveHistory.length : 0) : viewedPly;
  const movesSlice = liveHistory ? liveHistory.slice(0, currentPly) : [];
  const opening = openingsModule.findOpening(movesSlice);

  const ecoBadge = document.getElementById('opening-eco-badge');
  const nameEl = document.getElementById('opening-name');
  const wStat = document.getElementById('stat-white');
  const dStat = document.getElementById('stat-draw');
  const bStat = document.getElementById('stat-black');
  const movesListEl = document.getElementById('opening-moves-list');

  if (ecoBadge) ecoBadge.textContent = opening.eco || 'A00';
  if (nameEl) nameEl.textContent = opening.name || 'Starting Position';

  if (wStat && dStat && bStat && opening.stats) {
    wStat.style.width = `${opening.stats.white}%`;
    wStat.textContent = `${opening.stats.white}%`;
    wStat.title = `White wins: ${opening.stats.white}%`;

    dStat.style.width = `${opening.stats.draw}%`;
    dStat.textContent = `${opening.stats.draw}%`;
    dStat.title = `Draws: ${opening.stats.draw}%`;

    bStat.style.width = `${opening.stats.black}%`;
    bStat.textContent = `${opening.stats.black}%`;
    bStat.title = `Black wins: ${opening.stats.black}%`;
  }

  if (movesListEl) {
    movesListEl.innerHTML = '';
    if (opening.popularMoves && Array.isArray(opening.popularMoves)) {
      opening.popularMoves.slice(0, 4).forEach(pm => {
        const item = document.createElement('div');
        item.className = 'rec-move-item';
        item.innerHTML = `
          <div>
            <span class="rec-move-san">${pm.san || pm.uci}</span>
            <span style="color:#64748b; margin-left:6px;">${pm.name || ''}</span>
          </div>
          <span style="font-weight:600; color:#475569;">${pm.frequency}%</span>
        `;
        movesListEl.appendChild(item);
      });
    }
  }
}

function updateEvalGraphUI() {
  const openingsModule = (typeof window !== 'undefined' && window.Openings) || (typeof Openings !== 'undefined' ? Openings : null);
  const svg = document.getElementById('eval-graph-svg');
  if (!svg || !openingsModule) return;

  const currentPly = viewedPly === null ? (liveHistory ? liveHistory.length : 0) : viewedPly;
  const graphData = openingsModule.generateEvalGraphData(evalHistory || [0], 400, 80);

  svg.innerHTML = '';

  // Zero-center line
  const zeroLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  zeroLine.setAttribute('x1', '0');
  zeroLine.setAttribute('y1', String(graphData.zeroY));
  zeroLine.setAttribute('x2', '400');
  zeroLine.setAttribute('y2', String(graphData.zeroY));
  zeroLine.setAttribute('class', 'graph-zero-line');
  svg.appendChild(zeroLine);

  // Curve path
  if (graphData.pathData) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', graphData.pathData);
    path.setAttribute('class', 'graph-curve');
    svg.appendChild(path);
  }

  // Active ply indicator
  if (graphData.points && graphData.points[currentPly]) {
    const activePt = graphData.points[currentPly];
    const indLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    indLine.setAttribute('x1', String(activePt.x));
    indLine.setAttribute('y1', '0');
    indLine.setAttribute('x2', String(activePt.x));
    indLine.setAttribute('y2', '80');
    indLine.setAttribute('class', 'graph-active-indicator');
    svg.appendChild(indLine);
  }

  // Dots for each ply
  if (graphData.points) {
    graphData.points.forEach(pt => {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', String(pt.x));
      circle.setAttribute('cy', String(pt.y));
      circle.setAttribute('r', pt.ply === currentPly ? '4' : '2.5');
      circle.setAttribute('class', 'graph-dot');
      circle.dataset.ply = String(pt.ply);
      circle.onclick = () => jumpToPly(pt.ply);
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `Ply ${pt.ply}: ${pt.cp >= 0 ? '+' : ''}${(pt.cp / 100).toFixed(2)}`;
      circle.appendChild(title);
      svg.appendChild(circle);
    });
  }
}

function updateSeatUI() {
  const badge = document.getElementById('seat-badge');
  const claimWhite = document.getElementById('claim-white-btn');
  const claimBlack = document.getElementById('claim-black-btn');
  const leaveBtn = document.getElementById('leave-seat-btn');

  if (badge) {
    if (currentSeatRole === 'white') {
      badge.textContent = 'Seated: White';
      badge.style.background = '#2563eb';
      badge.style.color = 'white';
    } else if (currentSeatRole === 'black') {
      badge.textContent = 'Seated: Black';
      badge.style.background = '#1e293b';
      badge.style.color = 'white';
    } else {
      badge.textContent = 'Unseated';
      badge.style.background = '#e2e8f0';
      badge.style.color = '#334155';
    }
  }

  if (leaveBtn) leaveBtn.classList.toggle('hidden', !currentSeatRole);
  if (claimWhite) claimWhite.disabled = currentSeatRole === 'white';
  if (claimBlack) claimBlack.disabled = currentSeatRole === 'black';
}

async function claimSeat(role) {
  try {
    const res = await fetch('/api/seat/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role })
    });
    const data = await res.json();
    if (res.ok && data.token) {
      currentSeatRole = role;
      currentSeatToken = data.token;
      if (typeof window !== 'undefined' && window.sessionStorage) {
        window.sessionStorage.setItem('chess_seat_token', data.token);
        window.sessionStorage.setItem('chess_seat_role', role);
      }
      updateSeatUI();
      return true;
    } else {
      if (typeof alert === 'function') alert(data.error || 'Failed to claim seat');
      return false;
    }
  } catch (e) {
    return false;
  }
}

async function leaveSeat() {
  if (!currentSeatToken) return;
  try {
    await fetch('/api/seat/release', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Seat-Token': currentSeatToken
      }
    });
  } catch (e) {}
  currentSeatRole = null;
  currentSeatToken = null;
  if (typeof window !== 'undefined' && window.sessionStorage) {
    window.sessionStorage.removeItem('chess_seat_token');
    window.sessionStorage.removeItem('chess_seat_role');
  }
  updateSeatUI();
}

const btnClaimWhite = document.getElementById('claim-white-btn');
if (btnClaimWhite) btnClaimWhite.onclick = () => claimSeat('white');
const btnClaimBlack = document.getElementById('claim-black-btn');
if (btnClaimBlack) btnClaimBlack.onclick = () => claimSeat('black');
const btnLeaveSeat = document.getElementById('leave-seat-btn');
if (btnLeaveSeat) btnLeaveSeat.onclick = leaveSeat;

let measuredLatency = null;
let clockOffset = 0;

async function syncNtpClock() {
  const t0 = Date.now();
  try {
    const res = await fetch(`/api/time?t0=${t0}`);
    if (res.ok) {
      const data = await res.json();
      const t3 = Date.now();
      const t1 = data.serverReceiveTime || data.serverTime || t3;
      const t2 = data.serverTransmitTime || t1;
      const rtt = Math.max(0, (t3 - t0) - (t2 - t1));
      measuredLatency = Math.round(rtt / 2);
      clockOffset = Math.round(((t1 - t0) + (t2 - t3)) / 2);
      updatePingUI();
    }
  } catch (e) {}
}

function updatePingUI() {
  const pingEl = document.getElementById('ping-badge');
  if (pingEl && measuredLatency !== null) {
    pingEl.textContent = `${measuredLatency}ms`;
    pingEl.title = `Latency: ${measuredLatency}ms (Offset: ${clockOffset}ms)`;
  }
}

// ==========================================
// Phase 3: SQLite Game Archive & PGN Library
// ==========================================

let lastAutoSavedGameId = null;

async function autoSaveFinishedGame(state) {
  if (!state || !state.gameOver || !liveHistory || liveHistory.length === 0) return;
  const gameSignature = `${state.result || '*'}:${liveHistory.join(',')}`;
  if (lastAutoSavedGameId === gameSignature) return;
  lastAutoSavedGameId = gameSignature;

  const rawHistory = liveHistory;
  const sanList = historyToSan(rawHistory);
  const resultToken = pgnResultToken();
  const pgnText = buildPgn(sanList, resultToken);

  try {
    await fetch('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        white: 'White',
        black: 'Black',
        result: resultToken,
        moves: rawHistory,
        pgn: pgnText
      })
    });
  } catch (err) {
    console.warn('Auto-save game archive failed:', err);
  }
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function loadGameArchiveList(query = '') {
  const tableBody = document.getElementById('games-table-body');
  const statusMsg = document.getElementById('archive-status-msg');
  if (statusMsg) statusMsg.textContent = 'Loading archive...';

  try {
    const url = query ? `/api/games?q=${encodeURIComponent(query)}` : '/api/games';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const games = data.games || [];

    if (!tableBody) return;
    tableBody.innerHTML = '';

    if (games.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 16px; color: #64748b;">No games found.</td></tr>';
      if (statusMsg) statusMsg.textContent = query ? 'No matching games found.' : 'No saved games yet.';
      return;
    }

    for (const game of games) {
      const tr = document.createElement('tr');
      const movesCount = game.moves ? game.moves.trim().split(/\s+/).filter(Boolean).length : 0;
      const movesDisplay = movesCount > 0 ? `${Math.ceil(movesCount / 2)} moves` : '-';

      tr.innerHTML = `
        <td style="padding: 6px 8px;">${escapeHtml(game.date || '-')}</td>
        <td style="padding: 6px 8px; font-weight: 500;">${escapeHtml(game.white || 'White')}</td>
        <td style="padding: 6px 8px; font-weight: 500;">${escapeHtml(game.black || 'Black')}</td>
        <td style="padding: 6px 8px;"><span style="display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 0.75rem; background: rgba(0,0,0,0.06); font-family: monospace;">${escapeHtml(game.result || '*')}</span></td>
        <td style="padding: 6px 8px; font-family: monospace;">${escapeHtml(game.eco || '-')}</td>
        <td style="padding: 6px 8px; color: #64748b;">${escapeHtml(movesDisplay)}</td>
        <td style="padding: 6px 8px; text-align: right; white-space: nowrap;">
          <button type="button" class="archive-view-btn" data-id="${escapeHtml(game.id)}" style="padding: 2px 8px; margin-right: 4px; font-size: 0.8rem; cursor: pointer;">View</button>
          <button type="button" class="archive-download-btn" data-id="${escapeHtml(game.id)}" style="padding: 2px 8px; margin-right: 4px; font-size: 0.8rem; cursor: pointer;">PGN</button>
          <button type="button" class="archive-reload-btn" data-id="${escapeHtml(game.id)}" style="padding: 2px 8px; font-size: 0.8rem; cursor: pointer;">Load</button>
        </td>
      `;
      tableBody.appendChild(tr);
    }

    tableBody.querySelectorAll('.archive-view-btn').forEach(btn => {
      btn.onclick = () => viewArchivedGame(btn.dataset.id);
    });
    tableBody.querySelectorAll('.archive-download-btn').forEach(btn => {
      btn.onclick = () => downloadArchivedGamePgn(btn.dataset.id);
    });
    tableBody.querySelectorAll('.archive-reload-btn').forEach(btn => {
      btn.onclick = () => reloadArchivedGameOntoBoard(btn.dataset.id);
    });

    if (statusMsg) statusMsg.textContent = `Showing ${games.length} game${games.length === 1 ? '' : 's'}`;
  } catch (err) {
    if (statusMsg) statusMsg.textContent = `Failed to load games: ${err.message}`;
  }
}

async function viewArchivedGame(gameId) {
  try {
    const res = await fetch(`/api/games/${encodeURIComponent(gameId)}`);
    if (!res.ok) throw new Error(`Failed to fetch game details: ${res.status}`);
    const data = await res.json();
    const game = data.game;
    if (!game) return;

    let uciMoves = [];
    if (game.moves) {
      const split = game.moves.trim().split(/\s+/).filter(Boolean);
      if (split.length > 0 && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(split[0])) {
        uciMoves = split;
      }
    }

    if (uciMoves.length === 0 && game.pgn) {
      const chessClass = (typeof Chess !== 'undefined' ? Chess : (typeof window !== 'undefined' && window.Chess ? window.Chess : null));
      if (chessClass) {
        try {
          const c = new chessClass();
          c.loadPgn(game.pgn);
          uciMoves = c.history({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''));
        } catch (_) {}
      }
    }

    liveHistory = uciMoves;
    const sanHistory = historyToSan(uciMoves);
    const moves = [];
    for (let i = 0; i < uciMoves.length; i += 2) {
      moves.push({
        whiteMove: sanHistory[i],
        blackMove: sanHistory[i + 1] || '',
        raw: uciMoves[i],
        rawBlack: uciMoves[i + 1] || ''
      });
    }
    moveHistory = moves;
    if (typeof computeHistoryPositions === 'function') {
      historyPositions = computeHistoryPositions(liveHistory);
    }
    jumpToPly(0);
    updateHistoryUI();
    if (statusElement) {
      statusElement.textContent = `Viewing archive: ${game.white} vs ${game.black} (${game.result || '*'})`;
    }

    const modal = document.getElementById('archive-modal');
    if (modal) modal.classList.add('hidden');
  } catch (err) {
    alert(`Could not view game: ${err.message}`);
  }
}

function downloadArchivedGamePgn(gameId) {
  const link = document.createElement('a');
  link.href = `/api/games/${encodeURIComponent(gameId)}/pgn`;
  link.download = `${gameId}.pgn`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

async function reloadArchivedGameOntoBoard(gameId) {
  try {
    const res = await fetch(`/api/games/${encodeURIComponent(gameId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const game = data.game;
    if (!game) return;

    let uciMoves = [];
    if (game.moves) {
      const split = game.moves.trim().split(/\s+/).filter(Boolean);
      if (split.length > 0 && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(split[0])) {
        uciMoves = split;
      }
    }
    if (uciMoves.length === 0 && game.pgn) {
      const chessClass = (typeof Chess !== 'undefined' ? Chess : (typeof window !== 'undefined' && window.Chess ? window.Chess : null));
      if (chessClass) {
        try {
          const c = new chessClass();
          c.loadPgn(game.pgn);
          uciMoves = c.history({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''));
        } catch (_) {}
      }
    }

    await runRefereeCommand('Resetting referee', () => fetch('/api/reset', { method: 'POST' }));

    for (const move of uciMoves) {
      await fetch('/api/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ move })
      });
    }

    const modal = document.getElementById('archive-modal');
    if (modal) modal.classList.add('hidden');
  } catch (err) {
    alert(`Could not reload game onto board: ${err.message}`);
  }
}

function setupGameArchiveUI() {
  const archiveBtn = document.getElementById('game-archive-btn');
  const archiveModal = document.getElementById('archive-modal');
  const closeArchiveBtn = document.getElementById('close-archive-btn');
  const searchInput = document.getElementById('archive-search-input');
  const searchBtn = document.getElementById('archive-search-btn');
  const refreshBtn = document.getElementById('archive-refresh-btn');

  const importModal = document.getElementById('import-pgn-modal');
  const openImportBtn = document.getElementById('open-import-pgn-btn');
  const closeImportBtn = document.getElementById('close-import-pgn-btn');
  const cancelImportBtn = document.getElementById('cancel-import-pgn-btn');
  const submitImportBtn = document.getElementById('submit-import-pgn-btn');
  const importTextarea = document.getElementById('import-pgn-textarea');
  const importStatus = document.getElementById('import-pgn-status');

  if (archiveBtn && archiveModal) {
    archiveBtn.onclick = () => {
      archiveModal.classList.remove('hidden');
      loadGameArchiveList(searchInput ? searchInput.value : '');
    };
  }

  if (closeArchiveBtn && archiveModal) {
    closeArchiveBtn.onclick = () => archiveModal.classList.add('hidden');
  }

  if (searchBtn && searchInput) {
    searchBtn.onclick = () => loadGameArchiveList(searchInput.value);
  }

  if (searchInput) {
    searchInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        loadGameArchiveList(searchInput.value);
      }
    };
  }

  if (refreshBtn) {
    refreshBtn.onclick = () => {
      if (searchInput) searchInput.value = '';
      loadGameArchiveList('');
    };
  }

  if (openImportBtn && importModal) {
    openImportBtn.onclick = () => {
      importModal.classList.remove('hidden');
      if (importStatus) importStatus.textContent = '';
      if (importTextarea) importTextarea.focus();
    };
  }

  const closeImport = () => {
    if (importModal) importModal.classList.add('hidden');
  };

  if (closeImportBtn) closeImportBtn.onclick = closeImport;
  if (cancelImportBtn) cancelImportBtn.onclick = closeImport;

  if (submitImportBtn && importTextarea) {
    submitImportBtn.onclick = async () => {
      const pgn = importTextarea.value.trim();
      if (!pgn) {
        if (importStatus) {
          importStatus.textContent = 'Please paste a PGN string.';
          importStatus.style.color = '#dc2626';
        }
        return;
      }
      if (importStatus) {
        importStatus.textContent = 'Saving game to library...';
        importStatus.style.color = '#2563eb';
      }

      try {
        const res = await fetch('/api/games', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pgn })
        });
        const result = await res.json();
        if (!res.ok || !result.ok) {
          throw new Error(result.error || 'Failed to save game');
        }
        if (importStatus) {
          importStatus.textContent = 'Game saved successfully!';
          importStatus.style.color = '#16a34a';
        }
        importTextarea.value = '';
        setTimeout(() => {
          closeImport();
          loadGameArchiveList();
        }, 600);
      } catch (err) {
        if (importStatus) {
          importStatus.textContent = `Error: ${err.message}`;
          importStatus.style.color = '#dc2626';
        }
      }
    };
  }
}

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('keydown', handleGlobalScrubberKeydown);
  window.jumpToPly = jumpToPly;
  window.scrubFirst = scrubFirst;
  window.scrubPrev = scrubPrev;
  window.scrubNext = scrubNext;
  window.scrubLast = scrubLast;
  window.getViewedPly = getViewedPly;
  window.getLivePly = getLivePly;
  window.isViewingHistory = isViewingHistory;
  window.getEngineMultiPvLines = getEngineMultiPvLines;
  window.setMultiPvCount = setMultiPvCount;
  window.clearEngineMultiPvLines = clearEngineMultiPvLines;
  window.renderMultiPvBreakdown = renderMultiPvBreakdown;
  window.runGameReview = runGameReview;
  window.getLatestGameReview = () => latestGameReview;
  window.getEvalHistory = () => evalHistory;
  window.setEvalHistory = (h) => { evalHistory = h; };
  window.updateOpeningExplorerUI = updateOpeningExplorerUI;
  window.updateEvalGraphUI = updateEvalGraphUI;
  window.claimSeat = claimSeat;
  window.leaveSeat = leaveSeat;
  window.getCurrentSeatRole = () => currentSeatRole;
  window.getCurrentSeatToken = () => currentSeatToken;
  window.updateSeatUI = updateSeatUI;
  window.syncNtpClock = syncNtpClock;
  window.getMeasuredLatency = () => measuredLatency;
  window.getClockOffset = () => clockOffset;
  window.updatePingUI = updatePingUI;
  window.getCurrentRoomId = getCurrentRoomId;
  window.withRoomParam = withRoomParam;
  window.updateRoomBadge = updateRoomBadge;
  window.loadGameArchiveList = loadGameArchiveList;
  window.viewArchivedGame = viewArchivedGame;
  window.downloadArchivedGamePgn = downloadArchivedGamePgn;
  window.setupGameArchiveUI = setupGameArchiveUI;
}

const copyRoomButton = document.getElementById('copy-room-link');
if (copyRoomButton) {
  copyRoomButton.onclick = () => {
    const roomId = getCurrentRoomId();
    const url = typeof window !== 'undefined' && window.location
      ? (roomId === 'default' ? window.location.origin + '/' : window.location.origin + '/game/' + encodeURIComponent(roomId))
      : '';
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        if (statusElement) statusElement.textContent = 'Room link copied to clipboard';
      }).catch(() => {});
    }
  };
}
updateRoomBadge();

initGame();
setupGameArchiveUI();
const cachedState = restoreCachedRefereeState();
if (cachedState) {
  // This is a paint-only bootstrap. The first referee poll always runs with
  // an empty comparison key and reconciles/overrides this cached snapshot.
  previousRefereeState = cachedState;
  applyRefereeState(cachedState);
}

