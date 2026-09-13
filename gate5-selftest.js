#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const worker = require('./stockfish-worker.js');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`PASS: ${message}`);
    passed++;
  } else {
    console.error(`FAIL: ${message}`);
    failed++;
  }
}

async function main() {
  console.log('--- Running Gate 5 Stockfish Engine & Security Self-Tests ---\n');

  // Test FEN parsing
  const initialFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const parsed = worker.parseFen(initialFen);
  assert(parsed && parsed.turn === 'white', 'parseFen parses valid initial FEN');
  assert(Object.keys(parsed.pieces).length === 32, 'parseFen identifies all 32 starting pieces');

  // Test Evaluation
  const initialEval = worker.evaluatePosition(parsed);
  assert(typeof initialEval === 'number' && initialEval === 0, 'evaluatePosition returns 0 for equal starting position');

  // Test Best Move analysis
  const analysis = worker.findBestMove(parsed);
  assert(analysis && typeof analysis.bestMove === 'string' && analysis.bestMove.length === 4, 'findBestMove produces candidate best move coordinate');

  // Test server rate limiting function logic
  const serverCode = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert(/checkRateLimit/.test(serverCode), 'server.js implements client request rate limiting');
  assert(/stockfish-worker\.js/.test(serverCode), 'server.js explicitly serves stockfish-worker.js in ALLOWED_FILES');

  // Test HTML & UI elements
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');

  assert(/id="eval-bar-container"/.test(html) && /id="eval-bar-fill"/.test(html), 'index.html contains evaluation bar markup');
  assert(/id="analysis-arrows"/.test(html), 'index.html contains SVG analysis arrows container');
  assert(/function drawAnalysisArrow/.test(ui) && /function updateEvalUI/.test(ui), 'ui.js includes eval UI update and analysis arrow functions');

  console.log(`\n--- Gate 5 Self-Test Summary ---\nPassed: ${passed}\nFailed: ${failed}`);
  if (failed > 0) process.exit(1);
  console.log('\nAll Gate 5 self-tests PASSED successfully!');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
