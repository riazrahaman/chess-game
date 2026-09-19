'use strict';

/**
 * study-store.js — persistence for Study chapters (roadmap A2.2).
 *
 * A chapter is an author-created study line with three kinds:
 *   'pgn'  — parsed from a PGN via study-tree.fromPGN (RAV variations + NAGs kept)
 *   'fen'  — a start FEN plus a recorded line of moves
 *   'game' — an archived game imported by id (game-archive.getGame)
 *
 * Rows live in node:sqlite (`CHESS_STUDY_DB_PATH`, default <repo>/study.db,
 * gitignored via `*.db`). When node:sqlite is unavailable the store degrades to
 * an in-memory map mirrored to a JSON file (`CHESS_STUDY_JSON_PATH`, default
 * <repo>/.study.json), matching social-store.js / accounts.js / game-archive.js.
 *
 * The stored shape is deliberately serialization-safe: `tree` is a plain
 * nested node object (no parent links), `solution`/`solutionSan` are flat
 * arrays. The route module rehydrates the study-tree from `tree` only when it
 * needs PGN export, so `study-tree.js` stays the single source of PGN/NAG
 * truth.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
function defaultDbPath() {
  return process.env.CHESS_STUDY_DB_PATH || path.join(ROOT, 'study.db');
}
function defaultJsonPath() {
  return process.env.CHESS_STUDY_JSON_PATH || path.join(ROOT, '.study.json');
}

function rowToChapter(row) {
  return {
    id: row.id,
    owner: row.owner_id == null ? null : String(row.owner_id),
    kind: row.kind,
    title: row.title,
    startFen: row.start_fen,
    solution: parseJson(row.solution, []),
    solutionSan: parseJson(row.solution_san, []),
    tree: parseJson(row.tree, null),
    quiz: Number(row.quiz) === 1,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0
  };
}

function parseJson(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}

class SqliteStudyAdapter {
  constructor(dbPath) {
    const { DatabaseSync } = require('node:sqlite');
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS study_chapters (
        id TEXT PRIMARY KEY,
        owner_id TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        start_fen TEXT NOT NULL,
        solution TEXT NOT NULL,
        solution_san TEXT NOT NULL,
        tree TEXT NOT NULL,
        quiz INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_study_chapters_owner ON study_chapters(owner_id);
      CREATE TABLE IF NOT EXISTS study_reveals (
        chapter_id TEXT NOT NULL,
        viewer_key TEXT NOT NULL,
        revealed_at INTEGER NOT NULL,
        PRIMARY KEY (chapter_id, viewer_key)
      );
    `);
  }

  saveChapter(chapter) {
    const existing = this.db.prepare('SELECT created_at FROM study_chapters WHERE id = ?').get(String(chapter.id));
    const createdAt = existing ? Number(existing.created_at) : (Number(chapter.createdAt) || Date.now());
    const updatedAt = Date.now();
    this.db.prepare(`
      INSERT OR REPLACE INTO study_chapters
        (id, owner_id, kind, title, start_fen, solution, solution_san, tree, quiz, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(chapter.id),
      chapter.owner == null ? null : String(chapter.owner),
      String(chapter.kind),
      String(chapter.title || ''),
      String(chapter.startFen || ''),
      JSON.stringify(chapter.solution || []),
      JSON.stringify(chapter.solutionSan || []),
      JSON.stringify(chapter.tree || null),
      chapter.quiz ? 1 : 0,
      createdAt,
      updatedAt
    );
    return Object.assign({}, chapter, { createdAt, updatedAt });
  }

  getChapter(id) {
    if (!id) return null;
    const row = this.db.prepare('SELECT * FROM study_chapters WHERE id = ?').get(String(id));
    return row ? rowToChapter(row) : null;
  }

  listChapters(options = {}) {
    const owner = options.owner == null ? null : String(options.owner);
    const rows = owner == null
      ? this.db.prepare('SELECT * FROM study_chapters WHERE owner_id IS NULL ORDER BY updated_at DESC').all()
      : this.db.prepare('SELECT * FROM study_chapters WHERE owner_id = ? ORDER BY updated_at DESC').all(owner);
    return rows.map(rowToChapter);
  }

  deleteChapter(id) {
    const result = this.db.prepare('DELETE FROM study_chapters WHERE id = ?').run(String(id));
    if (Number(result.changes) > 0) this.db.prepare('DELETE FROM study_reveals WHERE chapter_id = ?').run(String(id));
    return Number(result.changes) > 0;
  }

  markRevealed(chapterId, viewerKey) {
    this.db.prepare('INSERT OR IGNORE INTO study_reveals (chapter_id, viewer_key, revealed_at) VALUES (?, ?, ?)')
      .run(String(chapterId), String(viewerKey), Date.now());
  }

  isRevealed(chapterId, viewerKey) {
    const row = this.db.prepare('SELECT 1 AS hit FROM study_reveals WHERE chapter_id = ? AND viewer_key = ?')
      .get(String(chapterId), String(viewerKey));
    return !!row;
  }

  close() {
    try { this.db.close(); } catch (_) {}
  }
}

class JsonStudyAdapter {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { chapters: {}, reveals: {} };
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.chapters) this.data.chapters = parsed.chapters;
      if (parsed && typeof parsed === 'object' && parsed.reveals) this.data.reveals = parsed.reveals;
    } catch (_) { /* fresh store */ }
  }

  _flush() {
    try {
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.filePath);
    } catch (_) { /* best effort */ }
  }

  saveChapter(chapter) {
    const existing = this.data.chapters[String(chapter.id)];
    const createdAt = existing ? existing.createdAt : (Number(chapter.createdAt) || Date.now());
    const record = {
      id: String(chapter.id),
      owner: chapter.owner == null ? null : String(chapter.owner),
      kind: String(chapter.kind),
      title: String(chapter.title || ''),
      startFen: String(chapter.startFen || ''),
      solution: chapter.solution || [],
      solutionSan: chapter.solutionSan || [],
      tree: chapter.tree || null,
      quiz: !!chapter.quiz,
      createdAt,
      updatedAt: Date.now()
    };
    this.data.chapters[record.id] = record;
    this._flush();
    return record;
  }

  getChapter(id) {
    if (!id) return null;
    const rec = this.data.chapters[String(id)];
    return rec ? Object.assign({}, rec) : null;
  }

  listChapters(options = {}) {
    const owner = options.owner == null ? null : String(options.owner);
    return Object.values(this.data.chapters)
      .filter(c => (c.owner == null ? null : String(c.owner)) === owner)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(c => Object.assign({}, c));
  }

  deleteChapter(id) {
    const key = String(id);
    if (!this.data.chapters[key]) return false;
    delete this.data.chapters[key];
    for (const rk of Object.keys(this.data.reveals)) {
      if (rk.startsWith(key + '|')) delete this.data.reveals[rk];
    }
    this._flush();
    return true;
  }

  markRevealed(chapterId, viewerKey) {
    this.data.reveals[String(chapterId) + '|' + String(viewerKey)] = Date.now();
    this._flush();
  }

  isRevealed(chapterId, viewerKey) {
    return !!this.data.reveals[String(chapterId) + '|' + String(viewerKey)];
  }

  close() {}
}

function createStudyStore(options = {}) {
  if (options.forceJson !== true) {
    try {
      return new SqliteStudyAdapter(options.dbPath || defaultDbPath());
    } catch (_) { /* fall through */ }
  }
  return new JsonStudyAdapter(options.jsonPath || defaultJsonPath());
}

let defaultStore = null;
function getDefaultStudyStore() {
  if (!defaultStore) defaultStore = createStudyStore();
  return defaultStore;
}

function resetDefaultStudyStore() {
  if (defaultStore) defaultStore.close();
  defaultStore = null;
}

module.exports = {
  SqliteStudyAdapter,
  JsonStudyAdapter,
  createStudyStore,
  getDefaultStudyStore,
  resetDefaultStudyStore,
  get DEFAULT_DB_PATH() { return defaultDbPath(); },
  get DEFAULT_JSON_PATH() { return defaultJsonPath(); }
};
