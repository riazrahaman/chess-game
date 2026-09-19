#!/usr/bin/env node
'use strict';

/**
 * p5-retry-selftest.js
 * Verification suite for P5: Retry-before-reveal pedagogy.
 * Enforces:
 * 1. Solution withholding until user commits an attempt across mistake puzzles & analysis retry.
 * 2. On-demand voluntary reveal available only AFTER an attempt is committed.
 * 3. Gate 4 invariant: 0 occurrences of literal makeMove( and createInitialBoard(.
 * 4. DOM element uniqueness and presence of #puzzle-reveal-btn.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const uiSrc = fs.readFileSync(path.join(ROOT, 'src', 'ui.js'), 'utf8');
const analysisSrc = fs.readFileSync(path.join(ROOT, 'src', 'ui-analysis.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const curriculum = require('../src/practice-curriculum.js');

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

console.log('=== P5 Retry-Before-Reveal Pedagogy Selftest ===');

// 1. Gate 4 Invariant
test('Gate 4 Invariant: ui.js and ui-analysis.js contain zero makeMove/createInitialBoard', () => {
  for (const [file, content] of [['ui.js', uiSrc], ['ui-analysis.js', analysisSrc]]) {
    assert.ok(!content.includes('makeMove('), `Gate 4 violation: ${file} contains makeMove(`);
    assert.ok(!content.includes('createInitialBoard('), `Gate 4 violation: ${file} contains createInitialBoard(`);
  }
});

// 2. DOM elements
test('index.html contains #puzzle-reveal-btn inside #puzzle-box with hidden class', () => {
  assert.ok(htmlSrc.includes('id="puzzle-reveal-btn"'), 'index.html has #puzzle-reveal-btn');
  const boxMatch = htmlSrc.match(/<div id="puzzle-box"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<div id="why-explanation/);
  assert.ok(boxMatch, 'found puzzle-box block');
  const boxHtml = boxMatch[1];
  assert.ok(boxHtml.includes('id="puzzle-reveal-btn"') && boxHtml.includes('class="hidden"'), 'puzzle-reveal-btn is inside puzzle-box and initially hidden');
});

test('No duplicate IDs in index.html for puzzle controls', () => {
  const ids = ['retry-mistakes-section', 'retry-mistakes-btn', 'puzzle-box', 'puzzle-header', 'puzzle-instruction', 'puzzle-feedback', 'puzzle-hint-btn', 'puzzle-reveal-btn', 'puzzle-next-btn', 'puzzle-exit-btn'];
  for (const id of ids) {
    const count = (htmlSrc.match(new RegExp(`id="${id}"`, 'g')) || []).length;
    assert.strictEqual(count, 1, `Element id #${id} must appear exactly once, got ${count}`);
  }
});

// 3. UI logic in ui.js
test('ui.js manages attempts, reveal state, and unlocks revealBtn on wrong attempt', () => {
  assert.ok(uiSrc.includes('puzzleAttempts++;'), 'increments puzzleAttempts on each move attempt');
  assert.ok(uiSrc.includes('revealBtn.classList.remove(\'hidden\');'), 'unlocks revealBtn on failed attempt');
  assert.ok(uiSrc.includes('revealBtn.classList.add(\'hidden\');'), 'hides revealBtn on solve or initial load');
  assert.ok(uiSrc.includes('Please make at least one attempt before revealing'), 'guards revealBtn click before attempt');
});

test('ui.js exports P5 state getters on window', () => {
  assert.ok(uiSrc.includes('window.getPuzzleAttempts = () => puzzleAttempts;'), 'exports getPuzzleAttempts');
  assert.ok(uiSrc.includes('window.isPuzzleRevealed = () => puzzleRevealed;'), 'exports isPuzzleRevealed');
  assert.ok(uiSrc.includes('window.isPuzzleSolved = () => puzzleSolved;'), 'exports isPuzzleSolved');
});

// 4. UI-analysis.js retry pedagogy
test('ui-analysis.js withholds missed-reveal button until attempts > 0', () => {
  assert.ok(analysisSrc.includes('retry.attempts > 0 ? \'<button type="button" data-an="missed-reveal">Reveal best move</button>\' : \'\''), 'reveal button only rendered after attempts > 0');
  assert.ok(analysisSrc.includes('if (state.retry.attempts === 0)'), 'revealRetry guards against revealing without attempts');
});

// 5. Practice curriculum P5 verification
test('practice-curriculum verifies retry-before-reveal contract', () => {
  const lesson = curriculum.getLessonById('mate-back-rank');
  assert.ok(lesson, 'lesson exists');

  // Wrong move attempt without reveal flag
  const wrongAttempt = curriculum.verifyPracticeMove(lesson, 0, 'a2a3');
  assert.strictEqual(wrongAttempt.correct, false, 'marked incorrect');
  assert.strictEqual(wrongAttempt.retry, true, 'prompts retry');
  assert.strictEqual(wrongAttempt.revealedSolution, undefined, 'withholds solution');

  // Requesting reveal explicitly
  const revealAttempt = curriculum.verifyPracticeMove(lesson, 0, 'a2a3', { reveal: true });
  assert.strictEqual(revealAttempt.correct, false);
  assert.strictEqual(revealAttempt.revealedSolution, 'Qe8#', 'reveals solution when requested');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
