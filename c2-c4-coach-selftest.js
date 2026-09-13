/**
 * c2-c4-coach-selftest.js
 * Verification suite for C2 ("Why?" Move Explanations) & C4 (Coach Mode Hints).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const aiCoach = require('./ai-coach.js');

function runTests() {
  console.log('=== Starting c2-c4-coach-selftest.js ===');

  // Test 1: Gate 4 Invariant: ui.js contains 0 literal makeMove( or createInitialBoard(
  const uiContent = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');
  assert(!uiContent.includes('makeMove('), 'Gate 4 violation: ui.js contains literal makeMove(');
  assert(!uiContent.includes('createInitialBoard('), 'Gate 4 violation: ui.js contains literal createInitialBoard(');
  console.log('✔ Passed: Gate 4 invariants verified in ui.js');

  // Test 2: UI elements existence in index.html
  const htmlContent = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert(htmlContent.includes('id="why-explanation-section"'), 'index.html contains #why-explanation-section');
  assert(htmlContent.includes('id="why-move-btn"'), 'index.html contains #why-move-btn');
  assert(htmlContent.includes('id="why-explanation-card"'), 'index.html contains #why-explanation-card');
  assert(htmlContent.includes('id="why-title"'), 'index.html contains #why-title');
  assert(htmlContent.includes('id="why-body"'), 'index.html contains #why-body');
  assert(htmlContent.includes('id="coach-hint-btn"'), 'index.html contains #coach-hint-btn');
  assert(htmlContent.includes('id="coach-hint-banner"'), 'index.html contains #coach-hint-banner');
  assert(htmlContent.includes('id="coach-hint-text"'), 'index.html contains #coach-hint-text');
  assert(htmlContent.includes('id="close-coach-hint"'), 'index.html contains #close-coach-hint');
  console.log('✔ Passed: All Coach and Why? UI elements exist in index.html');

  // Test 3: aiCoach exports functions
  assert.strictEqual(typeof aiCoach.explainMove, 'function');
  assert.strictEqual(typeof aiCoach.getCoachHint, 'function');
  console.log('✔ Passed: aiCoach.explainMove and getCoachHint exported');

  // Test 4: explainMove produces accurate natural-language narratives
  const blunderExp = aiCoach.explainMove({
    move: 'f7f6',
    color: 'black',
    key: 'blunder',
    preCp: 20,
    postCp: 450,
    bestMove: 'b8c6'
  });
  assert.strictEqual(blunderExp.classification, 'blunder');
  assert(blunderExp.explanation.includes('Blunder (??)'));
  assert(blunderExp.explanation.includes('b8c6'));
  console.log(`✔ Passed: Blunder explanation generated: "${blunderExp.explanation}"`);

  const bestExp = aiCoach.explainMove({
    move: 'e2e4',
    color: 'white',
    key: 'best',
    preCp: 0,
    postCp: 30,
    bestMove: 'e2e4'
  });
  assert.strictEqual(bestExp.classification, 'best');
  assert(bestExp.explanation.includes('Best move (★)'));
  console.log(`✔ Passed: Best move explanation generated: "${bestExp.explanation}"`);

  // Test 5: getCoachHint generates progressive multi-tier advice
  const hint = aiCoach.getCoachHint({
    turn: 'white',
    bestMove: 'g1f3',
    evalCp: 25,
    ply: 2
  });
  assert(hint.generalPrinciple.includes('Opening Principle'));
  assert(hint.pieceHint.includes('g1'));
  assert(hint.moveHint.includes('g1 to f3'));
  console.log(`✔ Passed: Coach hint produced strategic, piece, and move guidance`);

  // Test 6: ui.js exports coach hooks on window
  assert(uiContent.includes('window.explainCurrentlyViewedMove = explainCurrentlyViewedMove;'));
  assert(uiContent.includes('window.showCoachHint = showCoachHint;'));
  assert(uiContent.includes('window.setupAiCoachUI = setupAiCoachUI;'));
  console.log('✔ Passed: Frontend ui.js coach hooks exported on window');

  console.log('\nAll 6 tests passed successfully!');
  process.exit(0);
}

runTests();
