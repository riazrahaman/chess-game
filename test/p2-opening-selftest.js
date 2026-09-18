#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const engine = require('../src/engine.js');
const openings = require('../src/openings-db.js');

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

console.log('=== Test Suite 1: ECO Opening Database Lookups ===');

// 1. Initial starting position
const startOpening = openings.findOpening([]);
assert(startOpening.eco === 'A00', `Initial position is A00 (got ${startOpening.eco})`);
assert(startOpening.name.includes('Starting Position'), `Initial position title correct: ${startOpening.name}`);
assert(startOpening.popularMoves === undefined && startOpening.stats === undefined, 'No fabricated popularMoves/stats on the initial position (E3)');

// 2. 1. e4
const e4Opening = openings.findOpening(['e2e4']);
assert(e4Opening.eco === 'B00', `1. e4 is B00 King's Pawn (got ${e4Opening.eco})`);

// 3. Italian Game: 1. e4 e5 2. Nf3 Nc6 3. Bc4
const italian = openings.findOpening(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4']);
assert(italian.eco === 'C50', `Italian game is C50 (got ${italian.eco})`);
assert(italian.name.includes('Italian Game'), `Name is Italian Game: ${italian.name}`);
assert(italian.isExact === true, 'Italian line is exact match');

// 4. Queen's Gambit: 1. d4 d5 2. c4
const qg = openings.findOpening(['d2d4', 'd7d5', 'c2c4']);
assert(qg.eco === 'D06', `Queen's Gambit is D06 (got ${qg.eco})`);

// 5. Deep prefix match for unknown move extension
const extendedItalian = openings.findOpening(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'h7h6']);
assert(extendedItalian.eco === 'C50', `Extended line falls back to Italian C50 (got ${extendedItalian.eco})`);
assert(extendedItalian.matchedPlies === 5, `Matched 5 plies prefix (got ${extendedItalian.matchedPlies})`);
assert(extendedItalian.isExact === false, 'Marked as non-exact prefix match');

console.log('\n=== Test Suite 2: SVG Advantage Graph Mathematics ===');

const testEvals = [0, 50, -30, 200, -150];
const graphData = openings.generateEvalGraphData(testEvals, 400, 80);

assert(graphData.points.length === 5, `Generated 5 points for 5 evals (got ${graphData.points.length})`);
assert(graphData.zeroY === 40, `Zero line is at height / 2 = 40 (got ${graphData.zeroY})`);
assert(graphData.points[0].y === 40, `0 cp is on zero line y=40 (got ${graphData.points[0].y})`);
assert(graphData.points[1].y < 40, `Positive cp (+50) is above zero line y < 40 (got ${graphData.points[1].y})`);
assert(graphData.points[2].y > 40, `Negative cp (-30) is below zero line y > 40 (got ${graphData.points[2].y})`);
assert(graphData.pathData.startsWith('M'), `Path data starts with Move command 'M' (got ${graphData.pathData.slice(0, 10)})`);
assert(graphData.pathData.includes('L'), 'Path data includes Line commands');

// Clamping test
const extremeData = openings.generateEvalGraphData([2500, -3000], 400, 80);
assert(extremeData.points[0].y >= 8 && extremeData.points[0].y <= 40, 'Clamped extreme positive eval within upper canvas');
assert(extremeData.points[1].y <= 72 && extremeData.points[1].y >= 40, 'Clamped extreme negative eval within lower canvas');

console.log('\n=== Test Suite 3: UI Integration & Explorer/Graph DOM Simulation ===');

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
      this._innerHTML = '';
      this.tabIndex = -1;
      this.disabled = false;
      this.draggable = false;
      this.listeners = {};
      this.classList = new MockClassList(this);
    }
    set innerHTML(val) {
      this._innerHTML = val;
      if (val === '') {
        this.children = [];
      }
    }
    get innerHTML() { return this._innerHTML; }
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
    'theme-mode-toggle', 'sound-toggle', 'haptics-toggle', 'eval-bar-container', 'eval-bar-fill', 'eval-score-text',
    'analysis-arrows', 'new-game', 'copy-pgn', 'flip-board', 'resign', 'offer-draw',
    'scrub-start', 'scrub-prev', 'scrub-next', 'scrub-end', 'multipv-container', 'multipv-select',
    'multipv-lines', 'review-panel', 'white-accuracy', 'black-accuracy', 'classification-summary',
    'game-review-btn', 'close-review', 'explorer-panel', 'opening-eco-badge', 'opening-name',
    'opening-moves-list',
    'graph-panel', 'eval-graph-container', 'eval-graph-svg'
  ];

  ids.forEach(id => add(id, id.includes('button') || ['rematch', 'undo', 'promo-cancel', 'sound-toggle', 'haptics-toggle', 'new-game', 'copy-pgn', 'flip-board', 'resign', 'offer-draw', 'scrub-start', 'scrub-prev', 'scrub-next', 'scrub-end', 'game-review-btn', 'close-review'].includes(id) ? 'button' : id.includes('select') ? 'select' : id === 'eval-graph-svg' ? 'svg' : 'div'));

  const promoButtons = ['q', 'r', 'b', 'n'].map(piece => {
    const button = new MockElement('button');
    button.className = 'promo-btn';
    button.dataset.piece = piece;
    elements.get('promo-box').appendChild(button);
    return button;
  });
  const commandButtons = ['rematch', 'undo'].map(id => elements.get(id));

  document = {
    activeElement: null,
    documentElement: new MockElement('html'),
    createElement: tag => new MockElement(tag),
    createElementNS: (ns, tag) => new MockElement(tag),
    getElementById: id => elements.get(id) || null,
    createTextNode: (text) => {
      const el = new MockElement('text');
      el.textContent = text;
      return el;
    },
    querySelectorAll(selector) {
      const all = [...elements.values()];
      if (selector === '.promo-btn') return promoButtons;
      if (selector === '#command-controls button') return commandButtons;
      if (selector === '.square') return all.filter(el => el.classList.contains('square'));
      if (selector === '.drop-hint') return all.filter(el => el.classList.contains('drop-hint'));
      return [];
    }
  };

  const windowListeners = {};
  const context = {
    console,
    document,
    window: {
      addEventListener(type, fn) { (windowListeners[type] ||= []).push(fn); },
      removeEventListener(type, fn) { windowListeners[type] = (windowListeners[type] || []).filter(h => h !== fn); },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      dispatchEvent: () => true,
      Openings: openings
    },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    EventSource: class {
      addEventListener() {}
      close() {}
    },
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: () => 1,
    clearInterval: () => {},
    AudioContext: class {
      createOscillator() { return { type: '', frequency: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: () => {}, start: () => {}, stop: () => {} }; }
      createGain() { return { gain: { setValueAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: () => {} }; }
      get destination() { return {}; }
      get currentTime() { return 0; }
    },
    navigator: { vibrate: () => true },
    Worker: class {
      postMessage() {}
      terminate() {}
    },
    Openings: openings,
    ...engine,
    renderPieceSvg(container, color, type) {
      let piece = container.firstElementChild;
      if (!piece) piece = container.appendChild(new MockElement('span'));
      piece.className = 'chess-piece';
      piece.dataset.type = type;
      piece.dataset.color = color;
    }
  };

  vm.createContext(context);
  const uiCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui.js'), 'utf8');
  vm.runInContext(uiCode, context);

  return { context, elements };
}

const { context, elements } = createHarness();

assert(typeof context.window.updateOpeningExplorerUI === 'function', 'updateOpeningExplorerUI is exposed on window');
assert(typeof context.window.updateEvalGraphUI === 'function', 'updateEvalGraphUI is exposed on window');

// Test initial opening explorer render
context.window.updateOpeningExplorerUI();
const ecoBadge = elements.get('opening-eco-badge');
const nameEl = elements.get('opening-name');
assert(ecoBadge.textContent === 'A00', `Initial ECO badge is A00 (got ${ecoBadge.textContent})`);
assert(nameEl.textContent.includes('Starting Position'), `Initial name is Starting Position: ${nameEl.textContent}`);

// Set up a 4-ply game
let b = engine.createInitialBoard();
b = engine.makeMove(b, 'e2', 'e4');
b = engine.makeMove(b, 'e7', 'e5');
b = engine.makeMove(b, 'g1', 'f3');
b = engine.makeMove(b, 'b8', 'c6');

context.applyRefereeState({
  board: b,
  clocks: { white: 600, black: 600 },
  history: ['e2e4', 'e7e5', 'g1f3', 'b8c6'],
  status: 'ongoing',
  gameOver: false,
  result: null
});

// Test initial graph render with 5 evals (plies 0 to 4)
context.window.setEvalHistory([0, 40, 20, 80, 50]);
context.window.updateEvalGraphUI();

const svgEl = elements.get('eval-graph-svg');
assert(svgEl.children.length > 0, `Graph SVG rendered child elements (${svgEl.children.length})`);

// Find dots and zero line in SVG children
const zeroLine = svgEl.children.find(c => c.attributes.class === 'graph-zero-line');
assert(zeroLine !== undefined, 'Zero line rendered in SVG graph');

const dots = svgEl.children.filter(c => c.attributes.class === 'graph-dot');
assert(dots.length === 5, `Rendered 5 dots for 5 evaluation steps (got ${dots.length})`);

// Test jumping to ply via dot click
assert(typeof dots[2].onclick === 'function', 'Dot has onclick handler');
dots[2].onclick();
assert(context.window.getViewedPly() === 2, `Clicking dot jumped to ply 2 (got ${context.window.getViewedPly()})`);

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
