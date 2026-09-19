'use strict';

/**
 * routes-openings.js — Wave 2 (E3) read-only opening / FEN routes.
 *
 * Mounted from server.js with a single hook line before the `/api/` 404:
 *
 *   if (handleOpeningsRoute(req, res, urlPath, { sendJson, sendJsonError, readJsonBody })) return;
 *
 * Routes (all read-only; none touch referee state — Gate 4):
 *
 *   GET  /api/openings/status
 *        → { ok, loaded, lines, source, licence }
 *
 *   GET  /api/openings/lookup?moves=e2e4,e7e5,g1f3
 *        Longest-prefix match against data/openings.tsv (lichess chess-openings,
 *        CC0). `moves` = comma- or space-separated UCI (max 100 plies).
 *        → { ok, eco, name, pgn, matchedPlies, isExact, book,
 *            continuations: [{ uci, lines, eco, name, named }], source }
 *        `book` = the exact sequence lies on a named line (TSV entry or prefix).
 *        `lines` = number of named TSV lines through that continuation — NOT a
 *        game count; there are no game counts anywhere in this dataset.
 *
 *   GET  /api/openings/personal?moves=e2e4,e7e5
 *        W/D/L from the player's OWN archived games (game-archive.js, read-only)
 *        whose UCI move list starts with `moves`. Results are from White's
 *        perspective (`wins` = 1-0). Never fabricated; count 0 → all zeros.
 *        → { ok, label: 'your games', perspective: 'white', count, wins, draws,
 *            losses, winRate, drawRate, lossRate, games: [...] }
 *
 *   POST /api/fen/validate   body { fen }
 *        → { ok, valid, fen (canonical, chess.js-normalised), turn, pieces }
 *          or { ok, valid: false, error }
 *
 * Data loads once at first require (ensureDefaultLoaded); the dataset is
 * server-side only — browsers see only these JSON answers.
 */

const path = require('path');
const explorer = require('./openings-explorer.js');
const rulesEngine = require('./rules-engine.js');
const tablebase = require('./tablebase.js');
const repertoireTrainer = require('./repertoire-trainer.js');
let gameArchive = null;
try { gameArchive = require('./game-archive.js'); } catch (_) { gameArchive = null; }

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const MAX_PLIES = 100;
const SOURCE = 'lichess-org/chess-openings (data/openings.tsv)';
const LICENCE = 'CC0-1.0';

const loaded = explorer.ensureDefaultLoaded();
if (!loaded) {
  console.warn('routes-openings: data/openings.tsv not loaded (' + path.join('data', 'openings.tsv') + ') — lookups fall back to bundled names only');
}

function parseMovesParam(raw) {
  if (raw == null || raw === '') return [];
  const parts = String(raw).split(/[,\s]+/).filter(Boolean).map(s => s.toLowerCase());
  if (parts.length > MAX_PLIES) return null;
  for (const p of parts) if (!UCI_RE.test(p)) return null;
  return parts;
}

function queryOf(req) {
  const idx = req.url.indexOf('?');
  return new URLSearchParams(idx >= 0 ? req.url.slice(idx + 1) : '');
}

function lookup(moves) {
  const opening = explorer.exploreOpening(moves);
  const conts = explorer.continuations(moves);
  return {
    ok: true,
    eco: opening.eco || null,
    name: opening.name || null,
    pgn: opening.pgn || null,
    matchedPlies: opening.matchedPlies || 0,
    isExact: !!opening.isExact,
    book: explorer.isKnownLine(moves),
    continuations: conts,
    source: SOURCE,
    licence: LICENCE
  };
}

function personal(moves, archive) {
  const stats = explorer.personalExplorer(archive, moves);
  if (!stats) {
    return { ok: true, label: 'your games', perspective: 'white', available: false, count: 0, wins: 0, draws: 0, losses: 0, winRate: 0, drawRate: 0, lossRate: 0, games: [] };
  }
  return Object.assign({ ok: true, label: 'your games', perspective: 'white', available: true }, stats);
}

function validateFen(fen) {
  if (typeof fen !== 'string' || !fen.trim()) return { ok: true, valid: false, error: 'fen is required' };
  const trimmed = fen.trim();
  if (trimmed.length > 120) return { ok: true, valid: false, error: 'fen too long' };
  try {
    const board = rulesEngine.fenToBoard(trimmed);
    const canonical = rulesEngine.boardToFen(board);
    return {
      ok: true,
      valid: true,
      fen: canonical,
      turn: rulesEngine.turn(canonical),
      pieces: tablebase.countPiecesInFen(canonical)
    };
  } catch (err) {
    return { ok: true, valid: false, error: (err && err.message) || 'invalid fen' };
  }
}

/**
 * @returns {boolean} true when the request was handled (response sent or
 * scheduled), false to let server.js continue routing.
 */
function handleOpeningsRoute(req, res, urlPath, ctx) {
  ctx = ctx || {};
  const sendJson = ctx.sendJson || ((r, status, payload) => { r.statusCode = status; r.setHeader('Content-Type', 'application/json'); r.end(JSON.stringify(payload)); });
  const sendJsonError = ctx.sendJsonError || ((r, status, message) => sendJson(r, status, { ok: false, error: message }));
  const archive = ctx.archive || gameArchive;

  if (req.method === 'GET' && urlPath === '/api/openings/status') {
    const map = explorer.getTSVMap();
    sendJson(res, 200, { ok: true, loaded: !!(map && map.size > 0), lines: map ? map.size : 0, source: SOURCE, licence: LICENCE });
    return true;
  }

  if (req.method === 'GET' && (urlPath === '/api/openings/lookup' || urlPath === '/api/openings/personal')) {
    const moves = parseMovesParam(queryOf(req).get('moves'));
    if (moves === null) {
      sendJsonError(res, 400, 'moves must be comma-separated UCI (e2e4,e7e5), at most ' + MAX_PLIES + ' plies');
      return true;
    }
    if (urlPath === '/api/openings/lookup') sendJson(res, 200, lookup(moves));
    else sendJson(res, 200, personal(moves, archive));
    return true;
  }

  if (req.method === 'POST' && urlPath === '/api/fen/validate') {
    const readJsonBody = ctx.readJsonBody;
    if (typeof readJsonBody !== 'function') {
      sendJsonError(res, 500, 'body reader unavailable');
      return true;
    }
    readJsonBody(req).then(body => {
      if (!body || typeof body !== 'object') {
        sendJsonError(res, 400, 'invalid json body');
        return;
      }
      const result = validateFen(body.fen);
      sendJson(res, 200, result); // a rejected FEN is a normal answer, not an HTTP error
    }).catch(() => {
      if (!res.headersSent) sendJsonError(res, 413, 'request body too large');
    });
    return true;
  }

  if (req.method === 'POST' && urlPath === '/api/openings/repertoire/deviation') {
    const readJsonBody = ctx.readJsonBody;
    if (typeof readJsonBody !== 'function') {
      sendJsonError(res, 500, 'body reader unavailable');
      return true;
    }
    readJsonBody(req).then(body => {
      if (!body || !body.moves) {
        sendJsonError(res, 400, 'moves array is required');
        return;
      }
      let rep = body.repertoire;
      if (rep && !rep.cards) {
        try { rep = repertoireTrainer.fromJSON(rep); } catch (_) { rep = null; }
      }
      if (!rep) {
        sendJsonError(res, 400, 'valid repertoire is required');
        return;
      }
      const result = repertoireTrainer.detectDeviation(rep, body.moves);
      sendJson(res, 200, Object.assign({ ok: true }, result));
    }).catch(() => {
      if (!res.headersSent) sendJsonError(res, 413, 'request body too large');
    });
    return true;
  }

  return false;
}

module.exports = {
  handleOpeningsRoute,
  // exported for tests
  parseMovesParam,
  lookup,
  personal,
  validateFen,
  SOURCE,
  LICENCE
};
