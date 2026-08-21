import {
  createInitialBoard,
  getLegalMoves,
  makeMove,
  isCheck,
  isCheckmate,
  isStalemate,
  getGameStatus
} from './engine.js';

let board = null;
let turn = 'white';
let selectedSquare = null;
let legalMoves = [];

const boardElement = document.getElementById('board');
const infoElement = 'info'; // Wait, I need to select the element
const infoElem = document.getElementById('info');
const statusElement = document.getElementById('status');
const newGameButton = document.getElementById('new-game');

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

function renderBoard() {
  if (!board) return;
  boardElement.innerHTML = '';
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const squareId = String.fromCharCode(97 + c) + (8 - r);
      const squareDiv = document.createElement('div');
      squareDiv.className = `square ${(r + c) % 2 === 0 ? 'white-sq' : 'black-sq'}`;
      squareDiv.id = squareId;

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
  if (infoElem) infoElem.textContent = `Turn: ${turn.charAt(0).toUpperCase() + turn.slice(1)}`;
  const status = getGameStatus(board, turn);
  if (statusElement) statusElement.textContent = `Status: ${status.charAt(0).toUpperCase() + status.slice(1)}`;
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
  renderBoard();
  updateStatus();
}

if (newGameButton) newGameButton.onclick = initGame;
initGame();
