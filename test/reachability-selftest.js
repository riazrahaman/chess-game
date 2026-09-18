#!/usr/bin/env node
'use strict';

/**
 * reachability-selftest.js  (roadmap §7 "Definition of Done, revised")
 *
 * READ-ONLY static guard. It never starts the server, never require()s
 * server.js / referee-service.js, and never writes state files. Everything is
 * derived by text-parsing index.html, server.js, service-worker.js and src/.
 *
 * It prevents two classes of regression:
 *   "loaded but not servable"  — a <script src> that 404s because it is missing
 *                                from server.js ALLOWED_FILES / disk / PRECACHE.
 *   "shipped but never called" — a src/ module that nobody loads, requires, or
 *                                calls, unless explicitly allow-listed in
 *                                KNOWN_DARK (which may only shrink).
 *
 * Assertions:
 *   a. every <script src> in index.html + every new Worker('...') in src/ui*.js
 *      resolves to a file on disk AND is in server.js ALLOWED_FILES
 *   b. every entry in ALLOWED_FILES exists on disk
 *   c. every client script index.html loads (+ the Worker) is in
 *      service-worker.js PRECACHE_ASSETS, and every PRECACHE entry exists on disk
 *   d. every src/*.js module is loaded by index.html, required transitively from
 *      server.js, or listed in KNOWN_DARK
 *   e. every script index.html loads has >=1 call site outside its own file
 *      (or self-initialises), unless listed in KNOWN_DARK
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

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
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// KNOWN_DARK — the ONLY allowed set of unreachable modules. Each entry names
// the roadmap item (docs/06-world-class-roadmap.md) that will wire it. This
// list may only SHRINK. Adding a new dark module without listing it here fails
// the build. Modules here are exempt from (d) and (e); NOT from (a)/(b)/(c).
// ---------------------------------------------------------------------------
const KNOWN_DARK = {
  // --- DARK, never loaded by index.html nor required from server.js (§1: 11) ---
  'rating.js':            'roadmap §1 DARK-never-loaded; Phase 2 ratings/leaderboard shell (P2)',
  'ratings-pool.js':      'roadmap §1 DARK-never-loaded; Phase 2 ratings/leaderboard shell (P2)',
  'lobby.js':             'roadmap §1 DARK-never-loaded; Phase 2 lobby/seek shell (P2)',
  'puzzle-service.js':    'roadmap §1 DARK-never-loaded; Phase 2 puzzles shell (P2)',
  'puzzle-rating.js':     'roadmap §1 DARK-never-loaded; Phase 2 puzzles shell (P2)',
  'puzzle-storm.js':      'roadmap §1 DARK-never-loaded; Phase 2 puzzles shell (P2)',
  'daily-puzzle.js':      'roadmap §1 DARK-never-loaded; Phase 2 puzzles shell (P2)',
  'study-tree.js':        'roadmap §1 DARK-never-loaded; Phase 2 studies shell (P2)',
  'openings-explorer.js': 'roadmap §1 DARK-never-loaded; Phase 2 opening explorer shell (P2)',
  'puzzle-repetition.js': 'roadmap §1 DARK-never-loaded; Phase 2 puzzles shell (P2)',
  'fen-setup.js':         'roadmap §1 doc/code contradiction: referee _cmdSetup uses rulesEngine.fenToBoard, not this module (P2 setup UI)',

  // --- DARK, shipped to browser with zero call sites (§1: 18) ---
  'masters-db.js':        'roadmap §1 DARK-shipped; Phase 1 game-review reclassification wiring (P1)',
  'acpl.js':              'roadmap §1 DARK-shipped; Phase 1 accuracy/ACPL panel wiring (P1)',
  'puzzle-racer.js':      'roadmap §1 DARK-shipped; Phase 2 puzzles shell (P2)',
  'a11y-text-entry.js':   'roadmap §1 DARK-shipped; Phase 2 accessibility affordances (P2)',
  'a11y-gestures.js':     'roadmap §1 DARK-shipped; Phase 2 accessibility affordances (P2)',
  'voice-intents.js':     'roadmap §1 DARK-shipped; Phase 2 accessibility affordances (P2)',
  'chess960.js':          'roadmap §1 DARK-shipped; Phase 2 variants/new-game dialog (P2)',
  'tablebase.js':         'roadmap §1 DARK-shipped; Phase 2 analysis panel (P2)',
  'arena.js':             'roadmap §1 DARK-shipped; Phase 3 tournaments (P3)',
  'social-graph.js':      'roadmap §1 DARK-shipped; Phase 3 social (P3)',
  'chat-upgrades.js':     'roadmap §1 DARK-shipped; Phase 2 chat affordances (P2)',
  'correspondence.js':    'roadmap §1 DARK-shipped; Phase 3 correspondence (P3)',
  'personality-bots.js':  'roadmap §1 DARK-shipped; Phase 2 bot picker (P2)',
  'pov-export.js':        'roadmap §1 DARK-shipped; Phase 2 export menu (P2)',
  'embed-viewer.js':      'roadmap §1 DARK-shipped; Phase 2 export menu (P2)',
  'variants.js':          'roadmap §1 DARK-shipped; Phase 2 variants/new-game dialog (P2)',
  'i18n.js':              'roadmap §1 DARK-shipped; Phase 2 site shell i18n (P2)',

  // --- PARTIAL: server side live, browser copy shipped but never called (§1) ---
  'game-archive.js':      'roadmap §1 PARTIAL: server /api/games* live; browser window.GameArchive uncalled (Phase 1: stop shipping)',
  'time-control.js':      'roadmap §1 PARTIAL: server /api/time-control live; browser window.TimeControl uncalled (Phase 2 TC dialog)',
};

// ---------------------------------------------------------------------------
// Parsers (pure text; no require of app modules)
// ---------------------------------------------------------------------------
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function stripHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

function parseIndexScripts() {
  const html = stripHtmlComments(read('index.html'));
  const out = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const src = m[1];
    if (/^(https?:)?\/\//i.test(src)) continue; // external CDN (e.g. Google GSI) — not ours to serve
    out.push(src.replace(/^\.?\//, ''));
  }
  return out;
}

function parseWorkerPaths() {
  const out = [];
  for (const f of fs.readdirSync(SRC)) {
    if (!/^ui.*\.js$/.test(f)) continue;
    const code = fs.readFileSync(path.join(SRC, f), 'utf8');
    const re = /new\s+Worker\s*\(\s*["'`]([^"'`]+)["'`]/g;
    let m;
    while ((m = re.exec(code))) out.push(m[1].replace(/^\.?\//, ''));
  }
  return out;
}

function parseStringArrayLiteral(code, anchorRegex, label) {
  const m = anchorRegex.exec(code);
  assert(m, 'could not locate ' + label);
  const start = m.index + m[0].length;
  // Find the matching closing bracket for the opening one the anchor ended on.
  const open = m[0][m[0].length - 1];
  const close = open === '[' ? ']' : ')';
  let depth = 1;
  let i = start;
  for (; i < code.length && depth > 0; i++) {
    if (code[i] === open) depth++;
    else if (code[i] === close) depth--;
  }
  const body = code.slice(start, i - 1);
  const entries = [];
  const re = /["'`]([^"'`]+)["'`]/g;
  let e;
  while ((e = re.exec(body))) entries.push(e[1]);
  return entries;
}

function parseAllowedFiles() {
  const code = read('server.js');
  return parseStringArrayLiteral(code, /const\s+ALLOWED_FILES\s*=\s*new\s+Set\s*\(\s*\[/, 'server.js ALLOWED_FILES');
}

function parsePrecacheAssets() {
  const code = read('service-worker.js');
  return parseStringArrayLiteral(code, /const\s+PRECACHE_ASSETS\s*=\s*\[/, 'service-worker.js PRECACHE_ASSETS');
}

function listSrcModules() {
  return fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).sort();
  // NOTE: referee-helper.cjs is intentionally out of scope (src/*.js only). It is
  // a CLI exercised by engine-selftest.js / draw-selftest.js via execSync.
}

// Transitive require() closure starting from server.js (text-parsed).
function serverRequireClosure() {
  const seen = new Set();
  const queue = [];
  const root = read('server.js');
  const reRoot = /require\(\s*["']\.\/src\/([^"']+)["']\s*\)/g;
  let m;
  while ((m = reRoot.exec(root))) queue.push(m[1]);
  const reSrc = /require\(\s*["']\.\/([^"']+)["']\s*\)/g;
  while (queue.length) {
    const mod = queue.shift();
    if (seen.has(mod)) continue;
    seen.add(mod);
    const p = path.join(SRC, mod);
    if (!fs.existsSync(p)) continue;
    const code = fs.readFileSync(p, 'utf8');
    let r;
    while ((r = reSrc.exec(code))) queue.push(r[1]);
    reSrc.lastIndex = 0;
  }
  return seen;
}

// Names a module exposes to the page, with how a call site must reference them:
//   {name, kind:'global'}  from window.X = / root.X = / globalThis.X =  (IIFE
//                          modules) — any word-boundary reference counts.
//   {name, kind:'fn'}      top-level `function X(` declarations, used ONLY when
//                          the module exposes no explicit global (plain-script
//                          modules such as engine.js, ui-sound.js, ...) — a
//                          call site must be `X(` so private helpers that
//                          happen to share a name (normalize, timestamp, ...)
//                          in IIFE modules do not count.
function exposedNames(code) {
  const out = [];
  const seen = new Set();
  let m;
  const reGlobal = /\b(?:window|root|globalThis)\.([A-Za-z_$][\w$]*)\s*=[^=]/g;
  while ((m = reGlobal.exec(code))) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push({ name: m[1], kind: 'global' }); }
  }
  if (out.length > 0) return out;
  const reFn = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  while ((m = reFn.exec(code))) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push({ name: m[1], kind: 'fn' }); }
  }
  return out;
}

// Heuristic for self-initialising modules (documented): a module counts as
// "called" if it wires itself up on load — a top-level (column-0) bare call
// statement like `initThemeBar();`, a DOMContentLoaded listener, or a
// top-level `document.` / `window.addEventListener(` statement.
function selfInitialises(code) {
  if (/DOMContentLoaded/.test(code)) return true;
  if (/^[A-Za-z_$][\w$]*\s*\([^;]*\)\s*;\s*$/m.test(code)) return true;
  if (/^(?:document\.|window\.addEventListener\()/m.test(code)) return true;
  return false;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function wordRe(name, kind) {
  const tail = kind === 'fn' ? '\\s*\\(' : '(?![A-Za-z0-9_$])';
  return new RegExp('(?<![A-Za-z0-9_$])' + escapeRe(name) + tail);
}

// ---------------------------------------------------------------------------
// Gather inputs once
// ---------------------------------------------------------------------------
const indexScripts = parseIndexScripts();
const workerPaths = parseWorkerPaths();
const clientLoaded = [...new Set([...indexScripts, ...workerPaths])];
const allowedFiles = parseAllowedFiles();
const allowedSet = new Set(allowedFiles);
const precache = parsePrecacheAssets();
const precacheSet = new Set(precache);
const srcModules = listSrcModules();
const requiredFromServer = serverRequireClosure();

console.log('=== reachability-selftest (read-only static guard) ===');
console.log(`index.html scripts: ${indexScripts.length}, Worker paths: ${workerPaths.length}, ` +
            `ALLOWED_FILES: ${allowedFiles.length}, PRECACHE_ASSETS: ${precache.length}, ` +
            `src/*.js: ${srcModules.length}, server require closure: ${requiredFromServer.size}`);

test('parsers found non-empty inputs', () => {
  assert(indexScripts.length > 5, 'index.html <script src> list looks empty');
  assert(workerPaths.length >= 1, 'no new Worker(...) path found in src/ui*.js');
  assert(allowedFiles.length > 5, 'ALLOWED_FILES looks empty');
  assert(precache.length > 5, 'PRECACHE_ASSETS looks empty');
  assert(requiredFromServer.size > 3, 'server.js require closure looks empty');
});

// (a) every client-loaded script resolves on disk AND is in ALLOWED_FILES
test('(a) every <script src> / Worker path exists on disk', () => {
  const missing = clientLoaded.filter((p) => !fs.existsSync(path.join(ROOT, p)));
  assert(missing.length === 0, 'loaded but missing on disk: ' + missing.join(', '));
});
test('(a) every <script src> / Worker path is in server.js ALLOWED_FILES', () => {
  const notAllowed = clientLoaded.filter((p) => !allowedSet.has(p));
  assert(notAllowed.length === 0,
    'loaded by the page but NOT servable (404) — add to ALLOWED_FILES or stop loading: ' + notAllowed.join(', '));
});

// (b) every ALLOWED_FILES entry exists on disk
test('(b) every ALLOWED_FILES entry exists on disk', () => {
  const missing = allowedFiles.filter((p) => !fs.existsSync(path.join(ROOT, p)));
  assert(missing.length === 0, 'in ALLOWED_FILES but missing on disk: ' + missing.join(', '));
});

// (c) precache <-> loaded scripts
test('(c) every index.html script is in service-worker PRECACHE_ASSETS', () => {
  const missing = indexScripts.filter((p) => !precacheSet.has('/' + p));
  assert(missing.length === 0, 'loaded but not precached (offline 404): ' + missing.join(', '));
});
test('(c) the eval Worker script is in PRECACHE_ASSETS (roadmap §1: eval bar offline)', () => {
  const missing = workerPaths.filter((p) => !precacheSet.has('/' + p));
  assert(missing.length === 0, 'Worker script not precached: ' + missing.join(', '));
});
test('(c) every PRECACHE_ASSETS entry exists on disk', () => {
  const missing = precache
    .filter((p) => p !== '/')
    .filter((p) => !fs.existsSync(path.join(ROOT, p.replace(/^\//, ''))));
  assert(missing.length === 0, 'precached but missing on disk: ' + missing.join(', '));
});
test('(c) every precached src/ script is also in ALLOWED_FILES', () => {
  const notAllowed = precache
    .filter((p) => p.startsWith('/src/'))
    .map((p) => p.replace(/^\//, ''))
    .filter((p) => !allowedSet.has(p));
  assert(notAllowed.length === 0, 'precached but not servable: ' + notAllowed.join(', '));
});

// (d) every src/*.js is loaded, required, or KNOWN_DARK
test('(d) every src/*.js module is loaded by index.html, required from server.js, or in KNOWN_DARK', () => {
  const loadedSet = new Set(clientLoaded.map((p) => p.replace(/^src\//, '')));
  const dark = srcModules.filter((m) => !loadedSet.has(m) && !requiredFromServer.has(m) && !KNOWN_DARK[m]);
  assert(dark.length === 0,
    'new DARK module(s) — neither loaded nor required, and not in KNOWN_DARK: ' + dark.join(', '));
});
test('(d) KNOWN_DARK only names modules that exist (list may only shrink)', () => {
  const stale = Object.keys(KNOWN_DARK).filter((m) => !srcModules.includes(m));
  assert(stale.length === 0, 'KNOWN_DARK entries with no file — remove them: ' + stale.join(', '));
});
test('(d) KNOWN_DARK never-loaded entries are really still unreachable (prune when wired)', () => {
  // A module that is now BOTH loaded and called must be removed from KNOWN_DARK.
  const loadedSet = new Set(indexScripts.map((p) => p.replace(/^src\//, '')));
  const nowLive = Object.keys(KNOWN_DARK).filter((m) => loadedSet.has(m) && callSitesFor(m).length > 0);
  assert(nowLive.length === 0, 'now reachable — remove from KNOWN_DARK: ' + nowLive.join(', '));
});

// (e) every index.html script has a call site outside its own file.
// Only browser-REACHABLE files count as call sites: index.html plus modules
// that the page actually loads and that are not themselves KNOWN_DARK. A
// reference from a never-loaded module (e.g. ratings-pool.js reading
// window.GameArchive) is not reachability.
function callSitesFor(mod) {
  const code = fs.readFileSync(path.join(SRC, mod), 'utf8');
  const names = exposedNames(code);
  const others = clientLoaded
    .map((p) => p.replace(/^src\//, ''))
    .filter((m) => m !== mod && !KNOWN_DARK[m] && fs.existsSync(path.join(SRC, m)))
    .map((m) => ({ f: 'src/' + m, code: fs.readFileSync(path.join(SRC, m), 'utf8') }));
  others.push({ f: 'index.html', code: stripHtmlComments(read('index.html')) });
  const hits = [];
  for (const { name, kind } of names) {
    const re = wordRe(name, kind);
    for (const o of others) {
      if (re.test(o.code)) hits.push(name + '@' + o.f);
    }
  }
  return hits;
}

for (const script of indexScripts) {
  const mod = script.replace(/^src\//, '');
  if (KNOWN_DARK[mod]) continue;
  test(`(e) ${script} is called from outside its own file (or self-initialises)`, () => {
    const p = path.join(ROOT, script);
    assert(fs.existsSync(p), 'missing on disk');
    const code = fs.readFileSync(p, 'utf8');
    if (selfInitialises(code)) return; // documented heuristic above
    const hits = callSitesFor(mod);
    assert(hits.length > 0,
      'zero call sites for exposed names [' + exposedNames(code).map((n) => n.name).slice(0, 8).join(', ') +
      (exposedNames(code).length > 8 ? ', ...' : '') + '] — wire it or add to KNOWN_DARK with a roadmap item');
  });
}

// ---------------------------------------------------------------------------
console.log('\nKNOWN_DARK size: ' + Object.keys(KNOWN_DARK).length + ' (may only shrink)');
if (failed > 0) {
  console.error(`\nFailed: ${failed}, Passed: ${passed}`);
  process.exit(1);
}
console.log(`\nAll ${passed} tests passed successfully!`);
