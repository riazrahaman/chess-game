// ui-compete.js — Wave 2 (roadmap R2): the Compete view (#/compete).
//
// Lobby (open seeks, create seek, accept -> /game/<room>#/play), per-pool
// leaderboards, and arenas (list / create / join / standings). Pure display
// layer: every number here comes from /api/lobby/*, /api/leaderboard/:tc and
// /api/arena* — nothing is computed from or written into game state (Gate 4).
// Registers with the shell via Shell.registerView({ id: 'compete', ... }).

'use strict';

const COMPETE_POLL_MS = 5000;
const COMPETE_POOLS = ['bullet', 'blitz', 'rapid', 'classical'];
const COMPETE_TC_OPTIONS = [
  { value: 'bullet_1_0', label: 'Bullet 1+0' },
  { value: 'blitz_3_2', label: 'Blitz 3+2' },
  { value: 'blitz_5_3', label: 'Blitz 5+3' },
  { value: 'rapid_10_15', label: 'Rapid 10+15' },
  { value: 'rapid_15_10', label: 'Rapid 15+10' },
  { value: 'classical_60_0', label: 'Classical 60+0' }
];

const competeState = {
  el: null,
  timer: null,
  user: null,
  pool: 'blitz',
  arenaId: null,
  visible: false
};

function competeEsc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function competeFetch(path, options) {
  const opts = Object.assign({ credentials: 'include' }, options || {});
  if (opts.body && typeof opts.body !== 'string') {
    opts.body = JSON.stringify(opts.body);
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  }
  const res = await fetch(path, opts);
  let json = null;
  try { json = await res.json(); } catch (_) { json = null; }
  return { ok: res.ok, status: res.status, body: json || {} };
}

function competeInjectStyles() {
  if (document.getElementById('compete-styles')) return;
  const style = document.createElement('style');
  style.id = 'compete-styles';
  style.textContent = `
    .compete-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-top: 12px; }
    .compete-panel { border: 1px solid var(--panel-border); border-radius: 10px; background: var(--panel-bg); padding: 14px 16px; min-width: 0; }
    .compete-panel h3 { margin: 0 0 8px; font-size: 1.05rem; }
    .compete-panel table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    .compete-panel th, .compete-panel td { text-align: left; padding: 6px 4px; border-bottom: 1px solid var(--panel-border); vertical-align: middle; }
    .compete-panel th { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
    .compete-form { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0 12px; }
    .compete-form select, .compete-form input { min-height: 36px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--panel-border); background: var(--panel-bg); color: var(--text-color); }
    .compete-form input[type=number] { width: 90px; }
    .compete-form input[type=text] { flex: 1 1 140px; }
    .compete-panel button { min-height: 36px; padding: 6px 12px; }
    .compete-tabs { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 8px; }
    .compete-tabs button { border-radius: 999px; padding: 4px 12px; font-size: 0.85rem; }
    .compete-tabs button[aria-pressed="true"] { outline: 2px solid var(--accent, currentColor); }
    .compete-badge { display: inline-block; font-size: 0.7rem; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--panel-border); color: var(--muted); margin-left: 6px; }
    .compete-empty { color: var(--muted); font-size: 0.9rem; padding: 8px 0; }
    .compete-status { font-size: 0.85rem; color: var(--muted); min-height: 1.2em; margin-top: 6px; }
    .compete-mine { border-left: 3px solid var(--accent, currentColor); }
    .compete-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    @media (max-width: 679px) { .compete-panel { padding: 12px; } .compete-panel td, .compete-panel th { padding: 8px 2px; } }
  `;
  document.head.appendChild(style);
}

function competeRenderSkeleton(el) {
  el.innerHTML = `
    <h2 id="compete-title">Compete</h2>
    <p class="supporting-copy">Find a rated opponent, climb the leaderboards, or join an arena. Games between two signed-in players are rated per time control; bot and guest games are not.</p>
    <div id="compete-auth-note" class="compete-status" role="status"></div>
    <div class="compete-grid">
      <section class="compete-panel" aria-labelledby="compete-lobby-title">
        <h3 id="compete-lobby-title">Lobby</h3>
        <form id="compete-seek-form" class="compete-form" autocomplete="off">
          <label class="sr-only" for="compete-seek-tc">Time control</label>
          <select id="compete-seek-tc" name="tc">
            ${COMPETE_TC_OPTIONS.map(o => `<option value="${o.value}"${o.value === 'blitz_3_2' ? ' selected' : ''}>${o.label}</option>`).join('')}
          </select>
          <label class="sr-only" for="compete-seek-range">Rating range (±)</label>
          <input id="compete-seek-range" name="ratingRange" type="number" min="0" max="3000" step="50" value="200" title="Rating range ±">
          <button type="submit" id="compete-seek-btn">Create seek</button>
          <button type="button" id="compete-seek-cancel-btn" hidden>Cancel my seek</button>
        </form>
        <div id="compete-seeks"></div>
        <div id="compete-lobby-status" class="compete-status" role="status" aria-live="polite"></div>
      </section>
      <section class="compete-panel" aria-labelledby="compete-lb-title">
        <h3 id="compete-lb-title">Leaderboards</h3>
        <div class="compete-tabs" id="compete-lb-tabs" role="tablist">
          ${COMPETE_POOLS.map(p => `<button type="button" role="tab" data-pool="${p}" aria-pressed="${p === competeState.pool}">${p.charAt(0).toUpperCase() + p.slice(1)}</button>`).join('')}
        </div>
        <div id="compete-leaderboard"></div>
      </section>
      <section class="compete-panel" aria-labelledby="compete-arena-title">
        <h3 id="compete-arena-title">Arenas</h3>
        <form id="compete-arena-form" class="compete-form" autocomplete="off">
          <label class="sr-only" for="compete-arena-name">Arena name</label>
          <input id="compete-arena-name" name="name" type="text" maxlength="60" placeholder="Arena name">
          <label class="sr-only" for="compete-arena-tc">Time control</label>
          <select id="compete-arena-tc" name="tc">
            ${COMPETE_TC_OPTIONS.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
          </select>
          <button type="submit" id="compete-arena-btn">Create arena</button>
        </form>
        <div id="compete-arenas"></div>
        <div id="compete-arena-standings"></div>
        <div id="compete-arena-status" class="compete-status" role="status" aria-live="polite"></div>
      </section>
    </div>`;
}

function competeSetStatus(id, text) {
  const node = document.getElementById(id);
  if (node) node.textContent = text || '';
}

async function competeRefreshAuth() {
  try {
    const res = await competeFetch('/api/auth/me');
    competeState.user = res.body && res.body.authenticated ? res.body.user : null;
  } catch (_) {
    competeState.user = null;
  }
  const note = document.getElementById('compete-auth-note');
  if (note) {
    if (competeState.user) {
      note.innerHTML = `Signed in as <strong>${competeEsc(competeState.user.username)}</strong>. Seeks you create and games you accept here are rated.`;
    } else {
      note.innerHTML = 'You are browsing as a guest. <a href="#/me">Sign in</a> to create seeks, join arenas, and get rated.';
    }
  }
  const seekBtn = document.getElementById('compete-seek-btn');
  const arenaBtn = document.getElementById('compete-arena-btn');
  if (seekBtn) seekBtn.disabled = !competeState.user;
  if (arenaBtn) arenaBtn.disabled = !competeState.user;
}

function competeEnterRoom(match) {
  if (!match || !match.roomId) return;
  try {
    if (match.seatToken && match.color) {
      window.localStorage.setItem('chess_seat_token_' + match.roomId, match.seatToken);
      window.localStorage.setItem('chess_seat_role_' + match.roomId, match.color);
      window.sessionStorage.setItem('chess_seat_token', match.seatToken);
      window.sessionStorage.setItem('chess_seat_role', match.color);
    }
    if (match.pairingId) window.sessionStorage.setItem('chess_lobby_seen_' + match.pairingId, '1');
  } catch (_) { /* storage unavailable: the player can still claim a seat manually */ }
  window.location.assign('/game/' + encodeURIComponent(match.roomId) + '#/play');
}

async function competeRefreshLobby() {
  const host = document.getElementById('compete-seeks');
  if (!host) return;
  let seeks = [];
  let mine = null;
  try {
    const res = await competeFetch('/api/lobby/seeks');
    seeks = Array.isArray(res.body.seeks) ? res.body.seeks : [];
    if (competeState.user) {
      const m = await competeFetch('/api/lobby/mine');
      mine = m.ok ? m.body : null;
    }
  } catch (_) {
    competeSetStatus('compete-lobby-status', 'Lobby unavailable — retrying.');
    return;
  }
  const myId = competeState.user ? String(competeState.user.id) : null;
  if (mine && mine.match && mine.match.roomId) {
    let seen = false;
    try { seen = Boolean(window.sessionStorage.getItem('chess_lobby_seen_' + mine.match.pairingId)); } catch (_) {}
    if (!seen) {
      competeSetStatus('compete-lobby-status', `Matched with ${competeEsc(mine.match.opponent && mine.match.opponent.username)} — opening your game as ${mine.match.color}…`);
      competeEnterRoom(mine.match);
      return;
    }
  }
  const cancelBtn = document.getElementById('compete-seek-cancel-btn');
  if (cancelBtn) cancelBtn.hidden = !(mine && mine.seeks && mine.seeks.length);
  if (!seeks.length) {
    host.innerHTML = '<p class="compete-empty">No open seeks right now. Create one and wait for an opponent — you will be taken to the board when someone accepts.</p>';
    return;
  }
  host.innerHTML = `
    <table>
      <thead><tr><th>Player</th><th>Rating</th><th>Time</th><th></th></tr></thead>
      <tbody>
        ${seeks.map(s => {
          const isMine = myId && String(s.playerId) === myId;
          const band = s.ratingBand ? `${s.ratingBand[0]}–${s.ratingBand[1]}` : '';
          const action = isMine
            ? '<span class="compete-badge">your seek</span>'
            : `<button type="button" data-accept="${competeEsc(s.id)}"${competeState.user ? '' : ' disabled title="Sign in to accept"'}>Accept</button>`;
          return `<tr${isMine ? ' class="compete-mine"' : ''}>
            <td>${competeEsc(s.username)}</td>
            <td>${competeEsc(s.rating)}<span class="compete-badge" title="Accepts opponents rated ${band}">±${competeEsc(s.ratingRange)}</span></td>
            <td>${competeEsc(s.tcLabel)}${s.rated ? '' : '<span class="compete-badge">casual</span>'}</td>
            <td>${action}</td></tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

async function competeAcceptSeek(seekId) {
  competeSetStatus('compete-lobby-status', 'Creating your game…');
  const res = await competeFetch('/api/lobby/accept/' + encodeURIComponent(seekId), { method: 'POST' });
  if (!res.ok) {
    competeSetStatus('compete-lobby-status', res.body.error || 'Could not accept that seek.');
    competeRefreshLobby();
    return;
  }
  competeEnterRoom(res.body);
}

async function competeCreateSeek(ev) {
  ev.preventDefault();
  if (!competeState.user) { competeSetStatus('compete-lobby-status', 'Sign in to create a seek.'); return; }
  const tc = document.getElementById('compete-seek-tc').value;
  const ratingRange = Number(document.getElementById('compete-seek-range').value) || 200;
  const res = await competeFetch('/api/lobby/seek', { method: 'POST', body: { tc, ratingRange } });
  competeSetStatus('compete-lobby-status', res.ok ? 'Seek posted. Waiting for an opponent…' : (res.body.error || 'Could not create seek.'));
  competeRefreshLobby();
}

async function competeCancelSeek() {
  const res = await competeFetch('/api/lobby/seek/cancel', { method: 'POST', body: {} });
  competeSetStatus('compete-lobby-status', res.ok ? `Cancelled ${res.body.cancelled} seek(s).` : (res.body.error || 'Could not cancel.'));
  competeRefreshLobby();
}

async function competeRefreshLeaderboard() {
  const host = document.getElementById('compete-leaderboard');
  if (!host) return;
  document.querySelectorAll('#compete-lb-tabs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.pool === competeState.pool)));
  let res;
  try { res = await competeFetch('/api/leaderboard/' + encodeURIComponent(competeState.pool) + '?limit=25'); } catch (_) { return; }
  const ranked = Array.isArray(res.body.ranked) ? res.body.ranked : [];
  const provisional = Array.isArray(res.body.provisional) ? res.body.provisional : [];
  if (!ranked.length && !provisional.length) {
    host.innerHTML = `<p class="compete-empty">Nobody has a ${competeEsc(competeState.pool)} rating yet. Play a rated game from the lobby to appear here.</p>`;
    return;
  }
  const myId = competeState.user ? String(competeState.user.id) : null;
  const row = r => `<tr${myId && String(r.playerId) === myId ? ' class="compete-mine"' : ''}>
      <td>${r.rank == null ? '—' : competeEsc(r.rank)}</td>
      <td>${competeEsc(r.username)}${r.provisional ? '<span class="compete-badge" title="Rating deviation above 110: fewer than ~10 rated games">provisional</span>' : ''}</td>
      <td>${competeEsc(r.rating)} <span class="compete-badge" title="Rating deviation">±${competeEsc(r.rd)}</span></td>
      <td>${myId && String(r.playerId) !== myId ? `<button type="button" data-follow="${competeEsc(r.playerId)}" title="Follow ${competeEsc(r.username)}">Follow</button>` : ''}</td>
    </tr>`;
  host.innerHTML = `
    <table>
      <thead><tr><th>#</th><th>Player</th><th>Rating</th><th></th></tr></thead>
      <tbody>${ranked.map(row).join('')}${provisional.map(row).join('')}</tbody>
    </table>
    ${provisional.length ? '<p class="compete-empty">Provisional players (RD &gt; 110) are listed unranked until their rating settles.</p>' : ''}`;
}

async function competeFollow(userId, button) {
  const res = await competeFetch('/api/social/follow/' + encodeURIComponent(userId), { method: 'POST' });
  if (button) {
    button.textContent = res.ok ? (res.body.friends ? 'Friends' : 'Following') : 'Follow';
    button.disabled = res.ok;
  }
}

function competeNextRoundPreview(payload) {
  // The server returns raw players/results; arena.js (loaded in the page)
  // deterministically pairs the next round from those, seeded by the arena id.
  if (!window.Arena || typeof window.Arena.Arena !== 'function' || !payload || !payload.arena) return [];
  try {
    const preview = new window.Arena.Arena({ seed: payload.arena.id });
    preview.players = (payload.players || []).slice();
    preview.results = (payload.results || []).slice();
    preview.round = Number(payload.round) || 0;
    return preview.pairNextRound();
  } catch (_) {
    return [];
  }
}

async function competeRefreshArenas() {
  const host = document.getElementById('compete-arenas');
  if (!host) return;
  let res;
  try { res = await competeFetch('/api/arena'); } catch (_) { return; }
  const arenas = Array.isArray(res.body.arenas) ? res.body.arenas : [];
  if (!arenas.length) {
    host.innerHTML = '<p class="compete-empty">No arenas yet. Create one and invite friends — rated games between members count toward the standings.</p>';
    document.getElementById('compete-arena-standings').innerHTML = '';
    return;
  }
  host.innerHTML = `
    <table>
      <thead><tr><th>Arena</th><th>Time</th><th>Players</th><th></th></tr></thead>
      <tbody>${arenas.map(a => `<tr${a.id === competeState.arenaId ? ' class="compete-mine"' : ''}>
        <td>${competeEsc(a.name)}<span class="compete-badge">${competeEsc(a.status)}</span></td>
        <td>${competeEsc(a.tcLabel)}</td>
        <td>${competeEsc(a.playerCount)} · ${competeEsc(a.gamesPlayed)} games</td>
        <td class="compete-actions">
          <button type="button" data-standings="${competeEsc(a.id)}">Standings</button>
          <button type="button" data-join="${competeEsc(a.id)}"${competeState.user && a.status === 'open' ? '' : ' disabled'}>Join</button>
        </td></tr>`).join('')}
      </tbody>
    </table>`;
  if (competeState.arenaId) competeShowStandings(competeState.arenaId);
}

async function competeShowStandings(id) {
  competeState.arenaId = id;
  const host = document.getElementById('compete-arena-standings');
  if (!host) return;
  const res = await competeFetch('/api/arena/' + encodeURIComponent(id) + '/standings');
  if (!res.ok) { host.innerHTML = `<p class="compete-empty">${competeEsc(res.body.error || 'Arena not found.')}</p>`; return; }
  const rows = Array.isArray(res.body.standings) ? res.body.standings : [];
  const names = {};
  (res.body.players || []).forEach(p => { names[p.id] = p.name; });
  const preview = competeNextRoundPreview(res.body);
  host.innerHTML = `
    <h4 style="margin:12px 0 6px;">${competeEsc(res.body.arena.name)} — standings</h4>
    <table>
      <thead><tr><th>#</th><th>Player</th><th>Pts</th><th>Games</th><th title="Buchholz">Bh</th><th title="Sonneborn-Berger">SB</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${r.rank}</td><td>${competeEsc(r.name)}${r.streak >= 2 ? '<span class="compete-badge" title="Win streak">🔥' + r.streak + '</span>' : ''}</td><td>${r.score}</td><td>${r.games}</td><td>${r.buchholz}</td><td>${r.sonneborn}</td></tr>`).join('')}</tbody>
    </table>
    ${preview.length ? `<p class="compete-empty">Next-round pairings (preview): ${preview.map(p => p.bye ? `${competeEsc(names[p.white] || p.white)} (bye)` : `${competeEsc(names[p.white] || p.white)} – ${competeEsc(names[p.black] || p.black)}`).join(' · ')}</p>` : ''}`;
}

async function competeCreateArena(ev) {
  ev.preventDefault();
  if (!competeState.user) { competeSetStatus('compete-arena-status', 'Sign in to create an arena.'); return; }
  const name = document.getElementById('compete-arena-name').value.trim();
  const tc = document.getElementById('compete-arena-tc').value;
  if (!name) { competeSetStatus('compete-arena-status', 'Give the arena a name.'); return; }
  const res = await competeFetch('/api/arena', { method: 'POST', body: { name, tc } });
  competeSetStatus('compete-arena-status', res.ok ? 'Arena created — you are its first player.' : (res.body.error || 'Could not create arena.'));
  if (res.ok) { document.getElementById('compete-arena-name').value = ''; competeState.arenaId = res.body.arena.id; }
  competeRefreshArenas();
}

async function competeJoinArena(id) {
  const res = await competeFetch('/api/arena/' + encodeURIComponent(id) + '/join', { method: 'POST' });
  competeSetStatus('compete-arena-status', res.ok ? (res.body.joined ? 'Joined the arena.' : 'You are already in this arena.') : (res.body.error || 'Could not join.'));
  competeState.arenaId = id;
  competeRefreshArenas();
}

function competeBindEvents(el) {
  el.addEventListener('submit', ev => {
    if (ev.target.id === 'compete-seek-form') competeCreateSeek(ev);
    else if (ev.target.id === 'compete-arena-form') competeCreateArena(ev);
  });
  el.addEventListener('click', ev => {
    const btn = ev.target.closest('button');
    if (!btn || btn.disabled) return;
    if (btn.id === 'compete-seek-cancel-btn') { competeCancelSeek(); return; }
    if (btn.dataset.accept) { competeAcceptSeek(btn.dataset.accept); return; }
    if (btn.dataset.pool) { competeState.pool = btn.dataset.pool; competeRefreshLeaderboard(); return; }
    if (btn.dataset.follow) { competeFollow(btn.dataset.follow, btn); return; }
    if (btn.dataset.standings) { competeShowStandings(btn.dataset.standings); return; }
    if (btn.dataset.join) { competeJoinArena(btn.dataset.join); }
  });
}

async function competeRefreshAll() {
  await competeRefreshAuth();
  await Promise.all([competeRefreshLobby(), competeRefreshLeaderboard(), competeRefreshArenas()]);
}

function competeStartPolling() {
  if (competeState.timer) return;
  competeState.timer = setInterval(() => {
    if (!competeState.visible || document.hidden) return;
    competeRefreshLobby();
  }, COMPETE_POLL_MS);
}

function competeStopPolling() {
  if (competeState.timer) { clearInterval(competeState.timer); competeState.timer = null; }
}

function initCompeteView() {
  if (typeof window === 'undefined' || !window.Shell || typeof window.Shell.registerView !== 'function') return;
  window.Shell.registerView({
    id: 'compete',
    title: 'Compete',
    order: 50,
    nav: true,
    mount(el) {
      competeState.el = el;
      competeInjectStyles();
      competeRenderSkeleton(el);
      competeBindEvents(el);
    },
    show(el, params) {
      competeState.visible = true;
      if (params && params.pool && COMPETE_POOLS.includes(params.pool)) competeState.pool = params.pool;
      if (params && params.arena) competeState.arenaId = String(params.arena);
      competeRefreshAll();
      competeStartPolling();
    },
    hide() {
      competeState.visible = false;
      competeStopPolling();
    }
  });
}

initCompeteView();
