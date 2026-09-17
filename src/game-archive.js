'use strict';

let fs = null;
let path = null;
let cryptoMod = null;
if (typeof require === 'function') {
  try { fs = require('fs'); } catch (_) {}
  try { path = require('path'); } catch (_) {}
  try { cryptoMod = require('crypto'); } catch (_) {}
}

let engine = null;
if (typeof require === 'function') {
  try {
    engine = require('./engine.js');
  } catch (_) {
    // engine may not be available in all standalone environments
  }
} else if (typeof window !== 'undefined' && window.engine) {
  engine = window.engine;
}

const DEFAULT_DB_PATH = (typeof process !== 'undefined' && process.env && process.env.CHESS_DB_FILE) || (path ? path.join(__dirname, 'games.db') : 'games.db');
const DEFAULT_JSON_PATH = (typeof process !== 'undefined' && process.env && process.env.CHESS_JSON_ARCHIVE_FILE) || (path ? path.join(__dirname, '.games-archive.json') : '.games-archive.json');

/**
 * Normalizes a FEN to a 4-field cache key by stripping halfmove and fullmove counters.
 * Transpositions (same board, different move counters) share a cache entry.
 * @param {string} fen  Full FEN string.
 * @returns {string}    4-field key: "piecePlacement sideToMove castling enPassant"
 */
function fenCacheKey(fen) {
  if (!fen || typeof fen !== 'string') return '';
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) return fen;
  return parts.slice(0, 4).join(' ');
}

let _lastCreatedAt = 0;
function getNextCreatedAt() {
  const now = Date.now();
  if (now > _lastCreatedAt) {
    _lastCreatedAt = now;
  } else {
    _lastCreatedAt++;
  }
  return _lastCreatedAt;
}

// Standard Opening ECO lookup table for common opening lines
const OPENING_ECO_MAP = {
  'e4': 'B00',
  'e4 e5': 'C20',
  'e4 e5 Nf3': 'C40',
  'e4 e5 Nf3 Nc6': 'C44',
  'e4 e5 Nf3 Nc6 Bc4': 'C50',
  'e4 e5 Nf3 Nc6 Bb5': 'C60',
  'e4 c5': 'B20',
  'e4 c5 Nf3': 'B27',
  'e4 c5 Nf3 d6': 'B50',
  'e4 c5 Nf3 Nc6': 'B30',
  'e4 e6': 'C00',
  'e4 e6 d4 d5': 'C01',
  'e4 c6': 'B10',
  'e4 c6 d4 d5': 'B12',
  'e4 d5': 'B01',
  'e4 d6': 'B07',
  'e4 Nf6': 'B02',
  'e4 g6': 'B06',
  'd4': 'A40',
  'd4 d5': 'D00',
  'd4 d5 c4': 'D06',
  'd4 d5 c4 c6': 'D10',
  'd4 d5 c4 e6': 'D30',
  'd4 Nf6': 'A45',
  'd4 Nf6 c4': 'A50',
  'd4 Nf6 c4 e6': 'E00',
  'd4 Nf6 c4 g6': 'E60',
  'd4 f5': 'A80',
  'c4': 'A10',
  'c4 e5': 'A20',
  'c4 Nf6': 'A15',
  'Nf3': 'A04',
  'Nf3 d5': 'A06',
  'f4': 'A02',
  'g3': 'A00',
  'b3': 'A01'
};

function detectEco(moves) {
  if (!moves) return '';
  const moveList = Array.isArray(moves) ? moves : String(moves).trim().split(/\s+/).filter(Boolean);
  if (moveList.length === 0) return '';
  // Check longest prefix match in opening map
  for (let len = Math.min(moveList.length, 6); len >= 1; len--) {
    const key = moveList.slice(0, len).join(' ');
    if (OPENING_ECO_MAP[key]) {
      return OPENING_ECO_MAP[key];
    }
  }
  return '';
}

function parsePgn(pgnString) {
  if (!pgnString || typeof pgnString !== 'string') {
    return {
      id: '',
      white: 'White',
      black: 'Black',
      date: '',
      result: '*',
      eco: '',
      moves: [],
      movetext: '',
      headers: {},
      pgn: ''
    };
  }

  const headers = {};
  const headerRegex = /^\s*\[([A-Za-z0-9_]+)\s+"([^"\\]*(?:\\.[^"\\]*)*)"\]\s*$/gm;
  let match;
  while ((match = headerRegex.exec(pgnString)) !== null) {
    headers[match[1]] = match[2];
  }

  // Separate headers from movetext
  let body = pgnString.replace(/^\s*\[[A-Za-z0-9_]+\s+"[^"\\]*(?:\\.[^"\\]*)*"\]\s*/gm, '').trim();

  // Strip comments { ... } and ; ...
  body = body
    .replace(/\{[^}]*\}/g, '')
    .replace(/;[^\r\n]*/g, '')
    .replace(/\([^)]*\)/g, '') // strip RAV variations
    .replace(/\$[0-9]+/g, ''); // strip NAGs

  // Extract result if at end
  let result = headers.Result || '*';
  const resMatch = body.match(/(1-0|0-1|1\/2-1\/2|\*)\s*$/);
  if (resMatch) {
    result = resMatch[1];
    body = body.slice(0, resMatch.index).trim();
  }

  // Extract move tokens (filter out move numbers like "1.", "1...", "2.")
  const rawTokens = body.split(/\s+/).filter(Boolean);
  const moves = [];
  for (const t of rawTokens) {
    if (/^\d+\.+$/.test(t)) continue;
    const clean = t.replace(/^\d+\.+/, '');
    if (clean && !['1-0', '0-1', '1/2-1/2', '*'].includes(clean)) {
      moves.push(clean);
    }
  }

  // Format clean movetext
  const tokens = [];
  for (let i = 0; i < moves.length; i += 2) {
    const num = Math.floor(i / 2) + 1;
    const w = moves[i];
    const b = moves[i + 1];
    tokens.push(`${num}. ${w}${b ? ' ' + b : ''}`);
  }
  const cleanMovetext = tokens.join(' ');

  const eco = headers.ECO || detectEco(moves);

  return {
    id: headers.Id || headers.Round && headers.Round !== '-' ? headers.Round : '',
    white: headers.White || 'White',
    black: headers.Black || 'Black',
    date: headers.Date || '',
    result,
    eco,
    moves,
    movetext: cleanMovetext,
    headers,
    pgn: pgnString.trim()
  };
}

function exportPgn(game) {
  if (!game) return '';
  const headers = Object.assign({}, game.headers || {});

  const white = game.white || headers.White || 'White';
  const black = game.black || headers.Black || 'Black';
  const date = game.date || headers.Date || new Date().toISOString().slice(0, 10).replace(/-/g, '.');
  const result = game.result || headers.Result || '*';
  let eco = game.eco || headers.ECO || '';

  headers.Event = headers.Event || 'Casual Game';
  headers.Site = headers.Site || 'Local Chess';
  headers.Date = date;
  headers.Round = headers.Round || '-';
  headers.White = white;
  headers.Black = black;
  headers.Result = result;

  // Process moves
  let sanMoves = [];
  if (Array.isArray(game.moves)) {
    // If moves are UCI (e.g. 'e2e4'), convert to SAN if engine is available
    if (game.moves.length > 0 && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(game.moves[0]) && engine && typeof engine.historyToSan === 'function') {
      try {
        sanMoves = engine.historyToSan(game.moves);
      } catch (_) {
        sanMoves = game.moves;
      }
    } else {
      sanMoves = game.moves;
    }
  } else if (typeof game.moves === 'string' && game.moves.trim()) {
    const trimmed = game.moves.trim();
    if (/^\d+\./.test(trimmed)) {
      // already formatted movetext, parse moves out
      const parsed = parsePgn(trimmed);
      sanMoves = parsed.moves;
    } else {
      const split = trimmed.split(/\s+/).filter(Boolean);
      if (split.length > 0 && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(split[0]) && engine && typeof engine.historyToSan === 'function') {
        try {
          sanMoves = engine.historyToSan(split);
        } catch (_) {
          sanMoves = split;
        }
      } else {
        sanMoves = split;
      }
    }
  } else if (game.pgn) {
    const parsed = parsePgn(game.pgn);
    sanMoves = parsed.moves;
    if (!eco && parsed.eco) eco = parsed.eco;
  }

  if (!eco && sanMoves.length > 0) {
    eco = detectEco(sanMoves);
  }
  if (eco) {
    headers.ECO = eco;
  }

  const standardTags = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'];
  const headerLines = [];
  for (const tag of standardTags) {
    headerLines.push(`[${tag} "${headers[tag] || '?' }"]`);
  }
  for (const tag of Object.keys(headers)) {
    if (!standardTags.includes(tag)) {
      headerLines.push(`[${tag} "${headers[tag]}"]`);
    }
  }

  const tokens = [];
  for (let i = 0; i < sanMoves.length; i += 2) {
    const num = Math.floor(i / 2) + 1;
    const w = sanMoves[i];
    const b = sanMoves[i + 1];
    tokens.push(`${num}. ${w}${b ? ' ' + b : ''}`);
  }
  const movetext = tokens.join(' ');

  return `${headerLines.join('\n')}\n\n${movetext ? movetext + ' ' : ''}${result}`.trim();
}

/**
 * SqliteStorageAdapter: backed by Node.js native `node:sqlite` DatabaseSync
 */
class SqliteStorageAdapter {
  constructor(dbPath) {
    const { DatabaseSync } = require('node:sqlite');
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this._initSchema();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        white TEXT,
        black TEXT,
        date TEXT,
        result TEXT,
        eco TEXT,
        pgn TEXT,
        moves TEXT,
        created_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_games_created_at ON games(created_at DESC);
      CREATE TABLE IF NOT EXISTS eval_cache (
        fen TEXT PRIMARY KEY,
        cp REAL,
        depth INTEGER,
        mate INTEGER,
        bestmove TEXT,
        created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS puzzle_ratings (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        rating REAL NOT NULL,
        rd REAL NOT NULL,
        vol REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (kind, id)
      );
      CREATE TABLE IF NOT EXISTS ratings_pool (
        pool TEXT NOT NULL,
        player_id TEXT NOT NULL,
        username TEXT NOT NULL,
        rating REAL NOT NULL,
        rd REAL NOT NULL,
        vol REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (pool, player_id)
      );
      CREATE INDEX IF NOT EXISTS idx_ratings_pool_rank
        ON ratings_pool(pool, rating DESC);
      CREATE TABLE IF NOT EXISTS puzzle_reviews (
        puzzle_id TEXT PRIMARY KEY,
        next_due_at INTEGER NOT NULL,
        interval_days INTEGER NOT NULL,
        step INTEGER NOT NULL DEFAULT 0,
        review_count INTEGER NOT NULL DEFAULT 0,
        last_reviewed_at INTEGER,
        correct_streak INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        window_start INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  save(record) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO games (id, white, black, date, result, eco, pgn, moves, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      record.id,
      record.white,
      record.black,
      record.date,
      record.result,
      record.eco,
      record.pgn,
      record.moves,
      record.created_at
    );
    return record;
  }

  get(id) {
    const stmt = this.db.prepare('SELECT * FROM games WHERE id = ?');
    const row = stmt.get(id);
    return row ? Object.assign({}, row) : null;
  }

  list(options = {}) {
    const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : 50;
    const offset = typeof options.offset === 'number' && options.offset >= 0 ? options.offset : 0;
    const order = options.sort && String(options.sort).toUpperCase().includes('ASC') ? 'ASC' : 'DESC';
    const stmt = this.db.prepare(`SELECT * FROM games ORDER BY created_at ${order}, rowid ${order} LIMIT ? OFFSET ?`);
    const rows = stmt.all(limit, offset);
    return rows.map(r => Object.assign({}, r));
  }

  search(query, options = {}) {
    const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : 50;
    const offset = typeof options.offset === 'number' && options.offset >= 0 ? options.offset : 0;

    if (typeof query === 'string') {
      const pattern = `%${query.trim()}%`;
      const stmt = this.db.prepare(`
        SELECT * FROM games
        WHERE white LIKE ? OR black LIKE ? OR eco LIKE ? OR result LIKE ? OR moves LIKE ? OR id LIKE ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ? OFFSET ?
      `);
      const rows = stmt.all(pattern, pattern, pattern, pattern, pattern, pattern, limit, offset);
      return rows.map(r => Object.assign({}, r));
    }

    if (typeof query === 'object' && query !== null) {
      const clauses = [];
      const params = [];
      if (query.white) { clauses.push('white LIKE ?'); params.push(`%${query.white}%`); }
      if (query.black) { clauses.push('black LIKE ?'); params.push(`%${query.black}%`); }
      if (query.eco) { clauses.push('eco LIKE ?'); params.push(`%${query.eco}%`); }
      if (query.result) { clauses.push('result = ?'); params.push(query.result); }
      if (query.id) { clauses.push('id = ?'); params.push(query.id); }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      params.push(limit, offset);
      const stmt = this.db.prepare(`SELECT * FROM games ${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`);
      const rows = stmt.all(...params);
      return rows.map(r => Object.assign({}, r));
    }

    return this.list(options);
  }

  saveEval(fen, evalData) {
    if (!fen) return null;
    const key = fenCacheKey(fen);
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO eval_cache (fen, cp, depth, mate, bestmove, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      key,
      evalData.cp != null ? evalData.cp : null,
      evalData.depth != null ? evalData.depth : null,
      evalData.mate != null ? evalData.mate : null,
      evalData.bestmove || null,
      Date.now()
    );
    return { fen: key, ...evalData };
  }

  getEval(fen) {
    if (!fen) return null;
    const key = fenCacheKey(fen);
    const stmt = this.db.prepare('SELECT * FROM eval_cache WHERE fen = ?');
    const row = stmt.get(key);
    if (!row) return null;
    return { fen: row.fen, cp: row.cp, depth: row.depth, mate: row.mate, bestmove: row.bestmove, created_at: row.created_at };
  }

  savePuzzleRating(kind, id, ratingData) {
    if (!kind || !id || !ratingData) return null;
    const entry = {
      kind: String(kind),
      id: String(id),
      rating: ratingData.rating,
      rd: ratingData.rd,
      vol: ratingData.vol,
      updated_at: Date.now()
    };
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO puzzle_ratings (kind, id, rating, rd, vol, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(entry.kind, entry.id, entry.rating, entry.rd, entry.vol, entry.updated_at);
    return entry;
  }

  getPuzzleRating(kind, id) {
    if (!kind || !id) return null;
    const stmt = this.db.prepare('SELECT * FROM puzzle_ratings WHERE kind = ? AND id = ?');
    const row = stmt.get(String(kind), String(id));
    return row ? Object.assign({}, row) : null;
  }

  savePoolRating(pool, playerId, ratingData) {
    if (!pool || !playerId || !ratingData) return null;
    const entry = {
      pool: String(pool),
      playerId: String(playerId),
      username: String(ratingData.username || playerId),
      rating: ratingData.rating,
      rd: ratingData.rd,
      vol: ratingData.vol,
      updatedAt: Date.now()
    };
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO ratings_pool
        (pool, player_id, username, rating, rd, vol, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(entry.pool, entry.playerId, entry.username, entry.rating, entry.rd, entry.vol, entry.updatedAt);
    return entry;
  }

  getPoolRating(pool, playerId) {
    if (!pool || !playerId) return null;
    const row = this.db.prepare(
      'SELECT * FROM ratings_pool WHERE pool = ? AND player_id = ?'
    ).get(String(pool), String(playerId));
    return row ? {
      pool: row.pool,
      playerId: row.player_id,
      username: row.username,
      rating: row.rating,
      rd: row.rd,
      vol: row.vol,
      updatedAt: row.updated_at
    } : null;
  }

  listPoolRatings(pool) {
    if (!pool) return [];
    const rows = this.db.prepare(
      'SELECT * FROM ratings_pool WHERE pool = ? ORDER BY rating DESC, player_id ASC'
    ).all(String(pool));
    return rows.map(row => ({
      pool: row.pool,
      playerId: row.player_id,
      username: row.username,
      rating: row.rating,
      rd: row.rd,
      vol: row.vol,
      updatedAt: row.updated_at
    }));
  }

  savePuzzleReview(reviewRecord) {
    if (!reviewRecord || !reviewRecord.puzzleId) return null;
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO puzzle_reviews
        (puzzle_id, next_due_at, interval_days, step, review_count, last_reviewed_at, correct_streak)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      String(reviewRecord.puzzleId),
      reviewRecord.nextDueAt,
      reviewRecord.intervalDays,
      reviewRecord.step || 0,
      reviewRecord.reviewCount || 0,
      reviewRecord.lastReviewedAt || null,
      reviewRecord.correctStreak || 0
    );
    return Object.assign({}, reviewRecord);
  }

  getPuzzleReview(puzzleId) {
    if (!puzzleId) return null;
    const stmt = this.db.prepare('SELECT * FROM puzzle_reviews WHERE puzzle_id = ?');
    const row = stmt.get(String(puzzleId));
    if (!row) return null;
    return {
      puzzleId: row.puzzle_id,
      nextDueAt: row.next_due_at,
      intervalDays: row.interval_days,
      step: row.step,
      reviewCount: row.review_count,
      lastReviewedAt: row.last_reviewed_at,
      correctStreak: row.correct_streak
    };
  }

  getRateLimit(key) {
    if (!key) return null;
    const row = this.db.prepare('SELECT * FROM rate_limits WHERE key = ?').get(String(key));
    if (!row) return null;
    return { key: row.key, count: row.count, windowStart: row.window_start, updatedAt: row.updated_at };
  }

  saveRateLimit(key, record) {
    if (!key || !record) return null;
    const entry = {
      key: String(key),
      count: Number(record.count) || 0,
      windowStart: Number(record.windowStart) || 0,
      updatedAt: Number(record.updatedAt) || Date.now()
    };
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO rate_limits (key, count, window_start, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(entry.key, entry.count, entry.windowStart, entry.updatedAt);
    return entry;
  }

  close() {
    if (this.db) {
      try { this.db.close(); } catch (_) { /* ignore */ }
    }
  }
}

/**
 * JsonFileStorageAdapter: resilient fallback when SQLite is unavailable
 */
class JsonFileStorageAdapter {
  constructor(filePath) {
    this.filePath = filePath;
    this.games = new Map();
    this.evalCache = new Map();
    this.puzzleRatings = new Map();
    this.ratingsPool = new Map();
    this.puzzleReviews = new Map();
    this.rateLimits = new Map();
    this._load();
  }

  _load() {
    if (!this.filePath || this.filePath === ':memory:' || !fs) {
      this.games = new Map();
      this.evalCache = new Map();
      this.puzzleRatings = new Map();
      this.ratingsPool = new Map();
      this.puzzleReviews = new Map();
      this.rateLimits = new Map();
      return;
    }
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && item.id) this.games.set(item.id, item);
          }
        } else if (parsed && typeof parsed === 'object') {
          if (Array.isArray(parsed.games)) {
            for (const item of parsed.games) {
              if (item && item.id) this.games.set(item.id, item);
            }
          }
          if (parsed.evalCache && typeof parsed.evalCache === 'object') {
            for (const [k, v] of Object.entries(parsed.evalCache)) {
              this.evalCache.set(k, v);
            }
          }
          if (parsed.puzzleRatings && typeof parsed.puzzleRatings === 'object') {
            for (const [k, v] of Object.entries(parsed.puzzleRatings)) {
              this.puzzleRatings.set(k, v);
            }
          }
          if (parsed.ratingsPool && typeof parsed.ratingsPool === 'object') {
            for (const [k, v] of Object.entries(parsed.ratingsPool)) {
              this.ratingsPool.set(k, v);
            }
          }
          if (parsed.puzzleReviews && typeof parsed.puzzleReviews === 'object') {
            for (const [k, v] of Object.entries(parsed.puzzleReviews)) {
              this.puzzleReviews.set(k, v);
            }
          }
          if (parsed.rateLimits && typeof parsed.rateLimits === 'object') {
            for (const [k, v] of Object.entries(parsed.rateLimits)) {
              this.rateLimits.set(k, v);
            }
          }
        }
      }
    } catch (_) {
      this.games = new Map();
      this.evalCache = new Map();
      this.puzzleRatings = new Map();
      this.ratingsPool = new Map();
      this.puzzleReviews = new Map();
      this.rateLimits = new Map();
    }
  }

  _saveToDisk() {
    if (!this.filePath || this.filePath === ':memory:' || !fs) return;
    try {
      const games = Array.from(this.games.values());
      const evalCacheObj = {};
      for (const [k, v] of this.evalCache) {
        evalCacheObj[k] = v;
      }
      const puzzleRatingsObj = {};
      for (const [k, v] of this.puzzleRatings) {
        puzzleRatingsObj[k] = v;
      }
      const ratingsPoolObj = {};
      for (const [k, v] of this.ratingsPool) {
        ratingsPoolObj[k] = v;
      }
      const puzzleReviewsObj = {};
      for (const [k, v] of this.puzzleReviews) {
        puzzleReviewsObj[k] = v;
      }
      const rateLimitsObj = {};
      for (const [k, v] of this.rateLimits) {
        rateLimitsObj[k] = v;
      }
      const payload = JSON.stringify({ games, evalCache: evalCacheObj, puzzleRatings: puzzleRatingsObj, ratingsPool: ratingsPoolObj, puzzleReviews: puzzleReviewsObj, rateLimits: rateLimitsObj }, null, 2);
      const tempPath = `${this.filePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tempPath, payload, 'utf8');
      fs.renameSync(tempPath, this.filePath);
    } catch (_) {
      // non-fatal on write failure
    }
  }

  save(record) {
    this.games.set(record.id, Object.assign({}, record));
    this._saveToDisk();
    return record;
  }

  get(id) {
    const item = this.games.get(id);
    return item ? Object.assign({}, item) : null;
  }

  list(options = {}) {
    const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : 50;
    const offset = typeof options.offset === 'number' && options.offset >= 0 ? options.offset : 0;
    const order = options.sort && String(options.sort).toUpperCase().includes('ASC') ? 'ASC' : 'DESC';

    const list = Array.from(this.games.values()).sort((a, b) => {
      const diff = (a.created_at || 0) - (b.created_at || 0);
      return order === 'ASC' ? diff : -diff;
    });

    return list.slice(offset, offset + limit);
  }

  search(query, options = {}) {
    const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : 50;
    const offset = typeof options.offset === 'number' && options.offset >= 0 ? options.offset : 0;

    let filtered = Array.from(this.games.values());

    if (typeof query === 'string') {
      const q = query.trim().toLowerCase();
      filtered = filtered.filter(g =>
        (g.white && g.white.toLowerCase().includes(q)) ||
        (g.black && g.black.toLowerCase().includes(q)) ||
        (g.eco && g.eco.toLowerCase().includes(q)) ||
        (g.result && g.result.toLowerCase().includes(q)) ||
        (g.moves && g.moves.toLowerCase().includes(q)) ||
        (g.id && g.id.toLowerCase().includes(q))
      );
    } else if (typeof query === 'object' && query !== null) {
      filtered = filtered.filter(g => {
        if (query.white && (!g.white || !g.white.toLowerCase().includes(query.white.toLowerCase()))) return false;
        if (query.black && (!g.black || !g.black.toLowerCase().includes(query.black.toLowerCase()))) return false;
        if (query.eco && (!g.eco || !g.eco.toLowerCase().includes(query.eco.toLowerCase()))) return false;
        if (query.result && g.result !== query.result) return false;
        if (query.id && g.id !== query.id) return false;
        return true;
      });
    }

    filtered.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    return filtered.slice(offset, offset + limit);
  }

  saveEval(fen, evalData) {
    if (!fen) return null;
    const key = fenCacheKey(fen);
    const entry = { fen: key, cp: evalData.cp, depth: evalData.depth, mate: evalData.mate, bestmove: evalData.bestmove, created_at: Date.now() };
    this.evalCache.set(key, entry);
    this._saveToDisk();
    return entry;
  }

  getEval(fen) {
    if (!fen) return null;
    const key = fenCacheKey(fen);
    const item = this.evalCache.get(key);
    return item ? Object.assign({}, item) : null;
  }

  savePuzzleRating(kind, id, ratingData) {
    if (!kind || !id || !ratingData) return null;
    const entry = {
      kind: String(kind),
      id: String(id),
      rating: ratingData.rating,
      rd: ratingData.rd,
      vol: ratingData.vol,
      updated_at: Date.now()
    };
    this.puzzleRatings.set(`${entry.kind}:${entry.id}`, entry);
    this._saveToDisk();
    return Object.assign({}, entry);
  }

  getPuzzleRating(kind, id) {
    if (!kind || !id) return null;
    const item = this.puzzleRatings.get(`${String(kind)}:${String(id)}`);
    return item ? Object.assign({}, item) : null;
  }

  savePoolRating(pool, playerId, ratingData) {
    if (!pool || !playerId || !ratingData) return null;
    const entry = {
      pool: String(pool),
      playerId: String(playerId),
      username: String(ratingData.username || playerId),
      rating: ratingData.rating,
      rd: ratingData.rd,
      vol: ratingData.vol,
      updatedAt: Date.now()
    };
    this.ratingsPool.set(`${entry.pool}:${entry.playerId}`, entry);
    this._saveToDisk();
    return Object.assign({}, entry);
  }

  getPoolRating(pool, playerId) {
    if (!pool || !playerId) return null;
    const item = this.ratingsPool.get(`${String(pool)}:${String(playerId)}`);
    return item ? Object.assign({}, item) : null;
  }

  listPoolRatings(pool) {
    if (!pool) return [];
    const poolKey = String(pool);
    return Array.from(this.ratingsPool.values())
      .filter(item => item.pool === poolKey)
      .sort((left, right) => right.rating - left.rating || left.playerId.localeCompare(right.playerId))
      .map(item => Object.assign({}, item));
  }

  savePuzzleReview(reviewRecord) {
    if (!reviewRecord || !reviewRecord.puzzleId) return null;
    const entry = Object.assign({}, reviewRecord);
    this.puzzleReviews.set(String(reviewRecord.puzzleId), entry);
    this._saveToDisk();
    return entry;
  }

  getPuzzleReview(puzzleId) {
    if (!puzzleId) return null;
    const item = this.puzzleReviews.get(String(puzzleId));
    return item ? Object.assign({}, item) : null;
  }

  getRateLimit(key) {
    if (!key) return null;
    const item = this.rateLimits.get(String(key));
    return item ? Object.assign({}, item) : null;
  }

  saveRateLimit(key, record) {
    if (!key || !record) return null;
    const entry = {
      key: String(key),
      count: Number(record.count) || 0,
      windowStart: Number(record.windowStart) || 0,
      updatedAt: Number(record.updatedAt) || Date.now()
    };
    this.rateLimits.set(entry.key, entry);
    this._saveToDisk();
    return Object.assign({}, entry);
  }

  close() {
    this._saveToDisk();
  }
}

/**
 * GameArchive: High-level database manager supporting node:sqlite with JSON fallback
 */
class GameArchive {
  constructor(options = {}) {
    let dbPath = typeof options === 'string' ? options : (options.dbPath || DEFAULT_DB_PATH);
    const forceJson = options.forceJson === true || process.env.CHESS_ARCHIVE_FORCE_JSON === '1';

    this.backendType = 'json';
    this.storage = null;

    if (!forceJson) {
      try {
        this.storage = new SqliteStorageAdapter(dbPath);
        this.backendType = 'sqlite';
      } catch (err) {
        // Fallback to JSON if SQLite is unavailable
        this.storage = null;
      }
    }

    if (!this.storage) {
      const jsonPath = typeof options === 'string' ? options : (options.jsonPath || DEFAULT_JSON_PATH);
      this.storage = new JsonFileStorageAdapter(jsonPath);
      this.backendType = 'json';
    }
  }

  saveGame(data) {
    if (!data) throw new Error('saveGame: data object is required');
    const game = Object.assign({}, data);

    // If PGN string was passed, parse it to extract metadata and moves
    if (game.pgn && typeof game.pgn === 'string') {
      const parsed = parsePgn(game.pgn);
      if (!game.white || game.white === 'White') game.white = parsed.white;
      if (!game.black || game.black === 'Black') game.black = parsed.black;
      if (!game.date) game.date = parsed.date;
      if (!game.result || game.result === '*') game.result = parsed.result;
      if (!game.eco) game.eco = parsed.eco;
      if (!game.moves || (Array.isArray(game.moves) && game.moves.length === 0)) {
        game.moves = parsed.moves;
      }
    }

    // Ensure primary ID
    if (!game.id) {
      game.id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'game_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    }

    // Fallbacks
    if (!game.white) game.white = 'White';
    if (!game.black) game.black = 'Black';
    if (!game.date) game.date = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
    if (!game.result) game.result = '*';

    // Moves string representation
    let movesStr = '';
    if (Array.isArray(game.moves)) {
      movesStr = game.moves.join(' ');
    } else if (typeof game.moves === 'string') {
      movesStr = game.moves.trim();
    }

    // ECO code
    if (!game.eco) {
      game.eco = detectEco(game.moves);
    }

    // Generate full PGN if not provided
    if (!game.pgn) {
      game.pgn = exportPgn(game);
    }

    const record = {
      id: String(game.id),
      white: String(game.white),
      black: String(game.black),
      date: String(game.date),
      result: String(game.result),
      eco: String(game.eco || ''),
      pgn: String(game.pgn),
      moves: movesStr,
      created_at: Number(game.created_at || getNextCreatedAt())
    };

    return this.storage.save(record);
  }

  getGame(id) {
    if (!id) return null;
    return this.storage.get(String(id));
  }

  listGames(options = {}) {
    return this.storage.list(options);
  }

  searchGames(query, options = {}) {
    return this.storage.search(query, options);
  }

  saveEval(fen, evalData) {
    if (!this.storage || typeof this.storage.saveEval !== 'function') return null;
    try {
      return this.storage.saveEval(fen, evalData);
    } catch (_) {
      return null;
    }
  }

  getEval(fen) {
    if (!this.storage || typeof this.storage.getEval !== 'function') return null;
    try {
      return this.storage.getEval(fen);
    } catch (_) {
      return null;
    }
  }

  savePuzzleRating(kind, id, ratingData) {
    if (!this.storage || typeof this.storage.savePuzzleRating !== 'function') return null;
    try {
      return this.storage.savePuzzleRating(kind, id, ratingData);
    } catch (_) {
      return null;
    }
  }

  getPuzzleRating(kind, id) {
    if (!this.storage || typeof this.storage.getPuzzleRating !== 'function') return null;
    try {
      return this.storage.getPuzzleRating(kind, id);
    } catch (_) {
      return null;
    }
  }

  savePoolRating(pool, playerId, ratingData) {
    if (!this.storage || typeof this.storage.savePoolRating !== 'function') return null;
    try {
      return this.storage.savePoolRating(pool, playerId, ratingData);
    } catch (_) {
      return null;
    }
  }

  getPoolRating(pool, playerId) {
    if (!this.storage || typeof this.storage.getPoolRating !== 'function') return null;
    try {
      return this.storage.getPoolRating(pool, playerId);
    } catch (_) {
      return null;
    }
  }

  listPoolRatings(pool) {
    if (!this.storage || typeof this.storage.listPoolRatings !== 'function') return [];
    try {
      return this.storage.listPoolRatings(pool);
    } catch (_) {
      return [];
    }
  }

  savePuzzleReview(reviewRecord) {
    if (!this.storage || typeof this.storage.savePuzzleReview !== 'function') return null;
    try {
      return this.storage.savePuzzleReview(reviewRecord);
    } catch (_) {
      return null;
    }
  }

  getPuzzleReview(puzzleId) {
    if (!this.storage || typeof this.storage.getPuzzleReview !== 'function') return null;
    try {
      return this.storage.getPuzzleReview(puzzleId);
    } catch (_) {
      return null;
    }
  }

  getRateLimit(key) {
    if (!this.storage || typeof this.storage.getRateLimit !== 'function') return null;
    try {
      return this.storage.getRateLimit(key);
    } catch (_) {
      return null;
    }
  }

  saveRateLimit(key, record) {
    if (!this.storage || typeof this.storage.saveRateLimit !== 'function') return null;
    try {
      return this.storage.saveRateLimit(key, record);
    } catch (_) {
      return null;
    }
  }

  exportPgn(game) {
    return exportPgn(game);
  }

  parsePgn(pgnString) {
    return parsePgn(pgnString);
  }

  close() {
    if (this.storage && typeof this.storage.close === 'function') {
      this.storage.close();
    }
  }
}

let _defaultArchive = null;
function getArchive() {
  if (!_defaultArchive) {
    _defaultArchive = new GameArchive();
  }
  return _defaultArchive;
}

function resetArchive() {
  if (_defaultArchive) {
    _defaultArchive.close();
    _defaultArchive = null;
  }
}

function createGameArchive(options) {
  return new GameArchive(options);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GameArchive,
    SqliteStorageAdapter,
    JsonFileStorageAdapter,
    createGameArchive,
    getArchive,
    resetArchive,
    saveGame: (data) => getArchive().saveGame(data),
    getGame: (id) => getArchive().getGame(id),
    listGames: (options) => getArchive().listGames(options),
    searchGames: (query, options) => getArchive().searchGames(query, options),
    saveEval: (fen, evalData) => getArchive().saveEval(fen, evalData),
    getEval: (fen) => getArchive().getEval(fen),
    savePuzzleRating: (kind, id, ratingData) => getArchive().savePuzzleRating(kind, id, ratingData),
    getPuzzleRating: (kind, id) => getArchive().getPuzzleRating(kind, id),
    savePoolRating: (pool, playerId, ratingData) => getArchive().savePoolRating(pool, playerId, ratingData),
    getPoolRating: (pool, playerId) => getArchive().getPoolRating(pool, playerId),
    listPoolRatings: (pool) => getArchive().listPoolRatings(pool),
    savePuzzleReview: (reviewRecord) => getArchive().savePuzzleReview(reviewRecord),
    getPuzzleReview: (puzzleId) => getArchive().getPuzzleReview(puzzleId),
    saveRateLimit: (key, record) => getArchive().saveRateLimit(key, record),
    getRateLimit: (key) => getArchive().getRateLimit(key),
    fenCacheKey,
    exportPgn,
    parsePgn,
    detectEco,
    DEFAULT_DB_PATH,
    DEFAULT_JSON_PATH
  };
}

if (typeof window !== 'undefined') {
  window.GameArchive = {
    exportPgn,
    parsePgn,
    detectEco
  };
}
