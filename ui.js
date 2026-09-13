let board = null;
let turn = 'white';
let selectedSquare = null;
let legalMoves = [];
// C1: clocks are owned by the referee file; UI only renders what it polled.
// No local constants here — the referee state always carries clocks {white,black}.
let whiteTime = null;
let blackTime = null;
let moveHistory = [];
let lastKnownStateJson = "";
let pollStarted = false;
let refereeStatus = 'ongoing';
let gameOver = false;
let result = null;
let kingStatus = { kingSquare: null, check: false, mate: false };
let boardFlipped = false;
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

function formatTime(seconds) {
  const clamped = Math.max(0, Math.floor(seconds));
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// C1: pure render of referee-owned clocks. No ticking, no increments —
// the referee file is the only place clock values ever change.
function renderTimers() {
  if (whiteTime === null || blackTime === null) return;
  if (timerWhite) timerWhite.textContent = `White: ${formatTime(whiteTime)}`;
  if (timerBlack) timerBlack.textContent = `Black: ${formatTime(blackTime)}`;

  if (timerWhite) timerWhite.classList.toggle('active-timer', turn === 'white');
  if (timerBlack) timerBlack.classList.toggle('active-timer', turn === 'black');
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
  if (capturedPiece && capturedPiece !== movingPiece) capturedPiece.remove();
  updatePieceElement(movingPiece, afterTo);
  toSquare.appendChild(movingPiece);
}

function renderBoard(lastMove = null, boardBeforeRender = previousBoard) {
  if (!board) return;
  // The board and turn are the latest referee snapshot. Check status is
  // derived from that snapshot for presentation only; it is never stored as
  // an independent game state by the UI.
  kingStatus = getKingStatus(board, turn);
  const renderOrder = getBoardRenderOrder(boardFlipped);
  const orientationChanged = renderedBoardFlipped !== boardFlipped;
  if (orientationChanged) renderCoordinates();

  renderOrder.forEach(squareId => {
      let squareDiv = document.getElementById(squareId);
      if (!squareDiv) {
        squareDiv = document.createElement('div');
        squareDiv.id = squareId;
        squareDiv.onclick = () => handleSquareClick(squareId);
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
        classes.push('highlight');
      }

      const pieceData = board.pieces[squareId];
      if (pieceData) {
        const { type, color } = pieceData;
        renderPieceSvg(squareDiv, color, type);
      }

      if (selectedSquare === squareId) {
        if (!classes.includes('highlight')) classes.push('highlight');
      } else if (legalMoves.includes(squareId)) {
        if (!classes.includes('highlight')) classes.push('highlight');
      }

      const nextClassName = classes.join(' ');
      if (squareDiv.className !== nextClassName) squareDiv.className = nextClassName;

      const beforePiece = boardBeforeRender && boardBeforeRender.pieces[squareId];
      const nextPiece = board.pieces[squareId];
      if (!piecesMatch(beforePiece, nextPiece) || !squareDiv.firstElementChild) {
        reconcilePiece(squareDiv, nextPiece);
      }
  });
  renderedBoardFlipped = boardFlipped;
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

function closePromoModal() {
  if (promoModal) promoModal.classList.add('hidden');
  pendingPromo = null;
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

// C2: submit a move through the referee; the confirmed move string (with
// promo suffix when applicable) is validated server-side and lands in
// .referee-state.json. The poll picks it up and re-renders from that truth.
async function submitMoveToReferee(moveStr) {
  try {
    const res = await fetch('/api/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ move: moveStr })
    });
    const result = await res.json();
    if (!result.ok) {
      console.warn('referee rejected move:', result.error);
    }
  } catch (e) {
    console.error('submitMoveToReferee error:', e);
  }
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
  gameEndOverlay.classList.toggle('hidden', !presentation);
  if (presentation && gameEndBanner) gameEndBanner.textContent = presentation.banner;
}

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

function applyRefereeState(state) {
  const nextTurn = state.board ? state.board.turn : 'white';
  turn = nextTurn;
  refereeStatus = state.status || getGameStatus(state.board, nextTurn);
  gameOver = state.gameOver === true;
  result = state.result || null;
  renderGameEnd(state);
  if (state.clocks && typeof state.clocks.white === 'number') {
    whiteTime = state.clocks.white;
    blackTime = state.clocks.black;
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
  renderBoard(lastMove, boardBeforeRender);
  previousBoard = cloneBoardSnapshot(board);
  renderTimers();
  renderCaptured();
  updateStatus();
  updateHistoryUI();
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
  } catch (e) {
    console.error('pollReferee error:', e);
  }
  setTimeout(pollReferee, 600);
}

function handleSquareClick(squareId) {
  // Until a referee snapshot exists, there is no board for the UI to act on.
  if (!board || gameOver) return;

  if (legalMoves.includes(squareId)) {
    const fromSquare = selectedSquare;
    selectedSquare = null;
    legalMoves = [];
    // C2: promotion opens the piece modal BEFORE finalizing; every confirmed
    // move is submitted through the referee so the state file stays authoritative.
    if (isPromotionMove(fromSquare, squareId)) {
      pendingPromo = { from: fromSquare, to: squareId };
      setPromoPieces(board.pieces[fromSquare].color);
      if (promoModal) promoModal.classList.remove('hidden');
    } else {
      submitMoveToReferee(fromSquare + squareId);
    }
    renderBoard();
    return;
  }

  const pieceData = board.pieces[squareId];
  if (pieceData) {
    const pTurn = pieceData.color;
    if (pTurn === turn) {
      selectedSquare = squareId;
      legalMoves = getLegalMoves(board, squareId, turn);
      renderBoard();
      return;
    }
  }

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
  whiteTime = null;
  blackTime = null;
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
}

async function resetReferee() {
  try {
    const response = await fetch('/api/reset', { method: 'POST' });
    if (!response.ok) throw new Error('referee reset failed');
    // The board is still changed only by the subsequent referee poll.
    lastKnownStateJson = '';
  } catch (e) {
    console.error('resetReferee error:', e);
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
  try {
    await fetch(`/api/resign?${turn === 'white' ? 'w' : 'b'}`, { method: 'POST' });
  } catch (e) { console.error('resign error:', e); }
};
const drawButton = document.getElementById('offer-draw');
if (drawButton) drawButton.onclick = async () => {
  try {
    await fetch('/api/draw', { method: 'POST' });
  } catch (e) { console.error('draw error:', e); }
};
if (undoButton) undoButton.onclick = async () => {
  try {
    await fetch('/api/undo', { method: 'POST' });
  } catch (e) { console.error('undo error:', e); }
};

initGame();
const cachedState = restoreCachedRefereeState();
if (cachedState) {
  // This is a paint-only bootstrap. The first referee poll always runs with
  // an empty comparison key and reconciles/overrides this cached snapshot.
  previousRefereeState = cachedState;
  applyRefereeState(cachedState);
}
