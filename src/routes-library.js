'use strict';

/**
 * routes-library.js — Wave 3 (roadmap §4 R1 Library row + §6 N3.17): the
 * Library API. Mounted from server.js with one line before the /api/ 404:
 *   if (LibraryRoutes.handleLibraryRoute(req, res, urlPath, ctx)) return;
 *
 * Route table (auth = cookie chess_session / Authorization: Bearer / X-Session-Token):
 *   GET  /api/library?owner=me&q=&source=&page=&pageSize=
 *          signed in + owner=me -> that account's games; guest (or owner=guest)
 *          -> unowned local games only. Never lists other accounts' games.
 *   POST /api/library/claim {roomIds:[..], ids:[..]}   (auth) bind the guest's
 *          unowned games (matched by room id, or explicit game id) to the account
 *   POST /api/import/lichess  {username, max?, full?}  (auth)
 *   POST /api/import/chesscom {username, max?, full?}  (auth)
 *          server-side fetch of the public APIs via import-external.js; one
 *          import per account at a time (409 while running); incremental by
 *          default (resumes from the stored nextSince), `full: true` re-scans
 *   GET  /api/import/status                            (auth) last run per source
 *
 * Pure archive/API layer: nothing here touches referee state.
 */

const ImportExternal = require('./import-external.js');
const GameArchive = require('./game-archive.js');

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
const MAX_CLAIM_IDS = 200;
const ROOM_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const IMPORT_SOURCES = new Set(['lichess', 'chesscom']);

// ownerId -> source currently importing (the upstream APIs are rate limited;
// never run two imports for one account concurrently).
const inFlight = new Map();

// Test seam: selftests stub the network here (server.js stays a one-line hook).
const testHooks = { fetchImpl: null, sleepImpl: null, backoffMs: null };
function setTestHooks(hooks) { Object.assign(testHooks, hooks || {}); }

function parseJson(body) {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return null;
  }
}

function queryOf(req) {
  const idx = req.url.indexOf('?');
  return new URLSearchParams(idx >= 0 ? req.url.slice(idx + 1) : '');
}

function sessionOf(req, ctx) {
  const session = ctx.getAuthUser(req);
  if (!session || !session.userId) return null;
  return { id: String(session.userId), username: String(session.username || session.userId) };
}

function requireAuth(req, res, ctx) {
  const user = sessionOf(req, ctx);
  if (!user) {
    ctx.sendJsonError(res, 401, 'sign in required');
    return null;
  }
  return user;
}

function archiveOf(ctx) {
  return ctx.gameArchive || GameArchive;
}

function pgnHeader(pgn, name) {
  if (!pgn || typeof pgn !== 'string') return '';
  const m = pgn.match(new RegExp('\\[' + name + '\\s+"([^"]*)"\\]'));
  return m ? m[1] : '';
}

/** Public row shape for the Library list (never leaks owner ids of others). */
function libraryRow(game) {
  const moves = typeof game.moves === 'string' ? game.moves.trim() : '';
  const plies = moves ? moves.split(/\s+/).filter(Boolean).length : 0;
  const source = game.source || 'local';
  const opening = pgnHeader(game.pgn, 'Opening');
  const timeControl = pgnHeader(game.pgn, 'TimeControl');
  return {
    id: game.id,
    white: game.white,
    black: game.black,
    date: game.date,
    result: game.result,
    eco: game.eco || '',
    opening,
    timeControl,
    plies,
    source,
    externalId: game.external_id || null,
    externalUrl: source === 'lichess' && game.external_id ? `https://lichess.org/${game.external_id}`
      : source === 'chesscom' && game.external_id ? game.external_id : null,
    roomId: game.room_id || null,
    owned: game.owner_id != null,
    createdAt: game.created_at || null
  };
}

// ---------------------------------------------------------------------------
// GET /api/library
// ---------------------------------------------------------------------------
function handleLibraryList(req, res, ctx) {
  const q = queryOf(req);
  const user = sessionOf(req, ctx);
  const ownerParam = (q.get('owner') || 'me').toLowerCase();
  // Guests (and "owner=guest") see unowned games only; a signed-in user sees
  // their own. There is no way to list another account's games.
  const scope = {};
  if (user && ownerParam !== 'guest') scope.owner = user.id;
  else scope.owner = null;

  const source = (q.get('source') || '').toLowerCase();
  if (source && source !== 'all') {
    if (!GameArchive.GAME_SOURCES.includes(source)) { ctx.sendJsonError(res, 400, 'invalid source'); return; }
    scope.source = source;
  }

  let pageSize = parseInt(q.get('pageSize') || String(PAGE_SIZE_DEFAULT), 10);
  if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = PAGE_SIZE_DEFAULT;
  pageSize = Math.min(pageSize, PAGE_SIZE_MAX);
  let page = parseInt(q.get('page') || '1', 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  const offset = (page - 1) * pageSize;

  const text = (q.get('q') || '').trim().slice(0, 120);
  const archive = archiveOf(ctx);
  let games;
  let total = null;
  try {
    if (text) {
      games = archive.searchGames(text, Object.assign({ limit: pageSize, offset }, scope));
    } else {
      games = archive.listGames(Object.assign({ limit: pageSize, offset }, scope));
      total = typeof archive.countGames === 'function' ? archive.countGames(scope) : null;
    }
  } catch (err) {
    ctx.sendJsonError(res, 500, 'library unavailable');
    return;
  }
  const rows = (games || []).map(libraryRow);
  ctx.sendJson(res, 200, {
    ok: true,
    owner: scope.owner === null ? 'guest' : 'me',
    source: scope.source || 'all',
    q: text,
    page,
    pageSize,
    total,
    hasMore: total != null ? offset + rows.length < total : rows.length === pageSize,
    games: rows
  });
}

// ---------------------------------------------------------------------------
// POST /api/library/claim
// ---------------------------------------------------------------------------
function handleClaim(req, res, ctx) {
  const user = requireAuth(req, res, ctx);
  if (!user) return;
  ctx.readBody(req, ctx.maxBodyBytes).then(body => {
    const data = parseJson(body);
    if (!data) { ctx.sendJsonError(res, 400, 'invalid json'); return; }
    const roomIds = Array.isArray(data.roomIds) ? data.roomIds.map(String).filter(r => ROOM_ID_RE.test(r)).slice(0, MAX_CLAIM_IDS) : [];
    const ids = Array.isArray(data.ids) ? data.ids.map(String).filter(r => ROOM_ID_RE.test(r)).slice(0, MAX_CLAIM_IDS) : [];
    if (roomIds.length === 0 && ids.length === 0) { ctx.sendJsonError(res, 400, 'roomIds or ids required'); return; }
    const claimed = archiveOf(ctx).claimGames(user.id, { roomIds, ids }) || [];
    ctx.sendJson(res, 200, { ok: true, claimed, count: claimed.length });
  }).catch(() => { if (!res.headersSent) ctx.sendJsonError(res, 413, 'request body too large'); });
}

// ---------------------------------------------------------------------------
// POST /api/import/:source
// ---------------------------------------------------------------------------
function handleImport(req, res, ctx, source) {
  const user = requireAuth(req, res, ctx);
  if (!user) return;
  ctx.readBody(req, ctx.maxBodyBytes).then(async body => {
    const data = parseJson(body);
    if (!data) { ctx.sendJsonError(res, 400, 'invalid json'); return; }
    const username = String(data.username || '').trim();
    if (!/^[A-Za-z0-9_-]{2,40}$/.test(username)) { ctx.sendJsonError(res, 400, 'invalid username'); return; }
    if (inFlight.has(user.id)) { ctx.sendJsonError(res, 409, `an import (${inFlight.get(user.id)}) is already running for this account`); return; }

    const archive = archiveOf(ctx);
    let since = null;
    if (!data.full) {
      const prev = (archive.listImports(user.id) || []).find(r => r.source === source && r.username.toLowerCase() === username.toLowerCase());
      if (prev && prev.nextSince) since = Number(prev.nextSince);
    }
    inFlight.set(user.id, source);
    try {
      const result = await ImportExternal.runImport(source, {
        username, ownerId: user.id, archive, max: data.max, since,
        fetchImpl: ctx.fetchImpl || testHooks.fetchImpl || undefined,
        sleepImpl: ctx.sleepImpl || testHooks.sleepImpl || undefined,
        backoffMs: ctx.importBackoffMs != null ? ctx.importBackoffMs : (testHooks.backoffMs != null ? testHooks.backoffMs : undefined)
      });
      ctx.sendJson(res, 200, Object.assign({ ok: true }, result));
    } catch (err) {
      const status = err && err.status ? err.status : 502;
      ctx.sendJsonError(res, status, err && err.message ? err.message : 'import failed');
    } finally {
      inFlight.delete(user.id);
    }
  }).catch(() => { if (!res.headersSent) ctx.sendJsonError(res, 413, 'request body too large'); });
}

function handleImportStatus(req, res, ctx) {
  const user = requireAuth(req, res, ctx);
  if (!user) return;
  const imports = archiveOf(ctx).listImports(user.id) || [];
  ctx.sendJson(res, 200, { ok: true, running: inFlight.get(user.id) || null, imports });
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------
function handleLibraryRoute(req, res, urlPath, ctx) {
  const method = req.method;
  let m;
  if (method === 'GET' && urlPath === '/api/library') { handleLibraryList(req, res, ctx); return true; }
  if (method === 'POST' && urlPath === '/api/library/claim') { handleClaim(req, res, ctx); return true; }
  if (method === 'GET' && urlPath === '/api/import/status') { handleImportStatus(req, res, ctx); return true; }
  if (method === 'POST' && (m = urlPath.match(/^\/api\/import\/([a-z]+)$/))) {
    if (!IMPORT_SOURCES.has(m[1])) { ctx.sendJsonError(res, 404, 'unknown import source'); return true; }
    handleImport(req, res, ctx, m[1]); return true;
  }
  return false;
}

/** Test hook. */
function resetLibraryState() { inFlight.clear(); setTestHooks({ fetchImpl: null, sleepImpl: null, backoffMs: null }); }

module.exports = { handleLibraryRoute, libraryRow, resetLibraryState, setTestHooks, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX };
