'use strict';

/**
 * leagues.js — Wave 3 (roadmap N2.8): weekly leagues, Chess.com model.
 *
 * Pure league logic over an injected store (leagues-store.js contract). No
 * Math.random anywhere: tie-breaks and division assignment are deterministic.
 *
 * THE LEAGUE RULES (documented here, enforced below):
 *   1. Weeks are ISO-8601 weeks in UTC: id `YYYY-Www`, running Monday 00:00:00
 *      UTC up to (not including) the next Monday 00:00:00 UTC. weekOf(ms) maps
 *      any instant to its week; weekEndMs(week) is the boundary.
 *   2. Enrolment is automatic: a player joins the current week's league the
 *      first time they finish a RATED game that week (rating-hook.js decides
 *      what "rated" means; bot, anonymous and aborted games never enrol).
 *      Explicit enroll() exists for the same effect without a result.
 *   3. Tiers, lowest to highest: Wood, Stone, Bronze, Silver, Crystal, Elite,
 *      Champion, Legend. A new player starts in Wood. The tier a player will be
 *      placed in is persisted across weeks (league_tiers) and only ever rises.
 *   4. Divisions hold at most DIVISION_SIZE (50) players of one tier. Enrolment
 *      fills the lowest-numbered open division of the player's tier, creating
 *      `${week}:${tier}:${n}` when all are full.
 *   5. Points: 1 per rated win, 0.5 per rated draw, 0 per loss. Losses are
 *      recorded (they count as games) but never subtract points.
 *   6. Standings order: points desc, wins desc, games asc (fewer games for the
 *      same points ranks higher), enrolment time asc, playerId asc.
 *   7. At week end the top PROMOTE_FRACTION (20 %, rounded up, at least one
 *      player) of every division with at least one point promote one tier.
 *      Players with 0 points never promote; Legend is the ceiling. Nobody is
 *      ever relegated. closeWeek() is idempotent, refuses to close the current
 *      or a future week (unless { force: true }), and fires
 *      onPromotion(playerId, fromTier, toTier) for each promotion — a no-op
 *      when nothing is registered (Worker A's achievements hook into it).
 *   8. A new week starts with fresh, empty divisions; last week's standings
 *      stay readable through standings(x, week).
 *
 * Public API (createLeague(store, opts) returns an instance):
 *   weekOf(ms), weekStartMs(week), weekEndMs(week), nextWeek(week), isValidWeek(week)
 *   enroll(playerId, week, { username })
 *   recordResult(playerId, result, week, { username })   result: 'win'|'draw'|'loss'|1|0.5|0
 *   standings(playerIdOrDivisionId, week)
 *   closeWeek(week, { now, force })
 *   autoClose(now)                        close every finished, still-open week
 *   onPromotion(fn)                       register the promotion callback
 *   onRatedGame(event)                    adapter for rating-hook onRated events
 */

const TIERS = ['Wood', 'Stone', 'Bronze', 'Silver', 'Crystal', 'Elite', 'Champion', 'Legend'];
const DIVISION_SIZE = 50;
const PROMOTE_FRACTION = 0.2;
const POINTS = { win: 1, draw: 0.5, loss: 0 };
const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;
const WEEK_RE = /^(\d{4})-W(\d{2})$/;

// ---------------------------------------------------------------------------
// ISO week helpers (UTC)
// ---------------------------------------------------------------------------
function weekOf(input) {
  const d = new Date(input == null ? Date.now() : input);
  if (Number.isNaN(d.getTime())) throw new TypeError('weekOf: invalid date');
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7; // Mon=1 .. Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // the Thursday of this ISO week
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function isValidWeek(week) {
  const m = WEEK_RE.exec(String(week || ''));
  if (!m) return false;
  const n = Number(m[2]);
  return n >= 1 && n <= 53 && weekOf(weekStartMs(week)) === week;
}

function weekStartMs(week) {
  const m = WEEK_RE.exec(String(week || ''));
  if (!m) throw new TypeError('weekStartMs: week must look like YYYY-Www');
  const year = Number(m[1]);
  const n = Number(m[2]);
  // ISO week 1 is the week containing January 4th.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = Date.UTC(year, 0, 4 - (jan4Day - 1));
  return week1Monday + (n - 1) * WEEK_MS;
}

function weekEndMs(week) {
  return weekStartMs(week) + WEEK_MS;
}

function nextWeek(week) {
  return weekOf(weekEndMs(week));
}

function tierIndex(tier) {
  return TIERS.indexOf(tier);
}

function nextTier(tier) {
  const i = tierIndex(tier);
  return i >= 0 && i < TIERS.length - 1 ? TIERS[i + 1] : null;
}

function normalizeResult(result) {
  if (result === 'win' || result === 1 || result === '1') return 'win';
  if (result === 'draw' || result === 0.5 || result === '0.5') return 'draw';
  if (result === 'loss' || result === 0 || result === '0') return 'loss';
  throw new TypeError('recordResult: result must be win | draw | loss');
}

function compareRows(a, b) {
  if (b.points !== a.points) return b.points - a.points;
  if (b.wins !== a.wins) return b.wins - a.wins;
  if (a.games !== b.games) return a.games - b.games;
  if (a.enrolledAt !== b.enrolledAt) return a.enrolledAt - b.enrolledAt;
  return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0;
}

/** How many players promote out of a division of `size` members. */
function promoteCount(size) {
  if (size <= 0) return 0;
  return Math.max(1, Math.ceil(size * PROMOTE_FRACTION));
}

// ---------------------------------------------------------------------------
// League instance
// ---------------------------------------------------------------------------
function createLeague(store, options = {}) {
  if (!store || typeof store.getMembership !== 'function') {
    throw new TypeError('createLeague: a leagues-store instance is required');
  }
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const promotionListeners = new Set();
  if (typeof options.onPromotion === 'function') promotionListeners.add(options.onPromotion);

  function emitPromotion(playerId, fromTier, toTier) {
    for (const fn of promotionListeners) {
      try { fn(playerId, fromTier, toTier); } catch (_) { /* observers never break the league */ }
    }
  }

  function currentTier(playerId) {
    const rec = store.getPlayerTier(playerId);
    return rec && tierIndex(rec.tier) >= 0 ? rec.tier : TIERS[0];
  }

  function openDivisionFor(week, tier) {
    const divisions = store.listDivisions(week).filter(d => d.tier === tier).sort((a, b) => a.seq - b.seq);
    for (const div of divisions) {
      if (store.listDivisionMembers(div.id).length < DIVISION_SIZE) return div;
    }
    const seq = divisions.length + 1;
    const div = { id: `${week}:${tier}:${seq}`, week, tier, seq, createdAt: now() };
    store.saveDivision(div);
    return div;
  }

  function enroll(playerId, week, opts = {}) {
    if (!playerId) throw new TypeError('enroll: playerId is required');
    const wk = week || weekOf(now());
    if (!isValidWeek(wk)) throw new TypeError('enroll: invalid week ' + wk);
    const id = String(playerId);
    const existing = store.getMembership(wk, id);
    if (existing) {
      if (opts.username && existing.username !== opts.username) {
        existing.username = String(opts.username);
        store.saveMembership(existing);
      }
      return existing;
    }
    if (store.getWeekClose(wk)) throw new Error('enroll: week ' + wk + ' is closed');
    const tier = currentTier(id);
    const div = openDivisionFor(wk, tier);
    const membership = {
      week: wk,
      playerId: id,
      username: String(opts.username || id),
      divisionId: div.id,
      points: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      enrolledAt: now()
    };
    store.saveMembership(membership);
    return membership;
  }

  function recordResult(playerId, result, week, opts = {}) {
    const kind = normalizeResult(result);
    const wk = week || weekOf(now());
    const membership = enroll(playerId, wk, opts);
    if (store.getWeekClose(wk)) throw new Error('recordResult: week ' + wk + ' is closed');
    membership.points += POINTS[kind];
    if (kind === 'win') membership.wins += 1;
    else if (kind === 'draw') membership.draws += 1;
    else membership.losses += 1;
    store.saveMembership(membership);
    return Object.assign({}, membership, { games: membership.wins + membership.draws + membership.losses });
  }

  function divisionStandings(div, week) {
    const closeRec = store.getWeekClose(week);
    const members = store.listDivisionMembers(div.id).map(m => Object.assign({}, m, { games: m.wins + m.draws + m.losses }));
    members.sort(compareRows);
    const promoteN = nextTier(div.tier) ? promoteCount(members.length) : 0;
    const rows = members.map((m, i) => ({
      rank: i + 1,
      playerId: m.playerId,
      username: m.username,
      points: m.points,
      wins: m.wins,
      draws: m.draws,
      losses: m.losses,
      games: m.games,
      promotes: i < promoteN && m.points > 0
    }));
    return {
      week,
      divisionId: div.id,
      tier: div.tier,
      nextTier: nextTier(div.tier),
      size: rows.length,
      capacity: DIVISION_SIZE,
      promoteCount: rows.filter(r => r.promotes).length,
      weekStartsAt: weekStartMs(week),
      weekEndsAt: weekEndMs(week),
      closed: Boolean(closeRec),
      rows
    };
  }

  /**
   * standings(x, week): x is a division id (`week:Tier:n`) or a player id.
   * Returns null when the player is not enrolled that week.
   */
  function standings(idOrPlayer, week) {
    const wk = week || weekOf(now());
    const key = String(idOrPlayer || '');
    const direct = store.getDivision(key);
    if (direct && direct.week === wk) return divisionStandings(direct, wk);
    const membership = store.getMembership(wk, key);
    if (!membership) return null;
    const div = store.getDivision(membership.divisionId);
    if (!div) return null;
    const out = divisionStandings(div, wk);
    out.me = out.rows.find(r => r.playerId === key) || null;
    return out;
  }

  function closeWeek(week, opts = {}) {
    const wk = String(week || '');
    if (!isValidWeek(wk)) throw new TypeError('closeWeek: invalid week ' + wk);
    const existing = store.getWeekClose(wk);
    if (existing) return Object.assign({ alreadyClosed: true }, existing.summary || { week: wk });
    const at = typeof opts.now === 'number' ? opts.now : now();
    if (!opts.force && weekEndMs(wk) > at) {
      throw new Error('closeWeek: week ' + wk + ' has not ended yet');
    }
    const divisions = store.listDivisions(wk);
    const promoted = [];
    for (const div of divisions) {
      const table = divisionStandings(div, wk);
      for (const row of table.rows) {
        if (!row.promotes) continue;
        const from = div.tier;
        const to = nextTier(from);
        if (!to) continue;
        // A player's persisted tier only rises (they may already have been
        // promoted by a later week that closed first).
        const persisted = currentTier(row.playerId);
        if (tierIndex(to) > tierIndex(persisted)) store.savePlayerTier(row.playerId, to, wk);
        promoted.push({ playerId: row.playerId, username: row.username, divisionId: div.id, fromTier: from, toTier: to, points: row.points });
      }
    }
    const summary = { week: wk, closedAt: at, divisions: divisions.length, promoted };
    store.saveWeekClose(wk, summary);
    for (const p of promoted) emitPromotion(p.playerId, p.fromTier, p.toTier);
    return summary;
  }

  /** Close every week whose boundary has passed and that still has open divisions. */
  function autoClose(at) {
    const t = typeof at === 'number' ? at : now();
    const closed = [];
    for (const wk of store.listOpenWeeks()) {
      if (!isValidWeek(wk) || weekEndMs(wk) > t) continue;
      closed.push(closeWeek(wk, { now: t }));
    }
    return closed;
  }

  function playerTier(playerId) {
    return currentTier(String(playerId));
  }

  /**
   * Adapter for rating-hook.js `onRated(event)`: only rated events with both
   * account ids count. Week is derived from event.at (UTC).
   */
  function onRatedGame(event) {
    if (!event || event.rated !== true || !event.white || !event.black) return null;
    if (!event.white.accountId || !event.black.accountId) return null;
    const value = String(event.result == null ? '' : event.result).trim();
    let whiteResult;
    if (value.startsWith('1-0')) whiteResult = 'win';
    else if (value.startsWith('0-1')) whiteResult = 'loss';
    else if (value.startsWith('½-½') || value.startsWith('1/2-1/2')) whiteResult = 'draw';
    else return null;
    const blackResult = whiteResult === 'win' ? 'loss' : whiteResult === 'loss' ? 'win' : 'draw';
    const wk = weekOf(typeof event.at === 'number' ? event.at : now());
    if (store.getWeekClose(wk)) return null;
    const white = recordResult(event.white.accountId, whiteResult, wk, { username: event.white.username });
    const black = recordResult(event.black.accountId, blackResult, wk, { username: event.black.username });
    return { week: wk, white, black };
  }

  return {
    TIERS,
    DIVISION_SIZE,
    PROMOTE_FRACTION,
    POINTS,
    weekOf,
    weekStartMs,
    weekEndMs,
    nextWeek,
    isValidWeek,
    enroll,
    recordResult,
    standings,
    closeWeek,
    autoClose,
    playerTier,
    onRatedGame,
    onPromotion(fn) {
      if (typeof fn !== 'function') throw new TypeError('onPromotion: function required');
      promotionListeners.add(fn);
      return () => promotionListeners.delete(fn);
    }
  };
}

module.exports = {
  createLeague,
  weekOf,
  weekStartMs,
  weekEndMs,
  nextWeek,
  isValidWeek,
  nextTier,
  promoteCount,
  TIERS,
  DIVISION_SIZE,
  PROMOTE_FRACTION,
  POINTS
};
