/**
 * chess960-selftest.js — standalone selftest for chess960.js.
 * Exits non-zero on any assertion failure.
 */
'use strict';

const Chess960 = require('../src/chess960.js');
const { Chess } = require('chess.js');

let passed = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL: ' + msg);
    process.exit(1);
  }
}

function test(name, fn) {
  fn();
  passed++;
  console.log('PASS: ' + name);
}

// --- Section 1: SP number generation invariants ---

test('SP 0 produces a valid position (RNBQKBNR standard-like)', () => {
  const p = Chess960.generatePosition(0);
  assert(p, 'position exists');
  // Standard chess is SP 518, not 0. But SP 0 must still be a legal 960 position:
  // verify king between rooks and bishops on opposite colors.
  const files = Chess960.FILES;
  let kingIdx = -1, rookIdxs = [];
  for (let f = 0; f < 8; f++) {
    const pc = p.pieces[files[f] + '1'];
    if (pc && pc.type === 'k') kingIdx = f;
    if (pc && pc.type === 'r') rookIdxs.push(f);
  }
  assert(kingIdx !== -1, 'king present');
  assert(rookIdxs.length === 2, 'two rooks');
  assert(rookIdxs[0] < kingIdx && kingIdx < rookIdxs[1], 'king between rooks');
  // Bishops on opposite colors.
  let bishopFiles = [];
  for (let f = 0; f < 8; f++) {
    const pc = p.pieces[files[f] + '1'];
    if (pc && pc.type === 'b') bishopFiles.push(f);
  }
  assert(bishopFiles.length === 2, 'two bishops');
  assert((bishopFiles[0] % 2) !== (bishopFiles[1] % 2), 'bishops on opposite colors');
});

test('generatePosition produces exactly the standard start at SP 518', () => {
  const p = Chess960.generatePosition(518);
  assert(p.fen === 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'SP 518 == standard FEN, got ' + p.fen);
  assert(p.kingFile.white === 'e' && p.kingFile.black === 'e', 'king on e-file');
  assert(p.rookFiles.white.k === 'h' && p.rookFiles.white.q === 'a', 'white rooks h/a');
});

test('all 960 positions have king between rooks and opposite-color bishops', () => {
  for (let sp = 0; sp < 960; sp++) {
    const p = Chess960.generatePosition(sp);
    const files = Chess960.FILES;
    let kingIdx = -1, rookIdxs = [], bishopFiles = [];
    for (let f = 0; f < 8; f++) {
      const pc = p.pieces[files[f] + '1'];
      if (pc && pc.type === 'k') kingIdx = f;
      if (pc && pc.type === 'r') rookIdxs.push(f);
      if (pc && pc.type === 'b') bishopFiles.push(f);
    }
    assert(kingIdx !== -1 && rookIdxs.length === 2, 'SP ' + sp + ' has king+2 rooks');
    assert(rookIdxs[0] < kingIdx && kingIdx < rookIdxs[1], 'SP ' + sp + ' king between rooks');
    assert(bishopFiles.length === 2, 'SP ' + sp + ' two bishops');
    assert((bishopFiles[0] % 2) !== (bishopFiles[1] % 2), 'SP ' + sp + ' bishops opposite colors');
  }
});

test('the 960 generated FENs are unique', () => {
  const seen = new Set();
  for (let sp = 0; sp < 960; sp++) {
    const fen = Chess960.generatePosition(sp).fen;
    assert(!seen.has(fen), 'duplicate FEN at SP ' + sp);
    seen.add(fen);
  }
  assert(seen.size === 960, '960 unique FENs');
});

// --- Section 2: FEN cross-validation with chess.js ---

test('chess.js accepts every generated 960 FEN', () => {
  for (let sp = 0; sp < 960; sp++) {
    const fen = Chess960.generatePosition(sp).fen;
    let c;
    try {
      c = new Chess(fen);
    } catch (e) {
      assert(false, 'chess.js rejected SP ' + sp + ' (' + fen + '): ' + e.message);
      return;
    }
    assert(c.fen().split(' ')[0] === fen.split(' ')[0], 'SP ' + sp + ' placement round-trips');
  }
});

// --- Section 3: castling rules ---

test('standard kingside castling works (SP 518)', () => {
  const gen = Chess960.generatePosition(518);
  // Clear f1/g1 empty already; move N f1/g1 out of the way is already empty in
  // the start position for standard chess? Standard: f1 bishop, g1 knight are
  // occupied, so kingside castling is NOT immediately legal. Use a board where
  // the path is clear: move pieces manually.
  const board = gen.board;
  // Remove white's f1 bishop and g1 knight to make O-O legal.
  board.pieces['f1'] = null;
  board.pieces['g1'] = null;
  const result = Chess960.castle(board, 'white', 'k', 'e', 'h');
  assert(result, 'castling should be legal');
  assert(result.pieces['g1'] && result.pieces['g1'].type === 'k', 'king on g1');
  assert(result.pieces['f1'] && result.pieces['f1'].type === 'r', 'rook on f1');
  assert(result.pieces['e1'] === null && result.pieces['h1'] === null, 'e1/h1 empty');
});

test('standard queenside castling works (SP 518)', () => {
  const gen = Chess960.generatePosition(518);
  const board = gen.board;
  board.pieces['b1'] = null;
  board.pieces['c1'] = null;
  board.pieces['d1'] = null;
  const result = Chess960.castle(board, 'white', 'q', 'e', 'a');
  assert(result, 'queenside castling legal');
  assert(result.pieces['c1'] && result.pieces['c1'].type === 'k', 'king on c1');
  assert(result.pieces['d1'] && result.pieces['d1'].type === 'r', 'rook on d1');
  assert(result.pieces['e1'] === null && result.pieces['a1'] === null, 'e1/a1 empty');
});

test('Chess960 kingside castling with non-standard king file (SP 709, king on b1)', () => {
  // SP 709: king=b, rooks a and h. Kingside castling: king b->g, rook h->f.
  const gen = Chess960.generatePosition(709);
  assert(gen.kingFile.white === 'b', 'SP 709 king on b');
  const board = gen.board;
  const kf = gen.kingFile.white; // b
  const rk = gen.rookFiles.white.k; // h
  // Clear all files between the king start and its target, and rook start to
  // target, except the two moving pieces.
  const files = Chess960.FILES;
  const kIdx = files.indexOf(kf);
  for (let x = kIdx; x !== 6; x += 1) {
    const sq = files[x] + '1';
    if (sq !== kf + '1' && sq !== rk + '1') board.pieces[sq] = null;
  }
  for (let x = files.indexOf(rk); x !== 5; x -= 1) {
    const sq = files[x] + '1';
    if (sq !== kf + '1' && sq !== rk + '1') board.pieces[sq] = null;
  }
  const result = Chess960.castle(board, 'white', 'k', kf, rk);
  assert(result, '960 kingside castling legal with king on b1');
  assert(result.pieces['g1'] && result.pieces['g1'].type === 'k', 'king lands g1');
  assert(result.pieces['f1'] && result.pieces['f1'].type === 'r', 'rook lands f1');
  assert(result.pieces['b1'] === null && result.pieces['h1'] === null, 'b1/h1 empty');
});

test('Chess960 queenside castling with non-standard rook file (SP 251, king c1 rook b1)', () => {
  // SP 251: king=c, queenside rook=b. Queenside castling: king c->c (stays),
  // rook b->d.
  const gen = Chess960.generatePosition(251);
  const board = gen.board;
  const kf = gen.kingFile.white; // c
  const rq = gen.rookFiles.white.q; // b
  // Move the queen off d1 (the rook's destination square) so the path is clear.
  board.pieces['d1'] = null;
  board.pieces['h4'] = { type: 'q', color: 'white' };
  const files = Chess960.FILES;
  const kIdx = files.indexOf(kf);
  for (let x = kIdx; x !== 2; x -= 1) {
    const sq = files[x] + '1';
    if (sq !== kf + '1' && sq !== rq + '1') board.pieces[sq] = null;
  }
  for (let x = files.indexOf(rq); x !== 3; x += 1) {
    const sq = files[x] + '1';
    if (sq !== kf + '1' && sq !== rq + '1') board.pieces[sq] = null;
  }
  const result = Chess960.castle(board, 'white', 'q', kf, rq);
  assert(result, '960 queenside castling legal');
  assert(result.pieces['d1'] && result.pieces['d1'].type === 'r', 'rook lands d1');
  assert(result.pieces['b1'] === null, 'rook left b1');
});

test('castling blocked when an intermediate square is occupied', () => {
  const gen = Chess960.generatePosition(518);
  const board = gen.board;
  board.pieces['f1'] = null; // clear f1
  // g1 still has the knight -> blocked
  const result = Chess960.castle(board, 'white', 'k', 'e', 'h');
  assert(result === null, 'castling blocked by g1 knight');
});

test('castling denied when king is in check', () => {
  const gen = Chess960.generatePosition(518);
  const board = gen.board;
  board.pieces['f1'] = null;
  board.pieces['g1'] = null;
  // Place a black rook on e2 attacking e1 (same file).
  board.pieces['e2'] = { type: 'r', color: 'black' };
  board.pieces['e8'] = null;
  const result = Chess960.castle(board, 'white', 'k', 'e', 'h');
  assert(result === null, 'castling denied while in check');
});

test('castling denied when a transit square is attacked', () => {
  const gen = Chess960.generatePosition(518);
  const board = gen.board;
  board.pieces['f1'] = null;
  board.pieces['g1'] = null;
  // Black rook on f2 attacks f1 (king transit square).
  board.pieces['f2'] = { type: 'r', color: 'black' };
  board.pieces['f8'] = null;
  const result = Chess960.castle(board, 'white', 'k', 'e', 'h');
  assert(result === null, 'castling denied when f1 attacked');
});

test('castling clears both castling flags for the moving color', () => {
  const gen = Chess960.generatePosition(518);
  const board = gen.board;
  board.pieces['f1'] = null;
  board.pieces['g1'] = null;
  const result = Chess960.castle(board, 'white', 'k', 'e', 'h');
  assert(result.castling.white.kingSide === false, 'white kingSide cleared');
  assert(result.castling.white.queenSide === false, 'white queenSide cleared');
  assert(result.castling.black.kingSide === true, 'black kingSide untouched');
});

// --- Section 4: normalizeSp ---

test('normalizeSp validates range', () => {
  assert(Chess960.normalizeSp(0) === 0, '0 valid');
  assert(Chess960.normalizeSp(959) === 959, '959 valid');
  assert(Chess960.normalizeSp(-1) === null, '-1 invalid');
  assert(Chess960.normalizeSp(960) === null, '960 invalid');
  assert(Chess960.normalizeSp(3.7) === null, 'non-integer invalid');
  assert(Chess960.normalizeSp('x') === null, 'string invalid');
});

console.log('\nAll ' + passed + ' tests passed successfully!');
