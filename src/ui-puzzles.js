// ui-puzzles.js — Puzzles view for the site shell (Wave 2, roadmap E4 + R1/R2).
//
// Pure display layer: it renders its OWN small board (pieces.js SVG) inside the
// `[data-view="puzzles"]` section and never touches the live #board or referee
// state (Gate 4: no makeMove / createInitialBoard). Every move the player
// clicks is sent to POST /api/puzzle/:id/try and the SERVER decides legality
// and correctness; the client only redraws the FEN the server reports.
//
// Tabs: Daily · Rated · Custom (theme + rating band) · Storm · Review · Stats.
// Deep link: #/puzzles?theme=fork opens Custom on that theme.
(function () {
  'use strict';

  const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const TABS = [
    { id: 'daily', label: 'Daily' },
    { id: 'rated', label: 'Rated' },
    { id: 'custom', label: 'Custom' },
    { id: 'storm', label: 'Storm' },
    { id: 'review', label: 'Review' },
    { id: 'stats', label: 'Stats' }
  ];
  const RATING_BANDS = [
    { key: 'any', label: 'Your rating', target: null },
    { key: '600-1000', label: '600 – 1000', target: 800 },
    { key: '1000-1400', label: '1000 – 1400', target: 1200 },
    { key: '1400-1800', label: '1400 – 1800', target: 1600 },
    { key: '1800-2200', label: '1800 – 2200', target: 2000 },
    { key: '2200+', label: '2200+', target: 2300 }
  ];

  const state = {
    el: null,
    tab: 'daily',
    mode: 'daily',
    puzzle: null,        // server presentPuzzle() view
    fen: null,           // position currently displayed (server reported)
    moves: [],           // solver's committed moves (UCI) — echoed back by the server
    selected: null,
    lastMove: null,      // { from, to }
    busy: false,
    startedAt: 0,
    status: 'idle',      // idle | intro | playing | solved | failed
    missed: false,       // a wrong move has been committed (rating already settled)
    committed: false,    // /solve sent
    revealed: false,
    solution: null,
    lastResult: null,    // /solve response
    player: null,        // { rating, rd, provisional }
    themes: [],
    customTheme: 'mix',
    customBand: 'any',
    storm: null,         // server storm state
    stormTimer: null,
    stormPuzzleStartedAt: 0,
    review: null,
    dashboard: null,
    message: '',
    pendingPromotion: null
  };

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  function api(path, options) {
    const opts = Object.assign({ credentials: 'same-origin', headers: {} }, options || {});
    if (opts.body && typeof opts.body !== 'string') {
      opts.body = JSON.stringify(opts.body);
      opts.headers['Content-Type'] = 'application/json';
    }
    return fetch(path, opts).then(res => res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` })).then(json => {
      if (!res.ok && json && json.ok !== true) json.status = res.status;
      return json;
    }));
  }

  function parseFen(fen) {
    const board = {};
    const placement = String(fen || '').split(' ')[0];
    const ranks = placement.split('/');
    for (let r = 0; r < ranks.length && r < 8; r++) {
      let file = 0;
      for (const ch of ranks[r]) {
        if (/\d/.test(ch)) { file += Number(ch); continue; }
        if (file > 7) break;
        board[FILES[file] + (8 - r)] = { color: ch === ch.toUpperCase() ? 'white' : 'black', type: ch.toLowerCase() };
        file++;
      }
    }
    return board;
  }

  function sideToMove(fen) {
    return String(fen || '').split(' ')[1] === 'b' ? 'black' : 'white';
  }

  function themeLabel(key) {
    const hit = state.themes.find(t => t.key === key);
    if (hit) return hit.label;
    return String(key).replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
  }

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const child of [].concat(children || [])) {
      if (child == null || child === false) continue;
      el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return el;
  }

  function fmtDelta(n) {
    if (n == null) return '';
    return (n > 0 ? '+' : '') + n;
  }

  function fmtClock(sec) {
    const s = Math.max(0, Math.round(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // ---------------------------------------------------------------------------
  // Styles (injected — this module owns no index.html CSS)
  // ---------------------------------------------------------------------------
  const CSS = `
  .pz-root { display: grid; grid-template-columns: minmax(280px, 560px) minmax(260px, 1fr); gap: 20px; align-items: start; }
  .pz-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0 16px; }
  .pz-tabs button { min-height: 40px; padding: 6px 14px; border-radius: 20px; }
  .pz-tabs button[aria-selected="true"] { background: var(--accent, #355a42); color: var(--panel-bg, #fff); border-color: var(--accent, #355a42); }
  .pz-board-wrap { position: relative; }
  .pz-board { display: grid; grid-template-columns: repeat(8, 1fr); grid-template-rows: repeat(8, 1fr); width: 100%; aspect-ratio: 1 / 1; border: 3px solid var(--board-border, #333); border-radius: 6px; overflow: hidden; user-select: none; touch-action: manipulation; }
  .pz-sq { position: relative; display: flex; align-items: center; justify-content: center; cursor: pointer; min-width: 0; min-height: 0; }
  .pz-sq.light { background: var(--sq-white, #eeeed2); }
  .pz-sq.dark { background: var(--sq-black, #769656); }
  .pz-sq.last::after { content: ''; position: absolute; inset: 0; background: var(--last-move, rgba(255,193,77,0.45)); pointer-events: none; }
  .pz-sq.selected::after { content: ''; position: absolute; inset: 0; background: var(--highlight, #f7f769); opacity: 0.85; pointer-events: none; }
  .pz-sq .chess-piece { position: relative; z-index: 1; width: 88%; height: 88%; filter: var(--piece-shadow, none); }
  .pz-sq .coord { position: absolute; font-size: 10px; font-weight: 600; opacity: 0.6; pointer-events: none; }
  .pz-sq .coord.file { right: 3px; bottom: 1px; }
  .pz-sq .coord.rank { left: 3px; top: 1px; }
  .pz-board.disabled .pz-sq { cursor: default; }
  .pz-turn { display: flex; align-items: center; gap: 10px; margin-top: 10px; font-weight: 600; min-height: 28px; }
  .pz-turn .dot { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--board-border, #333); display: inline-block; }
  .pz-turn .dot.white { background: #fff; } .pz-turn .dot.black { background: #222; }
  .pz-side { display: flex; flex-direction: column; gap: 14px; }
  .pz-panel { border: 1px solid var(--panel-border, #ccc); border-radius: 10px; background: var(--panel-bg, #fff); padding: 14px 16px; }
  .pz-panel h3 { margin: 0 0 8px; font-size: 1.05rem; }
  .pz-status { font-size: 1.1rem; font-weight: 700; margin: 0 0 6px; }
  .pz-status.ok { color: var(--accent, #2e7d32); } .pz-status.bad { color: #b3261e; }
  .pz-muted { color: var(--muted, #666); font-size: 0.9rem; }
  .pz-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .pz-actions button { min-height: 40px; }
  .pz-rating { display: flex; gap: 18px; align-items: baseline; flex-wrap: wrap; }
  .pz-rating strong { font-size: 1.6rem; }
  .pz-delta.up { color: #2e7d32; font-weight: 700; } .pz-delta.down { color: #b3261e; font-weight: 700; }
  .pz-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .pz-chip { font-size: 0.78rem; padding: 3px 8px; border-radius: 12px; background: var(--accent-soft, #eee); color: var(--text-color, inherit); text-decoration: none; }
  .pz-solution { font-family: ui-monospace, monospace; margin-top: 6px; word-break: break-word; }
  .pz-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
  .pz-field select { min-height: 40px; }
  .pz-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  .pz-table th, .pz-table td { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--panel-row-border, #ddd); }
  .pz-table td.num, .pz-table th.num { text-align: right; }
  .pz-bar { height: 6px; border-radius: 3px; background: var(--panel-row-border, #ddd); overflow: hidden; }
  .pz-bar i { display: block; height: 100%; background: var(--accent, #355a42); }
  .pz-storm-hud { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; text-align: center; }
  .pz-storm-hud strong { display: block; font-size: 1.6rem; }
  .pz-storm-hud .warn strong { color: #b3261e; }
  .pz-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .pz-list li { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--panel-row-border, #ddd); }
  .pz-promo { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 8px; background: var(--overlay-bg, rgba(0,0,0,0.5)); z-index: 5; }
  .pz-promo button { width: 64px; height: 64px; padding: 4px; background: var(--panel-bg, #fff); }
  .pz-promo .chess-piece { width: 100%; height: 100%; }
  @media (max-width: 860px) { .pz-root { grid-template-columns: 1fr; } .pz-board-wrap { max-width: 560px; margin-inline: auto; width: 100%; } }
  `;

  function injectStyles() {
    if (document.getElementById('pz-styles')) return;
    const style = document.createElement('style');
    style.id = 'pz-styles';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Board
  // ---------------------------------------------------------------------------
  let boardEl = null;
  let turnEl = null;
  let sideEl = null;
  let tabsEl = null;

  function orientation() {
    return state.puzzle ? state.puzzle.solverColor : 'white';
  }

  function renderBoard() {
    if (!boardEl) return;
    boardEl.innerHTML = '';
    const pieces = parseFen(state.fen || state.puzzle && state.puzzle.fen || '8/8/8/8/8/8/8/8 w - - 0 1');
    const flip = orientation() === 'black';
    const interactive = state.status === 'playing' && !state.busy;
    boardEl.classList.toggle('disabled', !interactive);
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const fileIdx = flip ? 7 - col : col;
        const rank = flip ? row + 1 : 8 - row;
        const sq = FILES[fileIdx] + rank;
        const light = (fileIdx + rank) % 2 === 1;
        const cell = h('div', { class: `pz-sq ${light ? 'light' : 'dark'}`, 'data-square': sq, role: 'gridcell', 'aria-label': sq });
        if (state.lastMove && (state.lastMove.from === sq || state.lastMove.to === sq)) cell.classList.add('last');
        if (state.selected === sq) cell.classList.add('selected');
        const piece = pieces[sq];
        if (piece && typeof window.pieceSvgMarkup === 'function') {
          cell.insertAdjacentHTML('beforeend', window.pieceSvgMarkup(piece.color, piece.type));
          cell.setAttribute('aria-label', `${sq} ${piece.color} ${piece.type}`);
        }
        if (row === 7) cell.appendChild(h('span', { class: 'coord file', text: FILES[fileIdx] }));
        if (col === 0) cell.appendChild(h('span', { class: 'coord rank', text: String(rank) }));
        cell.addEventListener('click', () => onSquareClick(sq));
        boardEl.appendChild(cell);
      }
    }
    renderTurn();
  }

  function renderTurn() {
    if (!turnEl) return;
    turnEl.innerHTML = '';
    if (!state.puzzle) { turnEl.textContent = ''; return; }
    const color = state.puzzle.solverColor;
    const dot = h('span', { class: `dot ${color}`, 'aria-hidden': 'true' });
    let text = '';
    if (state.status === 'intro') text = `${color === 'white' ? 'Black' : 'White'} just played ${state.puzzle.opponentMove ? state.puzzle.opponentMove.san : '…'}`;
    else if (state.status === 'playing') text = state.missed ? `Keep looking — find the best move for ${color}` : `Your move — find the best move for ${color}`;
    else if (state.status === 'solved') text = 'Puzzle solved';
    else if (state.status === 'failed') text = 'Puzzle failed';
    turnEl.appendChild(dot);
    turnEl.appendChild(document.createTextNode(text));
  }

  function onSquareClick(sq) {
    if (state.status !== 'playing' || state.busy || !state.puzzle) return;
    const pieces = parseFen(state.fen);
    const piece = pieces[sq];
    const me = state.puzzle.solverColor;
    if (state.selected == null) {
      if (piece && piece.color === me) { state.selected = sq; renderBoard(); }
      return;
    }
    if (state.selected === sq) { state.selected = null; renderBoard(); return; }
    if (piece && piece.color === me) { state.selected = sq; renderBoard(); return; }
    const from = state.selected;
    const mover = pieces[from];
    const targetRank = Number(sq[1]);
    if (mover && mover.type === 'p' && ((me === 'white' && targetRank === 8) || (me === 'black' && targetRank === 1))) {
      showPromotion(from, sq);
      return;
    }
    submitMove(from + sq);
  }

  function showPromotion(from, to) {
    const wrap = boardEl.parentElement;
    const overlay = h('div', { class: 'pz-promo', role: 'dialog', 'aria-label': 'Choose promotion piece' });
    for (const type of ['q', 'r', 'b', 'n']) {
      const btn = h('button', { type: 'button', 'aria-label': `Promote to ${type}`, onclick: () => { overlay.remove(); submitMove(from + to + type); } });
      if (typeof window.pieceSvgMarkup === 'function') btn.innerHTML = window.pieceSvgMarkup(state.puzzle.solverColor, type);
      else btn.textContent = type.toUpperCase();
      overlay.appendChild(btn);
    }
    wrap.appendChild(overlay);
  }

  // ---------------------------------------------------------------------------
  // Puzzle flow
  // ---------------------------------------------------------------------------
  function loadPuzzle(view, mode) {
    state.puzzle = view;
    state.mode = mode;
    state.fen = view.initialFen;
    state.moves = [];
    state.selected = null;
    state.lastMove = null;
    state.status = 'intro';
    state.missed = false;
    state.committed = false;
    state.revealed = false;
    state.solution = null;
    state.lastResult = null;
    state.message = '';
    state.busy = false;
    renderBoard();
    renderSide();
    // Show the pre-move position, then the opponent's move, then hand over.
    window.setTimeout(() => {
      if (state.puzzle !== view) return;
      state.fen = view.fen;
      if (view.opponentMove) state.lastMove = { from: view.opponentMove.uci.slice(0, 2), to: view.opponentMove.uci.slice(2, 4) };
      state.status = 'playing';
      state.startedAt = Date.now();
      if (mode === 'storm') state.stormPuzzleStartedAt = Date.now();
      renderBoard();
      renderSide();
    }, 500);
  }

  function submitMove(uci) {
    if (!state.puzzle || state.busy) return;
    state.busy = true;
    state.selected = null;
    renderBoard();
    const id = state.puzzle.id;
    api(`/api/puzzle/${encodeURIComponent(id)}/try`, { method: 'POST', body: { move: uci, moves: state.moves } }).then(res => {
      state.busy = false;
      if (!state.puzzle || state.puzzle.id !== id) return;
      if (!res || res.ok !== true) { state.message = res && res.error ? res.error : 'Could not check that move.'; renderBoard(); renderSide(); return; }
      if (res.legal === false) {
        state.message = 'That move is not legal here.';
        renderBoard(); renderSide();
        return;
      }
      if (!res.correct) {
        state.message = `${res.move.san} is not the solution.`;
        state.lastMove = null;
        state.fen = res.fen;
        onWrongMove();
        return;
      }
      state.message = '';
      state.moves = res.moves;
      state.fen = res.fen;
      state.lastMove = res.reply
        ? { from: res.reply.uci.slice(0, 2), to: res.reply.uci.slice(2, 4) }
        : { from: uci.slice(0, 2), to: uci.slice(2, 4) };
      if (res.complete) {
        state.solution = res.solution || null;
        onSolved(res.alternateMate);
      } else {
        renderBoard(); renderSide();
      }
    }).catch(() => {
      state.busy = false;
      state.message = 'Network error — try again.';
      renderBoard(); renderSide();
    });
  }

  function onWrongMove() {
    if (state.mode === 'storm') {
      state.status = 'failed';
      renderBoard(); renderSide();
      stormReport('failed');
      return;
    }
    if (!state.missed) {
      state.missed = true;
      commitSolve(false);
    }
    // Retry before reveal: keep the board live so the player can look again.
    renderBoard(); renderSide();
  }

  function onSolved(alternate) {
    state.status = 'solved';
    if (alternate) state.message = 'Alternate checkmate accepted.';
    renderBoard(); renderSide();
    if (state.mode === 'storm') { stormReport('solved'); return; }
    if (!state.missed) commitSolve(true);
    else refreshAfterSolve();
  }

  function commitSolve(win) {
    if (state.committed || !state.puzzle) return;
    state.committed = true;
    const id = state.puzzle.id;
    const timeMs = Math.max(0, Date.now() - state.startedAt);
    api(`/api/puzzle/${encodeURIComponent(id)}/solve`, { method: 'POST', body: { moves: state.moves, timeMs, win, mode: state.mode } }).then(res => {
      if (!state.puzzle || state.puzzle.id !== id) return;
      if (res && res.ok) {
        state.lastResult = res;
        state.player = { rating: res.rating.after, rd: res.rating.rd, provisional: res.rating.provisional };
        if (win) state.solution = res.solution;
        else state.solution = res.solution; // kept hidden until revealed
      } else {
        state.message = res && res.error ? res.error : 'Could not record the result.';
      }
      renderSide();
    }).catch(() => { state.message = 'Network error recording the result.'; renderSide(); });
  }

  function refreshAfterSolve() {
    renderSide();
  }

  function revealSolution() {
    state.revealed = true;
    state.status = 'failed';
    if (state.solution && state.puzzle) {
      // Show the final position of the solution line for context.
      state.lastMove = null;
    }
    renderBoard(); renderSide();
  }

  // ---------------------------------------------------------------------------
  // Loaders per tab
  // ---------------------------------------------------------------------------
  function loadDaily() {
    state.message = '';
    return api('/api/puzzle/daily').then(res => {
      if (!res || !res.ok) { state.message = res && res.error ? res.error : 'Daily puzzle unavailable.'; renderSide(); return; }
      state.player = res.player;
      state.dailyDate = res.date;
      state.dailyPlayed = res.alreadyPlayed;
      loadPuzzle(res.puzzle, 'daily');
    });
  }

  function loadNext(mode, theme, target) {
    state.message = '';
    const params = new URLSearchParams();
    if (theme && theme !== 'mix') params.set('theme', theme);
    if (target) params.set('rating', String(target));
    return api(`/api/puzzle/next${params.toString() ? '?' + params : ''}`).then(res => {
      if (!res || !res.ok) { state.message = res && res.error ? res.error : 'No puzzle available.'; state.puzzle = null; state.status = 'idle'; renderBoard(); renderSide(); return; }
      state.player = res.player;
      loadPuzzle(res.puzzle, mode);
    });
  }

  function loadThemes() {
    if (state.themes.length) return Promise.resolve();
    return api('/api/puzzle/themes').then(res => {
      if (res && res.ok) state.themes = res.themes;
    }).catch(() => {});
  }

  function loadReview() {
    return api('/api/puzzle/review').then(res => { if (res && res.ok) state.review = res; renderSide(); });
  }

  function loadDashboard() {
    return api('/api/puzzle/dashboard/30').then(res => { if (res && res.ok) { state.dashboard = res; state.player = res.player; } renderSide(); });
  }

  // ---------------------------------------------------------------------------
  // Storm
  // ---------------------------------------------------------------------------
  function stormStart() {
    stopStormTimer();
    state.message = '';
    return api('/api/puzzle/storm/start').then(res => {
      if (!res || !res.ok) { state.message = res && res.error ? res.error : 'Could not start Storm.'; renderSide(); return; }
      state.storm = res.storm;
      state.stormClientStart = Date.now();
      state.stormSummary = null;
      startStormTimer();
      if (res.storm.puzzle) loadPuzzle(res.storm.puzzle, 'storm');
      renderSide();
    });
  }

  function stormReport(result) {
    if (!state.storm || !state.puzzle) return;
    const body = { sessionId: state.storm.sessionId, puzzleId: state.puzzle.id, result, timeMs: Date.now() - state.stormPuzzleStartedAt, moves: state.moves };
    api('/api/puzzle/storm/result', { method: 'POST', body }).then(res => {
      if (!res || !res.ok) { state.message = res && res.error ? res.error : 'Storm result rejected.'; renderSide(); return; }
      state.storm = res.storm;
      if (res.storm.status === 'complete' || !res.storm.puzzle) {
        state.stormSummary = res.summary || { solved: res.storm.solved, failed: res.storm.failed, bestStreak: res.storm.bestStreak };
        stopStormTimer();
        state.status = 'idle';
        state.solution = res.solution;
        renderBoard(); renderSide();
        return;
      }
      window.setTimeout(() => { if (state.storm && state.storm.sessionId === res.storm.sessionId) loadPuzzle(res.storm.puzzle, 'storm'); }, 350);
      renderSide();
    });
  }

  function stormRemaining() {
    if (!state.storm) return 0;
    const elapsed = (Date.now() - state.stormClientStart) / 1000;
    return Math.max(0, state.storm.durationSec - elapsed);
  }

  function startStormTimer() {
    stopStormTimer();
    state.stormTimer = window.setInterval(() => {
      const clock = sideEl && sideEl.querySelector('[data-storm-clock]');
      const remaining = stormRemaining();
      if (clock) {
        clock.textContent = fmtClock(remaining);
        clock.parentElement.classList.toggle('warn', remaining < 20);
      }
      if (remaining <= 0 && state.storm && state.storm.status !== 'complete') {
        stopStormTimer();
        state.status = 'idle';
        // Ask the server to close the session; a 'failed' result after the deadline is ignored by the session.
        api('/api/puzzle/storm/result', { method: 'POST', body: { sessionId: state.storm.sessionId, result: 'failed', timeMs: 0 } }).then(res => {
          if (res && res.ok) { state.storm = res.storm; state.stormSummary = res.summary || { solved: res.storm.solved, failed: res.storm.failed, bestStreak: res.storm.bestStreak }; }
          renderBoard(); renderSide();
        });
      }
    }, 250);
  }

  function stopStormTimer() {
    if (state.stormTimer) { window.clearInterval(state.stormTimer); state.stormTimer = null; }
  }

  // ---------------------------------------------------------------------------
  // Side panel rendering
  // ---------------------------------------------------------------------------
  function renderTabs() {
    if (!tabsEl) return;
    tabsEl.innerHTML = '';
    for (const tab of TABS) {
      tabsEl.appendChild(h('button', {
        type: 'button', role: 'tab', 'data-tab': tab.id, 'aria-selected': state.tab === tab.id ? 'true' : 'false',
        text: tab.label, onclick: () => selectTab(tab.id)
      }));
    }
  }

  function selectTab(id, opts) {
    const changed = state.tab !== id;
    state.tab = id;
    renderTabs();
    if (id !== 'storm') stopStormTimer();
    if (id === 'daily') { if (changed || !state.puzzle || state.mode !== 'daily') loadDaily(); }
    else if (id === 'rated') { if (changed || !state.puzzle || state.mode !== 'rated') loadNext('rated'); }
    else if (id === 'custom') {
      loadThemes().then(() => { renderSide(); if (changed || (opts && opts.reload) || !state.puzzle || state.mode !== 'custom') loadCustom(); });
    }
    else if (id === 'storm') { state.puzzle = state.mode === 'storm' ? state.puzzle : null; state.status = state.mode === 'storm' ? state.status : 'idle'; renderBoard(); }
    else if (id === 'review') { state.puzzle = state.mode === 'review' ? state.puzzle : null; state.status = state.mode === 'review' ? state.status : 'idle'; renderBoard(); loadReview(); }
    else if (id === 'stats') { loadDashboard(); }
    renderSide();
  }

  function loadCustom() {
    const band = RATING_BANDS.find(b => b.key === state.customBand) || RATING_BANDS[0];
    return loadNext('custom', state.customTheme, band.target);
  }

  function puzzleInfoPanel() {
    const p = state.puzzle;
    if (!p) return null;
    const chips = p.themes.map(t => h('a', { class: 'pz-chip', href: '#', text: themeLabel(t), onclick: (e) => { e.preventDefault(); state.customTheme = t; if (window.Shell) window.Shell.navigate('puzzles', { theme: t }); else openCustomTheme(t); } }));
    return h('div', { class: 'pz-panel' }, [
      h('h3', { text: `Puzzle ${p.id}` }),
      h('div', { class: 'pz-muted', text: `Rating ${p.rating} · ${p.solutionLength} move${p.solutionLength === 1 ? '' : 's'} to find · played ${p.nbPlays.toLocaleString()} times on lichess` }),
      h('div', { class: 'pz-chips' }, chips),
      p.gameUrl ? h('div', { class: 'pz-muted', style: 'margin-top:8px' }, [h('a', { href: p.gameUrl, target: '_blank', rel: 'noopener', text: 'From this lichess game ↗' })]) : null
    ]);
  }

  function ratingPanel() {
    const player = state.player;
    if (!player) return null;
    const res = state.lastResult;
    const delta = res && res.rating ? res.rating.delta : null;
    return h('div', { class: 'pz-panel' }, [
      h('h3', { text: 'Your puzzle rating' }),
      h('div', { class: 'pz-rating' }, [
        h('strong', { text: String(player.rating) }),
        delta != null ? h('span', { class: `pz-delta ${delta >= 0 ? 'up' : 'down'}`, 'data-rating-delta': String(delta), text: fmtDelta(delta) }) : null,
        h('span', { class: 'pz-muted', text: player.provisional ? `provisional (±${player.rd})` : `±${player.rd}` })
      ])
    ]);
  }

  function statusPanel() {
    const p = state.puzzle;
    if (!p) return null;
    const children = [];
    const actions = [];
    const nextLabel = state.mode === 'daily' ? 'Try a rated puzzle' : 'Next puzzle';
    const onNext = () => {
      if (state.mode === 'daily') selectTab('rated');
      else if (state.mode === 'custom') loadCustom();
      else if (state.mode === 'review') { selectTab('review'); }
      else loadNext('rated');
    };

    if (state.status === 'intro') children.push(h('p', { class: 'pz-status', text: 'Watch the opponent\'s move…' }));
    else if (state.status === 'playing' && !state.missed) {
      children.push(h('p', { class: 'pz-status', text: state.moves.length ? 'Correct — keep going' : 'Find the best move' }));
      if (state.message) children.push(h('p', { class: 'pz-muted', text: state.message }));
      if (state.dailyPlayed && state.mode === 'daily') children.push(h('p', { class: 'pz-muted', text: `You already ${state.dailyPlayed.win ? 'solved' : 'attempted'} today's puzzle — this replay is still rated.` }));
    } else if (state.status === 'playing' && state.missed) {
      children.push(h('p', { class: 'pz-status bad', text: 'Not quite' }));
      children.push(h('p', { class: 'pz-muted', text: `${state.message} Your rating has been updated; try again before revealing the solution.` }));
      actions.push(h('button', { type: 'button', 'data-action': 'reveal', text: 'View solution', onclick: revealSolution }));
      actions.push(h('button', { type: 'button', 'data-action': 'next', text: nextLabel, onclick: onNext }));
    } else if (state.status === 'solved') {
      children.push(h('p', { class: 'pz-status ok', 'data-result': 'solved', text: state.missed ? 'Solved after a miss' : 'Success!' }));
      if (state.message) children.push(h('p', { class: 'pz-muted', text: state.message }));
      if (state.solution) children.push(h('p', { class: 'pz-solution', text: solutionText() }));
      actions.push(h('button', { type: 'button', 'data-action': 'next', text: nextLabel, onclick: onNext }));
    } else if (state.status === 'failed') {
      children.push(h('p', { class: 'pz-status bad', 'data-result': 'failed', text: state.mode === 'storm' ? 'Wrong move' : 'Solution' }));
      if (state.solution) children.push(h('p', { class: 'pz-solution', text: solutionText() }));
      if (state.mode !== 'storm') actions.push(h('button', { type: 'button', 'data-action': 'next', text: nextLabel, onclick: onNext }));
    }
    if (state.lastResult && state.lastResult.review && state.mode !== 'storm') {
      const days = state.lastResult.review.intervalDays;
      children.push(h('p', { class: 'pz-muted', text: `Scheduled for review in ${days} day${days === 1 ? '' : 's'}.` }));
    }
    if (actions.length) children.push(h('div', { class: 'pz-actions' }, actions));
    return h('div', { class: 'pz-panel', 'data-status-panel': state.status }, children);
  }

  function solutionText() {
    const sol = state.solution;
    if (!sol || !sol.san) return '';
    const p = state.puzzle;
    const parts = [];
    for (let i = 0; i < sol.san.length; i++) parts.push((i === 0 ? '(' : '') + sol.san[i] + (i === 0 ? ')' : ''));
    return `${p && p.solverColor === 'white' ? '' : '… '}${parts.join(' ')}`;
  }

  function customPanel() {
    const themeSel = h('select', { 'aria-label': 'Theme', onchange: (e) => { state.customTheme = e.target.value; loadCustom(); } });
    const themes = state.themes.length ? state.themes : [{ key: 'mix', label: 'Healthy mix', count: 0 }];
    for (const t of themes) {
      themeSel.appendChild(h('option', { value: t.key, selected: t.key === state.customTheme, text: t.count ? `${t.label} (${t.count})` : t.label }));
    }
    const bandSel = h('select', { 'aria-label': 'Rating band', onchange: (e) => { state.customBand = e.target.value; loadCustom(); } });
    for (const b of RATING_BANDS) bandSel.appendChild(h('option', { value: b.key, selected: b.key === state.customBand, text: b.label }));
    return h('div', { class: 'pz-panel' }, [
      h('h3', { text: 'Custom puzzles' }),
      h('label', { class: 'pz-field' }, [h('span', { class: 'pz-muted', text: 'Theme' }), themeSel]),
      h('label', { class: 'pz-field' }, [h('span', { class: 'pz-muted', text: 'Rating band' }), bandSel]),
      h('p', { class: 'pz-muted', text: 'Custom puzzles are rated like any other attempt.' })
    ]);
  }

  function stormPanel() {
    const s = state.storm;
    const children = [h('h3', { text: 'Puzzle Storm' })];
    if (!s || state.stormSummary) {
      if (state.stormSummary) {
        const sum = state.stormSummary;
        children.push(h('p', { class: 'pz-status', 'data-storm-summary': '', text: `Score ${sum.solved} · best streak ${sum.bestStreak} · ${sum.failed} missed` }));
      } else {
        children.push(h('p', { class: 'pz-muted', text: 'Solve as many puzzles as you can in 3 minutes. Difficulty climbs with your streak; a wrong move resets it. Storm is unrated.' }));
      }
      if (state.message) children.push(h('p', { class: 'pz-muted', text: state.message }));
      children.push(h('div', { class: 'pz-actions' }, [h('button', { type: 'button', 'data-action': 'storm-start', text: state.stormSummary ? 'Play again' : 'Start Storm', onclick: stormStart })]));
      return h('div', { class: 'pz-panel' }, children);
    }
    children.push(h('div', { class: 'pz-storm-hud' }, [
      h('div', {}, [h('strong', { 'data-storm-clock': '', text: fmtClock(stormRemaining()) }), h('span', { class: 'pz-muted', text: 'time' })]),
      h('div', {}, [h('strong', { 'data-storm-score': '', text: String(s.solved) }), h('span', { class: 'pz-muted', text: 'solved' })]),
      h('div', {}, [h('strong', { text: String(s.streak) }), h('span', { class: 'pz-muted', text: `streak · ${s.difficulty}` })])
    ]));
    if (state.message) children.push(h('p', { class: 'pz-muted', text: state.message }));
    return h('div', { class: 'pz-panel' }, children);
  }

  function reviewPanel() {
    const r = state.review;
    const children = [h('h3', { text: 'Spaced-repetition review' })];
    if (!r) { children.push(h('p', { class: 'pz-muted', text: 'Loading…' })); return h('div', { class: 'pz-panel' }, children); }
    children.push(h('p', { class: 'pz-muted', text: `Puzzles you missed come back on expanding intervals (${r.intervals.join(', ')} days). ${r.counts.due} due now · ${r.counts.upcoming} upcoming.` }));
    if (r.due.length === 0 && r.upcoming.length === 0) children.push(h('p', { class: 'pz-muted', text: 'Nothing queued yet — miss a rated puzzle and it will show up here.' }));
    if (r.due.length) {
      const list = h('ul', { class: 'pz-list', 'data-review-due': '' });
      for (const item of r.due) {
        list.appendChild(h('li', {}, [
          h('span', {}, [h('strong', { text: `#${item.puzzle.id}` }), h('span', { class: 'pz-muted', text: ` · ${item.puzzle.rating} · ${item.puzzle.themes.slice(0, 3).map(themeLabel).join(', ')}` })]),
          h('button', { type: 'button', text: 'Train', onclick: () => { state.player = state.player; loadPuzzle(item.puzzle, 'review'); } })
        ]));
      }
      children.push(list);
    }
    if (r.upcoming.length) {
      children.push(h('h3', { text: 'Upcoming', style: 'margin-top:12px' }));
      const list = h('ul', { class: 'pz-list' });
      for (const item of r.upcoming) {
        const dueIn = Math.max(0, Math.ceil((item.schedule.nextDueAt - r.now) / 86400000));
        list.appendChild(h('li', {}, [
          h('span', {}, [h('strong', { text: `#${item.puzzle.id}` }), h('span', { class: 'pz-muted', text: ` · ${item.puzzle.rating} · step ${item.schedule.step + 1}` })]),
          h('span', { class: 'pz-muted', text: `due in ${dueIn} day${dueIn === 1 ? '' : 's'}` })
        ]));
      }
      children.push(list);
    }
    return h('div', { class: 'pz-panel' }, children);
  }

  function statsPanel() {
    const d = state.dashboard;
    const children = [h('h3', { text: 'Last 30 days' })];
    if (!d) { children.push(h('p', { class: 'pz-muted', text: 'Loading…' })); return h('div', { class: 'pz-panel' }, children); }
    const g = d.global;
    children.push(h('p', { class: 'pz-muted', text: g.nb ? `${g.nb} puzzles · ${g.wins} solved (${g.winRate}%) · performance ${g.performance}` : 'No rated attempts yet. Solve a few puzzles and your strengths and weaknesses will appear here.' }));
    if (!d.player.authenticated) children.push(h('p', { class: 'pz-muted', text: 'Stats are tied to this browser. Sign in to keep them across devices.' }));
    if (d.themes.length) {
      const table = h('table', { class: 'pz-table', 'data-dashboard-themes': '' }, [
        h('thead', {}, [h('tr', {}, [h('th', { text: 'Theme' }), h('th', { class: 'num', text: 'Played' }), h('th', { class: 'num', text: 'Solved' }), h('th', { text: 'Win rate' })])])
      ]);
      const tbody = h('tbody');
      for (const t of d.themes.slice(0, 20)) {
        tbody.appendChild(h('tr', {}, [
          h('td', {}, [h('a', { href: '#', text: t.label, onclick: (e) => { e.preventDefault(); if (window.Shell) window.Shell.navigate('puzzles', { theme: t.theme }); } })]),
          h('td', { class: 'num', text: String(t.nb) }),
          h('td', { class: 'num', text: String(t.wins) }),
          h('td', {}, [h('div', { class: 'pz-bar', title: `${t.winRate}%` }, [h('i', { style: `width:${t.winRate}%` })])])
        ]));
      }
      table.appendChild(tbody);
      children.push(table);
    }
    if (d.weaknesses && d.weaknesses.length) {
      children.push(h('p', { class: 'pz-muted', style: 'margin-top:10px' }, ['Work on: ', ...d.weaknesses.map(w => h('a', { class: 'pz-chip', href: '#', text: `${w.label} ${w.winRate}%`, onclick: (e) => { e.preventDefault(); if (window.Shell) window.Shell.navigate('puzzles', { theme: w.theme }); } }))]));
    }
    return h('div', { class: 'pz-panel' }, children);
  }

  function renderSide() {
    if (!sideEl) return;
    sideEl.innerHTML = '';
    const tab = state.tab;
    if (tab === 'daily') {
      sideEl.appendChild(h('div', { class: 'pz-panel' }, [h('h3', { text: 'Daily puzzle' }), h('p', { class: 'pz-muted', text: `One puzzle for everyone, every day (UTC${state.dailyDate ? ' · ' + state.dailyDate : ''}). Same rules as rated.` })]));
    }
    if (tab === 'custom') sideEl.appendChild(customPanel());
    if (tab === 'storm') sideEl.appendChild(stormPanel());
    if (tab === 'review') sideEl.appendChild(reviewPanel());
    if (tab === 'stats') { sideEl.appendChild(statsPanel()); const rp = ratingPanel(); if (rp) sideEl.appendChild(rp); return; }
    if (!state.puzzle && state.message && tab !== 'storm') sideEl.appendChild(h('div', { class: 'pz-panel' }, [h('p', { class: 'pz-status bad', text: state.message })]));
    const sp = statusPanel(); if (sp) sideEl.appendChild(sp);
    if (tab !== 'storm') { const rp = ratingPanel(); if (rp) sideEl.appendChild(rp); }
    const ip = puzzleInfoPanel(); if (ip) sideEl.appendChild(ip);
  }

  function openCustomTheme(theme) {
    state.customTheme = theme;
    selectTab('custom', { reload: true });
  }

  // ---------------------------------------------------------------------------
  // Shell view
  // ---------------------------------------------------------------------------
  function mount(el) {
    injectStyles();
    state.el = el;
    el.innerHTML = '';
    el.appendChild(h('h2', { text: 'Puzzles' }));
    el.appendChild(h('p', { class: 'supporting-copy', text: 'Real lichess tactics (CC0). Every move is checked by the server — no peeking at the solution until you commit.' }));
    tabsEl = h('div', { class: 'pz-tabs', role: 'tablist', 'aria-label': 'Puzzle modes' });
    el.appendChild(tabsEl);
    const root = h('div', { class: 'pz-root' });
    const boardWrap = h('div', { class: 'pz-board-wrap' });
    boardEl = h('div', { class: 'pz-board', id: 'puzzle-board', role: 'grid', 'aria-label': 'Puzzle board' });
    turnEl = h('div', { class: 'pz-turn', 'aria-live': 'polite' });
    boardWrap.appendChild(boardEl);
    boardWrap.appendChild(turnEl);
    sideEl = h('div', { class: 'pz-side' });
    root.appendChild(boardWrap);
    root.appendChild(sideEl);
    el.appendChild(root);
    renderTabs();
    renderBoard();
  }

  function applyParams(params) {
    if (params && params.theme) {
      const theme = String(params.theme);
      if (state.tab !== 'custom' || state.customTheme !== theme || !state.puzzle) {
        state.customTheme = theme;
        selectTab('custom', { reload: true });
      }
      return;
    }
    if (params && params.tab && TABS.some(t => t.id === params.tab)) { selectTab(params.tab); return; }
    if (state.status === 'idle' && !state.puzzle) selectTab(state.tab);
  }

  function show(el, params) {
    if (!boardEl) mount(el);
    applyParams(params);
  }

  function hide() {
    stopStormTimer();
  }

  function init() {
    if (!window.Shell || typeof window.Shell.registerView !== 'function') return;
    window.Shell.registerView({ id: 'puzzles', title: 'Puzzles', order: 30, nav: true, mount, show, hide });
  }

  window.UIPuzzles = { init, state, api, parseFen, sideToMove };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
