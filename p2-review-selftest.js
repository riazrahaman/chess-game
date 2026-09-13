#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const engine = require('./engine.js');
const moveReview = require('./move-review.js');

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

console.log('=== Test Suite 1: Win Probability & Move Accuracy Mathematics ===');

// 1. calculateWinProbability
const probEqual = moveReview.calculateWinProbability(0);
assert(Math.abs(probEqual - 50) < 0.1, `0 cp is 50% win probability (got ${probEqual.toFixed(2)})`);

const probWhiteAdv = moveReview.calculateWinProbability(500);
assert(probWhiteAdv > 80, `+500 cp is >80% win probability (got ${probWhiteAdv.toFixed(2)})`);

const probBlackAdv = moveReview.calculateWinProbability(-500);
assert(probBlackAdv < 20, `-500 cp is <20% win probability (got ${probBlackAdv.toFixed(2)})`);

// 2. calculateDeltaWinProb
const deltaWhiteZero = moveReview.calculateDeltaWinProb(100, 100, true);
assert(Math.abs(deltaWhiteZero) < 0.01, `Delta win prob is 0 for identical evals (got ${deltaWhiteZero})`);

const deltaWhiteBlunder = moveReview.calculateDeltaWinProb(100, -300, true);
assert(deltaWhiteBlunder > 30, `Delta win prob >30% for blunder from +100 to -300 (got ${deltaWhiteBlunder.toFixed(2)})`);

const deltaBlackGood = moveReview.calculateDeltaWinProb(100, -100, false);
assert(deltaBlackGood === 0, `Delta win prob is 0 when position improves for black (got ${deltaBlackGood})`);

// 3. calculateMoveAccuracy (CAPS formula)
const acc100 = moveReview.calculateMoveAccuracy(0);
assert(acc100 === 100, `Accuracy is 100% for 0 loss (got ${acc100})`);

const accSmallLoss = moveReview.calculateMoveAccuracy(2.0);
assert(accSmallLoss >= 85 && accSmallLoss <= 100, `Accuracy is >=85% for 2% loss (got ${accSmallLoss})`);

const accLargeLoss = moveReview.calculateMoveAccuracy(40.0);
assert(accLargeLoss < 30, `Accuracy is <30% for 40% loss (got ${accLargeLoss})`);

// 4. classifyMove
const bestClass = moveReview.classifyMove(50, 55, true);
assert(bestClass.key === 'best', `Move maintaining eval is classified as best (got ${bestClass.key})`);

const inaccClass = moveReview.classifyMove(100, -20, true);
assert(inaccClass.key === 'inaccuracy' || inaccClass.key === 'mistake', `Small eval drop classified as inaccuracy/mistake (got ${inaccClass.key})`);

const blunderClass = moveReview.classifyMove(200, -400, true);
assert(blunderClass.key === 'blunder', `Huge eval drop classified as blunder (got ${blunderClass.key})`);

const brilliantClass = moveReview.classifyMove(100, 200, true, true);
assert(brilliantClass.key === 'brilliant', `Winning piece sacrifice classified as brilliant (got ${brilliantClass.key})`);

// 5. reviewGame
const mockMoves = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5'];
const mockEvals = [0, 25, 20, 30, 25, 35, 30];
const gameReview = moveReview.reviewGame(mockMoves, mockEvals);

assert(typeof gameReview.whiteAccuracy === 'number' && gameReview.whiteAccuracy > 80, `White accuracy computed (>80%): ${gameReview.whiteAccuracy}`);
assert(typeof gameReview.blackAccuracy === 'number' && gameReview.blackAccuracy > 80, `Black accuracy computed (>80%): ${gameReview.blackAccuracy}`);
assert(gameReview.moves.length === 6, `All 6 moves reviewed (got ${gameReview.moves.length})`);
assert(gameReview.counts.white.best + gameReview.counts.white.excellent + gameReview.counts.white.good === 3, 'All white moves classified accurately');

console.log('\n=== Test Suite 2: UI Integration & Review Panel DOM Simulation ===');

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
    'game-review-btn', 'close-review'
  ];

  ids.forEach(id => add(id, id.includes('button') || ['rematch', 'undo', 'promo-cancel', 'sound-toggle', 'haptics-toggle', 'new-game', 'copy-pgn', 'flip-board', 'resign', 'offer-draw', 'scrub-start', 'scrub-prev', 'scrub-next', 'scrub-end', 'game-review-btn', 'close-review'].includes(id) ? 'button' : id.includes('select') ? 'select' : 'div'));

  const promoButtons = ['q', 'r', 'b', 'n'].map(piece => {
    const button = new MockElement('button');
    button.className = 'promo-btn';
    button.dataset.piece = piece;
    elements.get('promo-box').appendChild(button);
    return button;
  });
  const commandButtons = ['rematch', 'undo'].map(id => elements.get(id));

  // initial review-panel has hidden class
  elements.get('review-panel').classList.add('hidden');

  document = {
    activeElement: null,
    documentElement: new MockElement('html'),
    createElement: tag => new MockElement(tag),
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
      MoveReview: moveReview
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
    MoveReview: moveReview,
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
  const uiCode = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');
  vm.runInContext(uiCode, context);

  return { context, elements };
}

const { context, elements } = createHarness();

assert(typeof context.window.runGameReview === 'function', 'runGameReview is exposed on window');
assert(typeof context.window.getLatestGameReview === 'function', 'getLatestGameReview is exposed on window');

// Simulate moves and evaluation history in sandbox
const testEvals = [0, 30, 20, 45, 10];
context.window.setEvalHistory(testEvals);

// Trigger game review via button click
const reviewBtn = elements.get('game-review-btn');
assert(typeof reviewBtn.onclick === 'function', 'game-review-btn has click handler');

reviewBtn.onclick();

const reviewResult = context.window.getLatestGameReview();
assert(reviewResult !== null, 'Game review produced review result');
assert(typeof reviewResult.whiteAccuracy === 'number', `White accuracy is number: ${reviewResult.whiteAccuracy}`);
assert(typeof reviewResult.blackAccuracy === 'number', `Black accuracy is number: ${reviewResult.blackAccuracy}`);

// Check review panel DOM visibility
const reviewPanel = elements.get('review-panel');
assert(!reviewPanel.classList.contains('hidden'), 'review-panel is visible after review run');

// Check accuracy text
const whiteAccEl = elements.get('white-accuracy');
const blackAccEl = elements.get('black-accuracy');
assert(whiteAccEl.textContent.includes('%'), `White accuracy text set: ${whiteAccEl.textContent}`);
assert(blackAccEl.textContent.includes('%'), `Black accuracy text set: ${blackAccEl.textContent}`);

// Check close button functionality
const closeBtn = elements.get('close-review');
assert(typeof closeBtn.onclick === 'function', 'close-review has click handler');
closeBtn.onclick();
assert(reviewPanel.classList.contains('hidden'), 'review-panel is hidden after close click');

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
