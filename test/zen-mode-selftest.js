#!/usr/bin/env node
'use strict';

/**
 * zen-mode-selftest.js
 * Verification suite for G6: Zen mode & flip-board shortcut parity.
 * Enforces:
 * 1. Z key toggles Zen mode (hiding ratings, eval bar, assist drawer, chat, report clutter).
 * 2. F key triggers flip board shortcut parity.
 * 3. Gate 4 invariant: 0 occurrences of literal makeMove( and createInitialBoard(.
 * 4. DOM element uniqueness and presence of #zen-mode-toggle and #zen-pill.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const uiSrc = fs.readFileSync(path.join(ROOT, 'src', 'ui.js'), 'utf8');
const settingsSrc = fs.readFileSync(path.join(ROOT, 'src', 'ui-settings.js'), 'utf8');
const htmlSrcRaw = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const htmlSrc = htmlSrcRaw.replace(/<!--[\s\S]*?-->/g, '');

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

console.log('=== G6 Zen Mode & Flip Board Shortcut Selftest ===');

// 1. Gate 4 Invariant
test('Gate 4 Invariant: ui.js and ui-settings.js contain zero makeMove/createInitialBoard', () => {
  for (const [file, content] of [['ui.js', uiSrc], ['ui-settings.js', settingsSrc]]) {
    assert.ok(!content.includes('makeMove('), `Gate 4 violation: ${file} contains makeMove(`);
    assert.ok(!content.includes('createInitialBoard('), `Gate 4 violation: ${file} contains createInitialBoard(`);
  }
});

// 2. DOM elements
test('index.html contains #zen-mode-toggle in #command-controls and #zen-pill in status', () => {
  assert.ok(htmlSrc.includes('id="zen-mode-toggle"'), 'index.html has #zen-mode-toggle');
  assert.ok(htmlSrc.includes('id="zen-pill"'), 'index.html has #zen-pill');
  
  const cmdMatch = htmlSrc.match(/<div id="command-controls"[^>]*>([\s\S]*?)<\/div>\s*<div id="assist-block"/);
  assert.ok(cmdMatch, 'found command-controls block');
  assert.ok(cmdMatch[1].includes('id="zen-mode-toggle"'), '#zen-mode-toggle is inside #command-controls');
});

test('No duplicate IDs for zen controls in index.html', () => {
  for (const id of ['zen-mode-toggle', 'zen-pill', 'flip-board']) {
    const count = (htmlSrc.match(new RegExp(`id="${id}"`, 'g')) || []).length;
    assert.strictEqual(count, 1, `Element id #${id} must appear exactly once, got ${count}`);
  }
});

// 3. CSS rules for Zen mode
test('index.html defines body.zen-mode suppression styles', () => {
  assert.ok(htmlSrc.includes('body.zen-mode #eval-bar-container'), 'hides eval bar');
  assert.ok(htmlSrc.includes('body.zen-mode #assist-block'), 'hides assist block');
  assert.ok(htmlSrc.includes('body.zen-mode #spectator-badge'), 'hides spectator badge');
  assert.ok(htmlSrc.includes('body.zen-mode #chat-panel'), 'hides chat panel');
  assert.ok(htmlSrc.includes('body.zen-mode #zen-pill { display: inline-block'), 'displays zen pill in zen mode');
});

// 4. Keyboard shortcuts in ui.js
test('ui.js handles F key for board flip and Z key for zen mode toggle', () => {
  assert.ok(uiSrc.includes("if (k === 'f')"), 'handles f key');
  assert.ok(uiSrc.includes("if (k === 'z')"), 'handles z key');
  assert.ok(uiSrc.includes('toggleZenMode();'), 'invokes toggleZenMode on z key');
});

// 5. Window exports and persistence in ui.js
test('ui.js exports toggleZenMode, isZenModeActive, and setZenMode on window', () => {
  assert.ok(uiSrc.includes('window.toggleZenMode = toggleZenMode;'), 'exports toggleZenMode');
  assert.ok(uiSrc.includes('window.isZenModeActive = isZenModeActive;'), 'exports isZenModeActive');
  assert.ok(uiSrc.includes('window.setZenMode = setZenMode;'), 'exports setZenMode');
  assert.ok(uiSrc.includes("localStorage.setItem('chess_zen_mode'"), 'persists zen mode in localStorage');
});

// 6. Settings view documentation
test('ui-settings.js documents F and Z keyboard shortcuts', () => {
  assert.ok(settingsSrc.includes("['F', 'Flip board']"), 'lists F shortcut in settings');
  assert.ok(settingsSrc.includes("['Z', 'Toggle Zen mode"), 'lists Z shortcut in settings');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
