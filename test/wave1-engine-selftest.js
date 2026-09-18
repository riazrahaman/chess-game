/**
 * wave1-engine-selftest.js — proof that a REAL engine ships (Wave 1, E1/D4).
 *
 * Asserts, in order:
 *   a. the vendored Stockfish 19 lite-single WASM + loader + GPL licence exist
 *      and look right (size band, `\0asm` magic, licence text);
 *   b. both vendor files are wired into server.js ALLOWED_FILES and
 *      service-worker.js PRECACHE_ASSETS (Worker A / E1a);
 *   c. the CSP script-src carries 'wasm-unsafe-eval' and not 'unsafe-eval' (D4);
 *   d. the engine actually runs under Node: `uci` -> "Stockfish 19", does not
 *      hang the queen on the Qxd5 trap, finds a mate-in-1, all in < 10 s;
 *   e. index.html no longer advertises the "Beginner Engine".
 *
 * Failures are collected (not exit-on-first) so a pending wiring step cannot
 * hide an engine regression. Exits non-zero if anything failed.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'stockfish');
const LOADER = path.join(VENDOR, 'stockfish-19-lite-single.js');
const WASM = path.join(VENDOR, 'stockfish-19-lite-single.wasm');
const LICENCE = path.join(VENDOR, 'Copying.txt');

let passed = 0;
const failures = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS: ' + name);
  } catch (err) {
    failures.push(name + ' — ' + (err && err.message ? err.message : String(err)));
    console.error('FAIL: ' + name + ' — ' + (err && err.message ? err.message : String(err)));
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// --- a. vendored files ------------------------------------------------------

async function sectionVendor() {
  await test('vendor loader stockfish-19-lite-single.js exists', () => {
    assert(fs.existsSync(LOADER), 'missing ' + LOADER);
    assert(fs.statSync(LOADER).size > 5000, 'loader suspiciously small');
  });

  await test('vendor stockfish-19-lite-single.wasm exists, 1.5–2.5 MB', () => {
    assert(fs.existsSync(WASM), 'missing ' + WASM);
    const size = fs.statSync(WASM).size;
    assert(size >= 1.5 * 1024 * 1024 && size <= 2.5 * 1024 * 1024,
      'wasm size ' + size + ' bytes outside 1.5–2.5 MB (wrong build? the full-net build is ~99 MB and must NOT ship)');
  });

  await test('wasm starts with the \\0asm magic', () => {
    const fd = fs.openSync(WASM, 'r');
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    assert(head.equals(Buffer.from([0x00, 0x61, 0x73, 0x6d])), 'first 4 bytes are ' + head.toString('hex'));
  });

  await test('Copying.txt present and is the GNU GPL', () => {
    assert(fs.existsSync(LICENCE), 'missing ' + LICENCE);
    assert(fs.readFileSync(LICENCE, 'utf8').includes('GNU GENERAL PUBLIC LICENSE'), 'licence text is not the GPL');
  });

  await test('vendor/stockfish/README.md names the version and GPL-3.0', () => {
    const readme = read('vendor/stockfish/README.md');
    assert(/Stockfish 19/.test(readme), 'README does not name Stockfish 19');
    assert(/GPL-3\.0/.test(readme), 'README does not name GPL-3.0');
  });
}

// --- b. server allowlist + SW precache (Worker A, E1a) ----------------------

async function sectionWiring() {
  const PENDING = ' (expected to FAIL until Worker A lands E1a: src/stockfish-worker.js + server.js ALLOWED_FILES + service-worker.js PRECACHE_ASSETS)';

  await test('server.js ALLOWED_FILES lists both vendor engine files', () => {
    const src = read('server.js');
    const m = src.match(/const ALLOWED_FILES = new Set\(\[([\s\S]*?)\]\);/);
    assert(m, 'could not locate ALLOWED_FILES in server.js');
    const body = m[1];
    for (const f of ['vendor/stockfish/stockfish-19-lite-single.js', 'vendor/stockfish/stockfish-19-lite-single.wasm']) {
      assert(body.includes("'" + f + "'") || body.includes('"' + f + '"'), 'ALLOWED_FILES is missing ' + f + PENDING);
    }
  });

  await test('service-worker.js PRECACHE_ASSETS lists both vendor engine files', () => {
    const src = read('service-worker.js');
    const m = src.match(/const PRECACHE_ASSETS = \[([\s\S]*?)\];/);
    assert(m, 'could not locate PRECACHE_ASSETS in service-worker.js');
    const body = m[1];
    for (const f of ['/vendor/stockfish/stockfish-19-lite-single.js', '/vendor/stockfish/stockfish-19-lite-single.wasm']) {
      assert(body.includes("'" + f + "'") || body.includes('"' + f + '"'), 'PRECACHE_ASSETS is missing ' + f + PENDING);
    }
  });

  await test('server.js serves .wasm as application/wasm', () => {
    assert(/'\.wasm':\s*'application\/wasm'/.test(read('server.js')), 'MIME map lacks .wasm -> application/wasm');
  });
}

// --- c. CSP (D4) ------------------------------------------------------------

async function sectionCsp() {
  await test("CSP script-src has 'wasm-unsafe-eval' and NOT 'unsafe-eval' (D4)", () => {
    const hadEnv = Object.prototype.hasOwnProperty.call(process.env, 'CHESS_CSP');
    const saved = process.env.CHESS_CSP;
    delete process.env.CHESS_CSP; // buildCsp() returns CHESS_CSP verbatim when set
    let csp;
    try {
      csp = require('../server.js').buildCsp();
    } finally {
      if (hadEnv) process.env.CHESS_CSP = saved;
    }
    const scriptSrc = csp.split(';').map(s => s.trim()).find(s => s.startsWith('script-src '));
    assert(scriptSrc, 'no script-src directive in CSP: ' + csp);
    const tokens = scriptSrc.split(/\s+/).slice(1);
    assert(tokens.includes("'wasm-unsafe-eval'"), "script-src lacks 'wasm-unsafe-eval': " + scriptSrc);
    assert(!tokens.includes("'unsafe-eval'"), "script-src still has 'unsafe-eval': " + scriptSrc);
    const workerSrc = csp.split(';').map(s => s.trim()).find(s => s.startsWith('worker-src '));
    assert(workerSrc && workerSrc.includes("'self'") && workerSrc.includes('blob:'), "worker-src must keep 'self' blob:");
  });
}

// --- d. the engine actually runs --------------------------------------------

function loadEngine() {
  // Same init pattern as scripts/engine-probe.js.
  const INIT = require(LOADER);
  const lines = [];
  const engine = {
    locateFile: (f) => (f.endsWith('.wasm') ? WASM : f),
    listener: (l) => lines.push(l),
    print: (l) => lines.push(l)
  };
  return INIT()(engine).then(() => new Promise((resolve) => {
    (function ready() {
      if (engine._isReady && !engine._isReady()) return setTimeout(ready, 10);
      resolve();
    })();
  })).then(() => {
    const send = (cmd) => engine.ccall('command', null, ['string'], [cmd], { async: /^go\b/.test(cmd) });
    const waitFor = (re, timeoutMs) => new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const hit = lines.find(l => re.test(l));
        if (hit) { clearInterval(iv); return resolve(hit); }
        if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error('timeout waiting for ' + re + '; last lines: ' + lines.slice(-3).join(' | '))); }
      }, 10);
    });
    const clear = () => { lines.length = 0; };
    return { engine, lines, send, waitFor, clear };
  });
}

async function sectionEngineRuns() {
  const t0 = Date.now();
  let eng = null;

  await test('engine loads under Node and answers `uci` with "Stockfish 19"', async () => {
    eng = await loadEngine();
    eng.send('uci');
    const idName = await eng.waitFor(/^id name /, 5000);
    await eng.waitFor(/^uciok/, 5000);
    assert(idName.includes('Stockfish 19'), 'id name was: ' + idName);
    eng.send('isready');
    await eng.waitFor(/^readyok/, 5000);
  });

  await test('does not hang the queen: Qxd5?? is rejected at depth 10 (rnb1kbnr/… w KQkq - 0 4)', async () => {
    assert(eng, 'engine did not load');
    eng.clear();
    eng.send('ucinewgame');
    eng.send('position fen rnb1kbnr/ppp2ppp/4p3/3p4/3Q4/8/PPPP1PPP/RNB1KBNR w KQkq - 0 4');
    eng.send('go depth 10');
    const bm = await eng.waitFor(/^bestmove /, 8000);
    const move = bm.split(/\s+/)[1];
    assert(move && move !== 'd4d5', 'bestmove ' + move + ' — the PST heuristic hung the queen here; a real engine must not');
  });

  await test('finds mate-in-1 (6k1/5ppp/8/8/8/8/5PPP/R5K1 w) -> a1a8', async () => {
    assert(eng, 'engine did not load');
    eng.clear();
    eng.send('ucinewgame');
    eng.send('position fen 6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1');
    eng.send('go depth 5');
    const bm = await eng.waitFor(/^bestmove /, 5000);
    const move = bm.split(/\s+/)[1];
    assert(move === 'a1a8', 'bestmove was ' + move + ', expected a1a8');
    const mateLine = eng.lines.find(l => /score mate 1\b/.test(l));
    assert(mateLine, 'no "score mate 1" info line seen');
  });

  await test('engine section completed in < 10 s and quit cleanly', async () => {
    const elapsed = Date.now() - t0;
    if (eng) eng.send('quit');
    assert(elapsed < 10000, 'engine section took ' + elapsed + ' ms');
    console.log('      (engine load + 3 searches: ' + elapsed + ' ms)');
  });
}

// --- e. index.html honesty --------------------------------------------------

async function sectionIndexHtml() {
  await test('index.html has #analysis-engine-label and #analysis-engine-caveat, no "Beginner Engine"', () => {
    const html = read('index.html');
    assert(html.includes('id="analysis-engine-label"'), 'missing id="analysis-engine-label"');
    assert(html.includes('id="analysis-engine-caveat"'), 'missing id="analysis-engine-caveat"');
    assert(!html.includes('Beginner Engine'), 'index.html still says "Beginner Engine"');
    assert(!/Lightweight local heuristic engine/.test(html), 'index.html still describes the PST heuristic as the engine');
    assert(/Stockfish 19 \(GPL-3\.0\)/.test(html), 'index.html lacks the Stockfish 19 (GPL-3.0) credit line');
  });
}

(async () => {
  console.log('=== Wave 1: real engine proof (E1 / D4) ===\n');
  await sectionVendor();
  await sectionWiring();
  await sectionCsp();
  await sectionEngineRuns();
  await sectionIndexHtml();

  console.log('\n--- wave1-engine-selftest summary ---');
  console.log('Passed: ' + passed);
  console.log('Failed: ' + failures.length);
  if (failures.length) {
    failures.forEach(f => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('\nAll ' + passed + ' tests passed successfully!');
  process.exit(0);
})().catch((err) => {
  console.error('FATAL: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
