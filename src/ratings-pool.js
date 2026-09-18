'use strict';

let Rating = null;
let GameArchive = null;
if (typeof require === 'function') {
  try { Rating = require('./rating.js'); } catch (_) {}
  try { GameArchive = require('./game-archive.js'); } catch (_) {}
}
if (!Rating && typeof window !== 'undefined') Rating = window.Rating;
if (!GameArchive && typeof window !== 'undefined') GameArchive = window.GameArchive;

const DEFAULT_POOL = 'rapid';
const DEFAULT_RATING = 1500;
const DEFAULT_RD = 350;
const DEFAULT_VOLATILITY = 0.06;
const DEFAULT_TAU = 0.5;
const PROVISIONAL_RD = 110;

function requireRatingEngine() {
  if (!Rating || typeof Rating.createPlayer !== 'function' ||
      typeof Rating.updateRating !== 'function' ||
      typeof Rating.confidenceInterval !== 'function') {
    throw new Error('ratings-pool.js: rating.js is required');
  }
}

function normalizePool(timeControl) {
  const pool = timeControl == null ? DEFAULT_POOL : String(timeControl).trim().toLowerCase();
  return pool || DEFAULT_POOL;
}

function normalizePlayerId(playerId) {
  if (playerId && typeof playerId === 'object') {
    playerId = playerId.playerId == null ? playerId.id : playerId.playerId;
  }
  if (playerId == null || String(playerId).trim() === '') {
    throw new TypeError('player id must be a non-empty value');
  }
  return String(playerId);
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function isProvisional(player) {
  return !player || !Number.isFinite(player.rd) || player.rd > PROVISIONAL_RD;
}

function createPoolPlayer(player = {}) {
  requireRatingEngine();
  const source = typeof player === 'string' ? { id: player } : (player || {});
  const playerId = normalizePlayerId(source);
  const state = Rating.createPlayer(
    finiteOr(source.rating, DEFAULT_RATING),
    finiteOr(source.rd, DEFAULT_RD),
    finiteOr(source.vol, DEFAULT_VOLATILITY)
  );
  return {
    playerId,
    username: String(source.username || source.name || playerId),
    rating: state.rating,
    rd: state.rd,
    vol: state.vol,
    provisional: isProvisional(state)
  };
}

function normalizeScore(result) {
  if (result === 1 || result === 0.5 || result === 0) return result;
  const value = String(result == null ? '' : result).trim().toLowerCase();
  if (value === 'win' || value === '1-0') return 1;
  if (value === 'draw' || value === '1/2-1/2' || value === '½-½') return 0.5;
  if (value === 'loss' || value === '0-1') return 0;
  throw new TypeError('result must be win, draw, loss, 1, 0.5, or 0');
}

/**
 * Pure two-player update. playerA's result is supplied; playerB receives its
 * complement. Bot games and explicitly unrated games return unchanged states.
 */
function recordMatch(playerA, playerB, result, options = {}) {
  requireRatingEngine();
  const currentA = createPoolPlayer(playerA);
  const currentB = createPoolPlayer(playerB);
  const botGame = Boolean(options.isBot || options.playerAIsBot || options.playerBIsBot ||
    (playerA && playerA.isBot) || (playerB && playerB.isBot));
  if (options.rated === false || botGame) {
    return {
      rated: false,
      reason: botGame ? 'bot-game' : 'unrated',
      playerA: currentA,
      playerB: currentB
    };
  }

  const score = normalizeScore(result);
  const updatedA = Rating.updateRating(currentA, [{ opponent: currentB, score }], options.tau || DEFAULT_TAU);
  const updatedB = Rating.updateRating(currentB, [{ opponent: currentA, score: 1 - score }], options.tau || DEFAULT_TAU);
  return {
    rated: true,
    reason: null,
    score,
    playerA: createPoolPlayer({ ...currentA, ...updatedA }),
    playerB: createPoolPlayer({ ...currentB, ...updatedB })
  };
}

function poolValues(pool) {
  if (pool instanceof Map) return Array.from(pool.values());
  if (Array.isArray(pool)) return pool;
  if (pool && typeof pool === 'object') return Object.values(pool);
  return [];
}

/**
 * Return ranked established players. Pass { includeProvisional: true } to
 * append provisional players with rank:null and their provisional flag set.
 */
function getLeaderboard(pool, options = {}) {
  requireRatingEngine();
  const players = poolValues(pool).map(createPoolPlayer);
  const established = players
    .filter(player => !player.provisional)
    .sort((left, right) => right.rating - left.rating || left.playerId.localeCompare(right.playerId));
  const ranked = established.map((player, index) => {
    const confidence = Rating.confidenceInterval(player);
    return { ...player, rank: index + 1, confidence };
  });
  if (options.includeProvisional !== true) return ranked;

  const provisional = players
    .filter(player => player.provisional)
    .sort((left, right) => right.rating - left.rating || left.playerId.localeCompare(right.playerId))
    .map(player => ({
      ...player,
      rank: null,
      confidence: Rating.confidenceInterval(player)
    }));
  return ranked.concat(provisional);
}

class RatingsPoolStore {
  constructor(options = {}) {
    this.archive = Object.prototype.hasOwnProperty.call(options, 'archive')
      ? options.archive
      : GameArchive;
    this.pools = new Map();
  }

  _pool(timeControl) {
    const key = normalizePool(timeControl);
    if (!this.pools.has(key)) this.pools.set(key, new Map());
    return this.pools.get(key);
  }

  _remember(timeControl, player) {
    const value = createPoolPlayer(player);
    this._pool(timeControl).set(value.playerId, value);
    return { ...value };
  }

  _persist(timeControl, player) {
    const pool = normalizePool(timeControl);
    const value = this._remember(pool, player);
    if (this.archive && typeof this.archive.savePoolRating === 'function') {
      try { this.archive.savePoolRating(pool, value.playerId, value); } catch (_) {}
    }
    return value;
  }

  getPlayer(timeControl, playerId, defaults = {}) {
    const pool = normalizePool(timeControl);
    const id = normalizePlayerId(playerId);
    const remembered = this._pool(pool).get(id);
    if (remembered) return { ...remembered };

    if (this.archive && typeof this.archive.getPoolRating === 'function') {
      try {
        const saved = this.archive.getPoolRating(pool, id);
        if (saved) return this._remember(pool, saved);
      } catch (_) {}
    }
    return this._remember(pool, { ...defaults, playerId: id });
  }

  _readPlayer(timeControl, playerId, defaults = {}) {
    const pool = normalizePool(timeControl);
    const id = normalizePlayerId(playerId);
    const rememberedPool = this.pools.get(pool);
    const remembered = rememberedPool && rememberedPool.get(id);
    if (remembered) return { ...remembered };

    if (this.archive && typeof this.archive.getPoolRating === 'function') {
      try {
        const saved = this.archive.getPoolRating(pool, id);
        if (saved) return createPoolPlayer(saved);
      } catch (_) {}
    }
    return createPoolPlayer({ ...defaults, playerId: id });
  }

  /**
   * Read-only lookup: memory, then archive, else null. Unlike getPlayer() this
   * never inserts a default entry, so routes such as /api/ratings/me do not
   * manufacture phantom provisional players.
   */
  peekPlayer(timeControl, playerId) {
    const pool = normalizePool(timeControl);
    const id = normalizePlayerId(playerId);
    const rememberedPool = this.pools.get(pool);
    const remembered = rememberedPool && rememberedPool.get(id);
    if (remembered) return { ...remembered };
    if (this.archive && typeof this.archive.getPoolRating === 'function') {
      try {
        const saved = this.archive.getPoolRating(pool, id);
        if (saved) return createPoolPlayer(saved);
      } catch (_) {}
    }
    return null;
  }

  setPlayer(timeControl, player) {
    return this._persist(timeControl, player);
  }

  recordMatch(match = {}) {
    const pool = normalizePool(match.timeControl || match.pool);
    const sourceA = match.playerA;
    const sourceB = match.playerB;
    const idA = normalizePlayerId(sourceA);
    const idB = normalizePlayerId(sourceB);
    const playerAIsBot = Boolean(match.playerAIsBot || (sourceA && sourceA.isBot));
    const playerBIsBot = Boolean(match.playerBIsBot || (sourceB && sourceB.isBot));
    const unrated = match.rated === false || Boolean(match.isBot) || playerAIsBot || playerBIsBot;

    // Unrated games are observational only: do not insert either participant
    // into a pool, cache an archive read, or write any rating state.
    if (unrated) {
      const currentA = this._readPlayer(pool, idA, typeof sourceA === 'object' ? sourceA : {});
      const currentB = this._readPlayer(pool, idB, typeof sourceB === 'object' ? sourceB : {});
      const unchanged = recordMatch(currentA, currentB, match.result, {
        rated: match.rated,
        isBot: match.isBot,
        playerAIsBot,
        playerBIsBot,
        tau: match.tau
      });
      return { ...unchanged, pool };
    }

    const currentA = this.getPlayer(pool, idA, typeof sourceA === 'object' ? sourceA : {});
    const currentB = this.getPlayer(pool, idB, typeof sourceB === 'object' ? sourceB : {});
    const updated = recordMatch(currentA, currentB, match.result, {
      rated: match.rated,
      isBot: match.isBot,
      playerAIsBot,
      playerBIsBot,
      tau: match.tau
    });
    updated.playerA = this._persist(pool, updated.playerA);
    updated.playerB = this._persist(pool, updated.playerB);
    return { ...updated, pool };
  }

  getLeaderboard(timeControl, options = {}) {
    const pool = normalizePool(timeControl);
    if (this.archive && typeof this.archive.listPoolRatings === 'function') {
      try {
        const saved = this.archive.listPoolRatings(pool);
        if (Array.isArray(saved)) {
          for (const player of saved) this._remember(pool, player);
        }
      } catch (_) {}
    }
    return getLeaderboard(this._pool(pool), options);
  }
}

const RatingsPool = {
  DEFAULT_POOL,
  DEFAULT_RATING,
  DEFAULT_RD,
  DEFAULT_VOLATILITY,
  PROVISIONAL_RD,
  normalizePool,
  createPoolPlayer,
  isProvisional,
  normalizeScore,
  recordMatch,
  getLeaderboard,
  RatingsPoolStore
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RatingsPool;
}
if (typeof window !== 'undefined') {
  window.RatingsPool = RatingsPool;
}
