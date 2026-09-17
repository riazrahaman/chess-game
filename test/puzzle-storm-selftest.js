#!/usr/bin/env node
'use strict';

const assert = require('assert');
const PuzzleStorm = require('../src/puzzle-storm.js');

let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS: ${name}`);
}

function puzzlePool() {
  return [
    { id: 'p1400', rating: 1400 },
    { id: 'p1500-a', rating: 1500 },
    { id: 'p1500-b', rating: 1500 },
    { id: 'p1550', rating: 1550 },
    { id: 'p1600', rating: 1600 },
    { id: 'p1700', rating: 1700 }
  ];
}

console.log('=== Puzzle Storm Self-Test ===\n');

test('startSession creates an active three-minute session by default', () => {
  const session = PuzzleStorm.startSession({ puzzles: puzzlePool(), seed: 'default', now: 1000, archive: null });
  assert.strictEqual(session.status, 'active');
  assert.strictEqual(session.solverId, 'default');
  assert.strictEqual(session.deadline - session.startAt, 180000);
  assert(session.activePuzzle);
});

test('solves grow streak, solved count, best streak, and difficulty', () => {
  const session = PuzzleStorm.startSession({
    puzzles: puzzlePool(), seed: 'growth', now: 1000, archive: null, difficultyStep: 50
  });
  session.recordResult('solved', 20, 2000);
  assert.strictEqual(session.streak, 1);
  assert.strictEqual(session.solved, 1);
  assert.strictEqual(session.bestStreak, 1);
  assert.strictEqual(session.difficulty, session.baseRating + 50);
  session.submit({ result: 'solved', timeSec: 20, now: 3000 });
  assert.strictEqual(session.streak, 2);
  assert.strictEqual(session.solved, 2);
  assert.strictEqual(session.bestStreak, 2);
  assert.strictEqual(session.difficulty, session.baseRating + 100);
});

test('failure resets current streak but preserves best streak', () => {
  const session = PuzzleStorm.startSession({ puzzles: puzzlePool(), seed: 'reset', now: 1000, archive: null });
  session.recordResult('solved', 15, 2000);
  session.recordResult('solved', 15, 3000);
  session.recordResult('failed', 15, 4000);
  assert.strictEqual(session.streak, 0);
  assert.strictEqual(session.bestStreak, 2);
  assert.strictEqual(session.solved, 2);
  assert.strictEqual(session.failed, 1);
  assert.strictEqual(session.difficulty, session.baseRating);
});

test('difficulty escalation selects progressively harder puzzles', () => {
  const session = PuzzleStorm.startSession({
    puzzles: puzzlePool(), rng: () => 0, now: 1000, archive: null, difficultyStep: 50
  });
  session.recordResult('solved', 10, 2000);
  assert.strictEqual(session.activePuzzle.id, 'p1550');
  session.recordResult('solved', 10, 3000);
  assert.strictEqual(session.activePuzzle.id, 'p1600');
});

test('expired sessions reject attempts and finalize their summary', () => {
  const session = PuzzleStorm.startSession({ puzzles: puzzlePool(), seed: 'expiry', durationSec: 2, now: 1000, archive: null });
  assert.strictEqual(session.timeRemaining(2000), 1);
  const result = session.recordResult('solved', 1, 3000);
  assert.strictEqual(result.timeUp, true);
  assert.strictEqual(session.status, 'complete');
  assert.strictEqual(session.solved, 0);
  assert.strictEqual(session.activePuzzle, null);
  assert.deepStrictEqual(session.finalize(3000), { streak: 0, solved: 0, failed: 0, bestStreak: 0 });
  assert.strictEqual(session.isComplete(3000), true);
});

test('empty pools and already-elapsed sessions are terminal', () => {
  const empty = PuzzleStorm.startSession({ puzzles: [], now: 1000, archive: null });
  assert.strictEqual(empty.status, 'empty');
  assert.strictEqual(empty.activePuzzle, null);
  assert.strictEqual(empty.timeRemaining(1000), 0);
  assert.strictEqual(empty.isComplete(1000), true);

  const elapsed = PuzzleStorm.startSession({ puzzles: puzzlePool(), durationSec: 0, now: 1000, archive: null });
  assert.strictEqual(elapsed.status, 'complete');
  assert.strictEqual(elapsed.activePuzzle, null);
});

test('same seed produces the same first puzzle without shared state', () => {
  const first = PuzzleStorm.startSession({ puzzles: puzzlePool(), seed: 'repeatable', now: 1000, archive: null });
  const second = PuzzleStorm.startSession({ puzzles: puzzlePool(), seed: 'repeatable', now: 1000, archive: null });
  assert.strictEqual(first.activePuzzle.id, second.activePuzzle.id);
  assert.notStrictEqual(first, second);
});

test('default session selection is deterministic without a seed or RNG', () => {
  const first = PuzzleStorm.startSession({ puzzles: puzzlePool(), now: 1000, archive: null });
  const second = PuzzleStorm.startSession({ puzzles: puzzlePool(), now: 1000, archive: null });
  assert.strictEqual(first.activePuzzle.id, second.activePuzzle.id);
});

test('null archive degradation still updates solver and puzzle ratings', () => {
  const session = PuzzleStorm.startSession({ puzzles: puzzlePool(), seed: 'memory', now: 1000, archive: null });
  const solverBefore = session.solver.rating;
  const puzzleBefore = session.activePuzzle.puzzleRating.rating;
  const result = session.recordResult('solved', 20, 2000);
  assert(result.ratingUpdate);
  assert(session.solver.rating > solverBefore);
  assert(result.ratingUpdate.puzzle.rating < puzzleBefore);
});

console.log(`\nAll ${passed} tests passed successfully!`);
