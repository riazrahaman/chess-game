'use strict';

const assert = require('assert');
const { generatePostGameReport } = require('../src/game-report.js');

console.log('--- Running C6: Post-Game Report & Prose Narrative Self-Test ---');

// Test 1: Generate report for a decisive game with a turning point blunder
const mockReview = {
  whiteAccuracy: 88.5,
  blackAccuracy: 62.1,
  counts: {
    white: { brilliant: 1, best: 10, blunder: 0 },
    black: { good: 6, mistake: 1, blunder: 2 }
  },
  moves: [
    { ply: 1, move: 'e4', color: 'white', key: 'best', preCp: 20, postCp: 25 },
    { ply: 2, move: 'e5', color: 'black', key: 'best', preCp: -25, postCp: -20 },
    { ply: 3, move: 'Nf3', color: 'white', key: 'best', preCp: 20, postCp: 30 },
    { ply: 4, move: 'f6', color: 'black', key: 'blunder', preCp: -30, postCp: -350 }
  ]
};

const report1 = generatePostGameReport({
  moveHistory: ['e2e4', 'e7e5', 'g1f3', 'f7f6'],
  sanHistory: ['e4', 'e5', 'Nf3', 'f6'],
  evalHistory: [20, 25, 20, 30, 350],
  review: mockReview,
  result: '1-0',
  reason: 'checkmate'
});

assert.ok(report1.headline.includes('Decisive victory for White'), 'Headline should indicate White victory');
assert.ok(report1.headline.includes('1-0'), 'Headline should include result code');
assert.ok(report1.headline.includes('checkmate'), 'Headline should include checkmate reason');
assert.ok(report1.accSummary.includes('88.5%') && report1.accSummary.includes('62.1%'), 'Accuracy summary matches inputs');
console.log('✓ Test 1 Passed: Decisive game headline and accuracy verified');

// Test 2: Turning point detection
assert.ok(report1.turningPointNarrative.includes('f6'), 'Turning point narrative should identify blunder move f6');
assert.ok(report1.turningPointNarrative.includes('3.2 pawns'), 'Turning point swing calculated correctly');
console.log('✓ Test 2 Passed: Turning point detection identifies largest blunder correctly');

// Test 3: Tactical advice generation
assert.ok(report1.whiteAdvice.includes('solid tactical discipline'), 'White has 0 blunders advice');
assert.ok(report1.blackAdvice.includes('conceded 2 major blunder'), 'Black blunder count advice generated');
console.log('✓ Test 3 Passed: Tactical advice reflects blunder counts');

// Test 4: Annotated PGN generation with NAGs and eval comments
assert.ok(report1.annotatedPgn.includes('1. e4 $1 { [%eval +0.25] }'), 'PGN includes White best move with NAG and eval');
assert.ok(report1.annotatedPgn.includes('f6 $4 { [%eval +3.50] }'), 'PGN includes Black blunder with $4 and eval');
assert.ok(report1.annotatedPgn.endsWith('1-0'), 'PGN terminates with result code');
console.log('✓ Test 4 Passed: Annotated PGN with NAG glyphs and eval comments verified');

// Test 5: Draw with balanced play and no blunders
const mockDrawReview = {
  whiteAccuracy: 95.0,
  blackAccuracy: 94.8,
  counts: {
    white: { blunder: 0 },
    black: { blunder: 0 }
  },
  moves: []
};

const report2 = generatePostGameReport({
  moveHistory: new Array(60).fill('e4'),
  sanHistory: new Array(60).fill('e4'),
  evalHistory: new Array(61).fill(10),
  review: mockDrawReview,
  result: '1/2-1/2',
  reason: 'stalemate'
});

assert.ok(report2.headline.includes('Hard-fought draw'), 'Headline reflects draw');
assert.ok(report2.headline.includes('30 moves'), 'Calculates 30 moves for 60 plies');
assert.ok(report2.openingNarrative.includes('evenly'), 'Even opening detected');
assert.ok(report2.turningPointNarrative.includes('No dramatic singular blunders'), 'Handled game with no major turning blunders');
assert.ok(report2.endgameNarrative.includes('In the late game'), 'Detects long game late game conversion');
console.log('✓ Test 5 Passed: Draw and strategic maneuvering game verified');

console.log('=== All 5 C6 Self-Tests Passed Successfully! ===');
