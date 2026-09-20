// ui-analysis.js — Analysis view (Wave 2, roadmap R5 / E3).
//
// Registers the `analysis` view with the site shell (src/shell.js) and renders
// its own analysis board — NOT the live `#board` of the Play view. Everything
// shown here derives from server-reported data or the analysis worker:
//
//   * game sources: the current room (`GET /api/state` → positions[] per ply,
//     referee-served), an archived game (`GET /api/games/:id` → positions[]),
//     or a pasted FEN validated by `POST /api/fen/validate`.
//   * engine lines: a SECOND `new Worker('/src/stockfish-worker.js')` owned by
//     this view. Protocol (see that file): `{type:'position', fen, depth}` in,
//     `{type:'eval', fen, eval, multipv:[...], depth, engine, partial}` out,
//     `{type:'uci', command:'setoption name MultiPV value 3'}` for MultiPV.
//   * opening: `GET /api/openings/lookup` (lichess chess-openings, CC0) and
//     `GET /api/openings/personal` ("your games" from the archive). No
//     popularity or win-rate figures — none exist in the dataset.
//   * book badge: window.MastersDb, fed from the lookup answers.
//   * tablebase: window.Tablebase (lichess Syzygy, ≤ 7 pieces; offline → "n/a").
//   * ACPL / phase accuracy: window.Acpl over the evals this view collected.
//   * exports: window.PovExport (annotated PGN + summary-card SVG) and
//     window.EmbedViewer (FEN→SVG + iframe embed snippet).
//   * missed tactics (Wave 3, N1.3): `GET /api/games/:id/missed-tactics` for an
//     archived game or `POST /api/review/missed-tactics {moves}` for the room
//     game — server-side Stockfish + missed-tactics.js. "Retry" puts the
//     analysis board on the position before the Miss, hides the engine, and
//     compares the user's two-click attempt with the best move. The attempt is
//     display-only: it is never sent to the referee.
//
// Gate 4: display only. This file never mutates game state, never replays moves
// client-side, and never posts to a referee command endpoint.
(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const WORKER_PATH = '/src/stockfish-worker.js';
  // Depth is only pinned once the worker reports the real engine: the PST
  // fallback searches synchronously and a deep request would block the worker
  // (and the 'engine-ready' upgrade) for minutes. Before that the worker's own
  // default depth applies (PST: 3, Stockfish: 16).
  const ENGINE_DEPTH = 16;
  const BATCH_DEPTH = 12;
  const SF_ENGINE_ID = 'stockfish19-lite';
  const MULTIPV = 3;
  const FILES = 'abcdefgh';

  // ---------------------------------------------------------------- state
  const state = {
    source: null,           // 'room' | 'archive' | 'fen'
    label: '',
    positions: [{ fen: START_FEN, san: null, lastMove: null }],
    uci: [],                // UCI per ply (positions[i+1] reached by uci[i])
    tags: {},
    result: '*',
    ply: 0,
    evals: [],              // White-perspective centipawns per ply index
    evalDepth: [],
    engine: null,           // { id, name }
    lines: [],              // current MultiPV lines for positions[ply]
    worker: null,
    workerReady: false,
    batch: null,            // { i, total } while "Analyse all" runs
    lookupCache: new Map(), // moves key → lookup response
    personalCache: new Map(),
    tbCache: new Map(),
    pendingFen: null,
    gameId: null,           // archive id when source === 'archive'
    missed: null,           // { misses:[], engine, plies } from the review route
    retry: null,            // { miss, from, attempts, solved, revealed } while retrying a Miss
    el: null,
    mounted: false
  };

  // ---------------------------------------------------------------- utils
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function $(sel) { return state.el ? state.el.querySelector(sel) : null; }
  function fenTurn(fen) { return (String(fen || '').split(/\s+/)[1] || 'w') === 'b' ? 'black' : 'white'; }
  function currentFen() { return (state.positions[state.ply] && state.positions[state.ply].fen) || START_FEN; }
  function movesBefore(ply) { return state.uci.slice(0, ply); }
  function fmtCp(cp, mate) {
    if (typeof mate === 'number' && mate !== 0) return (mate > 0 ? '+M' : '-M') + Math.abs(mate);
    if (typeof cp !== 'number' || isNaN(cp)) return '—';
    const v = cp / 100;
    return (v > 0 ? '+' : '') + v.toFixed(2);
  }
  function roomId() {
    try {
      if (typeof getCurrentRoomId === 'function') return getCurrentRoomId(); // ui.js global
    } catch (_) { /* fall through */ }
    const m = window.location.pathname.match(/\/game\/([^/]+)/);
    if (m) return decodeURIComponent(m[1]);
    const q = new URLSearchParams(window.location.search).get('room');
    return q && /^[a-zA-Z0-9_-]+$/.test(q) ? q : 'default';
  }
  function fetchJson(url, opts) {
    return fetch(url, opts).then(r => r.json().then(j => ({ status: r.status, body: j })));
  }
  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return Promise.reject(new Error('clipboard unavailable'));
  }
  function setStatus(msg, isError) {
    const el = $('[data-an="status"]');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('an-error', !!isError);
  }

  // ---------------------------------------------------------------- markup
  const CSS = `
    .an-view { display: grid; gap: 16px; padding: 0 16px 24px; max-width: 1200px; margin: 0 auto; }
    .an-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .an-toolbar input[type=text] { flex: 1 1 220px; min-height: 36px; padding: 4px 8px; border: 1px solid var(--panel-border, #ccc); border-radius: 6px; background: var(--panel-bg, #fff); color: inherit; }
    .an-toolbar button, .an-panel button { min-height: 36px; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--panel-border, #ccc); background: var(--panel-bg, #fff); color: inherit; cursor: pointer; font: inherit; }
    .an-toolbar button:hover, .an-panel button:hover { border-color: var(--accent, #355a42); }
    .an-status { min-height: 1.2em; font-size: 0.85rem; color: var(--muted, #666); }
    .an-status.an-error { color: #b42318; }
    .an-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
    @media (min-width: 900px) { .an-layout { grid-template-columns: minmax(280px, 560px) minmax(280px, 1fr); } }
    .an-board { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); grid-template-rows: repeat(8, minmax(0, 1fr)); width: 100%; max-width: 560px; aspect-ratio: 1; border: 2px solid var(--board-border, #5a4632); }
    .an-board .square { cursor: default; touch-action: auto; }
    .an-board .an-last { box-shadow: inset 0 0 0 3px rgba(255, 213, 79, 0.85); }
    .an-board .an-best { box-shadow: inset 0 0 0 3px rgba(37, 99, 235, 0.75); }
    .an-scrub { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
    .an-scrub input[type=range] { flex: 1 1 160px; }
    .an-moves { display: flex; flex-wrap: wrap; gap: 2px 6px; margin-top: 8px; font-family: ui-monospace, Menlo, monospace; font-size: 0.9rem; max-height: 180px; overflow: auto; }
    .an-moves .an-num { color: var(--muted, #666); }
    .an-moves button { border: 0; background: transparent; padding: 2px 4px; border-radius: 4px; color: inherit; cursor: pointer; font: inherit; min-height: 28px; }
    .an-moves button[aria-current="true"] { background: var(--accent-soft, #e3ebdf); font-weight: 600; }
    .an-panels { display: grid; gap: 12px; }
    .an-panel { border: 1px solid var(--panel-border, #ccc); border-radius: 8px; padding: 10px 12px; background: var(--panel-bg, #fff); }
    .an-panel h3 { margin: 0 0 6px; font-size: 0.95rem; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .an-panel h3 .an-sub { font-weight: 400; font-size: 0.8rem; color: var(--muted, #666); }
    .an-lines { list-style: none; margin: 0; padding: 0; font-family: ui-monospace, Menlo, monospace; font-size: 0.85rem; }
    .an-lines li { display: flex; gap: 10px; padding: 3px 0; border-top: 1px solid var(--panel-row-border, #eee); }
    .an-lines li:first-child { border-top: 0; }
    .an-lines .an-score { min-width: 4.5em; font-weight: 600; }
    .an-lines .an-pv { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .an-badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 0.75rem; border: 1px solid var(--panel-border, #ccc); }
    .an-badge.an-book { background: var(--accent-soft, #e3ebdf); border-color: var(--accent, #355a42); }
    .an-kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; font-size: 0.85rem; }
    .an-kv dt { color: var(--muted, #666); } .an-kv dd { margin: 0; }
    .an-conts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
    .an-conts span { font-size: 0.8rem; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--panel-border, #ccc); }
    .an-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .an-mono { font-family: ui-monospace, Menlo, monospace; font-size: 0.8rem; word-break: break-all; }
    .an-muted { color: var(--muted, #666); font-size: 0.8rem; }
    .an-board .an-sel { box-shadow: inset 0 0 0 3px rgba(255, 119, 105, 0.9); }
    .an-board .an-reveal { box-shadow: inset 0 0 0 3px rgba(22, 163, 74, 0.85); }
    .an-board.an-retry .square { cursor: pointer; }
    .an-moves button.an-miss { text-decoration: underline wavy #ff7769; }
    .an-misses { list-style: none; margin: 0; padding: 0; font-size: 0.85rem; }
    .an-misses li { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; padding: 4px 0; border-top: 1px solid var(--panel-row-border, #eee); }
    .an-misses li:first-child { border-top: 0; }
    .an-misses .an-miss-tag { color: #ff7769; font-weight: 700; }
    .an-retry-box { margin-top: 8px; padding: 8px; border: 1px dashed #ff7769; border-radius: 6px; }
    .an-retry-box.an-solved { border-color: #16a34a; }
  `;

  function buildMarkup() {
    return `
      <style>${CSS}</style>
      <div class="an-view">
        <h2 style="margin:0">Analysis</h2>
        <div class="an-toolbar" role="group" aria-label="Load a game">
          <button type="button" data-an="load-room">Current game</button>
          <input type="text" data-an="archive-id" placeholder="Archive game id" aria-label="Archive game id">
          <button type="button" data-an="load-archive">Load archived</button>
          <input type="text" data-an="fen" placeholder="Paste a FEN" aria-label="FEN">
          <button type="button" data-an="load-fen">Load FEN</button>
        </div>
        <div class="an-status" data-an="status" aria-live="polite"></div>
        <div class="an-layout">
          <div>
            <div class="an-board" data-an="board" role="img" aria-label="Analysis board"></div>
            <div class="an-scrub">
              <button type="button" data-an="first" aria-label="First position">|&lt;</button>
              <button type="button" data-an="prev" aria-label="Previous ply">&lt;</button>
              <input type="range" min="0" max="0" value="0" data-an="range" aria-label="Ply">
              <button type="button" data-an="next" aria-label="Next ply">&gt;</button>
              <button type="button" data-an="last" aria-label="Last position">&gt;|</button>
              <span class="an-muted" data-an="ply-label">Ply 0</span>
            </div>
            <div class="an-moves" data-an="moves" aria-label="Move list"></div>
            <p class="an-mono" data-an="fen-out"></p>
          </div>
          <div class="an-panels">
            <section class="an-panel" aria-label="Engine">
              <h3>Engine <span class="an-sub" data-an="engine-label">starting…</span></h3>
              <ul class="an-lines" data-an="lines"><li class="an-muted">Waiting for the engine…</li></ul>
              <div class="an-actions" style="margin-top:8px">
                <button type="button" data-an="analyse-all">Analyse all plies</button>
                <span class="an-muted" data-an="batch-label"></span>
              </div>
            </section>
            <section class="an-panel" aria-label="Opening">
              <h3>Opening <span data-an="book-badge" class="an-badge">unknown</span></h3>
              <div data-an="opening"><span class="an-muted">—</span></div>
              <div data-an="personal" class="an-muted" style="margin-top:6px"></div>
              <p class="an-muted" style="margin:6px 0 0">Names: lichess chess-openings (CC0). "Your games": this server's archive only. No popularity or win-rate figures are shown because the dataset has none.</p>
            </section>
            <section class="an-panel" aria-label="Tablebase">
              <h3>Tablebase <span class="an-sub">lichess Syzygy, ≤ 7 pieces</span></h3>
              <div data-an="tablebase" class="an-muted">Not an endgame yet.</div>
            </section>
            <section class="an-panel" aria-label="Accuracy">
              <h3>Accuracy <span class="an-sub" data-an="acpl-sub">from this view's engine evals</span></h3>
              <div data-an="acpl" class="an-muted">Run "Analyse all plies" to compute ACPL and phase accuracy.</div>
            </section>
            <section class="an-panel" aria-label="Missed tactics">
              <h3>Missed tactics <span class="an-sub" data-an="missed-sub">opponent blunders you did not punish</span></h3>
              <div class="an-actions">
                <button type="button" data-an="missed-load">Find missed tactics</button>
                <span class="an-muted" data-an="missed-label"></span>
              </div>
              <ul class="an-misses" data-an="missed-list"><li class="an-muted">Load a game, then "Find missed tactics". Server engine, depth 12; a Miss = the opponent handed you ≥ 1.5 pawns and your reply gave ≥ 1 pawn back.</li></ul>
              <div class="an-retry-box hidden" data-an="retry-box" aria-live="polite"></div>
            </section>
            <section class="an-panel" aria-label="Export">
              <h3>Export</h3>
              <div class="an-actions">
                <button type="button" data-an="export-pgn-white">PGN (White POV)</button>
                <button type="button" data-an="export-pgn-black">PGN (Black POV)</button>
                <button type="button" data-an="export-card">Summary card (SVG)</button>
                <button type="button" data-an="export-embed">Copy embed snippet</button>
                <button type="button" data-an="export-svg">Position SVG</button>
              </div>
              <textarea data-an="export-out" class="an-mono" rows="4" style="width:100%;margin-top:8px" readonly aria-label="Export output"></textarea>
            </section>
          </div>
        </div>
      </div>`;
  }

  // ---------------------------------------------------------------- board
  function renderBoard() {
    const board = $('[data-an="board"]');
    if (!board) return;
    const fen = currentFen();
    const arr = window.EmbedViewer ? window.EmbedViewer.fenBoardToArray(fen.split(/\s+/)[0]) : [];
    const last = state.positions[state.ply] && state.positions[state.ply].lastMove;
    const retry = state.retry && state.retry.miss && state.ply === state.retry.miss.ply - 1 ? state.retry : null;
    const best = !retry && state.lines[0] && state.lines[0].move; // hidden while retrying a Miss
    const reveal = retry && (retry.revealed || retry.solved) ? String(retry.miss.bestMove || '') : '';
    const markup = typeof pieceSvgMarkup === 'function' ? pieceSvgMarkup : null;
    board.classList.toggle('an-retry', !!retry && !retry.solved);
    let html = '';
    for (let i = 0; i < 64; i++) {
      const r = Math.floor(i / 8), c = i % 8;
      const sq = FILES[c] + (8 - r);
      const light = (r + c) % 2 === 0;
      const cls = ['square', light ? 'white-sq' : 'black-sq'];
      if (last && (last.from === sq || last.to === sq)) cls.push('an-last');
      if (best && (best.slice(0, 2) === sq || best.slice(2, 4) === sq)) cls.push('an-best');
      if (retry && retry.from === sq) cls.push('an-sel');
      if (reveal && (reveal.slice(0, 2) === sq || reveal.slice(2, 4) === sq)) cls.push('an-reveal');
      const p = arr[i];
      let piece = '';
      if (p && markup) piece = markup(p === p.toUpperCase() ? 'white' : 'black', p.toLowerCase());
      html += `<div class="${cls.join(' ')}" data-an-square="${sq}">${piece}</div>`;
    }
    board.innerHTML = html;
    board.setAttribute('aria-label', 'Analysis board, ' + fenTurn(fen) + ' to move');
    const fenOut = $('[data-an="fen-out"]');
    if (fenOut) fenOut.textContent = fen;
  }

  function renderMoves() {
    const host = $('[data-an="moves"]');
    if (!host) return;
    let html = '';
    html += `<button type="button" data-an-ply="0" ${state.ply === 0 ? 'aria-current="true"' : ''}>start</button>`;
    for (let i = 1; i < state.positions.length; i++) {
      if (i % 2 === 1) html += `<span class="an-num">${Math.ceil(i / 2)}.</span>`;
      const san = state.positions[i].san || state.uci[i - 1] || '?';
      const isMiss = missSet().has(i);
      html += `<button type="button" data-an-ply="${i}" class="${isMiss ? 'an-miss' : ''}" ${isMiss ? 'title="Miss"' : ''} ${state.ply === i ? 'aria-current="true"' : ''}>${esc(san)}${isMiss ? ' ✕' : ''}</button>`;
    }
    host.innerHTML = html;
    const range = $('[data-an="range"]');
    if (range) { range.max = String(state.positions.length - 1); range.value = String(state.ply); }
    const lbl = $('[data-an="ply-label"]');
    if (lbl) lbl.textContent = `Ply ${state.ply} / ${state.positions.length - 1}`;
  }

  // ---------------------------------------------------------------- engine
  function ensureWorker() {
    if (state.worker) return;
    try {
      const w = new Worker(WORKER_PATH);
      state.worker = w;
      w.onmessage = ev => onWorkerMessage(ev.data);
      w.onerror = err => { setStatus('Engine worker error: ' + (err && err.message ? err.message : 'unknown'), true); };
      w.postMessage({ type: 'uci', command: `setoption name MultiPV value ${MULTIPV}` });
    } catch (e) {
      setStatus('Engine worker unavailable: ' + e.message, true);
    }
  }

  function onWorkerMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'engine-ready') {
      state.workerReady = true;
      state.engine = { id: msg.engine, name: msg.name };
      const lbl = $('[data-an="engine-label"]');
      if (lbl) lbl.textContent = msg.name || msg.engine || 'engine';
      state.worker.postMessage({ type: 'uci', command: `setoption name MultiPV value ${MULTIPV}` });
      requestEval();
      return;
    }
    if (msg.type !== 'eval' || typeof msg.fen !== 'string') return;
    const plyIdx = state.positions.findIndex(p => p.fen === msg.fen);
    if (plyIdx >= 0 && typeof msg.eval === 'number' && !msg.partial) {
      if ((state.evalDepth[plyIdx] || 0) <= (msg.depth || 0)) {
        state.evals[plyIdx] = msg.eval;
        state.evalDepth[plyIdx] = msg.depth || 0;
      }
    }
    if (state.batch) {
      if (!msg.partial && msg.fen === state.positions[state.batch.i].fen) batchNext();
      return; // batch mode shows the summary, not per-position lines
    }
    if (msg.fen !== currentFen()) return; // stale answer for a position we left
    if (state.retry && !state.retry.solved && !state.retry.revealed && state.ply === state.retry.miss.ply - 1) return; // engine hidden during retry
    const lines = Array.isArray(msg.multipv) && msg.multipv.length ? msg.multipv : [{ pvIndex: 1, bestMove: msg.bestMove, scoreRaw: msg.eval, depth: msg.depth, mate: msg.mate, pv: msg.pv }];
    state.lines = lines.filter(Boolean).map((l, i) => ({
      idx: l.pvIndex || i + 1,
      move: l.bestMove || (l.pv && l.pv[0]) || null,
      cp: typeof l.scoreRaw === 'number' ? l.scoreRaw : (typeof l.scoreCp === 'number' ? l.scoreCp * 100 : null),
      mate: l.mate == null ? null : l.mate,
      depth: l.depth || msg.depth || 0,
      pv: Array.isArray(l.pv) ? l.pv : []
    }));
    renderLines(msg);
    renderBoard();
  }

  function renderLines(msg) {
    const ul = $('[data-an="lines"]');
    if (!ul) return;
    if (!state.lines.length) { ul.innerHTML = '<li class="an-muted">No line.</li>'; return; }
    ul.innerHTML = state.lines.map(l =>
      `<li data-an-line="${l.idx}" data-depth="${l.depth}"><span class="an-score">${esc(fmtCp(l.cp, l.mate))}</span><span class="an-pv" title="${esc(l.pv.join(' '))}">${esc(l.pv.join(' ') || l.move || '')}</span><span class="an-muted">d${l.depth}</span></li>`
    ).join('');
    const lbl = $('[data-an="engine-label"]');
    if (lbl) lbl.textContent = `${(state.engine && state.engine.name) || msg.engine || 'engine'} · depth ${msg.depth || 0}${msg.partial ? '…' : ''}`;
  }

  function requestEval() {
    if (!state.worker || state.batch) return;
    const fen = currentFen();
    state.lines = [];
    const ul = $('[data-an="lines"]');
    if (state.retry && !state.retry.solved && !state.retry.revealed && state.ply === state.retry.miss.ply - 1) {
      if (ul) ul.innerHTML = '<li class="an-muted">Engine hidden while you retry the missed tactic.</li>';
      return;
    }
    if (ul) ul.innerHTML = '<li class="an-muted">Thinking…</li>';
    state.worker.postMessage(positionRequest(fen, ENGINE_DEPTH));
  }

  function positionRequest(fen, depth) {
    const msg = { type: 'position', fen };
    if (state.workerReady && state.engine && state.engine.id === SF_ENGINE_ID) msg.depth = depth;
    return msg;
  }

  function startBatch() {
    if (!state.worker || state.batch || state.positions.length < 2) return;
    state.batch = { i: 0, total: state.positions.length };
    const btn = $('[data-an="analyse-all"]');
    if (btn) btn.disabled = true;
    batchStep();
  }
  function batchStep() {
    const lbl = $('[data-an="batch-label"]');
    if (lbl) lbl.textContent = `Analysing ${state.batch.i + 1} / ${state.batch.total}…`;
    state.worker.postMessage(positionRequest(state.positions[state.batch.i].fen, BATCH_DEPTH));
  }
  function batchNext() {
    state.batch.i++;
    if (state.batch.i >= state.batch.total) {
      state.batch = null;
      const btn = $('[data-an="analyse-all"]');
      if (btn) btn.disabled = false;
      const lbl = $('[data-an="batch-label"]');
      if (lbl) lbl.textContent = 'Done.';
      fetch('/api/activity', { method: 'POST', credentials: 'include', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'analysis' }) }).then(() => { if (window.Retention) window.Retention.refresh(); }).catch(() => {}); // Wave 3: an analysis batch counts as streak activity (401 for guests is fine)
      renderAccuracy();
      requestEval();
      return;
    }
    batchStep();
  }

  // ---------------------------------------------------------------- panels
  function renderAccuracy() {
    const host = $('[data-an="acpl"]');
    if (!host || !window.Acpl) return;
    const evals = state.positions.map((_, i) => state.evals[i]);
    const have = evals.filter(e => typeof e === 'number').length;
    if (have < 2 || state.uci.length === 0) {
      host.innerHTML = `<span class="an-muted">${have}/${state.positions.length} positions evaluated. Run "Analyse all plies" for ACPL.</span>`;
      return;
    }
    const acpl = window.Acpl.computeAcpl(evals, state.uci);
    const phase = window.Acpl.phaseAcpl(evals, state.uci);
    const ph = p => (p && p.plies ? `${p.overall} (${p.plies} plies)` : '—');
    host.innerHTML = `
      <dl class="an-kv">
        <dt>ACPL White</dt><dd>${acpl.white}</dd>
        <dt>ACPL Black</dt><dd>${acpl.black}</dd>
        <dt>Opening</dt><dd>${ph(phase.opening)}</dd>
        <dt>Middlegame</dt><dd>${ph(phase.middlegame)}</dd>
        <dt>Endgame</dt><dd>${ph(phase.endgame)}</dd>
        <dt>Coverage</dt><dd>${have}/${state.positions.length} positions, ${(state.engine && state.engine.name) || 'engine'}</dd>
      </dl>`;
  }

  function renderOpening() {
    const host = $('[data-an="opening"]');
    const badge = $('[data-an="book-badge"]');
    const personalEl = $('[data-an="personal"]');
    if (!host) return;
    if (state.source === 'fen') {
      host.innerHTML = '<span class="an-muted">Opening names need the move sequence; a bare FEN has none.</span>';
      if (badge) { badge.textContent = 'n/a'; badge.classList.remove('an-book'); }
      if (personalEl) personalEl.textContent = '';
      return;
    }
    const moves = movesBefore(state.ply);
    const key = moves.join(',');
    const apply = (data) => {
      if (!data || !data.ok) { host.innerHTML = '<span class="an-muted">Opening lookup unavailable.</span>'; return; }
      if (window.MastersDb) window.MastersDb.addBookPosition(moves, data.book ? data.continuations : null);
      const bookInfo = window.MastersDb ? window.MastersDb.isBookPosition(moves) : { book: data.book, known: true };
      if (badge) {
        badge.textContent = !bookInfo.known ? 'unknown' : (bookInfo.book ? 'book line' : 'out of book');
        badge.classList.toggle('an-book', !!bookInfo.book);
        badge.title = 'Book = the moves so far lie on a named line in lichess chess-openings (' + (window.MastersDb ? window.MastersDb.BOOK_SOURCE : 'data/openings.tsv') + ')';
      }
      const conts = (data.continuations || []).slice(0, 8).map(c =>
        `<span title="${esc(c.name || '')}">${esc(c.uci)}${c.name ? ' · ' + esc(c.name) : ''} <em class="an-muted">${c.lines} line${c.lines === 1 ? '' : 's'}</em></span>`).join('');
      host.innerHTML = `
        <div><strong data-an="opening-eco">${esc(data.eco || '—')}</strong> <span data-an="opening-name">${esc(data.name || 'Unknown opening')}</span>
          ${data.isExact ? '' : `<span class="an-muted"> (matched ${data.matchedPlies} plies)</span>`}</div>
        ${data.pgn ? `<div class="an-mono">${esc(data.pgn)}</div>` : ''}
        ${conts ? `<div class="an-conts" aria-label="Named continuations">${conts}</div>` : '<div class="an-muted">No named continuation from here.</div>'}`;
    };
    if (state.lookupCache.has(key)) apply(state.lookupCache.get(key));
    else {
      fetchJson('/api/openings/lookup?moves=' + encodeURIComponent(moves.join(',')))
        .then(r => { state.lookupCache.set(key, r.body); apply(r.body); })
        .catch(() => apply(null));
    }
    if (personalEl) {
      const applyP = (p) => {
        if (!p || !p.ok || !p.available) { personalEl.textContent = 'Your games: archive unavailable.'; return; }
        if (p.count === 0) { personalEl.textContent = 'Your games: none reached this position.'; return; }
        personalEl.innerHTML = `<span data-an="personal-stats">Your games (${p.count}, White's view): ${p.wins} W · ${p.draws} D · ${p.losses} L</span>`;
      };
      if (state.personalCache.has(key)) applyP(state.personalCache.get(key));
      else {
        fetchJson('/api/openings/personal?moves=' + encodeURIComponent(moves.join(',')))
          .then(r => { state.personalCache.set(key, r.body); applyP(r.body); })
          .catch(() => applyP(null));
      }
    }
  }

  function renderTablebase() {
    const host = $('[data-an="tablebase"]');
    if (!host) return;
    const TB = window.Tablebase;
    const fen = currentFen();
    if (!TB || !TB.isEndgame(fen, TB.MAX_PIECES)) {
      host.textContent = TB ? `Not an endgame yet (${TB.countPiecesInFen(fen)} pieces; tablebase covers ≤ ${TB.MAX_PIECES}).` : 'Tablebase module unavailable.';
      return;
    }
    const apply = (r) => {
      if (!r || !r.ok) {
        host.textContent = `Tablebase offline (${(r && r.reason) || 'no answer'}) — using the engine lines above instead.`;
        return;
      }
      const b = r.best || {};
      const cat = b.category ? b.category.replace('-', ' ') : (b.wdl ? (b.wdl[0] ? 'win' : b.wdl[2] ? 'loss' : 'draw') : '—');
      host.innerHTML = `<dl class="an-kv">
        <dt>Result (side to move)</dt><dd><strong>${esc(cat)}</strong></dd>
        <dt>Best move</dt><dd>${esc(b.san || b.move || '—')}</dd>
        <dt>DTZ</dt><dd>${b.dtz == null ? '—' : esc(b.dtz)}</dd>
        ${b.dtm != null ? `<dt>DTM</dt><dd>${esc(b.dtm)}</dd>` : ''}
        <dt>Source</dt><dd><a href="${esc(r.url)}" target="_blank" rel="noopener">tablebase.lichess.ovh</a></dd>
      </dl>`;
    };
    if (state.tbCache.has(fen)) { apply(state.tbCache.get(fen)); return; }
    host.textContent = 'Probing tablebase…';
    TB.probe(fen).then(r => { state.tbCache.set(fen, r); if (currentFen() === fen) apply(r); });
  }

  // ---------------------------------------------------------------- exports
  function povMoves() {
    return state.positions.slice(1).map((p, i) => {
      const m = { san: p.san || state.uci[i] || '?' };
      const e = state.evals[i + 1];
      if (typeof e === 'number') m.evalCp = Math.round(e);
      return m;
    });
  }
  function exportPgn(pov) {
    if (!window.PovExport) return;
    const tags = Object.assign({ Event: 'Analysis', Site: window.location.origin, Date: new Date().toISOString().slice(0, 10).replace(/-/g, '.'), White: 'White', Black: 'Black', Result: state.result || '*' }, state.tags);
    if (state.source === 'fen') { tags.SetUp = '1'; tags.FEN = state.positions[0].fen; }
    const pgn = window.PovExport.buildPovPgn({ moves: povMoves(), pov, tags, result: state.result || '*' });
    const out = $('[data-an="export-out"]');
    if (out) out.value = pgn;
    download(`analysis-${pov}.pgn`, pgn, 'application/x-chess-pgn');
    setStatus(`PGN (${pov} POV) exported.`);
  }
  function exportCard() {
    if (!window.PovExport) return;
    const summary = window.PovExport.summarize({ moves: povMoves(), pov: 'white', result: state.result || '*' });
    const svg = window.PovExport.summaryCardSvg(summary);
    const out = $('[data-an="export-out"]');
    if (out) out.value = svg;
    download('summary-card.svg', svg, 'image/svg+xml');
    setStatus('Summary card exported.');
  }
  function exportEmbed() {
    if (!window.EmbedViewer) return;
    const html = window.EmbedViewer.iframeSnippet({ fen: currentFen(), title: 'Chess position' });
    if (!html) { setStatus('Could not build embed snippet.', true); return; }
    const snippet = `<iframe width="400" height="400" style="border:0" title="Chess position" srcdoc="${html.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe>`;
    const out = $('[data-an="export-out"]');
    if (out) out.value = snippet;
    copyText(snippet).then(() => setStatus('Embed snippet copied to clipboard.'), () => setStatus('Embed snippet shown below (clipboard unavailable).'));
  }
  function exportSvg() {
    if (!window.EmbedViewer) return;
    const svg = window.EmbedViewer.boardSvg(window.EmbedViewer.fenBoardToArray(currentFen().split(/\s+/)[0]));
    const out = $('[data-an="export-out"]');
    if (out) out.value = svg;
    download('position.svg', svg, 'image/svg+xml');
    setStatus('Position SVG exported.');
  }

  // ---------------------------------------------------------------- missed tactics (Wave 3, N1.3)
  function missSet() {
    const set = new Set();
    if (state.missed && Array.isArray(state.missed.misses)) for (const m of state.missed.misses) set.add(m.ply);
    return set;
  }
  function colorLabel(c) { return c === 'white' ? 'White' : 'Black'; }
  function uciToText(uci) { return uci ? uci.slice(0, 2) + '→' + uci.slice(2, 4) + (uci[4] ? '=' + uci[4].toUpperCase() : '') : '?'; }
  // Why the server stopped early: 'budget' = time/search cap, 'max-plies' = the
  // game is longer than the position cap. Anything else stays honest and generic.
  function truncationNote(reason) { return reason === 'max-plies' ? 'position cap reached' : reason === 'budget' ? 'budget reached' : 'analysis stopped early'; }

  function loadMissed() {
    const label = $('[data-an="missed-label"]');
    if (!state.source || state.source === 'fen' || state.uci.length < 3) {
      if (label) label.textContent = 'Load a game with moves first (a bare FEN has no history).';
      return Promise.resolve();
    }
    if (label) label.textContent = 'Asking the server engine…';
    const btn = $('[data-an="missed-load"]');
    if (btn) btn.disabled = true;
    const req = state.source === 'archive' && state.gameId
      ? fetchJson('/api/games/' + encodeURIComponent(state.gameId) + '/missed-tactics')
      : fetchJson('/api/review/missed-tactics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ moves: state.uci }) });
    return req.then(r => {
      if (!r.body || !r.body.ok) throw new Error((r.body && r.body.error) || ('HTTP ' + r.status));
      const evals = Array.isArray(r.body.evals) ? r.body.evals : [];
      const checked = evals.filter(Boolean).length;
      state.missed = { misses: r.body.misses || [], engine: r.body.engine, plies: r.body.plies, evaluated: r.body.evaluated, cached: r.body.cached, truncated: !!r.body.truncated, truncatedReason: r.body.truncatedReason || null, checked, total: evals.length };
      state.retry = null;
      if (label) {
        if (!r.body.engine) label.textContent = 'Server engine unavailable — nothing evaluated.';
        else if (r.body.truncated) label.textContent = `${r.body.engine} · checked ${checked} of ${evals.length} positions (${truncationNote(r.body.truncatedReason)})${r.body.cached ? ` · ${r.body.cached} cached` : ''}`;
        else label.textContent = `${r.body.engine} · depth ${r.body.depth} · ${r.body.cached} cached / ${r.body.evaluated} new`;
      }
      renderMissed();
      renderMoves();
      renderBoard();
    }).catch(err => {
      if (label) label.textContent = 'Could not compute missed tactics: ' + err.message;
    }).then(() => { if (btn) btn.disabled = false; });
  }

  function renderMissed() {
    const ul = $('[data-an="missed-list"]');
    if (!ul) return;
    if (!state.missed) {
      ul.innerHTML = '<li class="an-muted">Load a game, then "Find missed tactics". Server engine, depth 12; a Miss = the opponent handed you ≥ 1.5 pawns and your reply gave ≥ 1 pawn back.</li>';
      renderRetryBox();
      return;
    }
    const list = state.missed.misses;
    if (!list.length) {
      const scope = state.missed.truncated
        ? `${state.missed.checked} of ${state.missed.total} positions checked (${truncationNote(state.missed.truncatedReason)})`
        : `${state.missed.plies} plies checked`;
      ul.innerHTML = `<li class="an-muted" data-an="missed-empty">No missed tactics in this game (${scope}${state.missed.engine ? '' : ' — engine unavailable'}).</li>`;
      renderRetryBox();
      return;
    }
    ul.innerHTML = list.map((m, i) => `
      <li data-an-miss="${i}">
        <span class="an-miss-tag" title="Miss">✕</span>
        <span>Ply ${m.ply} · ${colorLabel(m.color)} played <strong>${esc(m.playedSan || uciToText(m.playedMove))}</strong></span>
        <span class="an-muted">swing +${(m.swingCp / 100).toFixed(1)} · gave back ${(m.giveBackCp / 100).toFixed(1)} (${esc(m.theme || 'tactic')})</span>
        <button type="button" data-an="missed-retry" data-idx="${i}">Retry</button>
      </li>`).join('');
    renderRetryBox();
  }

  function startRetry(idx) {
    const miss = state.missed && state.missed.misses[idx];
    if (!miss) return;
    state.retry = { miss, from: null, attempts: 0, solved: false, revealed: false, message: `${colorLabel(miss.color)} to move. Find the move ${colorLabel(miss.color)} missed — click a piece, then its destination.` };
    goTo(miss.ply - 1);
    renderRetryBox();
  }

  function retryActiveHere() {
    return state.retry && state.ply === state.retry.miss.ply - 1;
  }

  // Display-only: the attempted move is compared with the engine's best move
  // and never sent anywhere (Gate 4).
  function onRetrySquare(sq) {
    const retry = state.retry;
    if (!retry || retry.solved || !retryActiveHere()) return;
    const fen = currentFen();
    const piece = fenPieceAt(fen, sq);
    const mover = fenTurn(fen);
    const own = piece && ((mover === 'white' && piece === piece.toUpperCase()) || (mover === 'black' && piece === piece.toLowerCase()));
    if (!retry.from) {
      if (!own) { retry.message = 'Pick one of your own pieces first.'; renderRetryBox(); return; }
      retry.from = sq;
      renderBoard(); renderRetryBox();
      return;
    }
    if (own && sq !== retry.from) { retry.from = sq; renderBoard(); renderRetryBox(); return; }
    if (sq === retry.from) { retry.from = null; renderBoard(); renderRetryBox(); return; }
    const attempt = retry.from + sq;
    retry.from = null;
    retry.attempts++;
    const best = String(retry.miss.bestMove || '');
    if (best && best.slice(0, 4) === attempt) {
      retry.solved = true;
      retry.message = `Correct — ${uciToText(best)} was the move you missed. (${retry.attempts} attempt${retry.attempts === 1 ? '' : 's'})`;
      renderBoard(); renderRetryBox(); requestEval();
      return;
    }
    retry.message = `${uciToText(attempt)} is not it${attempt === (retry.miss.playedMove || '').slice(0, 4) ? ' — that is what you played in the game' : ''}. Try again or reveal.`;
    renderBoard(); renderRetryBox();
  }

  function revealRetry() {
    if (!state.retry) return;
    if (state.retry.attempts === 0) {
      state.retry.message = 'Try at least one move before revealing the best move.';
      renderRetryBox();
      return;
    }
    state.retry.revealed = true;
    state.retry.message = `Best was ${uciToText(state.retry.miss.bestMove)} (engine). You played ${esc(state.retry.miss.playedSan || uciToText(state.retry.miss.playedMove))}.`;
    renderBoard(); renderRetryBox(); requestEval();
  }

  function exitRetry() {
    state.retry = null;
    renderBoard(); renderRetryBox(); requestEval();
  }

  function renderRetryBox() {
    const box = $('[data-an="retry-box"]');
    if (!box) return;
    const retry = state.retry;
    if (!retry) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.classList.toggle('an-solved', !!retry.solved);
    const m = retry.miss;
    box.innerHTML = `
      <div><strong>Retry ply ${m.ply}</strong> · ${colorLabel(m.color)} to move${retryActiveHere() ? '' : ' · <button type="button" data-an="missed-back">back to the position</button>'}</div>
      <div data-an="retry-message" style="margin:4px 0">${retry.message}</div>
      <div class="an-actions">
        ${retry.solved || retry.revealed ? '' : (retry.attempts > 0 ? '<button type="button" data-an="missed-reveal">Reveal best move</button>' : '')}
        <button type="button" data-an="missed-exit">Done</button>
      </div>`;
  }

  function fenPieceAt(fen, sq) {
    const arr = window.EmbedViewer ? window.EmbedViewer.fenBoardToArray(String(fen).split(/\s+/)[0]) : [];
    const file = FILES.indexOf(sq[0]);
    const rank = 8 - Number(sq[1]);
    return arr[rank * 8 + file] || null;
  }

  // ---------------------------------------------------------------- loading
  function setGame(g) {
    state.source = g.source;
    state.label = g.label || '';
    state.positions = g.positions && g.positions.length ? g.positions : [{ fen: START_FEN, san: null, lastMove: null }];
    state.uci = g.uci || [];
    state.tags = g.tags || {};
    state.result = g.result || '*';
    state.evals = []; state.evalDepth = []; state.lines = [];
    state.gameId = g.gameId || null;
    state.missed = null; state.retry = null;
    renderMissed();
    state.ply = typeof g.ply === 'number' ? Math.max(0, Math.min(g.ply, state.positions.length - 1)) : state.positions.length - 1;
    setStatus(g.label || '');
    const acpl = $('[data-an="acpl"]');
    if (acpl) acpl.innerHTML = '<span class="an-muted">Run "Analyse all plies" to compute ACPL and phase accuracy.</span>';
    const bl = $('[data-an="batch-label"]');
    if (bl) bl.textContent = '';
    goTo(state.ply);
  }

  function uciFromPositions(positions, movesStr) {
    const fromStr = typeof movesStr === 'string' ? movesStr.trim().split(/\s+/).filter(Boolean) : [];
    if (fromStr.length === positions.length - 1 && fromStr.every(m => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m))) return fromStr;
    // Fall back to the referee-served lastMove squares (promotion piece is not
    // recorded there; the opening book never needs it).
    return positions.slice(1).map(p => (p.lastMove ? p.lastMove.from + p.lastMove.to : '????'));
  }

  function loadRoom() {
    const room = roomId();
    setStatus('Loading current game…');
    return fetchJson('/api/state?room=' + encodeURIComponent(room)).then(r => {
      const s = r.body;
      if (!s || !Array.isArray(s.positions)) throw new Error('no positions in /api/state');
      const uci = uciFromPositions(s.positions, s.history);
      setGame({
        source: 'room',
        label: `Room "${room}" · ${s.positions.length - 1} plies (referee state, read-only)`,
        positions: s.positions,
        uci,
        tags: { Event: 'Live game', Site: window.location.origin, Round: room },
        result: s.result || '*'
      });
    }).catch(err => setStatus('Could not load the current game: ' + err.message, true));
  }

  function loadArchive(id) {
    if (!id) { setStatus('Enter an archive game id.', true); return Promise.resolve(); }
    setStatus('Loading archived game…');
    return fetchJson('/api/games/' + encodeURIComponent(id)).then(r => {
      if (!r.body || !r.body.ok || !r.body.game) throw new Error((r.body && r.body.error) || 'not found');
      const g = r.body.game;
      if (!Array.isArray(g.positions)) throw new Error('archive entry has no positions');
      setGame({
        source: 'archive',
        label: `Archive ${g.id}: ${g.white} vs ${g.black} ${g.result || '*'} (${g.date || ''})`,
        positions: g.positions,
        uci: uciFromPositions(g.positions, g.moves),
        tags: { Event: 'Archived game', White: g.white, Black: g.black, Date: g.date, Result: g.result || '*', ECO: g.eco || '' },
        result: g.result || '*',
        gameId: g.id
      });
      const input = $('[data-an="archive-id"]');
      if (input) input.value = g.id;
    }).catch(err => setStatus('Could not load archived game: ' + err.message, true));
  }

  function loadFen(fen) {
    if (!fen || !fen.trim()) { setStatus('Paste a FEN first.', true); return Promise.resolve(); }
    setStatus('Validating FEN…');
    return fetchJson('/api/fen/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fen: fen.trim() }) })
      .then(r => {
        if (!r.body || !r.body.valid) throw new Error((r.body && r.body.error) || 'invalid FEN');
        setGame({ source: 'fen', label: `Position (${r.body.pieces} pieces, ${r.body.turn} to move)`, positions: [{ fen: r.body.fen, san: null, lastMove: null }], uci: [], tags: { Event: 'Position analysis' } });
        const input = $('[data-an="fen"]');
        if (input) input.value = r.body.fen;
      })
      .catch(err => setStatus('FEN rejected: ' + err.message, true));
  }

  function goTo(ply) {
    state.ply = Math.max(0, Math.min(ply, state.positions.length - 1));
    state.lines = [];
    renderBoard();
    renderMoves();
    renderOpening();
    renderTablebase();
    renderAccuracy();
    renderRetryBox();
    requestEval();
  }

  // ---------------------------------------------------------------- wiring
  function bind() {
    const el = state.el;
    el.addEventListener('click', ev => {
      const t = ev.target.closest('[data-an], [data-an-ply], [data-an-square]');
      if (!t) return;
      if (t.hasAttribute('data-an-square')) { onRetrySquare(t.getAttribute('data-an-square')); return; }
      if (t.hasAttribute('data-an-ply')) { goTo(Number(t.getAttribute('data-an-ply'))); return; }
      switch (t.getAttribute('data-an')) {
        case 'load-room': loadRoom(); break;
        case 'load-archive': loadArchive(($('[data-an="archive-id"]') || {}).value); break;
        case 'load-fen': loadFen(($('[data-an="fen"]') || {}).value); break;
        case 'first': goTo(0); break;
        case 'prev': goTo(state.ply - 1); break;
        case 'next': goTo(state.ply + 1); break;
        case 'last': goTo(state.positions.length - 1); break;
        case 'analyse-all': startBatch(); break;
        case 'export-pgn-white': exportPgn('white'); break;
        case 'export-pgn-black': exportPgn('black'); break;
        case 'export-card': exportCard(); break;
        case 'export-embed': exportEmbed(); break;
        case 'export-svg': exportSvg(); break;
        case 'missed-load': loadMissed(); break;
        case 'missed-retry': startRetry(Number(t.getAttribute('data-idx'))); break;
        case 'missed-reveal': revealRetry(); break;
        case 'missed-back': if (state.retry) goTo(state.retry.miss.ply - 1); break;
        case 'missed-exit': exitRetry(); break;
        default: break;
      }
    });
    const range = $('[data-an="range"]');
    if (range) range.addEventListener('input', () => goTo(Number(range.value)));
    el.addEventListener('keydown', ev => {
      if (ev.target && /^(INPUT|TEXTAREA)$/.test(ev.target.tagName)) return;
      if (ev.key === 'ArrowLeft') { goTo(state.ply - 1); ev.preventDefault(); }
      else if (ev.key === 'ArrowRight') { goTo(state.ply + 1); ev.preventDefault(); }
    });
  }

  function applyParams(params) {
    params = params || {};
    if (params.game) return loadArchive(String(params.game));
    if (params.fen) return loadFen(String(params.fen));
    if (!state.source) return loadRoom();
    return Promise.resolve();
  }

  const view = {
    id: 'analysis',
    title: 'Analysis',
    order: 20,
    nav: true,
    mount(el, params) {
      state.el = el;
      el.innerHTML = buildMarkup();
      bind();
      ensureWorker();
      renderBoard();
      renderMoves();
      state.mounted = true;
      applyParams(params);
    },
    show(el, params) {
      if (!state.mounted) return;
      if (params && (params.game || params.fen)) applyParams(params);
      else if (state.source === 'room') loadRoom(); // refresh referee state on re-entry
      else requestEval();
    },
    hide() {
      // keep the worker warm; nothing to tear down (display only)
    }
  };

  function register() {
    if (window.Shell && typeof window.Shell.registerView === 'function') window.Shell.registerView(view);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', register);
  else register();

  window.UiAnalysis = { view, state, goTo, loadRoom, loadArchive, loadFen, loadMissed, startRetry };
})();
