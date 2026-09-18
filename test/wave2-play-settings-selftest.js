#!/usr/bin/env node
'use strict';

/**
 * wave2-play-settings-selftest.js — Wave 2 Worker A (roadmap R1 / R4).
 *
 * Static + module guards for: the slimmed Play view (New-game card, grouped
 * commands, opt-in Assist drawer), the header reduced to brand/nav/account/⚙,
 * the Settings view module (ui-settings.js) that relocates the display and
 * accessibility toggles, and the wiring of the three formerly-dark a11y modules
 * into ui.js. Read-only: never starts the server, never touches state files.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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

const html = read('index.html').replace(/<!--[\s\S]*?-->/g, '');
const ui = read('src/ui.js');
const settingsSrc = read('src/ui-settings.js');
const serverSrc = read('server.js');
const swSrc = read('service-worker.js');

function sliceBetween(src, startRe, endRe) {
  const s = src.search(startRe);
  assert.ok(s >= 0, 'start marker missing: ' + startRe);
  const e = src.slice(s).search(endRe);
  assert.ok(e >= 0, 'end marker missing: ' + endRe);
  return src.slice(s, s + e);
}

const header = sliceBetween(html, /<header class="app-header">/, /<\/header>/);
const play = sliceBetween(html, /<main id="workspace"[^>]*data-view="play">/, /<\/main>/);
const statusPanel = sliceBetween(play, /<section id="status-panel"/, /<\/section>/);
const drawer = sliceBetween(statusPanel, /<details id="assist-drawer">/, /<\/details>/);

console.log('=== wave2-play-settings-selftest ===');

// ---- Play view (R1) --------------------------------------------------------
test('header carries only brand, #shell-nav, #account-bar (+⚙ link) and the sr-only announcer', () => {
  for (const id of ['theme-board-select', 'theme-mode-toggle', 'sound-toggle', 'voice-toggle', 'mic-move-btn', 'blind-mode-toggle', 'theme-bar']) {
    assert.ok(!header.includes('id="' + id + '"'), '#' + id + ' must not be in the header');
  }
  assert.ok(header.includes('id="shell-nav"'), 'nav present');
  assert.ok(header.includes('id="account-bar"'), 'account bar present');
  assert.ok(/id="settings-link"[^>]*href="#\/settings"/.test(header), '⚙ link to #/settings present');
  assert.ok(header.includes('id="accessibility-announcer"'), 'announcer stays in header');
});

test('New-game card groups time control, seats, computer opponent and one primary New Game button', () => {
  const card = sliceBetween(statusPanel, /<div id="new-game-card"/, /<div id="command-controls"/);
  for (const id of ['time-control-select', 'claim-white-btn', 'claim-black-btn', 'bot-toggle', 'bot-level-select', 'bot-color-select', 'new-game', 'copy-room-link', 'new-room-btn', 'room-badge']) {
    assert.ok(card.includes('id="' + id + '"'), '#' + id + ' inside #new-game-card');
  }
  assert.strictEqual((card.match(/id="new-game"/g) || []).length, 1, 'exactly one primary New Game button');
});

test('game commands stay visible and grouped in #command-controls', () => {
  const cmds = sliceBetween(statusPanel, /<div id="command-controls"/, /<div id="assist-block"/);
  for (const id of ['resign', 'offer-draw', 'undo', 'flip-board', 'copy-pgn', 'game-archive-btn', 'game-review-btn', 'claim-draw', 'draw-offer-banner', 'accept-draw', 'decline-draw', 'rematch-btn']) {
    assert.ok(cmds.includes('id="' + id + '"'), '#' + id + ' inside #command-controls');
  }
  assert.ok(!cmds.includes('id="new-game"'), 'New Game moved out of the command row');
  assert.ok(!cmds.includes('id="coach-hint-btn"'), 'Coach Hint moved out of the command row');
});

test('Assist drawer is a <details> closed by default holding the eval bar + MultiPV', () => {
  assert.ok(!/<details id="assist-drawer"[^>]*\bopen\b/.test(html), 'drawer must not be open in markup');
  for (const id of ['eval-bar-container', 'eval-bar-fill', 'eval-score-text', 'multipv-container', 'multipv-select', 'multipv-lines', 'analysis-engine-label', 'analysis-engine-caveat']) {
    assert.ok(drawer.includes('id="' + id + '"'), '#' + id + ' inside #assist-drawer');
  }
  const gameContainer = sliceBetween(play, /<div id="game-container">/, /<section id="status-panel"/);
  assert.ok(!gameContainer.includes('id="eval-bar-container"'), 'eval bar no longer above the board');
  assert.ok(!gameContainer.includes('id="multipv-container"'), 'MultiPV no longer beside the board');
});

test('Coach Hint button + banner stay clickable outside the closed drawer (browser suites click them cold)', () => {
  assert.ok(!drawer.includes('id="coach-hint-btn"'), 'coach-hint-btn not inside the closed drawer');
  assert.ok(!drawer.includes('id="coach-hint-banner"'), 'coach-hint-banner not inside the closed drawer');
  const block = sliceBetween(statusPanel, /<div id="assist-block"/, /<div id="a11y-panel"/);
  assert.ok(block.includes('id="coach-hint-btn"') && block.includes('id="coach-hint-banner"') && block.includes('id="close-coach-hint"'), 'coach controls live in #assist-block');
});

test('ui.js persists the Assist drawer open/closed state in localStorage behind try/catch', () => {
  assert.ok(ui.includes("const ASSIST_DRAWER_KEY = 'chess.assist.open'"), 'storage key defined');
  assert.ok(ui.includes('function setupAssistDrawer()'), 'setupAssistDrawer defined');
  assert.ok(/^setupAssistDrawer\(\);$/m.test(ui), 'setupAssistDrawer called at init');
  const fn = sliceBetween(ui, /function setupAssistDrawer\(\)/, /\n}\n/);
  assert.ok(/try\s*\{[\s\S]*localStorage\.getItem\(ASSIST_DRAWER_KEY\)/.test(fn), 'read wrapped in try');
  assert.ok(/addEventListener\('toggle'/.test(fn), 'toggle listener persists state');
});

test('every id the browser suites reference still exists exactly once in index.html', () => {
  const scripts = ['scripts/smoke-test.mjs', 'scripts/test-ui-features.mjs']
    .filter(p => fs.existsSync(path.join(ROOT, p)))
    .map(read).join('\n');
  const refs = new Set([...scripts.matchAll(/#([a-z][a-z0-9-]*)/g)].map(m => m[1]));
  const skip = new Set(['e2', 'e4', 'board']); // squares are rendered at runtime; board is checked separately
  for (const id of refs) {
    if (skip.has(id)) continue;
    const count = (html.match(new RegExp('id="' + id + '"', 'g')) || []).length;
    assert.strictEqual(count, 1, '#' + id + ' must appear exactly once (got ' + count + ')');
  }
  assert.ok(html.includes('id="board"'), '#board present');
});

test('no duplicate element ids in index.html', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  assert.deepStrictEqual(dup, [], 'duplicate ids: ' + dup.join(', '));
});

test('mobile touch targets: 44px rule for Play controls under @media (max-width: 679px)', () => {
  assert.ok(/@media \(max-width: 679px\) \{[\s\S]*?#status-panel button, #status-panel select[^{]*\{ min-height: 44px; \}/.test(html), '44px min-height for status-panel controls');
});

// ---- Settings view ---------------------------------------------------------
test('ui-settings.js is loaded before ui.js, allow-listed and precached', () => {
  const scriptsInOrder = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  const i = scriptsInOrder.indexOf('src/ui-settings.js');
  const j = scriptsInOrder.indexOf('src/ui.js');
  const k = scriptsInOrder.indexOf('src/shell.js');
  assert.ok(i >= 0 && j >= 0 && k >= 0, 'script tags present');
  assert.ok(k < i && i < j, 'order must be shell.js < ui-settings.js < ui.js');
  assert.ok(serverSrc.includes("'src/ui-settings.js'"), 'server.js ALLOWED_FILES');
  assert.ok(swSrc.includes("'/src/ui-settings.js'"), 'service-worker.js PRECACHE_ASSETS');
});

test('ui-settings.js registers view { id: settings, title: Settings, order: 70, nav: true } with mount/show/hide', () => {
  assert.ok(settingsSrc.includes("const SETTINGS_VIEW_ID = 'settings'"), 'view id');
  assert.ok(/title:\s*'Settings'/.test(settingsSrc), 'title');
  assert.ok(/order:\s*70/.test(settingsSrc), 'order 70');
  assert.ok(/nav:\s*true/.test(settingsSrc), 'nav true');
  for (const hook of ['mount(el)', 'show(el)', 'hide()']) assert.ok(settingsSrc.includes(hook), hook + ' hook');
  assert.ok(/^initSettingsView\(\);$/m.test(settingsSrc), 'self-initialises (reachability heuristic)');
});

test('ui-settings.js never references banned referee mutators (Gate 4)', () => {
  for (const name of ['makeMove', 'createInitialBoard', 'historyToSan', 'fetch(']) {
    assert.ok(!new RegExp('\\b' + name.replace('(', '\\(')).test(settingsSrc), 'ui-settings.js must not reference ' + name);
  }
});

test('Settings module relocates the toggles into rows and returns them to #theme-bar (DOM stub)', () => {
  // Minimal DOM double: enough for buildSettingsView / adopt / release.
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {}; this.id = ''; this.className = ''; this.textContent = ''; }
    appendChild(c) { if (c.parentNode) c.parentNode.children = c.parentNode.children.filter(x => x !== c); c.parentNode = this; this.children.push(c); return c; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = v; }
    removeAttribute(k) { delete this.attrs[k]; }
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }
    get classList() { const self = this; return { add(c) { self.className = (self.className + ' ' + c).trim(); } }; }
    set innerHTML(v) { if (v === '') this.children = []; }
    querySelector(sel) {
      const m = sel.match(/^\[data-settings-slot="([^"]+)"\]$/);
      const walk = (n) => { for (const c of n.children) { if (m && c.getAttribute('data-settings-slot') === m[1]) return c; const r = walk(c); if (r) return r; } return null; };
      return walk(this);
    }
  }
  const registry = new Map();
  const doc = {
    createElement: (t) => new El(t),
    createTextNode: (t) => ({ textContent: t, parentNode: null }),
    getElementById: (id) => registry.get(id) || null
  };
  const bar = new El('div'); bar.id = 'theme-bar'; registry.set('theme-bar', bar);
  const label = new El('label'); bar.appendChild(label);
  const ids = ['theme-board-select', 'theme-mode-toggle', 'sound-toggle', 'voice-toggle', 'blind-mode-toggle'];
  for (const id of ids) { const n = new El(id.endsWith('select') ? 'select' : 'button'); n.id = id; registry.set(id, n); bar.appendChild(n); }

  const origDoc = global.document; const origWin = global.window;
  global.document = doc;
  global.window = { Shell: { registerView: (d) => d } };
  try {
    const mod = require('../src/ui-settings.js');
    assert.deepStrictEqual(mod.settingsControlIds(), ids, 'exactly the five relocated controls (mic stays on Play)');
    const view = mod.initSettingsView();
    assert.strictEqual(view.id, 'settings'); assert.strictEqual(view.order, 70); assert.strictEqual(view.nav, true);
    const section = new El('section');
    view.mount(section);
    for (const id of ids) {
      const node = registry.get(id);
      assert.strictEqual(node.parentNode.getAttribute('data-settings-slot'), id, id + ' adopted into its row');
      assert.strictEqual(node.getAttribute('aria-labelledby'), 'settings-label-' + id, id + ' labelled by its row title');
    }
    assert.strictEqual(bar.children.length, 1, 'only the label remains in #theme-bar while Settings shows');
    view.hide();
    assert.deepStrictEqual(bar.children.map(c => c.id || c.tagName), ['LABEL', ...ids], 'controls return to #theme-bar in original order');
    assert.strictEqual(registry.get('voice-toggle').getAttribute('aria-labelledby'), null, 'aria-labelledby cleared on release');
  } finally {
    global.document = origDoc; global.window = origWin;
  }
});

// ---- R4: a11y modules wired -----------------------------------------------
test('Play view has the typed-command form (#a11y-command-input) and keeps mic + transcript status', () => {
  const panel = sliceBetween(statusPanel, /<div id="a11y-panel"/, /<\/section>|$/);
  assert.ok(/<form id="a11y-command-form"/.test(panel), 'form');
  assert.ok(/<input id="a11y-command-input"/.test(panel), 'input');
  assert.ok(panel.includes('id="a11y-command-submit"'), 'submit button');
  assert.ok(panel.includes('id="a11y-command-feedback"') && /id="a11y-command-feedback"[^>]*aria-live="polite"/.test(panel), 'live-region feedback');
  assert.ok(panel.includes('id="mic-move-btn"'), 'mic stays on Play (in-game action)');
  assert.ok(panel.includes('id="voice-transcript-status"'), 'transcript status next to the mic');
  assert.ok(panel.includes('id="theme-bar"'), 'theme-bar home lives in the a11y panel');
});

test('ui.js routes typed input through A11yTextEntry.parseTextInput and submits via submitMoveToReferee', () => {
  assert.ok(/\bA11yTextEntry\b/.test(ui), 'references the A11yTextEntry global');
  assert.ok(ui.includes('TextEntry.parseTextInput(raw, buildLegalMoveCandidates())'), 'parses against legal candidates');
  const fn = sliceBetween(ui, /function handleTypedCommand\(/, /\n}\n/);
  assert.ok(fn.includes('submitMoveToReferee(from + to + (promo || \'\'))'), 'moves go to the referee');
  assert.ok(fn.includes('dispatchA11yAction(parsed.action)'), 'actions dispatched');
  assert.ok(/^setupA11yCommandEntry\(\);$/m.test(ui), 'form wired at init');
});

test('ui.js routes spoken intents through VoiceIntents.parseIntent before move parsing', () => {
  assert.ok(/\bVoiceIntents\b/.test(ui), 'references the VoiceIntents global');
  const fn = sliceBetween(ui, /function handleVoiceTranscript\(/, /\n}\n/);
  const intentIdx = fn.indexOf('Intents.parseIntent(transcript)');
  const moveIdx = fn.indexOf('parseSpokenMove(transcript');
  assert.ok(intentIdx >= 0 && moveIdx > intentIdx, 'intent routing happens first');
  assert.ok(fn.includes('dispatchA11yAction(intent.action)'), 'intents dispatched');
  for (const dead of ['handleResignClick', 'handleDrawOffer', 'handleDrawDecline']) {
    assert.ok(!ui.includes(dead), 'dead reference removed: ' + dead);
  }
});

test('dispatchA11yAction only drives existing referee-bound buttons / display helpers', () => {
  const fn = sliceBetween(ui, /function dispatchA11yAction\(/, /\n}\n/);
  for (const id of ['resign', 'offer-draw', 'accept-draw', 'decline-draw', 'undo', 'new-game', 'game-review-btn']) {
    assert.ok(fn.includes("clickIfActionable('" + id + "')"), 'routes to #' + id);
  }
  assert.ok(fn.includes('showCoachHint()'), 'hint → showCoachHint');
  assert.ok(fn.includes('setAssistDrawerOpen(true)'), 'best/analyze open the Assist drawer');
  assert.ok(!/fetch\(/.test(fn), 'no direct fetch — mutations stay behind the button handlers');
});

test('ui.js attaches A11yGestures.GestureController to #board, enabled only in blind mode', () => {
  assert.ok(/\bA11yGestures\b/.test(ui), 'references the A11yGestures global');
  const fn = sliceBetween(ui, /function setupA11yGestures\(/, /\n}\n/);
  assert.ok(fn.includes('new Gestures.GestureController('), 'controller constructed');
  assert.ok(fn.includes('setRovingSquare(keyboardDestination(current, key))'), 'swipes reuse the keyboard-grid handlers');
  assert.ok(fn.includes("addEventListener('touchstart'") && fn.includes("addEventListener('touchend'"), 'touch listeners on the board');
  assert.ok(ui.includes('syncA11yGestures();'), 'gesture enable state synced with blind-mode toggle');
  assert.ok(/pointerType === 'touch'[^\n]*isBlindModeActive\(\)\) return;/.test(ui), 'touch drag suppressed in blind mode');
  assert.ok(/^setupA11yGestures\(\);$/m.test(ui), 'gestures wired at init');
});

test('Gate 4: ui.js never references makeMove / createInitialBoard / historyToSan', () => {
  for (const name of ['makeMove', 'createInitialBoard', 'historyToSan']) {
    assert.ok(!new RegExp('\\b' + name + '\\b').test(ui), 'ui.js must not reference ' + name);
  }
});

test('reachability KNOWN_DARK no longer lists the three a11y modules', () => {
  const reach = read('test/reachability-selftest.js');
  const dark = sliceBetween(reach, /const KNOWN_DARK = \{/, /\n\};/);
  for (const mod of ['a11y-text-entry.js', 'a11y-gestures.js', 'voice-intents.js']) {
    assert.ok(!dark.includes("'" + mod + "'"), mod + ' must not be in KNOWN_DARK');
  }
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
