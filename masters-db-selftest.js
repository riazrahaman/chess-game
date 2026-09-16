#!/usr/bin/env node
'use strict';

const assert = require('assert');
const MastersDb = require('./masters-db.js');

let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS: ${name}`);
}

console.log('=== Masters-DB Mistake Whitelist Self-Test ===\n');

test('book positions have a count and continuations', () => {
  const p = MastersDb.isBookPosition(['e2e4']);
  assert.strictEqual(p.book, true);
  assert(p.count > 0);
  assert(Array.isArray(p.continuations));
  assert(p.continuations.some(c => c.move === 'e7e5'));
});

test('a book continuation is recognized with a master-game count', () => {
  const m = MastersDb.isBookMove(['e2e4'], 'e7e5');
  assert.strictEqual(m.book, true);
  assert(m.games >= MastersDb.MIN_MASTER_GAMES);
});

test('a non-book move is not whitelisted', () => {
  assert.strictEqual(MastersDb.isBookMove(['e2e4'], 'a7a5').book, false);
});

test('deep theory lines resolve to book positions', () => {
  const ruy = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6'];
  const p = MastersDb.isBookPosition(ruy);
  assert.strictEqual(p.book, true);
  assert(p.continuations.some(c => c.move === 'b5a4'));
});

test('unknown positions are not book', () => {
  assert.strictEqual(MastersDb.isBookPosition(['a2a3']).book, false);
  assert.strictEqual(MastersDb.isBookPosition([]).book, false);
});

test('normalizes string and array move inputs identically', () => {
  const a = MastersDb.isBookPosition('e2e4 e7e5 g1f3');
  const b = MastersDb.isBookPosition(['e2e4', 'e7e5', 'g1f3']);
  assert.deepStrictEqual(a, b);
});

test('whitelistMistakes reclassifies a book-true flagged move to Best', () => {
  // Simulate a review where Black's 3...g8f6 (Petrov, book) was flagged as a mistake.
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
  // 2...h6 is not in the Sicilian book (only g1f3/b1c3/c2c3 are).
  const out = MastersDb.whitelistMistakes(review, ['e2e4', 'c7c5', 'h7h6']);
  assert.strictEqual(out.moves[2].key, 'blunder');
});

test('whitelistMistakes is safe on empty/partial inputs', () => {
  assert.deepStrictEqual(MastersDb.whitelistMistakes(null, []), null);
  const empty = MastersDb.whitelistMistakes({ moves: [] }, []);
  assert.deepStrictEqual(empty.moves, []);
});

test('getMastersDbSize reports a non-trivial book', () => {
  assert(MastersDb.getMastersDbSize() > 10);
});

console.log(`\nAll ${passed} tests passed successfully!`);
