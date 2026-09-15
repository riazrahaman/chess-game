#!/usr/bin/env node
'use strict';

const assert = require('assert');
const gameArchive = require('./game-archive.js');
const PuzzleRating = require('./puzzle-rating.js');

let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS: ${name}`);
}

console.log('=== Puzzle Glicko-2 Rating Self-Test ===\n');

test('solver and puzzle ratings both change after a solve', () => {
  const solver = PuzzleRating.createSolverRating({ rating: 1500, rd: 200 });
  const puzzle = PuzzleRating.createPuzzleRating({ id: 'solve', rating: 1500, rd: 200 });
  const updated = PuzzleRating.recordSolve(solver, puzzle, 'solved', 30);
  assert(updated.solver.rating > solver.rating);
  assert(updated.puzzle.rating < puzzle.rating);
  assert.strictEqual(updated.score, 1);
});

test('failed attempt lowers solver and raises puzzle rating', () => {
  const solver = PuzzleRating.createSolverRating({ rating: 1500, rd: 200 });
  const puzzle = PuzzleRating.createPuzzleRating({ id: 'fail', rating: 1500, rd: 200 });
  const updated = PuzzleRating.recordSolve(solver, puzzle, 'failed', 20);
  assert(updated.solver.rating < solver.rating);
  assert(updated.puzzle.rating > puzzle.rating);
  assert.strictEqual(updated.score, 0);
});

test('equal-RD two-sided updates are symmetric', () => {
  const solver = PuzzleRating.createSolverRating({ rating: 1500, rd: 200, vol: 0.06 });
  const puzzle = PuzzleRating.createPuzzleRating({ id: 'symmetric', rating: 1500, rd: 200, vol: 0.06 });
  const updated = PuzzleRating.recordSolve(solver, puzzle, 'solved', 30);
  const solverGain = updated.solver.rating - solver.rating;
  const puzzleLoss = puzzle.rating - updated.puzzle.rating;
  assert(Math.abs(solverGain - puzzleLoss) < 0.000001);
});

test('imported and updated ratings are clamped to the supported range', () => {
  assert.strictEqual(PuzzleRating.createPuzzleRating({ rating: 50 }).rating, PuzzleRating.MIN_RATING);
  assert.strictEqual(PuzzleRating.createPuzzleRating({ rating: 9999 }).rating, PuzzleRating.MAX_RATING);
  assert.strictEqual(PuzzleRating.createSolverRating({ rating: -1 }).rating, PuzzleRating.MIN_RATING);
  assert.strictEqual(PuzzleRating.createSolverRating({ rating: 5000 }).rating, PuzzleRating.MAX_RATING);
});

test('selectNextPuzzle picks the nearest puzzle rating', () => {
  const puzzles = [
    { id: 'easy', rating: 900 },
    { id: 'near', rating: 1535 },
    { id: 'hard', rating: 2100 }
  ];
  assert.strictEqual(PuzzleRating.selectNextPuzzle({ rating: 1500 }, puzzles).id, 'near');
});

test('time bonus and solve scores stay bounded from 0 through 1', () => {
  for (const seconds of [-1, 0, 1, 60, 600, Infinity, NaN]) {
    const bonus = PuzzleRating.calculateTimeBonus(seconds);
    assert(bonus >= 0 && bonus <= 1);
  }
  assert.strictEqual(PuzzleRating.calculateSolveScore('failed', 1), 0);
  assert(PuzzleRating.calculateSolveScore('solved', 600) < PuzzleRating.calculateSolveScore('solved', 30));
  assert(PuzzleRating.calculateSolveScore('solved', 600) <= 1);
});

test('no-result and empty-selection paths do not crash', () => {
  const unchanged = PuzzleRating.recordSolve(
    PuzzleRating.createSolverRating(),
    PuzzleRating.createPuzzleRating({ id: 'none', rating: 1500 }),
    null,
    null
  );
  assert.strictEqual(unchanged.recorded, false);
  assert.strictEqual(unchanged.score, null);
  assert.strictEqual(PuzzleRating.selectNextPuzzle(unchanged.solver, []), null);
});

test('store persists solver and puzzle ratings through game-archive storage', () => {
  const archive = gameArchive.createGameArchive({ forceJson: true, jsonPath: ':memory:' });
  const firstStore = new PuzzleRating.PuzzleRatingStore({ archive });
  const updated = firstStore.recordSolve({ id: 'persisted', rating: 1600 }, 'failed', 45, 'user-1');
  const secondStore = new PuzzleRating.PuzzleRatingStore({ archive });
  assert.strictEqual(secondStore.getSolver('user-1').rating, updated.solver.rating);
  assert.strictEqual(secondStore.getPuzzle({ id: 'persisted', rating: 1600 }).rating, updated.puzzle.rating);
  archive.close();
});

test('null archive gracefully retains ratings in memory', () => {
  const store = new PuzzleRating.PuzzleRatingStore({ archive: null });
  const updated = store.recordSolve({ id: 'memory', rating: 1400 }, 'solved', 40);
  assert.strictEqual(store.getSolver().rating, updated.solver.rating);
  assert.strictEqual(store.getPuzzle({ id: 'memory', rating: 1400 }).rating, updated.puzzle.rating);
});

console.log(`\nAll ${passed} tests passed successfully!`);
