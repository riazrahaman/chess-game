'use strict';

/**
 * routes-review.js — Wave 3 (N1.3, kanban w3-missed-tactics) review routes.
 *
 * Mounted from server.js with a single hook line before the `/api/` 404:
 *
 *   if (require('./src/routes-review.js').handleReviewRoute(req, res, urlPath, ctx)) return;
 *
 * Routes (read-only; nothing here touches referee state — Gate 4):
 *
 *   GET  /api/games/:id/missed-tactics[?color=white|black]
 *        Evaluates every position of the archived game with the server engine
 *        (engine-server.js, Stockfish 19 lite: depth 12, movetime <= 200 ms per
 *        ply), caching each eval in game-archive's eval_cache (getEval/saveEval,
 *        White-perspective cp like the browser worker stores), then returns the
 *        Miss list from missed-tactics.js findMissedTactics().
 *        → { ok, gameId, plies, engine, depth, evaluated, cached, truncated,
 *            evals: [{ cp, mate, bestmove, depth }], misses: [...] }
 *
 *   POST /api/review/missed-tactics   body { moves: [uci...], color? }
 *        Same computation for an unarchived game (the Analysis view's "Current
 *        game" source, whose positions come from the referee's /api/state).
 *        Moves are validated by referee.buildPositions (chess.js legality).
 *
 * Engine scores from engine-server are side-to-move; they are flipped to
 * White's perspective here before caching/comparing. Terminal positions
 * (checkmate / stalemate) are scored without the engine.
 */

const { Chess } = require('chess.js');
const missedTactics = require('./missed-tactics.js');

let engineServer = null;
try { engineServer = require('./engine-server.js'); } catch (_) { engineServer = null; }

const REVIEW_DEPTH = 12;
const REVIEW_MOVETIME_MS = 200;
const MAX_PLIES = 300;
const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

function fenTurn(fen) {
  return String(fen || '').split(/\s+/)[1] === 'b' ? 'b' : 'w';
}

function terminalEval(fen) {
  try {
    const c = new Chess(fen);
    if (c.isCheckmate()) {
      // Side to move is mated: White-perspective score.
      return { cp: fenTurn(fen) === 'w' ? -missedTactics.MATE_CP : missedTactics.MATE_CP, mate: null, bestmove: null, depth: REVIEW_DEPTH, terminal: 'checkmate' };
    }
    if (c.isStalemate() || c.isInsufficientMaterial()) {
      return { cp: 0, mate: null, bestmove: null, depth: REVIEW_DEPTH, terminal: c.isStalemate() ? 'stalemate' : 'insufficient-material' };
    }
  } catch (_) { /* fall through to the engine */ }
  return null;
}

function toWhitePerspective(fen, line) {
  const sign = fenTurn(fen) === 'w' ? 1 : -1;
  const mate = typeof line.mate === 'number' && line.mate !== 0 ? sign * line.mate : null;
  let cp = typeof line.scoreCp === 'number' ? sign * line.scoreCp : null;
  if (cp === null && mate !== null) cp = missedTactics.mateToCp(mate);
  return { cp, mate };
}

function cacheUsable(cached) {
  if (!cached) return false;
  const hasScore = typeof cached.cp === 'number' || typeof cached.mate === 'number';
  return hasScore && typeof cached.depth === 'number' && cached.depth >= REVIEW_DEPTH;
}

async function evaluatePositions(positions, gameArchive) {
  const evals = [];
  let cached = 0;
  let evaluated = 0;
  let engineName = null;
  let truncated = false;
  const available = !!(engineServer && engineServer.isAvailable());
  for (let i = 0; i < positions.length; i++) {
    const fen = positions[i] && positions[i].fen;
    if (!fen) { evals.push(null); continue; }
    if (i > MAX_PLIES) { truncated = true; evals.push(null); continue; }
    const hit = gameArchive && typeof gameArchive.getEval === 'function' ? gameArchive.getEval(fen) : null;
    if (cacheUsable(hit)) {
      cached++;
      evals.push({ cp: hit.cp, mate: hit.mate == null ? null : hit.mate, bestmove: hit.bestmove || null, depth: hit.depth });
      continue;
    }
    let ev = terminalEval(fen);
    if (!ev) {
      if (!available) { evals.push(null); continue; }
      try {
        const r = await engineServer.analyse(fen, { depth: REVIEW_DEPTH, movetime: REVIEW_MOVETIME_MS });
        engineName = r.engine || engineName;
        const line = (r.lines && r.lines[0]) || {};
        const wp = toWhitePerspective(fen, line);
        if (wp.cp === null) { evals.push(null); continue; }
        ev = { cp: wp.cp, mate: wp.mate, bestmove: r.bestMove || line.move || null, depth: line.depth || REVIEW_DEPTH };
      } catch (_) {
        evals.push(null);
        continue;
      }
    }
    evaluated++;
    if (gameArchive && typeof gameArchive.saveEval === 'function') {
      try { gameArchive.saveEval(fen, { cp: ev.cp, depth: ev.depth, mate: ev.mate, bestmove: ev.bestmove }); } catch (_) {}
    }
    evals.push(ev);
  }
  if (!engineName && available && engineServer.ENGINE_NAME) engineName = engineServer.ENGINE_NAME;
  return { evals, cached, evaluated, engine: available ? engineName : null, truncated };
}

function uciListFromGame(game) {
  const movesStr = typeof game.moves === 'string' ? game.moves.trim() : '';
  const split = movesStr ? movesStr.split(/\s+/) : [];
  if (split.length > 0 && split.every(m => UCI_RE.test(m))) return split;
  if (game.pgn) {
    try {
      const c = new Chess();
      c.loadPgn(game.pgn);
      return c.history({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''));
    } catch (_) { return null; }
  }
  return split.length === 0 ? [] : null;
}

async function respondMisses(res, ctx, uci, color, extra) {
  const positions = ctx.referee.buildPositions(uci);
  if (!positions) { ctx.sendJsonError(res, 400, 'illegal move sequence'); return; }
  const result = await evaluatePositions(positions, ctx.gameArchive);
  const misses = missedTactics.findMissedTactics(positions, result.evals, { color });
  ctx.sendJson(res, 200, Object.assign({
    ok: true,
    plies: uci.length,
    engine: result.engine,
    depth: REVIEW_DEPTH,
    movetimeMs: REVIEW_MOVETIME_MS,
    evaluated: result.evaluated,
    cached: result.cached,
    truncated: result.truncated,
    thresholds: { swingCp: missedTactics.MISS_SWING_CP, giveBackCp: missedTactics.MISS_GIVEBACK_CP },
    evals: result.evals,
    misses
  }, extra || {}));
}

function colorParam(req) {
  try {
    const c = new URL(req.url, 'http://127.0.0.1').searchParams.get('color');
    return c === 'white' || c === 'black' ? c : null;
  } catch (_) { return null; }
}

/**
 * @returns {boolean} true when the request was handled.
 */
function handleReviewRoute(req, res, urlPath, ctx) {
  const m = urlPath.match(/^\/api\/games\/([^/?#]+)\/missed-tactics$/);
  if (m && req.method === 'GET') {
    const id = decodeURIComponent(m[1]);
    const game = ctx.gameArchive.getGame(id);
    if (!game) { ctx.sendJsonError(res, 404, 'game not found'); return true; }
    const uci = uciListFromGame(game);
    if (!uci) { ctx.sendJsonError(res, 422, 'game has no usable move list'); return true; }
    respondMisses(res, ctx, uci, colorParam(req), { gameId: game.id })
      .catch(err => { if (!res.headersSent) ctx.sendJsonError(res, 500, err && err.message || 'review failed'); });
    return true;
  }
  if (urlPath === '/api/review/missed-tactics' && req.method === 'POST') {
    ctx.readJsonBody(req).then(body => {
      const moves = body && Array.isArray(body.moves) ? body.moves : null;
      if (!moves || moves.length > MAX_PLIES || !moves.every(x => typeof x === 'string' && UCI_RE.test(x))) {
        ctx.sendJsonError(res, 400, 'moves must be an array of UCI strings (max ' + MAX_PLIES + ')');
        return;
      }
      const color = body.color === 'white' || body.color === 'black' ? body.color : colorParam(req);
      return respondMisses(res, ctx, moves, color, {});
    }).catch(err => { if (!res.headersSent) ctx.sendJsonError(res, err && /Too Large/i.test(err.message) ? 413 : 500, err && err.message || 'review failed'); });
    return true;
  }
  return false;
}

module.exports = {
  handleReviewRoute,
  evaluatePositions,
  terminalEval,
  toWhitePerspective,
  REVIEW_DEPTH,
  REVIEW_MOVETIME_MS,
  MAX_PLIES
};
