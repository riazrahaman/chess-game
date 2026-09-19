'use strict';

/**
 * leagues-store.js — Wave 3 (roadmap N2.8): persistence for weekly leagues,
 * over node:sqlite (`leagues.db`, gitignored via `*.db`).
 *
 * Path: CHESS_LEAGUES_DB_PATH env var (read at construction time so tests can
 * point it under os.tmpdir() before the default store is created), else
 * <repo>/leagues.db. When node:sqlite is unavailable the store degrades to an
 * in-memory map mirrored to a JSON file (CHESS_LEAGUES_JSON_PATH, default
 * <repo>/.leagues.json), matching social-store.js / accounts.js.
 *
 * Store contract consumed by leagues.js (all synchronous):
 *   getMembership(week, playerId) -> row | null
 *   saveMembership(row)                 upsert on (week, playerId)
 *   listDivisionMembers(divisionId)  -> rows
 *   getDivision(id) / saveDivision(div) / listDivisions(week)
 *   getPlayerTier(playerId) -> { tier, updatedAt, week } | null
 *   savePlayerTier(playerId, tier, week)
 *   getWeekClose(week) -> { week, closedAt, summary } | null
 *   saveWeekClose(week, summary)
 *   listOpenWeeks() -> week ids that have divisions but no close record
 *   close()
 *
 * `createMemoryStore()` returns the JSON adapter with no file (pure in-memory)
 * for unit tests.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function defaultDbPath() {
  return process.env.CHESS_LEAGUES_DB_PATH || path.join(ROOT, 'leagues.db');
}
function defaultJsonPath() {
  return process.env.CHESS_LEAGUES_JSON_PATH || path.join(ROOT, '.leagues.json');
}

function rowToMembership(r) {
  if (!r) return null;
  return {
    week: r.week,
    playerId: r.player_id,
    username: r.username,
    divisionId: r.division_id,
    points: Number(r.points),
    wins: Number(r.wins),
    draws: Number(r.draws),
    losses: Number(r.losses),
    enrolledAt: Number(r.enrolled_at)
  };
}

class SqliteLeaguesAdapter {
  constructor(dbPath) {
    const { DatabaseSync } = require('node:sqlite');
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS league_members (
        week TEXT NOT NULL,
        player_id TEXT NOT NULL,
        username TEXT NOT NULL,
        division_id TEXT NOT NULL,
        points REAL NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        draws INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        enrolled_at INTEGER NOT NULL,
        PRIMARY KEY (week, player_id)
      );
      CREATE INDEX IF NOT EXISTS idx_league_members_division ON league_members(division_id);
      CREATE TABLE IF NOT EXISTS league_divisions (
        id TEXT PRIMARY KEY,
        week TEXT NOT NULL,
        tier TEXT NOT NULL,
        seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_league_divisions_week ON league_divisions(week, tier, seq);
      CREATE TABLE IF NOT EXISTS league_tiers (
        player_id TEXT PRIMARY KEY,
        tier TEXT NOT NULL,
        week TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS league_weeks (
        week TEXT PRIMARY KEY,
        closed_at INTEGER NOT NULL,
        summary TEXT NOT NULL
      );
    `);
  }

  getMembership(week, playerId) {
    return rowToMembership(this.db.prepare('SELECT * FROM league_members WHERE week = ? AND player_id = ?').get(String(week), String(playerId)));
  }

  saveMembership(m) {
    this.db.prepare(`
      INSERT OR REPLACE INTO league_members (week, player_id, username, division_id, points, wins, draws, losses, enrolled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(String(m.week), String(m.playerId), String(m.username || m.playerId), String(m.divisionId),
      Number(m.points) || 0, Number(m.wins) || 0, Number(m.draws) || 0, Number(m.losses) || 0, Number(m.enrolledAt) || Date.now());
    return m;
  }

  listDivisionMembers(divisionId) {
    return this.db.prepare('SELECT * FROM league_members WHERE division_id = ? ORDER BY enrolled_at ASC, player_id ASC')
      .all(String(divisionId)).map(rowToMembership);
  }

  getDivision(id) {
    const r = this.db.prepare('SELECT * FROM league_divisions WHERE id = ?').get(String(id));
    return r ? { id: r.id, week: r.week, tier: r.tier, seq: Number(r.seq), createdAt: Number(r.created_at) } : null;
  }

  saveDivision(div) {
    this.db.prepare('INSERT OR REPLACE INTO league_divisions (id, week, tier, seq, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(String(div.id), String(div.week), String(div.tier), Number(div.seq) || 0, Number(div.createdAt) || Date.now());
    return div;
  }

  listDivisions(week) {
    return this.db.prepare('SELECT * FROM league_divisions WHERE week = ? ORDER BY tier ASC, seq ASC').all(String(week))
      .map(r => ({ id: r.id, week: r.week, tier: r.tier, seq: Number(r.seq), createdAt: Number(r.created_at) }));
  }

  getPlayerTier(playerId) {
    const r = this.db.prepare('SELECT * FROM league_tiers WHERE player_id = ?').get(String(playerId));
    return r ? { tier: r.tier, week: r.week, updatedAt: Number(r.updated_at) } : null;
  }

  savePlayerTier(playerId, tier, week) {
    this.db.prepare('INSERT OR REPLACE INTO league_tiers (player_id, tier, week, updated_at) VALUES (?, ?, ?, ?)')
      .run(String(playerId), String(tier), week == null ? null : String(week), Date.now());
  }

  getWeekClose(week) {
    const r = this.db.prepare('SELECT * FROM league_weeks WHERE week = ?').get(String(week));
    if (!r) return null;
    let summary = null;
    try { summary = JSON.parse(r.summary); } catch (_) { summary = null; }
    return { week: r.week, closedAt: Number(r.closed_at), summary };
  }

  saveWeekClose(week, summary) {
    this.db.prepare('INSERT OR REPLACE INTO league_weeks (week, closed_at, summary) VALUES (?, ?, ?)')
      .run(String(week), Date.now(), JSON.stringify(summary || {}));
  }

  listOpenWeeks() {
    return this.db.prepare(`
      SELECT DISTINCT d.week AS week FROM league_divisions d
      LEFT JOIN league_weeks w ON w.week = d.week
      WHERE w.week IS NULL ORDER BY d.week ASC
    `).all().map(r => r.week);
  }

  close() {
    try { this.db.close(); } catch (_) {}
  }
}

class JsonLeaguesAdapter {
  constructor(filePath) {
    this.filePath = filePath || null;
    this.data = { members: {}, divisions: {}, tiers: {}, weeks: {} };
    if (this.filePath) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          this.data.members = parsed.members || {};
          this.data.divisions = parsed.divisions || {};
          this.data.tiers = parsed.tiers || {};
          this.data.weeks = parsed.weeks || {};
        }
      } catch (_) { /* fresh store */ }
    }
  }

  _flush() {
    if (!this.filePath) return;
    try {
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.filePath);
    } catch (_) { /* best effort */ }
  }

  getMembership(week, playerId) {
    const m = this.data.members[`${week}|${playerId}`];
    return m ? Object.assign({}, m) : null;
  }
  saveMembership(m) {
    this.data.members[`${m.week}|${m.playerId}`] = Object.assign({}, m, { username: m.username || m.playerId });
    this._flush();
    return m;
  }
  listDivisionMembers(divisionId) {
    return Object.values(this.data.members)
      .filter(m => m.divisionId === divisionId)
      .sort((a, b) => (a.enrolledAt - b.enrolledAt) || (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0))
      .map(m => Object.assign({}, m));
  }
  getDivision(id) { const d = this.data.divisions[id]; return d ? Object.assign({}, d) : null; }
  saveDivision(div) { this.data.divisions[div.id] = Object.assign({}, div); this._flush(); return div; }
  listDivisions(week) {
    return Object.values(this.data.divisions).filter(d => d.week === week)
      .sort((a, b) => (a.tier < b.tier ? -1 : a.tier > b.tier ? 1 : 0) || (a.seq - b.seq))
      .map(d => Object.assign({}, d));
  }
  getPlayerTier(playerId) { const t = this.data.tiers[playerId]; return t ? Object.assign({}, t) : null; }
  savePlayerTier(playerId, tier, week) {
    this.data.tiers[playerId] = { tier, week: week == null ? null : String(week), updatedAt: Date.now() };
    this._flush();
  }
  getWeekClose(week) { const w = this.data.weeks[week]; return w ? Object.assign({}, w) : null; }
  saveWeekClose(week, summary) { this.data.weeks[week] = { week, closedAt: Date.now(), summary: summary || {} }; this._flush(); }
  listOpenWeeks() {
    const weeks = new Set(Object.values(this.data.divisions).map(d => d.week));
    return [...weeks].filter(w => !this.data.weeks[w]).sort();
  }
  close() {}
}

function createLeaguesStore(options = {}) {
  const dbPath = options.dbPath || defaultDbPath();
  try {
    require('node:sqlite');
    return new SqliteLeaguesAdapter(dbPath);
  } catch (_) {
    return new JsonLeaguesAdapter(options.jsonPath || defaultJsonPath());
  }
}

function createMemoryStore() {
  return new JsonLeaguesAdapter(null);
}

let defaultStore = null;
function getDefaultStore() {
  if (!defaultStore) defaultStore = createLeaguesStore();
  return defaultStore;
}
function resetDefaultStore() {
  if (defaultStore) defaultStore.close();
  defaultStore = null;
}

module.exports = {
  SqliteLeaguesAdapter,
  JsonLeaguesAdapter,
  createLeaguesStore,
  createMemoryStore,
  getDefaultStore,
  resetDefaultStore,
  defaultDbPath,
  defaultJsonPath
};
