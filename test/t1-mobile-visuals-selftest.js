#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

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

function main() {
  console.log('=== Running Mobile & Visuals Self-Test (D5, A7, A9) ===\n');

  const indexPath = path.join(__dirname, '..', 'index.html');
  const indexContent = fs.readFileSync(indexPath, 'utf8');

  const uiPath = path.join(__dirname, '..', 'src', 'ui.js');
  const uiContent = fs.readFileSync(uiPath, 'utf8');

  // 1. A7 & A9 Visual Depth and CSS Consolidation
  assert(!indexContent.includes('--board-bevel: none;'), 'index.html does not disable board-bevel');
  assert(indexContent.includes('--board-bevel: inset'), 'index.html defines inset board-bevel');
  assert(indexContent.includes('--piece-shadow: drop-shadow'), 'index.html defines piece-shadow with drop-shadow');
  assert(indexContent.includes('--sq-white-grad: linear-gradient'), 'index.html defines subtle square white gradient');
  assert(indexContent.includes('--sq-black-grad: linear-gradient'), 'index.html defines subtle square black gradient');

  // 2. D5 Touch action & Pointer Drag
  assert(indexContent.includes('#board { width: 100%; border-width: 1px; border-radius: 6px; box-shadow: var(--board-bevel); touch-action: none; }'), 'board has touch-action: none');
  assert(indexContent.includes('.square {') && indexContent.includes('touch-action: none;'), 'square has touch-action: none');

  // 3. ui.js Pointer Events Integration
  assert(uiContent.includes('function handlePointerDown('), 'ui.js defines handlePointerDown');
  assert(uiContent.includes('function handlePointerMove('), 'ui.js defines handlePointerMove');
  assert(uiContent.includes('function handlePointerUp('), 'ui.js defines handlePointerUp');
  assert(uiContent.includes('function handlePointerCancel('), 'ui.js defines handlePointerCancel');
  assert(uiContent.includes('squareDiv.onpointerdown'), 'ui.js attaches onpointerdown to squareDiv');
  assert(uiContent.includes("window.addEventListener('pointermove'"), 'ui.js registers global pointermove listener');
  assert(uiContent.includes("window.addEventListener('pointerup'"), 'ui.js registers global pointerup listener');

  // 4. Architectural Invariants
  assert(!uiContent.includes('makeMove('), 'ARCHITECTURAL INVARIANT: ui.js does not call makeMove(');
  assert(!uiContent.includes('createInitialBoard('), 'ARCHITECTURAL INVARIANT: ui.js does not call createInitialBoard(');

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
