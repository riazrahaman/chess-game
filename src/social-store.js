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
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_DB_PATH = process.env.CHESS_SOCIAL_DB_PATH || path.join(ROOT, 'social.db');
const DEFAULT_JSON_PATH = process.env.CHESS_SOCIAL_JSON_PATH || path.join(ROOT, '.social.json');

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
    `);
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

class JsonSocialAdapter {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { graph: { follows: {}, blocks: {} }, arenas: {} };
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.data.graph = parsed.graph || this.data.graph;
        this.data.arenas = parsed.arenas || {};
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
  close() {}
}

function createSocialStore(options = {}) {
  if (options.forceJson !== true) {
    try {
      return new SqliteSocialAdapter(options.dbPath || DEFAULT_DB_PATH);
    } catch (_) { /* fall through */ }
  }
  return new JsonSocialAdapter(options.jsonPath || DEFAULT_JSON_PATH);
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
  DEFAULT_DB_PATH,
  DEFAULT_JSON_PATH
};
