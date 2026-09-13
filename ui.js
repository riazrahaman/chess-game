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
let queuedPremove = null;
let touchDragState = null;

function clearPremove() {
  queuedPremove = null;
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

function playSound(kind) {
  if (!kind) return;
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return;
  try {
    if (!audioContext) audioContext = new AudioCtor();
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    const frequencies = { move: 440, capture: 330, check: 660, gameEnd: 220 };
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = frequencies[kind] || frequencies.move;
    oscillator.type = 'sine';
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, audioContext.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.14);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.15);
  } catch (e) {
    // Audio is optional; a blocked or unavailable context must not affect play.
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

      if (typeof queuedPremove !== 'undefined' && queuedPremove) {
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
      const shouldBeDraggable = gameActive && !!pieceOnSquare && pieceOnSquare.color === turn;
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
  return runRefereeCommand('Submitting move', () => fetch('/api/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ move: moveStr })
    }));
}

function updateStatus() {
  if (!board) return;
  if (infoElement) infoElement.textContent = `Turn: ${turn.charAt(0).toUpperCase() + turn.slice(1)}`;
  const label = refereeStatus.charAt(0).toUpperCase() + refereeStatus.slice(1);
  const checkLabel = kingStatus.mate ? 'Checkmate' : kingStatus.check ? 'Check' : label;
  if (statusElement) statusElement.textContent = `Status: ${result || checkLabel}`;
}

function updateHistoryUI() {
  if (!historyBody) return;
  historyBody.innerHTML = '';
  moveHistory.forEach((move, index) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${index + 1}</td>
      <td>${move.whiteMove}</td>
      <td>${move.blackMove}</td>
    `;
    historyBody.appendChild(row);
  });
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
  const boardBeforeRender = previousBoard;
  board = state.board;
  if (typeof queuedPremove !== 'undefined' && queuedPremove && state.board) {
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
  renderBoard(lastMove, boardBeforeRender);
  previousBoard = cloneBoardSnapshot(board);
  renderTimers();
  renderCaptured();
  updateStatus();
  updateHistoryUI();
  return true;
}

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
    const response = await fetch(`.referee-state.json?_t=${Date.now()}`);
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
    sseEventSource = new EventSource('/api/events');
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
      queuedPremove = { from: fromSquare, to: squareId, color: pieceColor };
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
      clearPremove();
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
    fetch('/api/reset', { method: 'POST' }));
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
    fetch(`/api/resign?${turn === 'white' ? 'w' : 'b'}`, { method: 'POST' }));
};
const drawButton = document.getElementById('offer-draw');
if (drawButton) drawButton.onclick = async () => {
  await runRefereeCommand('Offering draw', () => fetch('/api/draw', { method: 'POST' }));
};
if (undoButton) undoButton.onclick = async () => {
  await runRefereeCommand('Requesting undo', () => fetch('/api/undo', { method: 'POST' }));
};

initGame();
const cachedState = restoreCachedRefereeState();
if (cachedState) {
  // This is a paint-only bootstrap. The first referee poll always runs with
  // an empty comparison key and reconciles/overrides this cached snapshot.
  previousRefereeState = cachedState;
  applyRefereeState(cachedState);
}
