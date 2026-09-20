// ui-study.js — Study chapters view (#/study) for the site shell (roadmap A2.2).
//
// Pure display layer. It owns its OWN board inside the `[data-view="study"]`
// section and never touches the live `#board` or referee state (Gate 4). All
// chapter data comes from /api/study; a quiz guess is sent to
// POST /api/study/:id/guess and the SERVER decides legality and correctness.
// The solution line is never in the public payload until the viewer completes
// the chapter or presses Reveal.
//
// Three chapter kinds — PGN (parsed server-side by study-tree.fromPGN, RAV +
// NAG preserved), FEN (server-validated start position + recorded line) and
// Game (an archived game imported by id). PGN export is server-rendered by
// study-tree.toPGN, so $1–$9 NAG glyphs round-trip.
(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const KIND_LABELS = { pgn: 'PGN', fen: 'FEN', game: 'Game' };

  const state = {
    el: null,
    chapters: [],
    current: null,        // public chapter view
    ply: 0,
    positions: [],        // display-only [{fen,san,lastMove}]
    revealed: false,
    // quiz
    guessMoves: [],       // committed UCI guesses
    selected: null,
    lastMove: null,
    quizFen: null,
    busy: false,
    message: '',
    status: '',           // '', 'ok', 'error'
    authenticated: false
  };

  // ------------------------------------------------------------------ utils
  function api(path, options) {
    const opts = Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options || {});
    if (opts.body && typeof opts.body !== 'string') {
      opts.body = JSON.stringify(opts.body);
      opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    }
    return fetch(path, opts).then(res => res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` })));
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

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
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

  function fmtDate(ts) {
    if (!ts) return '';
    try { return new Date(ts).toISOString().slice(0, 10); } catch (_) { return ''; }
  }

  // ------------------------------------------------------------------ styles
  const CSS = `
    .st-root { display: grid; grid-template-columns: minmax(300px, 1fr) minmax(300px, 1fr); gap: 18px; align-items: start; margin-top: 12px; }
    @media (max-width: 900px) { .st-root { grid-template-columns: 1fr; } }
    .st-panel { border: 1px solid var(--panel-border, #ccc); border-radius: 10px; background: var(--panel-bg, #fff); padding: 14px 16px; min-width: 0; }
    .st-panel h3 { margin: 0 0 10px; font-size: 1.05rem; }
    .st-panel h4 { margin: 14px 0 6px; font-size: 0.95rem; }
    .st-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin: 4px 0 10px; }
    .st-tabs button { min-height: 38px; padding: 5px 12px; border-radius: 999px; border: 1px solid var(--panel-border, #ccc); background: transparent; color: inherit; cursor: pointer; font: inherit; }
    .st-tabs button[aria-pressed="true"] { background: var(--accent, #355a42); color: #fff; border-color: var(--accent, #355a42); }
    .st-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
    .st-field input[type=text] { min-height: 38px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--panel-border, #ccc); background: var(--panel-bg, #fff); color: inherit; }
    .st-field textarea { min-height: 120px; font-family: ui-monospace, monospace; font-size: 0.8rem; padding: 8px; border-radius: 6px; border: 1px solid var(--panel-border, #ccc); background: var(--panel-bg, #fff); color: inherit; box-sizing: border-box; width: 100%; }
    .st-field label { font-size: 0.85rem; color: var(--muted, #666); }
    .st-panel button { min-height: 38px; padding: 5px 12px; border-radius: 6px; border: 1px solid var(--panel-border, #ccc); background: var(--panel-bg, #fff); color: inherit; cursor: pointer; font: inherit; }
    .st-panel button:hover { border-color: var(--accent, #355a42); }
    .st-list { list-style: none; margin: 0; padding: 0; }
    .st-list li { display: flex; justify-content: space-between; gap: 8px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--panel-row-border, #eee); }
    .st-list li:last-child { border-bottom: 0; }
    .st-list .st-meta { font-size: 0.78rem; color: var(--muted, #666); }
    .st-badge { display: inline-block; font-size: 0.7rem; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--panel-border, #ccc); color: var(--muted, #666); margin-left: 6px; }
    .st-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .st-board { display: grid; grid-template-columns: repeat(8, 1fr); grid-template-rows: repeat(8, 1fr); width: 100%; max-width: 560px; aspect-ratio: 1 / 1; border: 3px solid var(--board-border, #333); border-radius: 6px; overflow: hidden; user-select: none; touch-action: manipulation; }
    .st-sq { position: relative; display: flex; align-items: center; justify-content: center; min-width: 0; min-height: 0; cursor: pointer; }
    .st-sq.light { background: var(--sq-white, #eeeed2); }
    .st-sq.dark { background: var(--sq-black, #769656); }
    .st-sq.last::after { content: ''; position: absolute; inset: 0; background: var(--last-move, rgba(255,193,77,0.45)); pointer-events: none; }
    .st-sq.selected::after { content: ''; position: absolute; inset: 0; background: var(--highlight, #f7f769); opacity: 0.85; pointer-events: none; }
    .st-sq .chess-piece { position: relative; z-index: 1; width: 88%; height: 88%; }
    .st-sq .coord { position: absolute; font-size: 10px; font-weight: 600; opacity: 0.6; pointer-events: none; }
    .st-board.disabled .st-sq { cursor: default; }
    .st-scrub { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
    .st-scrub input[type=range] { flex: 1 1 160px; }
    .st-moves { display: flex; flex-wrap: wrap; gap: 2px 6px; margin-top: 8px; font-family: ui-monospace, monospace; font-size: 0.9rem; max-height: 160px; overflow: auto; }
    .st-moves .st-num { color: var(--muted, #666); }
    .st-moves button { border: 0; background: transparent; padding: 2px 4px; border-radius: 4px; color: inherit; cursor: pointer; font: inherit; min-height: 28px; }
    .st-moves button[aria-current="true"] { background: var(--accent-soft, #e3ebdf); font-weight: 600; }
    .st-status { min-height: 1.2em; font-size: 0.9rem; margin-top: 8px; }
    .st-status.ok { color: #16a34a; font-weight: 600; }
    .st-status.error { color: #dc2626; }
    .st-muted { color: var(--muted, #666); font-size: 0.85rem; }
    .st-mono { font-family: ui-monospace, monospace; font-size: 0.78rem; word-break: break-all; white-space: pre-wrap; }
    .st-promo { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 8px; background: rgba(0,0,0,0.5); z-index: 5; }
    .st-promo button { width: 60px; height: 60px; padding: 4px; background: var(--panel-bg, #fff); }
    .st-promo .chess-piece { width: 100%; height: 100%; }
    .st-turn { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-weight: 600; min-height: 26px; }
    .st-turn .dot { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--board-border, #333); display: inline-block; }
    .st-turn .dot.white { background: #fff; } .st-turn .dot.black { background: #222; }
    .st-board-wrap { position: relative; }
  `;

  function injectStyles() {
    if (document.getElementById('st-styles')) return;
    const style = document.createElement('style');
    style.id = 'st-styles';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // ------------------------------------------------------------------ markup
  function renderSkeleton(el) {
    el.innerHTML = `
      <h2 id="study-title">Study</h2>
      <p class="supporting-copy">Build chapters from a PGN, a FEN or an archived game, then step through them — or hide the moves and guess each one like a puzzle.</p>
      <div class="st-root">
        <section class="st-panel" aria-labelledby="study-create-title">
          <h3 id="study-create-title">New chapter</h3>
          <div class="st-tabs" role="group" aria-label="Chapter kind" id="study-kind-tabs">
            <button type="button" data-kind="pgn" aria-pressed="true">PGN</button>
            <button type="button" data-kind="fen" aria-pressed="false">FEN</button>
            <button type="button" data-kind="game" aria-pressed="false">Game</button>
          </div>
          <div id="study-form-pgn">
            <div class="st-field"><label for="study-pgn-title">Title</label><input type="text" id="study-pgn-title" placeholder="Chapter title" autocomplete="off"></div>
            <div class="st-field"><label for="study-pgn">PGN</label><textarea id="study-pgn" placeholder="[FEN &quot;...&quot;] optional\n\n1. e4 e5 2. Nf3 (2. Bc4 …) 2... Nc6 $2"></textarea></div>
          </div>
          <div id="study-form-fen" hidden>
            <div class="st-field"><label for="study-fen-title">Title</label><input type="text" id="study-fen-title" placeholder="Chapter title" autocomplete="off"></div>
            <div class="st-field"><label for="study-fen">Start FEN</label><input type="text" id="study-fen" placeholder="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"></div>
            <div class="st-field"><label for="study-fen-line">Line (SAN or UCI)</label><textarea id="study-fen-line" placeholder="1. e4 e5 2. Nf3"></textarea></div>
          </div>
          <div id="study-form-game" hidden>
            <div class="st-field"><label for="study-game-title">Title</label><input type="text" id="study-game-title" placeholder="Chapter title" autocomplete="off"></div>
            <div class="st-field"><label for="study-game-id">Archive game id</label><input type="text" id="study-game-id" placeholder="game id from the Library" autocomplete="off"></div>
          </div>
          <label class="st-muted"><input type="checkbox" id="study-quiz-toggle"> Hidden-move quiz chapter</label>
          <div class="st-actions" style="margin-top:10px">
            <button type="button" id="study-create-btn">Create chapter</button>
            <button type="button" id="study-refresh-btn">Refresh list</button>
          </div>
          <p class="st-status" id="study-create-status" role="status" aria-live="polite"></p>
        </section>
        <section class="st-panel" aria-labelledby="study-list-title">
          <h3 id="study-list-title">Chapters</h3>
          <p class="st-muted" id="study-scope"></p>
          <ul class="st-list" id="study-list" aria-live="polite"><li class="st-muted">Loading…</li></ul>
        </section>
      </div>
      <section class="st-panel" id="study-viewer-panel" aria-labelledby="study-viewer-title" hidden style="margin-top:18px">
        <h3 id="study-viewer-title">Chapter</h3>
        <div class="st-root">
          <div class="st-board-wrap">
            <div class="st-board" id="study-board" role="grid" aria-label="Study board"></div>
            <div class="st-turn" id="study-turn" aria-live="polite"></div>
            <div class="st-scrub" id="study-scrub">
              <button type="button" id="study-first" aria-label="First position">|&lt;</button>
              <button type="button" id="study-prev" aria-label="Previous ply">&lt;</button>
              <input type="range" id="study-range" min="0" max="0" value="0" aria-label="Ply">
              <button type="button" id="study-next" aria-label="Next ply">&gt;</button>
              <button type="button" id="study-last" aria-label="Last position">&gt;|</button>
              <span class="st-muted" id="study-ply-label">Ply 0</span>
            </div>
          </div>
          <div>
            <div class="st-moves" id="study-movelist" aria-label="Move list"></div>
            <p class="st-status" id="study-status" role="status" aria-live="polite"></p>
            <div class="st-actions" style="margin-top:8px">
              <button type="button" id="study-guess-reveal">Reveal solution</button>
              <button type="button" id="study-export-pgn">Export PGN</button>
              <button type="button" id="study-delete">Delete chapter</button>
              <button type="button" id="study-close">Close</button>
            </div>
            <textarea id="study-pgn-out" class="st-mono" rows="5" style="width:100%;margin-top:8px" readonly aria-label="PGN export"></textarea>
          </div>
        </div>
      </section>`;
  }

  // ------------------------------------------------------------------ board
  function boardEl() { return document.getElementById('study-board'); }
  function currentFen() {
    if (state.current && state.current.quiz && !state.revealed) return state.quizFen || state.current.startFen;
    const pos = state.positions[state.ply];
    return (pos && pos.fen) || (state.current && state.current.startFen) || '8/8/8/8/8/8/8/8 w - - 0 1';
  }

  function interactive() {
    return !!(state.current && state.current.quiz && !state.revealed && !state.busy && !isComplete());
  }

  function isComplete() {
    const c = state.current;
    if (!c) return false;
    if (!c.quiz || state.revealed) return state.ply >= state.positions.length - 1;
    return state.guessMoves.length * 2 >= c.totalMoves;
  }

  function renderBoard() {
    const board = boardEl();
    if (!board) return;
    board.innerHTML = '';
    const pieces = parseFen(currentFen());
    const quiz = state.current && state.current.quiz && !state.revealed;
    board.classList.toggle('disabled', !interactive());
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const sq = FILES[col] + (8 - row);
        const light = (col + 8 - row) % 2 === 1;
        const cell = h('div', { class: `st-sq ${light ? 'light' : 'dark'}`, 'data-square': sq, role: 'gridcell', 'aria-label': sq });
        if (state.lastMove && (state.lastMove.from === sq || state.lastMove.to === sq)) cell.classList.add('last');
        if (state.selected === sq) cell.classList.add('selected');
        const piece = pieces[sq];
        if (piece && typeof window.pieceSvgMarkup === 'function') {
          cell.insertAdjacentHTML('beforeend', window.pieceSvgMarkup(piece.color, piece.type));
          cell.setAttribute('aria-label', `${sq} ${piece.color} ${piece.type}`);
        }
        if (row === 7) cell.appendChild(h('span', { class: 'coord', style: 'right:3px;bottom:1px', text: FILES[col] }));
        if (col === 0) cell.appendChild(h('span', { class: 'coord', style: 'left:3px;top:1px', text: String(8 - row) }));
        if (quiz) cell.addEventListener('click', () => onSquareClick(sq));
        board.appendChild(cell);
      }
    }
    renderTurn();
  }

  function renderTurn() {
    const turnEl = document.getElementById('study-turn');
    if (!turnEl || !state.current) return;
    turnEl.innerHTML = '';
    const color = sideToMove(currentFen());
    turnEl.appendChild(h('span', { class: `dot ${color}`, 'aria-hidden': 'true' }));
    let text = '';
    if (state.current.quiz && !state.revealed) {
      text = isComplete() ? 'Chapter complete' : `${color === 'white' ? 'White' : 'Black'} to move — guess the move`;
    } else {
      text = `${color === 'white' ? 'White' : 'Black'} to move`;
    }
    turnEl.appendChild(document.createTextNode(text));
  }

  function renderMoves() {
    const host = document.getElementById('study-movelist');
    if (!host || !state.current) return;
    const c = state.current;
    host.innerHTML = '';
    if (c.quiz && !state.revealed) {
      // Only the guesses the solver has committed are shown — never the solution.
      host.appendChild(h('span', { class: 'st-muted', text: state.guessMoves.length ? `${state.guessMoves.length} move(s) guessed` : 'Moves are concealed. Guess on the board.' }));
    } else {
      const sans = (c.positions || []).slice(1).map(p => p.san);
      host.appendChild(h('button', { type: 'button', text: 'start', 'aria-current': state.ply === 0 ? 'true' : null, onclick: () => { state.ply = 0; renderViewer(); } }));
      for (let i = 0; i < sans.length; i++) {
        if (i % 2 === 0) host.appendChild(h('span', { class: 'st-num', text: `${Math.floor(i / 2) + 1}.` }));
        host.appendChild(h('button', { type: 'button', text: sans[i], 'aria-current': state.ply === i + 1 ? 'true' : null, onclick: () => { state.ply = i + 1; renderViewer(); } }));
      }
    }
    const range = document.getElementById('study-range');
    if (range && c.positions) { range.max = String(c.positions.length - 1); range.value = String(state.ply); }
    const lbl = document.getElementById('study-ply-label');
    if (lbl) lbl.textContent = `Ply ${state.ply}`;
  }

  function setStatus(msg, tone) {
    state.message = msg || '';
    state.status = tone || '';
    const el = document.getElementById('study-status');
    if (el) { el.textContent = state.message; el.className = 'st-status' + (state.status ? ' ' + state.status : ''); }
  }

  function renderViewer() {
    const panel = document.getElementById('study-viewer-panel');
    if (panel) panel.hidden = !state.current;
    if (!state.current) return;
    const title = document.getElementById('study-viewer-title');
    if (title) title.textContent = `${state.current.title} · ${KIND_LABELS[state.current.kind] || state.current.kind}${state.current.quiz ? ' · quiz' : ''}`;
    const scrub = document.getElementById('study-scrub');
    const showScrub = !state.current.quiz || state.revealed;
    if (scrub) scrub.hidden = !showScrub;
    // The export endpoint refuses to emit a concealed quiz's solution, so the
    // button is hidden until this viewer reveals or completes the chapter.
    const exportBtn = document.getElementById('study-export-pgn');
    if (exportBtn) exportBtn.hidden = !!(state.current.quiz && !state.revealed);
    if (state.current.quiz && !state.revealed) {
      if (state.quizFen == null) state.quizFen = state.current.startFen;
      state.lastMove = null;
    }
    renderBoard();
    renderMoves();
    renderTurn();
  }

  // ------------------------------------------------------------------ quiz
  function onSquareClick(sq) {
    if (!interactive()) return;
    const pieces = parseFen(currentFen());
    const piece = pieces[sq];
    const me = sideToMove(currentFen());
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
    submitGuess(from + sq);
  }

  function showPromotion(from, to) {
    const wrap = document.querySelector('.st-board-wrap');
    if (!wrap) return;
    const me = sideToMove(currentFen());
    const overlay = h('div', { class: 'st-promo', role: 'dialog', 'aria-label': 'Choose promotion piece' });
    const cleanup = () => {
      window.removeEventListener('keydown', onKey);
      overlay.remove();
      state.selected = null;
      renderBoard();
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        cleanup();
      }
    };
    window.addEventListener('keydown', onKey);
    for (const type of ['q', 'r', 'b', 'n']) {
      const btn = h('button', {
        type: 'button',
        'aria-label': `Promote to ${type}`,
        onclick: () => {
          window.removeEventListener('keydown', onKey);
          overlay.remove();
          submitGuess(from + to + type);
        }
      });
      if (typeof window.pieceSvgMarkup === 'function') btn.innerHTML = window.pieceSvgMarkup(me, type);
      else btn.textContent = type.toUpperCase();
      overlay.appendChild(btn);
    }
    const cancelBtn = h('button', {
      type: 'button',
      class: 'st-promo-cancel',
      'aria-label': 'Cancel promotion',
      onclick: () => {
        cleanup();
      }
    }, 'Cancel');
    overlay.appendChild(cancelBtn);
    wrap.appendChild(overlay);
  }

  function submitGuess(uci) {
    if (!state.current || state.busy) return;
    state.busy = true;
    state.selected = null;
    renderBoard();
    const id = state.current.id;
    api(`/api/study/${encodeURIComponent(id)}/guess`, { method: 'POST', body: { move: uci, moves: state.guessMoves } }).then(res => {
      state.busy = false;
      if (!state.current || state.current.id !== id) return;
      if (!res || res.ok !== true) { setStatus(res && res.error ? res.error : 'Could not check that move.', 'error'); renderBoard(); return; }
      if (res.legal === false) { setStatus('That move is not legal here.', 'error'); renderBoard(); return; }
      if (!res.correct) {
        setStatus(`${res.move.san} is not the move. Try again.`, 'error');
        state.lastMove = null;
        renderBoard();
        return;
      }
      setStatus('');
      state.guessMoves = res.moves;
      state.quizFen = res.fen;
      state.lastMove = res.reply ? { from: res.reply.uci.slice(0, 2), to: res.reply.uci.slice(2, 4) } : { from: uci.slice(0, 2), to: uci.slice(2, 4) };
      if (res.complete) {
        // Completing a chapter reveals it: fetch the authoritative positions
        // (which include the whole line) rather than guessing client-side.
        setStatus('Chapter complete — well played.', 'ok');
        fetchRevealed();
      } else {
        renderBoard();
      }
    }).catch(() => { state.busy = false; setStatus('Network error — try again.', 'error'); renderBoard(); });
  }

  /** Pull the full revealed chapter (positions + solution) from the server. */
  function fetchRevealed() {
    if (!state.current) return;
    const id = state.current.id;
    api(`/api/study/${encodeURIComponent(id)}/reveal`, { method: 'POST', body: {} }).then(res => {
      if (!state.current || state.current.id !== id || !res || res.ok !== true) { renderViewer(); return; }
      state.current.positions = res.chapter.positions || state.current.positions;
      state.current.solutionSan = res.chapter.solutionSan || [];
      state.positions = state.current.positions;
      state.revealed = true;
      state.ply = 0;
      renderViewer();
    }).catch(() => renderViewer());
  }

  // ------------------------------------------------------------------ chapter list / viewer
  function openChapter(id) {
    api(`/api/study/${encodeURIComponent(id)}`).then(res => {
      if (!res || res.ok !== true) { setListStatus(res && res.error ? res.error : 'Could not open that chapter.', 'error'); return; }
      const c = res.chapter;
      state.current = c;
      state.ply = 0;
      // The server owns reveal state; a quiz chapter that this viewer already
      // revealed/completed comes back with positions + revealed:true.
      state.revealed = !!c.revealed;
      state.guessMoves = [];
      state.quizFen = c.startFen;
      state.selected = null;
      state.lastMove = null;
      state.positions = c.positions || [{ fen: c.startFen, san: null, lastMove: null }];
      setStatus(c.quiz && !state.revealed ? 'Moves are concealed — guess on the board, or press Reveal.' : '', '');
      renderViewer();
      const panel = document.getElementById('study-viewer-panel');
      if (panel && panel.scrollIntoView) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function doReveal() {
    if (!state.current || !state.current.quiz) { setStatus('This chapter is already visible.', ''); return; }
    api(`/api/study/${encodeURIComponent(state.current.id)}/reveal`, { method: 'POST', body: {} }).then(res => {
      if (!res || res.ok !== true) { setStatus(res && res.error ? res.error : 'Could not reveal the solution.', 'error'); return; }
      state.current.positions = res.chapter.positions || state.current.positions;
      state.current.solutionSan = res.chapter.solutionSan || [];
      state.positions = state.current.positions;
      state.revealed = true;
      state.ply = 0;
      setStatus('Solution revealed.', '');
      renderViewer();
    });
  }

  function exportPgn() {
    if (!state.current) return;
    api(`/api/study/${encodeURIComponent(state.current.id)}/pgn`).then(res => {
      if (!res || res.ok !== true) { setStatus(res && res.error ? res.error : 'Export failed.', 'error'); return; }
      const out = document.getElementById('study-pgn-out');
      if (out) out.value = res.pgn;
      setStatus('PGN exported below ($1–$9 NAGs preserved).', 'ok');
    });
  }

  function deleteChapter() {
    if (!state.current) return;
    const id = state.current.id;
    api(`/api/study/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(res => {
      if (!res || res.ok !== true) { setStatus(res && res.error ? res.error : 'Delete failed.', 'error'); return; }
      state.current = null;
      renderViewer();
      loadChapters();
    });
  }

  function setListStatus(msg, tone) {
    const el = document.getElementById('study-create-status');
    if (el) { el.textContent = msg; el.className = 'st-status' + (tone ? ' ' + tone : ''); }
  }

  function renderChapterList() {
    const list = document.getElementById('study-list');
    if (!list) return;
    list.innerHTML = '';
    if (state.chapters.length === 0) { list.appendChild(h('li', { class: 'st-muted', text: 'No chapters yet. Create one on the left.' })); return; }
    for (const ch of state.chapters) {
      const li = h('li');
      const left = h('div');
      left.appendChild(h('div', { text: ch.title }));
      left.appendChild(h('div', { class: 'st-meta', text: `${KIND_LABELS[ch.kind] || ch.kind} · ${ch.totalMoves} moves · ${fmtDate(ch.updatedAt)}` }));
      if (ch.quiz) left.appendChild(h('span', { class: 'st-badge', text: 'quiz' }));
      if (ch.owned) left.appendChild(h('span', { class: 'st-badge', text: 'owned' }));
      const open = h('button', { type: 'button', text: 'Open', onclick: () => openChapter(ch.id) });
      li.appendChild(left);
      li.appendChild(open);
      list.appendChild(li);
    }
  }

  // listSeq guards against out-of-order responses: a slow GET issued before a
  // create (possibly without the guest cookie) must not clobber the fresh list
  // the create refresh produced. listPromise dedupes the mount()+show() pair on
  // first navigation so two concurrent first-contact GETs cannot race and mint
  // two different guest identities (the chapter would then be invisible).
  let listSeq = 0;
  let listPromise = null;

  function loadChapters(options) {
    const force = !!(options && options.force);
    if (listPromise && !force) return listPromise;
    const seq = ++listSeq;
    const promise = api('/api/study').then(res => {
      if (seq !== listSeq) return; // superseded by a newer load
      const list = document.getElementById('study-list');
      if (!list) return;
      if (!res || res.ok !== true) { list.innerHTML = ''; list.appendChild(h('li', { class: 'st-muted', text: 'Could not load chapters.' })); return; }
      state.chapters = res.chapters || [];
      state.authenticated = !!res.authenticated;
      const scope = document.getElementById('study-scope');
      if (scope) scope.textContent = res.authenticated ? 'Your chapters.' : 'Guest chapters on this server. Sign in to keep them with your account.';
      renderChapterList();
    }).catch(() => {
      if (seq !== listSeq) return;
      const list = document.getElementById('study-list');
      if (list) { list.innerHTML = ''; list.appendChild(h('li', { class: 'st-muted', text: 'Could not load chapters.' })); }
    }).then(() => { if (listPromise === promise) listPromise = null; });
    listPromise = promise;
    // A fetch that never settles must not wedge the dedupe guard and disable
    // later (Refresh) loads; release it after a generous safety window.
    const wedgeTimer = setTimeout(() => { if (listPromise === promise) listPromise = null; }, 15000);
    promise.then(() => clearTimeout(wedgeTimer), () => clearTimeout(wedgeTimer));
    return promise;
  }

  // ------------------------------------------------------------------ create
  function currentKind() {
    const pressed = document.querySelector('#study-kind-tabs button[aria-pressed="true"]');
    return pressed ? pressed.getAttribute('data-kind') : 'pgn';
  }

  function createChapter() {
    const kind = currentKind();
    const quiz = document.getElementById('study-quiz-toggle').checked;
    const body = { kind, quiz };
    if (kind === 'pgn') {
      body.pgn = document.getElementById('study-pgn').value;
      body.title = document.getElementById('study-pgn-title').value;
    } else if (kind === 'fen') {
      body.fen = document.getElementById('study-fen').value;
      body.line = document.getElementById('study-fen-line').value;
      body.title = document.getElementById('study-fen-title').value;
    } else {
      body.gameId = document.getElementById('study-game-id').value;
      body.title = document.getElementById('study-game-title').value;
    }
    setListStatus('Creating…', '');
    api('/api/study', { method: 'POST', body }).then(res => {
      if (!res || res.ok !== true) { setListStatus(res && res.error ? res.error : 'Create failed.', 'error'); return; }
      setListStatus('Chapter created.', 'ok');
      // Optimistically insert the chapter the server just returned under THIS
      // viewer's identity, then refresh authoritatively. Even if a slow,
      // stale pre-create GET resolves later, the sequence guard in
      // loadChapters() discards it, so the new row cannot vanish.
      if (res.chapter) {
        const known = state.chapters.some(ch => ch.id === res.chapter.id);
        state.chapters = known ? state.chapters : [res.chapter].concat(state.chapters);
        renderChapterList();
      }
      loadChapters({ force: true });
      openChapter(res.chapter.id);
    }).catch(() => setListStatus('Network error.', 'error'));
  }

  function bindCreateTabs() {
    const tabs = document.getElementById('study-kind-tabs');
    if (!tabs) return;
    tabs.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        tabs.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
        const kind = btn.getAttribute('data-kind');
        document.getElementById('study-form-pgn').hidden = kind !== 'pgn';
        document.getElementById('study-form-fen').hidden = kind !== 'fen';
        document.getElementById('study-form-game').hidden = kind !== 'game';
      });
    });
  }

  // ------------------------------------------------------------------ shell
  function mount(el) {
    injectStyles();
    state.el = el;
    renderSkeleton(el);
    bindCreateTabs();
    document.getElementById('study-create-btn').addEventListener('click', createChapter);
    document.getElementById('study-refresh-btn').addEventListener('click', loadChapters);
    document.getElementById('study-guess-reveal').addEventListener('click', doReveal);
    document.getElementById('study-export-pgn').addEventListener('click', exportPgn);
    document.getElementById('study-delete').addEventListener('click', deleteChapter);
    document.getElementById('study-close').addEventListener('click', () => { state.current = null; renderViewer(); });
    document.getElementById('study-first').addEventListener('click', () => { state.ply = 0; renderViewer(); });
    document.getElementById('study-prev').addEventListener('click', () => { state.ply = Math.max(0, state.ply - 1); renderViewer(); });
    document.getElementById('study-next').addEventListener('click', () => { state.ply = Math.min(state.positions.length - 1, state.ply + 1); renderViewer(); });
    document.getElementById('study-last').addEventListener('click', () => { state.ply = state.positions.length - 1; renderViewer(); });
    document.getElementById('study-range').addEventListener('input', (e) => { state.ply = Number(e.target.value) || 0; renderViewer(); });
    renderBoard();
    loadChapters();
  }

  function show() { loadChapters(); }

  function init() {
    if (!window.Shell || typeof window.Shell.registerView !== 'function') return;
    window.Shell.registerView({ id: 'study', title: 'Study', order: 42, nav: true, mount, show });
  }

  window.UIStudy = { init, state, openChapter, parseFen, sideToMove };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
