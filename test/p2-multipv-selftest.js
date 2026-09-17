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
    'scrub-start', 'scrub-prev', 'scrub-next', 'scrub-end', 'multipv-container', 'multipv-select',
    'multipv-lines'
  ];
  ids.forEach(id => add(id, id.includes('button') || ['rematch', 'undo', 'promo-cancel', 'sound-toggle', 'new-game', 'copy-pgn', 'flip-board', 'resign', 'offer-draw', 'scrub-start', 'scrub-prev', 'scrub-next', 'scrub-end'].includes(id) ? 'button' : id.includes('select') ? 'select' : 'div'));

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
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'ui.js'), 'utf8'), context);
  return { context, elements, document, windowListeners, setFetch(fn) { fetchImpl = fn; } };
}

async function main() {
  console.log('--- Running Phase 2 Multi-PV Candidate Arrows Self-Tests ---\n');

  // 1. Check HTML markup
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert(/id="multipv-container"/.test(html), 'index.html contains multipv-container');
  assert(/id="multipv-select"/.test(html), 'index.html contains multipv-select element');
  assert(/id="multipv-lines"/.test(html), 'index.html contains multipv-lines element');

  const harness = createHarness();
  const { context, elements } = harness;
  const initialBoard = engine.createInitialBoard();
  const ongoing = { board: initialBoard, clocks: { white: 600, black: 600 }, history: [], status: 'ongoing', gameOver: false, result: null };

  context.applyRefereeState(ongoing);

  const arrowsSvg = elements.get('analysis-arrows');
  const breakdownContainer = elements.get('multipv-lines');

  // 2. Initial state
  assert(context.getEngineMultiPvLines().length === 0, 'initial Multi-PV lines array is empty');

  // 3. Dispatch Multi-PV evaluation payload (top 3 lines)
  const mockMultiPvData = {
    type: 'eval',
    evalCp: 0.35,
    bestMove: 'e2e4',
    multipv: [
      { pvIndex: 1, bestMove: 'e2e4', scoreCp: 0.35, depth: 8, pv: ['e2e4'] },
      { pvIndex: 2, bestMove: 'd2d4', scoreCp: 0.25, depth: 8, pv: ['d2d4'] },
      { pvIndex: 3, bestMove: 'g1f3', scoreCp: 0.15, depth: 8, pv: ['g1f3'] }
    ]
  };

  context.updateEvalUI(mockMultiPvData);

  const lines = context.getEngineMultiPvLines();
  assert(lines.length === 3, 'updateEvalUI extracts 3 Multi-PV candidate lines');
  assert(lines[0].from === 'e2' && lines[0].to === 'e4' && lines[0].pvIndex === 1, 'first candidate line is e2e4');
  assert(lines[1].from === 'd2' && lines[1].to === 'd4' && lines[1].pvIndex === 2, 'second candidate line is d2d4');
  assert(lines[2].from === 'g1' && lines[2].to === 'f3' && lines[2].pvIndex === 3, 'third candidate line is g1f3');

  // 4. Check rendered SVG candidate arrows
  const svgContent = arrowsSvg.innerHTML;
  assert(svgContent.includes('engine-pv-1'), 'SVG contains rank 1 candidate arrow (e2e4)');
  assert(svgContent.includes('engine-pv-2'), 'SVG contains rank 2 candidate arrow (d2d4)');
  assert(svgContent.includes('engine-pv-3'), 'SVG contains rank 3 candidate arrow (g1f3)');
  assert(svgContent.includes('url(#arrowhead-engine)') && svgContent.includes('url(#arrowhead-engine2)') && svgContent.includes('url(#arrowhead-engine3)'),
    'SVG includes distinct color-coded markers for each Multi-PV rank');

  // 5. Check Multi-PV breakdown panel in DOM
  assert(breakdownContainer.children.length === 3, 'breakdown panel contains 3 candidate rows');
  assert(breakdownContainer.children[0].className.includes('multipv-rank-1'), 'row 1 has multipv-rank-1 class');
  assert(breakdownContainer.children[1].className.includes('multipv-rank-2'), 'row 2 has multipv-rank-2 class');
  assert(breakdownContainer.children[2].className.includes('multipv-rank-3'), 'row 3 has multipv-rank-3 class');

  // 6. Coexistence with user right-click annotations
  context.addUserArrow('c2', 'c4', 'red');
  const combinedSvg = arrowsSvg.innerHTML;
  assert(combinedSvg.includes('annotation-arrow') && combinedSvg.includes('engine-multipv-arrow'),
    'user annotations and engine Multi-PV candidate arrows coexist on SVG overlay');

  // 7. Multi-PV count selector
  context.setMultiPvCount(2);
  const select = elements.get('multipv-select');
  assert(select.value === '2', 'setMultiPvCount updates select value');

  // 8. Clear Multi-PV lines
  context.clearEngineMultiPvLines();
  assert(context.getEngineMultiPvLines().length === 0, 'clearEngineMultiPvLines empties candidate lines');
  assert(!arrowsSvg.innerHTML.includes('engine-multipv-arrow'), 'clearing Multi-PV removes candidate arrows from SVG');
  assert(breakdownContainer.children.length === 0, 'clearing Multi-PV empties breakdown panel');

  console.log('\n--- Phase 2 Multi-PV Candidate Arrows Self-Test Summary ---');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
  console.log('\nAll Phase 2 Multi-PV candidate arrows self-tests PASSED successfully!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
