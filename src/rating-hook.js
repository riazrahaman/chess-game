'use strict';

/**
 * rating-hook.js — Wave 2 (roadmap R2): rate human-vs-human games on game end.
 *
 * Subscribes to the referee's state-change bus and, when a room's state has
 * transitioned to gameOver with a decisive or drawn result, records the result
 * in the per-time-control Glicko-2 pool (ratings-pool.js + rating.js), persisted
 * through game-archive.js's ratings_pool helpers (read-only use of that module).
 *
 * THE RATING RULE (documented here, enforced in shouldRate()):
 *   A finished game is rated iff
 *     1. state.gameOver is true and state.result is 1-0 / 0-1 / ½-½
 *        (flag-fall results "1-0 on time" / "0-1 on time" count as decisive);
 *     2. both player seats are held by NON-bot seat holders (seat-auth isBot) and
 *        the room has no enabled bot (bot-service) — bot games are unrated;
 *     3. both seat holders were signed in when they claimed their seat, i.e. the
 *        seat carries an accountId (anonymous/guest games are unrated);
 *     4. the two account ids differ (a player cannot rate against themselves);
 *     5. the game has at least MIN_RATED_PLIES plies (a resignation at move 0
 *        is an abort, not a result).
 *   The pool is the lichess TC category of the room's time control
 *   (time-control.js labelFormula: initial + 40·increment), lowercased:
 *   ultrabullet / bullet / blitz / rapid / classical.
 *
 * Idempotent per game: keyed by room id + a game signature (history + result),
 * plus a per-room generation counter that advances whenever the room leaves the
 * gameOver state (reset / rematch / setup), so two identical games in a row are
 * still each rated exactly once while repeat change events after game over
 * (draw offers, rematch offers, revision bumps) are not.
 *
 * The listener never throws: the referee emits synchronously inside its command
 * dispatch, so an exception here would turn a valid resign into a 500.
 *
 * Wave 3 (retention): every finished game — rated or not — is also broadcast to
 * module-level game-over listeners registered with onGameOver(fn). The event is
 * the same object handed to deps.onRated ({roomId, rated, reason, result, plies,
 * white:{accountId,username}|null, black:…, at}); streaks/achievements consume
 * it for BOTH signed-in seats regardless of rating eligibility.
 */

const RatingsPool = require('./ratings-pool.js');
const TimeControl = require('./time-control.js');

const MIN_RATED_PLIES = 2;
const MAX_REMEMBERED_GAMES = 500;
const POOLS = ['ultrabullet', 'bullet', 'blitz', 'rapid', 'classical'];

// Wave 3: process-wide game-over subscribers (routes-retention.js registers at load).
const gameOverListeners = new Set();
/** Subscribe to every finished game (rated or not). Returns an unsubscribe fn. */
function onGameOver(listener) {
  if (typeof listener !== 'function') throw new TypeError('onGameOver: listener function required');
  gameOverListeners.add(listener);
  return () => { gameOverListeners.delete(listener); };
}
function emitGameOver(event) {
  for (const listener of Array.from(gameOverListeners)) {
    try { listener(event); } catch (_) { /* observers never break the referee */ }
  }
}

function poolForTimeControl(tc) {
  if (!tc || typeof tc.baseSeconds !== 'number') return RatingsPool.DEFAULT_POOL; // referee default is Rapid 10+15
  try {
    const label = TimeControl.labelFormula(tc);
    const pool = String(label || '').toLowerCase();
    return POOLS.includes(pool) ? pool : RatingsPool.DEFAULT_POOL;
  } catch (_) {
    return RatingsPool.DEFAULT_POOL;
  }
}

/** Map a referee result string to White's score, or null when not a result. */
function scoreForWhite(result) {
  const value = String(result == null ? '' : result).trim();
  if (value.startsWith('1-0')) return 1;
  if (value.startsWith('0-1')) return 0;
  if (value.startsWith('½-½') || value.startsWith('1/2-1/2')) return 0.5;
  return null;
}

function gameSignature(state) {
  const history = Array.isArray(state.history) ? state.history.join(' ') : String(state.history || '');
  return `${history}|${state.result}|${state.status}`;
}

/**
 * Decide whether a finished game is rated. Returns { rated, reason, pool, score }.
 * `seats` is SeatAuthManager.getSeatAccounts(roomId); `botEnabled` is boolean.
 */
function shouldRate(state, seats, botEnabled) {
  if (!state || state.gameOver !== true) return { rated: false, reason: 'not-over' };
  const score = scoreForWhite(state.result);
  if (score === null) return { rated: false, reason: 'no-result' };
  const plies = Array.isArray(state.history) ? state.history.length : Number(state.plyCount) || 0;
  if (plies < MIN_RATED_PLIES) return { rated: false, reason: 'aborted' };
  const white = seats && seats.white;
  const black = seats && seats.black;
  if (botEnabled || (white && white.isBot) || (black && black.isBot)) return { rated: false, reason: 'bot-game' };
  if (!white || !black || !white.accountId || !black.accountId) return { rated: false, reason: 'anonymous' };
  if (white.accountId === black.accountId) return { rated: false, reason: 'same-account' };
  return { rated: true, reason: null, pool: poolForTimeControl(state.timeControl), score };
}

/**
 * Install the hook.
 *   deps.referee    — referee-service module (onStateChange, getReferee)
 *   deps.seatAuth   — SeatAuthManager instance (getSeatAccounts)
 *   deps.store      — RatingsPoolStore (defaults to one over deps.archive)
 *   deps.archive    — game-archive module/instance (savePoolRating etc.)
 *   deps.isBotRoom  — (roomId) => boolean, optional
 *   deps.onRated    — (event) => void, optional (tests / arena feed)
 *   deps.logger     — optional console-like
 * Returns { store, uninstall, ratedGames (Map), shouldRate, poolForTimeControl }.
 */
function installRatingHook(deps = {}) {
  const referee = deps.referee;
  const seatAuth = deps.seatAuth;
  if (!referee || typeof referee.onStateChange !== 'function' || typeof referee.getReferee !== 'function') {
    throw new TypeError('rating-hook: referee with onStateChange/getReferee is required');
  }
  if (!seatAuth || typeof seatAuth.getSeatAccounts !== 'function') {
    throw new TypeError('rating-hook: seatAuth with getSeatAccounts is required');
  }
  const store = deps.store || new RatingsPool.RatingsPoolStore(
    Object.prototype.hasOwnProperty.call(deps, 'archive') ? { archive: deps.archive } : {}
  );
  const isBotRoom = typeof deps.isBotRoom === 'function' ? deps.isBotRoom : () => false;
  const logger = deps.logger || null;

  // roomId -> { generation, lastSignature }
  const roomState = new Map();
  // `${roomId}#${generation}#${signature}` -> rating event
  const ratedGames = new Map();

  function remember(key, event) {
    if (ratedGames.size >= MAX_REMEMBERED_GAMES) {
      const oldest = ratedGames.keys().next().value;
      if (oldest !== undefined) ratedGames.delete(oldest);
    }
    ratedGames.set(key, event);
  }

  function onChange(evt) {
    try {
      const roomId = (evt && evt.roomId) || 'default';
      const ref = referee.getReferee(roomId);
      const state = ref && ref.state;
      if (!state) return;
      let track = roomState.get(roomId);
      if (!track) { track = { generation: 0, lastSignature: null }; roomState.set(roomId, track); }

      if (!state.gameOver) {
        // Left the finished state (reset/rematch/setup/new game): next finish is a new game.
        if (track.lastSignature !== null) { track.generation++; track.lastSignature = null; }
        return;
      }

      const signature = gameSignature(state);
      const key = `${roomId}#${track.generation}#${signature}`;
      if (ratedGames.has(key) || track.lastSignature === signature) return;
      track.lastSignature = signature;

      // Read seats synchronously: releaseSeat may run right after game end.
      const seats = seatAuth.getSeatAccounts(roomId);
      let botEnabled = false;
      try { botEnabled = Boolean(isBotRoom(roomId)); } catch (_) { botEnabled = false; }
      const decision = shouldRate(state, seats, botEnabled);
      const event = {
        roomId,
        rated: decision.rated,
        reason: decision.reason,
        pool: decision.pool || null,
        result: state.result,
        plies: Array.isArray(state.history) ? state.history.length : 0,
        white: seats.white ? { accountId: seats.white.accountId, username: seats.white.username } : null,
        black: seats.black ? { accountId: seats.black.accountId, username: seats.black.username } : null,
        at: Date.now()
      };
      if (decision.rated) {
        const outcome = store.recordMatch({
          timeControl: decision.pool,
          playerA: { playerId: seats.white.accountId, username: seats.white.username || seats.white.accountId },
          playerB: { playerId: seats.black.accountId, username: seats.black.username || seats.black.accountId },
          result: decision.score
        });
        event.white.rating = outcome.playerA;
        event.black.rating = outcome.playerB;
        event.rated = outcome.rated;
        if (!outcome.rated) event.reason = outcome.reason;
      }
      remember(key, event);
      if (typeof deps.onRated === 'function') {
        try { deps.onRated(event); } catch (_) { /* observers never break the referee */ }
      }
      if (typeof deps.onGameOver === 'function') {
        try { deps.onGameOver(event); } catch (_) { /* observers never break the referee */ }
      }
      emitGameOver(event);
      if (logger && event.rated && typeof logger.log === 'function') {
        logger.log(`[rating] ${roomId} ${event.pool} ${event.result} ${event.white.username} vs ${event.black.username}`);
      }
    } catch (err) {
      if (logger && typeof logger.error === 'function') logger.error('[rating] hook error', err && err.message);
    }
  }

  const unsubscribe = referee.onStateChange(onChange);
  return {
    store,
    ratedGames,
    shouldRate,
    poolForTimeControl,
    POOLS,
    uninstall: () => { try { unsubscribe(); } catch (_) {} }
  };
}

module.exports = {
  installRatingHook,
  onGameOver,
  shouldRate,
  poolForTimeControl,
  scoreForWhite,
  MIN_RATED_PLIES,
  POOLS
};
