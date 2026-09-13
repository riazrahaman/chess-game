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
    'analysis-arrows', 'new-game', 'copy-pgn', 'flip-board', 'resign', 'offer-draw',
    'scrub-start', 'scrub-prev', 'scrub-next', 'scrub-end'
  ];
  ids.forEach(id => add(id, id.includes('button') || ['rematch', 'undo', 'promo-cancel', 'sound-toggle', 'new-game', 'copy-pgn', 'flip-board', 'resign', 'offer-draw', 'scrub-start', 'scrub-prev', 'scrub-next', 'scrub-end'].includes(id) ? 'button' : 'div'));

  const promoButtons = ['q', 'r', 'b', 'n'].map(piece => {
    const button = new MockElement('button');
    button.className = 'promo-btn';
    button.dataset.piece = piece;
    elements.get('promo-box').appendChild(button);
    return button;
  });
  const commandButtons = ['rematch', 'undo'].map(id => elements.get(id));

  const windowListeners = {};
  const context = {
    console,
    document,
    window: {
      addEventListener(type, fn) { (windowListeners[type] ||= []).push(fn); },
      removeEventListener(type, fn) { windowListeners[type] = (windowListeners[type] || []).filter(h => h !== fn); },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      dispatchEvent: () => true
    },
    fetch: (...args) => fetchImpl(...args),
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
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8'), context);
  return { context, elements, document, windowListeners, setFetch(fn) { fetchImpl = fn; } };
}

async function main() {
  console.log('--- Running Phase 1 Interactive Move Tree Scrubber Self-Tests ---\n');

  const harness = createHarness();
  const { context, elements, windowListeners, document } = harness;

  // Build a 4-ply game: 1. e4 e5 2. Nf3 Nc6
  let b = engine.createInitialBoard();
  b = engine.makeMove(b, 'e2', 'e4');
  b = engine.makeMove(b, 'e7', 'e5');
  b = engine.makeMove(b, 'g1', 'f3');
  b = engine.makeMove(b, 'b8', 'c6');

  const fourPlyState = {
    board: b,
    clocks: { white: 580, black: 585 },
    history: ['e2e4', 'e7e5', 'g1f3', 'b8c6'],
    status: 'ongoing',
    gameOver: false,
    result: null
  };

  context.applyRefereeState(fourPlyState);

  // 1. Initial scrubber state after referee apply
  assert(context.getLivePly() === 4, 'live ply is 4');
  assert(context.getViewedPly() === null, 'viewed ply is null (live)');
  assert(context.isViewingHistory() === false, 'not viewing history at live position');

  // 2. History table rendered with 2 rows and interactive ply elements
  const historyBody = elements.get('history-body');
  assert(historyBody.children.length === 2, 'history table has 2 move rows');
  const row1 = historyBody.children[0];
  const row2 = historyBody.children[1];
  const whitePly1 = row1.children[1];
  const blackPly2 = row1.children[2];
  const whitePly3 = row2.children[1];
  const blackPly4 = row2.children[2];

  assert(whitePly1.textContent === 'e4' && whitePly1.dataset.ply === '1', 'ply 1 is white e4');
  assert(blackPly2.textContent === 'e5' && blackPly2.dataset.ply === '2', 'ply 2 is black e5');
  assert(whitePly3.textContent === 'Nf3' && whitePly3.dataset.ply === '3', 'ply 3 is white Nf3');
  assert(blackPly4.textContent === 'Nc6' && blackPly4.dataset.ply === '4', 'ply 4 is black Nc6');

  // 3. Scrubber buttons state at live position
  const btnStart = elements.get('scrub-start');
  const btnPrev = elements.get('scrub-prev');
  const btnNext = elements.get('scrub-next');
  const btnEnd = elements.get('scrub-end');

  assert(btnStart.disabled === false && btnPrev.disabled === false, 'start and prev buttons enabled at live position with moves');
  assert(btnNext.disabled === true && btnEnd.disabled === true, 'next and end buttons disabled when already at live end');

  // 4. jumpToPly(1) moves board back to after 1. e4
  const getPlyEl = (ply) => {
    const rIdx = Math.floor((ply - 1) / 2);
    const cIdx = ((ply - 1) % 2) + 1;
    return historyBody.children[rIdx] && historyBody.children[rIdx].children[cIdx];
  };

  context.jumpToPly(1);
  assert(context.getViewedPly() === 1, 'viewed ply updated to 1');
  assert(context.isViewingHistory() === true, 'isViewingHistory is true when viewedPly < livePly');
  assert(getPlyEl(1).classList.contains('active-ply'), 'ply 1 has active-ply highlight class');
  assert(!getPlyEl(2).classList.contains('active-ply'), 'ply 2 does not have active-ply class');

  // Check board state at ply 1: e4 has white pawn, e5 is empty
  const e4Piece = elements.get('e4').firstElementChild;
  const e5Piece = elements.get('e5').firstElementChild;
  assert(e4Piece && e4Piece.dataset.type === 'p' && e4Piece.dataset.color === 'white', 'board at ply 1 has white pawn on e4');
  assert(!e5Piece, 'board at ply 1 does not yet have black pawn on e5');
  assert(elements.get('e4').draggable === false, 'pieces are not draggable while viewing history');

  const statusEl = elements.get('status');
  assert(statusEl.textContent.includes('Viewing history (1/4)'), 'status indicator reflects viewing history (1/4)');

  // 5. scrubNext steps from ply 1 to ply 2
  context.scrubNext();
  assert(context.getViewedPly() === 2, 'scrubNext stepped to ply 2');
  assert(getPlyEl(2).classList.contains('active-ply'), 'ply 2 has active-ply class');
  const e5PieceNow = elements.get('e5').firstElementChild;
  assert(e5PieceNow && e5PieceNow.dataset.type === 'p' && e5PieceNow.dataset.color === 'black', 'board at ply 2 has black pawn on e5');

  // 6. scrubFirst jumps directly to starting position (ply 0)
  context.scrubFirst();
  assert(context.getViewedPly() === 0, 'scrubFirst jumps to ply 0');
  assert(btnStart.disabled === true && btnPrev.disabled === true, 'start and prev disabled at ply 0');
  assert(btnNext.disabled === false && btnEnd.disabled === false, 'next and end enabled at ply 0');
  assert(!elements.get('e4').firstElementChild, 'e4 is empty at initial position (ply 0)');

  // 7. scrubLast jumps directly back to live position
  context.scrubLast();
  assert(context.getViewedPly() === null, 'scrubLast returns viewed ply to null (live)');
  assert(context.isViewingHistory() === false, 'isViewingHistory is false after scrubLast');
  assert(btnNext.disabled === true && btnEnd.disabled === true, 'next and end disabled at live');

  // 8. Interactive click on move in table jumps to that ply
  getPlyEl(3).onclick(); // Click 2. Nf3
  assert(context.getViewedPly() === 3, 'clicking on Nf3 jumps to ply 3');
  assert(getPlyEl(3).classList.contains('active-ply'), 'ply 3 has active-ply class after click');

  // 9. Clicking on board while viewing history returns to live
  elements.get('e4').onclick();
  assert(context.getViewedPly() === null, 'clicking board while viewing history returns to live position');

  // 10. Global keyboard navigation (ArrowLeft, ArrowRight, Home, End)
  document.activeElement = null; // Unfocus board so global keyboard handler handles navigation
  const keyHandlers = windowListeners['keydown'] || [];
  assert(keyHandlers.length > 0, 'global keydown listener registered on window');
  const fireKey = (key) => {
    let prevented = false;
    keyHandlers.forEach(h => h({
      key,
      preventDefault: () => { prevented = true; },
      target: { tagName: 'DIV' }
    }));
    return prevented;
  };

  // From live (ply 4), ArrowLeft -> ply 3
  fireKey('ArrowLeft');
  assert(context.getViewedPly() === 3, 'ArrowLeft steps back from live to ply 3');

  // ArrowLeft again -> ply 2
  fireKey('ArrowLeft');
  assert(context.getViewedPly() === 2, 'ArrowLeft steps back to ply 2');

  // ArrowRight -> ply 3
  fireKey('ArrowRight');
  assert(context.getViewedPly() === 3, 'ArrowRight steps forward to ply 3');

  // Home -> ply 0
  fireKey('Home');
  assert(context.getViewedPly() === 0, 'Home key jumps to start (ply 0)');

  // End -> live
  fireKey('End');
  assert(context.getViewedPly() === null, 'End key jumps back to live position');

  console.log('\n--- Phase 1 Move Tree Scrubber Self-Test Summary ---');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
  console.log('\nAll Phase 1 move tree scrubber self-tests PASSED successfully!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
