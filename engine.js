/**
 * Chess Engine Game Logic
 * Dual-format module: works as classic browser script (globals) & CommonJS (Node.js)
 *
 * Board State Representation:
 * An object representing the chess game state:
 * {
 *   pieces: {
 *     // Keys are 64 algebraic square strings ('a1' through 'h8')
 *     // Values are null (if empty) or a Piece object:
 *     // { type: 'p' | 'r' | 'n' | 'b' | 'q' | 'k', color: 'white' | 'black' }
 *     'a1': { type: 'r', color: 'white' },
 *     'a2': { type: 'p', color: 'white' },
 *     ...
 *     'e4': null,
 *     ...
 *     'h8': { type: 'r', color: 'black' }
 *   },
 *   castling: {
 *     white: { kingSide: boolean, queenSide: boolean },
 *     black: { kingSide: boolean, queenSide: boolean }
 *   },
 *   enPassant: string | null, // Target square (e.g. 'e3', 'e6') if available for en passant capture, else null
 *   turn: 'white' | 'black',  // Active player turn
 *   halfmoveClock: number,    // For 50-move rule tracking
 *   fullmoveNumber: number    // Incremented after black's move
 * }
 */

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const RANKS = ['1', '2', '3', '4', '5', '6', '7', '8'];

const SQUARES = [];
for (let r = 0; r < 8; r++) {
  for (let f = 0; f < 8; f++) {
    SQUARES.push(`${FILES[f]}${RANKS[r]}`);
  }
}

function getBoardRenderOrder(flipped = false) {
  const ranks = getRankLabels(flipped);
  const files = getFileLabels(flipped);
  return ranks.flatMap(rank => files.map(file => `${file}${rank}`));
}

function getRankLabels(flipped = false) {
  return flipped ? [...RANKS] : [...RANKS].reverse();
}

function getFileLabels(flipped = false) {
  return flipped ? [...FILES].reverse() : [...FILES];
}

const STARTING_COUNTS = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };
const MATERIAL_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function fileOf(sq) {
  return sq.charCodeAt(0) - 97; // 0..7 for 'a'..'h'
}

function rankOf(sq) {
  return sq.charCodeAt(1) - 49; // 0..7 for '1'..'8'
}

function toSquare(f, r) {
  return `${FILES[f]}${RANKS[r]}`;
}

function isValidCoords(f, r) {
  return f >= 0 && f < 8 && r >= 0 && r < 8;
}

function cloneBoard(board) {
  const pieces = {};
  for (const sq of SQUARES) {
    const p = board.pieces ? board.pieces[sq] : null;
    pieces[sq] = p ? { type: p.type, color: p.color } : null;
  }
  return {
    pieces,
    castling: {
      white: {
        kingSide: board.castling?.white?.kingSide ?? true,
        queenSide: board.castling?.white?.queenSide ?? true
      },
      black: {
        kingSide: board.castling?.black?.kingSide ?? true,
        queenSide: board.castling?.black?.queenSide ?? true
      }
    },
    enPassant: board.enPassant ?? null,
    turn: board.turn ?? 'white',
    halfmoveClock: board.halfmoveClock ?? 0,
    fullmoveNumber: board.fullmoveNumber ?? 1
  };
}

/**
 * Returns the starting chess board state.
 * @returns {Object} initial board state
 */
function createInitialBoard() {
  const pieces = {};
  for (const sq of SQUARES) {
    pieces[sq] = null;
  }

  // White major/minor pieces (Rank 1)
  pieces['a1'] = { type: 'r', color: 'white' };
  pieces['b1'] = { type: 'n', color: 'white' };
  pieces['c1'] = { type: 'b', color: 'white' };
  pieces['d1'] = { type: 'q', color: 'white' };
  pieces['e1'] = { type: 'k', color: 'white' };
  pieces['f1'] = { type: 'b', color: 'white' };
  pieces['g1'] = { type: 'n', color: 'white' };
  pieces['h1'] = { type: 'r', color: 'white' };

  // White pawns (Rank 2)
  for (const f of FILES) {
    pieces[`${f}2`] = { type: 'p', color: 'white' };
  }

  // Black major/minor pieces (Rank 8)
  pieces['a8'] = { type: 'r', color: 'black' };
  pieces['b8'] = { type: 'n', color: 'black' };
  pieces['c8'] = { type: 'b', color: 'black' };
  pieces['d8'] = { type: 'q', color: 'black' };
  pieces['e8'] = { type: 'k', color: 'black' };
  pieces['f8'] = { type: 'b', color: 'black' };
  pieces['g8'] = { type: 'n', color: 'black' };
  pieces['h8'] = { type: 'r', color: 'black' };

  // Black pawns (Rank 7)
  for (const f of FILES) {
    pieces[`${f}7`] = { type: 'p', color: 'black' };
  }

  return {
    pieces,
    castling: {
      white: { kingSide: true, queenSide: true },
      black: { kingSide: true, queenSide: true }
    },
    enPassant: null,
    turn: 'white',
    halfmoveClock: 0,
    fullmoveNumber: 1
  };
}

function findKing(board, color) {
  for (const sq of SQUARES) {
    const p = board.pieces?.[sq];
    if (p && p.type === 'k' && p.color === color) {
      return sq;
    }
  }
  return null;
}

function isSquareAttacked(board, targetSquare, byColor) {
  const tf = fileOf(targetSquare);
  const tr = rankOf(targetSquare);

  // 1. Pawn attacks
  // White pawns attack diagonally upwards (from tr - 1)
  // Black pawns attack diagonally downwards (from tr + 1)
  const pawnRank = byColor === 'white' ? tr - 1 : tr + 1;
  for (const pawnFile of [tf - 1, tf + 1]) {
    if (isValidCoords(pawnFile, pawnRank)) {
      const p = board.pieces?.[toSquare(pawnFile, pawnRank)];
      if (p && p.color === byColor && p.type === 'p') {
        return true;
      }
    }
  }

  // 2. Knight attacks
  const knightOffsets = [
    [-2, -1], [-2, 1], [-1, -2], [-1, 2],
    [1, -2], [1, 2], [2, -1], [2, 1]
  ];
  for (const [df, dr] of knightOffsets) {
    const f = tf + df;
    const r = tr + dr;
    if (isValidCoords(f, r)) {
      const p = board.pieces?.[toSquare(f, r)];
      if (p && p.color === byColor && p.type === 'n') {
        return true;
      }
    }
  }

  // 3. King attacks
  const kingOffsets = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1],           [0, 1],
    [1, -1],  [1, 0],  [1, 1]
  ];
  for (const [df, dr] of kingOffsets) {
    const f = tf + df;
    const r = tr + dr;
    if (isValidCoords(f, r)) {
      const p = board.pieces?.[toSquare(f, r)];
      if (p && p.color === byColor && p.type === 'k') {
        return true;
      }
    }
  }

  // 4. Diagonals (Bishop, Queen)
  const diagonalDirs = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  for (const [df, dr] of diagonalDirs) {
    let f = tf + df;
    let r = tr + dr;
    while (isValidCoords(f, r)) {
      const p = board.pieces?.[toSquare(f, r)];
      if (p) {
        if (p.color === byColor && (p.type === 'b' || p.type === 'q')) {
          return true;
        }
        break;
      }
      f += df;
      r += dr;
    }
  }

  // 5. Orthogonals (Rook, Queen)
  const orthogonalDirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [df, dr] of orthogonalDirs) {
    let f = tf + df;
    let r = tr + dr;
    while (isValidCoords(f, r)) {
      const p = board.pieces?.[toSquare(f, r)];
      if (p) {
        if (p.color === byColor && (p.type === 'r' || p.type === 'q')) {
          return true;
        }
        break;
      }
      f += df;
      r += dr;
    }
  }

  return false;
}

function getPseudoLegalMoves(board, square, color) {
  const piece = board.pieces?.[square];
  if (!piece || piece.color !== color) return [];

  const moves = [];
  const f = fileOf(square);
  const r = rankOf(square);
  const opponent = color === 'white' ? 'black' : 'white';

  if (piece.type === 'p') {
    const dir = color === 'white' ? 1 : -1;
    const startRank = color === 'white' ? 1 : 6;

    // Single step forward
    const nextR = r + dir;
    if (isValidCoords(f, nextR) && !board.pieces?.[toSquare(f, nextR)]) {
      moves.push(toSquare(f, nextR));
      // Double step forward from starting rank
      const doubleR = r + 2 * dir;
      if (r === startRank && isValidCoords(f, doubleR) && !board.pieces?.[toSquare(f, doubleR)]) {
        moves.push(toSquare(f, doubleR));
      }
    }

    // Pawn diagonal captures (including en passant)
    for (const df of [-1, 1]) {
      const capF = f + df;
      if (isValidCoords(capF, nextR)) {
        const destSq = toSquare(capF, nextR);
        const targetPiece = board.pieces?.[destSq];
        if (targetPiece && targetPiece.color === opponent) {
          moves.push(destSq);
        } else if (board.enPassant === destSq) {
          moves.push(destSq);
        }
      }
    }
  } else if (piece.type === 'n') {
    const knightOffsets = [
      [-2, -1], [-2, 1], [-1, -2], [-1, 2],
      [1, -2], [1, 2], [2, -1], [2, 1]
    ];
    for (const [df, dr] of knightOffsets) {
      const nf = f + df;
      const nr = r + dr;
      if (isValidCoords(nf, nr)) {
        const destSq = toSquare(nf, nr);
        const targetPiece = board.pieces?.[destSq];
        if (!targetPiece || targetPiece.color === opponent) {
          moves.push(destSq);
        }
      }
    }
  } else if (piece.type === 'b') {
    const diagonalDirs = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    for (const [df, dr] of diagonalDirs) {
      let curF = f + df;
      let curR = r + dr;
      while (isValidCoords(curF, curR)) {
        const destSq = toSquare(curF, curR);
        const targetPiece = board.pieces?.[destSq];
        if (!targetPiece) {
          moves.push(destSq);
        } else {
          if (targetPiece.color === opponent) moves.push(destSq);
          break;
        }
        curF += df;
        curR += dr;
      }
    }
  } else if (piece.type === 'r') {
    const orthogonalDirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [df, dr] of orthogonalDirs) {
      let curF = f + df;
      let curR = r + dr;
      while (isValidCoords(curF, curR)) {
        const destSq = toSquare(curF, curR);
        const targetPiece = board.pieces?.[destSq];
        if (!targetPiece) {
          moves.push(destSq);
        } else {
          if (targetPiece.color === opponent) moves.push(destSq);
          break;
        }
        curF += df;
        curR += dr;
      }
    }
  } else if (piece.type === 'q') {
    const allDirs = [
      [-1, -1], [-1, 1], [1, -1], [1, 1],
      [-1, 0], [1, 0], [0, -1], [0, 1]
    ];
    for (const [df, dr] of allDirs) {
      let curF = f + df;
      let curR = r + dr;
      while (isValidCoords(curF, curR)) {
        const destSq = toSquare(curF, curR);
        const targetPiece = board.pieces?.[destSq];
        if (!targetPiece) {
          moves.push(destSq);
        } else {
          if (targetPiece.color === opponent) moves.push(destSq);
          break;
        }
        curF += df;
        curR += dr;
      }
    }
  } else if (piece.type === 'k') {
    const kingOffsets = [
      [-1, -1], [-1, 0], [-1, 1],
      [0, -1],           [0, 1],
      [1, -1],  [1, 0],  [1, 1]
    ];
    for (const [df, dr] of kingOffsets) {
      const kf = f + df;
      const kr = r + dr;
      if (isValidCoords(kf, kr)) {
        const destSq = toSquare(kf, kr);
        const targetPiece = board.pieces?.[destSq];
        if (!targetPiece || targetPiece.color === opponent) {
          moves.push(destSq);
        }
      }
    }

    // Castling moves
    if (color === 'white' && square === 'e1' && !isSquareAttacked(board, 'e1', 'black')) {
      // White Kingside: e1 -> g1
      if (
        board.castling?.white?.kingSide &&
        board.pieces?.['h1']?.type === 'r' && board.pieces?.['h1']?.color === 'white' &&
        !board.pieces?.['f1'] && !board.pieces?.['g1'] &&
        !isSquareAttacked(board, 'f1', 'black') &&
        !isSquareAttacked(board, 'g1', 'black')
      ) {
        moves.push('g1');
      }
      // White Queenside: e1 -> c1
      if (
        board.castling?.white?.queenSide &&
        board.pieces?.['a1']?.type === 'r' && board.pieces?.['a1']?.color === 'white' &&
        !board.pieces?.['b1'] && !board.pieces?.['c1'] && !board.pieces?.['d1'] &&
        !isSquareAttacked(board, 'd1', 'black') &&
        !isSquareAttacked(board, 'c1', 'black')
      ) {
        moves.push('c1');
      }
    } else if (color === 'black' && square === 'e8' && !isSquareAttacked(board, 'e8', 'white')) {
      // Black Kingside: e8 -> g8
      if (
        board.castling?.black?.kingSide &&
        board.pieces?.['h8']?.type === 'r' && board.pieces?.['h8']?.color === 'black' &&
        !board.pieces?.['f8'] && !board.pieces?.['g8'] &&
        !isSquareAttacked(board, 'f8', 'white') &&
        !isSquareAttacked(board, 'g8', 'white')
      ) {
        moves.push('g8');
      }
      // Black Queenside: e8 -> c8
      if (
        board.castling?.black?.queenSide &&
        board.pieces?.['a8']?.type === 'r' && board.pieces?.['a8']?.color === 'black' &&
        !board.pieces?.['b8'] && !board.pieces?.['c8'] && !board.pieces?.['d8'] &&
        !isSquareAttacked(board, 'd8', 'white') &&
        !isSquareAttacked(board, 'c8', 'white')
      ) {
        moves.push('c8');
      }
    }
  }

  return moves;
}

/**
 * Returns whether the specified player's king is currently in check.
 * @param {Object} board
 * @param {'white'|'black'} [turn]
 * @returns {boolean}
 */
function isCheck(board, turn) {
  const currentTurn = turn || board?.turn || 'white';
  const opponent = currentTurn === 'white' ? 'black' : 'white';
  const kingSquare = findKing(board, currentTurn);
  if (!kingSquare) return false;
  return isSquareAttacked(board, kingSquare, opponent);
}

/**
 * Applies a move from `from` square to `to` square and returns a new board state.
 * Does not mutate the input board.
 * @param {Object} board
 * @param {string} from - e.g. 'e2'
 * @param {string} to - e.g. 'e4'
 * @param {'q'|'r'|'b'|'n'} [promotion='q']
 * @returns {Object} new board state
 */
function makeMove(board, from, to, promotion = 'q') {
  const newBoard = cloneBoard(board);
  const piece = newBoard.pieces[from];
  if (!piece) return newBoard;

  const pieceType = piece.type;
  const pieceColor = piece.color;
  const fromFile = from[0];
  const fromRank = from[1];
  const toFile = to[0];
  const toRank = to[1];

  let isCapture = newBoard.pieces[to] !== null;

  // 1. En Passant capture execution
  if (pieceType === 'p' && to === board.enPassant && fromFile !== toFile && !newBoard.pieces[to]) {
    const capturedPawnSquare = `${toFile}${fromRank}`;
    newBoard.pieces[capturedPawnSquare] = null;
    isCapture = true;
  }

  // 2. Castling rook move execution
  if (pieceType === 'k') {
    if (from === 'e1' && to === 'g1') {
      newBoard.pieces['h1'] = null;
      newBoard.pieces['f1'] = { type: 'r', color: 'white' };
    } else if (from === 'e1' && to === 'c1') {
      newBoard.pieces['a1'] = null;
      newBoard.pieces['d1'] = { type: 'r', color: 'white' };
    } else if (from === 'e8' && to === 'g8') {
      newBoard.pieces['h8'] = null;
      newBoard.pieces['f8'] = { type: 'r', color: 'black' };
    } else if (from === 'e8' && to === 'c8') {
      newBoard.pieces['a8'] = null;
      newBoard.pieces['d8'] = { type: 'r', color: 'black' };
    }
  }

  // 3. Move the piece
  newBoard.pieces[from] = null;
  const finalPiece = { type: pieceType, color: pieceColor };

  // 4. Pawn promotion
  if (pieceType === 'p') {
    if ((pieceColor === 'white' && toRank === '8') || (pieceColor === 'black' && toRank === '1')) {
      const validPromotions = ['q', 'r', 'b', 'n'];
      const chosen = (typeof promotion === 'string' && validPromotions.includes(promotion.toLowerCase()))
        ? promotion.toLowerCase()
        : 'q';
      finalPiece.type = chosen;
    }
  }
  newBoard.pieces[to] = finalPiece;

  // 5. Update En Passant square
  if (pieceType === 'p' && Math.abs(parseInt(toRank, 10) - parseInt(fromRank, 10)) === 2) {
    const epRank = (parseInt(fromRank, 10) + parseInt(toRank, 10)) / 2;
    newBoard.enPassant = `${fromFile}${epRank}`;
  } else {
    newBoard.enPassant = null;
  }

  // 6. Update Castling Rights
  if (from === 'e1') {
    newBoard.castling.white.kingSide = false;
    newBoard.castling.white.queenSide = false;
  } else if (from === 'e8') {
    newBoard.castling.black.kingSide = false;
    newBoard.castling.black.queenSide = false;
  }

  if (from === 'a1') newBoard.castling.white.queenSide = false;
  if (from === 'h1') newBoard.castling.white.kingSide = false;
  if (from === 'a8') newBoard.castling.black.queenSide = false;
  if (from === 'h8') newBoard.castling.black.kingSide = false;

  if (to === 'a1') newBoard.castling.white.queenSide = false;
  if (to === 'h1') newBoard.castling.white.kingSide = false;
  if (to === 'a8') newBoard.castling.black.queenSide = false;
  if (to === 'h8') newBoard.castling.black.kingSide = false;

  // 7. Update turn, clock, move number
  newBoard.turn = (pieceColor === 'white') ? 'black' : 'white';
  if (pieceType === 'p' || isCapture) {
    newBoard.halfmoveClock = 0;
  } else {
    newBoard.halfmoveClock = (board.halfmoveClock ?? 0) + 1;
  }

  if (pieceColor === 'black') {
    newBoard.fullmoveNumber = (board.fullmoveNumber ?? 1) + 1;
  } else {
    newBoard.fullmoveNumber = board.fullmoveNumber ?? 1;
  }

  return newBoard;
}

/**
 * Returns an array of legal destination squares for the piece at `square`.
 * Excludes moves that leave the mover's own king in check.
 * @param {Object} board
 * @param {string} square - e.g. 'e2'
 * @param {'white'|'black'} [turn] - e.g. 'white'
 * @returns {string[]} array of destination squares (e.g. ['e3', 'e4'])
 */
function getLegalMoves(board, square, turn) {
  const currentTurn = turn || board?.turn || (board?.pieces?.[square]?.color) || 'white';
  const piece = board.pieces?.[square];
  if (!piece || piece.color !== currentTurn) return [];

  const pseudoMoves = getPseudoLegalMoves(board, square, currentTurn);
  const legalMoves = [];

  for (const to of pseudoMoves) {
    const nextBoard = makeMove(board, square, to, 'q');
    if (!isCheck(nextBoard, currentTurn)) {
      legalMoves.push(to);
    }
  }

  return legalMoves;
}

function hasAnyLegalMoves(board, turn) {
  for (const sq of SQUARES) {
    const piece = board.pieces?.[sq];
    if (piece && piece.color === turn) {
      const moves = getLegalMoves(board, sq, turn);
      if (moves.length > 0) return true;
    }
  }
  return false;
}

/**
 * Returns whether the specified player is checkmated.
 * @param {Object} board
 * @param {'white'|'black'} [turn]
 * @returns {boolean}
 */
function isCheckmate(board, turn) {
  const currentTurn = turn || board?.turn || 'white';
  if (!isCheck(board, currentTurn)) return false;
  return !hasAnyLegalMoves(board, currentTurn);
}

/**
 * Returns whether the specified player is stalemated.
 * @param {Object} board
 * @param {'white'|'black'} [turn]
 * @returns {boolean}
 */
function isStalemate(board, turn) {
  const currentTurn = turn || board?.turn || 'white';
  if (isCheck(board, currentTurn)) return false;
  return !hasAnyLegalMoves(board, currentTurn);
}

/**
 * Returns the current game status for the player's turn.
 * @param {Object} board
 * @param {'white'|'black'} [turn]
 * @returns {'ongoing'|'check'|'checkmate'|'stalemate'}
 */
function getGameStatus(board, turn) {
  const currentTurn = turn || board?.turn || 'white';
  if (isCheckmate(board, currentTurn)) return 'checkmate';
  if (isStalemate(board, currentTurn)) return 'stalemate';
  if (isCheck(board, currentTurn)) return 'check';
  return 'ongoing';
}

function getKingStatus(board, turn) {
  const currentTurn = turn || board?.turn || 'white';
  let kingSquare = null;
  for (const square of SQUARES) {
    const piece = board.pieces?.[square];
    if (piece && piece.type === 'k' && piece.color === currentTurn) {
      kingSquare = square;
      break;
    }
  }
  const check = isCheck(board, currentTurn);
  return { kingSquare, check, mate: check && isCheckmate(board, currentTurn) };
}

function computeCaptured(board) {
  const remaining = {
    white: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 },
    black: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 }
  };
  for (const square of SQUARES) {
    const piece = board.pieces?.[square];
    if (piece && remaining[piece.color]?.[piece.type] !== undefined) {
      remaining[piece.color][piece.type]++;
    }
  }

  const capturedBy = { white: [], black: [] };
  const capturedValue = { white: 0, black: 0 };
  for (const color of ['white', 'black']) {
    const capturer = color === 'white' ? 'black' : 'white';
    for (const type of ['q', 'r', 'b', 'n', 'p']) {
      const missing = Math.max(0, STARTING_COUNTS[type] - remaining[color][type]);
      for (let i = 0; i < missing; i++) {
        capturedBy[capturer].push({ type, color });
        capturedValue[capturer] += MATERIAL_VALUES[type];
      }
    }
  }
  const balance = capturedValue.white - capturedValue.black;
  return {
    capturedBy,
    capturedValue,
    advantage: balance === 0
      ? { side: null, points: 0 }
      : { side: balance > 0 ? 'white' : 'black', points: Math.abs(balance) }
  };
}

// Convert one coordinate move to Standard Algebraic Notation. This is kept in
// the engine so the browser renderer and hermetic Node tests share the same
// legal-move and check logic.
function moveToSan(board, moveStr) {
  const from = moveStr.slice(0, 2);
  const to = moveStr.slice(2, 4);
  const promotion = moveStr[4];
  const piece = board.pieces[from];
  if (!piece) return moveStr;

  if (piece.type === 'k' && from[0] === 'e' && (to[0] === 'g' || to[0] === 'c')) {
    const castling = to[0] === 'g' ? 'O-O' : 'O-O-O';
    const next = makeMove(board, from, to, promotion);
    const nextStatus = getGameStatus(next, next.turn);
    return castling + (nextStatus === 'checkmate' ? '#' : nextStatus === 'check' ? '+' : '');
  }

  const destinationPiece = board.pieces[to];
  const capture = Boolean(destinationPiece) ||
    (piece.type === 'p' && board.enPassant === to && !destinationPiece);
  const letters = { k: 'K', q: 'Q', r: 'R', b: 'B', n: 'N' };
  let san = piece.type === 'p' ? '' : letters[piece.type];

  if (piece.type === 'p') {
    if (capture) san += from[0];
  } else {
    const ambiguous = [];
    for (const square of SQUARES) {
      const candidate = board.pieces[square];
      if (square !== from && candidate && candidate.color === piece.color && candidate.type === piece.type &&
          getLegalMoves(board, square, board.turn).includes(to)) {
        ambiguous.push(square);
      }
    }
    if (ambiguous.length) {
      const sameFile = ambiguous.some(square => square[0] === from[0]);
      const sameRank = ambiguous.some(square => square[1] === from[1]);
      san += sameFile ? from[1] : sameRank ? from[0] : from;
    }
  }

  san += capture ? 'x' : '';
  san += to;
  if (promotion) san += `=${promotion.toUpperCase()}`;

  const next = makeMove(board, from, to, promotion);
  const nextStatus = getGameStatus(next, next.turn);
  return san + (nextStatus === 'checkmate' ? '#' : nextStatus === 'check' ? '+' : '');
}

function historyToSan(history) {
  let board = createInitialBoard();
  return history.map(move => {
    const san = moveToSan(board, move);
    const from = move.slice(0, 2);
    const to = move.slice(2, 4);
    board = makeMove(board, from, to, move[4]);
    return san;
  });
}

function buildPgn(sanMoves, result = '*') {
  const headers = [
    '[Event "Casual Game"]',
    '[Site "Local"]',
    '[Round "-"]',
    '[White "White"]',
    '[Black "Black"]',
    `[Result "${result}"]`
  ];
  const movetext = [];
  for (let i = 0; i < sanMoves.length; i += 2) {
    movetext.push(`${Math.floor(i / 2) + 1}. ${sanMoves[i]}${sanMoves[i + 1] ? ` ${sanMoves[i + 1]}` : ''}`);
  }
  return `${headers.join('\n')}\n\n${movetext.join(' ')}${movetext.length ? ' ' : ''}${result}`;
}

function gameEndPresentation(state) {
  if (!state?.gameOver) return null;
  const status = state.status;
  if (status === 'checkmate') {
    const winner = state.result === '0-1' ? 'Black' : 'White';
    return { banner: `${winner} wins by checkmate`, reason: 'checkmate' };
  }
  if (status === 'stalemate') return { banner: 'Draw by stalemate', reason: 'stalemate' };
  if (status === 'resigned') {
    const winner = state.resigned === 'white' ? 'Black' : 'White';
    return { banner: `${winner} wins by resignation`, reason: 'resignation' };
  }
  if (status === 'timeout') {
    const winner = state.flagged === 'white' ? 'Black' : 'White';
    return { banner: `${winner} wins on time`, reason: 'timeout' };
  }
  if (status === 'draw') return { banner: 'Draw by agreement', reason: 'draw' };
  return { banner: state.result || 'Game over', reason: status || 'game over' };
}

function pieceCounts(board) {
  const counts = {};
  for (const square of SQUARES) {
    const piece = board?.pieces?.[square];
    if (piece) {
      const key = `${piece.color}:${piece.type}`;
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return counts;
}

function classifySound(prevRefState, nextRefState) {
  if (!prevRefState || !nextRefState) return null;
  if (nextRefState.gameOver && !prevRefState.gameOver) return 'gameEnd';

  const previousHistory = prevRefState.history || [];
  const nextHistory = nextRefState.history || [];
  if (nextHistory.length <= previousHistory.length) return null;

  const previousCounts = pieceCounts(prevRefState.board);
  const nextCounts = pieceCounts(nextRefState.board);
  const captured = Object.keys(previousCounts).some(key =>
    (nextCounts[key] || 0) < previousCounts[key]
  );
  if (captured) return 'capture';
  if (getKingStatus(nextRefState.board, nextRefState.board.turn).check) return 'check';
  return 'move';
}

function serializeRefereeState(refereeState) {
  try {
    return JSON.stringify(refereeState);
  } catch (e) {
    return null;
  }
}

function deserializeRefereeState(serialized) {
  try {
    const state = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
    if (!state || typeof state !== 'object' || !state.board || !state.board.pieces || !Array.isArray(state.history)) {
      return null;
    }
    return JSON.parse(JSON.stringify(state));
  } catch (e) {
    return null;
  }
}

// A8: display-only clock formatter for the UI's render-only interpolation.
// Pure function — takes seconds (possibly fractional) and returns a display
// string. Below TENTHS_THRESHOLD seconds it shows tenths (e.g. 0:09.4),
// otherwise it shows m:ss. Never mutates; never persists. The referee file
// remains the single source of clock truth (C1).
const TENTHS_THRESHOLD = 10;

function formatClockTick(seconds) {
  const clamped = Math.max(0, seconds);
  if (clamped < TENTHS_THRESHOLD) {
    const tenths = Math.floor(clamped * 10) % 10;
    const wholeSeconds = Math.floor(clamped);
    return `0:${wholeSeconds.toString().padStart(2, '0')}.${tenths}`;
  }
  const m = Math.floor(clamped / 60);
  const s = Math.floor(clamped) % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createInitialBoard, getLegalMoves, makeMove, isCheck, isCheckmate,
    isStalemate, getGameStatus, getKingStatus, moveToSan, historyToSan,
    buildPgn, computeCaptured, getBoardRenderOrder, getRankLabels, getFileLabels,
    gameEndPresentation, classifySound, serializeRefereeState, deserializeRefereeState,
    formatClockTick
  };
}
