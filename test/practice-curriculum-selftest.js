'use strict';

/**
 * practice-curriculum-selftest.js
 *
 * Self-test suite for Practice Curriculum & Retry-Before-Reveal Pedagogy.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const PracticeCurriculum = require('../src/practice-curriculum.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('PASS: ' + name);
}

// 1. Tracks & Catalog
test('getTracks returns all canonical curriculum tracks', () => {
  const tracks = PracticeCurriculum.getTracks();
  assert.strictEqual(tracks.length, 4);
  const ids = tracks.map(t => t.id);
  assert.ok(ids.includes('checkmates'));
  assert.ok(ids.includes('fundamental_tactics'));
  assert.ok(ids.includes('advanced_tactics'));
  assert.ok(ids.includes('essential_endgames'));
});

test('getLessons returns all lessons and filters by track accurately', () => {
  const all = PracticeCurriculum.getLessons();
  assert.ok(all.length >= 10);

  const mates = PracticeCurriculum.getLessons('checkmates');
  assert.ok(mates.length >= 3);
  mates.forEach(l => assert.strictEqual(l.track, 'checkmates'));

  const tactics = PracticeCurriculum.getLessons('fundamental_tactics');
  assert.ok(tactics.length >= 3);
  tactics.forEach(l => assert.strictEqual(l.track, 'fundamental_tactics'));
});

test('getLessonById finds lesson by unique ID or returns null', () => {
  const backRank = PracticeCurriculum.getLessonById('mate-back-rank');
  assert.ok(backRank);
  assert.strictEqual(backRank.title, 'Back-Rank Mate');
  assert.strictEqual(backRank.track, 'checkmates');

  const fork = PracticeCurriculum.getLessonById('tactic-fork-knight');
  assert.ok(fork);
  assert.strictEqual(fork.title, 'The Knight Fork');

  assert.strictEqual(PracticeCurriculum.getLessonById('nonexistent'), null);
});

// 2. Retry-Before-Reveal Pedagogy (P5)
test('verifyPracticeMove marks correct move and completes single-step lesson', () => {
  const lesson = PracticeCurriculum.getLessonById('mate-back-rank'); // expected: 'Qe8#'
  const res = PracticeCurriculum.verifyPracticeMove(lesson, 0, 'Qe8#');
  assert.strictEqual(res.correct, true);
  assert.strictEqual(res.isCompleted, true);
  assert.strictEqual(res.stepIndex, 1);
  assert.strictEqual(res.retry, false);
  assert.ok(res.message.includes('Well done'));
});

test('verifyPracticeMove matches moves regardless of check/mate annotations', () => {
  const lesson = PracticeCurriculum.getLessonById('mate-back-rank'); // expected: 'Qe8#'
  const res = PracticeCurriculum.verifyPracticeMove(lesson, 0, 'Qe8'); // without #
  assert.strictEqual(res.correct, true);
  assert.strictEqual(res.isCompleted, true);
});

test('verifyPracticeMove withholds solution on error by default (P5 Retry-Before-Reveal)', () => {
  const lesson = PracticeCurriculum.getLessonById('mate-back-rank');
  const res = PracticeCurriculum.verifyPracticeMove(lesson, 0, 'Qd1'); // wrong move
  assert.strictEqual(res.correct, false);
  assert.strictEqual(res.isCompleted, false);
  assert.strictEqual(res.retry, true);
  assert.strictEqual(res.revealedSolution, undefined, 'Solution must be hidden on retry attempt');
  assert.ok(res.message.includes('Try again'));
  assert.strictEqual(res.hint, lesson.hint);
});

test('verifyPracticeMove reveals solution when reveal flag is explicitly requested', () => {
  const lesson = PracticeCurriculum.getLessonById('mate-back-rank');
  const res = PracticeCurriculum.verifyPracticeMove(lesson, 0, 'Qd1', { reveal: true });
  assert.strictEqual(res.correct, false);
  assert.strictEqual(res.retry, true);
  assert.strictEqual(res.revealedSolution, 'Qe8#');
  assert.ok(res.message.includes('The correct move is Qe8#'));
});

// 3. Curriculum Progress
test('calculateCurriculumProgress computes track and overall percentages accurately', () => {
  const completed = ['mate-back-rank', 'mate-smothered', 'tactic-fork-knight'];
  const progress = PracticeCurriculum.calculateCurriculumProgress(completed);

  assert.strictEqual(progress.totalCompleted, 3);
  assert.ok(progress.overallPct > 0);
  assert.strictEqual(progress.byTrack.checkmates.completed, 2);
  assert.strictEqual(progress.byTrack.fundamental_tactics.completed, 1);
  assert.strictEqual(progress.byTrack.advanced_tactics.completed, 0);
});

// 4. Gate 4 Invariant
test('Gate 4 Invariant: src/practice-curriculum.js has 0 makeMove/createInitialBoard calls', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/practice-curriculum.js'), 'utf8');
  assert.strictEqual(src.includes('makeMove('), false, 'Forbidden makeMove() call found');
  assert.strictEqual(src.includes('createInitialBoard('), false, 'Forbidden createInitialBoard() call found');
});

console.log(`\nAll ${passed} tests passed successfully!`);
