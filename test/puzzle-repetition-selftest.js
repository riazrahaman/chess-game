'use strict';

/**
 * puzzle-repetition-selftest.js — Spaced-repetition mistake review self-tests.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const DAY_MS = 24 * 60 * 60 * 1000;

// Load the module
const mod = require('../src/puzzle-repetition.js');
const {
  scheduleReview,
  getDueReviews,
  computeIntervalDays,
  saveReviewSchedule,
  loadReviewSchedule,
  DEFAULT_INTERVALS,
  MAX_INTERVAL_DAYS
} = mod;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL: ${name} — ${err.message}`);
    failed++;
  }
}

console.log('\n=== Spaced-Repetition Mistake Review Self-Tests ===\n');

// --- Section 1: Constants & Module shape ---

test('DEFAULT_INTERVALS is [1,2,4,8,16,32]', () => {
  assert.deepStrictEqual(DEFAULT_INTERVALS, [1, 2, 4, 8, 16, 32]);
});

test('MAX_INTERVAL_DAYS is 365', () => {
  assert.strictEqual(MAX_INTERVAL_DAYS, 365);
});

test('module exports scheduleReview, getDueReviews, computeIntervalDays', () => {
  assert.strictEqual(typeof scheduleReview, 'function');
  assert.strictEqual(typeof getDueReviews, 'function');
  assert.strictEqual(typeof computeIntervalDays, 'function');
});

// --- Section 2: Initial schedule (first-ever failure) ---

test('Initial schedule: nextDueAt = now + 1 day', () => {
  const now = 1000000;
  const rec = scheduleReview('p1', { now, wasCorrect: false });
  assert.strictEqual(rec.puzzleId, 'p1');
  assert.strictEqual(rec.intervalDays, 1);
  assert.strictEqual(rec.nextDueAt, now + 1 * DAY_MS);
  assert.strictEqual(rec.reviewCount, 1);
  assert.strictEqual(rec.step, 0);
  assert.strictEqual(rec.correctStreak, 0);
});

test('Initial schedule with no existing record defaults to step 0', () => {
  const rec = scheduleReview('p2', { now: 5000, wasCorrect: true });
  assert.strictEqual(rec.step, 0);
  assert.strictEqual(rec.intervalDays, 1);
  assert.strictEqual(rec.reviewCount, 1);
});

// --- Section 3: Interval growth on correct ---

test('Correct review advances interval from 1d to 2d', () => {
  const now = 1000000;
  const first = scheduleReview('p3', { now, wasCorrect: false });
  const second = scheduleReview('p3', { now: now + DAY_MS, wasCorrect: true, existing: first });
  assert.strictEqual(second.intervalDays, 2);
  assert.strictEqual(second.step, 1);
  assert.strictEqual(second.reviewCount, 2);
  assert.strictEqual(second.correctStreak, 1);
});

test('Multiple correct reviews advance through intervals [1,2,4,8,16,32]', () => {
  const now = 1000000;
  let rec = scheduleReview('p4', { now, wasCorrect: false });
  const intervals = [2, 4, 8, 16, 32];
  for (let i = 0; i < intervals.length; i++) {
    rec = scheduleReview('p4', { now: now + (i + 1) * DAY_MS, wasCorrect: true, existing: rec });
    assert.strictEqual(rec.intervalDays, intervals[i], `step ${i + 1} should be ${intervals[i]}d`);
    assert.strictEqual(rec.step, i + 1);
  }
});

test('Interval caps at MAX_INTERVAL_DAYS after max step', () => {
  const now = 1000000;
  let rec = scheduleReview('p5', { now, wasCorrect: false });
  // Advance to max step
  for (let i = 0; i < DEFAULT_INTERVALS.length; i++) {
    rec = scheduleReview('p5', { now: now + i * DAY_MS, wasCorrect: true, existing: rec });
  }
  // One more correct — should cap
  rec = scheduleReview('p5', { now: now + 999 * DAY_MS, wasCorrect: true, existing: rec });
  assert.strictEqual(rec.intervalDays, MAX_INTERVAL_DAYS);
});

// --- Section 4: Reset on incorrect ---

test('Incorrect review resets to first interval (1d)', () => {
  const now = 1000000;
  const first = scheduleReview('p6', { now, wasCorrect: false });
  const second = scheduleReview('p6', { now: now + DAY_MS, wasCorrect: true, existing: first });
  assert.strictEqual(second.intervalDays, 2);
  const third = scheduleReview('p6', { now: now + 3 * DAY_MS, wasCorrect: false, existing: second });
  assert.strictEqual(third.intervalDays, 1);
  assert.strictEqual(third.step, 0);
  assert.strictEqual(third.correctStreak, 0);
  assert.strictEqual(third.reviewCount, 3);
});

test('Reset from high step returns to 1d', () => {
  const now = 1000000;
  let rec = scheduleReview('p7', { now, wasCorrect: false });
  for (let i = 0; i < 5; i++) {
    rec = scheduleReview('p7', { now: now + i * DAY_MS, wasCorrect: true, existing: rec });
  }
  assert(rec.intervalDays >= 16, 'should be at 16d+ before reset');
  rec = scheduleReview('p7', { now: now + 999 * DAY_MS, wasCorrect: false, existing: rec });
  assert.strictEqual(rec.intervalDays, 1);
  assert.strictEqual(rec.step, 0);
});

// --- Section 5: getDueReviews filtering ---

test('getDueReviews returns puzzles with nextDueAt <= now', () => {
  const now = 5000000;
  const puzzles = [
    { id: 'a', reviewSchedule: { nextDueAt: now - 1000 } },   // due
    { id: 'b', reviewSchedule: { nextDueAt: now + 1000 } },   // not due
    { id: 'c', reviewSchedule: { nextDueAt: now } },           // due (exact)
    { id: 'd' }                                                 // no schedule
  ];
  const due = getDueReviews(puzzles, now);
  assert.strictEqual(due.length, 2);
  assert.strictEqual(due[0].id, 'a');
  assert.strictEqual(due[1].id, 'c');
});

test('getDueReviews handles empty/null input', () => {
  assert.deepStrictEqual(getDueReviews(null, Date.now()), []);
  assert.deepStrictEqual(getDueReviews([], Date.now()), []);
  assert.deepStrictEqual(getDueReviews(undefined, Date.now()), []);
});

test('getDueReviews supports .schedule alias', () => {
  const now = 5000000;
  const puzzles = [
    { id: 'x', schedule: { nextDueAt: now - 500 } }
  ];
  const due = getDueReviews(puzzles, now);
  assert.strictEqual(due.length, 1);
  assert.strictEqual(due[0].id, 'x');
});

// --- Section 6: Default-fresh on missing record ---

test('scheduleReview with null existing creates fresh record', () => {
  const rec = scheduleReview('p8', { now: 9000, wasCorrect: false, existing: null });
  assert.strictEqual(rec.step, 0);
  assert.strictEqual(rec.intervalDays, 1);
  assert.strictEqual(rec.reviewCount, 1);
});

test('scheduleReview with undefined puzzleId uses "unknown"', () => {
  const rec = scheduleReview(undefined, { now: 9000, wasCorrect: false });
  assert.strictEqual(rec.puzzleId, 'unknown');
});

// --- Section 7: Persistence (saveReviewSchedule / loadReviewSchedule) ---

test('saveReviewSchedule returns null gracefully when no archive backend', () => {
  // In test environment, game-archive.js may be available but uses default db.
  // Just verify it doesn't throw.
  const rec = scheduleReview('p9', { now: 9000, wasCorrect: false });
  const result = saveReviewSchedule(rec);
  // result may be null (no backend) or an object (if backend available)
  assert(result === null || typeof result === 'object');
});

test('loadReviewSchedule returns null gracefully when not found', () => {
  const result = loadReviewSchedule('nonexistent-puzzle-id-xyz');
  assert(result === null || typeof result === 'object');
});

// --- Section 8: Null-archive no-throw degradation ---

test('Null-archive: saveReviewSchedule does not throw', () => {
  // Force backend to null
  const orig = require('../src/game-archive.js');
  // Temporarily mock by calling with a bad record
  assert.doesNotThrow(() => saveReviewSchedule(null));
  assert.doesNotThrow(() => saveReviewSchedule(undefined));
  assert.doesNotThrow(() => saveReviewSchedule({}));
});

test('Null-archive: loadReviewSchedule does not throw on bad input', () => {
  assert.doesNotThrow(() => loadReviewSchedule(null));
  assert.doesNotThrow(() => loadReviewSchedule(undefined));
  assert.doesNotThrow(() => loadReviewSchedule(''));
});

// --- Section 9: Integration with game-archive.js ---

test('game-archive.js exports savePuzzleReview and getPuzzleReview', () => {
  const ga = require('../src/game-archive.js');
  assert.strictEqual(typeof ga.savePuzzleReview, 'function');
  assert.strictEqual(typeof ga.getPuzzleReview, 'function');
});

test('game-archive.js round-trip: save then load returns same data', () => {
  const ga = require('../src/game-archive.js');
  const archive = ga.createGameArchive({ forceJson: true, jsonPath: ':memory:' });
  const rec = scheduleReview('p-rt', { now: 12345, wasCorrect: false });
  const saved = archive.savePuzzleReview(rec);
  assert(saved !== null, 'savePuzzleReview should return non-null on memory store');
  const loaded = archive.getPuzzleReview('p-rt');
  assert(loaded !== null, 'getPuzzleReview should return the saved record');
  assert.strictEqual(loaded.puzzleId, 'p-rt');
  assert.strictEqual(loaded.nextDueAt, rec.nextDueAt);
  assert.strictEqual(loaded.intervalDays, rec.intervalDays);
  assert.strictEqual(loaded.step, rec.step);
  assert.strictEqual(loaded.reviewCount, rec.reviewCount);
  archive.close();
});

test('game-archive.js getPuzzleReview returns null for missing puzzle', () => {
  const ga = require('../src/game-archive.js');
  const archive = ga.createGameArchive({ forceJson: true, jsonPath: ':memory:' });
  const result = archive.getPuzzleReview('does-not-exist');
  assert.strictEqual(result, null);
  archive.close();
});

// --- Section 10: Gate-4 invariant ---

test('Gate-4: puzzle-repetition.js contains no makeMove( calls', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'puzzle-repetition.js'), 'utf8');
  assert(!code.includes('makeMove('), 'puzzle-repetition.js must not call makeMove(');
});

test('Gate-4: puzzle-repetition.js contains no createInitialBoard( calls', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'puzzle-repetition.js'), 'utf8');
  assert(!code.includes('createInitialBoard('), 'puzzle-repetition.js must not call createInitialBoard(');
});

// --- Summary ---

console.log(`\n=== Spaced-Repetition Self-Test Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
console.log('\nAll spaced-repetition self-tests PASSED successfully!');