let board = null;
let turn = 'white';
let selectedSquare = null;
let legalMoves = [];
let whiteTime = 600;
let blackTime = 600;
let lastMoveTimestamp = Date.now();
let moveHistory = [];
let timerInterval = null;
let lastKnownStateJson = "";
let lastMoveTimeStr = "";

const boardElement = document.getElementById('board');
const infoElement = document.getElementById('info');
const statusElement = document.getElementById('status');
const newGameButton = document.getElementById('new-game');
const timerWhite = document.getElementById('timer-white');
const timerBlack = document.getElementById('timer-black');
const historyBody = document.getElementById('history-body');
// ... rest of file

const pieceGlyphs = {
  'white': {
    'k': '\u2654',
    'q': '\u2655',
    'r': '\u2656',
    'b': '\u2657',
    'n': '\u2658',
    'p': '\u2659'
  },
  'black': {
    'k': '\u265A',
    'q': '\u265B',
    'r': '\u265C',
    'b': '\u265D',
    'n': '\u265E',
    'p': '\u265F'
  }
};

function formatTime(seconds) {
  const clamped = Math.max(0, Math.floor(seconds));
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function updateTimers() {
  if (turn === 'white') {
    whiteTime = Math.max(0, whiteTime - 1);
  } else {
    blackTime = Math.max(0, blackTime - 1);
  }

  if (timerWhite) timerWhite.textContent = `White: ${formatTime(whiteTime)}`;
  if (timerBlack) timerBlack.textContent = `Black: ${formatTime(blackTime)}`;

  if (timerWhite) timerWhite.classList.toggle('active-timer', turn === 'white');
  if (timerBlack) timerBlack.classList.toggle('active-timer', turn === 'black');
}

function renderBoard(lastMove = null) {
  if (!board) return;
  boardElement.innerHTML = '';
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const squareId = String.fromCharCode(97 + c) + (8 - r);
      const squareDiv = document.createElement('div');
      squareDiv.className = `square ${(r + c) % 2 === 0 ? 'white-sq' : 'black-sq'}`;
      squareDiv.id = squareId;

      if (lastMove && (lastMove.from === squareId || lastMove.to === squareId)) {
        squareDiv.classList.add('highlight');
      }

      const pieceData = board.pieces[squareId];
      if (pieceData) {
        const { type, color } = pieceData;
        squareDiv.textContent = pieceGlyphs[color][type] || '';
      }

      if (selectedSquare === squareId) {
        squareDiv.classList.add('highlight');
      } else if (legalMoves.includes(squareId)) {
        squareDiv.classList.add('highlight');
      }

      squareDiv.onclick = () => handleSquareClick(squareId);
      boardElement.appendChild(squareDiv);
    }
  }
}

function updateStatus() {
  if (!board) return;
  if (infoElement) infoElement.textContent = `Turn: ${turn.charAt(0).toUpperCase() + turn.slice(1)}`;
  const status = getGameStatus(board, turn);
  if (statusElement) statusElement.textContent = `Status: ${status.charAt(0).toUpperCase() + status.slice(1)}`;
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

async function pollReferee() {
  try {
    const response = await fetch(`.referee-state.json?_t=${Date.now()}`);
    if (!response.ok) throw new Error("Fetch failed");
    const state = await response.json();
    const stateJson = JSON.stringify(state);

    if (stateJson !== lastKnownStateJson) {
      const now = Date.now();
      
      const nextTurn = state.board ? state.board.turn : 'white';
      const prevTurn = turn;
      turn = nextTurn;

      let lastMove = null;
      if (state.history && state.history.length > 0) {
        const history = state.history;
        const latest = history[history.length - 1];
        lastMove = { from: latest.slice(0, 2), to: latest.slice(2, 4) };

        const moves = [];
        for (let i = 0; i < history.length; i += 2) {
          const whiteMove = history[i];
          const blackMove = history[i + 1] || '';
          moves.push({
            whiteMove: whiteMove,
            blackMove: blackMove
          });
        }
        moveHistory = moves;
      }

      if (prevTurn !== nextTurn) {
         if (prevTurn === 'white') {
           whiteTime = Math.min(600, whiteTime + 15);
         } else {
           blackTime = Math.min(600, blackTime + 15);
         }
      }

      board = state.board;
      lastMoveTimestamp = now;
      lastKnownStateJson = stateJson;
      
      renderBoard(lastMove);
      updateStatus();
      updateHistoryUI();
    }
  } catch (e) {
    console.error('pollReferee error:', e);
  }
  setTimeout(pollReferee, 600);
}

function handleSquareClick(squareId) {
  if (legalMoves.includes(squareId)) {
    const fromSquare = selectedSquare;
    board = makeMove(board, fromSquare, squareId);
    turn = board.turn;
    selectedSquare = null;
    legalMoves = [];
    renderBoard();
    updateStatus();
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
  board = createInitialBoard();
  turn = board.turn;
  selectedSquare = null;
  legalMoves = [];
  whiteTime = 300;
  blackTime = 300;
  lastMoveTimestamp = Date.now();
  moveHistory = [];
  lastKnownStateJson = "";
  renderBoard();
  updateStatus();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(updateTimers, 1000);
  pollReferee();
}

if (newGameButton) newGameButton.onclick = initGame;
initGame();
