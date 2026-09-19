'use strict';

/**
 * maia-bot-selftest.js
 *
 * Self-test suite for Maia rating-matched human-like bots & casual AI modes.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const MaiaBot = require('../src/maia-bot.js');
const { BotService } = require('../src/bot-service.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('PASS: ' + name);
}

// 1. Maia Tiers
test('getMaiaTier returns configured tiers for 1100, 1500, 1900', () => {
  const t1100 = MaiaBot.getMaiaTier(1100);
  assert.strictEqual(t1100.rating, 1100);
  assert.strictEqual(t1100.name, 'Maia 1100');
  assert.ok(t1100.temperature > 1.0); // higher temperature = noisier/beginner

  const t1500 = MaiaBot.getMaiaTier(1500);
  assert.strictEqual(t1500.rating, 1500);
  assert.strictEqual(t1500.name, 'Maia 1500');

  const t1900 = MaiaBot.getMaiaTier(1900);
  assert.strictEqual(t1900.rating, 1900);
  assert.strictEqual(t1900.name, 'Maia 1900');
  assert.ok(t1900.temperature < 0.8); // sharper/master
});

// 2. Move Probability Distributions
test('computeMoveProbabilities generates normalized probabilities summing to 1.0', () => {
  const legalMoves = ['e4', 'd4', 'Nf3', 'c4', 'g3', 'a3', 'h3'];
  const probs = MaiaBot.computeMoveProbabilities(legalMoves, 1500);

  assert.strictEqual(probs.length, legalMoves.length);
  const sum = probs.reduce((acc, p) => acc + p.probability, 0);
  assert.ok(Math.abs(sum - 1.0) < 0.001, 'Probabilities must sum to 1.0');

  // e4/d4/Nf3 should have higher human probability than a3/h3
  const e4 = probs.find(p => p.move === 'e4');
  const h3 = probs.find(p => p.move === 'h3');
  assert.ok(e4.probability > h3.probability, 'Center moves should be favored over wing pawn pushes');
});

// 3. Move Selection & Determinism
test('selectMaiaMove picks candidate moves with realistic think times', () => {
  const legalMoves = ['e4', 'd4', 'c4', 'Nf3'];
  const pick = MaiaBot.selectMaiaMove(legalMoves, 1500, 42);

  assert.ok(legalMoves.includes(pick.move));
  assert.strictEqual(pick.rating, 1500);
  assert.ok(pick.thinkTimeMs >= 400);

  // Determinism check with same seed
  const pick2 = MaiaBot.selectMaiaMove(legalMoves, 1500, 42);
  assert.strictEqual(pick.move, pick2.move);
});

// 4. Bot or Not (Turing Test Mode)
test('evaluateMoveHumanity scores common human moves higher than unnatural moves', () => {
  const legalMoves = ['e4', 'd4', 'Nf3', 'c4', 'h4', 'Na3'];
  const humanMove = MaiaBot.evaluateMoveHumanity('e4', legalMoves, 1500);
  const engineMove = MaiaBot.evaluateMoveHumanity('Na3', legalMoves, 1500);

  assert.ok(humanMove.humanLikenessScore > engineMove.humanLikenessScore);
  assert.strictEqual(humanMove.verdict, 'human-like');
  assert.ok(humanMove.explanation.includes('1500'));
});

// 5. Hand-and-Brain Mode
test('selectBrainPieceType chooses legal piece type', () => {
  const legalMoves = ['e4', 'd4', 'Nf3', 'Nc3'];
  const pt = MaiaBot.selectBrainPieceType(legalMoves, 1500, 99);
  assert.ok(['Pawn', 'Knight'].includes(pt));
});

test('filterMovesByPieceType filters candidate moves by piece type', () => {
  const legalMoves = ['e4', 'd4', 'Nf3', 'Nc3', 'Bc4', 'Qe2'];
  const knightMoves = MaiaBot.filterMovesByPieceType(legalMoves, 'Knight');
  assert.deepStrictEqual(knightMoves, ['Nf3', 'Nc3']);

  const pawnMoves = MaiaBot.filterMovesByPieceType(legalMoves, 'Pawn');
  assert.deepStrictEqual(pawnMoves, ['e4', 'd4']);
});

// 6. Bot Service Integration
test('BotService has registered Maia 1100, 1500, and 1900 bot levels', () => {
  const { BOT_LEVELS } = require('../src/bot-service.js');
  const m1100 = BOT_LEVELS['maia-1100'];
  assert.ok(m1100);
  assert.strictEqual(m1100.rating, 1100);
  assert.strictEqual(m1100.isMaia, true);

  const m1500 = BOT_LEVELS['maia-1500'];
  assert.ok(m1500);
  assert.strictEqual(m1500.rating, 1500);

  const m1900 = BOT_LEVELS['maia-1900'];
  assert.ok(m1900);
  assert.strictEqual(m1900.rating, 1900);
});

// 7. Gate 4 Invariant
test('Gate 4 Invariant: src/maia-bot.js has 0 makeMove/createInitialBoard calls', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/maia-bot.js'), 'utf8');
  assert.strictEqual(src.includes('makeMove('), false, 'Forbidden makeMove() call found');
  assert.strictEqual(src.includes('createInitialBoard('), false, 'Forbidden createInitialBoard() call found');
});

console.log(`\nAll ${passed} tests passed successfully!`);
