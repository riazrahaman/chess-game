#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const engine = require('../src/engine.js');

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
  console.log('--- Running Phase 1 Audio & Haptics Self-Tests ---\n');

  // Test 1: Sound classification
  const initial = { board: engine.createInitialBoard(), history: [], gameOver: false };
  const moveBoard = engine.makeMove(initial.board, 'e2', 'e4');
  const moveState = { board: moveBoard, history: ['e2e4'], gameOver: false };
  assert(engine.classifySound(initial, moveState) === 'move', 'ordinary move classifies as move');

  const captureBoard = engine.makeMove(moveBoard, 'd7', 'd5');
  const captureNext = engine.makeMove(captureBoard, 'e4', 'd5');
  const captureState = { board: captureNext, history: ['e2e4', 'd7d5', 'e4d5'], gameOver: false };
  assert(engine.classifySound({ board: captureBoard, history: ['e2e4', 'd7d5'], gameOver: false }, captureState) === 'capture',
    'piece capture classifies as capture');

  // Test 2: Castle classification
  const whiteKing = { type: 'k', color: 'white' };
  const prevCastleState = {
    board: {
      turn: 'white',
      pieces: { e1: whiteKing, h1: { type: 'r', color: 'white' }, f1: null, g1: null }
    },
    history: []
  };
  const nextCastleState = {
    board: {
      turn: 'black',
      pieces: { e1: null, h1: null, g1: whiteKing, f1: { type: 'r', color: 'white' } }
    },
    history: ['e1g1']
  };
  assert(engine.classifySound(prevCastleState, nextCastleState) === 'castle', 'kingside castling classifies as castle');

  // Test 3: Game end classification
  const endState = { ...initial, gameOver: true, status: 'checkmate', result: '1-0' };
  assert(engine.classifySound(initial, endState) === 'gameEnd', 'terminal state classifies as gameEnd');

  // Test 4: UI & Markup checks
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui.js'), 'utf8');

  assert(/id="sound-toggle"/.test(html), 'index.html contains sound toggle button');
  assert(/function setSoundEnabled/.test(ui), 'ui.js defines setSoundEnabled controller');
  assert(/navigator\.vibrate/.test(ui), 'ui.js integrates mobile haptic feedback');
  assert(/osc\.type = 'triangle'/.test(ui), 'ui.js features acoustic frequency curves for captures');

  console.log(`\n--- Phase 1 Audio Self-Test Summary ---\nPassed: ${passed}\nFailed: ${failed}`);
  if (failed > 0) process.exit(1);
  console.log('\nAll Phase 1 audio self-tests PASSED successfully!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
