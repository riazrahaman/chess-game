// ui-profile.js — Wave 2 (roadmap R2): the Profile view (#/me).
//
// Signed-in card (sign-in itself stays in ui-auth.js / #account-bar), ratings
// per pool with a provisional badge (RD > 110), recent games from /api/games,
// friends/followers from /api/social/*, and a "Sign in to get rated" empty
// state for guests. Pure display layer over server-reported data.
// Registers with the shell via Shell.registerView({ id: 'me', ... }).

'use strict';

const profileState = { el: null, user: null, visible: false };

function profileEsc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function profileFetch(path, options) {
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

function profileInjectStyles() {
  if (document.getElementById('profile-styles')) return;
  const style = document.createElement('style');
  style.id = 'profile-styles';
  style.textContent = `
    .profile-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-top: 12px; }
    .profile-panel { border: 1px solid var(--panel-border); border-radius: 10px; background: var(--panel-bg); padding: 14px 16px; min-width: 0; }
    .profile-panel h3 { margin: 0 0 8px; font-size: 1.05rem; }
    .profile-card { display: flex; align-items: center; gap: 12px; }
    .profile-avatar { width: 48px; height: 48px; border-radius: 50%; background: var(--accent, #2563eb); color: #fff; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 1.2rem; object-fit: cover; }
    .profile-empty { color: var(--muted); font-size: 0.9rem; padding: 8px 0; }
    .profile-panel table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    .profile-panel th, .profile-panel td { text-align: left; padding: 6px 4px; border-bottom: 1px solid var(--panel-border); }
    .profile-panel th { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
    .profile-badge { display: inline-block; font-size: 0.7rem; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--panel-border); color: var(--muted); margin-left: 6px; }
    .profile-rating { font-size: 1.4rem; font-weight: 700; }
    .profile-pools { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; }
    .profile-pool { border: 1px solid var(--panel-border); border-radius: 8px; padding: 8px 10px; }
    .profile-pool small { display: block; color: var(--muted); text-transform: capitalize; }
    .profile-form { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .profile-form input { flex: 1 1 140px; min-height: 36px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--panel-border); background: var(--panel-bg); color: var(--text-color); }
    .profile-panel button { min-height: 36px; padding: 6px 12px; }
    .profile-cta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
    .profile-status { font-size: 0.85rem; color: var(--muted); min-height: 1.2em; margin-top: 6px; }
  `;
  document.head.appendChild(style);
}

function profileRenderSkeleton(el) {
  el.innerHTML = `
    <h2 id="profile-title">Profile</h2>
    <div id="profile-card" class="profile-panel"></div>
    <div class="profile-grid" id="profile-body"></div>`;
}

function profileOpenSignIn() {
  if (typeof window.openAuthModal === 'function') { window.openAuthModal(); return; }
  const btn = document.getElementById('auth-sign-in-btn');
  if (btn) btn.click();
}

function profileRenderGuest() {
  const card = document.getElementById('profile-card');
  const body = document.getElementById('profile-body');
  if (!card || !body) return;
  card.innerHTML = `
    <div class="profile-card">
      <span class="profile-avatar" aria-hidden="true">?</span>
      <div>
        <strong>You are playing as a guest</strong>
        <p class="profile-empty" style="margin:2px 0 0;">Sign in to get rated. Guest and bot games are never rated; games between two signed-in players are rated per time control.</p>
        <div class="profile-cta">
          <button type="button" id="profile-sign-in-btn">Sign in</button>
          <a href="#/compete"><button type="button">Browse the lobby</button></a>
        </div>
      </div>
    </div>`;
  body.innerHTML = `
    <section class="profile-panel"><h3>Ratings</h3><p class="profile-empty">Sign in to get rated. Your Glicko-2 rating per pool (bullet, blitz, rapid, classical) appears here after your first rated game.</p></section>
    <section class="profile-panel"><h3>Recent games</h3><p class="profile-empty">Games saved to the archive under your username will be listed here.</p></section>
    <section class="profile-panel"><h3>Friends</h3><p class="profile-empty">Follow players from the leaderboard; mutual follows become friends.</p></section>`;
}

function profileAvatar(user) {
  if (user.picture) return `<img class="profile-avatar" src="${profileEsc(user.picture)}" alt="">`;
  return `<span class="profile-avatar" aria-hidden="true">${profileEsc((user.username || '?').charAt(0).toUpperCase())}</span>`;
}

function profileRenderUserCard(user, ratings) {
  const card = document.getElementById('profile-card');
  if (!card) return;
  const best = (ratings || []).slice().sort((a, b) => b.rating - a.rating)[0];
  card.innerHTML = `
    <div class="profile-card">
      ${profileAvatar(user)}
      <div>
        <strong>${profileEsc(user.username)}</strong>
        ${user.authProvider ? `<span class="profile-badge">${profileEsc(user.authProvider)}</span>` : ''}
        <p class="profile-empty" style="margin:2px 0 0;">${best ? `Best pool: ${profileEsc(best.pool)} ${profileEsc(best.rating)}${best.provisional ? ' (provisional)' : ''}` : 'Unrated — play a rated game from the lobby to get a rating.'}</p>
        <div class="profile-cta"><a href="#/compete"><button type="button">Find a rated game</button></a></div>
      </div>
    </div>`;
}

function profileRenderRatings(payload) {
  const pools = Array.isArray(payload.pools) ? payload.pools : [];
  const all = Array.isArray(payload.allPools) ? payload.allPools : ['bullet', 'blitz', 'rapid', 'classical'];
  if (!pools.length) {
    return '<p class="profile-empty">No rated games yet. Ratings start at 1500 ± 350 and are provisional until the rating deviation drops below 110.</p>';
  }
  const byPool = {};
  pools.forEach(p => { byPool[p.pool] = p; });
  return `<div class="profile-pools">${all.filter(p => p !== 'ultrabullet' || byPool[p]).map(pool => {
    const r = byPool[pool];
    return `<div class="profile-pool"><small>${profileEsc(pool)}</small>${r
      ? `<span class="profile-rating">${profileEsc(r.rating)}</span> <span class="profile-badge" title="Rating deviation">±${profileEsc(r.rd)}</span>${r.provisional ? '<span class="profile-badge" title="RD above 110">provisional</span>' : ''}`
      : '<span class="profile-empty">unrated</span>'}</div>`;
  }).join('')}</div>`;
}

function profileGameResultFor(game, username) {
  const white = String(game.white || '').toLowerCase() === String(username).toLowerCase();
  const result = game.result || '*';
  if (result === '1/2-1/2' || result === '½-½') return 'draw';
  if (result === '1-0') return white ? 'win' : 'loss';
  if (result === '0-1') return white ? 'loss' : 'win';
  return 'unfinished';
}

function profileRenderGames(games, username) {
  if (!games.length) return '<p class="profile-empty">No archived games under your username yet. Finished games saved from the board appear here.</p>';
  return `<table><thead><tr><th>Date</th><th>White</th><th>Black</th><th>Result</th></tr></thead><tbody>
    ${games.slice(0, 10).map(g => {
      const when = g.date || (g.createdAt ? new Date(g.createdAt).toISOString().slice(0, 10) : '');
      const outcome = profileGameResultFor(g, username);
      return `<tr><td>${profileEsc(when)}</td><td>${profileEsc(g.white)}</td><td>${profileEsc(g.black)}</td><td>${profileEsc(g.result || '*')}<span class="profile-badge">${outcome}</span></td></tr>`;
    }).join('')}</tbody></table>`;
}

function profileBuildGraph(me, followers, following) {
  // social-graph.js (loaded in the page) derives friendship from the two
  // server-reported edge lists; no fabricated relationships.
  if (!window.SocialGraph || typeof window.SocialGraph.SocialGraph !== 'function') return null;
  const graph = new window.SocialGraph.SocialGraph();
  following.forEach(u => graph.follow(me, String(u.id)));
  followers.forEach(u => graph.follow(String(u.id), me));
  return graph;
}

function profileRenderSocial(me, social) {
  const followers = Array.isArray(social.followers) ? social.followers : [];
  const following = Array.isArray(social.following) ? social.following : [];
  const graph = profileBuildGraph(me, followers, following);
  const friendIds = new Set(graph ? graph.mutualFriends(me) : []);
  const names = {};
  followers.concat(following).forEach(u => { names[String(u.id)] = u.username; });
  const list = (ids, emptyText, actions) => ids.length
    ? `<ul style="list-style:none; padding:0; margin:0;">${ids.map(id => `<li style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:4px 0; border-bottom:1px solid var(--panel-border);"><span>${profileEsc(names[id] || id)}${friendIds.has(id) ? '<span class="profile-badge">friend</span>' : ''}</span>${actions ? actions(id) : ''}</li>`).join('')}</ul>`
    : `<p class="profile-empty">${emptyText}</p>`;
  const followingIds = following.map(u => String(u.id));
  const followerIds = followers.map(u => String(u.id));
  return `
    <h4 style="margin:8px 0 4px;">Friends <span class="profile-badge">${friendIds.size}</span></h4>
    ${list(Array.from(friendIds), 'No mutual follows yet.')}
    <h4 style="margin:12px 0 4px;">Following <span class="profile-badge">${followingIds.length}</span></h4>
    ${list(followingIds, 'You are not following anyone.', id => `<button type="button" data-unfollow="${profileEsc(id)}">Unfollow</button>`)}
    <h4 style="margin:12px 0 4px;">Followers <span class="profile-badge">${followerIds.length}</span></h4>
    ${list(followerIds, 'Nobody follows you yet.', id => friendIds.has(id) ? '' : `<button type="button" data-follow="${profileEsc(id)}">Follow back</button>`)}
    <form id="profile-follow-form" class="profile-form" autocomplete="off">
      <label class="sr-only" for="profile-follow-name">Follow a player by username</label>
      <input id="profile-follow-name" type="text" maxlength="40" placeholder="Follow by username">
      <button type="submit">Follow</button>
    </form>
    <div id="profile-social-status" class="profile-status" role="status" aria-live="polite"></div>`;
}

async function profileRenderSignedIn(user) {
  const body = document.getElementById('profile-body');
  if (!body) return;
  const [ratings, games, social] = await Promise.all([
    profileFetch('/api/ratings/me'),
    profileFetch('/api/games?white=' + encodeURIComponent(user.username) + '&limit=10'),
    profileFetch('/api/social/followers')
  ]);
  let gamesList = Array.isArray(games.body.games) ? games.body.games : [];
  try {
    const asBlack = await profileFetch('/api/games?black=' + encodeURIComponent(user.username) + '&limit=10');
    const extra = Array.isArray(asBlack.body.games) ? asBlack.body.games : [];
    const seen = new Set(gamesList.map(g => g.id));
    extra.forEach(g => { if (!seen.has(g.id)) gamesList.push(g); });
    gamesList.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || String(b.date || '').localeCompare(String(a.date || '')));
  } catch (_) { /* white-only list is fine */ }
  profileRenderUserCard(user, ratings.ok ? ratings.body.pools : []);
  body.innerHTML = `
    <section class="profile-panel" aria-labelledby="profile-ratings-title"><h3 id="profile-ratings-title">Ratings</h3>${profileRenderRatings(ratings.ok ? ratings.body : {})}</section>
    <section class="profile-panel" aria-labelledby="profile-games-title"><h3 id="profile-games-title">Recent games</h3>${profileRenderGames(gamesList, user.username)}</section>
    <section class="profile-panel" aria-labelledby="profile-social-title"><h3 id="profile-social-title">Friends &amp; followers</h3>${social.ok ? profileRenderSocial(String(user.id), social.body) : '<p class="profile-empty">Social data unavailable.</p>'}</section>`;
}

async function profileRefresh() {
  let user = null;
  try {
    const res = await profileFetch('/api/auth/me');
    user = res.body && res.body.authenticated ? res.body.user : null;
  } catch (_) { user = null; }
  profileState.user = user;
  if (!user) { profileRenderGuest(); return; }
  await profileRenderSignedIn(user);
}

function profileSetStatus(text) {
  const node = document.getElementById('profile-social-status');
  if (node) node.textContent = text || '';
}

async function profileFollowByName(ev) {
  ev.preventDefault();
  const input = document.getElementById('profile-follow-name');
  const name = input ? input.value.trim() : '';
  if (!name) return;
  const lookup = await profileFetch('/api/social/lookup?username=' + encodeURIComponent(name));
  if (!lookup.ok) { profileSetStatus(lookup.body.error || 'User not found.'); return; }
  const res = await profileFetch('/api/social/follow/' + encodeURIComponent(lookup.body.user.id), { method: 'POST' });
  profileSetStatus(res.ok ? `Now following ${lookup.body.user.username}.` : (res.body.error || 'Could not follow.'));
  if (res.ok) profileRefresh();
}

function profileBindEvents(el) {
  el.addEventListener('click', async ev => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    if (btn.id === 'profile-sign-in-btn') { profileOpenSignIn(); return; }
    if (btn.dataset.follow) {
      await profileFetch('/api/social/follow/' + encodeURIComponent(btn.dataset.follow), { method: 'POST' });
      profileRefresh();
    } else if (btn.dataset.unfollow) {
      await profileFetch('/api/social/unfollow/' + encodeURIComponent(btn.dataset.unfollow), { method: 'POST' });
      profileRefresh();
    }
  });
  el.addEventListener('submit', ev => {
    if (ev.target.id === 'profile-follow-form') profileFollowByName(ev);
  });
}

function initProfileView() {
  if (typeof window === 'undefined' || !window.Shell || typeof window.Shell.registerView !== 'function') return;
  window.Shell.registerView({
    id: 'me',
    title: 'Profile',
    order: 60,
    nav: true,
    mount(el) {
      profileState.el = el;
      profileInjectStyles();
      profileRenderSkeleton(el);
      profileBindEvents(el);
    },
    show() {
      profileState.visible = true;
      profileRefresh();
    },
    hide() {
      profileState.visible = false;
    }
  });
}

initProfileView();
