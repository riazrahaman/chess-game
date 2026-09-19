#!/usr/bin/env node
'use strict';

/**
 * test/coordinates-trainer-selftest.js
 * Comprehensive self-test suite for G5: Coordinates trainer mini-game.
 * 
 * Verifies:
 * 1. Gate 4 Architectural Invariant: 0 makeMove/createInitialBoard calls.
 * 2. Coordinate geometry and square color calculations.
 * 3. Board square orientation order for White and Black perspectives.
 * 4. Session lifecycle, scoring, streak, latency, and accuracy metrics.
 * 5. Timer countdown and auto-completion.
 * 6. High score persistence logic.
 * 7. HTML, Shell, and Service-Worker wiring.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const Trainer = require(path.join(ROOT, 'src', 'coordinates-trainer.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS: ' + name);
  } catch (err) {
    failed++;
    console.error('FAIL: ' + name + ' — ' + (err && err.message ? err.message : err));
  }
}

console.log('=== G5 Coordinates Trainer Selftest ===');

// 1. Gate 4 Invariant
test('Gate 4 Invariant: zero occurrences of makeMove/createInitialBoard', () => {
  for (const filename of ['coordinates-trainer.js', 'ui-coordinates.js']) {
    const content = fs.readFileSync(path.join(ROOT, 'src', filename), 'utf8');
    assert.ok(!content.includes('makeMove('), `Gate 4 violation: ${filename} contains makeMove(`);
    assert.ok(!content.includes('createInitialBoard('), `Gate 4 violation: ${filename} contains createInitialBoard(`);
  }
});

// 2. Geometry & square color calculations
test('Square color calculation matches official chessboard geometry', () => {
  assert.strictEqual(Trainer.getSquareColor('a1'), 'dark');
  assert.strictEqual(Trainer.getSquareColor('h1'), 'light');
  assert.strictEqual(Trainer.getSquareColor('a8'), 'light');
  assert.strictEqual(Trainer.getSquareColor('h8'), 'dark');
  assert.strictEqual(Trainer.getSquareColor('e4'), 'light');
  assert.strictEqual(Trainer.getSquareColor('d4'), 'dark');
  assert.strictEqual(Trainer.getSquareColor('c3'), 'dark');
  assert.strictEqual(Trainer.getSquareColor('f6'), 'dark');
});

test('Square validation accepts all 64 squares and rejects illegal strings', () => {
  assert.strictEqual(Trainer.ALL_SQUARES.length, 64);
  assert.ok(Trainer.isValidSquare('a1'));
  assert.ok(Trainer.isValidSquare('h8'));
  assert.ok(Trainer.isValidSquare('E4'));
  assert.ok(!Trainer.isValidSquare('i1'));
  assert.ok(!Trainer.isValidSquare('a0'));
  assert.ok(!Trainer.isValidSquare('a9'));
  assert.ok(!Trainer.isValidSquare('invalid'));
});

test('getRandomSquare avoids immediate repeating of previous square', () => {
  for (let i = 0; i < 20; i++) {
    const sq = Trainer.getRandomSquare('e4');
    assert.notStrictEqual(sq, 'e4');
    assert.ok(Trainer.isValidSquare(sq));
  }
});

// 3. Board square orientation order
test('getBoardSquareOrder generates correct top-to-bottom grid for White perspective', () => {
  const squares = Trainer.getBoardSquareOrder('white');
  assert.strictEqual(squares.length, 64);
  // Top-left is a8, top-right is h8
  assert.strictEqual(squares[0].square, 'a8');
  assert.strictEqual(squares[7].square, 'h8');
  // Bottom-left is a1, bottom-right is h1
  assert.strictEqual(squares[56].square, 'a1');
  assert.strictEqual(squares[63].square, 'h1');
});

test('getBoardSquareOrder generates correct top-to-bottom grid for Black perspective', () => {
  const squares = Trainer.getBoardSquareOrder('black');
  assert.strictEqual(squares.length, 64);
  // From Black perspective, top-left is h1, top-right is a1
  assert.strictEqual(squares[0].square, 'h1');
  assert.strictEqual(squares[7].square, 'a1');
  // Bottom-left is h8, bottom-right is a8
  assert.strictEqual(squares[56].square, 'h8');
  assert.strictEqual(squares[63].square, 'a8');
});

// 4. Session lifecycle & scoring
test('createSession and startSession initialize cleanly', () => {
  const session = Trainer.createSession({ perspective: 'white', durationSeconds: 30 });
  assert.strictEqual(session.active, false);
  assert.strictEqual(session.completed, false);
  assert.strictEqual(session.score, 0);

  const started = Trainer.startSession(session, 1000);
  assert.strictEqual(started.active, true);
  assert.ok(Trainer.isValidSquare(started.currentTarget));
  assert.strictEqual(started.startedAt, 1000);
});

test('submitAttempt tracks correct answers, streak, and latency', () => {
  const session = Trainer.createSession({ perspective: 'white', durationSeconds: 30 });
  Trainer.startSession(session, 1000);
  const target = session.currentTarget;

  const res = Trainer.submitAttempt(session, target, 1500);
  assert.strictEqual(res.accepted, true);
  assert.strictEqual(res.correct, true);
  assert.strictEqual(res.score, 1);
  assert.strictEqual(res.streak, 1);
  assert.strictEqual(res.latencyMs, 500);
  assert.notStrictEqual(res.nextTarget, target);
  assert.strictEqual(session.score, 1);
  assert.strictEqual(session.correctCount, 1);
  assert.strictEqual(session.errorCount, 0);
});

test('submitAttempt handles incorrect answers and resets streak without changing target', () => {
  const session = Trainer.createSession({ perspective: 'white', durationSeconds: 30 });
  Trainer.startSession(session, 1000);
  const target = session.currentTarget;
  const wrongSquare = target === 'a1' ? 'h8' : 'a1';

  // First correct move
  Trainer.submitAttempt(session, target, 1200);
  assert.strictEqual(session.currentStreak, 1);

  // Next is wrong
  const nextTarget = session.currentTarget;
  const wrong2 = nextTarget === 'e4' ? 'd5' : 'e4';
  const res2 = Trainer.submitAttempt(session, wrong2, 1800);
  assert.strictEqual(res2.correct, false);
  assert.strictEqual(res2.streak, 0);
  assert.strictEqual(res2.expectedTarget, nextTarget);
  assert.strictEqual(session.score, 1);
  assert.strictEqual(session.correctCount, 1);
  assert.strictEqual(session.errorCount, 1);
  assert.strictEqual(session.currentStreak, 0);
  assert.strictEqual(session.bestStreak, 1);
});

// 5. Timer countdown and endSession summary
test('tickSession decrements time and auto-completes when time expires', () => {
  const session = Trainer.createSession({ perspective: 'white', durationSeconds: 10 });
  Trainer.startSession(session, 1000);

  // Tick halfway (5s elapsed)
  const halfway = Trainer.tickSession(session, 6000);
  assert.strictEqual(halfway, false);
  assert.strictEqual(session.timeRemainingMs, 5000);

  // Tick to expiry (10s elapsed)
  const expired = Trainer.tickSession(session, 11000);
  assert.strictEqual(expired, true);
  assert.strictEqual(session.active, false);
  assert.strictEqual(session.completed, true);
});

test('endSession generates comprehensive performance metrics', () => {
  const session = Trainer.createSession({ perspective: 'white', durationSeconds: 30 });
  Trainer.startSession(session, 1000);

  // 3 correct, 1 wrong
  Trainer.submitAttempt(session, session.currentTarget, 1500); // +1
  Trainer.submitAttempt(session, session.currentTarget, 2000); // +2
  Trainer.submitAttempt(session, 'xx', 2500);                   // wrong
  Trainer.submitAttempt(session, session.currentTarget, 3000); // +3

  const stats = Trainer.endSession(session, 4000);
  assert.strictEqual(stats.score, 3);
  assert.strictEqual(stats.correctCount, 3);
  assert.strictEqual(stats.errorCount, 1);
  assert.strictEqual(stats.totalAttempts, 4);
  assert.strictEqual(stats.accuracy, 75);
  assert.strictEqual(stats.bestStreak, 2);
  assert.strictEqual(stats.history.length, 4);
});

// 6. High score persistence logic
test('updateHighScore and getHighScore handle localStorage persistence', () => {
  const mockStorage = {};
  global.localStorage = {
    getItem: (k) => mockStorage[k] || null,
    setItem: (k, v) => { mockStorage[k] = String(v); }
  };

  assert.strictEqual(Trainer.getHighScore('find', 'white', 30), 0);
  const updated1 = Trainer.updateHighScore('find', 'white', 30, 15);
  assert.strictEqual(updated1, true);
  assert.strictEqual(Trainer.getHighScore('find', 'white', 30), 15);

  // Lower score should not overwrite
  const updated2 = Trainer.updateHighScore('find', 'white', 30, 12);
  assert.strictEqual(updated2, false);
  assert.strictEqual(Trainer.getHighScore('find', 'white', 30), 15);

  // Higher score should overwrite
  const updated3 = Trainer.updateHighScore('find', 'white', 30, 22);
  assert.strictEqual(updated3, true);
  assert.strictEqual(Trainer.getHighScore('find', 'white', 30), 22);

  delete global.localStorage;
});

// 7. Shell, HTML, and wiring verification
test('index.html contains coordinates section and script tags', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('data-view="coordinates"'), 'index.html has data-view="coordinates"');
  assert.ok(html.includes('src="src/coordinates-trainer.js"'), 'index.html loads coordinates-trainer.js');
  assert.ok(html.includes('src="src/ui-coordinates.js"'), 'index.html loads ui-coordinates.js');
});

test('src/shell.js includes coordinates view in KNOWN_VIEWS', () => {
  const shellSrc = fs.readFileSync(path.join(ROOT, 'src', 'shell.js'), 'utf8');
  assert.ok(shellSrc.includes("id: 'coordinates'"), 'shell.js has coordinates view');
});

test('service-worker.js precaches coordinates files', () => {
  const swSrc = fs.readFileSync(path.join(ROOT, 'service-worker.js'), 'utf8');
  assert.ok(swSrc.includes('/src/coordinates-trainer.js'), 'service-worker precaches coordinates-trainer.js');
  assert.ok(swSrc.includes('/src/ui-coordinates.js'), 'service-worker precaches ui-coordinates.js');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
