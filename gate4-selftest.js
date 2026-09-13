#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const engine = require('./engine.js');

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

class MockClassList {
  constructor(element) { this.element = element; }
  values() { return this.element.className.split(/\s+/).filter(Boolean); }
  contains(name) { return this.values().includes(name); }
  add(...names) { this.element.className = [...new Set([...this.values(), ...names])].join(' '); }
  remove(...names) { this.element.className = this.values().filter(name => !names.includes(name)).join(' '); }
  toggle(name, force) {
    const present = this.contains(name);
    const enable = force === undefined ? !present : !!force;
    if (enable) this.add(name); else this.remove(name);
    return enable;
  }
}

function createHarness() {
  const elements = new Map();
  let document;
  let fetchImpl = () => new Promise(() => {});

  class MockElement {
    constructor(tagName = 'div') {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.parentElement = null;
      this.dataset = {};
      this.attributes = {};
      this.style = {};
      this._id = '';
      this.className = '';
      this.textContent = '';
      this.innerHTML = '';
      this.tabIndex = -1;
      this.disabled = false;
      this.draggable = false;
      this.listeners = {};
      this.classList = new MockClassList(this);
    }
    set id(value) { this._id = value; if (value) elements.set(value, this); }
    get id() { return this._id; }
    get firstElementChild() { return this.children[0] || null; }
    appendChild(child) {
      if (child.parentElement) child.parentElement.children.splice(child.parentElement.children.indexOf(child), 1);
      this.children.push(child);
      child.parentElement = this;
      return child;
    }
    remove() {
      if (!this.parentElement) return;
      this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
      this.parentElement = null;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] || []).filter(item => item !== fn);
    }
    focus() { document.activeElement = this; if (this.onfocus) this.onfocus(); }
    getBoundingClientRect() { return { left: 0, top: 0, width: 80, height: 80 }; }
  }

  document = {
    activeElement: null,
    documentElement: new MockElement('html'),
    createElement: tag => new MockElement(tag),
    getElementById: id => elements.get(id) || null,
    querySelectorAll(selector) {
      const all = [...elements.values()];
      if (selector === '.promo-btn') return promoButtons;
      if (selector === '#command-controls button') return commandButtons;
      if (selector === '.square') return all.filter(el => el.classList.contains('square'));
      if (selector === '.drop-hint') return all.filter(el => el.classList.contains('drop-hint'));
      return [];
    }
  };

  function add(id, tag = 'div', className = '') {
    const element = new MockElement(tag);
    element.id = id;
    element.className = className;
    return element;
  }

  const ids = [
    'board', 'rank-labels', 'file-labels', 'info', 'status', 'timer-white', 'timer-black',
    'captured-white', 'captured-black', 'material-advantage', 'history-body', 'game-end-overlay',
    'game-end-card', 'game-end-banner', 'rematch', 'undo', 'promo-modal', 'promo-box',
    'promo-cancel', 'connection-status', 'command-status', 'retry-command', 'theme-board-select',
    'theme-mode-toggle', 'new-game', 'copy-pgn', 'flip-board', 'resign', 'offer-draw'
  ];
  ids.forEach(id => add(id, id.includes('button') || ['rematch', 'undo', 'promo-cancel', 'new-game', 'copy-pgn', 'flip-board', 'resign', 'offer-draw'].includes(id) ? 'button' : 'div'));
  elements.get('promo-modal').className = 'hidden';
  elements.get('game-end-overlay').className = 'hidden';
  elements.get('retry-command').className = 'hidden';
  elements.get('promo-modal').appendChild(elements.get('promo-box'));
  elements.get('game-end-overlay').appendChild(elements.get('game-end-card'));
  elements.get('game-end-card').appendChild(elements.get('game-end-banner'));
  elements.get('game-end-card').appendChild(elements.get('rematch'));

  const promoButtons = ['q', 'r', 'b', 'n'].map(piece => {
    const button = new MockElement('button');
    button.className = 'promo-btn';
    button.dataset.piece = piece;
    elements.get('promo-box').appendChild(button);
    return button;
  });
  elements.get('promo-box').appendChild(elements.get('promo-cancel'));
  const commandButtons = ['new-game', 'copy-pgn', 'flip-board', 'resign', 'offer-draw', 'undo'].map(id => elements.get(id));

  const storage = new Map();
  class MockEventSource {
    constructor(url) { this.url = url; this.listeners = {}; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
  }
  const context = {
    ...engine,
    document,
    Element: MockElement,
    window: { matchMedia: () => ({ matches: false }) },
    navigator: { clipboard: { writeText: async () => {} } },
    localStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, value)
    },
    EventSource: MockEventSource,
    fetch: (...args) => fetchImpl(...args),
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    console: { log() {}, warn() {}, error() {} },
    pieceSvgMarkup: (color, type) => `<svg data-piece="${color}-${type}"></svg>`,
    renderPieceSvg(container, color, type) {
      let piece = container.firstElementChild;
      if (!piece) piece = container.appendChild(new MockElement('span'));
      piece.className = 'chess-piece';
      piece.dataset.type = type;
      piece.dataset.color = color;
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8'), context);
  return { context, elements, document, promoButtons, setFetch(fn) { fetchImpl = fn; } };
}

function keyEvent(key, shiftKey = false) {
  return { key, shiftKey, prevented: false, preventDefault() { this.prevented = true; } };
}

async function main() {
  console.log('--- Running Gate 4 Accessibility Self-Tests ---\n');
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');

  assert(/id="board"[^>]*role="grid"[^>]*aria-label=/.test(html), 'board markup exposes a named ARIA grid');
  assert(/id="promo-modal"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="promo-title"/.test(html), 'promotion modal is a labelled modal dialog');
  assert(/id="game-end-overlay"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="game-end-banner"/.test(html), 'game-end overlay is a labelled modal dialog');
  assert(/id="command-status"[^>]*aria-live="assertive"/.test(html), 'command failures have an assertive live region');
  assert(/id="connection-status"[^>]*role="status"[^>]*aria-live="polite"/.test(html), 'connection changes have a polite status region');
  assert(/@media \(max-width: 720px\)/.test(html) && /@media \(max-height: 760px\)/.test(html), 'responsive rules cover mobile and short laptop viewports');
  assert(/@media \(prefers-reduced-motion: reduce\)/.test(html) && /transition-duration: 0\.01ms/.test(html), 'reduced-motion mode suppresses transitions and animations');
  assert(!/\bmakeMove\s*\(|\bcreateInitialBoard\s*\(/.test(ui), 'UI never creates or mutates an authoritative chess board locally');

  const harness = createHarness();
  const { context, elements, document, promoButtons } = harness;
  const initialBoard = engine.createInitialBoard();
  const ongoing = { board: initialBoard, clocks: { white: 600, black: 600 }, history: [], status: 'ongoing', gameOver: false, result: null };
  assert(context.applyRefereeState(ongoing) === true, 'valid referee snapshot is accepted');

  const squares = [...elements.values()].filter(el => el.classList.contains('square'));
  assert(squares.length === 64, 'referee snapshot renders exactly 64 grid cells');
  assert(squares.every(square => square.getAttribute('role') === 'gridcell'), 'every rendered square is an ARIA gridcell');
  assert(squares.every(square => Number(square.getAttribute('aria-rowindex')) >= 1 && Number(square.getAttribute('aria-colindex')) >= 1), 'every gridcell exposes row and column coordinates');
  assert(elements.get('a8').getAttribute('aria-label').includes('a8, black rook'), 'occupied-square label names coordinate, color, and piece');
  assert(elements.get('e4').getAttribute('aria-label').includes('e4, empty'), 'empty-square label names coordinate and emptiness');
  assert(squares.filter(square => square.tabIndex === 0).length === 1, 'board uses one roving keyboard tab stop');

  elements.get('a8').focus();
  const right = keyEvent('ArrowRight');
  elements.get('a8').onkeydown(right);
  assert(right.prevented && document.activeElement === elements.get('b8') && elements.get('b8').tabIndex === 0, 'ArrowRight moves roving focus one visual file');
  const down = keyEvent('ArrowDown');
  elements.get('b8').onkeydown(down);
  assert(down.prevented && document.activeElement === elements.get('b7'), 'ArrowDown moves roving focus one visual rank');
  const end = keyEvent('End');
  elements.get('b7').onkeydown(end);
  assert(end.prevented && document.activeElement === elements.get('h7'), 'End moves focus to the row boundary');

  context.setRovingSquare('e2');
  const select = keyEvent('Enter');
  elements.get('e2').onkeydown(select);
  assert(select.prevented && elements.get('e2').getAttribute('aria-selected') === 'true', 'Enter selects the side-to-move piece');
  assert(elements.get('e3').getAttribute('aria-label').includes('legal move') && elements.get('e4').getAttribute('aria-label').includes('legal move'), 'keyboard selection announces legal destinations');

  const beforeMove = JSON.stringify(ongoing.board);
  let resolveMove;
  harness.setFetch(() => new Promise(resolve => { resolveMove = resolve; }));
  const move = keyEvent(' ');
  elements.get('e4').onkeydown(move);
  assert(move.prevented && elements.get('command-status').dataset.state === 'pending', 'Space submits a legal move and announces pending state');
  assert(elements.get('board').getAttribute('aria-busy') === 'true' && elements.get('e4').getAttribute('aria-disabled') === 'true', 'pending command marks board busy and temporarily unavailable');
  assert(JSON.stringify(ongoing.board) === beforeMove && elements.get('e2').firstElementChild !== null && elements.get('e4').firstElementChild === null, 'pending keyboard move does not mutate the referee board or painted position');
  resolveMove({ ok: true, status: 200, json: async () => ({ ok: true }) });
  await new Promise(resolve => setImmediate(resolve));
  assert(elements.get('command-status').dataset.state === 'success' && elements.get('board').getAttribute('aria-busy') === 'false', 'accepted command clears busy state while awaiting snapshot truth');

  harness.setFetch(async () => { throw new Error('offline'); });
  await context.submitMoveToReferee('e2e4');
  assert(elements.get('command-status').dataset.state === 'error' && elements.get('command-status').textContent.includes('offline'), 'network failure is visibly and specifically announced');
  assert(!elements.get('retry-command').classList.contains('hidden'), 'failed command exposes an actionable retry control');
  harness.setFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
  elements.get('retry-command').onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert(elements.get('command-status').dataset.state === 'success' && elements.get('retry-command').classList.contains('hidden'), 'retry succeeds and clears the error action');

  context.setRovingSquare('e7');
  context.openPromotionDialog('e7', 'e8', 'white');
  assert(!elements.get('promo-modal').classList.contains('hidden') && document.activeElement === promoButtons[0], 'promotion dialog opens with focus on its first choice');
  elements.get('promo-cancel').focus();
  const tab = keyEvent('Tab');
  elements.get('promo-modal').onkeydown(tab);
  assert(tab.prevented && document.activeElement === promoButtons[0], 'promotion dialog contains forward Tab focus');
  const escape = keyEvent('Escape');
  elements.get('promo-modal').onkeydown(escape);
  assert(escape.prevented && elements.get('promo-modal').classList.contains('hidden') && document.activeElement === elements.get('e7'), 'Escape cancels promotion and restores board focus');

  elements.get('e7').focus();
  const terminal = { ...ongoing, gameOver: true, status: 'resigned', result: '0-1', resigned: 'white' };
  assert(context.applyRefereeState(terminal) === true && !elements.get('game-end-overlay').classList.contains('hidden'), 'terminal referee snapshot opens the game-end dialog');
  assert(document.activeElement === elements.get('rematch') && elements.get('game-end-banner').textContent.includes('Black wins'), 'game-end dialog receives focus and announces the result');
  const terminalEscape = keyEvent('Escape');
  elements.get('game-end-overlay').onkeydown(terminalEscape);
  assert(terminalEscape.prevented && !elements.get('game-end-overlay').classList.contains('hidden') && document.activeElement === elements.get('rematch'), 'Escape predictably keeps the authoritative terminal dialog open');
  context.applyRefereeState(ongoing);
  assert(elements.get('game-end-overlay').classList.contains('hidden') && document.activeElement === elements.get('e7'), 'new referee game state closes dialog and restores prior focus');

  const preservedLabel = elements.get('a8').getAttribute('aria-label');
  assert(context.applyRefereeState({ board: { turn: 'white', pieces: {} } }) === false, 'malformed referee snapshot is rejected without throwing');
  assert(elements.get('a8').getAttribute('aria-label') === preservedLabel, 'malformed snapshot leaves the last valid board untouched');
  assert(elements.get('connection-status').textContent.includes('Invalid referee data'), 'malformed snapshot is visibly announced');
  assert(context.handleSSEStateEvent(null) === false, 'missing SSE snapshot is rejected without disturbing UI state');

  context.setConnectionState('reconnecting', 'Live updates interrupted. Reconnecting…');
  assert(elements.get('connection-status').dataset.state === 'reconnecting' && elements.get('connection-status').textContent.includes('Reconnecting'), 'reconnect fallback is visible and announced');
  context.setConnectionState('connected', 'Connected to referee.');
  assert(elements.get('connection-status').dataset.state === 'connected', 'successful recovery returns connection status to connected');

  // --- UX Polish Tests: Pre-moves, Escape, and Touch ---
  // On White's turn, select Black piece e7, target e5
  elements.get('e7').onclick();
  elements.get('e5').onclick();
  assert(elements.get('e7').classList.contains('premove-source') && elements.get('e5').classList.contains('premove-target'), 'premove on opponent turn highlights premove source and target');

  // Pressing Escape clears premove highlights
  const escPremove = keyEvent('Escape');
  elements.get('e7').onkeydown(escPremove);
  assert(escPremove.prevented && !elements.get('e7').classList.contains('premove-source') && !elements.get('e5').classList.contains('premove-target'), 'Escape key clears queued premove');

  // Queue premove e7e5 again
  elements.get('e7').onclick();
  elements.get('e5').onclick();

  // Simulating move submission on referee state update to Black turn
  let submittedPremove = null;
  harness.setFetch(async (url, opts) => {
    if (url === '/api/move') submittedPremove = JSON.parse(opts.body).move;
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });

  const nextStateBlack = {
    ...ongoing,
    board: {
      turn: 'black',
      pieces: { ...ongoing.board.pieces }
    }
  };
  context.applyRefereeState(nextStateBlack);
  await new Promise(resolve => setImmediate(resolve));
  assert(submittedPremove === 'e7e5', 'premove automatically submits to referee when turn updates to opponent color');

  console.log(`\n--- Gate 4 Self-Test Summary ---\nPassed: ${passed}\nFailed: ${failed}`);
  if (failed > 0) process.exit(1);
  console.log('\nAll Gate 4 accessibility self-tests PASSED successfully!');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
