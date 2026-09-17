#!/usr/bin/env node
'use strict';

const assert = require('assert');
const TextEntry = require('../src/a11y-text-entry.js');
const Gestures = require('../src/a11y-gestures.js');
const VoiceIntents = require('../src/voice-intents.js');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS: ${name}`); }

console.log('=== Accessibility AB1/AB2/AB3 Self-Test ===\n');

// ---- AB1: text command entry ----
test('text entry recognizes a UCI move', () => {
  const candidates = [{ san: 'e4', uci: 'e2e4', from: 'e2', to: 'e4' }];
  const r = TextEntry.parseTextInput('e2e4', candidates);
  assert.strictEqual(r.move.uci, 'e2e4');
  assert.strictEqual(r.confidence, 1);
});

test('text entry recognizes SAN', () => {
  const candidates = [{ san: 'Nf3', uci: 'g1f3', from: 'g1', to: 'f3' }];
  const r = TextEntry.parseTextInput('Nf3', candidates);
  assert.strictEqual(r.move.uci, 'g1f3');
});

test('text entry recognizes promotion with UCI', () => {
  const candidates = [{ san: 'e8=Q', uci: 'e7e8q', from: 'e7', to: 'e8', promo: 'q' }];
  const r = TextEntry.parseTextInput('e7e8q', candidates);
  assert.strictEqual(r.move.uci, 'e7e8q');
});

test('text entry recognizes castling', () => {
  const candidates = [{ san: 'O-O', uci: 'e1g1', from: 'e1', to: 'g1' }];
  const r = TextEntry.parseTextInput('O-O', candidates);
  assert.strictEqual(r.move.uci, 'e1g1');
});

test('text entry recognizes commands', () => {
  assert.strictEqual(TextEntry.parseTextInput('resign', []).action, 'resign');
  assert.strictEqual(TextEntry.parseTextInput('show best move', []).action, 'best');
  assert.strictEqual(TextEntry.parseTextInput('analyze this', []).action, 'analyze');
});

test('text entry reports illegal and unrecognized', () => {
  const candidates = [{ san: 'e4', uci: 'e2e4', from: 'e2', to: 'e4' }];
  assert.strictEqual(TextEntry.parseTextInput('e2e5', candidates).error, 'illegal');
  assert.strictEqual(TextEntry.parseTextInput('gibberish', candidates).error, 'unrecognized');
});

test('text entry is safe on empty input', () => {
  assert.strictEqual(TextEntry.parseTextInput('', []), null);
  assert.strictEqual(TextEntry.parseTextInput(null, []), null);
});

// ---- AB2: touchscreen gestures ----
test('classifySwipe distinguishes directions', () => {
  assert.strictEqual(Gestures.classifySwipe(100, 5), 'right');
  assert.strictEqual(Gestures.classifySwipe(-100, 5), 'left');
  assert.strictEqual(Gestures.classifySwipe(5, 100), 'down');
  assert.strictEqual(Gestures.classifySwipe(5, -100), 'up');
  assert.strictEqual(Gestures.classifySwipe(5, 5), 'tap');
});

test('classifySwipe respects the threshold', () => {
  assert.strictEqual(Gestures.classifySwipe(30, 5, 40), 'tap');
  assert.strictEqual(Gestures.classifySwipe(41, 5, 40), 'right');
});

test('GestureController dispatches swipe and tap', () => {
  let swipes = [], taps = 0;
  const gc = new Gestures.GestureController({ onSwipe: d => swipes.push(d), onTap: () => taps++ });
  gc.handleTouchStart({ touches: [{ clientX: 0, clientY: 0 }] });
  const r = gc.handleTouchEnd({ changedTouches: [{ clientX: 100, clientY: 0 }] });
  assert.strictEqual(r, 'right');
  assert.deepStrictEqual(swipes, ['right']);

  gc.handleTouchStart({ touches: [{ clientX: 0, clientY: 0 }] });
  gc.handleTouchEnd({ changedTouches: [{ clientX: 2, clientY: 2 }] });
  assert.strictEqual(taps, 1);
});

test('GestureController can be disabled', () => {
  let count = 0;
  const gc = new Gestures.GestureController({ onTap: () => count++ });
  gc.setEnabled(false);
  gc.handleTouchStart({ touches: [{ clientX: 0, clientY: 0 }] });
  const r = gc.handleTouchEnd({ changedTouches: [{ clientX: 0, clientY: 0 }] });
  assert.strictEqual(r, null);
  assert.strictEqual(count, 0);
});

// ---- AB3: voice intents ----
test('voice intents route game commands', () => {
  assert.strictEqual(VoiceIntents.parseIntent('resign').action, 'resign');
  assert.strictEqual(VoiceIntents.parseIntent('analyze this').action, 'analyze');
  assert.strictEqual(VoiceIntents.parseIntent('show best move').action, 'best');
  assert.strictEqual(VoiceIntents.parseIntent('give me a hint').action, 'hint');
  assert.strictEqual(VoiceIntents.parseIntent('take back').action, 'undo');
});

test('voice intents return null for non-command utterances', () => {
  assert.strictEqual(VoiceIntents.parseIntent('knight to f3'), null);
  assert.strictEqual(VoiceIntents.parseIntent(''), null);
  assert.strictEqual(VoiceIntents.parseIntent(null), null);
});

test('voice intents handle punctuation and case', () => {
  assert.strictEqual(VoiceIntents.parseIntent('Resign!').action, 'resign');
  assert.strictEqual(VoiceIntents.parseIntent('  OFFER DRAW  ').action, 'draw');
});

console.log(`\nAll ${passed} tests passed successfully!`);
