#!/usr/bin/env node
'use strict';

const assert = require('assert');
const DailyPuzzle = require('./daily-puzzle.js');

let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS: ${name}`);
}

const puzzles = Array.from({ length: 31 }, (_, index) => ({
  id: `daily-${String(index + 1).padStart(2, '0')}`,
  rating: 1000 + index * 25
}));

console.log('=== Daily Puzzle Self-Test ===\n');

test('same UTC date always selects the same puzzle', () => {
  const first = DailyPuzzle.dailyPuzzleFor('2026-09-16', puzzles);
  const second = DailyPuzzle.dailyPuzzleFor(new Date('2026-09-16T23:59:59Z'), puzzles);
  assert.strictEqual(first.id, second.id);
});

test('selection is stable across repeated calls and input ordering', () => {
  const expected = DailyPuzzle.dailyPuzzleFor('2026-09-16', puzzles);
  assert.strictEqual(DailyPuzzle.dailyPuzzleFor('2026-09-16', puzzles).id, expected.id);
  assert.strictEqual(DailyPuzzle.dailyPuzzleFor('2026-09-16', puzzles.slice().reverse()).id, expected.id);
});

test('different dates select different fixture puzzles', () => {
  const first = DailyPuzzle.dailyPuzzleFor('2026-09-16', puzzles);
  const second = DailyPuzzle.dailyPuzzleFor('2026-09-17', puzzles);
  assert.notStrictEqual(first.id, second.id);
});

test('non-normalized calendar dates normalize to UTC YYYY-MM-DD', () => {
  assert.strictEqual(DailyPuzzle.normalizeUtcDate('2026-9-6'), '2026-09-06');
  assert.strictEqual(DailyPuzzle.normalizeUtcDate('2026-02-30'), null);
  assert.strictEqual(DailyPuzzle.normalizeUtcDate('not-a-date'), null);
});

test('empty pools and invalid dates return null', () => {
  assert.strictEqual(DailyPuzzle.dailyPuzzleFor('2026-09-16', []), null);
  assert.strictEqual(DailyPuzzle.dailyPuzzleFor('invalid', puzzles), null);
});

test('dailyPuzzleToday returns one item from a non-empty pool', () => {
  const selected = DailyPuzzle.dailyPuzzleToday(puzzles);
  assert(selected);
  assert(puzzles.some(puzzle => puzzle.id === selected.id));
});

console.log(`\nAll ${passed} tests passed successfully!`);
