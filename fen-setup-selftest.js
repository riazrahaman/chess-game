/**
 * fen-setup-selftest.js — standalone selftest for fen-setup.js.
 * Exits non-zero on any assertion failure.
 */
'use strict';

const FenSetup = require('./fen-setup.js');

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

test('isValid accepts the standard start FEN', () => {
  assert(FenSetup.isValid('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1') === true,
    'standard FEN valid');
});

test('isValid rejects garbage', () => {
  assert(FenSetup.isValid('') === false, 'empty invalid');
  assert(FenSetup.isValid('not-a-fen') === false, 'garbage invalid');
  assert(FenSetup.isValid(null) === false, 'null invalid');
  assert(FenSetup.isValid(undefined) === false, 'undefined invalid');
});

test('canonicalize fills missing halfmove/fullmove', () => {
  const out = FenSetup.canonicalize('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -');
  assert(out !== null, 'canonicalize returns a FEN');
  const parts = out.split(' ');
  assert(parts.length === 6, '6 fields, got ' + parts.length);
  assert(parts[4] === '0' && parts[5] === '1', 'halfmove 0 fullmove 1');
});

test('parseFen extracts turn and castling', () => {
  const p = FenSetup.parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert(p.turn === 'white', 'white to move');
  assert(p.castling.white.kingSide === true && p.castling.white.queenSide === true, 'white castling');
  assert(p.castling.black.kingSide === true && p.castling.black.queenSide === true, 'black castling');
  assert(p.halfmoveClock === 0 && p.fullmoveNumber === 1, 'counters');
});

test('parseFen detects black to move and en passant', () => {
  const fen = 'rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 3';
  const p = FenSetup.parseFen(fen);
  assert(p !== null, 'valid en-passant FEN');
  assert(p.turn === 'black', 'black to move');
  assert(p.enPassant === 'e3', 'en passant square e3');
  assert(p.fullmoveNumber === 3, 'fullmove 3');
});

test('parseFen returns null for invalid FEN', () => {
  assert(FenSetup.parseFen('8/8/8/8/8/8/8/8 w - - 0 1') === null, 'empty board has no kings -> invalid');
});

test('canonicalize round-trips a training position', () => {
  const fen = 'r3k2r/ppp2ppp/8/8/8/8/PPP2PPP/R3K2R w KQkq - 0 1';
  const c = FenSetup.canonicalize(fen);
  assert(c === fen, 'already-canonical FEN unchanged, got ' + c);
});

test('parseFen handles no-castling dash', () => {
  const p = FenSetup.parseFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
  assert(p.castling.white.kingSide === false && p.castling.white.queenSide === false, 'no white castling');
  assert(p.castling.black.kingSide === false && p.castling.black.queenSide === false, 'no black castling');
});

console.log('\nAll ' + passed + ' tests passed successfully!');
