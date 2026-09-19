'use strict';

/**
 * streaks.js — Wave 3 (roadmap §6 Tier N2 item 7): activity streaks with slack.
 *
 * Server-only module (never shipped to the browser). Pure rule logic over an
 * injected store (social-store.js adapters implement the contract below), and
 * fully deterministic: every entry point takes `at` / `now` in ms so tests can
 * simulate day boundaries. No Math.random, no Date.now() unless the caller
 * omits the timestamp.
 *
 * THE STREAK RULE (Chess.com model, documented once here and enforced in
 * applyActivity() / describeStreak()):
 *   - Days are UTC calendar days ('YYYY-MM-DD').
 *   - Qualifying activity kinds: 'game' (any finished game), 'puzzle' (an
 *     attempt), 'puzzle_review' (a spaced-repetition review), 'analysis'
 *     (an engine batch). Anything else is rejected.
 *   - The counter increments AT MOST ONCE per UTC day with activity.
 *   - gap = dayDiff(lastActiveDay, activityDay):
 *       gap <= 0   same (or earlier) day  → counter unchanged, day recorded
 *       gap 1..3   ≤ 2 fully idle days    → counter + 1 (slack: idle days pause,
 *                                           they do not break)
 *       gap >= 4   ≥ 3 fully idle days    → counter resets to 1
 *   - Status as seen at `now` (today = utcDay(now), gap = dayDiff(last, today)):
 *       gap 0..1  'active'   (today done, or yesterday done and today still open)
 *       gap 2..3  'at-risk'  (1–2 idle days have passed; the counter is kept)
 *       gap >= 4  'broken'   (3 idle days: current shown as 0, longest kept)
 *     daysUntilReset = max(0, 4 - gap): how many more idle days until 'broken'.
 *
 * Player ids are the bare account id (string). routes-puzzles.js uses
 * `user:<id>` for its own player key, so normalizePlayerId() strips that prefix
 * and rejects anonymous (`anon:`) players.
 *
 * Store contract (all synchronous):
 *   getStreak(playerId) → {current, longest, lastActiveDay} | null
 *   saveStreak(playerId, {current, longest, lastActiveDay})
 *   addActivityDay(playerId, day, kind) → {day, kinds[]}
 *   listActivityDays(playerId, {limit}) → [{day, kinds[]}] newest first
 */

const KINDS = Object.freeze(['game', 'puzzle', 'puzzle_review', 'analysis']);
const PAUSE_AFTER_IDLE_DAYS = 1;   // one idle day → at-risk
const RESET_AFTER_IDLE_DAYS = 3;   // three idle days → broken
const RESET_GAP = RESET_AFTER_IDLE_DAYS + 1; // gap in calendar days that resets
const DAY_MS = 24 * 60 * 60 * 1000;

function normalizePlayerId(id) {
  if (id == null) return null;
  let value = String(id).trim();
  if (!value) return null;
  if (value.startsWith('anon:')) return null;
  if (value.startsWith('user:')) value = value.slice(5);
  return value || null;
}

function isKind(kind) {
  return KINDS.includes(kind);
}

/** 'YYYY-MM-DD' in UTC for a ms timestamp (or Date). */
function utcDay(at) {
  const ms = at instanceof Date ? at.getTime() : Number(at);
  if (!Number.isFinite(ms)) throw new TypeError('utcDay: timestamp required');
  return new Date(ms).toISOString().slice(0, 10);
}

function dayToMs(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Signed whole-day difference b - a for two 'YYYY-MM-DD' strings. */
function dayDiff(a, b) {
  const ma = dayToMs(a);
  const mb = dayToMs(b);
  if (!Number.isFinite(ma) || !Number.isFinite(mb)) return NaN;
  return Math.round((mb - ma) / DAY_MS);
}

/** Pure: next streak record after an activity on `day`. */
function applyActivity(record, day) {
  const prev = record || { current: 0, longest: 0, lastActiveDay: null };
  if (!prev.lastActiveDay) {
    return { current: 1, longest: Math.max(1, prev.longest || 0), lastActiveDay: day, incremented: true };
  }
  const gap = dayDiff(prev.lastActiveDay, day);
  if (!Number.isFinite(gap) || gap <= 0) {
    return { current: prev.current, longest: prev.longest, lastActiveDay: prev.lastActiveDay, incremented: false };
  }
  const current = gap >= RESET_GAP ? 1 : prev.current + 1;
  return { current, longest: Math.max(prev.longest || 0, current), lastActiveDay: day, incremented: true };
}

/** Pure: how a stored record looks at `now`. */
function describeStreak(record, now) {
  const today = utcDay(now == null ? Date.now() : now);
  if (!record || !record.lastActiveDay) {
    return { current: 0, longest: (record && record.longest) || 0, lastActiveDay: null, status: 'broken', daysUntilReset: 0, activeToday: false };
  }
  const gap = dayDiff(record.lastActiveDay, today);
  let status = 'active';
  if (gap >= RESET_GAP) status = 'broken';
  else if (gap > PAUSE_AFTER_IDLE_DAYS) status = 'at-risk';
  return {
    current: status === 'broken' ? 0 : record.current,
    longest: record.longest,
    lastActiveDay: record.lastActiveDay,
    status,
    daysUntilReset: Math.max(0, RESET_GAP - Math.max(0, gap)),
    activeToday: gap === 0
  };
}

/**
 * Pure: number of consecutive UTC days ending today (or yesterday, since today
 * is still open) on which `predicate(kinds)` holds. Used for puzzle habits.
 */
function consecutiveDays(days, now, predicate) {
  const byDay = new Map();
  for (const d of days || []) byDay.set(d.day, d.kinds || []);
  const today = utcDay(now == null ? Date.now() : now);
  const match = day => byDay.has(day) && predicate(byDay.get(day));
  let cursorMs = dayToMs(today);
  if (!match(today)) cursorMs -= DAY_MS; // today still open: count from yesterday
  let count = 0;
  while (match(utcDay(cursorMs))) { count++; cursorMs -= DAY_MS; }
  return count;
}

class StreakTracker {
  constructor(options = {}) {
    if (!options.store || typeof options.store.getStreak !== 'function') {
      throw new TypeError('StreakTracker: a store with getStreak/saveStreak/addActivityDay/listActivityDays is required');
    }
    this.store = options.store;
  }

  /**
   * Record one qualifying activity. Returns { playerId, day, kind, incremented,
   * streak: describeStreak(...) } or null for anonymous players. Throws on an
   * unknown kind.
   */
  recordActivity(playerId, kind, at) {
    const pid = normalizePlayerId(playerId);
    if (!pid) return null;
    if (!isKind(kind)) throw new TypeError(`recordActivity: unknown kind '${kind}'`);
    const ts = at == null ? Date.now() : (at instanceof Date ? at.getTime() : Number(at));
    const day = utcDay(ts);
    const next = applyActivity(this.store.getStreak(pid), day);
    this.store.saveStreak(pid, { current: next.current, longest: next.longest, lastActiveDay: next.lastActiveDay });
    const dayRecord = this.store.addActivityDay(pid, day, kind);
    return { playerId: pid, day, kind, kinds: dayRecord.kinds, incremented: next.incremented, streak: describeStreak(this.store.getStreak(pid), ts) };
  }

  getStreak(playerId, now) {
    const pid = normalizePlayerId(playerId);
    if (!pid) return describeStreak(null, now);
    return describeStreak(this.store.getStreak(pid), now);
  }

  getActivityDays(playerId, options) {
    const pid = normalizePlayerId(playerId);
    if (!pid) return [];
    return this.store.listActivityDays(pid, options || {});
  }

  /** Consecutive days (ending today/yesterday) with a puzzle attempt or review. */
  puzzleDayStreak(playerId, now) {
    const days = this.getActivityDays(playerId, { limit: 400 });
    return consecutiveDays(days, now, kinds => kinds.includes('puzzle') || kinds.includes('puzzle_review'));
  }
}

let defaultTracker = null;
function getDefaultTracker() {
  if (!defaultTracker) {
    defaultTracker = new StreakTracker({ store: require('./social-store.js').getDefaultStore() });
  }
  return defaultTracker;
}
function resetDefaultTracker() { defaultTracker = null; }

module.exports = {
  KINDS,
  PAUSE_AFTER_IDLE_DAYS,
  RESET_AFTER_IDLE_DAYS,
  normalizePlayerId,
  isKind,
  utcDay,
  dayDiff,
  applyActivity,
  describeStreak,
  consecutiveDays,
  StreakTracker,
  getDefaultTracker,
  resetDefaultTracker,
  recordActivity: (playerId, kind, at) => getDefaultTracker().recordActivity(playerId, kind, at),
  getStreak: (playerId, now) => getDefaultTracker().getStreak(playerId, now)
};
