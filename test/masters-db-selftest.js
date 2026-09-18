#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const MastersDb = require('../src/masters-db.js');
const Explorer = require('../src/openings-explorer.js');

let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS: ${name}`);
}

console.log('=== Masters-DB Book-Theory Whitelist Self-Test (TSV-derived, no game counts) ===\n');

test('book is derived from data/openings.tsv (lichess chess-openings)', () => {
  assert.strictEqual(Explorer.ensureDefaultLoaded(), true, 'data/openings.tsv must load');
  assert(MastersDb.getMastersDbSize() > 3000, `expected ~3,800 named lines, got ${MastersDb.getMastersDbSize()}`);
  assert(/chess-openings/.test(MastersDb.BOOK_SOURCE));
});

test('book positions report presence + continuations, never a game count', () => {
  const p = MastersDb.isBookPosition(['e2e4']);
  assert.strictEqual(p.book, true);
  assert.strictEqual(p.known, true);
  assert.strictEqual(p.games, null, 'no game counts exist in this module');
  assert(Array.isArray(p.continuations));
  assert(p.continuations.some(c => c.move === 'e7e5'));
  for (const c of p.continuations) assert.strictEqual(c.games, null);
});

test('a book continuation is recognized by presence alone', () => {
  const m = MastersDb.isBookMove(['e2e4'], 'e7e5');
  assert.strictEqual(m.book, true);
  assert.strictEqual(m.known, true);
  assert.strictEqual(m.games, null);
  assert.strictEqual(MastersDb.MIN_MASTER_GAMES, undefined, 'fake count threshold must be gone');
});

test('a non-book move is not whitelisted', () => {
  // 1. e4 b5 is the one Black pawn reply with no named line in lichess chess-openings
  // (even 1...h5 "Goldsmith Defense" and 1...a5 are named).
  assert.strictEqual(MastersDb.isBookMove(['e2e4'], 'b7b5').book, false);
});

test('deep theory lines resolve to book positions', () => {
  const ruy = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6'];
  const p = MastersDb.isBookPosition(ruy);
  assert.strictEqual(p.book, true);
  assert(p.continuations.some(c => c.move === 'b5a4'));
});

test('unknown positions are not book', () => {
  // 1. a3 IS a named line (Anderssen Opening) — but 1. a3 a6 2. a4 is not.
  assert.strictEqual(MastersDb.isBookPosition(['a2a3']).book, true);
  assert.strictEqual(MastersDb.isBookPosition(['a2a3', 'a7a6', 'a3a4']).book, false);
  assert.strictEqual(MastersDb.isBookPosition(['e2e4', 'c7c5', 'h7h6']).book, false);
});

test('start position is book (a prefix of every line)', () => {
  const p = MastersDb.isBookPosition([]);
  assert.strictEqual(p.book, true);
  assert(p.continuations.some(c => c.move === 'e2e4'));
  assert(p.continuations.some(c => c.move === 'd2d4'));
});

test('normalizes string and array move inputs identically', () => {
  const a = MastersDb.isBookPosition('e2e4 e7e5 g1f3');
  const b = MastersDb.isBookPosition(['e2e4', 'e7e5', 'g1f3']);
  assert.deepStrictEqual(a, b);
});

test('whitelistMistakes reclassifies a book-true flagged move to Best', () => {
  // Black's 2...Nf6 (Petrov, C42) flagged as a mistake by the engine.
  const review = {
    whiteAccuracy: 90,
    blackAccuracy: 70,
    counts: { white: {}, black: {} },
    moves: [
      { key: 'best', move: 'e2e4', color: 'white', ply: 1 },
      { key: 'best', move: 'e7e5', color: 'black', ply: 2 },
      { key: 'best', move: 'g1f3', color: 'white', ply: 3 },
      { key: 'mistake', move: 'g8f6', color: 'black', ply: 4, label: 'Mistake', accuracy: 32 }
    ]
  };
  const out = MastersDb.whitelistMistakes(review, ['e2e4', 'e7e5', 'g1f3', 'g8f6']);
  assert.strictEqual(out.moves[3].key, 'best');
  assert.strictEqual(out.moves[3].bookTheory, true);
  assert.strictEqual(out.moves[3].accuracy, 100);
  assert(/chess-openings/.test(out.moves[3].bookSource));
  // original is not mutated
  assert.strictEqual(review.moves[3].key, 'mistake');
});

test('whitelistMistakes leaves a true blunder (non-book) untouched', () => {
  const review = {
    whiteAccuracy: 90,
    blackAccuracy: 50,
    counts: {},
    moves: [
      { key: 'best', move: 'e2e4', color: 'white', ply: 1 },
      { key: 'best', move: 'c7c5', color: 'black', ply: 2 },
      { key: 'blunder', move: 'h7h6', color: 'black', ply: 3, label: 'Blunder', accuracy: 10 }
    ]
  };
  const out = MastersDb.whitelistMistakes(review, ['e2e4', 'c7c5', 'h7h6']);
  assert.strictEqual(out.moves[2].key, 'blunder');
});

test('whitelistMistakes is safe on empty/partial inputs', () => {
  assert.deepStrictEqual(MastersDb.whitelistMistakes(null, []), null);
  const empty = MastersDb.whitelistMistakes({ moves: [] }, []);
  assert.deepStrictEqual(empty.moves, []);
});

test('browser cache API accepts /api/openings/lookup continuations', () => {
  // Pure cache behaviour (does not depend on the TSV being absent).
  MastersDb.addBookPosition(['h2h4', 'h7h5'], [{ uci: 'g2g4', lines: 1 }]);
  const n = MastersDb.loadBookLines([['b2b3', 'e7e5', 'c1b2']]);
  assert.strictEqual(n, 3);
});

test('source file contains no hardcoded game counts', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'masters-db.js'), 'utf8');
  assert(!/games:\s*\d/.test(code), 'masters-db.js must not contain numeric games: literals');
  assert(!/MIN_MASTER_GAMES\s*=/.test(code));
  assert(!code.includes('makeMove(') && !code.includes('createInitialBoard('), 'Gate 4');
});

console.log(`\nAll ${passed} tests passed successfully!`);
