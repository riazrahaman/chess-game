/**
 * c7-ai-puzzles-selftest.js
 * Verification suite for C7: Retry Your Mistakes / Blunder Puzzle Generator
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const moveReview = require('../src/move-review.js');
const stockfishWorker = require('../src/stockfish-worker.js');

function runTests() {
  console.log('=== Starting c7-ai-puzzles-selftest.js ===');

  // Test 1: Gate 4 Invariant: ui.js contains 0 literal makeMove( or createInitialBoard(
  const uiContent = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui.js'), 'utf8');
  assert(!uiContent.includes('makeMove('), 'Gate 4 violation: ui.js contains literal makeMove(');
  assert(!uiContent.includes('createInitialBoard('), 'Gate 4 violation: ui.js contains literal createInitialBoard(');
  console.log('✔ Passed: Gate 4 invariants verified in ui.js');

  // Test 2: UI elements existence in index.html
  const htmlContent = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert(htmlContent.includes('id="retry-mistakes-section"'), 'index.html contains #retry-mistakes-section');
  assert(htmlContent.includes('id="retry-mistakes-btn"'), 'index.html contains #retry-mistakes-btn');
  assert(htmlContent.includes('id="puzzle-box"'), 'index.html contains #puzzle-box');
  assert(htmlContent.includes('id="puzzle-header"'), 'index.html contains #puzzle-header');
  assert(htmlContent.includes('id="puzzle-instruction"'), 'index.html contains #puzzle-instruction');
  assert(htmlContent.includes('id="puzzle-feedback"'), 'index.html contains #puzzle-feedback');
  assert(htmlContent.includes('id="puzzle-hint-btn"'), 'index.html contains #puzzle-hint-btn');
  assert(htmlContent.includes('id="puzzle-next-btn"'), 'index.html contains #puzzle-next-btn');
  assert(htmlContent.includes('id="puzzle-exit-btn"'), 'index.html contains #puzzle-exit-btn');
  console.log('✔ Passed: All puzzle UI elements exist in index.html');

  // Test 3: generateMistakePuzzles function exported
  assert.strictEqual(typeof moveReview.generateMistakePuzzles, 'function');
  console.log('✔ Passed: moveReview.generateMistakePuzzles is exported');

  // Test 4: Game with no mistakes returns 0 puzzles
  const cleanMoves = ['e2e4', 'e7e5', 'g1f3', 'b8c6'];
  const cleanEvals = [0, 20, -15, 30, 25];
  const cleanPuzzles = moveReview.generateMistakePuzzles(cleanMoves, cleanEvals);
  assert.strictEqual(cleanPuzzles.length, 0, 'Clean game returns 0 mistake puzzles');
  console.log('✔ Passed: Clean game correctly generates 0 puzzles');

  // Test 5: Game with blunders generates interactive puzzles
  // Move 3 (Black plays a massive blunder dropping from +30 to +600)
  const blunderMoves = ['e2e4', 'e7e5', 'g1f3', 'f7f6', 'f3e5'];
  const blunderEvals = [0, 20, -10, 30, 650, 680];
  const fens = [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
    'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2',
    'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
    'rnbqkbnr/ppppp1pp/5p2/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3'
  ];

  const puzzles = moveReview.generateMistakePuzzles(blunderMoves, blunderEvals, fens);
  assert(puzzles.length >= 1, 'At least 1 blunder puzzle generated');

  const p1 = puzzles[0];
  assert.strictEqual(p1.ply, 4, 'Mistake occurred at ply 4 (Black move f7f6)');
  assert.strictEqual(p1.color, 'black');
  assert.strictEqual(p1.playedMove, 'f7f6');
  assert.strictEqual(p1.key, 'blunder');
  assert(p1.bestMove, 'Best move calculated');
  assert(typeof p1.bestMove === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(p1.bestMove), 'Best move is legal UCI move format');
  console.log(`✔ Passed: Blunder puzzle generated at ply ${p1.ply}: ${p1.playedMove} (best move: ${p1.bestMove})`);

  // Test 6: Frontend ui.js exports puzzle methods on window
  assert(uiContent.includes('window.startMistakePuzzles = startMistakePuzzles;'), 'ui.js exports startMistakePuzzles');
  assert(uiContent.includes('window.setupMistakePuzzlesUI = setupMistakePuzzlesUI;'), 'ui.js exports setupMistakePuzzlesUI');
  assert(uiContent.includes('window.getActiveMistakePuzzles = () => activeMistakePuzzles;'), 'ui.js exports getActiveMistakePuzzles');
  assert(uiContent.includes('window.isPuzzleModeActive = () => puzzleModeActive;'), 'ui.js exports isPuzzleModeActive');
  console.log('✔ Passed: Frontend ui.js puzzle hooks exported on window');

  console.log('\nAll 6 tests passed successfully!');
  process.exit(0);
}

runTests();
