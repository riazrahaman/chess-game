#!/usr/bin/env node
'use strict';

/**
 * about-selftest.js
 *
 * Read-only checks for the routed About view. A small in-memory DOM exercises
 * the real registration and mount hooks, so source text alone cannot make a
 * broken render pass. This suite never starts a server or writes app state.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ABOUT_PATH = path.join(ROOT, 'src', 'ui-about.js');

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function countUnitSuites() {
  const pkg = JSON.parse(read('package.json'));
  const command = pkg.scripts && pkg.scripts['test:unit'];
  assert(typeof command === 'string', 'package.json has no test:unit script');
  const suites = [];
  const pattern = /node\s+(test\/[^\s&]+-selftest\.js)/g;
  let match;
  while ((match = pattern.exec(command))) suites.push(match[1]);
  return new Set(suites).size;
}

function createRuntimeHarness() {
  const elements = new Map();
  const styles = [];
  let registeredView = null;

  class ElementStub {
    constructor(tagName) {
      this.tagName = String(tagName || 'div').toUpperCase();
      this._id = '';
      this.textContent = '';
    }
    set id(value) {
      this._id = String(value);
      if (this._id) elements.set(this._id, this);
    }
    get id() { return this._id; }
  }

  class ViewElementStub extends ElementStub {
    constructor() {
      super('section');
      this._innerHTML = '';
      this.playButtons = [];
    }
    set innerHTML(value) {
      this._innerHTML = String(value);
      const count = (this._innerHTML.match(/data-about-action="play"/g) || []).length;
      this.playButtons = Array.from({ length: count }, () => ({
        listeners: {},
        addEventListener(type, fn) { this.listeners[type] = fn; }
      }));
    }
    get innerHTML() { return this._innerHTML; }
    querySelectorAll(selector) {
      return selector === '[data-about-action="play"]' ? this.playButtons : [];
    }
  }

  const documentStub = {
    readyState: 'complete',
    head: {
      appendChild(node) {
        styles.push(node);
        if (node.id) elements.set(node.id, node);
        return node;
      }
    },
    createElement(tagName) { return new ElementStub(tagName); },
    getElementById(id) { return elements.get(id) || null; }
  };
  const windowStub = {
    Shell: {
      registerView(definition) {
        registeredView = definition;
        return definition;
      },
      navigate() {}
    }
  };

  const originalDocument = global.document;
  const originalWindow = global.window;
  let about;
  let rendered = '';
  let playButtons = [];

  try {
    global.document = documentStub;
    global.window = windowStub;
    delete require.cache[require.resolve(ABOUT_PATH)];
    about = require(ABOUT_PATH);
    assert(registeredView, 'init() did not register a view with window.Shell');
    const el = new ViewElementStub();
    registeredView.mount(el);
    registeredView.show(el);
    registeredView.hide(el);
    rendered = el.innerHTML;
    playButtons = el.playButtons;
  } finally {
    global.document = originalDocument;
    global.window = originalWindow;
    delete require.cache[require.resolve(ABOUT_PATH)];
  }

  return { about, registeredView, rendered, playButtons, styles };
}

const source = fs.existsSync(ABOUT_PATH) ? fs.readFileSync(ABOUT_PATH, 'utf8') : '';
let runtime = null;
let runtimeError = null;
try {
  runtime = createRuntimeHarness();
} catch (err) {
  runtimeError = err;
}

test('src/ui-about.js exists, exports hooks, and registers the real view', () => {
  assert(fs.existsSync(ABOUT_PATH), 'src/ui-about.js is missing');
  assert(!runtimeError, 'runtime harness failed: ' + (runtimeError && runtimeError.message));
  assert(typeof runtime.about.init === 'function', 'missing export: init');
  for (const method of ['mount', 'show', 'hide']) {
    assert(typeof runtime.about[method] === 'function', 'missing export: ' + method);
    assert(runtime.registeredView[method] === runtime.about[method], 'registered ' + method + ' is not the exported hook');
  }
  assert(runtime.registeredView.id === 'about', 'registered id is not about');
  assert(runtime.registeredView.title === 'About', 'registered title is not About');
  assert(runtime.registeredView.order === 90, 'registered order is not 90');
  assert(runtime.registeredView.nav === true, 'registered nav is not enabled');
});

test('mount renders every required About section and injects styles once', () => {
  assert(!runtimeError, 'runtime harness failed: ' + (runtimeError && runtimeError.message));
  assert(runtime.rendered.length > 0, 'mount produced no rendered output');
  const markers = ['header', 'features', 'stats', 'properties', 'technologies', 'architecture', 'gallery', 'faq', 'footer'];
  const missing = markers.filter((marker) => !runtime.rendered.includes(`data-about-section="${marker}"`));
  assert(missing.length === 0, 'rendered output is missing section markers: ' + missing.join(', '));
  assert(runtime.styles.filter((node) => node.id === 'about-view-styles').length === 1, 'About styles were not injected exactly once');
});

test('mounted output contains the expected heading and all six feature entries', () => {
  assert(runtime.rendered.includes('<h1>A chess board backed by one authoritative referee.</h1>'), 'expected h1 was not rendered');
  const features = ['Play', 'Puzzles', 'Analysis', 'Library', 'Insights &amp; ratings', 'Coordinates trainer'];
  const missing = features.filter((name) => !runtime.rendered.includes('<h2>' + name + '</h2>'));
  assert(missing.length === 0, 'rendered feature entries missing: ' + missing.join(', '));
  assert(runtime.playButtons.length === 2, 'both rendered Start a game actions were not bound');
  assert(runtime.playButtons.every((button) => typeof button.listeners.click === 'function'), 'a Start a game action has no click listener');
});

test('mounted stats match the distinct suites wired into test:unit', () => {
  const expected = countUnitSuites();
  assert(expected === 73, 'reviewed test:unit suite count changed; expected 73, got ' + expected);
  const stat = new RegExp('<span class="about-stat-value">' + expected + '<\\/span><span class="about-stat-label">Unit suites run<\\/span><span class="about-stat-detail">In the full unit check<\\/span>');
  assert(stat.test(runtime.rendered), 'rendered unit-suite statistic does not match package.json test:unit (' + expected + ')');
});

test('mounted FAQ is truthful about browser analysis and server-required play', () => {
  const expected = [
    'Is my data private, and where do games live?',
    'What works in the browser, and what needs the server?',
    'Do puzzles or analysis need an account?',
    'How do ratings work?',
    'Is there a mobile or accessible mode?'
  ];
  const missing = expected.filter((question) => !runtime.rendered.includes('<summary>' + question + '</summary>'));
  assert(missing.length === 0, 'rendered FAQ entries missing: ' + missing.join(', '));
  assert(runtime.rendered.includes('Analysis and game review run entirely in your browser.'), 'browser analysis guarantee is missing');
  assert(runtime.rendered.includes('bot opponents—need an active connection to the server.'), 'server requirement for bot games is missing');
  assert(!/offline/i.test(runtime.rendered), 'rendered copy makes an unsupported offline claim');
});

test('mounted gallery renders three images with non-empty alt text', () => {
  const images = [...runtime.rendered.matchAll(/<img\b([^>]*)>/g)];
  assert(images.length === 3, 'expected 3 rendered gallery images, got ' + images.length);
  for (const image of images) {
    const alt = /\balt="([^"]+)"/.exec(image[1]);
    assert(alt && alt[1].trim(), 'gallery image is missing non-empty alt text: ' + image[0]);
  }
});

test('About module stays display-only even when forbidden names are split across literals', () => {
  // Removing quote characters and the + operators between literals turns a
  // disguise such as 'make' + 'Move' back into makeMove before scanning.
  const normalized = source.replace(/['"`]/g, '').replace(/\s*\+\s*/g, '');
  const forbidden = ['makeMove', 'createInitialBoard', 'historyToSan'];
  const found = forbidden.filter((token) => normalized.includes(token));
  assert(found.length === 0, 'forbidden game-state tokens found after normalization: ' + found.join(', '));
  assert(!/\bfetch\s*\(/.test(source), 'About view must not fetch game state');
});

test('About module contains no source-sharing vocabulary', () => {
  const lower = source.toLowerCase();
  const prohibited = [
    'github', 'gitlab', 'open-source', 'opensource', 'repository', 'repo',
    'clone', 'fork', 'contribute', 'contributor', 'source code', 'source-code',
    'pull request', 'issue tracker'
  ];
  const found = prohibited.filter((term) => lower.includes(term));
  assert(found.length === 0, 'prohibited source-sharing terms found: ' + found.join(', '));
});

test('About markup contains no inline event handlers', () => {
  assert(!/\son[a-z]+\s*=/i.test(runtime.rendered), 'inline on*= handler found in rendered output');
});

test('index.html loads and hosts the About view', () => {
  const html = read('index.html');
  assert(html.includes('<script src="src/ui-about.js"></script>'), 'index.html does not load src/ui-about.js');
  assert(/<section\s+class="shell-view"\s+data-view="about"\s+hidden\s+aria-label="About"><\/section>/.test(html), 'index.html does not host data-view about');
});

test('server and service worker make src/ui-about.js reachable', () => {
  const server = read('server.js');
  const allowed = /const\s+ALLOWED_FILES\s*=\s*new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)/.exec(server);
  assert(allowed && allowed[1].includes("'src/ui-about.js'"), 'src/ui-about.js is absent from ALLOWED_FILES');
  const worker = read('service-worker.js');
  const assets = /const\s+PRECACHE_ASSETS\s*=\s*\[([\s\S]*?)\]/.exec(worker);
  assert(assets && assets[1].includes("'/src/ui-about.js'"), 'src/ui-about.js is absent from PRECACHE_ASSETS');
});

test('shell KNOWN_VIEWS includes About at order 90', () => {
  const shell = read('src/shell.js');
  const known = /const\s+KNOWN_VIEWS\s*=\s*\[([\s\S]*?)\];/.exec(shell);
  assert(known && /\{\s*id:\s*['"]about['"],\s*title:\s*['"]About['"],\s*order:\s*90\s*\}/.test(known[1]), 'About is absent from KNOWN_VIEWS');
});

console.log(`\n${failed > 0 ? 'Failed: ' + failed + ', ' : ''}Passed: ${passed}`);
process.exit(failed > 0 ? 1 : 0);
