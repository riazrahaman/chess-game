'use strict';

const assert = require('assert');
const fs = require('fs');
const { sanToNaturalSpeech, parseSpokenMove, AccessibilityVoiceController } = require('./accessibility-voice.js');

console.log('=== Starting c8-d4-voice-selftest.js ===');

// Test 1: Gate 4 Architectural Invariant Audit
const uiCode = fs.readFileSync('ui.js', 'utf8');
const makeMoveMatches = (uiCode.match(/makeMove\s*\(/g) || []).length;
const createBoardMatches = (uiCode.match(/createInitialBoard\s*\(/g) || []).length;
assert.strictEqual(makeMoveMatches, 0, 'Gate 4 invariant: ui.js must have 0 makeMove( calls');
assert.strictEqual(createBoardMatches, 0, 'Gate 4 invariant: ui.js must have 0 createInitialBoard( calls');
console.log('✔ Passed: Gate 4 invariants verified in ui.js');

// Test 2: HTML UI Elements Existence
const html = fs.readFileSync('index.html', 'utf8');
assert.ok(html.includes('id="voice-toggle"'), 'index.html must have voice-toggle button');
assert.ok(html.includes('id="mic-move-btn"'), 'index.html must have mic-move-btn button');
assert.ok(html.includes('id="blind-mode-toggle"'), 'index.html must have blind-mode-toggle button');
assert.ok(html.includes('id="voice-transcript-status"'), 'index.html must have voice-transcript-status');
assert.ok(html.includes('id="accessibility-announcer"'), 'index.html must have accessibility-announcer');
assert.ok(html.includes('src="accessibility-voice.js"'), 'index.html must include accessibility-voice.js script');
console.log('✔ Passed: All Voice & Blind Accessibility UI elements present in index.html');

// Test 3: Natural Speech Conversion (sanToNaturalSpeech)
assert.strictEqual(sanToNaturalSpeech('e4', 'white'), 'White: Pawn to e4');
assert.strictEqual(sanToNaturalSpeech('Nf3', 'white'), 'White: Knight to f3');
assert.strictEqual(sanToNaturalSpeech('exd5', 'white'), 'White: e takes d5');
assert.strictEqual(sanToNaturalSpeech('Qxd4+', 'black'), 'Black: Queen takes d4 check');
assert.strictEqual(sanToNaturalSpeech('O-O', 'white'), 'White: Kingside castle');
assert.strictEqual(sanToNaturalSpeech('O-O-O', 'black'), 'Black: Queenside castle');
assert.strictEqual(sanToNaturalSpeech('e8=Q#', 'white'), 'White: Pawn to e8 promotes to Queen checkmate');
console.log('✔ Passed: sanToNaturalSpeech converts chess notation to natural spoken English');

// Test 4: Voice Move Parsing (parseSpokenMove)
const mockCandidates = [
  { from: 'g1', to: 'f3', san: 'Nf3', uci: 'g1f3' },
  { from: 'e2', to: 'e4', san: 'e4', uci: 'e2e4' },
  { from: 'd2', to: 'd4', san: 'd4', uci: 'd2d4' },
  { from: 'e1', to: 'g1', san: 'O-O', uci: 'e1g1' },
  { from: 'e7', to: 'e8', promo: 'q', san: 'e8=Q#', uci: 'e7e8q' }
];

// Exact SAN / Coordinate matches
const res1 = parseSpokenMove('knight to f3', mockCandidates);
assert.ok(res1 && res1.move && res1.move.uci === 'g1f3', 'Recognizes "knight to f3"');

const res2 = parseSpokenMove('night to f3', mockCandidates);
assert.ok(res2 && res2.move && res2.move.uci === 'g1f3', 'Recognizes homophone "night to f3"');

const res3 = parseSpokenMove('e4', mockCandidates);
assert.ok(res3 && res3.move && res3.move.uci === 'e2e4', 'Recognizes "e4"');

const res4 = parseSpokenMove('pawn to e4', mockCandidates);
assert.ok(res4 && res4.move && res4.move.uci === 'e2e4', 'Recognizes "pawn to e4"');

const res5 = parseSpokenMove('e2 to e4', mockCandidates);
assert.ok(res5 && res5.move && res5.move.uci === 'e2e4', 'Recognizes coordinate move "e2 to e4"');

const res6 = parseSpokenMove('castle kingside', mockCandidates);
assert.ok(res6 && res6.move && res6.move.san === 'O-O', 'Recognizes "castle kingside"');

// Special commands
const resResign = parseSpokenMove('i resign', mockCandidates);
assert.ok(resResign && resResign.action === 'resign', 'Recognizes voice resign command');

const resDraw = parseSpokenMove('offer draw', mockCandidates);
assert.ok(resDraw && resDraw.action === 'draw', 'Recognizes voice draw command');
console.log('✔ Passed: parseSpokenMove successfully resolves natural spoken language and commands');

// Test 5: AccessibilityVoiceController state and grid cursor math
const controller = new AccessibilityVoiceController({ voiceEnabled: false, blindModeEnabled: false });
assert.strictEqual(controller.voiceEnabled, false);
assert.strictEqual(controller.blindModeEnabled, false);

assert.strictEqual(controller.toggleVoice(), true);
assert.strictEqual(controller.voiceEnabled, true);

assert.strictEqual(controller.toggleBlindMode(), true);
assert.strictEqual(controller.blindModeEnabled, true);

// Grid coordinates: fileIdx 0=a..7=h, rankIdx 0=1..7=8
controller.setCursor('e2');
assert.strictEqual(controller.focusedCoord.file, 4); // 'e' is index 4
assert.strictEqual(controller.focusedCoord.rank, 1); // '2' is index 1

// Move up one rank: e2 -> e3
const sqUp = controller.moveCursor(0, 1);
assert.strictEqual(sqUp, 'e3');

// Move right one file: e3 -> f3
const sqRight = controller.moveCursor(1, 0);
assert.strictEqual(sqRight, 'f3');

// Move out of bounds is clamped
controller.setCursor('h8');
const clamped = controller.moveCursor(2, 2);
assert.strictEqual(clamped, 'h8');
console.log('✔ Passed: AccessibilityVoiceController grid navigation and state toggles verified');

// Test 6: Mock DOM Announcer Integration
const mockElements = {};
global.document = {
  getElementById: (id) => {
    if (!mockElements[id]) {
      mockElements[id] = {
        id,
        attrs: {},
        textContent: '',
        setAttribute(k, v) { this.attrs[k] = v; }
      };
    }
    return mockElements[id];
  }
};

controller.announceLive('Test Announcement', true);
const announcerEl = global.document.getElementById('accessibility-announcer');
assert.strictEqual(announcerEl.textContent, 'Test Announcement');
assert.strictEqual(announcerEl.attrs['aria-live'], 'assertive');

controller.announceGameOutcome('checkmate', '1-0', 'normal');
assert.ok(announcerEl.textContent.includes('White wins'), 'Outcome announcement indicates winner');

controller.announceClocks(300, 185);
assert.ok(announcerEl.textContent.includes('5 minutes') && announcerEl.textContent.includes('3 minutes 5 seconds'), 'Clocks correctly formatted and announced');
console.log('✔ Passed: Mock DOM ARIA live announcer integration verified');

// Test 7: Exported Window Hooks in ui.js
assert.ok(uiCode.includes('window.getAccessibilityController'), 'ui.js exports window.getAccessibilityController');
assert.ok(uiCode.includes('window.setupAccessibilityVoiceUI'), 'ui.js exports window.setupAccessibilityVoiceUI');
assert.ok(uiCode.includes('window.handleVoiceTranscript'), 'ui.js exports window.handleVoiceTranscript');
console.log('✔ Passed: Frontend window hooks correctly exported in ui.js');

console.log('=== All 7 C8 & D4 Voice & Accessibility Tests Passed Successfully! ===');
