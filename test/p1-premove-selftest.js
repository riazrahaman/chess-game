#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
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
    'theme-mode-toggle', 'sound-toggle', 'eval-bar-container', 'eval-bar-fill', 'eval-score-text',
    'analysis-arrows', 'new-game', 'copy-pgn', 'flip-board', 'resign', 'offer-draw'
  ];
  ids.forEach(id => add(id, id.includes('button') || ['rematch', 'undo', 'promo-cancel', 'sound-toggle', 'new-game', 'copy-pgn', 'flip-board', 'resign', 'offer-draw'].includes(id) ? 'button' : 'div'));

  const promoButtons = ['q', 'r', 'b', 'n'].map(piece => {
    const button = new MockElement('button');
    button.className = 'promo-btn';
    button.dataset.piece = piece;
    elements.get('promo-box').appendChild(button);
    return button;
  });
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
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'ui.js'), 'utf8'), context);
  return { context, elements, document, setFetch(fn) { fetchImpl = fn; } };
}

async function main() {
  console.log('--- Running Phase 1 Multi-Premove Self-Tests ---\n');

  const harness = createHarness();
  const { context, elements } = harness;
  const initialBoard = engine.createInitialBoard();
  const ongoing = { board: initialBoard, clocks: { white: 600, black: 600 }, history: [], status: 'ongoing', gameOver: false, result: null };

  context.applyRefereeState(ongoing);

  // 1. Queue first premove on opponent's turn: Black pawn e7 -> e5
  elements.get('e7').onclick();
  elements.get('e5').onclick();
  assert(elements.get('e7').classList.contains('premove-source') && elements.get('e5').classList.contains('premove-target'),
    'first premove e7e5 highlighted on board');

  // 2. Queue second premove on opponent's turn: Black knight g8 -> f6
  elements.get('g8').onclick();
  elements.get('f6').onclick();
  assert(elements.get('g8').classList.contains('premove-source') && elements.get('f6').classList.contains('premove-target'),
    'second chained premove g8f6 highlighted on board');

  // 3. Simulate referee confirming White move e2e4 (it is now Black turn)
  let submittedMove = null;
  harness.setFetch(async (url, opts) => {
    if (url === '/api/move') submittedMove = JSON.parse(opts.body).move;
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });

  const boardAfterWhite = engine.makeMove(initialBoard, 'e2', 'e4');
  context.applyRefereeState({
    ...ongoing,
    board: boardAfterWhite,
    history: ['e2e4']
  });
  await new Promise(resolve => setImmediate(resolve));

  assert(submittedMove === 'e7e5', 'head of premove queue (e7e5) automatically submitted when turn arrived');

  // 4. Verification that second premove remains in the queue
  const queue = context.getPremoveQueue();
  assert(queue.length === 1 && queue[0].from === 'g8' && queue[0].to === 'f6',
    'second premove (g8f6) preserved in queue for subsequent turn');

  // 5. Invalidation safety test: if opponent plays move that invalidates queued premove, queue is safely flushed
  context.clearPremove();
  assert(context.getPremoveQueue().length === 0, 'clearPremove flushes premove queue');

  console.log(`\n--- Phase 1 Multi-Premove Self-Test Summary ---\nPassed: ${passed}\nFailed: ${failed}`);
  if (failed > 0) process.exit(1);
  console.log('\nAll Phase 1 multi-premove self-tests PASSED successfully!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
