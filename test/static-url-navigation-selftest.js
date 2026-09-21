#!/usr/bin/env node
'use strict';

/**
 * static-url-navigation-selftest.js
 *
 * Verifies that site shell navigation between sections (Play, Analysis,
 * Puzzles, Coordinates, Library, Study, Compete, Profile, About, Home) is
 * in-memory and keeps the browser URL static (matching agent-kanban architecture).
 *
 * Checks:
 * 1. Gate 4 invariant: zero makeMove( or createInitialBoard( in src/shell.js or src/ui.js.
 * 2. Shell in-memory navigation: Shell.navigate(id, params) switches view without mutating window.location.hash.
 * 3. Deep link hash on initial boot: respected on initial load, then cleanly stripped via replaceState.
 * 4. Nav links and hash-link clicks: intercepted with preventDefault and handled in-memory without hash mutation.
 * 5. Non-route in-page anchors (e.g. #workspace): not intercepted, allowed default behavior.
 * 6. ui.js initRoomRouting & one-shot cleanup: preserves /game/<room> without appending #/play or route hashes.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

// 1. Gate 4 Architectural Invariant
test('Gate 4: src/shell.js and src/ui.js make no calls to makeMove or createInitialBoard', () => {
  const shellCode = fs.readFileSync(path.join(ROOT, 'src', 'shell.js'), 'utf8');
  const uiCode = fs.readFileSync(path.join(ROOT, 'src', 'ui.js'), 'utf8');
  const forbidden = [/\bmakeMove\s*\(/, /\bcreateInitialBoard\s*\(/];
  for (const pat of forbidden) {
    assert(!pat.test(shellCode), `Gate 4 violation in shell.js: ${pat}`);
    assert(!pat.test(uiCode), `Gate 4 violation in ui.js: ${pat}`);
  }
});

// Helper to create a mocked DOM environment for shell.js
function createMockEnv(initialUrl, initialHash, opts) {
  let currentUrl = initialUrl || 'https://chess.riazrahaman.com/game/game-test123';
  let currentHash = initialHash || '';
  const listeners = { click: [], hashchange: [], DOMContentLoaded: [] };
  const elements = new Map();

  class MockElement {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.attributes = new Map();
      this.children = [];
      this.hidden = false;
      this.textContent = '';
      this._innerHTML = '';
      this.eventListeners = {};
    }
    setAttribute(name, val) { this.attributes.set(name, String(val)); }
    getAttribute(name) { return this.attributes.get(name) || null; }
    removeAttribute(name) { this.attributes.delete(name); }
    appendChild(child) { this.children.push(child); return child; }
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) this.children.splice(idx, 1);
      return child;
    }
    querySelector(sel) {
      if (sel.startsWith('[data-view="')) {
        const id = sel.slice(12, -2);
        return elements.get('view:' + id) || null;
      }
      return null;
    }
    querySelectorAll(sel) {
      if (sel === '[data-view]') {
        return Array.from(elements.entries())
          .filter(([k]) => k.startsWith('view:'))
          .map(([, v]) => v);
      }
      if (sel === '.shell-placeholder') return [];
      if (sel === '[data-home-action]') return [];
      return [];
    }
    addEventListener(evt, fn) {
      this.eventListeners[evt] = this.eventListeners[evt] || [];
      this.eventListeners[evt].push(fn);
    }
    dispatchEvent(evt) {
      const list = this.eventListeners[evt.type] || [];
      for (const fn of list) fn(evt);
    }
    closest(sel) {
      if (sel === 'a[href^="#/"]') {
        if (this.tagName === 'A') {
          const href = this.getAttribute('href') || '';
          if (href.startsWith('#/')) return this;
        }
      }
      if (sel === 'a[href^="#"]') {
        if (this.tagName === 'A') {
          const href = this.getAttribute('href') || '';
          if (href.startsWith('#')) return this;
        }
      }
      return null;
    }
    get childElementCount() { return this.children.length; }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(val) { this._innerHTML = val; this.children = []; }
  }

  const documentBody = new MockElement('body');
  const viewsHost = new MockElement('div');
  viewsHost.setAttribute('id', 'views');
  const shellNav = new MockElement('nav');
  shellNav.setAttribute('id', 'shell-nav');

  // Pre-populate standard views: play and home
  const playSection = new MockElement('section');
  playSection.setAttribute('data-view', 'play');
  elements.set('view:play', playSection);

  const homeSection = new MockElement('section');
  homeSection.setAttribute('data-view', 'home');
  elements.set('view:home', homeSection);

  const document = {
    body: documentBody,
    readyState: 'complete',
    title: '',
    createElement(tag) { return new MockElement(tag); },
    getElementById(id) {
      if (id === 'shell-nav') return shellNav;
      if (id === 'views') return viewsHost;
      return null;
    },
    querySelector(sel) {
      if (sel.startsWith('[data-view="')) {
        const id = sel.slice(12, -2);
        return elements.get('view:' + id) || null;
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '[data-view]') {
        return Array.from(elements.entries())
          .filter(([k]) => k.startsWith('view:'))
          .map(([, v]) => v);
      }
      return [];
    },
    addEventListener(evt, fn) {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(fn);
    },
    dispatchEvent(evt) {
      const list = listeners[evt.type] || [];
      for (const fn of list) fn(evt);
    }
  };

  const parsedUrl = new URL(currentUrl);
  const location = {
    get href() { return parsedUrl.origin + parsedUrl.pathname + parsedUrl.search + currentHash; },
    get pathname() { return parsedUrl.pathname; },
    get search() { return parsedUrl.search; },
    get origin() { return parsedUrl.origin; },
    get hash() { return currentHash; },
    set hash(val) { currentHash = val; }
  };

  function applyHistoryUrl(url) {
    if (!url) return;
    if (url.startsWith('/')) {
      const withoutHash = url.split('#')[0];
      const qIdx = withoutHash.indexOf('?');
      parsedUrl.pathname = qIdx === -1 ? withoutHash : withoutHash.slice(0, qIdx);
      parsedUrl.search = qIdx === -1 ? '' : withoutHash.slice(qIdx);
    }
    const hashIdx = url.indexOf('#');
    currentHash = hashIdx !== -1 ? url.slice(hashIdx) : '';
  }

  const replaceStateCalls = [];
  const pushStateCalls = [];
  const history = {
    replaceState(state, title, url) {
      replaceStateCalls.push({ state, title, url });
      applyHistoryUrl(url);
    },
    pushState(state, title, url) {
      pushStateCalls.push({ state, title, url });
      applyHistoryUrl(url);
    }
  };

  const localStorageStore = new Map(Object.entries((opts && opts.localStorage) || {}));
  const localStorage = {
    getItem(key) { return localStorageStore.has(key) ? localStorageStore.get(key) : null; },
    setItem(key, value) { localStorageStore.set(key, String(value)); },
    removeItem(key) { localStorageStore.delete(key); }
  };

  const window = {
    document,
    location,
    history,
    localStorage,
    addEventListener(evt, fn) {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(fn);
    }
  };

  return { window, document, location, history, localStorage, localStorageStore, replaceStateCalls, pushStateCalls, elements, listeners, shellNav };
}

// Loads src/ui.js into a fresh vm context and returns the context plus the mock
// env. ui.js drives /api/* through fetch and an EventSource at load time, so the
// context stubs both; localStorage seeds the stored personal room.
function loadUiEnv(initialUrl, opts) {
  const env = createMockEnv(initialUrl, '', opts);
  env.window.navigator = { clipboard: { writeText: async () => {} } };
  const context = {
    window: env.window,
    document: env.document,
    navigator: env.window.navigator,
    URLSearchParams,
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
    EventSource: function MockEventSource() {
      this.addEventListener = () => {};
      this.close = () => {};
    },
    console: { log() {}, warn() {}, error() {} }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'ui.js'), 'utf8'), context);
  return { context, env };
}

// 2. Initial page load on /game/<room> without hash lands on Play with static URL
test('initial boot on /game/<room> lands on play view with no hash in URL', () => {
  const env = createMockEnv('https://chess.riazrahaman.com/game/game-room1', '');
  const shellCode = fs.readFileSync(path.join(ROOT, 'src', 'shell.js'), 'utf8');

  vm.runInNewContext(shellCode, {
    window: env.window,
    document: env.document,
    console
  });

  const Shell = env.window.Shell;
  assert(Shell, 'Shell global exported');
  assert(Shell.current() === 'play', `Expected current view 'play', got ${Shell.current()}`);
  assert(env.location.hash === '', `Expected empty hash, got ${env.location.hash}`);
  assert(env.elements.get('view:play').hidden === false, 'play view should be visible');
});

// 3. Shell.navigate switches view in-memory without changing location.hash or URL
test('Shell.navigate switches view in-memory and keeps location.hash clean and URL static', () => {
  const env = createMockEnv('https://chess.riazrahaman.com/game/game-room1', '');
  const shellCode = fs.readFileSync(path.join(ROOT, 'src', 'shell.js'), 'utf8');

  vm.runInNewContext(shellCode, {
    window: env.window,
    document: env.document,
    console
  });

  const Shell = env.window.Shell;
  let mountedPuzzles = false;
  let shownPuzzles = false;

  Shell.registerView({
    id: 'puzzles',
    title: 'Puzzles',
    mount() { mountedPuzzles = true; },
    show() { shownPuzzles = true; }
  });

  Shell.navigate('puzzles');

  assert(Shell.current() === 'puzzles', 'current view should be puzzles');
  assert(mountedPuzzles, 'puzzles should be mounted');
  assert(shownPuzzles, 'puzzles should be shown');
  assert(env.location.hash === '', `URL hash must remain empty, got: ${env.location.hash}`);
  assert(env.location.pathname === '/game/game-room1', 'pathname remains /game/game-room1');

  // Verify play view was hidden
  assert(env.elements.get('view:play').hidden === true, 'play view should be hidden');
});

// 4. Initial boot with deep link hash: respects view, then strips hash from URL
test('initial boot with deep link #/analysis shows analysis view and strips hash via replaceState', () => {
  const env = createMockEnv('https://chess.riazrahaman.com/game/game-room1', '#/analysis');
  const shellCode = fs.readFileSync(path.join(ROOT, 'src', 'shell.js'), 'utf8');

  vm.runInNewContext(shellCode, {
    window: env.window,
    document: env.document,
    console
  });

  const Shell = env.window.Shell;
  assert(Shell.current() === 'analysis', `Expected current view 'analysis', got ${Shell.current()}`);
  assert(env.location.hash === '', 'hash should be cleanly stripped via replaceState');
  assert(env.replaceStateCalls.length > 0, 'replaceState should have been called');
  assert(env.replaceStateCalls[env.replaceStateCalls.length - 1].url === '/game/game-room1',
    `replaceState url should be /game/game-room1, got ${env.replaceStateCalls[env.replaceStateCalls.length - 1].url}`);
});

// 5. In-document link click interception
test('clicking a[href^="#/"] triggers in-memory navigation without mutating location.hash', () => {
  const env = createMockEnv('https://chess.riazrahaman.com/game/game-room1', '');
  const shellCode = fs.readFileSync(path.join(ROOT, 'src', 'shell.js'), 'utf8');

  vm.runInNewContext(shellCode, {
    window: env.window,
    document: env.document,
    console
  });

  const Shell = env.window.Shell;
  let libraryMounted = false;
  Shell.registerView({
    id: 'library',
    title: 'Library',
    mount() { libraryMounted = true; }
  });

  // Create a link simulating a nav link or card
  const link = env.document.createElement('a');
  link.setAttribute('href', '#/library');

  let defaultPrevented = false;
  const clickEvent = {
    type: 'click',
    target: link,
    button: 0,
    defaultPrevented: false,
    preventDefault() { defaultPrevented = true; this.defaultPrevented = true; }
  };

  env.document.dispatchEvent(clickEvent);

  assert(defaultPrevented, 'click event default should be prevented');
  assert(Shell.current() === 'library', `Expected current view 'library', got ${Shell.current()}`);
  assert(libraryMounted, 'library view should have mounted');
  assert(env.location.hash === '', `location.hash must stay empty, got: ${env.location.hash}`);
});

// 6. In-page anchor (e.g. #workspace) is NOT intercepted
test('clicking in-page non-route anchor (e.g. #workspace) is not prevented', () => {
  const env = createMockEnv('https://chess.riazrahaman.com/game/game-room1', '');
  const shellCode = fs.readFileSync(path.join(ROOT, 'src', 'shell.js'), 'utf8');

  vm.runInNewContext(shellCode, {
    window: env.window,
    document: env.document,
    console
  });

  const Shell = env.window.Shell;
  const link = env.document.createElement('a');
  link.setAttribute('href', '#workspace');

  let defaultPrevented = false;
  const clickEvent = {
    type: 'click',
    target: link,
    button: 0,
    defaultPrevented: false,
    preventDefault() { defaultPrevented = true; this.defaultPrevented = true; }
  };

  env.document.dispatchEvent(clickEvent);

  assert(!defaultPrevented, 'in-page anchor click should not be prevented');
  assert(Shell.current() === 'play', 'current view remains play');
});

// 7. Navigation with params works in-memory without putting params into URL
test('Shell.navigate with params passes params to view without polluting browser URL', () => {
  const env = createMockEnv('https://chess.riazrahaman.com/game/game-room1', '');
  const shellCode = fs.readFileSync(path.join(ROOT, 'src', 'shell.js'), 'utf8');

  vm.runInNewContext(shellCode, {
    window: env.window,
    document: env.document,
    console
  });

  const Shell = env.window.Shell;
  let receivedParams = null;
  Shell.registerView({
    id: 'compete',
    title: 'Compete',
    mount(el, params) { receivedParams = params; },
    show(el, params) { receivedParams = params; }
  });

  Shell.navigate('compete', { tab: 'arenas' });

  assert(Shell.current() === 'compete', 'current view is compete');
  assert(receivedParams && receivedParams.tab === 'arenas', 'params received by view');
  assert(env.location.hash === '', 'location.hash remains empty');
  assert(env.location.pathname === '/game/game-room1', 'pathname remains /game/game-room1');
});

// 8. ui.js initRoomRouting does not append #/... hash
test('ui.js initRoomRouting does not append #/route hash into URL', () => {
  const uiSrc = fs.readFileSync(path.join(ROOT, 'src', 'ui.js'), 'utf8');
  assert(!uiSrc.includes("replaceState(null, '', '/game/' + encodeURIComponent(personalRoom) + window.location.hash);"),
    'ui.js must not append window.location.hash in initRoomRouting');
  assert(!uiSrc.includes("window.location.search + '#/play'"),
    'ui.js must not force #/play hash on one-shot cleanup');
});

// 9. (a) A plain root visit must not rewrite the URL to /game/<room>.
test('ui.js initRoomRouting leaves a plain root visit at / with no /game/ replaceState', () => {
  const { env } = loadUiEnv('https://chess.riazrahaman.com/', {
    localStorage: { chess_personal_room: 'game-existing1' }
  });

  const gameRewrites = env.replaceStateCalls.filter(c => typeof c.url === 'string' && c.url.startsWith('/game/'));
  assert(gameRewrites.length === 0,
    `root visit must not replaceState to /game/...; got ${JSON.stringify(env.replaceStateCalls)}`);
  assert(env.location.pathname === '/', `pathname must stay '/', got ${env.location.pathname}`);
  assert(env.localStorageStore.get('chess_personal_room') === 'game-existing1', 'stored personal room preserved');
});

// 10. (a-mint) A first-ever root visit still mints a personal room into storage.
test('ui.js initRoomRouting mints and persists a personal room on a first bare root visit', () => {
  const { env } = loadUiEnv('https://chess.riazrahaman.com/', { localStorage: {} });
  const minted = env.localStorageStore.get('chess_personal_room');
  assert(minted && /^[a-zA-Z0-9_-]+$/.test(minted), `expected a minted personal room, got ${minted}`);
  const gameRewrites = env.replaceStateCalls.filter(c => typeof c.url === 'string' && c.url.startsWith('/game/'));
  assert(gameRewrites.length === 0, 'minting must not rewrite the URL to /game/...');
});

// 11. (b) getCurrentRoomId on a bare / uses the stored personal room, else 'default'.
test('ui.js getCurrentRoomId resolves the stored personal room on a bare root, else default', () => {
  const withRoom = loadUiEnv('https://chess.riazrahaman.com/', {
    localStorage: { chess_personal_room: 'game-personal9' }
  });
  assert(withRoom.context.window.getCurrentRoomId() === 'game-personal9',
    `expected stored room game-personal9, got ${withRoom.context.window.getCurrentRoomId()}`);

  // A bare root mints a room at load; clear it to isolate the no-stored-room
  // fallback in getCurrentRoomId itself.
  const withoutRoom = loadUiEnv('https://chess.riazrahaman.com/', { localStorage: {} });
  withoutRoom.env.localStorageStore.delete('chess_personal_room');
  assert(withoutRoom.context.window.getCurrentRoomId() === 'default',
    `expected default with no stored room, got ${withoutRoom.context.window.getCurrentRoomId()}`);
});

// 12. (c) withRoomParam scopes API calls to the personal room, or leaves them bare.
test('ui.js withRoomParam appends ?room=<personal> and leaves default urls untouched', () => {
  const withRoom = loadUiEnv('https://chess.riazrahaman.com/', {
    localStorage: { chess_personal_room: 'game-personal9' }
  });
  assert(withRoom.context.window.withRoomParam('/api/state') === '/api/state?room=game-personal9',
    `expected /api/state?room=game-personal9, got ${withRoom.context.window.withRoomParam('/api/state')}`);

  const withoutRoom = loadUiEnv('https://chess.riazrahaman.com/', { localStorage: {} });
  withoutRoom.env.localStorageStore.delete('chess_personal_room');
  assert(withoutRoom.context.window.withRoomParam('/api/state') === '/api/state',
    `expected bare /api/state for default, got ${withoutRoom.context.window.withRoomParam('/api/state')}`);
});

// 13. (d) shell.js lands on home for a bare root regardless of stored room;
// /game/<room> still lands on play. This pins the preserved landing behavior:
// the card only changes the URL, not which view a plain visit shows.
test('shell.js lands on home for a bare root (stored room or not), play for /game/<room>', () => {
  const shellCode = fs.readFileSync(path.join(ROOT, 'src', 'shell.js'), 'utf8');

  const rootWithRoom = createMockEnv('https://chess.riazrahaman.com/', '', {
    localStorage: { chess_personal_room: 'game-existing1' }
  });
  vm.runInNewContext(shellCode, { window: rootWithRoom.window, document: rootWithRoom.document, console });
  assert(rootWithRoom.window.Shell.current() === 'home',
    `expected home for a bare root even with a stored room, got ${rootWithRoom.window.Shell.current()}`);
  assert(rootWithRoom.location.pathname === '/', 'root pathname must remain /');

  const rootWithoutRoom = createMockEnv('https://chess.riazrahaman.com/', '', { localStorage: {} });
  vm.runInNewContext(shellCode, { window: rootWithoutRoom.window, document: rootWithoutRoom.document, console });
  assert(rootWithoutRoom.window.Shell.current() === 'home',
    `expected home with no stored room, got ${rootWithoutRoom.window.Shell.current()}`);

  const gameRoom = createMockEnv('https://chess.riazrahaman.com/game/game-room1', '', {
    localStorage: { chess_personal_room: 'game-existing1' }
  });
  vm.runInNewContext(shellCode, { window: gameRoom.window, document: gameRoom.document, console });
  assert(gameRoom.window.Shell.current() === 'play',
    `expected play for /game/<room>, got ${gameRoom.window.Shell.current()}`);
});

// 14. (e) An explicit ?room= link still wins over any stored personal room.
test('ui.js getCurrentRoomId lets an explicit ?room= win over the stored room', () => {
  const { context } = loadUiEnv('https://chess.riazrahaman.com/?room=xyz', {
    localStorage: { chess_personal_room: 'game-existing1' }
  });
  assert(context.window.getCurrentRoomId() === 'xyz',
    `expected ?room=xyz to win, got ${context.window.getCurrentRoomId()}`);
});

// 15. (f) A ?room= share link lands on the board; a bare root still lands on home.
test('shell.js lands on play for /?room=xyz, home for a bare root, play for /game/<room>', () => {
  const shellCode = fs.readFileSync(path.join(ROOT, 'src', 'shell.js'), 'utf8');

  const share = createMockEnv('https://chess.riazrahaman.com/?room=xyz', '', {
    localStorage: { chess_personal_room: 'game-mine' }
  });
  vm.runInNewContext(shellCode, { window: share.window, document: share.document, console, URLSearchParams });
  assert(share.window.Shell.current() === 'play',
    `expected play for /?room=xyz, got ${share.window.Shell.current()}`);

  const root = createMockEnv('https://chess.riazrahaman.com/', '', {
    localStorage: { chess_personal_room: 'game-mine' }
  });
  vm.runInNewContext(shellCode, { window: root.window, document: root.document, console, URLSearchParams });
  assert(root.window.Shell.current() === 'home',
    `expected home for a bare root, got ${root.window.Shell.current()}`);

  const gamePath = createMockEnv('https://chess.riazrahaman.com/game/game-room1', '');
  vm.runInNewContext(shellCode, { window: gamePath.window, document: gamePath.document, console, URLSearchParams });
  assert(gamePath.window.Shell.current() === 'play',
    `expected play for /game/<room>, got ${gamePath.window.Shell.current()}`);
});

// 16. (g) In-app navigation on a /?room= page must not erase the query string.
test('Shell.navigate keeps ?room=xyz in the URL and the room resolves to xyz afterwards', () => {
  const shellCode = fs.readFileSync(path.join(ROOT, 'src', 'shell.js'), 'utf8');
  const env = createMockEnv('https://chess.riazrahaman.com/?room=xyz', '', {
    localStorage: { chess_personal_room: 'game-mine' }
  });
  env.window.navigator = {};
  vm.runInNewContext(shellCode, { window: env.window, document: env.document, console, URLSearchParams });

  const Shell = env.window.Shell;
  assert(Shell.current() === 'play', 'share link boots on play');
  // Boot already landed on play, so navigate to a sibling view: the first real
  // in-memory navigation is what used to drop the query string.
  Shell.registerView({ id: 'library', title: 'Library' });
  Shell.navigate('library', {});

  assert(env.pushStateCalls.length > 0, 'navigate should push a history entry');
  const pushed = env.pushStateCalls[env.pushStateCalls.length - 1].url;
  assert(typeof pushed === 'string' && pushed.includes('room=xyz'),
    `pushState url must keep room=xyz, got ${pushed}`);
  assert(env.location.search === '?room=xyz', `location.search must stay ?room=xyz, got ${env.location.search}`);

  // (h) The strongest integration check: after navigating, ui.js still resolves
  // the shared room xyz rather than the recipient's own stored game-mine.
  const uiContext = {
    window: env.window,
    document: env.document,
    navigator: env.window.navigator,
    URLSearchParams,
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
    EventSource: function MockEventSource() { this.addEventListener = () => {}; this.close = () => {}; },
    console: { log() {}, warn() {}, error() {} }
  };
  vm.createContext(uiContext);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'ui.js'), 'utf8'), uiContext);
  assert(uiContext.window.getCurrentRoomId() === 'xyz',
    `expected xyz after navigate, got ${uiContext.window.getCurrentRoomId()}`);
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
