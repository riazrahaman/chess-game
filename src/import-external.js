'use strict';

/**
 * import-external.js — Wave 3 (roadmap §6 N3.17): import a player's public game
 * history from lichess.org or Chess.com into the local game archive, bound to
 * the importing account (`owner_id`), tagged with `source` and a per-source
 * `external_id` (lichess game id / Chess.com game URL) so re-imports skip
 * duplicates.
 *
 * Server-only module (never shipped to the browser). Network access is
 * dependency-injected (`fetchImpl`) so tests run with a stub; the backoff sleep
 * (`sleepImpl`) is injectable for the same reason.
 *
 *   importLichess({ username, ownerId, archive, max, since, fetchImpl })
 *   importChesscom({ username, ownerId, archive, max, since, fetchImpl })
 *     -> { imported, skipped, total, nextSince }
 *
 * Rate-limit friendly: strictly sequential requests, an identifying User-Agent,
 * exponential backoff on HTTP 429 (honouring Retry-After when present), and a
 * hard cap of MAX_GAMES_PER_IMPORT games per call.
 */

const GameArchive = require('./game-archive.js');

const MAX_GAMES_PER_IMPORT = 500;
const LICHESS_PAGE_MAX = 300;
const MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 2000;
const REQUEST_TIMEOUT_MS = 30000;
const USER_AGENT = 'chess-game-library-import/1.0 (+local-first chess app; contact: repository owner)';

const LICHESS_API = 'https://lichess.org';
const CHESSCOM_API = 'https://api.chess.com/pub';
const USERNAME_RE = /^[A-Za-z0-9_-]{2,40}$/;

class ImportError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ImportError';
    this.status = status || 502;
  }
}

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeUsername(username) {
  const u = String(username == null ? '' : username).trim();
  if (!USERNAME_RE.test(u)) throw new ImportError('invalid username', 400);
  return u;
}

function clampMax(max) {
  const n = Number(max);
  if (!Number.isFinite(n) || n <= 0) return MAX_GAMES_PER_IMPORT;
  return Math.min(Math.floor(n), MAX_GAMES_PER_IMPORT);
}

function retryAfterMs(res) {
  try {
    const raw = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
    if (!raw) return null;
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60000);
  } catch (_) { /* ignore */ }
  return null;
}

/**
 * One GET with 429 backoff. Resolves to the Response; throws ImportError on
 * non-OK status (404 -> "user not found") or after MAX_RETRIES 429s.
 */
async function fetchWithBackoff(url, { fetchImpl, sleepImpl, accept, backoffMs }) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new ImportError('fetch is not available in this runtime', 500);
  const sleep = sleepImpl || defaultSleep;
  let wait = typeof backoffMs === 'number' ? backoffMs : DEFAULT_BACKOFF_MS;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const headers = { 'User-Agent': USER_AGENT, Accept: accept || 'application/json' };
    const init = { method: 'GET', headers, redirect: 'follow' };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      init.signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    }
    let res;
    try {
      res = await doFetch(url, init);
    } catch (err) {
      throw new ImportError(`network error: ${err && err.message ? err.message : err}`, 502);
    }
    if (res.status === 429) {
      if (attempt === MAX_RETRIES) throw new ImportError('rate limited by upstream (429); try again later', 429);
      const ra = retryAfterMs(res);
      await sleep(ra != null ? ra : wait);
      wait *= 2;
      continue;
    }
    if (res.status === 404) throw new ImportError('user not found', 404);
    if (!res.ok) throw new ImportError(`upstream error ${res.status}`, 502);
    return res;
  }
  throw new ImportError('rate limited by upstream (429); try again later', 429);
}

/** Split a multi-game PGN export into individual game strings. */
function splitPgnGames(text) {
  if (!text || typeof text !== 'string') return [];
  const parts = text.replace(/\r\n?/g, '\n').split(/\n(?=\[Event\s)/);
  return parts.map(p => p.trim()).filter(p => p.startsWith('['));
}

function lichessGameId(parsed) {
  const site = parsed && parsed.headers ? parsed.headers.Site || '' : '';
  const m = site.match(/lichess\.org\/([A-Za-z0-9]{8})/);
  if (m) return m[1];
  const id = parsed && parsed.headers && parsed.headers.GameId;
  return id ? String(id) : '';
}

function lichessTimestamp(parsed) {
  const h = parsed && parsed.headers ? parsed.headers : {};
  const d = h.UTCDate || h.Date || '';
  const t = h.UTCTime || '00:00:00';
  const m = d.match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  if (!m) return null;
  const ts = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${t}Z`);
  return Number.isFinite(ts) ? ts : null;
}

function pgnDateFromEpoch(ms) {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '.');
}

/**
 * Store one parsed game unless (source, externalId) already exists.
 * Returns 'imported' | 'skipped'.
 */
function storeGame(archive, { source, externalId, ownerId, pgn, parsed, seen }) {
  if (!externalId) return 'skipped';
  const key = `${source}:${externalId}`;
  if (seen.has(key)) return 'skipped';
  seen.add(key);
  if (archive.findGameByExternal(source, externalId)) return 'skipped';
  archive.saveGame({
    white: parsed.white,
    black: parsed.black,
    date: parsed.date,
    result: parsed.result,
    eco: parsed.eco || '',
    moves: parsed.moves,
    pgn,
    owner_id: ownerId,
    source,
    external_id: externalId
  });
  return 'imported';
}

// ---------------------------------------------------------------------------
// lichess
// ---------------------------------------------------------------------------
/**
 * GET /api/games/user/{username} (PGN stream). Newest first; pages by `until`
 * (the previous page's oldest timestamp - 1) and stops at `since`.
 */
async function importLichess(options = {}) {
  const username = normalizeUsername(options.username);
  const ownerId = options.ownerId == null ? null : String(options.ownerId);
  if (!ownerId) throw new ImportError('ownerId is required', 401);
  const archive = options.archive || GameArchive.getArchive();
  const cap = clampMax(options.max);
  const since = Number.isFinite(Number(options.since)) && Number(options.since) > 0 ? Number(options.since) : null;
  const base = options.baseUrl || LICHESS_API;
  const seen = new Set();

  let imported = 0, skipped = 0, total = 0, nextSince = since;
  let until = null;
  let remaining = cap;
  const pageSize = Number.isFinite(Number(options.pageSize)) && Number(options.pageSize) > 0
    ? Math.min(Math.floor(Number(options.pageSize)), LICHESS_PAGE_MAX) : LICHESS_PAGE_MAX;

  while (remaining > 0) {
    const pageMax = Math.min(pageSize, remaining);
    const params = new URLSearchParams({
      max: String(pageMax), pgnInJson: 'false', clocks: 'false', evals: 'false', opening: 'true', moves: 'true', tags: 'true'
    });
    if (since) params.set('since', String(since));
    if (until) params.set('until', String(until));
    const url = `${base}/api/games/user/${encodeURIComponent(username)}?${params}`;
    const res = await fetchWithBackoff(url, { fetchImpl: options.fetchImpl, sleepImpl: options.sleepImpl, backoffMs: options.backoffMs, accept: 'application/x-chess-pgn' });
    const text = await res.text();
    const games = splitPgnGames(text);
    if (games.length === 0) break;

    let oldest = null;
    for (const pgn of games) {
      if (remaining <= 0) break;
      const parsed = archive.parsePgn(pgn);
      const externalId = lichessGameId(parsed);
      const ts = lichessTimestamp(parsed);
      if (ts != null) {
        if (since && ts < since) { remaining = 0; break; }
        if (oldest == null || ts < oldest) oldest = ts;
        if (nextSince == null || ts + 1 > nextSince) nextSince = ts + 1;
      }
      total++;
      remaining--;
      if (storeGame(archive, { source: 'lichess', externalId, ownerId, pgn, parsed, seen }) === 'imported') imported++;
      else skipped++;
    }
    if (games.length < pageMax || oldest == null) break;
    until = oldest - 1;
    if (since && until < since) break;
  }

  return { source: 'lichess', username, imported, skipped, total, nextSince };
}

// ---------------------------------------------------------------------------
// Chess.com
// ---------------------------------------------------------------------------
/**
 * GET /pub/player/{username}/games/archives -> monthly archive URLs (oldest
 * first); each GET .../games/YYYY/MM returns { games: [{ url, pgn, end_time }] }.
 * Walks months newest first, games within a month newest first, stops at
 * `since` (ms) or the cap.
 */
async function importChesscom(options = {}) {
  const username = normalizeUsername(options.username);
  const ownerId = options.ownerId == null ? null : String(options.ownerId);
  if (!ownerId) throw new ImportError('ownerId is required', 401);
  const archive = options.archive || GameArchive.getArchive();
  const cap = clampMax(options.max);
  const since = Number.isFinite(Number(options.since)) && Number(options.since) > 0 ? Number(options.since) : null;
  const base = options.baseUrl || CHESSCOM_API;
  const fetchOpts = { fetchImpl: options.fetchImpl, sleepImpl: options.sleepImpl, backoffMs: options.backoffMs, accept: 'application/json' };
  const seen = new Set();

  const listRes = await fetchWithBackoff(`${base}/player/${encodeURIComponent(username.toLowerCase())}/games/archives`, fetchOpts);
  let listing;
  try { listing = await listRes.json(); } catch (_) { throw new ImportError('invalid archives response', 502); }
  const archives = Array.isArray(listing && listing.archives) ? listing.archives.slice().reverse() : [];

  let imported = 0, skipped = 0, total = 0, nextSince = since;
  let remaining = cap;
  let stop = false;

  for (const monthUrl of archives) {
    if (remaining <= 0 || stop) break;
    if (!/^https?:\/\/api\.chess\.com\/pub\/player\/[^/]+\/games\/\d{4}\/\d{2}$/.test(String(monthUrl)) && !options.baseUrl) continue;
    // Skip whole months that end before `since` (YYYY/MM in the URL).
    if (since) {
      const m = String(monthUrl).match(/(\d{4})\/(\d{2})$/);
      if (m) {
        const monthEnd = Date.UTC(Number(m[1]), Number(m[2]), 1) - 1; // last ms of that month
        if (monthEnd < since) { stop = true; break; }
      }
    }
    const res = await fetchWithBackoff(String(monthUrl), fetchOpts);
    let month;
    try { month = await res.json(); } catch (_) { throw new ImportError('invalid monthly archive response', 502); }
    const games = Array.isArray(month && month.games) ? month.games.slice().reverse() : [];
    for (const g of games) {
      if (remaining <= 0) break;
      if (!g || typeof g.pgn !== 'string' || !g.pgn.trim()) continue;
      const endMs = Number.isFinite(Number(g.end_time)) ? Number(g.end_time) * 1000 : null;
      if (since && endMs != null && endMs < since) { stop = true; break; }
      if (endMs != null && (nextSince == null || endMs + 1 > nextSince)) nextSince = endMs + 1;
      const parsed = archive.parsePgn(g.pgn);
      if (!parsed.date && endMs != null) parsed.date = pgnDateFromEpoch(endMs);
      const externalId = typeof g.url === 'string' && g.url ? g.url : (parsed.headers && parsed.headers.Link) || '';
      total++;
      remaining--;
      if (storeGame(archive, { source: 'chesscom', externalId, ownerId, pgn: g.pgn.trim(), parsed, seen }) === 'imported') imported++;
      else skipped++;
    }
  }

  return { source: 'chesscom', username, imported, skipped, total, nextSince };
}

/** Dispatch by source name; records the run in the archive's `imports` table. */
async function runImport(source, options = {}) {
  const fn = source === 'lichess' ? importLichess : source === 'chesscom' ? importChesscom : null;
  if (!fn) throw new ImportError('unknown import source', 400);
  const archive = options.archive || GameArchive.getArchive();
  let result;
  try {
    result = await fn(Object.assign({}, options, { archive }));
  } catch (err) {
    if (options.ownerId && err && err.status !== 400 && err.status !== 401) {
      archive.saveImport({ ownerId: options.ownerId, source, username: String(options.username || ''), lastRunAt: Date.now(), error: err.message });
    }
    throw err;
  }
  archive.saveImport({
    ownerId: options.ownerId, source, username: result.username, lastRunAt: Date.now(),
    imported: result.imported, skipped: result.skipped, total: result.total, nextSince: result.nextSince, error: null
  });
  return result;
}

module.exports = {
  importLichess,
  importChesscom,
  runImport,
  fetchWithBackoff,
  splitPgnGames,
  lichessGameId,
  lichessTimestamp,
  ImportError,
  MAX_GAMES_PER_IMPORT,
  LICHESS_PAGE_MAX,
  USER_AGENT
};
