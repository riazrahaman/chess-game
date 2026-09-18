'use strict';

/**
 * engine-server.js — E1b: server-side Stockfish 19 (lite, single-threaded WASM)
 * for the Play-vs-Computer bots and any other server-side analysis.
 *
 * Runs the vendored engine (`vendor/stockfish/`) inside a `worker_threads`
 * Worker so a search never blocks the HTTP event loop. This file is BOTH the
 * main-thread client and the worker script (it re-requires itself as the
 * Worker entry and branches on `isMainThread`).
 *
 * Why the loader needs a `require` shim: the emscripten loader checks
 * `require('worker_threads').isMainThread` and, when false, assumes it is
 * being driven as a raw message worker and exports nothing. We evaluate its
 * source with a shimmed `require` that reports `isMainThread: true` so it
 * exports its INIT factory like it does on the main thread.
 *
 * Public API (main thread):
 *   getEngine()   -> singleton EngineServer
 *   analyse(fen, { depth, movetime, multiPv, elo, skill })
 *                 -> Promise<{ bestMove, lines:[{ move, scoreCp, mate, depth, pv }], engine }>
 *   isAvailable() -> boolean (vendored files present and engine not crashed)
 *   shutdown()    -> Promise<void>
 *
 * Requests are serialised: one search at a time, FIFO queue. Two active bot
 * rooms therefore take turns (~movetime each). Scores are from the side to
 * move's perspective (UCI convention). This module never uses Math.random —
 * any non-determinism at limited strength comes from Stockfish's own Skill
 * picker.
 */

const path = require('path');
const fs = require('fs');
const { Worker, isMainThread, parentPort } = require('worker_threads');

const ENGINE_NAME = 'stockfish19-lite';
const VENDOR_DIR = path.join(__dirname, '..', 'vendor', 'stockfish');
const LOADER_PATH = path.join(VENDOR_DIR, 'stockfish-19-lite-single.js');
const WASM_PATH = path.join(VENDOR_DIR, 'stockfish-19-lite-single.wasm');

const UCI_ELO_MIN = 1320;
const UCI_ELO_MAX = 3190;
const DEFAULT_DEPTH = 12;
const MAX_DEPTH = 40;
const MAX_MOVETIME_MS = 30000;
const INIT_TIMEOUT_MS = 20000;
const READY_TIMEOUT_MS = 5000;
const SEARCH_GRACE_MS = 4000;     // extra beyond movetime before we send `stop`
const DEPTH_ONLY_TIMEOUT_MS = 15000; // hard cap when only depth is given
const STOP_GRACE_MS = 1500;       // time to wait for bestmove after `stop`
const MAX_RESTARTS = 3;

/* ------------------------------------------------------------------------ */
/* Worker side                                                               */
/* ------------------------------------------------------------------------ */

function runWorker() {
  const post = (msg) => parentPort.postMessage(msg);
  let engine = null;
  const pending = [];

  function send(cmd) {
    engine.ccall('command', null, ['string'], [cmd], { async: /^go\b/.test(cmd) });
  }

  try {
    const src = fs.readFileSync(LOADER_PATH, 'utf8');
    const shimRequire = (id) => (id === 'worker_threads' ? { isMainThread: true } : require(id));
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', '__dirname', '__filename', src)(
      shimRequire, mod, mod.exports, VENDOR_DIR, LOADER_PATH
    );
    const INIT = mod.exports;
    if (typeof INIT !== 'function') throw new Error('vendored loader did not export an INIT factory');

    engine = {
      arguments: [],
      locateFile: (f) => (f.endsWith('.wasm') ? WASM_PATH : path.join(VENDOR_DIR, f)),
      listener: (line) => post({ type: 'line', text: String(line) })
    };

    INIT()(engine).then(function ready() {
      if (engine._isReady && !engine._isReady()) return setTimeout(ready, 10);
      post({ type: 'ready' });
      while (pending.length) send(pending.shift());
      return undefined;
    }).catch((err) => post({ type: 'fatal', error: String(err && err.stack || err) }));
  } catch (err) {
    post({ type: 'fatal', error: String(err && err.stack || err) });
    return;
  }

  parentPort.on('message', (msg) => {
    if (!msg || msg.type !== 'cmd') return;
    const cmd = String(msg.text);
    try {
      if (engine && typeof engine.ccall === 'function' && (!engine._isReady || engine._isReady())) send(cmd);
      else pending.push(cmd);
    } catch (err) {
      post({ type: 'fatal', error: String(err && err.stack || err) });
    }
  });
}

/* ------------------------------------------------------------------------ */
/* Main-thread client                                                        */
/* ------------------------------------------------------------------------ */

function clampInt(v, lo, hi, dflt) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

/** Parse one `info ... multipv N score cp|mate X ... pv ...` line. */
function parseInfoLine(line) {
  if (!/^info\b/.test(line) || !/\bpv\b/.test(line) || !/\bscore\b/.test(line)) return null;
  const tokens = line.split(/\s+/);
  const out = { multipv: 1, depth: 0, scoreCp: null, mate: null, pv: [], bound: null };
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === 'depth') out.depth = parseInt(tokens[++i], 10) || 0;
    else if (t === 'multipv') out.multipv = parseInt(tokens[++i], 10) || 1;
    else if (t === 'score') {
      const kind = tokens[++i];
      const val = parseInt(tokens[++i], 10);
      if (kind === 'cp') out.scoreCp = val;
      else if (kind === 'mate') out.mate = val;
      if (tokens[i + 1] === 'lowerbound' || tokens[i + 1] === 'upperbound') out.bound = tokens[++i];
    } else if (t === 'pv') {
      out.pv = tokens.slice(i + 1);
      break;
    } else if (t === 'string') {
      return null;
    }
  }
  if (out.scoreCp === null && out.mate === null) return null;
  return out;
}

class EngineServer {
  constructor() {
    this.worker = null;
    this.readyPromise = null;
    this.crashed = false;
    this.restarts = 0;
    this.queue = [];
    this.busy = false;
    this.lineHandler = null;
    this.shuttingDown = false;
    this.lastError = null;
  }

  isAvailable() {
    if (this.shuttingDown) return false;
    if (this.crashed && this.restarts >= MAX_RESTARTS) return false;
    try {
      return fs.existsSync(LOADER_PATH) && fs.existsSync(WASM_PATH);
    } catch (_) {
      return false;
    }
  }

  /** Spawn the worker (idempotent) and resolve once the engine reports ready. */
  ready() {
    if (this.readyPromise) return this.readyPromise;
    if (!this.isAvailable()) {
      return Promise.reject(new Error('engine-server: vendored Stockfish not available'));
    }
    this.readyPromise = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this._markCrashed(new Error('engine-server: init timeout'));
        reject(this.lastError);
      }, INIT_TIMEOUT_MS);

      let worker;
      try {
        worker = new Worker(__filename);
      } catch (err) {
        clearTimeout(timer);
        settled = true;
        this._markCrashed(err);
        reject(err);
        return;
      }
      this.worker = worker;
      this.crashed = false;
      worker.unref(); // never keep the server process alive on its own

      worker.on('message', (msg) => {
        if (!msg) return;
        if (msg.type === 'line') {
          if (this.lineHandler) this.lineHandler(msg.text);
        } else if (msg.type === 'ready') {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        } else if (msg.type === 'fatal') {
          const err = new Error('engine-server: worker fatal: ' + msg.error);
          this._markCrashed(err);
          if (!settled) { settled = true; clearTimeout(timer); reject(err); }
        }
      });
      worker.on('error', (err) => {
        this._markCrashed(err);
        if (!settled) { settled = true; clearTimeout(timer); reject(err); }
      });
      worker.on('exit', (code) => {
        if (this.shuttingDown) return;
        const err = new Error('engine-server: worker exited with code ' + code);
        this._markCrashed(err);
        if (!settled) { settled = true; clearTimeout(timer); reject(err); }
      });
    });
    return this.readyPromise;
  }

  _markCrashed(err) {
    this.lastError = err;
    this.crashed = true;
    this.readyPromise = null;
    if (this.worker) {
      const w = this.worker;
      this.worker = null;
      try { w.terminate(); } catch (_) { /* ignore */ }
    }
    if (this.lineHandler) {
      const h = this.lineHandler;
      this.lineHandler = null;
      try { h(null, err); } catch (_) { /* ignore */ }
    }
  }

  _send(cmd) {
    if (!this.worker) throw new Error('engine-server: worker not running');
    this.worker.postMessage({ type: 'cmd', text: cmd });
  }

  /**
   * Wait for the first line matching `re`, collecting every line into `sink`
   * (if given). Rejects on timeout or engine crash.
   */
  _waitFor(re, timeoutMs, sink) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.lineHandler = null;
        reject(new Error('engine-server: timed out waiting for ' + re));
      }, timeoutMs);
      this.lineHandler = (line, err) => {
        if (err || line === null) {
          clearTimeout(timer);
          this.lineHandler = null;
          reject(err || new Error('engine-server: engine crashed'));
          return;
        }
        if (sink) sink.push(line);
        if (re.test(line)) {
          clearTimeout(timer);
          this.lineHandler = null;
          resolve(line);
        }
      };
    });
  }

  /**
   * analyse(fen, opts) — queued; one search at a time.
   * opts: depth (1..40), movetime (ms), multiPv (1..10), elo (1320..3190), skill (0..20)
   */
  analyse(fen, opts = {}) {
    if (typeof fen !== 'string' || !fen.trim()) {
      return Promise.reject(new Error('engine-server: fen must be a non-empty string'));
    }
    if (!this.isAvailable()) {
      return Promise.reject(this.lastError || new Error('engine-server: engine unavailable'));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ fen: fen.trim(), opts: opts || {}, resolve, reject });
      this._drain();
    });
  }

  async _drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        try {
          const result = await this._runSearch(job.fen, job.opts);
          job.resolve(result);
        } catch (err) {
          job.reject(err);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  async _runSearch(fen, opts) {
    if (this.crashed) {
      if (this.restarts >= MAX_RESTARTS) throw (this.lastError || new Error('engine-server: engine crashed'));
      this.restarts += 1;
    }
    await this.ready();

    const multiPv = clampInt(opts.multiPv, 1, 10, 1);
    const hasElo = opts.elo !== undefined && opts.elo !== null;
    const elo = hasElo ? clampInt(opts.elo, UCI_ELO_MIN, UCI_ELO_MAX, UCI_ELO_MIN) : null;
    const hasSkill = opts.skill !== undefined && opts.skill !== null;
    const skill = hasSkill ? clampInt(opts.skill, 0, 20, 20) : 20;
    const hasMovetime = opts.movetime !== undefined && opts.movetime !== null;
    const movetime = hasMovetime ? clampInt(opts.movetime, 1, MAX_MOVETIME_MS, 1000) : null;
    const hasDepth = opts.depth !== undefined && opts.depth !== null;
    const depth = hasDepth ? clampInt(opts.depth, 1, MAX_DEPTH, DEFAULT_DEPTH) : (hasMovetime ? null : DEFAULT_DEPTH);

    // Always set the FULL option set: the engine is a shared singleton, so a
    // limited-strength search must never leak into the next full-strength one.
    this._send('ucinewgame');
    this._send('setoption name MultiPV value ' + multiPv);
    this._send('setoption name Skill Level value ' + skill);
    if (elo !== null) {
      this._send('setoption name UCI_LimitStrength value true');
      this._send('setoption name UCI_Elo value ' + elo);
    } else {
      this._send('setoption name UCI_LimitStrength value false');
    }
    this._send('position fen ' + fen);
    this._send('isready');
    await this._waitFor(/^readyok\b/, READY_TIMEOUT_MS);

    let go = 'go';
    if (depth !== null) go += ' depth ' + depth;
    if (movetime !== null) go += ' movetime ' + movetime;
    const timeoutMs = movetime !== null ? movetime + SEARCH_GRACE_MS : DEPTH_ONLY_TIMEOUT_MS;

    const lines = [];
    this._send(go);
    let bestLine;
    try {
      bestLine = await this._waitFor(/^bestmove\b/, timeoutMs, lines);
    } catch (err) {
      if (!this.worker) throw err; // crashed
      // Wedged search: ask it to stop and give it a moment; otherwise restart.
      try {
        this._send('stop');
        bestLine = await this._waitFor(/^bestmove\b/, STOP_GRACE_MS, lines);
      } catch (_) {
        this._markCrashed(new Error('engine-server: search did not terminate (' + err.message + ')'));
        throw this.lastError;
      }
    }

    const bm = bestLine.split(/\s+/)[1] || '';
    const bestMove = /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(bm) ? bm : null;

    // Keep the deepest (and latest) exact line per multipv slot.
    const byPv = new Map();
    for (const raw of lines) {
      const info = parseInfoLine(raw);
      if (!info || info.pv.length === 0) continue;
      const prev = byPv.get(info.multipv);
      if (!prev || info.depth > prev.depth || (info.depth === prev.depth && (!info.bound || prev.bound))) {
        byPv.set(info.multipv, info);
      }
    }
    const out = [...byPv.entries()].sort((a, b) => a[0] - b[0]).map(([, info]) => ({
      move: info.pv[0],
      scoreCp: info.scoreCp,
      mate: info.mate,
      depth: info.depth,
      pv: info.pv.slice()
    }));

    return { bestMove, lines: out, engine: ENGINE_NAME };
  }

  async shutdown() {
    this.shuttingDown = true;
    const w = this.worker;
    this.worker = null;
    this.readyPromise = null;
    for (const job of this.queue.splice(0)) {
      job.reject(new Error('engine-server: shutting down'));
    }
    if (w) {
      try { w.postMessage({ type: 'cmd', text: 'quit' }); } catch (_) { /* ignore */ }
      try { await w.terminate(); } catch (_) { /* ignore */ }
    }
    this.shuttingDown = false;
    this.crashed = false;
    this.restarts = 0;
  }
}

let singleton = null;
function getEngine() {
  if (!singleton) singleton = new EngineServer();
  return singleton;
}

function analyse(fen, opts) { return getEngine().analyse(fen, opts); }
function isAvailable() { return getEngine().isAvailable(); }
function shutdown() { return getEngine().shutdown(); }

if (!isMainThread && parentPort && require.main === module) {
  runWorker();
}

module.exports = {
  getEngine,
  analyse,
  isAvailable,
  shutdown,
  ENGINE_NAME,
  UCI_ELO_MIN,
  UCI_ELO_MAX,
  EngineServer,
  parseInfoLine
};
