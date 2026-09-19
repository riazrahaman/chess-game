'use strict';

/**
 * routes-insights.js — Wave 3 (roadmap N2.8 leagues + N3.15 Insights).
 *
 * Mounted from server.js with a single line before the /api/ 404 fallthrough:
 *   if (require('./src/routes-insights.js').handleInsightsRoute(req, res, urlPath, ctx)) return;
 * and fed rated results through the rating hook's single onRated slot, chained
 * next to SocialRoutes.onRatedGame in server.js:
 *   onRated: event => { SocialRoutes.onRatedGame(event); require('./src/routes-insights.js').onRatedGame(event); }
 *
 * Route table:
 *   GET  /api/insights?metric=&dimension=&from=&to=&color=&tc=&opponent=[&compute=1]
 *                                      (auth) the caller's insights; scope is
 *                                      'player' when games are bound to the
 *                                      account, else 'archive' (whole archive,
 *                                      until owner_id lands). compute=1 fills
 *                                      the eval cache for recent games via the
 *                                      server engine under a ply budget.
 *   GET  /api/insights/dimensions       catalogue of metrics / dimensions / filters
 *   GET  /api/league                    (auth) own division standings, tier, week,
 *                                      countdown; enrolled:false when the caller
 *                                      has not finished a rated game this week
 *   GET  /api/league/tiers              tier ladder + rules
 *   POST /api/league/close-week {week?} admin only: X-Admin-Token must equal env
 *                                      CHESS_ADMIN_TOKEN (404 when unset)
 * Scheduled close: every league request first runs autoClose(now), so a
 * finished week is closed (and promotions fired) on the first request after
 * the Monday 00:00 UTC boundary.
 *
 * Promotion feed: onPromotion(fn) registers fn(playerId, fromTier, toTier)
 * (Worker A's achievements `first_league_promotion`); no-op when unregistered.
 */

const crypto = require('crypto');
const Leagues = require('./leagues.js');
const LeaguesStore = require('./leagues-store.js');
const Insights = require('./insights.js');

const MAX_INSIGHT_GAMES = 500;
const COMPUTE_PLY_BUDGET = 100;
const COMPUTE_MAX_GAMES = 30;

let league = null;
const promotionListeners = [];

function getLeague() {
  if (league) return league;
  league = Leagues.createLeague(LeaguesStore.getDefaultStore());
  league.onPromotion((playerId, fromTier, toTier) => {
    for (const fn of promotionListeners) {
      try { fn(playerId, fromTier, toTier); } catch (_) { /* observers never break the league */ }
    }
  });
  return league;
}

/** Register fn(playerId, fromTier, toTier); returns an unsubscribe function. */
function onPromotion(fn) {
  if (typeof fn !== 'function') throw new TypeError('onPromotion: function required');
  promotionListeners.push(fn);
  return () => {
    const i = promotionListeners.indexOf(fn);
    if (i >= 0) promotionListeners.splice(i, 1);
  };
}

/** Test hook: drop the league instance and the default store. */
function resetInsightsState() {
  league = null;
  LeaguesStore.resetDefaultStore();
}

/** rating-hook.js onRated consumer: enrol + score both players for rated games. */
function onRatedGame(event) {
  try {
    if (!event || event.rated !== true) return null;
    return getLeague().onRatedGame(event);
  } catch (_) {
    return null; // observers never break the referee
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function queryOf(req) {
  const idx = req.url.indexOf('?');
  return new URLSearchParams(idx >= 0 ? req.url.slice(idx + 1) : '');
}

function requireAuth(req, res, ctx) {
  const session = ctx.getAuthUser(req);
  if (!session || !session.userId) {
    ctx.sendJson(res, 401, { ok: false, error: 'sign in required', guest: true });
    return null;
  }
  return { id: String(session.userId), username: String(session.username || session.userId) };
}

function adminAllowed(req) {
  const expected = process.env.CHESS_ADMIN_TOKEN;
  if (!expected) return 'unset';
  const given = String(req.headers['x-admin-token'] || '');
  const a = Buffer.from(given);
  const b = Buffer.from(String(expected));
  if (a.length !== b.length || a.length === 0) return 'denied';
  return crypto.timingSafeEqual(a, b) ? 'ok' : 'denied';
}

function parseJson(body) {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------
function handleDimensions(req, res, ctx) {
  ctx.sendJson(res, 200, Object.assign({ ok: true }, Insights.catalogue()));
}

async function handleInsights(req, res, ctx) {
  const user = requireAuth(req, res, ctx);
  if (!user) return;
  const q = queryOf(req);
  const metric = q.get('metric') || 'results';
  const dimension = q.get('dimension') || 'all';
  const filters = {
    from: q.get('from') || null,
    to: q.get('to') || null,
    color: q.get('color') || null,
    tc: q.get('tc') || null,
    opponent: q.get('opponent') || null
  };
  const archive = ctx.gameArchive;
  const loaded = Insights.loadGames({
    archive,
    playerId: user.id,
    username: user.username,
    selectGames: typeof ctx.selectGames === 'function' ? ctx.selectGames : undefined,
    limit: MAX_INSIGHT_GAMES
  });
  let compute = null;
  if (metric === 'acpl' && q.get('compute') === '1') {
    try {
      compute = await Insights.computeMissingEvals(loaded.games, { archive, maxGames: COMPUTE_MAX_GAMES, plyBudget: COMPUTE_PLY_BUDGET, depth: 10, movetime: 150 });
    } catch (err) {
      compute = { analysed: 0, plies: 0, skipped: err && err.message ? err.message : 'compute failed' };
    }
  }
  const result = Insights.computeInsights(loaded.games, { metric, dimension, filters });
  if (!result.ok) {
    ctx.sendJson(res, 400, Object.assign({ scope: loaded.scope }, result));
    return;
  }
  const payload = Object.assign({ scope: loaded.scope, player: { id: user.id, username: user.username }, archiveGames: loaded.total }, result);
  if (compute) payload.compute = compute;
  ctx.sendJson(res, 200, payload);
}

function tierPayload() {
  return {
    tiers: Leagues.TIERS,
    divisionSize: Leagues.DIVISION_SIZE,
    promoteFraction: Leagues.PROMOTE_FRACTION,
    points: Leagues.POINTS,
    rules: [
      'Weeks are ISO weeks in UTC (Monday 00:00 UTC to the next Monday).',
      'You join this week\'s league automatically when you finish your first rated game.',
      'Win = 1 point, draw = 0.5, loss = 0.',
      'At week end the top 20% of each division (at least one player with points) promote one tier. Nobody relegates.'
    ]
  };
}

function handleLeagueTiers(req, res, ctx) {
  ctx.sendJson(res, 200, Object.assign({ ok: true }, tierPayload()));
}

function handleLeague(req, res, ctx) {
  const user = requireAuth(req, res, ctx);
  if (!user) return;
  const lg = getLeague();
  const now = Date.now();
  let autoClosed = [];
  try { autoClosed = lg.autoClose(now).map(s => s.week); } catch (_) { autoClosed = []; }
  const q = queryOf(req);
  const week = q.get('week') && lg.isValidWeek(q.get('week')) ? q.get('week') : lg.weekOf(now);
  const standings = lg.standings(user.id, week);
  ctx.sendJson(res, 200, {
    ok: true,
    week,
    currentWeek: lg.weekOf(now),
    weekStartsAt: lg.weekStartMs(week),
    weekEndsAt: lg.weekEndMs(week),
    now,
    tier: lg.playerTier(user.id),
    tiers: Leagues.TIERS,
    enrolled: Boolean(standings),
    standings,
    autoClosed
  });
}

function handleCloseWeek(req, res, ctx) {
  const admin = adminAllowed(req);
  if (admin === 'unset') { ctx.sendJsonError(res, 404, 'not found'); return; }
  if (admin !== 'ok') { ctx.sendJsonError(res, 403, 'admin token required'); return; }
  const readBody = ctx.readBody;
  const done = (body) => {
    const parsed = parseJson(body);
    if (parsed === null) { ctx.sendJsonError(res, 400, 'invalid json'); return; }
    const lg = getLeague();
    const week = parsed.week ? String(parsed.week) : lg.weekOf(Date.now() - 7 * 86400000);
    if (!lg.isValidWeek(week)) { ctx.sendJsonError(res, 400, 'invalid week'); return; }
    try {
      const summary = lg.closeWeek(week, { force: parsed.force === true });
      ctx.sendJson(res, 200, Object.assign({ ok: true }, summary));
    } catch (err) {
      ctx.sendJsonError(res, 409, err && err.message ? err.message : 'cannot close week');
    }
  };
  if (typeof readBody === 'function') {
    readBody(req, ctx.maxBodyBytes || 8192).then(done).catch(() => ctx.sendJsonError(res, 413, 'request body too large'));
  } else {
    done('');
  }
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------
function handleInsightsRoute(req, res, urlPath, ctx) {
  const method = req.method;
  if (method === 'GET' && urlPath === '/api/insights/dimensions') { handleDimensions(req, res, ctx); return true; }
  if (method === 'GET' && urlPath === '/api/insights') {
    handleInsights(req, res, ctx).catch(err => {
      if (!res.headersSent) ctx.sendJsonError(res, 500, err && err.message ? err.message : 'insights failed');
    });
    return true;
  }
  if (method === 'GET' && urlPath === '/api/league/tiers') { handleLeagueTiers(req, res, ctx); return true; }
  if (method === 'GET' && urlPath === '/api/league') { handleLeague(req, res, ctx); return true; }
  if (method === 'POST' && urlPath === '/api/league/close-week') { handleCloseWeek(req, res, ctx); return true; }
  return false;
}

module.exports = {
  handleInsightsRoute,
  onRatedGame,
  onPromotion,
  getLeague,
  resetInsightsState
};
