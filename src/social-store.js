'use strict';

/**
 * social-store.js — Wave 2 (roadmap R2): persistence for the social graph and
 * arena tournaments, over node:sqlite (`social.db`, gitignored via `*.db`).
 *
 * Path: CHESS_SOCIAL_DB_PATH env var, else <repo>/social.db. When node:sqlite
 * is unavailable the store degrades to an in-memory map mirrored to a JSON file
 * (CHESS_SOCIAL_JSON_PATH, default <repo>/.social.json), matching the fallback
 * pattern of accounts.js / game-archive.js.
 *
 * Exposes the whole-graph backend contract social-graph.js expects
 * ({ loadGraph(), saveGraph(serialized) }) plus arena snapshot helpers.
 *
 * Wave 3 (roadmap N2 items 7 + 9) adds the retention tables, keyed by the bare
 * account id (streaks.js normalizePlayerId):
 *   activity_days        (player_id, day 'YYYY-MM-DD', kinds 'game puzzle …')
 *   streaks              (player_id, current, longest, last_active_day)
 *   achievements         (player_id, achievement_id, awarded_at, evidence JSON)
 *   retention_counters   (player_id, key, value)   e.g. rated_games / rated_wins
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
function defaultDbPath() {
  return process.env.CHESS_SOCIAL_DB_PATH || path.join(ROOT, 'social.db');
}
function defaultJsonPath() {
  return process.env.CHESS_SOCIAL_JSON_PATH || path.join(ROOT, '.social.json');
}

class SqliteSocialAdapter {
  constructor(dbPath) {
    const { DatabaseSync } = require('node:sqlite');
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS social_edges (
        user_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('follow', 'block')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, target_id, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_social_edges_target ON social_edges(target_id, kind);
      CREATE TABLE IF NOT EXISTS arenas (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity_days (
        player_id TEXT NOT NULL,
        day TEXT NOT NULL,
        kinds TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (player_id, day)
      );
      CREATE TABLE IF NOT EXISTS streaks (
        player_id TEXT PRIMARY KEY,
        current INTEGER NOT NULL DEFAULT 0,
        longest INTEGER NOT NULL DEFAULT 0,
        last_active_day TEXT
      );
      CREATE TABLE IF NOT EXISTS achievements (
        player_id TEXT NOT NULL,
        achievement_id TEXT NOT NULL,
        awarded_at INTEGER NOT NULL,
        evidence TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (player_id, achievement_id)
      );
      CREATE TABLE IF NOT EXISTS retention_counters (
        player_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (player_id, key)
      );
    `);
  }

  // ---- Wave 3 retention: activity ledger -------------------------------
  addActivityDay(playerId, day, kind) {
    const row = this.db.prepare('SELECT kinds FROM activity_days WHERE player_id = ? AND day = ?').get(String(playerId), String(day));
    const kinds = mergeKinds(row ? row.kinds : '', kind);
    this.db.prepare('INSERT OR REPLACE INTO activity_days (player_id, day, kinds) VALUES (?, ?, ?)')
      .run(String(playerId), String(day), kinds);
    return { day: String(day), kinds: kinds.split(' ').filter(Boolean) };
  }

  listActivityDays(playerId, options = {}) {
    const limit = Math.max(1, Math.min(3660, Number(options.limit) || 400));
    const rows = this.db.prepare('SELECT day, kinds FROM activity_days WHERE player_id = ? ORDER BY day DESC LIMIT ?')
      .all(String(playerId), limit);
    return rows.map(r => ({ day: r.day, kinds: String(r.kinds || '').split(' ').filter(Boolean) }));
  }

  getStreak(playerId) {
    const row = this.db.prepare('SELECT current, longest, last_active_day FROM streaks WHERE player_id = ?').get(String(playerId));
    return row ? { current: Number(row.current) || 0, longest: Number(row.longest) || 0, lastActiveDay: row.last_active_day || null } : null;
  }

  saveStreak(playerId, streak) {
    this.db.prepare('INSERT OR REPLACE INTO streaks (player_id, current, longest, last_active_day) VALUES (?, ?, ?, ?)')
      .run(String(playerId), Number(streak.current) || 0, Number(streak.longest) || 0, streak.lastActiveDay || null);
    return { current: Number(streak.current) || 0, longest: Number(streak.longest) || 0, lastActiveDay: streak.lastActiveDay || null };
  }

  // ---- Wave 3 retention: achievements ---------------------------------
  /** Returns true when newly awarded, false when the player already had it. */
  saveAchievement(playerId, achievementId, awardedAt, evidence) {
    const result = this.db.prepare('INSERT OR IGNORE INTO achievements (player_id, achievement_id, awarded_at, evidence) VALUES (?, ?, ?, ?)')
      .run(String(playerId), String(achievementId), Number(awardedAt) || Date.now(), JSON.stringify(evidence || {}));
    return Number(result.changes) > 0;
  }

  listAchievements(playerId) {
    const rows = this.db.prepare('SELECT achievement_id, awarded_at, evidence FROM achievements WHERE player_id = ? ORDER BY awarded_at ASC').all(String(playerId));
    return rows.map(r => ({ id: r.achievement_id, awardedAt: Number(r.awarded_at), evidence: parseEvidence(r.evidence) }));
  }

  // ---- Wave 3 retention: counters -------------------------------------
  getCounter(playerId, key) {
    const row = this.db.prepare('SELECT value FROM retention_counters WHERE player_id = ? AND key = ?').get(String(playerId), String(key));
    return row ? Number(row.value) || 0 : 0;
  }

  incrementCounter(playerId, key, by = 1) {
    const next = this.getCounter(playerId, key) + (Number(by) || 0);
    this.db.prepare('INSERT OR REPLACE INTO retention_counters (player_id, key, value) VALUES (?, ?, ?)')
      .run(String(playerId), String(key), next);
    return next;
  }

  loadGraph() {
    const rows = this.db.prepare('SELECT user_id, target_id, kind FROM social_edges').all();
    const follows = {};
    const blocks = {};
    for (const row of rows) {
      const bucket = row.kind === 'block' ? blocks : follows;
      if (!bucket[row.user_id]) bucket[row.user_id] = [];
      bucket[row.user_id].push(row.target_id);
    }
    return { follows, blocks };
  }

  saveGraph(graph) {
    const now = Date.now();
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO social_edges (user_id, target_id, kind, created_at) VALUES (?, ?, ?, ?)'
    );
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM social_edges');
      for (const [user, targets] of Object.entries((graph && graph.follows) || {})) {
        for (const target of targets || []) insert.run(String(user), String(target), 'follow', now);
      }
      for (const [user, targets] of Object.entries((graph && graph.blocks) || {})) {
        for (const target of targets || []) insert.run(String(user), String(target), 'block', now);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw err;
    }
  }

  saveArena(id, snapshot) {
    this.db.prepare('INSERT OR REPLACE INTO arenas (id, json, updated_at) VALUES (?, ?, ?)')
      .run(String(id), JSON.stringify(snapshot), Date.now());
  }

  loadArenas() {
    const rows = this.db.prepare('SELECT id, json FROM arenas ORDER BY updated_at ASC').all();
    const out = [];
    for (const row of rows) {
      try { out.push(JSON.parse(row.json)); } catch (_) { /* skip corrupt row */ }
    }
    return out;
  }

  close() {
    try { this.db.close(); } catch (_) {}
  }
}

function mergeKinds(existing, kind) {
  const set = new Set(String(existing || '').split(' ').filter(Boolean));
  if (kind) set.add(String(kind));
  return Array.from(set).sort().join(' ');
}

function parseEvidence(raw) {
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
}

class JsonSocialAdapter {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { graph: { follows: {}, blocks: {} }, arenas: {}, activityDays: {}, streaks: {}, achievements: {}, counters: {} };
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.data.graph = parsed.graph || this.data.graph;
        this.data.arenas = parsed.arenas || {};
        this.data.activityDays = parsed.activityDays || {};
        this.data.streaks = parsed.streaks || {};
        this.data.achievements = parsed.achievements || {};
        this.data.counters = parsed.counters || {};
      }
    } catch (_) { /* fresh store */ }
  }

  _flush() {
    try {
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.filePath);
    } catch (_) { /* best effort */ }
  }

  loadGraph() { return this.data.graph; }
  saveGraph(graph) { this.data.graph = graph; this._flush(); }
  saveArena(id, snapshot) { this.data.arenas[String(id)] = snapshot; this._flush(); }
  loadArenas() { return Object.values(this.data.arenas); }

  addActivityDay(playerId, day, kind) {
    const days = this.data.activityDays[String(playerId)] || (this.data.activityDays[String(playerId)] = {});
    const kinds = mergeKinds(days[String(day)] || '', kind);
    days[String(day)] = kinds;
    this._flush();
    return { day: String(day), kinds: kinds.split(' ').filter(Boolean) };
  }

  listActivityDays(playerId, options = {}) {
    const limit = Math.max(1, Math.min(3660, Number(options.limit) || 400));
    const days = this.data.activityDays[String(playerId)] || {};
    return Object.keys(days).sort().reverse().slice(0, limit)
      .map(day => ({ day, kinds: String(days[day] || '').split(' ').filter(Boolean) }));
  }

  getStreak(playerId) {
    const rec = this.data.streaks[String(playerId)];
    return rec ? { current: rec.current || 0, longest: rec.longest || 0, lastActiveDay: rec.lastActiveDay || null } : null;
  }

  saveStreak(playerId, streak) {
    const rec = { current: Number(streak.current) || 0, longest: Number(streak.longest) || 0, lastActiveDay: streak.lastActiveDay || null };
    this.data.streaks[String(playerId)] = rec;
    this._flush();
    return { ...rec };
  }

  saveAchievement(playerId, achievementId, awardedAt, evidence) {
    const list = this.data.achievements[String(playerId)] || (this.data.achievements[String(playerId)] = []);
    if (list.some(a => a.id === String(achievementId))) return false;
    list.push({ id: String(achievementId), awardedAt: Number(awardedAt) || Date.now(), evidence: evidence && typeof evidence === 'object' ? evidence : {} });
    this._flush();
    return true;
  }

  listAchievements(playerId) {
    return (this.data.achievements[String(playerId)] || []).slice().sort((a, b) => a.awardedAt - b.awardedAt)
      .map(a => ({ id: a.id, awardedAt: a.awardedAt, evidence: a.evidence || {} }));
  }

  getCounter(playerId, key) {
    const c = this.data.counters[String(playerId)] || {};
    return Number(c[String(key)]) || 0;
  }

  incrementCounter(playerId, key, by = 1) {
    const c = this.data.counters[String(playerId)] || (this.data.counters[String(playerId)] = {});
    c[String(key)] = (Number(c[String(key)]) || 0) + (Number(by) || 0);
    this._flush();
    return c[String(key)];
  }

  close() {}
}

function createSocialStore(options = {}) {
  if (options.forceJson !== true) {
    try {
      return new SqliteSocialAdapter(options.dbPath || defaultDbPath());
    } catch (_) { /* fall through */ }
  }
  return new JsonSocialAdapter(options.jsonPath || defaultJsonPath());
}

let defaultStore = null;
function getDefaultStore() {
  if (!defaultStore) defaultStore = createSocialStore();
  return defaultStore;
}

function resetDefaultStore() {
  if (defaultStore) defaultStore.close();
  defaultStore = null;
}

module.exports = {
  SqliteSocialAdapter,
  JsonSocialAdapter,
  createSocialStore,
  getDefaultStore,
  resetDefaultStore,
  get DEFAULT_DB_PATH() { return defaultDbPath(); },
  get DEFAULT_JSON_PATH() { return defaultJsonPath(); }
};
