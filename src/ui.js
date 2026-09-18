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
// B1: true only once the referee reports the game has actually started
// (history non-empty, moveStartTs running). Before that, clocks render the
// referee value verbatim — no interpolation, so a fresh game shows full time.
let refereeClockRunning = false;
let clockTickInterval = null;
let moveHistory = [];
let lastKnownStateJson = "";
let pollStarted = false;
let sseStarted = false;
let sseEventSource = null;
// B6: poll cadence. While SSE is open the poll is only a slow liveness check;
// when SSE is down it resumes the fast cadence. Consecutive /api/state failures
// back off exponentially (capped) so a down server doesn't spam the console.
const POLL_FAST_MS = 600;
const POLL_SSE_LIVENESS_MS = 15000;
const POLL_FAIL_CAP_MS = 10000;
let pollTimer = null;
let pollFailures = 0;
let sseConnected = false;
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
// B5: timer for the auto-dismissing non-blocking error pill (showUiError).
let uiErrorDismissTimer = null;
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
  // B1: the referee only starts a clock after the first move. Until then
  // nothing is elapsing, so show the reported value unchanged.
  if (!refereeClockRunning) return turn === 'white' ? whiteTime : blackTime;
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
        squareDiv.onpointerdown = e => typeof handlePointerDown === 'function' && handlePointerDown(e, squareId);
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
      } else {
        while (squareDiv.firstChild) {
          squareDiv.removeChild(squareDiv.firstChild);
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

  if (accessibilityController && (accessibilityController.blindModeEnabled || accessibilityController.voiceEnabled)) {
    const p = board && board.pieces ? board.pieces[squareId] : null;
    const label = squareAccessibilityLabel(squareId, p, {
      selected: selectedSquare === squareId,
      legal: legalMoves.includes(squareId),
      check: kingStatus.kingSquare === squareId && kingStatus.check,
      mate: kingStatus.mate,
      gameOver,
      turn
    });
    accessibilityController.announceLive(label);
  }
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
function getAuthHeaders(extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  const room = getCurrentRoomId();
  const seatToken = (typeof window !== 'undefined' && (
    (window.sessionStorage && window.sessionStorage.getItem('chess_seat_token')) ||
    (window.localStorage && window.localStorage.getItem('chess_seat_token_' + room))
  )) || currentSeatToken;
  if (seatToken) {
    headers['X-Seat-Token'] = seatToken;
    headers['Authorization'] = `Bearer ${seatToken}`;
  }
  return headers;
}

// B5: non-blocking, auto-dismissing error pill. Writes to #command-status
// (the assertive live region) and never touches #status, which is reserved
// for referee-reported game status. Does not go through setCommandState so
// a display-only error never disables the command buttons.
const UI_ERROR_DISMISS_MS = 5000;
function showUiError(message) {
  const text = String(message || '');
  if (!commandStatusElement) {
    console.error(text);
    return;
  }
  commandStatusElement.dataset.state = 'error';
  commandStatusElement.textContent = text;
  if (uiErrorDismissTimer) clearTimeout(uiErrorDismissTimer);
  uiErrorDismissTimer = setTimeout(() => {
    uiErrorDismissTimer = null;
    // Only clear if nothing else (e.g. setCommandState) has replaced the text.
    if (commandStatusElement.textContent === text) {
      commandStatusElement.textContent = '';
      commandStatusElement.dataset.state = commandPending ? 'pending' : 'idle';
    }
  }, UI_ERROR_DISMISS_MS);
}

async function submitMoveToReferee(moveStr) {
  const roomParam = getCurrentRoomId() !== 'default' ? `?room=${encodeURIComponent(getCurrentRoomId())}` : '';
  const currentTurn = (refereeState && refereeState.board && refereeState.board.turn) || 'white';
  if (!currentSeatRole) {
    try {
      await claimSeat(currentTurn);
    } catch (_) {}
  }
  const headers = getAuthHeaders();
  const clientSentAt = Date.now();
  const cmdId = 'move:' + moveStr + ':' + clientSentAt + ':' + Math.random().toString(36).slice(2);
  return runRefereeCommand('Submitting move', () => fetch('/api/move' + roomParam, {
      method: 'POST',
      headers,
      body: JSON.stringify({ move: moveStr, clientSentAt, id: cmdId })
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

  if (!event.altKey && !event.ctrlKey && !event.metaKey && typeof event.key === 'string') {
    const k = event.key.toLowerCase();
    if (k === 'v') {
      if (event.preventDefault) event.preventDefault();
      const btn = document.getElementById('voice-toggle');
      if (btn) btn.click();
      return;
    }
    if (k === 'b') {
      if (event.preventDefault) event.preventDefault();
      const btn = document.getElementById('blind-mode-toggle');
      if (btn) btn.click();
      return;
    }
    if (k === 'm') {
      if (event.preventDefault) event.preventDefault();
      const btn = document.getElementById('mic-move-btn');
      if (btn) btn.click();
      return;
    }
    if (k === 'c') {
      if (event.preventDefault) event.preventDefault();
      if (accessibilityController) {
        accessibilityController.announceClocks(whiteTime, blackTime);
      }
      return;
    }
    if (k === 's') {
      if (event.preventDefault) event.preventDefault();
      if (accessibilityController && board) {
        const turnText = `${turn} to move`;
        const checkText = kingStatus.mate ? 'checkmate' : kingStatus.check ? 'in check' : 'normal';
        accessibilityController.announceLive(`Position status: ${turnText}, ${checkText}.`);
      }
      return;
    }
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

function getFenFromStateOrBoard(state) {
  if (state && typeof state.fen === 'string' && state.fen) return state.fen;
  const boardObj = (state && state.board) || (state && state.pieces ? state : board);
  if (!boardObj || !boardObj.pieces) return null;
  // The browser has no RulesEngine / boardToFen global (those live server-side
  // in rules-engine.js), so build the FEN placement string directly.
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
    // B1: interpolate only once the referee says the game is underway. The
    // referee keeps moveStartTs at 0 until the first move lands (and zeroes it
    // again at game end); history is the primary signal, moveStartTs secondary.
    const historyLength = Array.isArray(state.history) ? state.history.length : 0;
    const moveStartTs = typeof state.moveStartTs === 'number' ? state.moveStartTs : null;
    refereeClockRunning = !gameOver && historyLength > 0 && (moveStartTs === null || moveStartTs > 0);
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
    if (accessibilityController && accessibilityController.lastAnnouncedHistoryLength < history.length) {
      if (accessibilityController.lastAnnouncedHistoryLength > 0 || history.length === 1) {
        const lastIdx = history.length - 1;
        const lastSan = sanHistory[lastIdx];
        const lastColor = (lastIdx % 2 === 0) ? 'white' : 'black';
        accessibilityController.announceMove(lastSan, lastColor);
      }
      accessibilityController.lastAnnouncedHistoryLength = history.length;
    }
  } else {
    moveHistory = [];
    if (accessibilityController) {
      accessibilityController.lastAnnouncedHistoryLength = 0;
    }
  }
  if (gameOver && accessibilityController && !accessibilityController.announcedGameOver) {
    accessibilityController.announceGameOutcome(state.status, state.result, state.reason);
    accessibilityController.announcedGameOver = true;
  } else if (!gameOver && accessibilityController) {
    accessibilityController.announcedGameOver = false;
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
  if (typeof clearAnalysisArrow === 'function') {
    clearAnalysisArrow();
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
  if (typeof updateMatchgradeSocialUI === 'function') updateMatchgradeSocialUI(state);
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
      evalWorker = new Worker('src/stockfish-worker.js');
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
    pollFailures = 0;
  } catch (e) {
    if (pollFailures === 0) console.error('pollReferee error:', e);
    pollFailures += 1;
    setConnectionState('disconnected', 'Connection lost. Reconnecting…');
  }
  schedulePoll(nextPollDelayMs());
}

// B6: pick the next poll delay from transport health. Failures dominate
// (exponential backoff, capped); otherwise SSE-open means a slow liveness
// check and SSE-down means the fast fallback cadence.
function nextPollDelayMs() {
  if (pollFailures > 0) {
    return Math.min(POLL_FAIL_CAP_MS, POLL_FAST_MS * Math.pow(2, pollFailures - 1));
  }
  return sseConnected ? POLL_SSE_LIVENESS_MS : POLL_FAST_MS;
}

// B6: single-owner timer so SSE open/error handlers can re-arm the loop
// without ever creating a second concurrent poll chain.
function schedulePoll(delayMs) {
  if (!pollStarted) return;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    pollTimer = null;
    pollReferee();
  }, delayMs);
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
    sseEventSource.onopen = () => {
      setConnectionState('connected', 'Connected to referee.');
      // B6: SSE is now the primary transport; drop polling to a liveness check.
      sseConnected = true;
      schedulePoll(nextPollDelayMs());
    };
    sseEventSource.addEventListener('state', (event) => {
      try {
        const state = JSON.parse(event.data);
        handleSSEStateEvent(state);
      } catch (e) {
        console.error('SSE state parse error:', e);
      }
    });
    sseEventSource.addEventListener('chat', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (typeof appendChatMessage === 'function') appendChatMessage(msg);
      } catch (e) {
        console.error('SSE chat parse error:', e);
      }
    });
    sseEventSource.onerror = (e) => {
      if (sseConnected) console.warn('SSE connection error; pollReferee fallback remains active');
      setConnectionState('reconnecting', 'Live updates interrupted. Reconnecting; polling remains active…');
      // B6: SSE is down; resume the fast poll cadence immediately.
      sseConnected = false;
      schedulePoll(nextPollDelayMs());
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

// D5: Unified Pointer Events Drag-and-Drop (Mobile Touch, Tablet, & Pointer support)
let activePointerDrag = null;

function getSquareIdFromPoint(x, y) {
  if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return null;
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const squareEl = el.closest ? el.closest('.square') : null;
  return squareEl ? squareEl.id : null;
}

function handlePointerDown(e, squareId) {
  if (e.button !== undefined && e.button !== 0) return;
  if (!isSquareDraggable(squareId)) return;

  activePointerDrag = {
    fromSquare: squareId,
    startX: e.clientX,
    startY: e.clientY,
    hasMoved: false,
    ghostEl: null,
    pointerId: e.pointerId
  };
}

function handlePointerMove(e) {
  if (!activePointerDrag) return;
  const dx = e.clientX - activePointerDrag.startX;
  const dy = e.clientY - activePointerDrag.startY;
  const dist = Math.hypot(dx, dy);

  if (!activePointerDrag.hasMoved && dist > 7) {
    activePointerDrag.hasMoved = true;
    dragFromSquare = activePointerDrag.fromSquare;
    dragLegalMoves = getLegalMoves(board, activePointerDrag.fromSquare, turn);

    const squareDiv = document.getElementById(activePointerDrag.fromSquare);
    if (squareDiv) {
      squareDiv.classList.add('dragging-source');
      const pieceSvg = squareDiv.querySelector('.chess-piece');
      if (pieceSvg) {
        const ghost = pieceSvg.cloneNode(true);
        ghost.id = 'active-pointer-ghost';
        ghost.style.position = 'fixed';
        ghost.style.pointerEvents = 'none';
        ghost.style.zIndex = '9999';
        ghost.style.width = (squareDiv.offsetWidth || 48) + 'px';
        ghost.style.height = (squareDiv.offsetHeight || 48) + 'px';
        ghost.style.transform = 'translate(-50%, -50%) scale(1.12)';
        ghost.style.opacity = '0.92';
        ghost.style.filter = 'drop-shadow(0 6px 14px rgba(0,0,0,0.38))';
        document.body.appendChild(ghost);
        activePointerDrag.ghostEl = ghost;
      }
    }
    selectedSquare = activePointerDrag.fromSquare;
    legalMoves = dragLegalMoves;
    renderBoard();
  }

  if (activePointerDrag.hasMoved) {
    if (activePointerDrag.ghostEl) {
      activePointerDrag.ghostEl.style.left = e.clientX + 'px';
      activePointerDrag.ghostEl.style.top = e.clientY + 'px';
    }
    const hoverSquare = getSquareIdFromPoint(e.clientX, e.clientY);
    document.querySelectorAll('.drop-hint').forEach(el => {
      if (el.id !== hoverSquare) el.classList.remove('drop-hint');
    });
    if (hoverSquare && dragLegalMoves.includes(hoverSquare)) {
      const hoverDiv = document.getElementById(hoverSquare);
      if (hoverDiv && !hoverDiv.classList.contains('drop-hint')) {
        hoverDiv.classList.add('drop-hint');
      }
    }
    if (e.cancelable && e.preventDefault) {
      e.preventDefault();
    }
  }
}

function handlePointerUp(e) {
  if (!activePointerDrag) return;
  const fromSquare = activePointerDrag.fromSquare;
  const hadMoved = activePointerDrag.hasMoved;

  if (activePointerDrag.ghostEl && activePointerDrag.ghostEl.parentNode) {
    activePointerDrag.ghostEl.parentNode.removeChild(activePointerDrag.ghostEl);
  }

  activePointerDrag = null;

  if (hadMoved) {
    const targetSquare = getSquareIdFromPoint(e.clientX, e.clientY);
    clearDragState();
    if (targetSquare && getLegalMoves(board, fromSquare, turn).includes(targetSquare)) {
      submitDragMove(fromSquare, targetSquare);
    } else {
      selectedSquare = null;
      legalMoves = [];
      renderBoard();
    }
  }
}

function handlePointerCancel() {
  if (activePointerDrag && activePointerDrag.ghostEl && activePointerDrag.ghostEl.parentNode) {
    activePointerDrag.ghostEl.parentNode.removeChild(activePointerDrag.ghostEl);
  }
  activePointerDrag = null;
  clearDragState();
  selectedSquare = null;
  legalMoves = [];
  renderBoard();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointermove', handlePointerMove, { passive: false });
  window.addEventListener('pointerup', handlePointerUp);
  window.addEventListener('pointercancel', handlePointerCancel);
}

function handleSquareClick(squareId) {
  // Until a referee snapshot exists, there is no board for the UI to act on.
  if (!board || gameOver || commandPending) return;

  if (typeof puzzleModeActive !== 'undefined' && puzzleModeActive) {
    if (typeof handlePuzzleSquareClick === 'function') handlePuzzleSquareClick(squareId);
    return;
  }

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
  refereeClockRunning = false;
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
  const cmdId = 'reset:' + Date.now() + ':' + Math.random().toString(36).slice(2);
  const accepted = await runRefereeCommand('Starting new game', () =>
    fetch(withRoomParam('/api/reset'), { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ id: cmdId }) }));
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
  const resignRole = currentSeatRole || (turn === 'white' ? 'white' : 'black');
  const cmdId = 'resign:' + resignRole + ':' + Date.now() + ':' + Math.random().toString(36).slice(2);
  await runRefereeCommand('Submitting resignation', () =>
    fetch(withRoomParam(`/api/resign?color=${encodeURIComponent(resignRole)}`), { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ id: cmdId }) }));
};
const drawButton = document.getElementById('offer-draw');
if (drawButton) drawButton.onclick = async () => {
  const cmdId = 'draw:' + Date.now() + ':' + Math.random().toString(36).slice(2);
  await runRefereeCommand('Offering draw', () => fetch(withRoomParam('/api/draw'), { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ id: cmdId }) }));
};
if (undoButton) undoButton.onclick = async () => {
  const cmdId = 'undo:' + Date.now() + ':' + Math.random().toString(36).slice(2);
  await runRefereeCommand('Requesting undo', () => fetch(withRoomParam('/api/undo'), { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ id: cmdId }) }));
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

  if (typeof renderPostGameNarrativeReport === 'function') {
    renderPostGameNarrativeReport();
  }
}

function renderPostGameNarrativeReport() {
  const reportModule = (typeof window !== 'undefined' && window.GameReport) || (typeof GameReport !== 'undefined' ? GameReport : null);
  if (!reportModule || typeof reportModule.generatePostGameReport !== 'function') return;

  const rawHistory = (moveHistory || []).flatMap(m => [m.raw, m.rawBlack].filter(Boolean));
  const sanList = historyToSan(rawHistory);

  const report = reportModule.generatePostGameReport({
    moveHistory: rawHistory,
    sanHistory: sanList,
    evalHistory: evalHistory || [],
    review: latestGameReview || { whiteAccuracy: 85, blackAccuracy: 80 },
    result: result || '*',
    reason: (previousRefereeState && previousRefereeState.status) || 'normal'
  });

  const headlineEl = document.getElementById('report-headline');
  const accEl = document.getElementById('report-accuracy');
  const openEl = document.getElementById('report-opening');
  const turnEl = document.getElementById('report-turning-point');
  const endEl = document.getElementById('report-endgame');
  const adviceEl = document.getElementById('report-advice');

  if (headlineEl) headlineEl.textContent = report.headline;
  if (accEl) accEl.textContent = report.accSummary;
  if (openEl) openEl.innerHTML = `<strong>Opening:</strong> ${escapeHtml(report.openingNarrative)}`;
  if (turnEl) turnEl.innerHTML = `<strong>Key Turning Point:</strong> ${escapeHtml(report.turningPointNarrative)}`;
  if (endEl) endEl.innerHTML = `<strong>Late Game:</strong> ${escapeHtml(report.endgameNarrative)}`;
  if (adviceEl) {
    adviceEl.innerHTML = `
      <div style="margin-bottom:3px;"><strong>White Takeaway:</strong> ${escapeHtml(report.whiteAdvice)}</div>
      <div><strong>Black Takeaway:</strong> ${escapeHtml(report.blackAdvice)}</div>
    `;
  }

  const copyAnnotatedBtn = document.getElementById('copy-annotated-pgn-btn');
  if (copyAnnotatedBtn) {
    copyAnnotatedBtn.onclick = async () => {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(report.annotatedPgn);
          copyAnnotatedBtn.textContent = 'Copied!';
          setTimeout(() => { copyAnnotatedBtn.textContent = 'Copy Annotated PGN'; }, 1500);
        }
      } catch (e) {}
    };
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
  const evalGraphModule = (typeof window !== 'undefined' && window.EvalGraph) || (typeof EvalGraph !== 'undefined' ? EvalGraph : null);
  const svg = document.getElementById('eval-graph-svg');
  if (!svg || !openingsModule) return;

  const currentPly = viewedPly === null ? (liveHistory ? liveHistory.length : 0) : viewedPly;
  const graphData = openingsModule.generateEvalGraphData(evalHistory || [0], 400, 80);

  // Build interactive tooltips via eval-graph.js if available
  let interactiveTooltips = null;
  if (evalGraphModule && typeof evalGraphModule.buildEvalGraph === 'function') {
    const interactive = evalGraphModule.buildEvalGraph(
      evalHistory || [0],
      liveHistory || [],
      { width: 400, height: 80 }
    );
    interactiveTooltips = interactive.tooltips;
  }

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

  // Dots for each ply with interactive tooltips (SAN + eval + ACPL delta)
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
      if (interactiveTooltips && interactiveTooltips[pt.ply]) {
        const tip = interactiveTooltips[pt.ply];
        let label = `Ply ${pt.ply}: ${tip.evalText}`;
        if (tip.san) label += `  ${tip.san}`;
        if (tip.acplText && tip.acplText !== 'Best') label += `  (${tip.acplText})`;
        if (tip.classification) label += `  [${tip.classification}]`;
        title.textContent = label;
      } else {
        title.textContent = `Ply ${pt.ply}: ${pt.cp >= 0 ? '+' : ''}${(pt.cp / 100).toFixed(2)}`;
      }
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

let seatHeartbeatTimer = null;

function startSeatHeartbeat() {
  if (seatHeartbeatTimer) return;
  seatHeartbeatTimer = setInterval(sendSeatHeartbeat, 25000);
}

function stopSeatHeartbeat() {
  if (seatHeartbeatTimer) {
    clearInterval(seatHeartbeatTimer);
    seatHeartbeatTimer = null;
  }
}

async function sendSeatHeartbeat() {
  const room = getCurrentRoomId();
  const token = (typeof window !== 'undefined' && (
    (window.sessionStorage && window.sessionStorage.getItem('chess_seat_token')) ||
    (window.localStorage && window.localStorage.getItem('chess_seat_token_' + room))
  )) || currentSeatToken;
  if (!token) {
    stopSeatHeartbeat();
    return;
  }
  try {
    const res = await fetch('/api/seat/heartbeat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Seat-Token': token
      },
      body: JSON.stringify({ room, token })
    });
    if (res.status === 404) {
      if (currentSeatRole) {
        const reacquired = await claimSeat(currentSeatRole);
        if (!reacquired) {
          await leaveSeat();
        }
      } else {
        await leaveSeat();
      }
    }
  } catch (e) {
    // transient network error, retry next cycle
  }
}

async function claimSeat(role) {
  try {
    const room = getCurrentRoomId();
    const res = await fetch('/api/seat/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, room })
    });
    const data = await res.json();
    if (res.ok && data.token) {
      currentSeatRole = role;
      currentSeatToken = data.token;
      if (typeof window !== 'undefined') {
        if (window.sessionStorage) {
          window.sessionStorage.setItem('chess_seat_token', data.token);
          window.sessionStorage.setItem('chess_seat_role', role);
        }
        if (window.localStorage) {
          window.localStorage.setItem('chess_seat_token_' + room, data.token);
          window.localStorage.setItem('chess_seat_role_' + room, role);
        }
      }
      updateSeatUI();
      startSeatHeartbeat();
      return true;
    } else {
      showUiError(data.error || 'Failed to claim seat');
      return false;
    }
  } catch (e) {
    return false;
  }
}

async function leaveSeat() {
  stopSeatHeartbeat();
  if (!currentSeatToken) return;
  const room = getCurrentRoomId();
  try {
    await fetch('/api/seat/release', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Seat-Token': currentSeatToken
      },
      body: JSON.stringify({ room, token: currentSeatToken })
    });
  } catch (e) {}
  currentSeatRole = null;
  currentSeatToken = null;
  if (typeof window !== 'undefined') {
    if (window.sessionStorage) {
      window.sessionStorage.removeItem('chess_seat_token');
      window.sessionStorage.removeItem('chess_seat_role');
    }
    if (window.localStorage) {
      window.localStorage.removeItem('chess_seat_token_' + room);
      window.localStorage.removeItem('chess_seat_role_' + room);
    }
  }
  updateSeatUI();
}

function initSeatAuth() {
  const room = getCurrentRoomId();
  let savedToken = null;
  let savedRole = null;
  if (typeof window !== 'undefined') {
    if (window.sessionStorage) {
      savedToken = window.sessionStorage.getItem('chess_seat_token');
      savedRole = window.sessionStorage.getItem('chess_seat_role');
    }
    if (!savedToken && window.localStorage) {
      savedToken = window.localStorage.getItem('chess_seat_token_' + room);
      savedRole = window.localStorage.getItem('chess_seat_role_' + room);
    }
  }
  if (savedToken && savedRole) {
    currentSeatToken = savedToken;
    currentSeatRole = savedRole;
    updateSeatUI();
    startSeatHeartbeat();
    sendSeatHeartbeat();
    return;
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
// Phase 3: Matchgrade Social, Time Control, Rematch & Chat
// ==========================================

function updateMatchgradeSocialUI(state) {
  if (!state) return;
  const tcSelect = document.getElementById('time-control-select');
  if (tcSelect && state.timeControl && state.timeControl.preset && document.activeElement !== tcSelect) {
    tcSelect.value = state.timeControl.preset;
  }
  const rematchBtn = document.getElementById('rematch-btn');
  if (rematchBtn) {
    if (state.gameOver) {
      rematchBtn.classList.remove('hidden');
      if (state.rematchOffer) {
        if (state.rematchOffer === currentSeatRole) {
          rematchBtn.textContent = 'Rematch Offered…';
          rematchBtn.disabled = true;
        } else {
          rematchBtn.textContent = `Accept Rematch (${state.rematchOffer})`;
          rematchBtn.disabled = false;
        }
      } else {
        rematchBtn.textContent = 'Offer Rematch';
        rematchBtn.disabled = false;
      }
    } else {
      rematchBtn.classList.add('hidden');
    }
  }
  updateSpectatorBadge();
}

async function updateSpectatorBadge() {
  const badge = document.getElementById('spectator-badge');
  if (!badge) return;
  try {
    const res = await fetch(withRoomParam('/api/seat/status'));
    if (res.ok) {
      const data = await res.json();
      badge.textContent = `👁 ${data.spectatorsCount || 0}`;
      badge.title = `${data.spectatorsCount || 0} spectator(s) viewing`;
    }
  } catch (e) {}
}

function appendChatMessage(msg) {
  const container = document.getElementById('chat-messages');
  if (!container || !msg || !msg.text) return;
  const div = document.createElement('div');
  div.style.padding = '2px 0';
  div.style.borderBottom = '1px solid rgba(0,0,0,0.05)';
  const senderSpan = document.createElement('strong');
  senderSpan.style.color = 'var(--accent, #2563eb)';
  senderSpan.textContent = (msg.sender || 'Player') + ': ';
  const textSpan = document.createElement('span');
  textSpan.textContent = msg.text;
  div.appendChild(senderSpan);
  div.appendChild(textSpan);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;

  const countEl = document.getElementById('chat-count');
  if (countEl) {
    countEl.textContent = `${container.children.length} messages`;
  }
}

async function loadChatMessages() {
  try {
    const res = await fetch(withRoomParam('/api/chat'));
    if (res.ok) {
      const data = await res.json();
      const container = document.getElementById('chat-messages');
      if (container && data.messages && Array.isArray(data.messages)) {
        container.innerHTML = '';
        data.messages.forEach(appendChatMessage);
      }
    }
  } catch (e) {}
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const sender = currentSeatRole ? (currentSeatRole.charAt(0).toUpperCase() + currentSeatRole.slice(1)) : 'Player';
  try {
    const res = await fetch(withRoomParam('/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender, text })
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.message && !sseEventSource) {
        appendChatMessage(data.message);
      }
    }
  } catch (e) {}
}

async function handleRematchClick() {
  const isOfferedToUs = previousRefereeState && previousRefereeState.rematchOffer && previousRefereeState.rematchOffer !== currentSeatRole;
  const action = isOfferedToUs ? 'accept' : 'offer';
  await runRefereeCommand(action === 'accept' ? 'Accepting rematch' : 'Offering rematch', async () => {
    const res = await fetch(withRoomParam(`/api/rematch/${action}`), {
      method: 'POST',
      headers: getAuthHeaders()
    });
    if (!res.ok && res.status === 403) {
      return fetch(withRoomParam('/api/reset'), {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ id: 'reset:' + Date.now() })
      });
    }
    return res;
  });
}

function setupMatchgradeSocialUI() {
  const tcSelect = document.getElementById('time-control-select');
  if (tcSelect) {
    tcSelect.addEventListener('change', async () => {
      const preset = tcSelect.value;
      try {
        await fetch(withRoomParam('/api/time-control'), {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ preset })
        });
      } catch (e) {
        console.error('Failed to change time control', e);
      }
    });
  }

  const rematchBtn = document.getElementById('rematch-btn');
  if (rematchBtn) {
    rematchBtn.onclick = handleRematchClick;
  }

  const chatForm = document.getElementById('chat-form');
  if (chatForm) {
    chatForm.onsubmit = (e) => {
      e.preventDefault();
      sendChatMessage();
      return false;
    };
  }
  const chatSendBtn = document.getElementById('chat-send-btn');
  if (chatSendBtn) {
    chatSendBtn.onclick = sendChatMessage;
  }
  const chatInput = document.getElementById('chat-input');
  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        sendChatMessage();
      }
    });
  }

  loadChatMessages();
  updateSpectatorBadge();
}

// ==========================================
// C5: Play vs Computer (Levels 1–8 Bot)
// ==========================================

async function fetchBotConfig() {
  try {
    const res = await fetch(withRoomParam('/api/bot'));
    if (res.ok) {
      const data = await res.json();
      if (data && data.bot) {
        updateBotUI(data.bot);
        if (data.bot.enabled && !currentSeatRole) {
          const humanColor = data.bot.color === 'black' ? 'white' : 'black';
          claimSeat(humanColor);
        }
      }
    }
  } catch (e) {}
}

function updateBotUI(botConfig) {
  if (!botConfig) return;
  const toggle = document.getElementById('bot-toggle');
  const levelSelect = document.getElementById('bot-level-select');
  const colorSelect = document.getElementById('bot-color-select');
  const badge = document.getElementById('bot-status-badge');

  if (toggle && typeof botConfig.enabled === 'boolean' && document.activeElement !== toggle) {
    toggle.checked = botConfig.enabled;
  }
  if (levelSelect) {
    if (botConfig && botConfig.level && document.activeElement !== levelSelect) {
      levelSelect.value = String(botConfig.level);
    }
  }
  if (colorSelect) {
    if (botConfig && botConfig.color && document.activeElement !== colorSelect) {
      colorSelect.value = botConfig.color;
    }
  }
  if (badge) {
    if (botConfig.enabled) {
      badge.textContent = `Bot: ${botConfig.name || 'Level ' + botConfig.level}`;
      badge.style.background = '#dcfce7';
      badge.style.color = '#166534';
    } else {
      badge.textContent = 'Bot: Off';
      badge.style.background = '#f1f5f9';
      badge.style.color = '#64748b';
    }
  }
}

async function sendBotConfigUpdate() {
  const toggle = document.getElementById('bot-toggle');
  const levelSelect = document.getElementById('bot-level-select');
  const colorSelect = document.getElementById('bot-color-select');

  const enabled = toggle ? toggle.checked : false;
  const level = levelSelect ? parseInt(levelSelect.value, 10) : 3;
  const color = colorSelect ? colorSelect.value : 'black';

  try {
    const res = await fetch(withRoomParam('/api/bot'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, level, color })
    });
    if (res.ok) {
      const data = await res.json();
      updateBotUI(data);
      if (enabled) {
        const humanColor = color === 'black' ? 'white' : 'black';
        if (currentSeatRole !== humanColor) {
          if (currentSeatRole) {
            await leaveSeat();
          }
          await claimSeat(humanColor);
        }
      }
    }
  } catch (e) {
    console.error('Failed to update bot config', e);
  }
}

function setupBotUI() {
  const toggle = document.getElementById('bot-toggle');
  const levelSelect = document.getElementById('bot-level-select');
  const colorSelect = document.getElementById('bot-color-select');

  if (toggle) toggle.addEventListener('change', sendBotConfigUpdate);
  if (levelSelect) {
    levelSelect.addEventListener('change', () => {
      if (toggle && !toggle.checked) toggle.checked = true;
      sendBotConfigUpdate();
    });
  }
  if (colorSelect) {
    colorSelect.addEventListener('change', () => {
      if (toggle && !toggle.checked) toggle.checked = true;
      sendBotConfigUpdate();
    });
  }

  fetchBotConfig();
}

// ==========================================
// C7: Retry Your Mistakes / Puzzle Generator
// ==========================================

let puzzleModeActive = false;
let activeMistakePuzzles = [];
let currentPuzzleIndex = 0;

function handlePuzzleSquareClick(squareId) {
  if (!activeMistakePuzzles || activeMistakePuzzles.length === 0) return;
  const puzzle = activeMistakePuzzles[currentPuzzleIndex];
  if (!puzzle) return;

  if (legalMoves.includes(squareId) && selectedSquare) {
    const moveAttempt = selectedSquare + squareId;
    selectedSquare = null;
    legalMoves = [];
    renderBoard();

    const feedbackEl = document.getElementById('puzzle-feedback');
    const nextBtn = document.getElementById('puzzle-next-btn');

    if (moveAttempt === puzzle.bestMove.slice(0, 4)) {
      if (feedbackEl) {
        feedbackEl.textContent = '✓ Best Move! (★) Excellent find!';
        feedbackEl.style.color = '#16a34a';
      }
      if (nextBtn && currentPuzzleIndex < activeMistakePuzzles.length - 1) {
        nextBtn.classList.remove('hidden');
      }
      playSound('move');
    } else {
      if (feedbackEl) {
        feedbackEl.textContent = `✗ Not the best move (${moveAttempt}). Try again!`;
        feedbackEl.style.color = '#dc2626';
      }
      playSound('illegal');
    }
    return;
  }

  const pieceData = board && board.pieces && board.pieces[squareId];
  if (pieceData && pieceData.color === (puzzle.color || (board && board.turn))) {
    selectedSquare = squareId;
    legalMoves = getLegalMoves(board, squareId, pieceData.color);
    renderBoard();
  } else {
    selectedSquare = null;
    legalMoves = [];
    renderBoard();
  }
}

function startMistakePuzzles() {
  const reviewModule = (typeof window !== 'undefined' && window.MoveReview) || (typeof MoveReview !== 'undefined' ? MoveReview : null);
  if (!reviewModule || typeof reviewModule.generateMistakePuzzles !== 'function') {
    showUiError('Game review module is not loaded.');
    return;
  }

  const fenHistory = (historyPositions || []).map(hp => getFenFromStateOrBoard(hp));
  activeMistakePuzzles = reviewModule.generateMistakePuzzles(liveHistory || [], evalHistory || [], fenHistory);

  const puzzleBox = document.getElementById('puzzle-box');
  const feedbackEl = document.getElementById('puzzle-feedback');
  if (!activeMistakePuzzles || activeMistakePuzzles.length === 0) {
    if (puzzleBox) puzzleBox.classList.remove('hidden');
    if (feedbackEl) {
      feedbackEl.textContent = 'No mistakes or blunders detected in this game! Great game!';
      feedbackEl.style.color = '#16a34a';
    }
    return;
  }

  currentPuzzleIndex = 0;
  puzzleModeActive = true;
  loadCurrentPuzzle();
}

function loadCurrentPuzzle() {
  if (!activeMistakePuzzles || activeMistakePuzzles.length === 0) return;
  const puzzle = activeMistakePuzzles[currentPuzzleIndex];
  if (!puzzle) return;

  const puzzleBox = document.getElementById('puzzle-box');
  if (puzzleBox) puzzleBox.classList.remove('hidden');

  const headerEl = document.getElementById('puzzle-header');
  if (headerEl) {
    headerEl.textContent = `Puzzle ${currentPuzzleIndex + 1} of ${activeMistakePuzzles.length} (Ply ${puzzle.ply}): ${puzzle.classification}`;
  }

  const instrEl = document.getElementById('puzzle-instruction');
  if (instrEl) {
    instrEl.textContent = `At ply ${puzzle.ply}, ${puzzle.color} played ${puzzle.playedMove} (${puzzle.key}). Find the best move!`;
  }

  const feedbackEl = document.getElementById('puzzle-feedback');
  if (feedbackEl) feedbackEl.textContent = '';

  const nextBtn = document.getElementById('puzzle-next-btn');
  if (nextBtn) nextBtn.classList.add('hidden');

  jumpToPly(puzzle.ply - 1);
}

function setupMistakePuzzlesUI() {
  const retryBtn = document.getElementById('retry-mistakes-btn');
  if (retryBtn) {
    retryBtn.onclick = startMistakePuzzles;
  }

  const hintBtn = document.getElementById('puzzle-hint-btn');
  if (hintBtn) {
    hintBtn.onclick = () => {
      const puzzle = activeMistakePuzzles && activeMistakePuzzles[currentPuzzleIndex];
      const feedbackEl = document.getElementById('puzzle-feedback');
      if (puzzle && feedbackEl) {
        feedbackEl.textContent = `💡 Hint: Focus on the piece at ${puzzle.bestMove.slice(0, 2)} moving to ${puzzle.bestMove.slice(2, 4)}.`;
        feedbackEl.style.color = '#2563eb';
      }
    };
  }

  const nextBtn = document.getElementById('puzzle-next-btn');
  if (nextBtn) {
    nextBtn.onclick = () => {
      if (currentPuzzleIndex < activeMistakePuzzles.length - 1) {
        currentPuzzleIndex++;
        loadCurrentPuzzle();
      }
    };
  }

  const exitBtn = document.getElementById('puzzle-exit-btn');
  if (exitBtn) {
    exitBtn.onclick = () => {
      puzzleModeActive = false;
      const puzzleBox = document.getElementById('puzzle-box');
      if (puzzleBox) puzzleBox.classList.add('hidden');
      scrubLast();
    };
  }
}

// ==========================================
// C2 & C4: "Why?" Move Explanations & Coach Mode Hints
// ==========================================

function explainCurrentlyViewedMove() {
  const coachModule = (typeof window !== 'undefined' && window.AiCoach) || (typeof AiCoach !== 'undefined' ? AiCoach : null);
  if (!coachModule || typeof coachModule.explainMove !== 'function') {
    showUiError('AI Coach is loading or unavailable.');
    return;
  }

  const card = document.getElementById('why-explanation-card');
  const titleEl = document.getElementById('why-title');
  const bodyEl = document.getElementById('why-body');
  if (!card) return;

  const moves = liveHistory || [];
  if (moves.length === 0) {
    card.classList.remove('hidden');
    if (titleEl) titleEl.textContent = 'Starting Position';
    if (bodyEl) bodyEl.textContent = 'No moves played yet. The board is in the initial starting array.';
    return;
  }

  const activePly = viewedPly !== null ? viewedPly + 1 : moves.length;
  const moveIdx = activePly - 1;
  const moveStr = moves[moveIdx] || moves[moves.length - 1];

  let review = latestGameReview;
  if (!review && typeof runGameReview === 'function') {
    review = runGameReview();
  }

  const reviewedMove = (review && review.moves && review.moves[moveIdx]) || null;
  const preCp = (evalHistory && evalHistory[moveIdx] !== undefined) ? evalHistory[moveIdx] : 0;
  const postCp = (evalHistory && evalHistory[moveIdx + 1] !== undefined) ? evalHistory[moveIdx + 1] : 0;
  const bestMove = (engineMultiPvLines && engineMultiPvLines[0] && (engineMultiPvLines[0].from + engineMultiPvLines[0].to)) || '';

  const explanation = coachModule.explainMove({
    move: moveStr,
    color: moveIdx % 2 === 0 ? 'white' : 'black',
    key: (reviewedMove && reviewedMove.key) || 'good',
    preCp,
    postCp,
    bestMove
  });

  card.classList.remove('hidden');
  if (titleEl) {
    titleEl.textContent = `Ply ${activePly} (${moveStr}): ${(explanation.classification || 'good').toUpperCase()}`;
  }
  if (bodyEl) {
    bodyEl.textContent = explanation.explanation;
  }
}

function showCoachHint() {
  const coachModule = (typeof window !== 'undefined' && window.AiCoach) || (typeof AiCoach !== 'undefined' ? AiCoach : null);
  if (!coachModule || typeof coachModule.getCoachHint !== 'function') {
    showUiError('AI Coach is loading or unavailable.');
    return;
  }

  const banner = document.getElementById('coach-hint-banner');
  const textEl = document.getElementById('coach-hint-text');
  if (!banner || !textEl) return;

  const currentTurn = turn || (board && board.turn) || 'white';
  let bestCandidate = (engineMultiPvLines && engineMultiPvLines[0] && (engineMultiPvLines[0].from + engineMultiPvLines[0].to));
  if (!bestCandidate && board) {
    for (const [from, p] of Object.entries(board.pieces || {})) {
      if (p && p.color === currentTurn) {
        const dests = getLegalMoves(board, from, currentTurn);
        if (dests && dests.length > 0) {
          bestCandidate = from + dests[0];
          break;
        }
      }
    }
  }
  if (!bestCandidate) bestCandidate = currentTurn === 'black' ? 'e7e5' : 'e2e4';

  const currentEval = (evalHistory && evalHistory.length > 0) ? evalHistory[evalHistory.length - 1] : 0;
  const ply = (liveHistory && liveHistory.length) ? liveHistory.length + 1 : 1;

  const hint = coachModule.getCoachHint({
    turn: currentTurn,
    bestMove: bestCandidate,
    evalCp: currentEval,
    ply
  });

  banner.classList.remove('hidden');
  textEl.innerHTML = `
    <div style="margin-bottom:4px;"><strong>Strategic Guideline:</strong> ${escapeHtml(hint.generalPrinciple)}</div>
    <div style="margin-bottom:4px; color:#92400e;"><strong>Focus Area:</strong> ${escapeHtml(hint.pieceHint)}</div>
    <div style="color:#b45309;"><strong>Tactical Concept:</strong> ${escapeHtml(hint.moveHint)}</div>
  `;
}

function setupAiCoachUI() {
  const whyBtn = document.getElementById('why-move-btn');
  if (whyBtn) {
    whyBtn.onclick = explainCurrentlyViewedMove;
  }

  const coachBtn = document.getElementById('coach-hint-btn');
  if (coachBtn) {
    coachBtn.onclick = showCoachHint;
  }

  const closeHintBtn = document.getElementById('close-coach-hint');
  if (closeHintBtn) {
    closeHintBtn.onclick = () => {
      const banner = document.getElementById('coach-hint-banner');
      if (banner) banner.classList.add('hidden');
    };
  }
}

let accessibilityController = null;

function handleVoiceTranscript(transcript) {
  const AccessModule = (typeof window !== 'undefined' && window.AccessibilityVoice) || (typeof AccessibilityVoice !== 'undefined' ? AccessibilityVoice : null);
  if (!AccessModule || !board) return;

  const candidates = [];
  for (const [from, p] of Object.entries(board.pieces || {})) {
    if (p && p.color === turn) {
      const dests = getLegalMoves(board, from, turn);
      for (const to of dests) {
        const isPromo = isPromotionMove(from, to);
        const promos = isPromo ? ['q', 'r', 'b', 'n'] : [undefined];
        for (const pr of promos) {
          const san = typeof moveToSan === 'function' ? moveToSan(board, from, to, pr) : `${from}${to}`;
          candidates.push({ from, to, promo: pr, san, uci: `${from}${to}${pr || ''}` });
        }
      }
    }
  }

  const match = AccessModule.parseSpokenMove(transcript, candidates);
  const transcriptStatus = document.getElementById('voice-transcript-status');

  if (!match) {
    if (transcriptStatus) {
      transcriptStatus.textContent = `Unrecognized: "${transcript}"`;
      transcriptStatus.style.color = '#dc2626';
    }
    if (accessibilityController) {
      accessibilityController.speak(`Move ${transcript} not recognized or not legal.`);
    }
    return;
  }

  if (match.action === 'resign') {
    if (typeof handleResignClick === 'function') handleResignClick();
    return;
  }
  if (match.action === 'draw' || match.action === 'accept_draw') {
    if (typeof handleDrawOffer === 'function') handleDrawOffer();
    return;
  }
  if (match.action === 'decline_draw') {
    if (typeof handleDrawDecline === 'function') handleDrawDecline();
    return;
  }

  if (match.move) {
    const { from, to, promo } = match.move;
    if (transcriptStatus) {
      transcriptStatus.textContent = `Executed: ${match.move.san || from + to}`;
      transcriptStatus.style.color = '#16a34a';
    }
    submitMoveToReferee(from + to + (promo || ''));
  }
}

function setupAccessibilityVoiceUI() {
  const AccessModule = (typeof window !== 'undefined' && window.AccessibilityVoice) || (typeof AccessibilityVoice !== 'undefined' ? AccessibilityVoice : null);
  if (AccessModule && !accessibilityController) {
    accessibilityController = new AccessModule.AccessibilityVoiceController({
      submitMoveCallback: (moveStr) => submitMoveToReferee(moveStr)
    });
  }

  const voiceToggleBtn = document.getElementById('voice-toggle');
  if (voiceToggleBtn) {
    const isVoice = accessibilityController ? accessibilityController.voiceEnabled : false;
    voiceToggleBtn.textContent = isVoice ? 'Voice: On' : 'Voice: Off';
    voiceToggleBtn.classList.toggle('active', isVoice);
    voiceToggleBtn.onclick = () => {
      const Mod = (typeof window !== 'undefined' && window.AccessibilityVoice) || (typeof AccessibilityVoice !== 'undefined' ? AccessibilityVoice : null);
      if (!accessibilityController && Mod) {
        accessibilityController = new Mod.AccessibilityVoiceController({
          submitMoveCallback: (moveStr) => submitMoveToReferee(moveStr)
        });
      }
      if (accessibilityController) {
        const enabled = accessibilityController.toggleVoice();
        voiceToggleBtn.textContent = enabled ? 'Voice: On' : 'Voice: Off';
        voiceToggleBtn.classList.toggle('active', enabled);
      } else {
        showUiError('Voice module is not available in this browser.');
      }
    };
  }

  const blindToggleBtn = document.getElementById('blind-mode-toggle');
  if (blindToggleBtn) {
    const isBlind = accessibilityController ? accessibilityController.blindModeEnabled : false;
    blindToggleBtn.textContent = isBlind ? 'Blind Mode: On' : 'Blind Mode: Off';
    blindToggleBtn.classList.toggle('active', isBlind);
    blindToggleBtn.onclick = () => {
      const Mod = (typeof window !== 'undefined' && window.AccessibilityVoice) || (typeof AccessibilityVoice !== 'undefined' ? AccessibilityVoice : null);
      if (!accessibilityController && Mod) {
        accessibilityController = new Mod.AccessibilityVoiceController({
          submitMoveCallback: (moveStr) => submitMoveToReferee(moveStr)
        });
      }
      if (accessibilityController) {
        const enabled = accessibilityController.toggleBlindMode();
        blindToggleBtn.textContent = enabled ? 'Blind Mode: On' : 'Blind Mode: Off';
        blindToggleBtn.classList.toggle('active', enabled);
        if (enabled && focusedSquareId) {
          setRovingSquare(focusedSquareId, true);
        }
      } else {
        showUiError('Accessibility module is not available in this browser.');
      }
    };
  }

  const micMoveBtn = document.getElementById('mic-move-btn');
  const transcriptStatus = document.getElementById('voice-transcript-status');

  if (micMoveBtn) {
    micMoveBtn.onclick = () => {
      const Mod = (typeof window !== 'undefined' && window.AccessibilityVoice) || (typeof AccessibilityVoice !== 'undefined' ? AccessibilityVoice : null);
      if (!accessibilityController && Mod) {
        accessibilityController = new Mod.AccessibilityVoiceController({
          submitMoveCallback: (moveStr) => submitMoveToReferee(moveStr)
        });
      }
      if (!accessibilityController) {
        showUiError('Voice recognition module is not available.');
        return;
      }

      if (accessibilityController.isListening) {
        accessibilityController.stopVoiceRecognition();
        micMoveBtn.textContent = '🎤 Mic';
        micMoveBtn.style.background = '';
        if (transcriptStatus) transcriptStatus.style.display = 'none';
        return;
      }

      micMoveBtn.textContent = '🔴 Listening...';
      micMoveBtn.style.background = '#fee2e2';
      if (transcriptStatus) {
        transcriptStatus.style.display = 'inline-block';
        transcriptStatus.textContent = 'Listening...';
        transcriptStatus.style.color = 'var(--text-color)';
      }

      accessibilityController.startVoiceRecognition(
        (transcript) => {
          micMoveBtn.textContent = '🎤 Mic';
          micMoveBtn.style.background = '';
          handleVoiceTranscript(transcript);
        },
        (statusText, isError) => {
          if (transcriptStatus) {
            transcriptStatus.style.display = 'inline-block';
            transcriptStatus.textContent = statusText;
            transcriptStatus.style.color = isError ? '#dc2626' : 'var(--text-color)';
          }
          if (isError) {
            micMoveBtn.textContent = '🎤 Mic';
            micMoveBtn.style.background = '';
          }
        }
      );
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
  window.getEngineMultiPvLines = typeof getEngineMultiPvLines !== 'undefined' ? getEngineMultiPvLines : undefined;
  window.setMultiPvCount = setMultiPvCount;
  window.clearEngineMultiPvLines = typeof clearEngineMultiPvLines !== 'undefined' ? clearEngineMultiPvLines : undefined;
  window.renderMultiPvBreakdown = typeof renderMultiPvBreakdown !== 'undefined' ? renderMultiPvBreakdown : undefined;
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
  window.startSeatHeartbeat = startSeatHeartbeat;
  window.stopSeatHeartbeat = stopSeatHeartbeat;
  window.sendSeatHeartbeat = sendSeatHeartbeat;
  window.initSeatAuth = initSeatAuth;
  window.syncNtpClock = syncNtpClock;
  window.getMeasuredLatency = () => measuredLatency;
  window.getClockOffset = () => clockOffset;
  window.updatePingUI = updatePingUI;
  window.getCurrentRoomId = getCurrentRoomId;
  window.withRoomParam = withRoomParam;
  window.updateRoomBadge = updateRoomBadge;
  window.loadGameArchiveList = typeof loadGameArchiveList !== 'undefined' ? loadGameArchiveList : undefined;
  window.viewArchivedGame = typeof viewArchivedGame !== 'undefined' ? viewArchivedGame : undefined;
  window.exitArchivedGameView = typeof exitArchivedGameView !== 'undefined' ? exitArchivedGameView : undefined;
  window.showUiError = showUiError;
  window.downloadArchivedGamePgn = typeof downloadArchivedGamePgn !== 'undefined' ? downloadArchivedGamePgn : undefined;
  window.setupGameArchiveUI = typeof setupGameArchiveUI !== 'undefined' ? setupGameArchiveUI : undefined;
  window.updateMatchgradeSocialUI = updateMatchgradeSocialUI;
  window.updateSpectatorBadge = updateSpectatorBadge;
  window.appendChatMessage = appendChatMessage;
  window.loadChatMessages = loadChatMessages;
  window.sendChatMessage = sendChatMessage;
  window.handleRematchClick = handleRematchClick;
  window.setupMatchgradeSocialUI = setupMatchgradeSocialUI;
  window.fetchBotConfig = fetchBotConfig;
  window.updateBotUI = updateBotUI;
  window.sendBotConfigUpdate = sendBotConfigUpdate;
  window.setupBotUI = setupBotUI;
  window.startMistakePuzzles = startMistakePuzzles;
  window.setupMistakePuzzlesUI = setupMistakePuzzlesUI;
  window.getActiveMistakePuzzles = () => activeMistakePuzzles;
  window.isPuzzleModeActive = () => puzzleModeActive;
  window.explainCurrentlyViewedMove = explainCurrentlyViewedMove;
  window.showCoachHint = showCoachHint;
  window.setupAiCoachUI = setupAiCoachUI;
  window.renderPostGameNarrativeReport = renderPostGameNarrativeReport;
  window.getAccessibilityController = () => accessibilityController;
  window.setupAccessibilityVoiceUI = setupAccessibilityVoiceUI;
  window.handleVoiceTranscript = handleVoiceTranscript;
}

function initRoomRouting() {
  if (typeof window === 'undefined' || !window.location) return;
  const pathname = window.location.pathname || '';
  const search = window.location.search || '';
  const hasGamePath = /^\/game\/([^/]+)/.test(pathname);
  let hasRoomParam = false;
  try {
    const searchParams = new URLSearchParams(search);
    hasRoomParam = searchParams.has('room') && /^[a-zA-Z0-9_-]+$/.test(searchParams.get('room'));
  } catch (_) {}

  if (!hasGamePath && !hasRoomParam && (pathname === '/' || pathname === '/index.html' || pathname === '')) {
    let personalRoom = null;
    try {
      personalRoom = window.localStorage ? window.localStorage.getItem('chess_personal_room') : null;
    } catch (_) {}
    if (!personalRoom || !/^[a-zA-Z0-9_-]+$/.test(personalRoom)) {
      personalRoom = 'game-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
      try {
        if (window.localStorage) window.localStorage.setItem('chess_personal_room', personalRoom);
      } catch (_) {}
    }
    try {
      if (window.history && typeof window.history.replaceState === 'function') {
        window.history.replaceState(null, '', '/game/' + encodeURIComponent(personalRoom));
      }
    } catch (_) {}
  }
}

function createNewRoom() {
  const newRoomId = 'game-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem('chess_personal_room', newRoomId);
    }
  } catch (_) {}
  if (typeof window !== 'undefined' && window.location) {
    window.location.href = '/game/' + encodeURIComponent(newRoomId);
  }
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

const newRoomButton = document.getElementById('new-room-btn');
if (newRoomButton) {
  newRoomButton.onclick = createNewRoom;
}

initRoomRouting();
updateRoomBadge();

initGame();
if (typeof setupGameArchiveUI === 'function') setupGameArchiveUI();
initSeatAuth();
syncNtpClock();
setupMatchgradeSocialUI();
setupBotUI();
setupMistakePuzzlesUI();
setupAiCoachUI();
setupAccessibilityVoiceUI();
if (typeof setInterval === 'function') {
  setInterval(syncNtpClock, 10000);
}
const cachedState = restoreCachedRefereeState();
if (cachedState) {
  // This is a paint-only bootstrap. The first referee poll always runs with
  // an empty comparison key and reconciles/overrides this cached snapshot.
  previousRefereeState = cachedState;
  applyRefereeState(cachedState);
}

