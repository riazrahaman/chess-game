#!/usr/bin/env node
'use strict';

const assert = require('assert');
const Acpl = require('../src/acpl.js');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS: ${name}`); }

console.log('=== ACPL / Report-Upgrade Self-Test ===\n');

test('ACPL is zero for a perfectly stable eval', () => {
  const r = Acpl.computeAcpl([0, 0, 0, 0, 0], ['e2e4', 'e7e5', 'g1f3', 'b8c6']);
  assert.strictEqual(r.overall, 0);
  assert.strictEqual(r.white, 0);
  assert.strictEqual(r.black, 0);
});

test('ACPL penalizes a white blunder (eval swings against white)', () => {
  // white drops from +30 to -250 in one move => ~280 cp loss for white
  const r = Acpl.computeAcpl([30, -250], ['e2e4']);
  assert(r.white > 200);
  assert.strictEqual(r.black, 0);
});

test('ACPL penalizes a black blunder (eval swings toward white)', () => {
  // white plays a stable move (index 0), then black allows eval to jump +20 -> +300
  // => 280 cp loss for black.
  const r = Acpl.computeAcpl([20, 20, 300], ['e2e4', 'e7e5']);
  assert(r.black > 200);
  assert.strictEqual(r.white, 0);
});

test('ACPL is clamped to reasonable bounds', () => {
  const r = Acpl.computeAcpl([0, 5000], ['e2e4']);
  assert(r.white <= 1000);
});

test('phase segmentation splits by move number', () => {
  const moves = [];
  const evals = [0];
  for (let i = 0; i < 100; i++) { moves.push(`m${i}`); evals.push(0); }
  const phases = Acpl.phaseAcpl(evals, moves);
  assert.strictEqual(phases.opening.plies, 20);
  assert.strictEqual(phases.middlegame.plies, 60);
  assert.strictEqual(phases.endgame.plies, 20);
});

test('move-time stats aggregate correctly', () => {
  const s = Acpl.moveTimeStats([4, 6, 8]);
  assert.strictEqual(s.count, 3);
  assert.strictEqual(s.average, 6);
  assert.strictEqual(s.max, 8);
  assert.strictEqual(s.min, 4);
  assert.strictEqual(s.white, 6); // (4 + 8)/2
  assert.strictEqual(s.black, 6);
});

test('empty move-time input is safe', () => {
  const s = Acpl.moveTimeStats([]);
  assert.strictEqual(s.count, 0);
  assert.strictEqual(s.average, 0);
});

test('phase accuracy buckets review moves', () => {
  const review = {
    moves: [
      { ply: 2, accuracy: 90 },
      { ply: 4, accuracy: 80 },
      { ply: 30, accuracy: 50 },
      { ply: 90, accuracy: 60 }
    ]
  };
  const pa = Acpl.phaseSegmentedAccuracy(review);
  assert.strictEqual(pa.opening, 85);       // (90+80)/2
  assert.strictEqual(pa.middlegame, 50);
  assert.strictEqual(pa.endgame, 60);
});

test('enrichReport attaches all A2.7 fields', () => {
  const enriched = Acpl.enrichReport({ headline: 'x' }, {
    evalHistory: [0, 0, 30],
    moveHistory: ['e2e4', 'e7e5'],
    moveTimes: [3, 5],
    review: { moves: [{ ply: 1, accuracy: 95 }] }
  });
  assert.strictEqual(enriched.headline, 'x');
  assert(typeof enriched.acpl === 'object');
  assert(typeof enriched.phaseAcpl === 'object');
  assert.strictEqual(enriched.moveTime.count, 2);
  assert.strictEqual(enriched.phaseAccuracy.opening, 95);
});

test('edge cases are safe', () => {
  assert.deepStrictEqual(Acpl.computeAcpl([], []), { white: 0, black: 0, overall: 0, plies: 0 });
  assert.strictEqual(Acpl.phaseSegmentedAccuracy(null).opening, null);
  assert.strictEqual(Acpl.moveTimeStats(null).count, 0);
});

console.log(`\nAll ${passed} tests passed successfully!`);
