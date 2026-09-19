// ui-insights.js — Wave 3 (roadmap N2.8 + N3.15): the Insights view (#/insights).
//
// League standings block (tier badge, division table, "promotes at week end"
// marker, countdown) from GET /api/league, then a metric x dimension pivot from
// GET /api/insights rendered as an inline SVG bar chart + table (no chart
// libraries). Pure display layer over server-reported data; every fetch is
// cache:'no-store' with a timestamp so the cache-first service worker never
// serves stale insights. Deep link: #/insights?metric=acpl&dimension=phase.
// Registers with the shell via Shell.registerView({ id: 'insights', ... }).

'use strict';

const insightsState = { el: null, user: null, visible: false, catalogue: null, params: {}, countdownTimer: null, weekEndsAt: null };

function insightsEsc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function insightsFetch(path, options) {
  const opts = Object.assign({ credentials: 'include', cache: 'no-store' }, options || {});
  if (opts.body && typeof opts.body !== 'string') {
    opts.body = JSON.stringify(opts.body);
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  }
  const url = (!opts.method || opts.method === 'GET') ? path + (path.includes('?') ? '&' : '?') + '_t=' + Date.now() : path;
  const res = await fetch(url, opts);
  let json = null;
  try { json = await res.json(); } catch (_) { json = null; }
  return { ok: res.ok, status: res.status, body: json || {} };
}

function insightsInjectStyles() {
  if (document.getElementById('insights-styles')) return;
  const style = document.createElement('style');
  style.id = 'insights-styles';
  style.textContent = `
    .insights-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-top: 12px; }
    .insights-panel { border: 1px solid var(--panel-border); border-radius: 10px; background: var(--panel-bg); padding: 14px 16px; min-width: 0; color: var(--text-color); }
    .insights-panel h3 { margin: 0 0 8px; font-size: 1.05rem; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .insights-wide { grid-column: 1 / -1; }
    .insights-empty { color: var(--muted, #666); font-size: 0.9rem; padding: 8px 0; }
    .insights-panel table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    .insights-panel th, .insights-panel td { text-align: left; padding: 6px 4px; border-bottom: 1px solid var(--panel-border); }
    .insights-panel th { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted, #666); }
    .insights-panel td.num, .insights-panel th.num { text-align: right; font-variant-numeric: tabular-nums; }
    .insights-badge { display: inline-block; font-size: 0.7rem; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--panel-border); color: var(--muted, #666); }
    .insights-tier { display: inline-block; font-weight: 700; padding: 2px 10px; border-radius: 999px; background: var(--accent, #2563eb); color: #fff; font-size: 0.85rem; }
    .insights-promote { color: var(--accent, #2563eb); font-weight: 600; }
    .insights-row-me td { font-weight: 700; }
    .insights-row-promotes td:first-child { border-left: 3px solid var(--accent, #2563eb); }
    .insights-controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 8px 0; }
    .insights-controls label { font-size: 0.8rem; color: var(--muted, #666); display: flex; flex-direction: column; gap: 2px; }
    .insights-controls select, .insights-controls input { min-height: 36px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--panel-border); background: var(--panel-bg); color: var(--text-color); font: inherit; }
    .insights-chips { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0 10px; }
    .insights-chip { border: 1px solid var(--panel-border); border-radius: 999px; padding: 4px 10px; font-size: 0.8rem; background: transparent; color: var(--text-color); cursor: pointer; min-height: 32px; }
    .insights-chip[aria-pressed="true"] { background: var(--accent, #2563eb); color: #fff; border-color: var(--accent, #2563eb); }
    .insights-chart { width: 100%; height: auto; display: block; margin: 8px 0 12px; }
    .insights-chart .bar { fill: var(--accent, #2563eb); }
    .insights-chart .bar-draw { fill: var(--muted, #888); }
    .insights-chart .bar-loss { fill: #c0504d; }
    .insights-chart text { fill: var(--text-color); font-size: 11px; }
    .insights-chart .axis { stroke: var(--panel-border); }
    .insights-note { font-size: 0.8rem; color: var(--muted, #666); margin: 4px 0 0; }
    .insights-status { font-size: 0.85rem; color: var(--muted, #666); min-height: 1.2em; margin-top: 6px; }
    .insights-cta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
    .insights-panel button.insights-btn { min-height: 36px; padding: 6px 12px; }
    .insights-countdown { font-variant-numeric: tabular-nums; }
  `;
  document.head.appendChild(style);
}

function insightsRenderSkeleton(el) {
  el.innerHTML = `
    <h2 id="insights-title">Insights</h2>
    <div class="insights-grid">
      <section class="insights-panel insights-wide" id="insights-league" aria-labelledby="insights-league-title"><h3 id="insights-league-title">Weekly league</h3><p class="insights-empty">Loading…</p></section>
      <section class="insights-panel insights-wide" id="insights-pivot" aria-labelledby="insights-pivot-title"><h3 id="insights-pivot-title">Your game insights</h3><div id="insights-controls"></div><div id="insights-body"><p class="insights-empty">Loading…</p></div></section>
    </div>`;
}

function insightsOpenSignIn() {
  if (typeof window.openAuthModal === 'function') { window.openAuthModal(); return; }
  const btn = document.getElementById('auth-sign-in-btn');
  if (btn) btn.click();
}

function insightsGuestMarkup(text) {
  return `<p class="insights-empty">${insightsEsc(text)}</p>
    <div class="insights-cta"><button type="button" class="insights-btn" id="insights-sign-in-btn">Sign in</button></div>`;
}

// ---------------------------------------------------------------------------
// League block
// ---------------------------------------------------------------------------
function insightsFormatCountdown(ms) {
  if (!(ms > 0)) return 'closing now';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  const sec = s % 60;
  return `${h}h ${m}m ${String(sec).padStart(2, '0')}s`;
}

function insightsTickCountdown() {
  const node = document.getElementById('insights-countdown');
  if (!node || !insightsState.weekEndsAt) return;
  node.textContent = insightsFormatCountdown(insightsState.weekEndsAt - Date.now());
}

function insightsRenderLeague(data) {
  const panel = document.getElementById('insights-league');
  if (!panel) return;
  insightsState.weekEndsAt = data.weekEndsAt || null;
  const tiers = Array.isArray(data.tiers) ? data.tiers : [];
  const tierIdx = tiers.indexOf(data.tier);
  const header = `<h3 id="insights-league-title">Weekly league
      <span class="insights-tier">${insightsEsc(data.tier || 'Wood')}</span>
      <span class="insights-badge">${insightsEsc(data.week)}</span>
      <span class="insights-badge">ends in <span id="insights-countdown" class="insights-countdown">${insightsEsc(insightsFormatCountdown((data.weekEndsAt || 0) - Date.now()))}</span></span>
    </h3>`;
  if (!data.enrolled || !data.standings) {
    panel.innerHTML = header + `<p class="insights-empty">Not enrolled this week yet. Finish a rated game (signed-in, human vs human) to join a ${insightsEsc(data.tier || 'Wood')} division. Top 20% promote at week end; nobody relegates.</p>
      <p class="insights-note">Tiers: ${tiers.map((t, i) => i === tierIdx ? `<strong>${insightsEsc(t)}</strong>` : insightsEsc(t)).join(' → ')}</p>`;
    return;
  }
  const st = data.standings;
  const rows = st.rows.map(r => {
    const cls = [r.playerId === (insightsState.user && String(insightsState.user.id)) ? 'insights-row-me' : '', r.promotes ? 'insights-row-promotes' : ''].filter(Boolean).join(' ');
    return `<tr class="${cls}"><td class="num">${r.rank}</td><td>${insightsEsc(r.username)}${r.promotes ? ` <span class="insights-promote" title="Promotes to ${insightsEsc(st.nextTier || '')} at week end">▲ promotes</span>` : ''}</td><td class="num">${r.points}</td><td class="num">${r.wins}</td><td class="num">${r.draws}</td><td class="num">${r.losses}</td></tr>`;
  }).join('');
  panel.innerHTML = header + `
    <p class="insights-note">Division <strong>${insightsEsc(st.divisionId)}</strong> · ${st.size}/${st.capacity} players · top ${st.promoteCount} promote to ${insightsEsc(st.nextTier || '—')} at week end${st.closed ? ' · <strong>closed</strong>' : ''}. Win 1 · draw ½ · loss 0.</p>
    <div style="overflow-x:auto"><table aria-label="Division standings"><thead><tr><th class="num">#</th><th>Player</th><th class="num">Pts</th><th class="num">W</th><th class="num">D</th><th class="num">L</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function insightsLoadLeague() {
  const panel = document.getElementById('insights-league');
  if (!panel) return;
  const res = await insightsFetch('/api/league');
  if (res.status === 401) {
    panel.innerHTML = `<h3 id="insights-league-title">Weekly league</h3>` + insightsGuestMarkup('Sign in and play rated games to join a weekly league.');
    return;
  }
  if (!res.ok) { panel.innerHTML = `<h3 id="insights-league-title">Weekly league</h3><p class="insights-empty">League unavailable (${res.status}).</p>`; return; }
  insightsRenderLeague(res.body);
}

// ---------------------------------------------------------------------------
// Pivot controls
// ---------------------------------------------------------------------------
const INSIGHTS_CHIPS = [
  { group: 'color', value: 'white', label: 'As White' },
  { group: 'color', value: 'black', label: 'As Black' },
  { group: 'opponent', value: 'human', label: 'vs humans' },
  { group: 'opponent', value: 'bot', label: 'vs bots' }
];

function insightsRenderControls() {
  const host = document.getElementById('insights-controls');
  if (!host || !insightsState.catalogue) return;
  const p = insightsState.params;
  const cat = insightsState.catalogue;
  const metricOpts = cat.metrics.map(m => `<option value="${insightsEsc(m.id)}" ${m.id === p.metric ? 'selected' : ''} ${m.available ? '' : 'disabled'}>${insightsEsc(m.label)}${m.available ? '' : ' (unavailable)'}</option>`).join('');
  const metric = cat.metrics.find(m => m.id === p.metric) || cat.metrics[0];
  const dims = cat.dimensions.filter(d => !metric || !metric.available || metric.dimensions.includes(d.id));
  const dimOpts = dims.map(d => `<option value="${insightsEsc(d.id)}" ${d.id === p.dimension ? 'selected' : ''}>${insightsEsc(d.label)}</option>`).join('');
  const chips = INSIGHTS_CHIPS.map(c => `<button type="button" class="insights-chip" data-group="${c.group}" data-value="${c.value}" aria-pressed="${p[c.group] === c.value ? 'true' : 'false'}">${insightsEsc(c.label)}</button>`).join('');
  host.innerHTML = `
    <div class="insights-controls">
      <label>Metric <select id="insights-metric" aria-label="Metric">${metricOpts}</select></label>
      <label>By <select id="insights-dimension" aria-label="Dimension">${dimOpts}</select></label>
      <label>From <input type="date" id="insights-from" value="${insightsEsc(p.from || '')}"></label>
      <label>To <input type="date" id="insights-to" value="${insightsEsc(p.to || '')}"></label>
      <label>Time control <input type="text" id="insights-tc" placeholder="e.g. 180+2" size="8" value="${insightsEsc(p.tc || '')}"></label>
    </div>
    <div class="insights-chips" role="group" aria-label="Filters">${chips}</div>`;
}

function insightsReadControls() {
  const p = insightsState.params;
  const get = id => { const n = document.getElementById(id); return n ? n.value.trim() : ''; };
  p.metric = get('insights-metric') || p.metric || 'results';
  p.dimension = get('insights-dimension') || p.dimension || 'all';
  p.from = get('insights-from'); p.to = get('insights-to'); p.tc = get('insights-tc');
  Object.keys(p).forEach(k => { if (!p[k]) delete p[k]; });
}

function insightsSyncHash() {
  if (!window.Shell || typeof window.Shell.navigate !== 'function') return;
  const clean = {};
  for (const [k, v] of Object.entries(insightsState.params)) if (v) clean[k] = v;
  window.Shell.navigate('insights', clean);
}

// ---------------------------------------------------------------------------
// Chart + table
// ---------------------------------------------------------------------------
function insightsBarChart(data) {
  const buckets = data.buckets || [];
  if (!buckets.length) return '';
  const stacked = data.metric === 'results';
  const width = 640;
  const barH = 22;
  const gap = 8;
  const labelW = 150;
  const height = buckets.length * (barH + gap) + 24;
  const plotW = width - labelW - 60;
  const max = stacked ? 100 : Math.max(1, ...buckets.map(b => Number(b.value) || 0));
  const rows = buckets.map((b, i) => {
    const y = 12 + i * (barH + gap);
    const label = String(b.label).length > 22 ? String(b.label).slice(0, 21) + '…' : b.label;
    let bars;
    if (stacked) {
      const w1 = plotW * (b.winPct / 100), w2 = plotW * (b.drawPct / 100), w3 = plotW * (b.lossPct / 100);
      bars = `<rect class="bar" x="${labelW}" y="${y}" width="${w1.toFixed(1)}" height="${barH}" rx="3"><title>${insightsEsc(b.label)}: ${b.wins} wins (${b.winPct}%)</title></rect>
        <rect class="bar-draw" x="${(labelW + w1).toFixed(1)}" y="${y}" width="${w2.toFixed(1)}" height="${barH}"><title>${b.draws} draws (${b.drawPct}%)</title></rect>
        <rect class="bar-loss" x="${(labelW + w1 + w2).toFixed(1)}" y="${y}" width="${w3.toFixed(1)}" height="${barH}" rx="3"><title>${b.losses} losses (${b.lossPct}%)</title></rect>`;
    } else {
      const v = Number(b.value) || 0;
      const w = plotW * (v / max);
      bars = `<rect class="bar" x="${labelW}" y="${y}" width="${w.toFixed(1)}" height="${barH}" rx="3"><title>${insightsEsc(b.label)}: ${b.value == null ? '—' : b.value} ${insightsEsc(data.unit)}</title></rect>`;
    }
    const valueText = stacked ? `${b.winPct}% / ${b.drawPct}% / ${b.lossPct}%` : (b.value == null ? '—' : `${b.value} ${data.unit}`);
    return `<g>${bars}<text x="${labelW - 6}" y="${y + barH / 2 + 4}" text-anchor="end">${insightsEsc(label)}</text><text x="${width - 4}" y="${y + barH / 2 + 4}" text-anchor="end" font-size="10">${insightsEsc(valueText)}</text><text x="${labelW + 4}" y="${y + barH / 2 + 4}" font-size="10" style="fill:#fff">n=${b.count}</text></g>`;
  }).join('');
  return `<svg class="insights-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${insightsEsc(data.metricLabel)} by ${insightsEsc(data.dimensionLabel)}">
    <line class="axis" x1="${labelW}" y1="6" x2="${labelW}" y2="${height - 6}" />${rows}</svg>`;
}

function insightsTable(data) {
  const buckets = data.buckets || [];
  if (data.metric === 'results') {
    return `<table><thead><tr><th>${insightsEsc(data.dimensionLabel)}</th><th class="num">Games</th><th class="num">W</th><th class="num">D</th><th class="num">L</th><th class="num">Win %</th><th class="num">Score %</th></tr></thead><tbody>${buckets.map(b => `<tr><td>${insightsEsc(b.label)}</td><td class="num">${b.count}</td><td class="num">${b.wins}</td><td class="num">${b.draws}</td><td class="num">${b.losses}</td><td class="num">${b.winPct}</td><td class="num">${b.score}</td></tr>`).join('')}</tbody></table>`;
  }
  return `<table><thead><tr><th>${insightsEsc(data.dimensionLabel)}</th><th class="num">Games</th><th class="num">${insightsEsc(data.metricLabel)} (${insightsEsc(data.unit)})</th></tr></thead><tbody>${buckets.map(b => `<tr><td>${insightsEsc(b.label)}</td><td class="num">${b.count}</td><td class="num">${b.value == null ? '—' : b.value}</td></tr>`).join('')}</tbody></table>`;
}

function insightsRenderResult(data) {
  const body = document.getElementById('insights-body');
  if (!body) return;
  const notes = [];
  if (data.scope === 'archive') notes.push('Showing every game in this server\'s archive: games are not yet bound to your account, so this is the whole archive, not just yours.');
  if (data.perspective === 'white') notes.push('Your side is unknown for these games; results are counted from White\'s perspective.');
  else if (data.perspective === 'mixed') notes.push(`${data.unknownColour} game(s) have an unknown side and are counted from White's perspective.`);
  if (data.coverage) notes.push(`ACPL uses cached engine evals: ${data.coverage.gamesWithEvals}/${data.coverage.gamesTotal} games have them.`);
  if (data.compute) notes.push(`Analysed ${data.compute.analysed} game(s), ${data.compute.plies} positions${data.compute.skipped ? ' — ' + data.compute.skipped : ''}.`);
  const scopeBadge = `<span class="insights-badge">scope: ${insightsEsc(data.scope)}</span> <span class="insights-badge">${data.games} game(s)</span>`;
  if (!data.games || !(data.buckets || []).length) {
    body.innerHTML = `<p class="insights-note">${scopeBadge}</p><p class="insights-empty">${data.scope === 'archive' ? 'No games in the archive yet. Finish a game and it appears here.' : 'No games match these filters yet. Play rated games to unlock Insights.'}</p>${notes.map(n => `<p class="insights-note">${insightsEsc(n)}</p>`).join('')}`;
    return;
  }
  const computeBtn = data.metric === 'acpl' && data.coverage && data.coverage.gamesWithEvals < data.coverage.gamesTotal
    ? `<div class="insights-cta"><button type="button" class="insights-btn" id="insights-compute-btn">Analyse recent games (engine, low depth)</button></div>` : '';
  body.innerHTML = `<p class="insights-note">${scopeBadge}</p>${insightsBarChart(data)}<div style="overflow-x:auto">${insightsTable(data)}</div>${notes.map(n => `<p class="insights-note">${insightsEsc(n)}</p>`).join('')}${computeBtn}<div class="insights-status" id="insights-status"></div>`;
}

async function insightsLoadPivot(compute) {
  const body = document.getElementById('insights-body');
  if (!body) return;
  if (!insightsState.catalogue) {
    const cat = await insightsFetch('/api/insights/dimensions');
    if (cat.ok) insightsState.catalogue = cat.body;
  }
  const p = insightsState.params;
  if (!p.metric) p.metric = 'results';
  if (!p.dimension) p.dimension = 'all';
  insightsRenderControls();
  const qs = new URLSearchParams();
  for (const k of ['metric', 'dimension', 'from', 'to', 'color', 'tc', 'opponent']) if (p[k]) qs.set(k, p[k]);
  if (compute) qs.set('compute', '1');
  body.innerHTML = '<p class="insights-empty">Loading…</p>';
  const res = await insightsFetch('/api/insights?' + qs.toString());
  if (res.status === 401) {
    insightsState.user = null;
    body.innerHTML = insightsGuestMarkup('Sign in and play rated games to unlock Insights.');
    return;
  }
  if (!res.ok) { body.innerHTML = `<p class="insights-empty">${insightsEsc(res.body.error || ('Insights unavailable (' + res.status + ')'))}</p>`; return; }
  insightsRenderResult(res.body);
}

async function insightsRefresh() {
  let user = null;
  try {
    const res = await insightsFetch('/api/auth/me');
    user = res.body && res.body.authenticated ? res.body.user : null;
  } catch (_) { user = null; }
  insightsState.user = user;
  if (!user) {
    const league = document.getElementById('insights-league');
    const body = document.getElementById('insights-body');
    const controls = document.getElementById('insights-controls');
    if (controls) controls.innerHTML = '';
    if (league) league.innerHTML = `<h3 id="insights-league-title">Weekly league</h3>` + insightsGuestMarkup('Sign in and play rated games to join a weekly league.');
    if (body) body.innerHTML = insightsGuestMarkup('Sign in and play rated games to unlock Insights.');
    return;
  }
  await Promise.all([insightsLoadLeague(), insightsLoadPivot(false)]);
}

function insightsBindEvents(el) {
  el.addEventListener('click', ev => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    if (btn.id === 'insights-sign-in-btn') { insightsOpenSignIn(); return; }
    if (btn.id === 'insights-compute-btn') {
      btn.disabled = true;
      const status = document.getElementById('insights-status');
      if (status) status.textContent = 'Analysing recent games with the server engine…';
      insightsLoadPivot(true);
      return;
    }
    if (btn.classList.contains('insights-chip')) {
      const group = btn.dataset.group;
      const value = btn.dataset.value;
      insightsReadControls();
      if (insightsState.params[group] === value) delete insightsState.params[group];
      else insightsState.params[group] = value;
      insightsSyncHash(); // shell re-shows the view, which reloads the pivot
    }
  });
  el.addEventListener('change', ev => {
    const t = ev.target;
    if (!t || !['insights-metric', 'insights-dimension', 'insights-from', 'insights-to', 'insights-tc'].includes(t.id)) return;
    insightsReadControls();
    if (t.id === 'insights-metric' && insightsState.catalogue) {
      const m = insightsState.catalogue.metrics.find(x => x.id === insightsState.params.metric);
      if (m && m.available && !m.dimensions.includes(insightsState.params.dimension)) insightsState.params.dimension = 'all';
    }
    insightsSyncHash(); // shell re-shows the view, which reloads the pivot
  });
}

function insightsApplyParams(params) {
  const p = params || {};
  const next = {};
  for (const k of ['metric', 'dimension', 'from', 'to', 'color', 'tc', 'opponent']) if (p[k]) next[k] = String(p[k]);
  insightsState.params = Object.assign({ metric: 'results', dimension: 'all' }, next);
}

function initInsightsView() {
  if (typeof window === 'undefined' || !window.Shell || typeof window.Shell.registerView !== 'function') return;
  window.Shell.registerView({
    id: 'insights',
    title: 'Insights',
    order: 45,
    nav: true,
    mount(el, params) {
      insightsState.el = el;
      insightsInjectStyles();
      insightsRenderSkeleton(el);
      insightsBindEvents(el);
      insightsApplyParams(params);
    },
    show(el, params) {
      insightsState.visible = true;
      insightsApplyParams(params);
      insightsRefresh();
      if (!insightsState.countdownTimer) insightsState.countdownTimer = setInterval(insightsTickCountdown, 1000);
    },
    hide() {
      insightsState.visible = false;
      if (insightsState.countdownTimer) { clearInterval(insightsState.countdownTimer); insightsState.countdownTimer = null; }
    }
  });
}

initInsightsView();
