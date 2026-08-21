const {
  createInitialBoard,
  getLegalMoves,
  makeMove,
  isCheck,
  isCheckmate,
  isStalemate,
  getGameStatus
} = require('./engine.js');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`PASS: ${message}`);
    passed++;
  } else {
    console.error(`FAIL: ${message}`);
    failed++;
  }
}

function assertArrayEquals(actual, expected, message) {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  const match = sortedActual.length === sortedExpected.length &&
    sortedActual.every((val, idx) => val === sortedExpected[idx]);

  if (match) {
    console.log(`PASS: ${message}`);
    passed++;
  } else {
    console.error(`FAIL: ${message} (Expected: [${sortedExpected.join(', ')}], Got: [${sortedActual.join(', ')}])`);
    failed++;
  }
}

function cloneBoardHelper(board) {
  const pieces = {};
  for (const sq in board.pieces) {
    const p = board.pieces[sq];
    pieces[sq] = p ? { type: p.type, color: p.color } : null;
  }
  return {
    pieces,
    castling: {
      white: { ...board.castling.white },
      black: { ...board.castling.black }
    },
    enPassant: board.enPassant,
    turn: board.turn,
    halfmoveClock: board.halfmoveClock,
    fullmoveNumber: board.fullmoveNumber
  };
}

console.log('--- Running Chess Engine Self-Tests ---\n');

// 1. Initial Board Verification
const initialBoard = createInitialBoard();
let whitePieces = 0;
let blackPieces = 0;
let emptySquares = 0;

for (const sq in initialBoard.pieces) {
  const p = initialBoard.pieces[sq];
  if (!p) {
    emptySquares++;
  } else if (p.color === 'white') {
    whitePieces++;
  } else if (p.color === 'black') {
    blackPieces++;
  }
}

assert(whitePieces === 16, `Initial board contains exactly 16 white pieces (found ${whitePieces})`);
assert(blackPieces === 16, `Initial board contains exactly 16 black pieces (found ${blackPieces})`);
assert(emptySquares === 32, `Initial board contains exactly 32 empty squares (found ${emptySquares})`);
assert(initialBoard.pieces['e1']?.type === 'k' && initialBoard.pieces['e1']?.color === 'white', 'White King starts on e1');
assert(initialBoard.pieces['e8']?.type === 'k' && initialBoard.pieces['e8']?.color === 'black', 'Black King starts on e8');
assert(initialBoard.pieces['d1']?.type === 'q' && initialBoard.pieces['d1']?.color === 'white', 'White Queen starts on d1');
assert(initialBoard.pieces['d8']?.type === 'q' && initialBoard.pieces['d8']?.color === 'black', 'Black Queen starts on d8');
assert(initialBoard.pieces['a1']?.type === 'r' && initialBoard.pieces['h1']?.type === 'r', 'White Rooks start on a1 and h1');
assert(initialBoard.pieces['a8']?.type === 'r' && initialBoard.pieces['h8']?.type === 'r', 'Black Rooks start on a8 and h8');

// 2. Opening Legal Moves Sanity
const e2Moves = getLegalMoves(initialBoard, 'e2', 'white');
assertArrayEquals(e2Moves, ['e3', 'e4'], 'e2 has legal moves [e3, e4] on opening turn');

const b1Moves = getLegalMoves(initialBoard, 'b1', 'white');
assertArrayEquals(b1Moves, ['a3', 'c3'], 'b1 knight has legal moves [a3, c3]');

const e1Moves = getLegalMoves(initialBoard, 'e1', 'white');
assertArrayEquals(e1Moves, [], 'e1 king has no legal moves at start (blocked by pieces)');

const blackE7MovesOnWhiteTurn = getLegalMoves(initialBoard, 'e7', 'white');
assertArrayEquals(blackE7MovesOnWhiteTurn, [], 'Black piece e7 returns empty moves on white turn');

assert(!e2Moves.includes('e5'), 'e2->e5 is illegal');
assert(!e2Moves.includes('d3'), 'e2->d3 is illegal');

// 3. Immutability of makeMove
const afterE4 = makeMove(initialBoard, 'e2', 'e4');
assert(initialBoard.pieces['e2']?.type === 'p', 'Original board e2 is still a pawn after makeMove (immutability)');
assert(initialBoard.pieces['e4'] === null, 'Original board e4 is still null after makeMove (immutability)');
assert(afterE4.pieces['e2'] === null, 'New board has e2 cleared');
assert(afterE4.pieces['e4']?.type === 'p' && afterE4.pieces['e4']?.color === 'white', 'New board has white pawn at e4');
assert(afterE4.enPassant === 'e3', 'En passant square is e3 after e2-e4');
assert(afterE4.turn === 'black', 'Turn switches to black after white move');

// 4. Initial Game Status
assert(isCheck(initialBoard, 'white') === false, 'White is not in check initially');
assert(isCheck(initialBoard, 'black') === false, 'Black is not in check initially');
assert(isCheckmate(initialBoard, 'white') === false, 'White is not in checkmate initially');
assert(isStalemate(initialBoard, 'white') === false, 'White is not in stalemate initially');
assert(getGameStatus(initialBoard, 'white') === 'ongoing', 'Initial game status is "ongoing"');

// 5. Scholar's Mate (1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#)
let b = createInitialBoard();
b = makeMove(b, 'e2', 'e4');
b = makeMove(b, 'e7', 'e5');
b = makeMove(b, 'f1', 'c4');
b = makeMove(b, 'b8', 'c6');
b = makeMove(b, 'd1', 'h5');
b = makeMove(b, 'g8', 'f6');
b = makeMove(b, 'h5', 'f7');

assert(isCheck(b, 'black') === true, "Scholar's Mate puts Black in check");
assert(isCheckmate(b, 'black') === true, "Scholar's Mate puts Black in checkmate");
assert(isStalemate(b, 'black') === false, "Scholar's Mate is not stalemate");
assert(getGameStatus(b, 'black') === 'checkmate', "Scholar's Mate game status is 'checkmate'");

// 6. Fool's Mate (1. f3 e5 2. g4 Qh4#)
let fools = createInitialBoard();
fools = makeMove(fools, 'f2', 'f3');
fools = makeMove(fools, 'e7', 'e5');
fools = makeMove(fools, 'g2', 'g4');
fools = makeMove(fools, 'd8', 'h4');

assert(isCheck(fools, 'white') === true, "Fool's Mate puts White in check");
assert(isCheckmate(fools, 'white') === true, "Fool's Mate puts White in checkmate");
assert(getGameStatus(fools, 'white') === 'checkmate', "Fool's Mate game status is 'checkmate'");

// 7. Stalemate Check
// Setup: Black king on a8, White king on a6, White queen on c7, Black turn
let stale = createInitialBoard();
for (const sq in stale.pieces) stale.pieces[sq] = null;
stale.pieces['a8'] = { type: 'k', color: 'black' };
stale.pieces['a6'] = { type: 'k', color: 'white' };
stale.pieces['c7'] = { type: 'q', color: 'white' };
stale.turn = 'black';

assert(isCheck(stale, 'black') === false, 'Black king is not in check in stalemate position');
assert(isStalemate(stale, 'black') === true, 'Black is in stalemate');
assert(isCheckmate(stale, 'black') === false, 'Black is not in checkmate in stalemate');
assert(getGameStatus(stale, 'black') === 'stalemate', 'Game status is "stalemate"');

// 8. Castling Tests
let castleBoard = createInitialBoard();
castleBoard.pieces['b1'] = null;
castleBoard.pieces['c1'] = null;
castleBoard.pieces['d1'] = null;
castleBoard.pieces['f1'] = null;
castleBoard.pieces['g1'] = null;

const kingCastleMoves = getLegalMoves(castleBoard, 'e1', 'white');
assert(kingCastleMoves.includes('g1'), 'White can castle kingside (e1->g1)');
assert(kingCastleMoves.includes('c1'), 'White can castle queenside (e1->c1)');

// Perform Kingside Castling
const kingsideCastled = makeMove(castleBoard, 'e1', 'g1');
assert(kingsideCastled.pieces['g1']?.type === 'k' && kingsideCastled.pieces['g1']?.color === 'white', 'King moved to g1');
assert(kingsideCastled.pieces['f1']?.type === 'r' && kingsideCastled.pieces['f1']?.color === 'white', 'Rook moved to f1');
assert(kingsideCastled.pieces['h1'] === null, 'h1 is empty after kingside castle');
assert(kingsideCastled.castling.white.kingSide === false, 'Kingside right lost after castling');
assert(kingsideCastled.castling.white.queenSide === false, 'Queenside right lost after king move');

// Perform Queenside Castling
const queensideCastled = makeMove(castleBoard, 'e1', 'c1');
assert(queensideCastled.pieces['c1']?.type === 'k' && queensideCastled.pieces['c1']?.color === 'white', 'King moved to c1');
assert(queensideCastled.pieces['d1']?.type === 'r' && queensideCastled.pieces['d1']?.color === 'white', 'Rook moved to d1');
assert(queensideCastled.pieces['a1'] === null, 'a1 is empty after queenside castle');

// Castling through check test: open f-file and place black rook at f8 attacking f1
let castleThroughCheck = cloneBoardHelper(castleBoard);
castleThroughCheck.pieces['f8'] = { type: 'r', color: 'black' };
castleThroughCheck.pieces['f7'] = null;
castleThroughCheck.pieces['f2'] = null; // clear pawns on f-file so f1 is attacked by rook
const throughCheckMoves = getLegalMoves(castleThroughCheck, 'e1', 'white');
assert(!throughCheckMoves.includes('g1'), 'Kingside castling blocked when f1 is attacked (cannot castle through check)');

// Castling while in check test: open e-file and place black rook on e8 attacking e1
let castleInCheck = cloneBoardHelper(castleBoard);
castleInCheck.pieces['e8'] = { type: 'r', color: 'black' };
castleInCheck.pieces['e7'] = null;
castleInCheck.pieces['e2'] = null; // clear pawns on e-file so e1 is attacked
const inCheckMoves = getLegalMoves(castleInCheck, 'e1', 'white');
assert(!inCheckMoves.includes('g1'), 'Kingside castling blocked when King is in check');
assert(!inCheckMoves.includes('c1'), 'Queenside castling blocked when King is in check');

// Castling rights lost after rook moves
let rookMovedBoard = makeMove(castleBoard, 'h1', 'h2');
assert(rookMovedBoard.castling.white.kingSide === false, 'Kingside castling right lost after h1 rook moves');
assert(rookMovedBoard.castling.white.queenSide === true, 'Queenside castling right preserved after h1 rook moves');

// Black Castling
let blackCastleBoard = createInitialBoard();
blackCastleBoard.pieces['b8'] = null;
blackCastleBoard.pieces['c8'] = null;
blackCastleBoard.pieces['d8'] = null;
blackCastleBoard.pieces['f8'] = null;
blackCastleBoard.pieces['g8'] = null;
blackCastleBoard.turn = 'black';

const blackKingCastleMoves = getLegalMoves(blackCastleBoard, 'e8', 'black');
assert(blackKingCastleMoves.includes('g8'), 'Black can castle kingside (e8->g8)');
assert(blackKingCastleMoves.includes('c8'), 'Black can castle queenside (e8->c8)');

const blackKingsideCastled = makeMove(blackCastleBoard, 'e8', 'g8');
assert(blackKingsideCastled.pieces['g8']?.type === 'k' && blackKingsideCastled.pieces['g8']?.color === 'black', 'Black King moved to g8');
assert(blackKingsideCastled.pieces['f8']?.type === 'r' && blackKingsideCastled.pieces['f8']?.color === 'black', 'Black Rook moved to f8');

// 9. En Passant Tests
let epBoard = createInitialBoard();
epBoard = makeMove(epBoard, 'e2', 'e4'); // white e4
epBoard = makeMove(epBoard, 'a7', 'a6'); // black dummy move
epBoard = makeMove(epBoard, 'e4', 'e5'); // white e5
epBoard = makeMove(epBoard, 'd7', 'd5'); // black d5 (double push)

assert(epBoard.enPassant === 'd6', 'En passant target square is d6 after d7->d5');
const e5PawnMoves = getLegalMoves(epBoard, 'e5', 'white');
assert(e5PawnMoves.includes('d6'), 'White e5 pawn can capture d6 en passant');

const afterEP = makeMove(epBoard, 'e5', 'd6');
assert(afterEP.pieces['d6']?.type === 'p' && afterEP.pieces['d6']?.color === 'white', 'White pawn now at d6');
assert(afterEP.pieces['d5'] === null, 'Captured black pawn at d5 is removed');
assert(afterEP.pieces['e5'] === null, 'Square e5 is now empty');

// En Passant expires if not taken immediately
let epExpiredBoard = makeMove(epBoard, 'h2', 'h3'); // white plays another move instead
assert(epExpiredBoard.enPassant === null, 'En passant flag clears after another move');

// 10. Pawn Promotion Tests
let promoBoard = createInitialBoard();
for (const sq in promoBoard.pieces) promoBoard.pieces[sq] = null;
promoBoard.pieces['e1'] = { type: 'k', color: 'white' };
promoBoard.pieces['e8'] = { type: 'k', color: 'black' };
promoBoard.pieces['a7'] = { type: 'p', color: 'white' };

// Default promotion (should be queen)
const promotedQueen = makeMove(promoBoard, 'a7', 'a8');
assert(promotedQueen.pieces['a8']?.type === 'q' && promotedQueen.pieces['a8']?.color === 'white', 'Pawn promotes to Queen by default');

// Knight promotion
const promotedKnight = makeMove(promoBoard, 'a7', 'a8', 'n');
assert(promotedKnight.pieces['a8']?.type === 'n' && promotedKnight.pieces['a8']?.color === 'white', 'Pawn promotes to Knight when requested');

// Rook promotion
const promotedRook = makeMove(promoBoard, 'a7', 'a8', 'r');
assert(promotedRook.pieces['a8']?.type === 'r' && promotedRook.pieces['a8']?.color === 'white', 'Pawn promotes to Rook when requested');

// Bishop promotion
const promotedBishop = makeMove(promoBoard, 'a7', 'a8', 'b');
assert(promotedBishop.pieces['a8']?.type === 'b' && promotedBishop.pieces['a8']?.color === 'white', 'Pawn promotes to Bishop when requested');

// Black pawn promotion
let blackPromoBoard = createInitialBoard();
for (const sq in blackPromoBoard.pieces) blackPromoBoard.pieces[sq] = null;
blackPromoBoard.pieces['e1'] = { type: 'k', color: 'white' };
blackPromoBoard.pieces['e8'] = { type: 'k', color: 'black' };
blackPromoBoard.pieces['b2'] = { type: 'p', color: 'black' };
blackPromoBoard.turn = 'black';

const blackPromotedQueen = makeMove(blackPromoBoard, 'b2', 'b1', 'q');
assert(blackPromotedQueen.pieces['b1']?.type === 'q' && blackPromotedQueen.pieces['b1']?.color === 'black', 'Black pawn promotes to Queen on rank 1');

// 11. Absolute Pin Test
// White King on e1, White Knight on e2, Black Rook on e8 (pawns cleared on e-file)
let pinBoard = createInitialBoard();
pinBoard.pieces['e2'] = { type: 'n', color: 'white' };
pinBoard.pieces['e7'] = null;
pinBoard.pieces['e8'] = { type: 'r', color: 'black' };

const pinnedKnightMoves = getLegalMoves(pinBoard, 'e2', 'white');
assertArrayEquals(pinnedKnightMoves, [], 'Knight pinned to King along e-file has 0 legal moves');

console.log('\n--- Self-Test Summary ---');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  console.error(`\nSelf-test FAILED with ${failed} failure(s).`);
  process.exit(1);
} else {
  console.log('\nAll self-tests PASSED successfully!');
}
