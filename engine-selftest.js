const {
  createInitialBoard,
  getLegalMoves,
  makeMove,
  isCheck,
  isCheckmate,
  isStalemate,
  getGameStatus,
  getKingStatus,
  computeCaptured,
  historyToSan,
  buildPgn,
  getBoardRenderOrder,
  getRankLabels,
  getFileLabels,
  gameEndPresentation,
  classifySound,
  serializeRefereeState,
  deserializeRefereeState,
  formatClockTick,
  getBoardThemes,
  isColorblindTheme,
  isValidBoardTheme,
  getDefaultBoardTheme
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

// A8: hermetic display-only clock formatter tests. formatClockTick is a pure
// function used by the UI render layer for interpolation; it never mutates or
// persists. Below 10s it shows tenths (e.g. 0:09.4); otherwise m:ss.
assert(formatClockTick(600) === '10:00',
  'A8: formatClockTick renders 600s as 10:00');
assert(formatClockTick(59.9) === '0:59',
  'A8: formatClockTick renders 59.9s (whole seconds) as 0:59 at the tenths threshold boundary');
assert(formatClockTick(9.4) === '0:09.4',
  'A8: formatClockTick renders 9.4s with tenths below the 10s threshold');
assert(formatClockTick(9.99) === '0:09.9',
  'A8: formatClockTick floors tenths (9.99 -> 0:09.9), never rounding up to 0:10.0');
assert(formatClockTick(0.5) === '0:00.5',
  'A8: formatClockTick renders half a second as 0:00.5');
assert(formatClockTick(0) === '0:00.0',
  'A8: formatClockTick renders zero as 0:00.0 with tenths');
assert(formatClockTick(-5) === '0:00.0',
  'A8: formatClockTick clamps negative seconds to 0:00.0');
assert(formatClockTick(10) === '0:10',
  'A8: formatClockTick renders exactly 10s without tenths (threshold is exclusive)');
assert(formatClockTick(9.999) === '0:09.9',
  'A8: formatClockTick just below 10s still floors tenths (9.999 -> 0:09.9)');

// E5. SAN and PGN conversion stays hermetic and replays only the supplied
// coordinate history; it does not depend on a server or browser state.
const knownSanMoves = historyToSan(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6']);
assert(JSON.stringify(knownSanMoves) === JSON.stringify(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']),
  'E5: known opening coordinate sequence converts to SAN');
const knownPgn = buildPgn(knownSanMoves);
assert(knownPgn.includes('[Event "Casual Game"]') &&
  knownPgn.includes('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *'),
  'E5: SAN moves assemble into minimal PGN with headers and result token');

const checkPosition = createInitialBoard();
let checkBoard = makeMove(checkPosition, 'f2', 'f3');
checkBoard = makeMove(checkBoard, 'e7', 'e5');
checkBoard = makeMove(checkBoard, 'g2', 'g4');
checkBoard = makeMove(checkBoard, 'd8', 'h4');
const checkState = getKingStatus(checkBoard, 'white');
assert(checkState.check === true && checkState.mate === true && checkState.kingSquare === 'e1',
  'E6: checked king status identifies the white king and checkmate');
const safeState = getKingStatus(createInitialBoard(), 'white');
assert(safeState.check === false && safeState.mate === false && safeState.kingSquare === 'e1',
  'E6: non-check position has no check or mate indicator');

// 1. Initial Board Verification
const initialBoard = createInitialBoard();
const freshMaterial = computeCaptured(initialBoard);
assert(freshMaterial.capturedBy.white.length === 0 && freshMaterial.capturedBy.black.length === 0 &&
  freshMaterial.advantage.points === 0,
  'E7: fresh starting board has empty captured trays and zero advantage');
let captureBoard = makeMove(initialBoard, 'e2', 'e4');
captureBoard = makeMove(captureBoard, 'd7', 'd5');
captureBoard = makeMove(captureBoard, 'e4', 'd5');
const captureMaterial = computeCaptured(captureBoard);
assert(captureMaterial.capturedBy.white.length === 1 &&
  captureMaterial.capturedBy.white[0].type === 'p' && captureMaterial.capturedValue.white === 1 &&
  captureMaterial.capturedBy.black.length === 0 && captureMaterial.advantage.side === 'white' &&
  captureMaterial.advantage.points === 1,
  'E7: after exd5, white tray contains one captured pawn and white leads by +1');
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

// 12. C1 Clock Reconciliation — referee file is single source of truth
const { execFileSync, execSync } = require('child_process');
const stateFile = require('path').join(__dirname, '.referee-state.json');
const CLOCK_START = 600, CLOCK_INC = 15;
const fs = require('fs');
// A1: make the hermetic SVG contract a prerequisite without changing the
// established 123 engine/referee assertion count reported by this gate.
execFileSync(process.execPath, [require('path').join(__dirname, 'pieces-selftest.js')], {
  cwd: __dirname,
  stdio: 'pipe'
});
const originalStateFile = fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null;
process.env.CHESS_STATE_FILE = stateFile;
// D1: short heartbeat/interval so SSE tests resolve quickly (hermetic).
process.env.CHESS_SSE_HEARTBEAT_MS = '200';
process.env.CHESS_SSE_WATCH_INTERVAL_MS = '50';
process.once('exit', () => {
  if (originalStateFile === null) {
    try { fs.unlinkSync(stateFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } else {
    fs.writeFileSync(stateFile, originalStateFile);
  }
});

function refereeCli(...args) {
  const out = execSync(`node referee-helper.cjs ${args.join(' ')}`, { cwd: __dirname }).toString();
  return JSON.parse(out);
}

function refereeCliWithEnv(env, ...args) {
  try {
    return JSON.parse(execSync(`node referee-helper.cjs ${args.join(' ')}`, {
      cwd: __dirname, env: { ...process.env, ...env }
    }).toString());
  } catch (error) {
    return JSON.parse(error.stdout.toString());
  }
}

refereeCli('reset');
let st = JSON.parse(require('fs').readFileSync(stateFile, 'utf8'));
assert(st.clocks && st.clocks.white === CLOCK_START && st.clocks.black === CLOCK_START,
  `C1: fresh referee game starts both clocks at ${CLOCK_START}s (got ${JSON.stringify(st.clocks)})`);

const before = JSON.parse(JSON.stringify(st.clocks));
const mv = refereeCli('move', 'e2e4');
assert(mv.ok === true, 'C1: referee accepts a legal move');
st = JSON.parse(require('fs').readFileSync(stateFile, 'utf8'));
assert(st.clocks.white === Math.min(CLOCK_START, before.white + CLOCK_INC),
  `C1: mover (white) receives +${CLOCK_INC}s increment, capped at ${CLOCK_START} (got ${st.clocks.white})`);
assert(st.clocks.black === CLOCK_START, `C1: non-mover (black) clock unchanged at ${CLOCK_START} (got ${st.clocks.black})`);
assert(mv.clocks && mv.clocks.white === st.clocks.white, 'C1: move output echoes referee clocks');

const statusOut = refereeCli('status');
assert(statusOut.clocks && statusOut.clocks.black === st.clocks.black, 'C1: status output carries referee clocks');

// Legacy backfill: state without clocks gets defaults
require('fs').writeFileSync(stateFile, JSON.stringify({ board: st.board, history: st.history }));
const backfillStatus = refereeCli('status');
assert(backfillStatus.clocks && backfillStatus.clocks.white === CLOCK_START,
  'C1: legacy state file without clocks is backfilled to start values');

refereeCli('reset');
st = JSON.parse(require('fs').readFileSync(stateFile, 'utf8'));
assert(st.clocks.white === CLOCK_START && st.clocks.black === CLOCK_START,
  'C1: reset restores both clocks to start');

// 13. C2 Promotion — referee plumbs promo choice through to the board
function seedPromotionBoard(color) {
  // Minimal board: two kings + one pawn one step from promotion.
  const pieces = {};
  for (const f of 'abcdefgh') for (const r of '12345678') pieces[f + r] = null;
  pieces['e1'] = { type: 'k', color: 'white' };
  pieces['e8'] = { type: 'k', color: 'black' };
  if (color === 'black') pieces['h2'] = { type: 'p', color: 'black' };
  else pieces['h7'] = { type: 'p', color: 'white' };
  return {
    pieces,
    castling: {
      white: { kingSide: false, queenSide: false },
      black: { kingSide: false, queenSide: false }
    },
    enPassant: null,
    turn: color,
    halfmoveClock: 0,
    fullmoveNumber: 1
  };
}

function seedReferee(board) {
  require('fs').writeFileSync(stateFile, JSON.stringify({
    board, history: [], clocks: { white: CLOCK_START, black: CLOCK_START }
  }));
}

// Engine-level: explicit underpromotion to rook (regression for the C2 bug
// where every UI promotion silently became a queen).
let promoEng = seedPromotionBoard('black');
promoEng = makeMove(promoEng, 'h2', 'h1', 'r');
assert(promoEng.pieces['h1']?.type === 'r' && promoEng.pieces['h1']?.color === 'black',
  'C2: engine underpromotion h2h1r yields a black ROOK on h1 (not queen)');
promoEng = seedPromotionBoard('black');
promoEng = makeMove(promoEng, 'h2', 'h1', 'n');
assert(promoEng.pieces['h1']?.type === 'n', 'C2: engine underpromotion h2h1n yields a knight');

// Referee-level: the move command accepts and applies every promo choice.
for (const [piece, name] of [['q', 'queen'], ['r', 'rook'], ['b', 'bishop'], ['n', 'knight']]) {
  seedReferee(seedPromotionBoard('black'));
  const res = refereeCli('move', 'h2h1' + piece);
  const landed = JSON.parse(require('fs').readFileSync(stateFile, 'utf8'));
  assert(res.ok === true && landed.board.pieces['h1']?.type === piece,
    `C2: referee applies promotion choice h2h1${piece} — ${name} on h1`);
  assert(landed.history[landed.history.length - 1] === 'h2h1' + piece,
    `C2: referee history records the promo suffix h2h1${piece}`);
}

// Referee-level: white promotion also validated (symmetry check).
seedReferee(seedPromotionBoard('white'));
const whitePromo = refereeCli('move', 'h7h8n');
const whiteLanded = JSON.parse(require('fs').readFileSync(stateFile, 'utf8'));
assert(whitePromo.ok === true && whiteLanded.board.pieces['h8']?.type === 'n',
  'C2: referee applies white underpromotion h7h8n — knight on h8');

// Backward compat: bare coordinate with no suffix still defaults to queen.
seedReferee(seedPromotionBoard('black'));
const bare = refereeCli('move', 'h2h1');
const bareLanded = JSON.parse(require('fs').readFileSync(stateFile, 'utf8'));
assert(bare.ok === true && bareLanded.board.pieces['h1']?.type === 'q',
  'C2: bare coordinate h2h1 (no promo arg) still defaults to queen');

// Referee rejects an illegal promo (piece not on a promotion square).
refereeCli('reset');
const badPromo = execSync(`node referee-helper.cjs move e2e4q 2>/dev/null || true`, { cwd: __dirname }).toString();
assert(JSON.parse(badPromo).ok === false, 'C2: referee rejects promo suffix on non-promotion move e2e4q');
const afterBad = refereeCli('status');
assert(afterBad.plyCount === 0, 'C2: rejected promo move does not touch referee history');

refereeCli('reset');

// 14. C3 Referee-authoritative UI transport — exercise the same HTTP endpoint
// used by ui.js, then read a fresh state snapshot as pollReferee() does.
const uiSource = require('fs').readFileSync(require('path').join(__dirname, 'ui.js'), 'utf8');
assert(!/makeMove\s*\(/.test(uiSource) && !/createInitialBoard\s*\(/.test(uiSource) &&
  /fetch\(['"]\/api\/move['"]/.test(uiSource),
  'C3: UI has no local board authority and submits moves through the referee endpoint');

// D2. Execute the actual ui.js reconcile functions against an in-memory DOM.
// Reading the source keeps this hermetic: no browser or live server is used.
function createReconcileHarness(initial) {
  const vm = require('vm');
  const writes = [];
  const elements = new Map();

  class MockElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.parentElement = null;
      this.dataset = {};
      this._id = '';
      this._className = '';
      this._textContent = '';
      this.removed = false;
    }
    set id(value) { this._id = value; elements.set(value, this); }
    get id() { return this._id; }
    set className(value) {
      this._className = value;
      if (this.parentElement) writes.push({ op: 'className', square: this.id, node: this });
    }
    get className() { return this._className; }
    set textContent(value) {
      this._textContent = value;
      if (this.parentElement) writes.push({ op: 'textContent', square: this.parentElement.id, node: this });
    }
    get textContent() { return this._textContent; }
    get firstElementChild() { return this.children[0] || null; }
    appendChild(child) {
      if (child.parentElement) {
        const oldParent = child.parentElement;
        oldParent.children.splice(oldParent.children.indexOf(child), 1);
        writes.push({ op: 'detach', square: oldParent.id, node: child });
      }
      this.children.push(child);
      child.parentElement = this;
      writes.push({ op: 'append', square: this.id, node: child });
      return child;
    }
    remove() {
      if (!this.parentElement) return;
      const oldParent = this.parentElement;
      oldParent.children.splice(oldParent.children.indexOf(this), 1);
      this.parentElement = null;
      this.removed = true;
      writes.push({ op: 'remove', square: oldParent.id, node: this });
    }
  }

  const boardElement = new MockElement('div');
  boardElement.id = 'board';
  const document = {
    createElement: tagName => new MockElement(tagName),
    getElementById: id => elements.get(id) || null
  };
  const start = uiSource.indexOf('function cloneBoardSnapshot');
  const end = uiSource.indexOf('// C2: promotion modal flow');
  if (start < 0 || end < 0) throw new Error('D2 reconcile source block not found');
  const reconcileSource = uiSource.slice(start, end);
  const context = {
    document,
    boardElement,
    board: initial,
    turn: initial.turn,
    boardFlipped: false,
    previousBoard: null,
    renderedBoardFlipped: null,
    selectedSquare: null,
    legalMoves: [],
    kingStatus: { kingSquare: null, check: false, mate: false },
    renderPieceSvg(el, color, type) {
      let child = el.firstElementChild;
      if (!child) {
        child = document.createElement('span');
        child.className = 'chess-piece';
        child.dataset.svg = color + type;
        el.appendChild(child);
      } else if (child.dataset.svg !== color + type) {
        child.dataset.svg = color + type;
      }
      return child;
    },
    getKingStatus,
    getBoardRenderOrder,
    renderCoordinates() {},
    handleSquareClick() {}
  };
  vm.createContext(context);
  vm.runInContext(reconcileSource, context);
  context.renderBoard(null, null);
  context.previousBoard = context.cloneBoardSnapshot(initial);
  writes.length = 0;
  return { context, writes, elements };
}

const identicalHarness = createReconcileHarness(createInitialBoard());
identicalHarness.context.board = cloneBoardHelper(createInitialBoard());
identicalHarness.context.renderBoard(null, identicalHarness.context.previousBoard);
assert(identicalHarness.writes.length === 0,
  'D2: consecutive identical referee boards produce no board DOM writes');

const moveStart = createInitialBoard();
const moveHarness = createReconcileHarness(moveStart);
const movingPawn = moveHarness.elements.get('e2').firstElementChild;
moveHarness.context.board = makeMove(moveStart, 'e2', 'e4');
moveHarness.context.turn = 'black';
moveHarness.context.renderBoard({ from: 'e2', to: 'e4' }, moveHarness.context.previousBoard);
const moveTouched = [...new Set(moveHarness.writes.map(write => write.square))].sort();
assert(JSON.stringify(moveTouched) === JSON.stringify(['e2', 'e4']) &&
  moveHarness.elements.get('e4').firstElementChild === movingPawn,
  'D2: a single-move diff touches only from/to squares and preserves piece identity');

let beforeCapture = makeMove(createInitialBoard(), 'e2', 'e4');
beforeCapture = makeMove(beforeCapture, 'd7', 'd5');
const captureHarness = createReconcileHarness(beforeCapture);
const capturingPawn = captureHarness.elements.get('e4').firstElementChild;
const capturedPawn = captureHarness.elements.get('d5').firstElementChild;
captureHarness.context.board = makeMove(beforeCapture, 'e4', 'd5');
captureHarness.context.turn = 'black';
captureHarness.context.renderBoard({ from: 'e4', to: 'd5' }, captureHarness.context.previousBoard);
const removedPieces = captureHarness.writes.filter(write => write.op === 'remove').map(write => write.node);
assert(removedPieces.length === 1 && removedPieces[0] === capturedPawn && capturedPawn.removed === true &&
  captureHarness.elements.get('d5').firstElementChild === capturingPawn,
  'D2: capture removes only the captured destination piece');

function httpMoveOverServer(server, move) {
  const payload = JSON.stringify({ move });
  return new Promise((resolve, reject) => {
    const req = require('http').request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'POST',
      path: '/api/move',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
    });
}

async function runC3Transport() {
  const { createServer } = require('./server.js');
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    refereeCli('reset');
    const endpointMove = await httpMoveOverServer(server, 'e2e4');
    const endpointState = JSON.parse(require('fs').readFileSync(stateFile, 'utf8'));
    assert(endpointMove.ok === true && endpointMove.applied === 'e2e4',
    'C3: HTTP move endpoint accepts a legal move through the referee');
    assert(endpointState.history[0] === 'e2e4' && endpointState.board.pieces.e2 === null &&
      endpointState.board.pieces.e4?.type === 'p' && endpointState.board.pieces.e4?.color === 'white',
    'C3: fresh referee state snapshot contains the endpoint move for UI rendering');
    assert(endpointState.board.turn === 'black',
    'C3: fresh referee state snapshot supplies the next turn to the UI');
    refereeCli('reset');
    } finally {
    await new Promise(r => server.close(r));
    }
}

// D1: hermetic SSE transport tests. Creates a server with listen(0), connects
// via raw http.request to /api/events, parses SSE frames, POSTs /api/move, and
// asserts a state event arrives with the new referee snapshot. Also asserts a
// heartbeat comment arrives within a short window (env-tuned heartbeat interval).
async function runD1SSETransport() {
  const http = require('http');
  const { createServer, stopStateWatcher } = require('./server.js');
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    refereeCli('reset');

    // Connect to SSE endpoint with raw http.request (no EventSource in Node).
    let sseBuf = '';
    const sseRes = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'GET', path: '/api/events'
      }, (res) => {
        res.on('data', (chunk) => { sseBuf += chunk.toString(); });
        resolve(res);
      });
      req.on('error', reject);
      req.end();
    });

    // Wait for the initial state event (server pushes current state on connect).
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('initial SSE event timeout')), 5000);
      const check = () => {
        if (sseBuf.includes('event: state')) { clearTimeout(timeout); resolve(); return; }
        setTimeout(check, 30);
      };
      check();
    });
    assert(true, 'D1: SSE endpoint sends initial state event on connection');

    // POST a move and wait for the SSE event reflecting the new referee state.
    sseBuf = '';
    const moveResult = await httpMoveOverServer(server, 'e2e4');
    assert(moveResult.ok === true && moveResult.applied === 'e2e4',
      'D1: SSE test move e2e4 accepted by referee');

    let sseStateEvent = null;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('SSE move event timeout')), 5000);
      const check = () => {
        const frames = sseBuf.split('\n\n');
        for (const frame of frames) {
          if (frame.startsWith('event: state')) {
            const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
            if (dataLine) {
              try {
                const data = JSON.parse(dataLine.slice(6));
                if (data.history && data.history.includes('e2e4')) {
                  sseStateEvent = data;
                  clearTimeout(timeout);
                  resolve();
                  return;
                }
              } catch (e) { /* partial frame, keep waiting */ }
            }
          }
        }
        setTimeout(check, 30);
      };
      check();
    });
    assert(sseStateEvent !== null && sseStateEvent.history[0] === 'e2e4',
      'D1: SSE pushes referee state event after move (history contains e2e4)');
    assert(sseStateEvent.board && sseStateEvent.board.pieces.e2 === null &&
      sseStateEvent.board.pieces.e4?.type === 'p' && sseStateEvent.board.pieces.e4?.color === 'white',
      'D1: SSE state event carries the updated board (pawn on e4, e2 empty)');
    assert(sseStateEvent.board.turn === 'black',
      'D1: SSE state event carries the next turn from the referee');

    // Heartbeat: with short CHESS_SSE_HEARTBEAT_MS, a heartbeat comment arrives.
    sseBuf = '';
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('heartbeat timeout')), 3000);
      const check = () => {
        if (sseBuf.includes(': heartbeat')) { clearTimeout(timeout); resolve(); return; }
        setTimeout(check, 30);
      };
      check();
    });
    assert(true, 'D1: SSE heartbeat comment arrives within timeout window');

    sseRes.destroy();
    refereeCli('reset');
  } finally {
    await new Promise(r => server.close(r));
    stopStateWatcher();
  }
}

runC3Transport().then(() => runD1SSETransport()).then(() => {
  // 15. C4 Referee timing and flagging — hermetic CLI tests with no network.
  refereeCli('reset');
  const timedStart = JSON.parse(require('fs').readFileSync(stateFile, 'utf8'));
  timedStart.clocks.white = 30;
  require('fs').writeFileSync(stateFile, JSON.stringify(timedStart));
  const timedMove = refereeCliWithEnv({ CHESS_MOVE_TIME_COST: '20' }, 'move', 'e2e4');
  const timedState = JSON.parse(require('fs').readFileSync(stateFile, 'utf8'));
  assert(timedMove.ok === true && timedState.clocks.white === 25 && timedState.clocks.white < 30,
    'C4: referee deducts active-side move time before applying a move');

  refereeCli('reset');
  const flagStart = JSON.parse(require('fs').readFileSync(stateFile, 'utf8'));
  flagStart.clocks.white = 1;
  require('fs').writeFileSync(stateFile, JSON.stringify(flagStart));
  const flaggedMove = refereeCliWithEnv({ CHESS_MOVE_TIME_COST: '1' }, 'move', 'e2e4');
  const flaggedState = JSON.parse(require('fs').readFileSync(stateFile, 'utf8'));
  assert(flaggedMove.ok === false && flaggedMove.error === 'flagged' &&
    flaggedState.gameOver === true && flaggedState.status === 'timeout' &&
    flaggedState.flagged === 'white' && flaggedState.result === '0-1 on time' &&
    flaggedState.clocks.white === 0,
    'C4: clock reaching zero flags white and records a 0-1 on time result');
  const postFlagMove = refereeCliWithEnv({ CHESS_MOVE_TIME_COST: '1' }, 'move', 'e2e4');
  const postFlagState = JSON.parse(require('fs').readFileSync(stateFile, 'utf8'));
  assert(postFlagMove.ok === false && postFlagMove.error === 'game over' &&
    postFlagState.history.length === 0 && postFlagState.board.pieces.e2?.type === 'p',
    'C4: referee rejects moves after flag and leaves the board unchanged');
  refereeCli('reset');

  // 17. E12 snapshot persistence and referee-owned undo.
  const persistenceSource = { board: createInitialBoard(), history: [], clocks: { white: 600, black: 600 } };
  const persisted = deserializeRefereeState(serializeRefereeState(persistenceSource));
  assert(persisted && persisted.board.pieces.e1?.type === 'k' && persisted.history.length === 0,
    'E12: referee snapshot serializes and deserializes losslessly');
  assert(deserializeRefereeState('{corrupt json') === null && deserializeRefereeState(null) === null,
    'E12: corrupt or empty persisted snapshot is rejected without throwing');
  refereeCli('move', 'e2e4');
  refereeCli('move', 'e7e5');
  const undoResult = refereeCli('undo');
  const undoState = JSON.parse(require('fs').readFileSync(stateFile, 'utf8'));
  assert(undoResult.ok === true && undoResult.undone === true && undoState.history.length === 1 &&
    undoState.history[0] === 'e2e4' && undoState.board.pieces.e4?.type === 'p' &&
    undoState.board.turn === 'black', 'E12: referee undo pops the last move and restores the prior board');
  refereeCli('reset');
  const emptyUndo = refereeCli('undo');
  assert(emptyUndo.ok === true && emptyUndo.noOp === true && emptyUndo.plyCount === 0,
    'E12: undo on empty history is a no-op');

  // 16. E8 referee-owned resignation/draw and UI-only board orientation.
  const e8UiSource = require('fs').readFileSync(require('path').join(__dirname, 'ui.js'), 'utf8');
  assert(e8UiSource.includes('boardFlipped') && e8UiSource.includes('flip-board') &&
    e8UiSource.includes('/api/resign') && e8UiSource.includes('/api/draw'),
    'E8: UI exposes flip, resign, and draw actions without local game-state mutation');
  const stateBeforeOrientation = JSON.parse(require('fs').readFileSync(stateFile, 'utf8'));
  const normalOrder = getBoardRenderOrder(false);
  const flippedOrder = getBoardRenderOrder(true);
  const stateAfterOrientation = JSON.parse(require('fs').readFileSync(stateFile, 'utf8'));
  assert(normalOrder.length === 64 && normalOrder[0] === 'a8' && normalOrder[63] === 'h1' &&
    flippedOrder[0] === 'h1' && flippedOrder[63] === 'a8' &&
    JSON.stringify(stateBeforeOrientation) === JSON.stringify(stateAfterOrientation),
    'E8: flipped render order reverses rows/files without mutating referee state');
  assert(JSON.stringify(getRankLabels(false)) === JSON.stringify(['8', '7', '6', '5', '4', '3', '2', '1']) &&
    JSON.stringify(getRankLabels(true)) === JSON.stringify(['1', '2', '3', '4', '5', '6', '7', '8']) &&
    JSON.stringify(getFileLabels(false)) === JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) &&
    JSON.stringify(getFileLabels(true)) === JSON.stringify(['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']),
    'E9: rank/file labels follow normal and flipped orientation');
  const endCases = [
    [{ gameOver: true, status: 'checkmate', result: '1-0' }, 'White wins by checkmate', 'checkmate'],
    [{ gameOver: true, status: 'stalemate', result: '½-½' }, 'Draw by stalemate', 'stalemate'],
    [{ gameOver: true, status: 'resigned', resigned: 'white', result: '0-1' }, 'Black wins by resignation', 'resignation'],
    [{ gameOver: true, status: 'timeout', flagged: 'white', result: '0-1 on time' }, 'Black wins on time', 'timeout'],
    [{ gameOver: true, status: 'draw', result: '½-½' }, 'Draw by agreement', 'draw']
  ];
  assert(endCases.every(([state, banner, reason]) => {
    const presentation = gameEndPresentation(state);
    return presentation.banner === banner && presentation.reason === reason;
  }), 'E10: referee game-over states map to the correct overlay banner and reason');
  const soundInitial = { board: createInitialBoard(), history: [], gameOver: false };
  const soundMoveBoard = makeMove(soundInitial.board, 'e2', 'e4');
  const soundMove = { board: soundMoveBoard, history: ['e2e4'], gameOver: false };
  assert(classifySound(soundInitial, soundMove) === 'move', 'E11: ordinary referee move classifies as move sound');
  const soundCaptureBoard = makeMove(soundMoveBoard, 'd7', 'd5');
  const soundCaptureNextBoard = makeMove(soundCaptureBoard, 'e4', 'd5');
  const soundCapture = { board: soundCaptureNextBoard, history: ['e2e4', 'd7d5', 'e4d5'], gameOver: false };
  assert(classifySound(soundCaptureBoard && { board: soundCaptureBoard, history: ['e2e4', 'd7d5'], gameOver: false }, soundCapture) === 'capture',
    'E11: removed piece classifies as capture sound');
  const soundCheckBoard = makeMove(createInitialBoard(), 'f2', 'f3');
  const soundCheckBoard2 = makeMove(soundCheckBoard, 'e7', 'e5');
  const soundCheckBoard3 = makeMove(soundCheckBoard2, 'g2', 'g4');
  const soundCheckBoard4 = makeMove(soundCheckBoard3, 'd8', 'h4');
  assert(classifySound(
    { board: soundCheckBoard3, history: ['f2f3', 'e7e5', 'g2g4'], gameOver: false },
    { board: soundCheckBoard4, history: ['f2f3', 'e7e5', 'g2g4', 'd8h4'], gameOver: false }
  ) === 'check', 'E11: new check classifies as check sound');
  assert(classifySound(soundInitial, { ...soundInitial, gameOver: true, status: 'draw', result: '½-½' }) === 'gameEnd',
    'E11: new referee game-over classifies as gameEnd sound');
  assert(classifySound(soundInitial, soundInitial) === null,
    'E11: unchanged referee poll produces no sound');

  const resigned = refereeCliWithEnv({}, 'resign', 'white');
  const resignedState = JSON.parse(require('fs').readFileSync(stateFile, 'utf8'));
  assert(resigned.ok === true && resignedState.gameOver === true && resignedState.resigned === 'white' &&
    resignedState.result === '0-1', 'E8: referee records white resignation and black win');
  const moveAfterResign = refereeCliWithEnv({}, 'move', 'e2e4');
  assert(moveAfterResign.ok === false && moveAfterResign.error === 'game over',
    'E8: post-resignation moves are rejected');

  refereeCli('reset');
  const drawn = refereeCliWithEnv({}, 'draw');
  const drawnState = JSON.parse(require('fs').readFileSync(stateFile, 'utf8'));
  assert(drawn.ok === true && drawnState.gameOver === true && drawnState.draw === true &&
    drawnState.result === '½-½', 'E8: referee records accepted draw as ½-½');
  const moveAfterDraw = refereeCliWithEnv({}, 'move', 'e2e4');
  assert(moveAfterDraw.ok === false && moveAfterDraw.error === 'game over',
    'E8: post-draw moves are rejected');
  refereeCli('reset');

  // A6: Theme helper tests (pure functions, hermetic — no DOM required)
  const themeList = getBoardThemes();
  assert(Array.isArray(themeList) && themeList.length >= 4,
    'A6: getBoardThemes returns an array with at least 4 board themes');
  assert(themeList.indexOf('classic') !== -1,
    'A6: getBoardThemes includes classic');
  assert(themeList.indexOf('slate') !== -1,
    'A6: getBoardThemes includes slate');
  assert(themeList.indexOf('walnut') !== -1,
    'A6: getBoardThemes includes walnut');
  assert(getDefaultBoardTheme() === 'classic',
    'A6: getDefaultBoardTheme returns classic');
  assert(isValidBoardTheme('classic') === true,
    'A6: isValidBoardTheme accepts classic');
  assert(isValidBoardTheme('slate') === true,
    'A6: isValidBoardTheme accepts slate');
  assert(isValidBoardTheme('walnut') === true,
    'A6: isValidBoardTheme accepts walnut');
  assert(isValidBoardTheme('colorblind') === true,
    'A6: isValidBoardTheme accepts colorblind');
  assert(isValidBoardTheme('colorblind-dark') === true,
    'A6: isValidBoardTheme accepts colorblind-dark');
  assert(isValidBoardTheme('nonexistent') === false,
    'A6: isValidBoardTheme rejects unknown theme');
  assert(isValidBoardTheme('') === false,
    'A6: isValidBoardTheme rejects empty string');
  assert(isColorblindTheme('colorblind') === true,
    'A6: isColorblindTheme identifies colorblind');
  assert(isColorblindTheme('colorblind-dark') === true,
    'A6: isColorblindTheme identifies colorblind-dark');
  assert(isColorblindTheme('classic') === false,
    'A6: isColorblindTheme rejects non-colorblind theme');
  assert(isColorblindTheme('slate') === false,
    'A6: isColorblindTheme rejects slate');
  // Ensure theme list is a fresh copy (immutability)
  const themeListCopy = getBoardThemes();
  themeListCopy.push('injected');
  assert(getBoardThemes().indexOf('injected') === -1,
    'A6: getBoardThemes returns a fresh copy each call');

  console.log('\n--- Self-Test Summary ---');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    console.error(`\nSelf-test FAILED with ${failed} failure(s).`);
    process.exit(1);
   } else {
    console.log('\nAll self-tests PASSED successfully!');
   }
  }).catch((err) => {
    console.error('C3 transport test error:', err);
    process.exit(1);
  });
