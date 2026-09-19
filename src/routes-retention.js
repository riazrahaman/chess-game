'use strict';

/**
 * routes-retention.js — Wave 3 (roadmap §6 Tier N2 items 7 + 9): streaks and
 * achievements API over streaks.js / achievements.js / social-store.js.
 *
 * Mounted from server.js with a single line before the /api/ 404 fallthrough:
 *   if (require('./src/routes-retention.js').handleRetentionRoute(req, res, urlPath, ctx)) return;
 * ctx: { getAuthUser, sendJson, sendJsonError, readJsonBody, gameArchive, referee, accountsManager }
 *
 * Route table:
 *   GET  /api/streak                      own streak (guest → {guest:true})
 *   GET  /api/streak/:userId              public: {current, status} only
 *   POST /api/activity {kind}             (auth) record 'analysis' | 'puzzle' | 'puzzle_review' | 'game'
 *   GET  /api/achievements                catalogue + own awarded (guest → {guest:true, catalogue})
 *   GET  /api/achievements/:userId        public awarded list
 *   POST /api/achievements/event          (auth) {type:'brilliant'|'tablebase_perfect', gameId|gameSignature, ply, san}
 *                                         — verified against the archive before anything is awarded
 *
 * Game end: this module subscribes to rating-hook.js onGameOver at load time and
 * records a 'game' activity for BOTH signed-in seats (rated or not), maintains the
 * rated_games / rated_wins counters, and evaluates game achievements.
 *
 * Time injection for tests: `?now=<ms>` on any route and `at` in POST bodies are
 * honoured ONLY when process.env.NODE_ENV === 'test' (checked per request).
 */

const Streaks = require('./streaks.js');
const Achievements = require('./achievements.js');
const RatingHook = require('./rating-hook.js');
const SocialStore = require('./social-store.js');

const MAX_PIECES_TABLEBASE = 7;
const PROVISIONAL_RD = 110;
const DEFAULT_PLAYER_NAMES = new Set(['white', 'black', '', '?']);

let state = null;
function getState() {
  if (state) return state;
  const store = SocialStore.getDefaultStore();
  state = {
    store,
    tracker: new Streaks.StreakTracker({ store }),
    achievements: new Achievements.AchievementService({ store }),
    archive: null,
    onLeaguePromotion: null
  };
  return state;
}

/** Test hook: drop in-memory state (the default store is owned by social-store). */
function resetRetentionState() {
  state = null;
  Streaks.resetDefaultTracker();
  Achievements.resetDefaultService();
}

function testTimeAllowed() {
  return process.env.NODE_ENV === 'test';
}

function nowFor(req, body) {
  if (testTimeAllowed()) {
    const idx = req.url.indexOf('?');
    const q = new URLSearchParams(idx >= 0 ? req.url.slice(idx + 1) : '');
    const fromQuery = Number(q.get('now'));
    if (Number.isFinite(fromQuery) && fromQuery > 0) return fromQuery;
    const fromBody = body && Number(body.at);
    if (Number.isFinite(fromBody) && fromBody > 0) return fromBody;
  }
  return Date.now();
}

function sessionOf(req, ctx) {
  const session = ctx && typeof ctx.getAuthUser === 'function' ? ctx.getAuthUser(req) : null;
  if (!session || !session.userId) return null;
  return { id: String(session.userId), username: String(session.username || session.userId) };
}

function safeUserId(raw) {
  let id = '';
  try { id = decodeURIComponent(String(raw || '')); } catch (_) { return null; }
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(id) ? id : null;
}

// ---------------------------------------------------------------------------
// Context for achievements.evaluate()
// ---------------------------------------------------------------------------
function puzzleRatingFor(playerId) {
  const archive = getState().archive;
  if (!archive || typeof archive.getPuzzleRating !== 'function') return null;
  try {
    const row = archive.getPuzzleRating('solver', 'user:' + playerId);
    if (!row || !Number.isFinite(Number(row.rating))) return null;
    // Provisional ratings (RD > 110, same threshold as ratings-pool / the
    // Profile view) never unlock a rating badge: one lucky solve from the
    // 1500 ± 350 start would otherwise award "Sharp eye" immediately.
    if (Number.isFinite(Number(row.rd)) && Number(row.rd) > PROVISIONAL_RD) return null;
    return Number(row.rating);
  } catch (_) { return null; }
}

function contextFor(playerId, now) {
  const s = getState();
  return {
    streak: s.tracker.getStreak(playerId, now),
    puzzleDayStreak: s.tracker.puzzleDayStreak(playerId, now),
    puzzleRating: puzzleRatingFor(playerId),
    ratedGames: s.store.getCounter(playerId, 'rated_games'),
    ratedWins: s.store.getCounter(playerId, 'rated_wins')
  };
}

/**
 * Record an activity and evaluate the achievements it can unlock.
 * Returns { activity, streak, awarded } or null for anonymous players.
 */
function recordActivity(playerId, kind, at, extraEvent) {
  const pid = Streaks.normalizePlayerId(playerId);
  if (!pid) return null;
  const s = getState();
  const now = at == null ? Date.now() : Number(at);
  const activity = s.tracker.recordActivity(pid, kind, now);
  const ctx = contextFor(pid, now);
  let awarded = s.achievements.award(pid, { type: 'activity', kind }, ctx, now);
  if (extraEvent) awarded = awarded.concat(s.achievements.award(pid, extraEvent, ctx, now));
  return { activity, streak: ctx.streak, awarded };
}

// Puzzle entry point used by routes-puzzles.js (one call): mode 'review' counts
// as a review, anything else as an attempt. `puzzle` carries id/themes.
function recordPuzzleAttempt(playerId, { mode, solved, puzzle, at } = {}) {
  const kind = mode === 'review' ? 'puzzle_review' : 'puzzle';
  const themes = puzzle && Array.isArray(puzzle.themes) ? puzzle.themes : [];
  return recordActivity(playerId, kind, at, { type: 'puzzle', solved: solved === true, themes, puzzleId: puzzle ? puzzle.id : null });
}

// ---------------------------------------------------------------------------
// Game end (rating-hook onGameOver, fires for rated AND unrated games)
// ---------------------------------------------------------------------------
function onGameOver(event) {
  if (!event || !event.result) return;
  const score = RatingHook.scoreForWhite(event.result);
  if (score === null) return; // no result → not a finished game
  const s = getState();
  const now = Number(event.at) || Date.now();
  for (const side of ['white', 'black']) {
    const seat = event[side];
    const pid = seat ? Streaks.normalizePlayerId(seat.accountId) : null;
    if (!pid) continue;
    const won = side === 'white' ? score === 1 : score === 0;
    if (event.rated) {
      s.store.incrementCounter(pid, 'rated_games', 1);
      if (won) s.store.incrementCounter(pid, 'rated_wins', 1);
    }
    try {
      recordActivity(pid, 'game', now, { type: 'game_over', rated: !!event.rated, won, result: event.result, roomId: event.roomId });
    } catch (_) { /* never break the referee */ }
  }
}

RatingHook.onGameOver(onGameOver);

// Hook for Weekly Leagues (Worker B): call with (playerId, {from, to}) when a
// promotion is applied; awards first_league_promotion.
function onLeaguePromotion(playerId, details = {}) {
  const pid = Streaks.normalizePlayerId(playerId);
  if (!pid) return [];
  const s = getState();
  const now = Number(details.at) || Date.now();
  return s.achievements.award(pid, { type: 'league_promotion', from: details.from, to: details.to }, contextFor(pid, now), now);
}

// ---------------------------------------------------------------------------
// Client-posted skill events — verified server-side
// ---------------------------------------------------------------------------
function pieceCount(fen) {
  const board = String(fen || '').split(' ')[0];
  return (board.match(/[prnbqkPRNBQK]/g) || []).length;
}

function archivedPositions(game, ctx) {
  const referee = ctx && ctx.referee;
  if (!game || !referee || typeof referee.buildPositions !== 'function') return null;
  const movesStr = typeof game.moves === 'string' ? game.moves.trim() : '';
  const split = movesStr ? movesStr.split(/\s+/) : [];
  let uci = [];
  if (split.length > 0 && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(split[0])) {
    uci = split;
  } else if (game.pgn) {
    try {
      const { Chess } = require('chess.js');
      const c = new Chess();
      c.loadPgn(game.pgn);
      uci = c.history({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''));
    } catch (_) { return null; }
  }
  return referee.buildPositions(uci);
}

function callerOwnsGame(game, user) {
  const w = String(game.white || '').trim().toLowerCase();
  const b = String(game.black || '').trim().toLowerCase();
  const me = String(user.username || '').toLowerCase();
  // Archived games saved from the board carry the placeholders 'White'/'Black'
  // (HANDOVER §7: accounts do not yet bind archived games). Only when a real
  // name is recorded do we insist that it is the caller's.
  const named = !DEFAULT_PLAYER_NAMES.has(w) || !DEFAULT_PLAYER_NAMES.has(b);
  if (!named) return true;
  return w === me || b === me;
}

/**
 * Verify a client-posted event against the archive. Returns
 * { ok, error, status, event } — event carries verified:true only on success.
 */
function verifyClientEvent(body, user, ctx) {
  const archive = ctx && ctx.gameArchive;
  const type = body && String(body.type || '');
  if (type !== 'brilliant' && type !== 'tablebase_perfect') return { ok: false, status: 400, error: "type must be 'brilliant' or 'tablebase_perfect'" };
  const gameId = body.gameId != null ? String(body.gameId) : (body.gameSignature != null ? String(body.gameSignature) : '');
  if (!gameId || gameId.length > 128) return { ok: false, status: 400, error: 'gameId is required' };
  if (!archive || typeof archive.getGame !== 'function') return { ok: false, status: 503, error: 'archive unavailable' };
  let game = null;
  try { game = archive.getGame(gameId); } catch (_) { game = null; }
  if (!game) return { ok: false, status: 404, error: 'archived game not found' };
  if (!callerOwnsGame(game, user)) return { ok: false, status: 403, error: 'game was not played by this account' };
  const positions = archivedPositions(game, ctx);
  if (!positions || positions.length < 2) return { ok: false, status: 422, error: 'archived game has no replayable moves' };

  if (type === 'brilliant') {
    const ply = Number(body.ply);
    if (!Number.isInteger(ply) || ply < 1 || ply >= positions.length) return { ok: false, status: 422, error: 'ply is not part of the archived game' };
    const san = body.san != null ? String(body.san) : null;
    if (san && positions[ply].san !== san) return { ok: false, status: 422, error: 'san does not match the archived move at that ply' };
    return { ok: true, event: { type: 'brilliant', verified: true, gameId, ply, san: positions[ply].san } };
  }

  // tablebase_perfect: decisive archived result and a final position within
  // tablebase range (≤ 7 pieces). The per-move tablebase check itself runs in
  // the client against lichess; the server verifies the game shape only.
  const score = RatingHook.scoreForWhite(game.result);
  if (score === null || score === 0.5) return { ok: false, status: 422, error: 'tablebase-perfect requires a decisive archived result' };
  const finalFen = positions[positions.length - 1].fen;
  const pieces = pieceCount(finalFen);
  if (pieces > MAX_PIECES_TABLEBASE) return { ok: false, status: 422, error: `final position has ${pieces} pieces; tablebase range is ${MAX_PIECES_TABLEBASE}` };
  return { ok: true, event: { type: 'tablebase_perfect', verified: true, gameId, plies: positions.length - 1, pieces, result: game.result } };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
function handleRetentionRoute(req, res, urlPath, ctx = {}) {
  const { sendJson, sendJsonError, readJsonBody } = ctx;
  if (typeof sendJson !== 'function' || typeof sendJsonError !== 'function') return false;
  const s = getState();
  if (ctx.gameArchive && !s.archive) s.archive = ctx.gameArchive;

  const path = String(urlPath || '').replace(/\/+$/, '');
  const segments = path.split('/').filter(Boolean); // ['api', 'streak', ...]
  if (segments[0] !== 'api') return false;
  const family = segments[1];
  if (family !== 'streak' && family !== 'activity' && family !== 'achievements') return false;

  // ---- GET /api/streak ----
  if (req.method === 'GET' && family === 'streak' && segments.length === 2) {
    const user = sessionOf(req, ctx);
    if (!user) { sendJson(res, 200, { guest: true }); return true; }
    const now = nowFor(req);
    const streak = s.tracker.getStreak(user.id, now);
    sendJson(res, 200, { guest: false, userId: user.id, streak, activityDays: s.tracker.getActivityDays(user.id, { limit: 60 }), puzzleDayStreak: s.tracker.puzzleDayStreak(user.id, now) });
    return true;
  }

  // ---- GET /api/streak/:userId ----
  if (req.method === 'GET' && family === 'streak' && segments.length === 3) {
    const id = safeUserId(segments[2]);
    if (!id) { sendJsonError(res, 400, 'invalid user id'); return true; }
    const streak = s.tracker.getStreak(id, nowFor(req));
    sendJson(res, 200, { userId: id, current: streak.current, status: streak.status });
    return true;
  }

  // ---- POST /api/activity ----
  if (req.method === 'POST' && family === 'activity' && segments.length === 2) {
    const user = sessionOf(req, ctx);
    if (!user) { sendJsonError(res, 401, 'authentication required'); return true; }
    if (typeof readJsonBody !== 'function') { sendJsonError(res, 500, 'body reader unavailable'); return true; }
    readJsonBody(req).then(body => {
      if (!body || typeof body !== 'object') { sendJsonError(res, 400, 'invalid request body'); return; }
      const kind = String(body.kind || '');
      if (!Streaks.isKind(kind)) { sendJsonError(res, 400, `kind must be one of ${Streaks.KINDS.join(', ')}`); return; }
      const result = recordActivity(user.id, kind, nowFor(req, body));
      sendJson(res, 200, { ok: true, kind, day: result.activity.day, incremented: result.activity.incremented, streak: result.streak, awarded: result.awarded });
    }).catch(() => sendJsonError(res, 413, 'request body too large'));
    return true;
  }

  // ---- GET /api/achievements ----
  if (req.method === 'GET' && family === 'achievements' && segments.length === 2) {
    const user = sessionOf(req, ctx);
    if (!user) { sendJson(res, 200, { guest: true, catalogue: Achievements.presentCatalogue([]) }); return true; }
    const awarded = s.achievements.listAwarded(user.id);
    sendJson(res, 200, { guest: false, userId: user.id, catalogue: Achievements.presentCatalogue(awarded), awarded });
    return true;
  }

  // ---- POST /api/achievements/event ----
  if (req.method === 'POST' && family === 'achievements' && segments[2] === 'event' && segments.length === 3) {
    const user = sessionOf(req, ctx);
    if (!user) { sendJsonError(res, 401, 'authentication required'); return true; }
    if (typeof readJsonBody !== 'function') { sendJsonError(res, 500, 'body reader unavailable'); return true; }
    readJsonBody(req).then(body => {
      if (!body || typeof body !== 'object') { sendJsonError(res, 400, 'invalid request body'); return; }
      const verdict = verifyClientEvent(body, user, ctx);
      if (!verdict.ok) { sendJsonError(res, verdict.status, verdict.error); return; }
      const now = nowFor(req, body);
      const awarded = s.achievements.award(user.id, verdict.event, contextFor(user.id, now), now);
      sendJson(res, 200, { ok: true, verified: true, event: verdict.event, awarded });
    }).catch(() => sendJsonError(res, 413, 'request body too large'));
    return true;
  }

  // ---- GET /api/achievements/:userId ----
  if (req.method === 'GET' && family === 'achievements' && segments.length === 3) {
    const id = safeUserId(segments[2]);
    if (!id) { sendJsonError(res, 400, 'invalid user id'); return true; }
    const awarded = s.achievements.listAwarded(id).map(a => ({ id: a.id, awardedAt: a.awardedAt }));
    sendJson(res, 200, { userId: id, awarded });
    return true;
  }

  sendJsonError(res, 404, 'not found');
  return true;
}

module.exports = {
  handleRetentionRoute,
  recordActivity,
  recordPuzzleAttempt,
  onGameOver,
  onLeaguePromotion,
  verifyClientEvent,
  resetRetentionState
};
