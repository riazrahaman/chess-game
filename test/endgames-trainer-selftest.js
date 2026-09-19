'use strict';

/**
 * endgames-trainer-selftest.js
 *
 * Self-test suite for Endgames Trainer & Timed Challenge.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const EndgamesTrainer = require('../src/endgames-trainer.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('PASS: ' + name);
}

// 1. Categories & Drills Catalog
test('getCategories returns all canonical endgame categories', () => {
  const cats = EndgamesTrainer.getCategories();
  assert.ok(cats.includes('all'));
  assert.ok(cats.includes('pawn'));
  assert.ok(cats.includes('rook'));
  assert.ok(cats.includes('queen'));
  assert.ok(cats.includes('minor'));
});

test('getDrills returns all drills and filters by category correctly', () => {
  const all = EndgamesTrainer.getDrills();
  assert.ok(all.length >= 10);

  const rooks = EndgamesTrainer.getDrills('rook');
  assert.ok(rooks.length >= 3);
  rooks.forEach(d => assert.strictEqual(d.category, 'rook'));

  const pawns = EndgamesTrainer.getDrills('pawn');
  assert.ok(pawns.length >= 3);
  pawns.forEach(d => assert.strictEqual(d.category, 'pawn'));
});

test('getDrillById returns correct drill or null', () => {
  const lucena = EndgamesTrainer.getDrillById('rook-lucena');
  assert.ok(lucena);
  assert.strictEqual(lucena.title, 'The Lucena Position');
  assert.strictEqual(lucena.goal, 'win');

  const philidor = EndgamesTrainer.getDrillById('rook-philidor');
  assert.ok(philidor);
  assert.strictEqual(philidor.goal, 'draw');

  assert.strictEqual(EndgamesTrainer.getDrillById('nonexistent'), null);
});

// 2. Move Grading (Curated Fallback)
test('gradeEndgameMove grades curated solution moves as best', () => {
  const lucena = EndgamesTrainer.getDrillById('rook-lucena');
  const res = EndgamesTrainer.gradeEndgameMove(lucena, 'Re4');
  assert.strictEqual(res.correct, true);
  assert.strictEqual(res.grade, 'best');
  assert.ok(res.message.includes('Correct move'));
});

test('gradeEndgameMove flags non-solution moves as inaccuracy', () => {
  const lucena = EndgamesTrainer.getDrillById('rook-lucena');
  const res = EndgamesTrainer.gradeEndgameMove(lucena, 'Re1');
  assert.strictEqual(res.correct, false);
  assert.strictEqual(res.grade, 'inaccuracy');
});

// 3. Move Grading (Tablebase Ground Truth)
test('gradeEndgameMove with tablebase confirms winning preservation', () => {
  const lucena = EndgamesTrainer.getDrillById('rook-lucena'); // goal: win
  // Opponent category after player move is 'loss' -> player retains win
  const res = EndgamesTrainer.gradeEndgameMove(lucena, 'Re4', { category: 'loss' });
  assert.strictEqual(res.correct, true);
  assert.strictEqual(res.grade, 'best');
  assert.ok(res.message.includes('maintains the theoretical win'));
});

test('gradeEndgameMove with tablebase detects blunder dropping win to draw', () => {
  const lucena = EndgamesTrainer.getDrillById('rook-lucena'); // goal: win
  const res = EndgamesTrainer.gradeEndgameMove(lucena, 'Re8', { category: 'draw' });
  assert.strictEqual(res.correct, false);
  assert.strictEqual(res.grade, 'blunder');
  assert.ok(res.message.includes('dropped from a theoretical win to a draw'));
});

test('gradeEndgameMove with tablebase confirms draw preservation in defense drill', () => {
  const philidor = EndgamesTrainer.getDrillById('rook-philidor'); // goal: draw
  const res = EndgamesTrainer.gradeEndgameMove(philidor, 'Ra6', { category: 'draw' });
  assert.strictEqual(res.correct, true);
  assert.strictEqual(res.grade, 'best');
  assert.ok(res.message.includes('theoretical draw is preserved'));
});

test('gradeEndgameMove with tablebase detects blunder allowing opponent win', () => {
  const philidor = EndgamesTrainer.getDrillById('rook-philidor'); // goal: draw
  const res = EndgamesTrainer.gradeEndgameMove(philidor, 'Ra8', { category: 'win' }); // opponent wins
  assert.strictEqual(res.correct, false);
  assert.strictEqual(res.grade, 'blunder');
  assert.ok(res.message.includes('allows the opponent to win'));
});

// 4. Timed Challenge Mode
test('createChallenge initializes challenge state properly', () => {
  const ch = EndgamesTrainer.createChallenge({ category: 'rook', timeLimitSeconds: 60 });
  assert.strictEqual(ch.category, 'rook');
  assert.strictEqual(ch.timeLimitSeconds, 60);
  assert.strictEqual(ch.score, 0);
  assert.strictEqual(ch.completedDrills, 0);
  assert.strictEqual(ch.isFinished, false);
  assert.ok(ch.drills.length >= 3);
});

test('submitChallengeStep awards points and updates challenge progression', () => {
  const ch = EndgamesTrainer.createChallenge({ category: 'rook', now: 1000 });
  const firstDrill = ch.drills[0];

  // Submit correct move under 2 seconds (timeSpentMs = 2000)
  const step = EndgamesTrainer.submitChallengeStep(ch, firstDrill.id, 'Re4', 2000, 3000);
  assert.strictEqual(step.correct, true);
  assert.ok(step.pointsAwarded > 100); // 100 base + speed bonus
  assert.strictEqual(ch.completedDrills, 1);
  assert.strictEqual(ch.currentIndex, 1);
});

test('submitChallengeStep applies penalty on incorrect move', () => {
  const ch = EndgamesTrainer.createChallenge({ category: 'rook', now: 1000 });
  ch.score = 200;
  const firstDrill = ch.drills[0];

  const step = EndgamesTrainer.submitChallengeStep(ch, firstDrill.id, 'Ka7', 3000, 4000);
  assert.strictEqual(step.correct, false);
  assert.strictEqual(ch.score, 175); // 25 pt penalty
});

// 5. Leaderboard
test('recordLeaderboardEntry stores and sorts high scores', () => {
  EndgamesTrainer.recordLeaderboardEntry({ playerName: 'Alice', score: 350, category: 'rook' });
  EndgamesTrainer.recordLeaderboardEntry({ playerName: 'Bob', score: 520, category: 'rook' });
  EndgamesTrainer.recordLeaderboardEntry({ playerName: 'Charlie', score: 410, category: 'pawn' });

  const lbRook = EndgamesTrainer.getLeaderboard('rook');
  assert.strictEqual(lbRook[0].playerName, 'Bob');
  assert.strictEqual(lbRook[0].score, 520);
  assert.strictEqual(lbRook[1].playerName, 'Alice');

  const lbAll = EndgamesTrainer.getLeaderboard('all');
  assert.ok(lbAll.length >= 3);
});

// 6. Gate 4 Invariant
test('Gate 4 Invariant: src/endgames-trainer.js has 0 makeMove/createInitialBoard calls', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/endgames-trainer.js'), 'utf8');
  assert.strictEqual(src.includes('makeMove('), false, 'Forbidden makeMove() call found');
  assert.strictEqual(src.includes('createInitialBoard('), false, 'Forbidden createInitialBoard() call found');
});

console.log(`\nAll ${passed} tests passed successfully!`);
