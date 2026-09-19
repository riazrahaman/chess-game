// ui-retention.js — Wave 3 (roadmap §6 Tier N2 items 7 + 9): streak badge,
// Home streak line, and the Profile streak card + achievements panel.
//
// Not a view. Pure display layer over GET /api/streak and GET /api/achievements
// (every read is cache:'no-store' and timestamp-busted past the service
// worker). Guests see nothing. Coordinates with other modules through the DOM
// only: #account-bar (ui-auth.js markup), #home-streak (index.html), and the
// #profile-retention mount point that ui-profile.js renders in its skeleton.
// Other modules may call window.Retention.refresh() after an activity.

'use strict';

(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const state = { streak: null, achievements: null, guest: true, timer: null, inflight: null };
  const REFRESH_MS = 60000;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function getJson(path) {
    const url = path + (path.includes('?') ? '&' : '?') + '_t=' + Date.now();
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    let json = null;
    try { json = await res.json(); } catch (_) { json = null; }
    return { ok: res.ok, status: res.status, body: json || {} };
  }

  function injectStyles() {
    if (document.getElementById('retention-styles')) return;
    const style = document.createElement('style');
    style.id = 'retention-styles';
    style.textContent = `
      #streak-badge { display: inline-flex; align-items: center; gap: 3px; margin-left: 6px; padding: 0 7px; border-radius: 999px; font-size: 0.75rem; font-weight: 700; line-height: 18px; background: rgba(249, 115, 22, 0.14); color: #c2410c; border: 1px solid rgba(249, 115, 22, 0.35); }
      #streak-badge[data-status="at-risk"] { background: rgba(234, 179, 8, 0.16); color: #a16207; border-color: rgba(234, 179, 8, 0.45); }
      #streak-badge[data-status="broken"] { background: transparent; color: var(--muted); border-color: var(--panel-border); }
      #streak-badge[data-status="broken"] .streak-flame { filter: grayscale(1); opacity: 0.6; }
      body[data-mode="dark"] #streak-badge { color: #fdba74; }
      body[data-mode="dark"] #streak-badge[data-status="at-risk"] { color: #fde047; }
      #home-streak { margin-top: 14px; padding: 10px 14px; border: 1px solid var(--panel-border); border-radius: 10px; background: var(--panel-bg); font-size: 0.95rem; }
      #home-streak[data-status="at-risk"] { border-color: rgba(234, 179, 8, 0.6); }
      #home-streak[hidden] { display: none; }
      .retention-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-top: 12px; }
      .retention-panel { border: 1px solid var(--panel-border); border-radius: 10px; background: var(--panel-bg); padding: 14px 16px; min-width: 0; }
      .retention-panel h3 { margin: 0 0 8px; font-size: 1.05rem; }
      .retention-streak-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
      .retention-count { font-size: 2rem; font-weight: 700; line-height: 1; }
      .retention-status { display: inline-block; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--panel-border); color: var(--muted); }
      .retention-status[data-status="active"] { color: #15803d; border-color: rgba(21, 128, 61, 0.5); }
      .retention-status[data-status="at-risk"] { color: #a16207; border-color: rgba(234, 179, 8, 0.6); }
      .retention-muted { color: var(--muted); font-size: 0.88rem; margin: 6px 0 0; }
      .retention-days { display: flex; gap: 4px; margin-top: 10px; flex-wrap: wrap; }
      .retention-day { width: 14px; height: 14px; border-radius: 3px; background: var(--panel-border); }
      .retention-day[data-active="1"] { background: #f97316; }
      .retention-day[data-today="1"] { outline: 2px solid var(--accent, #2563eb); outline-offset: 1px; }
      .retention-badges { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
      .retention-badge { border: 1px solid var(--panel-border); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; min-height: 44px; }
      .retention-badge[data-awarded="0"] { opacity: 0.55; }
      .retention-badge[data-awarded="0"] .retention-badge-icon { filter: grayscale(1); }
      .retention-badge-icon { font-size: 1.3rem; line-height: 1.2; }
      .retention-badge strong { font-size: 0.9rem; }
      .retention-badge small { color: var(--muted); font-size: 0.75rem; }
    `;
    document.head.appendChild(style);
  }

  // ------------------------------------------------------------- copy helpers
  function dayWord(n) { return n === 1 ? 'day' : 'days'; }

  function streakLine(streak) {
    if (!streak) return '';
    const n = streak.current || 0;
    if (streak.status === 'broken' || n === 0) return '🔥 Start a streak — finish a game, solve a puzzle or analyse one today.';
    if (streak.status === 'at-risk') {
      const left = streak.daysUntilReset;
      return `🔥 ${n}-${dayWord(n)} streak at risk — play today to keep it (resets in ${left} ${dayWord(left)}).`;
    }
    if (streak.activeToday) return `🔥 ${n}-${dayWord(n)} streak — done for today. See you tomorrow.`;
    return `🔥 ${n}-${dayWord(n)} streak — play today to keep it.`;
  }

  function badgeTitle(streak) {
    if (!streak) return '';
    if (streak.status === 'broken' || !streak.current) return 'No active streak. Any finished game, puzzle or analysis today starts one.';
    if (streak.status === 'at-risk') return `${streak.current}-${dayWord(streak.current)} streak at risk: play today (resets in ${streak.daysUntilReset} ${dayWord(streak.daysUntilReset)}).`;
    return `${streak.current}-${dayWord(streak.current)} activity streak${streak.activeToday ? ' — active today' : ' — play today to keep it'}. Longest: ${streak.longest}.`;
  }

  // ------------------------------------------------------------------ renders
  function renderBadge() {
    const existing = document.getElementById('streak-badge');
    if (state.guest || !state.streak) { if (existing) existing.remove(); return; }
    const bar = document.getElementById('account-bar');
    if (!bar) return;
    const anchor = document.getElementById('account-username');
    const host = anchor && anchor.parentElement ? anchor.parentElement : bar;
    const badge = existing || document.createElement('span');
    badge.id = 'streak-badge';
    badge.setAttribute('role', 'status');
    badge.dataset.status = state.streak.status;
    badge.dataset.count = String(state.streak.current || 0);
    badge.title = badgeTitle(state.streak);
    badge.setAttribute('aria-label', badge.title);
    badge.innerHTML = `<span class="streak-flame" aria-hidden="true">🔥</span><span class="streak-count">${esc(state.streak.current || 0)}</span>`;
    if (!existing) {
      if (anchor && anchor.nextSibling) host.insertBefore(badge, anchor.nextSibling);
      else host.appendChild(badge);
    }
  }

  function renderHome() {
    const el = document.getElementById('home-streak');
    if (!el) return;
    if (state.guest || !state.streak) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.dataset.status = state.streak.status;
    el.textContent = streakLine(state.streak);
  }

  function renderDays(activityDays, lastActiveDay) {
    const active = new Set((activityDays || []).map(d => d.day));
    const today = new Date().toISOString().slice(0, 10);
    const cells = [];
    for (let i = 13; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      cells.push(`<span class="retention-day" data-active="${active.has(day) ? 1 : 0}" data-today="${day === today ? 1 : 0}" title="${esc(day)}${active.has(day) ? ' — active' : ''}"></span>`);
    }
    return `<div class="retention-days" aria-label="Last 14 days${lastActiveDay ? ', last active ' + esc(lastActiveDay) : ''}">${cells.join('')}</div>`;
  }

  function renderProfile(attempt) {
    const host = document.getElementById('profile-retention');
    if (!host) {
      // ui-profile.js renders its skeleton in mount(); it may land a frame later.
      if ((attempt || 0) < 5) requestAnimationFrame(() => renderProfile((attempt || 0) + 1));
      return;
    }
    if (state.guest || !state.streak) { host.innerHTML = ''; host.hidden = true; return; }
    host.hidden = false;
    const s = state.streak;
    const statusLabel = s.status === 'at-risk' ? 'at risk' : s.status;
    const catalogue = state.achievements && Array.isArray(state.achievements.catalogue) ? state.achievements.catalogue : [];
    const awardedCount = catalogue.filter(a => a.awarded).length;
    host.innerHTML = `
      <div class="retention-grid">
        <section class="retention-panel" id="profile-streak-card" aria-labelledby="profile-streak-title">
          <h3 id="profile-streak-title">Activity streak</h3>
          <div class="retention-streak-head">
            <span class="retention-count">🔥 ${esc(s.current || 0)}</span>
            <span class="retention-status" data-status="${esc(s.status)}">${esc(statusLabel)}</span>
            <span class="retention-muted">longest ${esc(s.longest || 0)}</span>
          </div>
          <p class="retention-muted">${esc(streakLine(s).replace(/^🔥 /, ''))}</p>
          ${renderDays(state.streakDays, s.lastActiveDay)}
          <p class="retention-muted">Counts once per day (UTC): a finished game, a puzzle attempt or review, or an engine analysis. One idle day pauses the streak; it resets after three.</p>
        </section>
        <section class="retention-panel" id="profile-achievements" aria-labelledby="profile-achievements-title">
          <h3 id="profile-achievements-title">Achievements <span class="retention-status">${awardedCount} / ${catalogue.length}</span></h3>
          ${catalogue.length ? `<ul class="retention-badges">${catalogue.map(a => `
            <li class="retention-badge" data-achievement="${esc(a.id)}" data-awarded="${a.awarded ? 1 : 0}" title="${esc(a.description)}${a.awardedAt ? ' — earned ' + esc(new Date(a.awardedAt).toISOString().slice(0, 10)) : ''}">
              <span class="retention-badge-icon" aria-hidden="true">${esc(a.icon)}</span>
              <strong>${esc(a.title)}</strong>
              <small>${a.awarded ? 'Earned ' + esc(new Date(a.awardedAt).toISOString().slice(0, 10)) : esc(a.description)}</small>
            </li>`).join('')}</ul>` : '<p class="retention-muted">Achievements unavailable.</p>'}
        </section>
      </div>`;
  }

  function renderAll() {
    renderBadge();
    renderHome();
    if (window.Shell && window.Shell.current && window.Shell.current() === 'me') renderProfile();
  }

  // ------------------------------------------------------------------ refresh
  async function refresh() {
    if (state.inflight) return state.inflight;
    state.inflight = (async () => {
      try {
        const streak = await getJson('/api/streak');
        if (!streak.ok || streak.body.guest) {
          state.guest = true; state.streak = null; state.achievements = null; state.streakDays = [];
        } else {
          state.guest = false;
          state.streak = streak.body.streak;
          state.streakDays = streak.body.activityDays || [];
          const ach = await getJson('/api/achievements');
          state.achievements = ach.ok && !ach.body.guest ? ach.body : null;
        }
      } catch (_) {
        // Network hiccup: keep whatever we last rendered.
      } finally {
        state.inflight = null;
      }
      renderAll();
      return state;
    })();
    return state.inflight;
  }

  function scheduleTimer() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  }

  function init() {
    injectStyles();
    // ui-auth.js has no sign-in event: wrap its updateAuthUI(user) so a sign-in
    // or sign-out re-reads the streak immediately.
    if (typeof window.updateAuthUI === 'function' && !window.updateAuthUI.__retentionWrapped) {
      const original = window.updateAuthUI;
      const wrapped = function (user) {
        const out = original.apply(this, arguments);
        if (!user) { state.guest = true; state.streak = null; state.achievements = null; renderAll(); }
        else refresh();
        return out;
      };
      wrapped.__retentionWrapped = true;
      window.updateAuthUI = wrapped;
    }
    if (window.Shell && typeof window.Shell.onChange === 'function') {
      window.Shell.onChange(({ id }) => {
        if (id === 'me') renderProfile();
        refresh();
      });
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    scheduleTimer();
    refresh();
  }

  window.Retention = { refresh, render: renderAll, state };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
