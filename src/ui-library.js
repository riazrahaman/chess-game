// ui-library.js — Wave 3 (roadmap §4 R1 Library row, §6 N3.17): the Library view (#/library).
//
// The game archive as a page: search + source filter chips, a paginated list
// from GET /api/library (guests see the unowned local games; a signed-in user
// sees the games bound to their account), "Open in Analysis" / "Export PGN"
// row actions, PGN paste import (the same POST /api/games path the archive
// modal uses), lichess / Chess.com history import (server-side fetch through
// /api/import/*) and "Claim my guest games" (POST /api/library/claim with the
// room ids this browser remembers). Pure display layer over server-reported
// data; the existing archive modal (#game-archive-btn) keeps working untouched.
// Registers with the shell via Shell.registerView({ id: 'library', ... }).

'use strict';

const libraryState = {
  el: null,
  user: null,
  q: '',
  source: 'all',
  page: 1,
  pageSize: 20,
  hasMore: false,
  total: null,
  busy: false,
  visible: false
};

const LIBRARY_SOURCES = [
  { id: 'all', label: 'All' },
  { id: 'local', label: 'Local' },
  { id: 'lichess', label: 'lichess' },
  { id: 'chesscom', label: 'Chess.com' },
  { id: 'pgn', label: 'PGN' }
];

function libraryEsc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function libraryFetch(path, options) {
  const opts = Object.assign({ credentials: 'include', cache: 'no-store' }, options || {});
  if (opts.body && typeof opts.body !== 'string') {
    opts.body = JSON.stringify(opts.body);
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  }
  // service-worker.js is cache-first for same-origin GETs: bust with a timestamp.
  const url = (!opts.method || opts.method === 'GET') ? path + (path.includes('?') ? '&' : '?') + '_t=' + Date.now() : path;
  const res = await fetch(url, opts);
  let json = null;
  try { json = await res.json(); } catch (_) { json = null; }
  return { ok: res.ok, status: res.status, body: json || {} };
}

function libraryInjectStyles() {
  if (document.getElementById('library-styles')) return;
  const style = document.createElement('style');
  style.id = 'library-styles';
  style.textContent = `
    .library-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); gap: 16px; margin-top: 12px; }
    @media (max-width: 900px) { .library-grid { grid-template-columns: 1fr; } }
    .library-panel { border: 1px solid var(--panel-border); border-radius: 10px; background: var(--panel-bg); padding: 14px 16px; min-width: 0; }
    .library-panel h3 { margin: 0 0 8px; font-size: 1.05rem; }
    .library-panel h4 { margin: 12px 0 6px; font-size: 0.95rem; }
    .library-toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
    .library-toolbar input[type="search"] { flex: 1 1 200px; min-height: 40px; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--panel-border); background: var(--panel-bg); color: var(--text-color); }
    .library-chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .library-chip { min-height: 36px; padding: 4px 12px; border-radius: 999px; border: 1px solid var(--panel-border); background: transparent; color: var(--text-color); cursor: pointer; font-size: 0.85rem; }
    .library-chip[aria-pressed="true"] { background: var(--accent, #2563eb); color: #fff; border-color: var(--accent, #2563eb); }
    .library-list { list-style: none; margin: 0; padding: 0; }
    .library-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; padding: 10px 0; border-bottom: 1px solid var(--panel-border); align-items: center; }
    .library-row:last-child { border-bottom: 0; }
    .library-players { font-weight: 600; overflow-wrap: anywhere; }
    .library-meta { font-size: 0.8rem; color: var(--muted); display: flex; gap: 8px; flex-wrap: wrap; margin-top: 2px; }
    .library-result { font-family: ui-monospace, monospace; font-weight: 600; }
    .library-badge { display: inline-block; font-size: 0.7rem; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--panel-border); color: var(--muted); text-transform: none; }
    .library-badge[data-source="lichess"] { border-color: #6b7280; }
    .library-badge[data-source="chesscom"] { border-color: #7fa650; color: #5c8a2e; }
    .library-badge[data-source="pgn"] { border-color: #c084fc; }
    .library-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .library-actions a, .library-actions button, .library-panel button { min-height: 36px; padding: 6px 10px; font-size: 0.85rem; }
    .library-actions a { display: inline-flex; align-items: center; text-decoration: none; border: 1px solid var(--panel-border); border-radius: 6px; color: var(--text-color); }
    .library-pager { display: flex; gap: 8px; align-items: center; justify-content: space-between; margin-top: 10px; }
    .library-empty { color: var(--muted); font-size: 0.9rem; padding: 12px 0; }
    .library-form { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
    .library-form input[type="text"] { flex: 1 1 140px; min-height: 36px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--panel-border); background: var(--panel-bg); color: var(--text-color); }
    .library-form textarea { width: 100%; min-height: 110px; font-family: ui-monospace, monospace; font-size: 0.8rem; padding: 8px; border-radius: 6px; border: 1px solid var(--panel-border); background: var(--panel-bg); color: var(--text-color); box-sizing: border-box; }
    .library-status { font-size: 0.85rem; color: var(--muted); min-height: 1.2em; margin-top: 6px; }
    .library-status[data-tone="ok"] { color: #16a34a; }
    .library-status[data-tone="error"] { color: #dc2626; }
    .library-imports { font-size: 0.8rem; color: var(--muted); margin: 6px 0 0; padding-left: 16px; }
  `;
  document.head.appendChild(style);
}

function libraryRenderSkeleton(el) {
  const chips = LIBRARY_SOURCES.map(s =>
    `<button type="button" class="library-chip" data-source="${s.id}" aria-pressed="${s.id === libraryState.source}">${libraryEsc(s.label)}</button>`
  ).join('');
  el.innerHTML = `
    <h2 id="library-title">Library</h2>
    <p class="supporting-copy" id="library-scope"></p>
    <div class="library-grid">
      <section class="library-panel" aria-labelledby="library-games-title">
        <h3 id="library-games-title">Games</h3>
        <form class="library-toolbar" id="library-search-form" role="search">
          <input type="search" id="library-search" placeholder="Search players, ECO, result…" aria-label="Search games" autocomplete="off">
          <button type="submit" id="library-search-btn">Search</button>
        </form>
        <div class="library-chips" role="group" aria-label="Source filter" id="library-chips">${chips}</div>
        <ul class="library-list" id="library-list" aria-live="polite"></ul>
        <div class="library-pager">
          <button type="button" id="library-prev" disabled>Previous</button>
          <span id="library-page-info" class="library-status"></span>
          <button type="button" id="library-next" disabled>Next</button>
        </div>
      </section>
      <section class="library-panel" aria-labelledby="library-import-title">
        <h3 id="library-import-title">Import</h3>
        <h4>Paste a PGN</h4>
        <form class="library-form" id="library-pgn-form">
          <textarea id="library-pgn-text" aria-label="PGN text" placeholder="[Event &quot;…&quot;]&#10;&#10;1. e4 e5 2. Nf3 …"></textarea>
          <button type="submit" id="library-pgn-submit">Save to library</button>
        </form>
        <p class="library-status" id="library-pgn-status"></p>
        <div id="library-external"></div>
      </section>
    </div>`;
}

function libraryOpenSignIn() {
  if (typeof window.openAuthModal === 'function') { window.openAuthModal(); return; }
  const btn = document.getElementById('auth-sign-in-btn');
  if (btn) btn.click();
}

function libraryRenderExternal() {
  const host = document.getElementById('library-external');
  if (!host) return;
  if (!libraryState.user) {
    host.innerHTML = `
      <h4>Import from lichess or Chess.com</h4>
      <p class="library-empty">Sign in to import your online game history and keep your games bound to your account.</p>
      <button type="button" id="library-sign-in-btn">Sign in</button>`;
    return;
  }
  host.innerHTML = `
    <h4>lichess</h4>
    <form class="library-form" id="library-lichess-form" data-source="lichess">
      <input type="text" id="library-lichess-user" aria-label="lichess username" placeholder="lichess username" autocomplete="off" maxlength="40">
      <button type="submit">Import</button>
    </form>
    <h4>Chess.com</h4>
    <form class="library-form" id="library-chesscom-form" data-source="chesscom">
      <input type="text" id="library-chesscom-user" aria-label="Chess.com username" placeholder="Chess.com username" autocomplete="off" maxlength="40">
      <button type="submit">Import</button>
    </form>
    <p class="library-status" id="library-import-status"></p>
    <ul class="library-imports" id="library-import-history"></ul>
    <h4>Guest games</h4>
    <p class="library-empty">Games you played in this browser before signing in can be moved into your account.</p>
    <button type="button" id="library-claim-btn">Claim my guest games</button>
    <p class="library-status" id="library-claim-status"></p>`;
  libraryLoadImportStatus();
}

function libraryFormatDate(row) {
  if (row.date && /^\d{4}\.\d{2}\.\d{2}$/.test(row.date)) return row.date.replace(/\./g, '-');
  if (row.createdAt) { try { return new Date(row.createdAt).toISOString().slice(0, 10); } catch (_) { /* fall through */ } }
  return row.date || '';
}

function librarySourceLabel(source) {
  const s = LIBRARY_SOURCES.find(x => x.id === source);
  return s ? s.label : (source || 'Local');
}

function libraryRenderRows(games) {
  const list = document.getElementById('library-list');
  if (!list) return;
  if (!games.length) {
    const why = libraryState.q ? 'No games match that search.' : (libraryState.user
      ? 'No games in your library yet — finish a game, paste a PGN, or import your lichess / Chess.com history.'
      : 'No local games yet — finish a game on the Play view or paste a PGN to get started.');
    list.innerHTML = `<li class="library-empty">${libraryEsc(why)}</li>`;
    return;
  }
  list.innerHTML = games.map(g => {
    const opening = g.opening ? `${g.eco ? g.eco + ' ' : ''}${g.opening}` : (g.eco || '');
    const moves = g.plies ? `${Math.ceil(g.plies / 2)} moves` : '';
    const ext = g.externalUrl ? `<a href="${libraryEsc(g.externalUrl)}" target="_blank" rel="noopener noreferrer">View on ${libraryEsc(librarySourceLabel(g.source))}</a>` : '';
    return `
      <li class="library-row" data-id="${libraryEsc(g.id)}">
        <div>
          <div class="library-players">${libraryEsc(g.white || 'White')} <span class="library-result">${libraryEsc(g.result || '*')}</span> ${libraryEsc(g.black || 'Black')}</div>
          <div class="library-meta">
            <span>${libraryEsc(libraryFormatDate(g))}</span>
            ${opening ? `<span>${libraryEsc(opening)}</span>` : ''}
            ${moves ? `<span>${libraryEsc(moves)}</span>` : ''}
            ${g.timeControl ? `<span>${libraryEsc(g.timeControl)}</span>` : ''}
            <span class="library-badge" data-source="${libraryEsc(g.source || 'local')}">${libraryEsc(librarySourceLabel(g.source))}</span>
          </div>
        </div>
        <div class="library-actions">
          <button type="button" data-analyse="${libraryEsc(g.id)}">Open in Analysis</button>
          <a href="/api/games/${encodeURIComponent(g.id)}/pgn" download="${libraryEsc(g.id)}.pgn">Export PGN</a>
          ${ext}
        </div>
      </li>`;
  }).join('');
}

async function libraryLoad() {
  if (!libraryState.el) return;
  const params = new URLSearchParams({ page: String(libraryState.page), pageSize: String(libraryState.pageSize) });
  if (libraryState.q) params.set('q', libraryState.q);
  if (libraryState.source && libraryState.source !== 'all') params.set('source', libraryState.source);
  const info = document.getElementById('library-page-info');
  if (info) info.textContent = 'Loading…';
  const res = await libraryFetch('/api/library?' + params.toString());
  if (!res.ok) {
    if (info) info.textContent = res.body.error || `Could not load the library (${res.status}).`;
    libraryRenderRows([]);
    return;
  }
  const games = Array.isArray(res.body.games) ? res.body.games : [];
  libraryState.hasMore = !!res.body.hasMore;
  libraryState.total = typeof res.body.total === 'number' ? res.body.total : null;
  libraryRenderRows(games);
  const scope = document.getElementById('library-scope');
  if (scope) {
    scope.textContent = res.body.owner === 'me'
      ? `Games bound to ${libraryState.user ? libraryState.user.username : 'your account'}.`
      : 'Local games saved on this server. Sign in to bind them to an account and import your online history.';
  }
  const prev = document.getElementById('library-prev');
  const next = document.getElementById('library-next');
  if (prev) prev.disabled = libraryState.page <= 1;
  if (next) next.disabled = !libraryState.hasMore;
  if (info) {
    const from = games.length ? (libraryState.page - 1) * libraryState.pageSize + 1 : 0;
    const to = (libraryState.page - 1) * libraryState.pageSize + games.length;
    info.textContent = games.length
      ? (libraryState.total != null ? `${from}–${to} of ${libraryState.total}` : `${from}–${to}`)
      : '';
  }
}

function librarySetStatus(id, text, tone) {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = text || '';
  if (tone) node.dataset.tone = tone; else delete node.dataset.tone;
}

async function libraryLoadImportStatus() {
  const host = document.getElementById('library-import-history');
  if (!host || !libraryState.user) return;
  const res = await libraryFetch('/api/import/status');
  if (!res.ok) { host.innerHTML = ''; return; }
  const rows = Array.isArray(res.body.imports) ? res.body.imports : [];
  host.innerHTML = rows.map(r => {
    const when = r.lastRunAt ? new Date(r.lastRunAt).toLocaleString() : '';
    const outcome = r.error ? `failed: ${r.error}` : `${r.imported} imported, ${r.skipped} skipped`;
    return `<li>${libraryEsc(librarySourceLabel(r.source))} · ${libraryEsc(r.username)} · ${libraryEsc(outcome)} · ${libraryEsc(when)}</li>`;
  }).join('');
  for (const r of rows) {
    const input = document.getElementById(`library-${r.source}-user`);
    if (input && !input.value && r.username) input.value = r.username;
  }
}

async function librarySubmitPgn(ev) {
  ev.preventDefault();
  const textarea = document.getElementById('library-pgn-text');
  const pgn = textarea ? textarea.value.trim() : '';
  if (!pgn) { librarySetStatus('library-pgn-status', 'Paste a PGN first.', 'error'); return; }
  librarySetStatus('library-pgn-status', 'Saving…');
  const res = await libraryFetch('/api/games', { method: 'POST', body: { pgn } });
  if (!res.ok || !res.body.ok) { librarySetStatus('library-pgn-status', res.body.error || 'Could not save that PGN.', 'error'); return; }
  librarySetStatus('library-pgn-status', 'Saved to your library.', 'ok');
  if (textarea) textarea.value = '';
  libraryState.page = 1;
  libraryLoad();
}

async function librarySubmitExternal(ev) {
  ev.preventDefault();
  const form = ev.target;
  const source = form.dataset.source;
  const input = form.querySelector('input[type="text"]');
  const username = input ? input.value.trim() : '';
  if (!username) { librarySetStatus('library-import-status', 'Enter a username first.', 'error'); return; }
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(username)) { librarySetStatus('library-import-status', 'Usernames are letters, digits, "_" or "-".', 'error'); return; }
  if (libraryState.busy) return;
  libraryState.busy = true;
  form.querySelectorAll('button').forEach(b => { b.disabled = true; });
  librarySetStatus('library-import-status', `Importing ${username}'s ${librarySourceLabel(source)} games… this can take a minute.`);
  try {
    const res = await libraryFetch(`/api/import/${encodeURIComponent(source)}`, { method: 'POST', body: { username } });
    if (!res.ok) {
      const msg = res.status === 404 ? `No ${librarySourceLabel(source)} user named "${username}".`
        : res.status === 429 ? `${librarySourceLabel(source)} is rate-limiting requests — try again in a minute.`
          : (res.body.error || `Import failed (${res.status}).`);
      librarySetStatus('library-import-status', msg, 'error');
    } else {
      const b = res.body;
      const more = b.total >= 500 ? ' Showing your most recent 500 games; later runs pick up new games.' : '';
      librarySetStatus('library-import-status', `${librarySourceLabel(source)}: ${b.imported} imported, ${b.skipped} already in your library.${more}`, 'ok');
      libraryState.page = 1;
      libraryLoad();
    }
  } catch (err) {
    librarySetStatus('library-import-status', 'Import failed: ' + (err && err.message ? err.message : err), 'error');
  } finally {
    libraryState.busy = false;
    form.querySelectorAll('button').forEach(b => { b.disabled = false; });
    libraryLoadImportStatus();
  }
}

/** Room ids this browser remembers (personal room + any room it held a seat in). */
function libraryKnownRoomIds() {
  const rooms = new Set();
  try {
    const personal = window.localStorage ? window.localStorage.getItem('chess_personal_room') : null;
    if (personal) rooms.add(personal);
    if (window.localStorage) {
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i) || '';
        const m = key.match(/^chess_seat_(?:token|role)_(.+)$/);
        if (m) rooms.add(m[1]);
      }
    }
  } catch (_) { /* storage unavailable */ }
  try {
    if (typeof getCurrentRoomId === 'function') {
      const cur = getCurrentRoomId();
      if (cur && cur !== 'default') rooms.add(cur);
    }
  } catch (_) { /* ui.js not loaded yet */ }
  return Array.from(rooms).filter(r => /^[a-zA-Z0-9_-]{1,80}$/.test(r)).slice(0, 200);
}

async function libraryClaimGuestGames() {
  const roomIds = libraryKnownRoomIds();
  if (!roomIds.length) { librarySetStatus('library-claim-status', 'This browser has no guest rooms to claim.', 'error'); return; }
  librarySetStatus('library-claim-status', 'Claiming…');
  const res = await libraryFetch('/api/library/claim', { method: 'POST', body: { roomIds } });
  if (!res.ok) { librarySetStatus('library-claim-status', res.body.error || 'Could not claim games.', 'error'); return; }
  const n = res.body.count || 0;
  librarySetStatus('library-claim-status', n ? `Moved ${n} game${n === 1 ? '' : 's'} into your account.` : 'No unclaimed guest games found for this browser.', 'ok');
  if (n) { libraryState.page = 1; libraryLoad(); }
}

function libraryBindEvents(el) {
  el.addEventListener('submit', ev => {
    if (ev.target.id === 'library-search-form') {
      ev.preventDefault();
      const input = document.getElementById('library-search');
      libraryState.q = input ? input.value.trim() : '';
      libraryState.page = 1;
      libraryLoad();
    } else if (ev.target.id === 'library-pgn-form') {
      librarySubmitPgn(ev);
    } else if (ev.target.classList && ev.target.classList.contains('library-form') && ev.target.dataset.source) {
      librarySubmitExternal(ev);
    }
  });
  el.addEventListener('click', ev => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    if (btn.classList.contains('library-chip')) {
      libraryState.source = btn.dataset.source || 'all';
      libraryState.page = 1;
      el.querySelectorAll('.library-chip').forEach(c => c.setAttribute('aria-pressed', String(c === btn)));
      libraryLoad();
    } else if (btn.dataset.analyse) {
      if (window.Shell && typeof window.Shell.navigate === 'function') window.Shell.navigate('analysis', { game: btn.dataset.analyse });
    } else if (btn.id === 'library-prev' && libraryState.page > 1) {
      libraryState.page -= 1; libraryLoad();
    } else if (btn.id === 'library-next' && libraryState.hasMore) {
      libraryState.page += 1; libraryLoad();
    } else if (btn.id === 'library-sign-in-btn') {
      libraryOpenSignIn();
    } else if (btn.id === 'library-claim-btn') {
      libraryClaimGuestGames();
    }
  });
}

async function libraryRefresh() {
  let user = null;
  try {
    const res = await libraryFetch('/api/auth/me');
    user = res.body && res.body.authenticated ? res.body.user : null;
  } catch (_) { user = null; }
  const changed = (user ? user.id : null) !== (libraryState.user ? libraryState.user.id : null);
  libraryState.user = user;
  if (changed || !document.getElementById('library-external').children.length) libraryRenderExternal();
  await libraryLoad();
}

function initLibraryView() {
  if (typeof window === 'undefined' || !window.Shell || typeof window.Shell.registerView !== 'function') return;
  window.Shell.registerView({
    id: 'library',
    title: 'Library',
    order: 40,
    nav: true,
    mount(el) {
      libraryState.el = el;
      libraryInjectStyles();
      libraryRenderSkeleton(el);
      libraryBindEvents(el);
    },
    show() {
      libraryState.visible = true;
      libraryRefresh();
    },
    hide() {
      libraryState.visible = false;
    }
  });
}

initLibraryView();
