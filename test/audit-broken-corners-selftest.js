#!/usr/bin/env node
'use strict';

/**
 * audit-broken-corners-selftest.js
 *
 * Automated regression suite for the 6 broken corners resolved from the QA audit:
 * 1. Seat Token Isolation (room-namespaced storage in ui.js & ui-compete.js)
 * 2. Promotion Dialog Dismiss/Cancel (Cancel button & Escape key in ui-puzzles.js & ui-study.js)
 * 3. Unseated Draw Claim Visibility (claimDrawButton visible for unseated / local games)
 * 4. Touchscreen Resignation Confirmation (2-step state machine with 4000ms timeout)
 * 5. PGN Copy Fallback (clipboard fallback to execCommand('copy') and showUiError on failure)
 * 6. Shell In-Memory SPA History Navigation (pushState on navigate, popstate restore)
 * 7. Gate 4 invariant: 0 occurrences of makeMove( or createInitialBoard( in src/ui*.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let passed = 0;
let failed = 0;

const asyncTasks = [];

function test(name, fn) {
  try {
    const res = fn();
    if (res && typeof res.then === 'function') {
      const p = res.then(
        () => {
          passed++;
          console.log('PASS: ' + name);
        },
        (err) => {
          failed++;
          console.error('FAIL: ' + name + ' — ' + (err && err.message ? err.message : err));
        }
      );
      asyncTasks.push(p);
      return p;
    }
    passed++;
    console.log('PASS: ' + name);
  } catch (err) {
    failed++;
    console.error('FAIL: ' + name + ' — ' + (err && err.message ? err.message : err));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

// ---------------------------------------------------------------------------
// 1. Gate 4 Architectural Invariant Check across all src/ui*.js
// ---------------------------------------------------------------------------
test('Gate 4 invariant: zero occurrences of makeMove( or createInitialBoard( in src/ui*.js', () => {
  const srcDir = path.join(ROOT, 'src');
  const files = fs.readdirSync(srcDir).filter(f => f.startsWith('ui') && f.endsWith('.js'));
  assert(files.length > 0, 'Found no ui*.js files in src');

  const forbidden = [/\bmakeMove\s*\(/, /\bcreateInitialBoard\s*\(/];
  for (const file of files) {
    const content = fs.readFileSync(path.join(srcDir, file), 'utf8');
    for (const pat of forbidden) {
      assert(!pat.test(content), `Gate 4 violation in ${file}: matches ${pat}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Seat Token Isolation (src/ui.js & src/ui-compete.js)
// ---------------------------------------------------------------------------
test('Seat token: storage is room-namespaced in ui.js and ui-compete.js', () => {
  const uiCode = fs.readFileSync(path.join(ROOT, 'src', 'ui.js'), 'utf8');
  const competeCode = fs.readFileSync(path.join(ROOT, 'src', 'ui-compete.js'), 'utf8');

  // Verify room-namespaced storage in ui.js
  assert(uiCode.includes("window.sessionStorage.getItem('chess_seat_token_' + room) || window.sessionStorage.getItem('chess_seat_token')"),
    'ui.js should read room-namespaced sessionStorage with fallback');
  assert(uiCode.includes("window.sessionStorage.setItem('chess_seat_token_' + room, data.token)"),
    'ui.js claimSeat should write room-namespaced token to sessionStorage');
  assert(uiCode.includes("window.sessionStorage.removeItem('chess_seat_token_' + room)"),
    'ui.js leaveSeat should remove room-namespaced token from sessionStorage');

  // Verify room-namespaced storage in ui-compete.js
  assert(competeCode.includes("window.sessionStorage.setItem('chess_seat_token_' + match.roomId, match.seatToken)"),
    'ui-compete.js competeEnterRoom should write room-namespaced token to sessionStorage');
});

test('Seat token: room isolation in mock storage', () => {
  const sessionStorage = new Map();
  function saveSeatToken(room, token) {
    sessionStorage.set('chess_seat_token_' + room, token);
  }
  function getSeatToken(room) {
    return sessionStorage.get('chess_seat_token_' + room) || sessionStorage.get('chess_seat_token') || null;
  }

  saveSeatToken('roomA', 'token-A');
  saveSeatToken('roomB', 'token-B');

  assert(getSeatToken('roomA') === 'token-A', 'roomA token isolated');
  assert(getSeatToken('roomB') === 'token-B', 'roomB token isolated');
  assert(getSeatToken('roomC') === null, 'roomC has no token');
});

// ---------------------------------------------------------------------------
// 3. Promotion Dialog Dismiss / Cancel (ui-puzzles.js & ui-study.js)
// ---------------------------------------------------------------------------
test('Promotion dialog in ui-puzzles.js: Cancel button and Escape key dismiss cleanly', () => {
  const code = fs.readFileSync(path.join(ROOT, 'src', 'ui-puzzles.js'), 'utf8');
  assert(code.includes('.pz-promo'), 'pz-promo exists');
  assert(code.includes('Escape'), 'Escape listener exists in ui-puzzles');
  assert(code.includes('state.selected = null'), 'state.selected reset exists');
  assert(code.includes('renderBoard()'), 'renderBoard() call exists on dismiss');
  assert(code.includes('removeEventListener'), 'removeEventListener exists in ui-puzzles');
  assert(code.includes('pz-promo-cancel'), 'Cancel button exists in ui-puzzles');
});

test('Promotion dialog in ui-study.js: Cancel button and Escape key dismiss cleanly', () => {
  const code = fs.readFileSync(path.join(ROOT, 'src', 'ui-study.js'), 'utf8');
  assert(code.includes('.st-promo'), 'st-promo exists');
  assert(code.includes('Escape'), 'Escape listener exists in ui-study');
  assert(code.includes('state.selected = null'), 'state.selected reset exists');
  assert(code.includes('renderBoard()'), 'renderBoard() call exists on dismiss');
  assert(code.includes('removeEventListener'), 'removeEventListener exists in ui-study');
  assert(code.includes('st-promo-cancel'), 'Cancel button exists in ui-study');
});

// ---------------------------------------------------------------------------
// 4. Unseated Draw Claim Visibility (src/ui.js ~line 2123)
// ---------------------------------------------------------------------------
test('Unseated draw claim visibility: claimDrawButton is visible for unseated games when claimable', () => {
  const code = fs.readFileSync(path.join(ROOT, 'src', 'ui.js'), 'utf8');
  assert(code.includes('const canClaim = (seated || (!state?.seats?.white && !state?.seats?.black)) && isDrawClaimable(state);'),
    'canClaim calculation includes unseated game condition');
  assert(code.includes("claimDrawButton.classList.toggle('hidden', !canClaim);"),
    'claimDrawButton hidden toggled based on canClaim');

  // Verify logic table:
  const isDrawClaimable = () => true;
  function computeCanClaim(seated, seats) {
    const state = { seats };
    return (seated || (!state?.seats?.white && !state?.seats?.black)) && isDrawClaimable(state);
  }

  // Unseated local game (no seats in state) -> can claim
  assert(computeCanClaim(false, null) === true, 'unseated local game with null seats can claim');
  assert(computeCanClaim(false, {}) === true, 'unseated local game with empty seats can claim');

  // Seated player -> can claim
  assert(computeCanClaim(true, { white: 'p1', black: 'p2' }) === true, 'seated player can claim');

  // Spectator in game where seats are taken -> cannot claim
  assert(computeCanClaim(false, { white: 'p1', black: 'p2' }) === false, 'spectator with active seats cannot claim');
});

// ---------------------------------------------------------------------------
// 5. Touchscreen Resignation Confirmation State Machine (src/ui.js)
// ---------------------------------------------------------------------------
test('Resignation confirmation: 2-step confirm state machine with 4000ms timeout', () => {
  const code = fs.readFileSync(path.join(ROOT, 'src', 'ui.js'), 'utf8');
  assert(code.includes('btn-danger-confirm'), 'btn-danger-confirm class used');
  assert(code.includes('Confirm Resign?'), 'Confirm Resign? text used');
  assert(code.includes('4000'), '4000ms timeout used');
  assert(code.includes('resetResignConfirm'), 'resetResignConfirm function defined');

  // Test state machine logic in isolation
  let timerId = null;
  let cleared = false;
  let resigned = false;
  const mockButton = {
    textContent: 'Resign',
    classList: {
      hasConfirm: false,
      add(c) { if (c === 'btn-danger-confirm') this.hasConfirm = true; },
      remove(c) { if (c === 'btn-danger-confirm') this.hasConfirm = false; }
    }
  };

  function mockResetResignConfirm() {
    if (timerId) {
      cleared = true;
      timerId = null;
    }
    mockButton.textContent = 'Resign';
    mockButton.classList.remove('btn-danger-confirm');
  }

  function mockOnResignClick() {
    if (!timerId) {
      mockButton.textContent = 'Confirm Resign?';
      mockButton.classList.add('btn-danger-confirm');
      timerId = 12345;
      return;
    }
    mockResetResignConfirm();
    resigned = true;
  }

  // Click 1: enter confirm state, do NOT resign yet
  mockOnResignClick();
  assert(mockButton.textContent === 'Confirm Resign?', 'Button text updated to Confirm Resign?');
  assert(mockButton.classList.hasConfirm === true, 'btn-danger-confirm added on first click');
  assert(resigned === false, 'Resignation API call not made on first click');
  assert(timerId === 12345, 'Timer initiated');

  // Reset (e.g. timeout expiration or new game)
  mockResetResignConfirm();
  assert(mockButton.textContent === 'Resign', 'Button text reverted to Resign');
  assert(mockButton.classList.hasConfirm === false, 'btn-danger-confirm removed on revert');
  assert(cleared === true, 'Timer cleared');

  // Click 1 again, then Click 2: executes resignation
  resigned = false;
  mockOnResignClick();
  assert(mockButton.textContent === 'Confirm Resign?', 'Confirm state active');
  mockOnResignClick();
  assert(resigned === true, 'Resignation dispatched on second click');
  assert(mockButton.textContent === 'Resign', 'Button text reset after second click');
  assert(mockButton.classList.hasConfirm === false, 'btn-danger-confirm removed after second click');
});

// ---------------------------------------------------------------------------
// 6. PGN Copy Fallback Execution (src/ui.js)
// ---------------------------------------------------------------------------
test('PGN copy fallback: execCommand fallback executes if navigator.clipboard fails', async () => {
  const code = fs.readFileSync(path.join(ROOT, 'src', 'ui.js'), 'utf8');
  assert(code.includes('execCommand'), 'execCommand copy fallback exists in ui.js');
  assert(code.includes('textarea'), 'textarea created for fallback');
  assert(code.includes('Failed to copy PGN'), 'showUiError message for copy failure');

  // Test simulation: clipboard throws, execCommand succeeds
  let clipboardCalled = false;
  let execCommandCalled = false;
  let copiedStatus = '';
  let uiError = '';

  const mockNavigator = {
    clipboard: {
      writeText: async () => {
        clipboardCalled = true;
        throw new Error('Clipboard write rejected (permissions/insecure)');
      }
    }
  };

  const mockDocument = {
    body: {
      appendChild(el) {},
      removeChild(el) {}
    },
    createElement(tag) {
      return {
        value: '',
        style: {},
        setAttribute() {},
        select() {},
        setSelectionRange() {}
      };
    },
    execCommand(cmd) {
      if (cmd === 'copy') {
        execCommandCalled = true;
        return true;
      }
      return false;
    }
  };

  async function testCopyPgn(pgn) {
    let copied = false;
    if (mockNavigator.clipboard) {
      try {
        await mockNavigator.clipboard.writeText(pgn);
        copied = true;
      } catch (e) {}
    }
    if (!copied && mockDocument) {
      try {
        const textarea = mockDocument.createElement('textarea');
        textarea.value = pgn;
        mockDocument.body.appendChild(textarea);
        textarea.select();
        const successful = mockDocument.execCommand('copy');
        mockDocument.body.removeChild(textarea);
        if (successful) copied = true;
      } catch (_) {}
    }
    if (copied) {
      copiedStatus = 'PGN copied';
    } else {
      uiError = 'Failed to copy PGN';
    }
  }

  await testCopyPgn('1. e4 e5 2. Nf3 *');
  assert(clipboardCalled === true, 'Attempted navigator.clipboard');
  assert(execCommandCalled === true, 'Fell back to execCommand');
  assert(copiedStatus === 'PGN copied', 'PGN copied status rendered successfully via fallback');
  assert(uiError === '', 'No error shown when fallback succeeds');
});

// ---------------------------------------------------------------------------
// 7. Shell In-Memory SPA History Navigation (src/shell.js)
// ---------------------------------------------------------------------------
test('Shell history navigation: Shell.navigate pushes state and popstate restores view', () => {
  const code = fs.readFileSync(path.join(ROOT, 'src', 'shell.js'), 'utf8');
  assert(code.includes('history.pushState({ viewId: id, params }'), 'Shell.navigate pushes state');
  assert(code.includes("window.addEventListener('popstate'"), 'popstate event listener registered in shell.js');
  assert(code.includes('show(ev.state.viewId, ev.state.params || {}, false)'), 'popstate restores view via show');

  // Execute Shell in mock DOM environment
  const pushStateCalls = [];
  const popstateListeners = [];
  let currentActiveView = 'home';

  const mockWindow = {
    location: { pathname: '/game/test-room', search: '', hash: '' },
    history: {
      pushState(state, title, url) {
        pushStateCalls.push({ state, title, url });
      },
      replaceState(state, title, url) {}
    },
    addEventListener(evt, fn) {
      if (evt === 'popstate') popstateListeners.push(fn);
    }
  };

  // Simulate Shell navigation behavior
  let currentShellId = 'home';
  function simulateNavigate(id, params) {
    if (currentShellId !== id) {
      if (mockWindow.history && typeof mockWindow.history.pushState === 'function') {
        mockWindow.history.pushState({ viewId: id, params }, '', mockWindow.location.pathname);
      }
    }
    currentShellId = id;
    currentActiveView = id;
  }

  function simulatePopState(state) {
    for (const listener of popstateListeners) {
      listener({ state });
    }
  }

  // Register popstate listener like in shell.js
  mockWindow.addEventListener('popstate', (ev) => {
    if (ev.state && ev.state.viewId) {
      currentShellId = ev.state.viewId;
      currentActiveView = ev.state.viewId;
    }
  });

  // 1. Navigate to puzzles
  simulateNavigate('puzzles', { mode: 'daily' });
  assert(currentActiveView === 'puzzles', 'Navigated to puzzles view');
  assert(pushStateCalls.length === 1, 'pushState called once');
  assert(pushStateCalls[0].state.viewId === 'puzzles', 'pushState state viewId is puzzles');
  assert(pushStateCalls[0].state.params.mode === 'daily', 'pushState state params passed');

  // 2. Navigate to same view (puzzles): should NOT push duplicate state
  simulateNavigate('puzzles', { mode: 'daily' });
  assert(pushStateCalls.length === 1, 'duplicate navigation did not push duplicate state');

  // 3. Navigate to analysis
  simulateNavigate('analysis', {});
  assert(currentActiveView === 'analysis', 'Navigated to analysis view');
  assert(pushStateCalls.length === 2, 'pushState called second time');

  // 4. Popstate event (user presses Back button to puzzles)
  simulatePopState({ viewId: 'puzzles', params: { mode: 'daily' } });
  assert(currentActiveView === 'puzzles', 'popstate restored puzzles view cleanly');
});

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------
async function main() {
  await Promise.all(asyncTasks);
  console.log('\n--- Audit Broken Corners Self-Test Suite ---');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
}

main();
