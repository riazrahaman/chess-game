'use strict';

/**
 * repertoire-trainer-selftest.js
 *
 * Self-test suite for the Opening Repertoire Trainer & MoveTrainer SRS.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const RepertoireTrainer = require('../src/repertoire-trainer.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('PASS: ' + name);
}

// 1. SRS Schedule Calculations
test('computeNextSrs calculates Chessable ladder correctly on success', () => {
  const now = 1000000000000;
  // Step 0 -> Step 1 (24h)
  const r1 = RepertoireTrainer.computeNextSrs(0, true, now);
  assert.strictEqual(r1.step, 1);
  assert.strictEqual(r1.intervalHours, 24);
  assert.strictEqual(r1.nextDueAt, now + 24 * 3600 * 1000);

  // Step 1 -> Step 2 (72h / 3d)
  const r2 = RepertoireTrainer.computeNextSrs(1, true, now);
  assert.strictEqual(r2.step, 2);
  assert.strictEqual(r2.intervalHours, 72);

  // Step 7 (last) stays at max interval
  const r8 = RepertoireTrainer.computeNextSrs(7, true, now);
  assert.strictEqual(r8.step, 7);
  assert.strictEqual(r8.intervalHours, 4320);
});

test('computeNextSrs resets to step 0 (4h) on incorrect review', () => {
  const now = 1000000000000;
  const r = RepertoireTrainer.computeNextSrs(5, false, now);
  assert.strictEqual(r.step, 0);
  assert.strictEqual(r.intervalHours, 4);
  assert.strictEqual(r.nextDueAt, now + 4 * 3600 * 1000);
});

// 2. Repertoire Creation & Card Generation
test('createRepertoire initializes correct white and black defaults', () => {
  const repW = RepertoireTrainer.createRepertoire({ color: 'white' });
  assert.strictEqual(repW.color, 'white');
  assert.strictEqual(repW.cards.size, 0);

  const repB = RepertoireTrainer.createRepertoire({ color: 'black' });
  assert.strictEqual(repB.color, 'black');
});

test('addLine creates cards for player moves only (White repertoire)', () => {
  const rep = RepertoireTrainer.createRepertoire({ color: 'white' });
  // e4 (ply 0, White) e5 (ply 1, Black) Nf3 (ply 2, White) Nc6 (ply 3, Black) Bc4 (ply 4, White)
  const cardsCreated = RepertoireTrainer.addLine(rep, ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']);
  assert.strictEqual(cardsCreated, 3); // plies 0, 2, 4
  assert.strictEqual(rep.cards.size, 3);

  // Check card properties
  const due = RepertoireTrainer.getDueCards(rep);
  assert.strictEqual(due.length, 3);
  assert.strictEqual(due[0].expectedMove, 'e4');
  assert.strictEqual(due[0].ply, 0);
  assert.strictEqual(due[1].expectedMove, 'Nf3');
  assert.strictEqual(due[1].ply, 2);
  assert.strictEqual(due[2].expectedMove, 'Bc4');
  assert.strictEqual(due[2].ply, 4);
});

test('addLine creates cards for Black repertoire correctly', () => {
  const rep = RepertoireTrainer.createRepertoire({ color: 'black' });
  // d4 (ply 0, White) Nf6 (ply 1, Black) c4 (ply 2, White) e6 (ply 3, Black)
  const count = RepertoireTrainer.addLine(rep, 'd4 Nf6 c4 e6');
  assert.strictEqual(count, 2); // plies 1 and 3
  const due = RepertoireTrainer.getDueCards(rep);
  assert.strictEqual(due[0].expectedMove, 'Nf6');
  assert.strictEqual(due[1].expectedMove, 'e6');
});

// 3. Move Review Loop
test('reviewCard updates card progress and advances SRS on correct move', () => {
  const rep = RepertoireTrainer.createRepertoire({ color: 'white' });
  RepertoireTrainer.addLine(rep, 'e4 e5');
  const card = Array.from(rep.cards.values())[0];

  const now = 1000000000;
  const res = RepertoireTrainer.reviewCard(rep, card.id, 'e4', now);
  assert.strictEqual(res.correct, true);
  assert.strictEqual(card.reviewCount, 1);
  assert.strictEqual(card.correctCount, 1);
  assert.strictEqual(card.streak, 1);
  assert.strictEqual(card.srsStep, 1);
  assert.strictEqual(card.intervalHours, 24);
  assert.strictEqual(card.nextDueAt, now + 24 * 3600 * 1000);
});

test('reviewCard resets streak and SRS step on wrong move', () => {
  const rep = RepertoireTrainer.createRepertoire({ color: 'white' });
  RepertoireTrainer.addLine(rep, 'e4 e5');
  const card = Array.from(rep.cards.values())[0];
  card.srsStep = 3;
  card.streak = 5;

  const now = 1000000000;
  const res = RepertoireTrainer.reviewCard(rep, card.id, 'd4', now); // expected e4
  assert.strictEqual(res.correct, false);
  assert.strictEqual(card.streak, 0);
  assert.strictEqual(card.srsStep, 0);
  assert.strictEqual(card.intervalHours, 4);
});

// 4. Opponent Responses
test('getOpponentContinuation returns opponent responses along tree', () => {
  const rep = RepertoireTrainer.createRepertoire({ color: 'white' });
  RepertoireTrainer.addLine(rep, 'e4 e5 Nf3 Nc6 Bc4');
  RepertoireTrainer.addLine(rep, 'e4 c5 Nf3 d6 d4');

  assert.strictEqual(RepertoireTrainer.getOpponentContinuation(rep, ['e4']), 'e5');
  assert.strictEqual(RepertoireTrainer.getOpponentContinuation(rep, ['e4', 'e5', 'Nf3']), 'Nc6');
  assert.strictEqual(RepertoireTrainer.getOpponentContinuation(rep, ['e4', 'c5', 'Nf3']), 'd6');
  assert.strictEqual(RepertoireTrainer.getOpponentContinuation(rep, ['d4']), null); // off book
});

// 5. Post-Game Deviation Detection
test('detectDeviation identifies when player followed repertoire completely', () => {
  const rep = RepertoireTrainer.createRepertoire({ color: 'white' });
  RepertoireTrainer.addLine(rep, 'e4 e5 Nf3 Nc6 Bc4 Bc5');

  const result = RepertoireTrainer.detectDeviation(rep, ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']);
  assert.strictEqual(result.deviated, false);
  assert.strictEqual(result.inRepertoireToPly, 6);
});

test('detectDeviation flags player deviation with move number and expected move', () => {
  const rep = RepertoireTrainer.createRepertoire({ color: 'white' });
  RepertoireTrainer.addLine(rep, 'e4 c5 Nf3 d6 d4 cxd4 Nxd4');

  // Player plays 2. c3 instead of 2. Nf3 (ply 2, move 2)
  const result = RepertoireTrainer.detectDeviation(rep, ['e4', 'c5', 'c3']);
  assert.strictEqual(result.deviated, true);
  assert.strictEqual(result.deviatedByPlayer, true);
  assert.strictEqual(result.ply, 2);
  assert.strictEqual(result.moveNumber, 2);
  assert.strictEqual(result.played, 'c3');
  assert.deepStrictEqual(result.expected, ['Nf3']);
  assert.ok(result.message.includes('deviated'));
});

test('detectDeviation flags opponent deviation correctly', () => {
  const rep = RepertoireTrainer.createRepertoire({ color: 'white' });
  RepertoireTrainer.addLine(rep, 'e4 e5 Nf3 Nc6');

  // Opponent plays 1... e6 (French) instead of 1... e5 (ply 1, move 1)
  const result = RepertoireTrainer.detectDeviation(rep, ['e4', 'e6']);
  assert.strictEqual(result.deviated, true);
  assert.strictEqual(result.deviatedByPlayer, false);
  assert.strictEqual(result.ply, 1);
  assert.strictEqual(result.moveNumber, 1);
  assert.strictEqual(result.played, 'e6');
  assert.deepStrictEqual(result.expected, ['e5']);
});

// 6. Statistics & Serialization
test('getRepertoireStats computes accurate summaries', () => {
  const rep = RepertoireTrainer.createRepertoire({ color: 'white' });
  RepertoireTrainer.addLine(rep, 'e4 e5 Nf3 Nc6');
  const now = 1000;
  const cards = Array.from(rep.cards.values());

  // Review first card correctly
  RepertoireTrainer.reviewCard(rep, cards[0].id, 'e4', now);

  const stats = RepertoireTrainer.getRepertoireStats(rep, now);
  assert.strictEqual(stats.totalCards, 2);
  assert.strictEqual(stats.dueCount, 1); // cards[1] is still due
  assert.strictEqual(stats.totalReviews, 1);
  assert.strictEqual(stats.accuracyPct, 100);
});

test('toJSON and fromJSON preserve full repertoire structure', () => {
  const rep = RepertoireTrainer.createRepertoire({ id: 'rep_italian', name: 'Italian Game', color: 'white' });
  RepertoireTrainer.addLine(rep, 'e4 e5 Nf3 Nc6 Bc4');

  const json = RepertoireTrainer.toJSON(rep);
  const restored = RepertoireTrainer.fromJSON(json);

  assert.strictEqual(restored.id, 'rep_italian');
  assert.strictEqual(restored.name, 'Italian Game');
  assert.strictEqual(restored.color, 'white');
  assert.strictEqual(restored.cards.size, 3);
  assert.strictEqual(restored.root.children[0].move, 'e4');
});

// 7. Gate 4 Invariant
test('Gate 4 Invariant: src/repertoire-trainer.js has 0 makeMove/createInitialBoard calls', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/repertoire-trainer.js'), 'utf8');
  assert.strictEqual(src.includes('makeMove('), false, 'Forbidden makeMove() call found');
  assert.strictEqual(src.includes('createInitialBoard('), false, 'Forbidden createInitialBoard() call found');
});

console.log(`\nAll ${passed} tests passed successfully!`);
