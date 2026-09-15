#!/usr/bin/env node
'use strict';

/**
 * eval-graph-selftest.js — Interactive eval graph self-tests.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const EvalGraph = require('./eval-graph.js');
const {
  buildEvalGraph,
  buildTooltip,
  computeAcplDelta,
  classifyMoveByDelta,
  formatEval,
  formatAcplDelta,
  plyFromX,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  EVAL_CLAMP,
  MATE_SENTINEL
} = EvalGraph;

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

console.log('\n=== Interactive Eval Graph Self-Tests ===\n');

// --- Section 1: Module exports ---

test('module exports all public functions', () => {
  assert.strictEqual(typeof buildEvalGraph, 'function');
  assert.strictEqual(typeof buildTooltip, 'function');
  assert.strictEqual(typeof computeAcplDelta, 'function');
  assert.strictEqual(typeof classifyMoveByDelta, 'function');
  assert.strictEqual(typeof formatEval, 'function');
  assert.strictEqual(typeof formatAcplDelta, 'function');
  assert.strictEqual(typeof plyFromX, 'function');
  assert.ok(typeof DEFAULT_WIDTH === 'number');
  assert.ok(typeof DEFAULT_HEIGHT === 'number');
  assert.ok(typeof EVAL_CLAMP === 'number');
  assert.ok(typeof MATE_SENTINEL === 'number');
});

// --- Section 2: computeAcplDelta ---

test('computeAcplDelta: zero when eval unchanged', () => {
  assert.strictEqual(computeAcplDelta(100, 100), 0);
});

test('computeAcplDelta: positive when eval drops', () => {
  // White moved and eval went from +100 to +50 → lost 50 cp
  assert.strictEqual(computeAcplDelta(50, 100), 50);
});

test('computeAcplDelta: zero when eval improves', () => {
  // White moved and eval went from +50 to +100 → improved, no loss
  assert.strictEqual(computeAcplDelta(100, 50), 0);
});

test('computeAcplDelta: handles non-number inputs', () => {
  assert.strictEqual(computeAcplDelta(null, 100), 0);
  assert.strictEqual(computeAcplDelta(100, undefined), 0);
  assert.strictEqual(computeAcplDelta('foo', 100), 0);
});

test('computeAcplDelta: returns 0 for mate sentinels', () => {
  assert.strictEqual(computeAcplDelta(MATE_SENTINEL, 100), 0);
  assert.strictEqual(computeAcplDelta(100, -MATE_SENTINEL), 0);
  assert.strictEqual(computeAcplDelta(-MATE_SENTINEL, MATE_SENTINEL), 0);
});

// --- Section 3: classifyMoveByDelta ---

test('classifyMoveByDelta: best (≤10)', () => {
  assert.strictEqual(classifyMoveByDelta(0), 'best');
  assert.strictEqual(classifyMoveByDelta(10), 'best');
});

test('classifyMoveByDelta: excellent (≤25)', () => {
  assert.strictEqual(classifyMoveByDelta(25), 'excellent');
});

test('classifyMoveByDelta: good (≤50)', () => {
  assert.strictEqual(classifyMoveByDelta(50), 'good');
});

test('classifyMoveByDelta: inaccuracy (≤100)', () => {
  assert.strictEqual(classifyMoveByDelta(100), 'inaccuracy');
});

test('classifyMoveByDelta: mistake (≤300)', () => {
  assert.strictEqual(classifyMoveByDelta(300), 'mistake');
});

test('classifyMoveByDelta: blunder (>300)', () => {
  assert.strictEqual(classifyMoveByDelta(301), 'blunder');
  assert.strictEqual(classifyMoveByDelta(1000), 'blunder');
});

test('classifyMoveByDelta: unknown for non-number', () => {
  assert.strictEqual(classifyMoveByDelta(null), 'unknown');
  assert.strictEqual(classifyMoveByDelta(Infinity), 'unknown');
});

// --- Section 4: formatEval ---

test('formatEval: positive centipawns', () => {
  assert.strictEqual(formatEval(125), '+1.25');
  assert.strictEqual(formatEval(100), '+1.00');
});

test('formatEval: negative centipawns', () => {
  assert.strictEqual(formatEval(-80), '-0.80');
  assert.strictEqual(formatEval(-300), '-3.00');
});

test('formatEval: zero', () => {
  assert.strictEqual(formatEval(0), '0.00');
});

test('formatEval: mate sentinel', () => {
  assert.strictEqual(formatEval(MATE_SENTINEL), 'Mate for White');
  assert.strictEqual(formatEval(-MATE_SENTINEL), 'Mate for Black');
});

test('formatEval: non-number', () => {
  assert.strictEqual(formatEval(null), '—');
  assert.strictEqual(formatEval(NaN), '—');
});

// --- Section 5: formatAcplDelta ---

test('formatAcplDelta: best (delta=0)', () => {
  assert.strictEqual(formatAcplDelta(0, 100, 100), 'Best');
});

test('formatAcplDelta: shows delta for loss', () => {
  assert.strictEqual(formatAcplDelta(50, 50, 100), 'Δ -0.50');
});

test('formatAcplDelta: handles mate', () => {
  assert.strictEqual(formatAcplDelta(0, MATE_SENTINEL, 100), '—');
});

test('formatAcplDelta: non-number cp returns dash', () => {
  assert.strictEqual(formatAcplDelta(0, null, 100), '—');
});

test('formatAcplDelta: non-number prevCp returns Best (first ply)', () => {
  assert.strictEqual(formatAcplDelta(0, 100, null), 'Best');
});

// --- Section 6: buildTooltip ---

test('buildTooltip: basic tooltip with SAN and eval', () => {
  const tip = buildTooltip(0, 50, 'e4', null);
  assert.strictEqual(tip.ply, 0);
  assert.strictEqual(tip.san, 'e4');
  assert.strictEqual(tip.evalText, '+0.50');
  assert.strictEqual(tip.acplDelta, 0);
  assert.strictEqual(tip.acplText, 'Best');
  assert.strictEqual(tip.classification, 'best');
});

test('buildTooltip: tooltip with ACPL delta from previous ply', () => {
  const tip = buildTooltip(1, 50, 'Nf3', 200);
  assert.strictEqual(tip.ply, 1);
  assert.strictEqual(tip.san, 'Nf3');
  assert.strictEqual(tip.evalText, '+0.50');
  assert.strictEqual(tip.acplDelta, 150);
  assert.strictEqual(tip.classification, 'mistake');
});

test('buildTooltip: null SAN handled', () => {
  const tip = buildTooltip(0, 0, null, null);
  assert.strictEqual(tip.san, null);
  assert.strictEqual(tip.evalText, '0.00');
});

test('buildTooltip: showClassification=false suppresses classification', () => {
  const tip = buildTooltip(0, 50, 'e4', 200, { showClassification: false });
  assert.strictEqual(tip.classification, null);
});

test('buildTooltip: mate sentinel handled', () => {
  const tip = buildTooltip(5, MATE_SENTINEL, 'Qh5', 100);
  assert.strictEqual(tip.evalText, 'Mate for White');
  assert.strictEqual(tip.acplDelta, 0);
  assert.strictEqual(tip.acplText, '—');
});

// --- Section 7: buildEvalGraph ---

test('buildEvalGraph: basic graph with 5 plies', () => {
  const evals = [0, 50, 100, 80, 120];
  const moves = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'];
  const graph = buildEvalGraph(evals, moves);
  assert.strictEqual(graph.plyCount, 5);
  assert.ok(graph.pathData);
  assert.ok(graph.pathData.startsWith('M '));
  assert.strictEqual(graph.points.length, 5);
  assert.strictEqual(graph.tooltips.length, 5);
  assert.strictEqual(graph.clickTargets.length, 5);
});

test('buildEvalGraph: tooltips include SAN + eval + ACPL', () => {
  const evals = [0, 100, 50];
  const moves = ['e4', 'e5', 'Nf3'];
  const graph = buildEvalGraph(evals, moves);
  const tip1 = graph.tooltips[1];
  assert.strictEqual(tip1.san, 'e5');
  assert.strictEqual(tip1.evalText, '+1.00');
  assert.strictEqual(tip1.acplDelta, 0); // 0 → 100 = improvement, no loss
  const tip2 = graph.tooltips[2];
  assert.strictEqual(tip2.san, 'Nf3');
  assert.strictEqual(tip2.evalText, '+0.50');
  assert.strictEqual(tip2.acplDelta, 50); // 100 → 50 = lost 50 cp
  assert.strictEqual(tip2.classification, 'good');
});

test('buildEvalGraph: empty series returns single-point graph', () => {
  const graph = buildEvalGraph([], []);
  assert.strictEqual(graph.plyCount, 1);
  assert.ok(graph.pathData);
  assert.strictEqual(graph.tooltips.length, 1);
  assert.strictEqual(graph.tooltips[0].san, null);
});

test('buildEvalGraph: single ply', () => {
  const graph = buildEvalGraph([50], ['e4']);
  assert.strictEqual(graph.plyCount, 1);
  assert.strictEqual(graph.tooltips[0].san, 'e4');
  assert.strictEqual(graph.tooltips[0].evalText, '+0.50');
  assert.strictEqual(graph.tooltips[0].acplDelta, 0); // first ply, no prev
});

test('buildEvalGraph: null/undefined evals handled', () => {
  const graph = buildEvalGraph(null, null);
  assert.strictEqual(graph.plyCount, 1);
});

test('buildEvalGraph: mate sentinel in series', () => {
  const evals = [0, 50, MATE_SENTINEL];
  const graph = buildEvalGraph(evals, ['e4', 'e5', 'Qh5#']);
  assert.strictEqual(graph.plyCount, 3);
  assert.strictEqual(graph.tooltips[2].evalText, 'Mate for White');
  assert.strictEqual(graph.tooltips[2].acplDelta, 0);
});

test('buildEvalGraph: click targets have ply + coordinates', () => {
  const graph = buildEvalGraph([0, 50, 100], ['e4', 'e5', 'Nf3']);
  for (const target of graph.clickTargets) {
    assert.ok(typeof target.ply === 'number');
    assert.ok(typeof target.x === 'number');
    assert.ok(typeof target.y === 'number');
    assert.ok(typeof target.radius === 'number');
  }
});

test('buildEvalGraph: points have x, y, cp, ply', () => {
  const graph = buildEvalGraph([0, 100], ['e4', 'e5']);
  assert.strictEqual(graph.points[0].ply, 0);
  assert.strictEqual(graph.points[0].cp, 0);
  assert.strictEqual(graph.points[1].ply, 1);
  assert.strictEqual(graph.points[1].cp, 100);
});

test('buildEvalGraph: custom dimensions', () => {
  const graph = buildEvalGraph([0, 50], ['e4', 'e5'], { width: 600, height: 100 });
  assert.strictEqual(graph.width, 600);
  assert.strictEqual(graph.height, 100);
});

test('buildEvalGraph: eval clamped to EVAL_CLAMP', () => {
  const graph = buildEvalGraph([5000, -5000], ['e4', 'e5']);
  // Points should be clamped — y coordinates within bounds
  assert.ok(graph.points[0].y >= 0 && graph.points[0].y <= 80);
  assert.ok(graph.points[1].y >= 0 && graph.points[1].y <= 80);
});

// --- Section 8: plyFromX (click-to-jump mapping) ---

test('plyFromX: maps x to correct ply', () => {
  // 5 plies, width 400, paddingX 10 → usable 380, step = 380/4 = 95
  // x=10 → ply 0, x=105 → ply 1, x=200 → ply 2, etc.
  assert.strictEqual(plyFromX(10, 5, 400, 10), 0);
  assert.strictEqual(plyFromX(105, 5, 400, 10), 1);
  assert.strictEqual(plyFromX(200, 5, 400, 10), 2);
  assert.strictEqual(plyFromX(390, 5, 400, 10), 4);
});

test('plyFromX: clamps to valid range', () => {
  assert.strictEqual(plyFromX(-100, 5, 400, 10), 0);
  assert.strictEqual(plyFromX(1000, 5, 400, 10), 4);
});

test('plyFromX: single ply always returns 0', () => {
  assert.strictEqual(plyFromX(200, 1, 400, 10), 0);
});

test('plyFromX: invalid inputs return 0', () => {
  assert.strictEqual(plyFromX(null, 5, 400, 10), 0);
  assert.strictEqual(plyFromX(100, 0, 400, 10), 0);
  assert.strictEqual(plyFromX(100, -1, 400, 10), 0);
});

test('plyFromX: uses defaults when width/paddingX omitted', () => {
  const ply = plyFromX(200, 5);
  assert.ok(ply >= 0 && ply <= 4);
});

// --- Section 9: Round-trip: buildEvalGraph → plyFromX ---

test('Round-trip: click target x → plyFromX returns correct ply', () => {
  const evals = [0, 50, 100, 80, 120];
  const graph = buildEvalGraph(evals, ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']);
  for (const target of graph.clickTargets) {
    const ply = plyFromX(target.x, graph.plyCount, graph.width, DEFAULT_PADDING_X());
    assert.ok(ply >= 0 && ply < graph.plyCount);
  }
});

function DEFAULT_PADDING_X() { return 10; }

// --- Section 10: Edge cases ---

test('buildEvalGraph: moves array shorter than evals', () => {
  const graph = buildEvalGraph([0, 50, 100], ['e4']);
  assert.strictEqual(graph.tooltips[0].san, 'e4');
  assert.strictEqual(graph.tooltips[1].san, null);
  assert.strictEqual(graph.tooltips[2].san, null);
});

test('buildEvalGraph: moves array longer than evals', () => {
  const graph = buildEvalGraph([0, 50], ['e4', 'e5', 'Nf3']);
  assert.strictEqual(graph.plyCount, 2);
  assert.strictEqual(graph.tooltips[1].san, 'e5');
});

test('buildTooltip: first ply has no ACPL (prevCp=null)', () => {
  const tip = buildTooltip(0, 100, 'e4', null);
  assert.strictEqual(tip.acplDelta, 0);
  assert.strictEqual(tip.acplText, 'Best');
});

test('buildEvalGraph: all-zero evals', () => {
  const graph = buildEvalGraph([0, 0, 0, 0], ['e4', 'e5', 'Nf3', 'Nf6']);
  for (const tip of graph.tooltips) {
    assert.strictEqual(tip.evalText, '0.00');
    assert.strictEqual(tip.acplDelta, 0);
  }
});

// --- Section 11: Gate-4 invariant ---

test('Gate-4: eval-graph.js contains no makeMove( calls', () => {
  const code = fs.readFileSync(path.join(__dirname, 'eval-graph.js'), 'utf8');
  assert(!code.includes('makeMove('), 'eval-graph.js must not call makeMove(');
});

test('Gate-4: eval-graph.js contains no createInitialBoard( calls', () => {
  const code = fs.readFileSync(path.join(__dirname, 'eval-graph.js'), 'utf8');
  assert(!code.includes('createInitialBoard('), 'eval-graph.js must not call createInitialBoard(');
});

test('Gate-4: eval-graph.js does not import referee-service or rules-engine', () => {
  const code = fs.readFileSync(path.join(__dirname, 'eval-graph.js'), 'utf8');
  assert(!code.includes('referee-service'), 'eval-graph.js must not import referee-service');
  assert(!code.includes('rules-engine'), 'eval-graph.js must not import rules-engine');
});

// --- Summary ---

console.log(`\n=== Interactive Eval Graph Self-Test Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
console.log('\nAll eval-graph self-tests PASSED successfully!');