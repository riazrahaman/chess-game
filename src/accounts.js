'use strict';

let cryptoMod = null;
let fs = null;
let path = null;
let MoveReview = null;
if (typeof require === 'function') {
  try { cryptoMod = require('crypto'); } catch (_) {}
  try { fs = require('fs'); } catch (_) {}
  try { path = require('path'); } catch (_) {}
  try { MoveReview = require('./move-review.js'); } catch (_) {}
}
if (!MoveReview && typeof window !== 'undefined') MoveReview = window.MoveReview;

const SCRYPT_KEY_LENGTH = 64;
const DEFAULT_DB_PATH = (typeof process !== 'undefined' && process.env && process.env.CHESS_ACCOUNTS_DB_FILE) ||
  (path ? path.join(__dirname, 'accounts.db') : 'accounts.db');
const DEFAULT_JSON_PATH = (typeof process !== 'undefined' && process.env && process.env.CHESS_ACCOUNTS_JSON_FILE) ||
  (path ? path.join(__dirname, '.accounts.json') : '.accounts.json');

function requireCrypto() {
  if (!cryptoMod || typeof cryptoMod.scryptSync !== 'function') {
    throw new Error('accounts.js: Node crypto.scrypt is required for password operations');
  }
}

function normalizeUsername(username) {
  return typeof username === 'string' ? username.trim() : '';
}

function usernameKey(username) {
  return normalizeUsername(username).toLocaleLowerCase('en-US');
}

/**
 * Hash a password with scrypt and a per-account salt.
 * Stored format: scrypt$<base64 salt>$<base64 64-byte derived key>.
 */
function hashPassword(password, salt) {
  requireCrypto();
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('password must be a non-empty string');
  }
  const saltBuffer = salt == null
    ? cryptoMod.randomBytes(16)
    : (Buffer.isBuffer(salt) ? Buffer.from(salt) : Buffer.from(String(salt), 'utf8'));
  if (saltBuffer.length === 0) throw new TypeError('salt must not be empty');
  const derivedKey = cryptoMod.scryptSync(password, saltBuffer, SCRYPT_KEY_LENGTH);
  return `scrypt$${saltBuffer.toString('base64')}$${derivedKey.toString('base64')}`;
}

function verifyPassword(password, storedHash) {
  requireCrypto();
  if (typeof password !== 'string' || typeof storedHash !== 'string') return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  try {
    const salt = Buffer.from(parts[1], 'base64');
    const expected = Buffer.from(parts[2], 'base64');
    if (salt.length === 0 || expected.length !== SCRYPT_KEY_LENGTH) return false;
    const actual = cryptoMod.scryptSync(password, salt, expected.length);
    return actual.length === expected.length && cryptoMod.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

function publicAccount(account) {
  if (!account) return null;
  return {
    id: String(account.id),
    username: String(account.username),
    createdAt: Number(account.createdAt)
  };
}

class MemoryAccountsAdapter {
  constructor() {
    this.byId = new Map();
    this.byUsername = new Map();
  }

  save(account) {
    const saved = Object.assign({}, account);
    this.byId.set(saved.id, saved);
    this.byUsername.set(saved.usernameKey, saved);
    return Object.assign({}, saved);
  }

  getByUsername(key) {
    const account = this.byUsername.get(String(key));
    return account ? Object.assign({}, account) : null;
  }

  getById(id) {
    const account = this.byId.get(String(id));
    return account ? Object.assign({}, account) : null;
  }

  close() {}
}

class JsonAccountsAdapter extends MemoryAccountsAdapter {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this._load();
  }

  _load() {
    if (!fs || !this.filePath || this.filePath === ':memory:') return;
    try {
      const payload = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const accounts = Array.isArray(payload) ? payload : payload.accounts;
      if (Array.isArray(accounts)) {
        for (const account of accounts) {
          if (account && account.id && account.usernameKey && account.passwordHash) super.save(account);
        }
      }
    } catch (_) {
      // Missing, unreadable, or malformed stores start empty.
    }
  }

  _saveToDisk() {
    if (!fs || !this.filePath || this.filePath === ':memory:') return;
    try {
      const tempPath = `${this.filePath}.tmp.${Date.now()}`;
      const payload = JSON.stringify({ accounts: Array.from(this.byId.values()) }, null, 2);
      fs.writeFileSync(tempPath, payload, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tempPath, this.filePath);
    } catch (_) {
      // Persistence failure is non-fatal; AccountsManager retains memory state.
    }
  }

  save(account) {
    const saved = super.save(account);
    this._saveToDisk();
    return saved;
  }

  close() {
    this._saveToDisk();
  }
}

class SqliteAccountsAdapter {
  constructor(dbPath) {
    const { DatabaseSync } = require('node:sqlite');
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        username_key TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
  }

  save(account) {
    const statement = this.db.prepare(`
      INSERT INTO accounts (id, username, username_key, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    statement.run(account.id, account.username, account.usernameKey, account.passwordHash, account.createdAt);
    return Object.assign({}, account);
  }

  getByUsername(key) {
    const row = this.db.prepare('SELECT * FROM accounts WHERE username_key = ?').get(String(key));
    return row ? {
      id: row.id,
      username: row.username,
      usernameKey: row.username_key,
      passwordHash: row.password_hash,
      createdAt: row.created_at
    } : null;
  }

  getById(id) {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(String(id));
    return row ? {
      id: row.id,
      username: row.username,
      usernameKey: row.username_key,
      passwordHash: row.password_hash,
      createdAt: row.created_at
    } : null;
  }

  close() {
    if (this.db) {
      try { this.db.close(); } catch (_) {}
    }
  }
}

class AccountsManager {
  constructor(options = {}) {
    this.memory = new MemoryAccountsAdapter();
    this.storage = null;

    if (Object.prototype.hasOwnProperty.call(options, 'storage')) {
      this.storage = options.storage;
    } else if (options.forceMemory !== true) {
      if (options.forceJson !== true) {
        try {
          this.storage = new SqliteAccountsAdapter(options.dbPath || DEFAULT_DB_PATH);
        } catch (_) {
          this.storage = null;
        }
      }
      if (!this.storage) {
        try {
          this.storage = new JsonAccountsAdapter(options.jsonPath || DEFAULT_JSON_PATH);
        } catch (_) {
          this.storage = null;
        }
      }
    }
  }

  _getByUsername(key) {
    const cached = this.memory.getByUsername(key);
    if (cached) return cached;
    if (!this.storage || typeof this.storage.getByUsername !== 'function') return null;
    try {
      const stored = this.storage.getByUsername(key);
      if (stored) this.memory.save(stored);
      return stored || null;
    } catch (_) {
      return null;
    }
  }

  _getById(id) {
    const cached = this.memory.getById(id);
    if (cached) return cached;
    if (!this.storage || typeof this.storage.getById !== 'function') return null;
    try {
      const stored = this.storage.getById(id);
      if (stored) this.memory.save(stored);
      return stored || null;
    } catch (_) {
      return null;
    }
  }

  createAccount({ username, password } = {}) {
    requireCrypto();
    const displayName = normalizeUsername(username);
    const key = usernameKey(displayName);
    if (!displayName) throw new TypeError('username must be a non-empty string');
    if (typeof password !== 'string' || password.length === 0) {
      throw new TypeError('password must be a non-empty string');
    }
    if (this._getByUsername(key)) {
      const error = new Error('username already exists');
      error.code = 'ACCOUNT_EXISTS';
      throw error;
    }

    const account = {
      id: cryptoMod.randomUUID ? cryptoMod.randomUUID() : cryptoMod.randomBytes(16).toString('hex'),
      username: displayName,
      usernameKey: key,
      passwordHash: hashPassword(password),
      createdAt: Date.now()
    };

    if (this.storage && typeof this.storage.save === 'function') {
      try { this.storage.save(account); } catch (_) {}
    }
    this.memory.save(account);
    return publicAccount(account);
  }

  verifyAccount({ username, password } = {}) {
    const account = this._getByUsername(usernameKey(username));
    if (!account || !verifyPassword(password, account.passwordHash)) return null;
    return publicAccount(account);
  }

  getAccount(username) {
    return publicAccount(this._getByUsername(usernameKey(username)));
  }

  getAccountById(id) {
    if (id == null) return null;
    return publicAccount(this._getById(String(id)));
  }

  close() {
    if (this.storage && typeof this.storage.close === 'function') {
      try { this.storage.close(); } catch (_) {}
    }
  }
}

function gameResultForPlayer(game, username) {
  const key = usernameKey(username);
  const isWhite = usernameKey(game.white) === key;
  const isBlack = usernameKey(game.black) === key;
  if (!isWhite && !isBlack) return null;
  const result = String(game.result || '').trim();
  if (result === '1/2-1/2' || result === '½-½' || result === 'draw') return 'draw';
  if ((isWhite && result.startsWith('1-0')) || (isBlack && result.startsWith('0-1'))) return 'win';
  if ((isWhite && result.startsWith('0-1')) || (isBlack && result.startsWith('1-0'))) return 'loss';
  return null;
}

function accuracyForPlayer(game, username) {
  const isWhite = usernameKey(game.white) === usernameKey(username);
  const color = isWhite ? 'white' : 'black';
  const colorField = color === 'white' ? 'whiteAccuracy' : 'blackAccuracy';
  const candidates = [
    game[colorField],
    game.review && game.review[colorField],
    game.accuracy && game.accuracy[color]
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }

  if (MoveReview && typeof MoveReview.reviewGame === 'function' && Array.isArray(game.evalHistory)) {
    const moves = Array.isArray(game.moves)
      ? game.moves
      : String(game.moves || '').trim().split(/\s+/).filter(Boolean);
    if (moves.length > 0) {
      try {
        const review = MoveReview.reviewGame(moves, game.evalHistory);
        const value = Number(review && review[colorField]);
        if (Number.isFinite(value)) return value;
      } catch (_) {}
    }
  }
  return null;
}

function roundPercent(value) {
  return Math.round(value * 10) / 10;
}

function emptyProfile(username) {
  return {
    username: normalizeUsername(username),
    games: [],
    totalGames: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    winRate: 0,
    winRateByOpening: [],
    accuracyTrend: []
  };
}

/**
 * Aggregate exact-name archive records into a player profile.
 * Win rates are percentages in the 0..100 range.
 */
function playerProfile(archive, username) {
  const profile = emptyProfile(username);
  if (!profile.username || !archive) return profile;

  let records = [];
  try {
    if (typeof archive.searchGames === 'function') {
      records = archive.searchGames(profile.username, { limit: 100000 }) || [];
    } else if (typeof archive.listGames === 'function') {
      records = archive.listGames({ limit: 100000 }) || [];
    }
  } catch (_) {
    return profile;
  }
  if (!Array.isArray(records)) return profile;

  const key = usernameKey(profile.username);
  profile.games = records.filter(game =>
    usernameKey(game && game.white) === key || usernameKey(game && game.black) === key
  );
  profile.totalGames = profile.games.length;
  const openings = new Map();

  for (const game of profile.games) {
    const outcome = gameResultForPlayer(game, profile.username);
    if (outcome === 'win') profile.wins++;
    else if (outcome === 'draw') profile.draws++;
    else if (outcome === 'loss') profile.losses++;

    const eco = String(game.eco || '').trim() || 'Unknown';
    const opening = String(game.opening || game.openingName || '').trim() || eco;
    const openingKey = `${eco}\u0000${opening}`;
    if (!openings.has(openingKey)) {
      openings.set(openingKey, { eco, opening, games: 0, wins: 0, draws: 0, losses: 0, winRate: 0 });
    }
    const stats = openings.get(openingKey);
    stats.games++;
    if (outcome === 'win') stats.wins++;
    else if (outcome === 'draw') stats.draws++;
    else if (outcome === 'loss') stats.losses++;

    const accuracy = accuracyForPlayer(game, profile.username);
    if (accuracy != null) {
      profile.accuracyTrend.push({
        gameId: game.id == null ? '' : String(game.id),
        date: String(game.date || ''),
        createdAt: Number(game.created_at || game.createdAt || 0),
        accuracy: roundPercent(accuracy)
      });
    }
  }

  profile.winRate = profile.totalGames > 0 ? roundPercent((profile.wins / profile.totalGames) * 100) : 0;
  profile.winRateByOpening = Array.from(openings.values())
    .map(stats => ({
      ...stats,
      winRate: stats.games > 0 ? roundPercent((stats.wins / stats.games) * 100) : 0
    }))
    .sort((left, right) => left.eco.localeCompare(right.eco) || left.opening.localeCompare(right.opening));
  profile.accuracyTrend.sort((left, right) =>
    left.createdAt - right.createdAt || left.date.localeCompare(right.date) || left.gameId.localeCompare(right.gameId)
  );
  return profile;
}

let defaultManager = null;
function getDefaultManager() {
  if (!defaultManager) defaultManager = new AccountsManager();
  return defaultManager;
}

function resetDefaultManager() {
  if (defaultManager) defaultManager.close();
  defaultManager = null;
}

const Accounts = {
  AccountsManager,
  MemoryAccountsAdapter,
  JsonAccountsAdapter,
  SqliteAccountsAdapter,
  hashPassword,
  verifyPassword,
  playerProfile,
  createAccount: data => getDefaultManager().createAccount(data),
  verifyAccount: data => getDefaultManager().verifyAccount(data),
  getAccount: username => getDefaultManager().getAccount(username),
  getAccountById: id => getDefaultManager().getAccountById(id),
  resetDefaultManager,
  DEFAULT_DB_PATH,
  DEFAULT_JSON_PATH
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Accounts;
}
if (typeof window !== 'undefined') {
  window.Accounts = Accounts;
}
