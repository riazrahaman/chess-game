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
  const commandButtons = ['rematch', 'undo'].map(id => elements.get(id));

  const context = {
    console,
    document,
    window: {
      addEventListener() {},
      removeEventListener() {},
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
  return { context, elements, document, setFetch(fn) { fetchImpl = fn; } };
}

async function main() {
  console.log('--- Running Phase 1 Right-Click Annotation Self-Tests ---\n');

  const harness = createHarness();
  const { context, elements } = harness;
  const initialBoard = engine.createInitialBoard();
  const ongoing = { board: initialBoard, clocks: { white: 600, black: 600 }, history: [], status: 'ongoing', gameOver: false, result: null };

  context.applyRefereeState(ongoing);

  const arrowsSvg = elements.get('analysis-arrows');
  assert(arrowsSvg !== null, 'analysis-arrows SVG container exists');

  // Test 1: addUserArrow adds arrow and renders to SVG
  context.addUserArrow('e2', 'e4', 'green');
  let annotations = context.getUserAnnotations();
  assert(annotations.arrows.length === 1, 'addUserArrow adds an arrow to userAnnotations');
  assert(annotations.arrows[0].from === 'e2' && annotations.arrows[0].to === 'e4', 'arrow endpoints are e2 and e4');
  assert(arrowsSvg.innerHTML.includes('annotation-arrow') && arrowsSvg.innerHTML.includes('url(#arrowhead-green)'),
    'SVG innerHTML contains rendered annotation arrow with green marker');

  // Test 2: toggle same arrow with same color removes it
  context.addUserArrow('e2', 'e4', 'green');
  annotations = context.getUserAnnotations();
  assert(annotations.arrows.length === 0, 're-adding same arrow with same color removes it (toggle behavior)');
  assert(!arrowsSvg.innerHTML.includes('annotation-arrow'), 'SVG innerHTML does not contain arrow after toggle off');

  // Test 3: change arrow color updates existing arrow without duplicating
  context.addUserArrow('e2', 'e4', 'green');
  context.addUserArrow('e2', 'e4', 'red');
  annotations = context.getUserAnnotations();
  assert(annotations.arrows.length === 1, 'updating arrow color retains exactly 1 arrow');
  assert(annotations.arrows[0].color === 'red', 'arrow color is updated to red');
  assert(arrowsSvg.innerHTML.includes('url(#arrowhead-red)'), 'SVG innerHTML reflects red marker');

  // Test 4: toggleUserCircle adds circle and renders to SVG
  context.toggleUserCircle('e4', 'green');
  annotations = context.getUserAnnotations();
  assert(annotations.circles.length === 1, 'toggleUserCircle adds a circle');
  assert(annotations.circles[0].square === 'e4' && annotations.circles[0].color === 'green', 'circle is on square e4 with green color');
  assert(arrowsSvg.innerHTML.includes('annotation-circle') && arrowsSvg.innerHTML.includes('data-square="e4"'),
    'SVG innerHTML contains rendered annotation circle on e4');

  // Test 5: toggle same circle with same color removes it
  context.toggleUserCircle('e4', 'green');
  annotations = context.getUserAnnotations();
  assert(annotations.circles.length === 0, 'toggling same circle with same color removes it');
  assert(!arrowsSvg.innerHTML.includes('annotation-circle'), 'SVG innerHTML does not contain circle after toggle off');

  // Test 6: modifier key mapping
  assert(context.getAnnotationColorFromEvent(null) === 'green', 'default color is green');
  assert(context.getAnnotationColorFromEvent({ shiftKey: true }) === 'blue', 'shift key maps to blue');
  assert(context.getAnnotationColorFromEvent({ altKey: true }) === 'red', 'alt key maps to red');
  assert(context.getAnnotationColorFromEvent({ ctrlKey: true }) === 'red', 'ctrl key maps to red');
  assert(context.getAnnotationColorFromEvent({ metaKey: true }) === 'red', 'meta key maps to red');
  assert(context.getAnnotationColorFromEvent({ shiftKey: true, altKey: true }) === 'yellow', 'shift+alt maps to yellow');

  // Test 7: clearUserAnnotations flushes all
  context.addUserArrow('b1', 'c3', 'blue');
  context.toggleUserCircle('d4', 'yellow');
  assert(context.getUserAnnotations().arrows.length === 2 && context.getUserAnnotations().circles.length === 1, 'arrows and circles present before clear');
  context.clearUserAnnotations();
  assert(context.getUserAnnotations().arrows.length === 0 && context.getUserAnnotations().circles.length === 0, 'clearUserAnnotations flushes both arrows and circles');

  // Test 8: Left click clears user annotations
  context.addUserArrow('g1', 'f3', 'green');
  assert(context.getUserAnnotations().arrows.length === 1, 'arrow added before square click');
  elements.get('d2').onclick(); // left click square d2
  assert(context.getUserAnnotations().arrows.length === 0, 'left-clicking a square clears user annotations');

  // Test 9: Engine analysis arrow coexists with user annotations
  context.addUserArrow('c2', 'c4', 'green');
  context.drawAnalysisArrow(arrowsSvg, 'd2', 'd4');
  assert(arrowsSvg.innerHTML.includes('annotation-arrow') && arrowsSvg.innerHTML.includes('engine-arrow'),
    'user annotation arrow and engine analysis arrow coexist in SVG overlay');

  // Test 10: Flipping board recalculates coordinates
  const beforeFlipSvg = arrowsSvg.innerHTML;
  elements.get('flip-board').onclick();
  const afterFlipSvg = arrowsSvg.innerHTML;
  assert(beforeFlipSvg !== afterFlipSvg, 'board flipping updates SVG coordinates for annotations');

  // Test 11: Right-click mousedown and mouseup creates arrow and circle
  const sqF1 = elements.get('f1');
  const sqC4 = elements.get('c4');

  // Right-click drag f1 -> c4
  sqF1.onmousedown({ button: 2, preventDefault() {} });
  sqC4.onmouseup({ button: 2, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, preventDefault() {} });
  const f1c4Arrow = context.getUserAnnotations().arrows.find(a => a.from === 'f1' && a.to === 'c4');
  assert(f1c4Arrow !== undefined && f1c4Arrow.color === 'green', 'right-click mousedown on f1 and mouseup on c4 draws green arrow');

  // Right-click click on c4 (mousedown + mouseup on same square)
  sqC4.onmousedown({ button: 2, preventDefault() {} });
  sqC4.onmouseup({ button: 2, shiftKey: true, preventDefault() {} }); // with shift -> blue circle
  const c4Circle = context.getUserAnnotations().circles.find(c => c.square === 'c4');
  assert(c4Circle !== undefined && c4Circle.color === 'blue', 'right-click click on c4 with shift draws blue circle');

  console.log('\n--- Phase 1 Right-Click Annotation Self-Test Summary ---');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
  console.log('\nAll Phase 1 right-click annotation self-tests PASSED successfully!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
