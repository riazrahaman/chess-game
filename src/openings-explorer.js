'use strict';

/**
 * openings-explorer.js — Real-data opening explorer.
 *
 * Replaces the fabricated win-rate percentages in openings-db.js with:
 *  (a) Real ECO/name/moves data sourced from the lichess-org/chess-openings
 *      TSV format, loaded at startup or on demand.
 *  (b) A personal explorer that queries the SQLite game archive to report
 *      what the player actually plays in a given position and their real
 *      win/draw/loss record — no fabricated numbers.
 *
 * Gate 4: This module is a pure analysis/display layer.  It never calls
 * makeMove or createInitialBoard and never touches referee state.
 *
 * Public API:
 *   loadFromTSV(tsvText)        — parse TSV, populate internal map. Accepts a
 *                                 `uci`/`moves` column, or (Node only, via
 *                                 chess.js) the lichess `pgn` SAN column.
 *   loadFromFile(path)          — Node: read + loadFromTSV; returns the map
 *   ensureDefaultLoaded()       — Node: load data/openings.tsv once (idempotent)
 *   getTSVMap()                 — retrieve the parsed TSV map
 *   exploreOpening(moves)       — lookup { eco, name, pgn?, matchedPlies, isExact }
 *   continuations(moves)        — next moves seen in TSV lines extending `moves`
 *   linesExtending(moves)       — TSV entries whose move list strictly extends `moves`
 *   isKnownLine(moves)          — `moves` is a TSV line or a prefix of one
 *   personalExplorer(archive, movesOrFen) — query archive for real win rates
 *   getBundledOpenings()        — returns the bundled real-data opening entries
 */

/* ------------------------------------------------------------------ *
 * Lazy-load dependencies                                             *
 * ------------------------------------------------------------------ */

let OpeningsDB = null;
let GameArchive = null;
let ChessCtor = null;   // chess.js (Node only) — SAN→UCI for the lichess `pgn` column
let nodeFs = null;
let nodePath = null;
if (typeof require === 'function') {
  try { OpeningsDB = require('./openings-db.js'); } catch (_) {}
  try { GameArchive = require('./game-archive.js'); } catch (_) {}
  try { ChessCtor = require('chess.js').Chess; } catch (_) {}
  try { nodeFs = require('fs'); nodePath = require('path'); } catch (_) {}
}
if (!OpeningsDB && typeof window !== 'undefined') OpeningsDB = window.Openings;
if (!GameArchive && typeof window !== 'undefined') GameArchive = window.GameArchive;

/* ------------------------------------------------------------------ *
 * Bundled real opening data (ECO + name + UCI move sequence)         *
 * Sourced from lichess-org/chess-openings.  No fabricated stats.     *
 * ------------------------------------------------------------------ */

const BUNDLED_OPENINGS = [
  { eco: 'A00', name: 'Starting Position', moves: [] },
  { eco: 'B00', name: "King's Pawn Opening", moves: ['e2e4'] },
  { eco: 'C20', name: 'Open Game', moves: ['e2e4', 'e7e5'] },
  { eco: 'C40', name: "King's Knight Opening", moves: ['e2e4', 'e7e5', 'g1f3'] },
  { eco: 'C44', name: 'Open Game: Three / Four Knights Setup', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6'] },
  { eco: 'C50', name: 'Italian Game', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'] },
  { eco: 'C53', name: 'Italian Game: Giuoco Piano', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5'] },
  { eco: 'C55', name: 'Italian Game: Two Knights Defense', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6'] },
  { eco: 'C60', name: 'Ruy Lopez (Spanish Opening)', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'] },
  { eco: 'C68', name: 'Ruy Lopez: Morphy Defense', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6'] },
  { eco: 'B20', name: 'Sicilian Defense', moves: ['e2e4', 'c7c5'] },
  { eco: 'B50', name: 'Sicilian Defense: Modern Variations', moves: ['e2e4', 'c7c5', 'g1f3', 'd7d6'] },
  { eco: 'B90', name: 'Sicilian Defense: Najdorf Variation', moves: ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'a7a6'] },
  { eco: 'C00', name: 'French Defense', moves: ['e2e4', 'e7e6'] },
  { eco: 'B10', name: 'Caro-Kann Defense', moves: ['e2e4', 'c7c6'] },
  { eco: 'B01', name: 'Scandinavian Defense', moves: ['e2e4', 'd7d5'] },
  { eco: 'A40', name: "Queen's Pawn Game", moves: ['d2d4'] },
  { eco: 'D00', name: "Queen's Pawn Game: Closed", moves: ['d2d4', 'd7d5'] },
  { eco: 'D06', name: "Queen's Gambit", moves: ['d2d4', 'd7d5', 'c2c4'] },
  { eco: 'D30', name: "Queen's Gambit Declined", moves: ['d2d4', 'd7d5', 'c2c4', 'e7e6'] },
  { eco: 'D10', name: 'Slav Defense', moves: ['d2d4', 'd7d5', 'c2c4', 'c7c6'] },
  { eco: 'A45', name: 'Indian Defense', moves: ['d2d4', 'g8f6'] },
  { eco: 'E60', name: "King's Indian Defense", moves: ['d2d4', 'g8f6', 'c2c4', 'g7g6'] },
  { eco: 'A10', name: 'English Opening', moves: ['c2c4'] },
  { eco: 'A04', name: 'Réti Opening', moves: ['g1f3'] }
];

/* ------------------------------------------------------------------ *
 * TSV parser                                                         *
 * ------------------------------------------------------------------ *
 * Expected columns (tab-separated):                                  *
 *   eco  name  pgn  epd  uci                                         *
 * or the minimal subset:                                             *
 *   eco  name  uci                                                   *
 * where uci is a space-joined UCI move sequence (e.g. "e2e4 e7e5").  *
 * ------------------------------------------------------------------ */

let _tsvMap = null; // Map<string, {eco, name, moves, pgn}>
// Prefix index built alongside the map: key (space-joined UCI prefix, '' for
// the start position) → Map<nextUci, count of TSV lines that continue with it>.
// Counts are "named lines in the TSV", never game counts.
let _prefixIndex = null;
let _defaultLoadAttempted = false;

/**
 * Parse a TSV string and populate the internal opening map.
 * The map is keyed by space-joined UCI moves (same format as OPENINGS_DB).
 *
 * @param {string} tsvText  — raw TSV text with header row
 * @returns {Map<string, {eco, name, moves}>} parsed map
 */
function loadFromTSV(tsvText) {
  if (!tsvText || typeof tsvText !== 'string') {
    _tsvMap = new Map();
    return _tsvMap;
  }

  const lines = tsvText.split(/\r?\n/);
  if (lines.length === 0) {
    _tsvMap = new Map();
    return _tsvMap;
  }

  // Parse header to find column indices
  const header = lines[0].split('\t').map(h => h.trim().toLowerCase());
  const colIdx = {};
  for (let i = 0; i < header.length; i++) {
    colIdx[header[i]] = i;
  }

  // Determine which columns we have
  const ecoCol = colIdx.eco != null ? colIdx.eco : 0;
  const nameCol = colIdx.name != null ? colIdx.name : 1;
  const uciCol = colIdx.uci != null ? colIdx.uci : (colIdx.moves != null ? colIdx.moves : null);

  const map = new Map();
  const index = new Map();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    const cols = line.split('\t');
    const eco = (cols[ecoCol] || '').trim();
    const name = (cols[nameCol] || '').trim();
    const pgn = colIdx.pgn != null && cols[colIdx.pgn] ? cols[colIdx.pgn].trim() : null;

    let movesArr = [];
    if (uciCol != null && cols[uciCol]) {
      movesArr = cols[uciCol].trim().split(/\s+/).filter(m => m.length > 0);
    } else if (pgn) {
      // lichess chess-openings ships SAN only; convert with chess.js (Node).
      movesArr = _pgnToUci(pgn);
      if (movesArr.length === 0) continue; // unconvertible row: skip, never guess
    }

    const key = movesArr.join(' ');
    if (key || eco) {
      const entry = { eco, name, moves: movesArr };
      if (pgn) entry.pgn = pgn;
      map.set(key, entry);
      for (let k = 0; k < movesArr.length; k++) {
        const prefix = movesArr.slice(0, k).join(' ');
        let bucket = index.get(prefix);
        if (!bucket) { bucket = new Map(); index.set(prefix, bucket); }
        bucket.set(movesArr[k], (bucket.get(movesArr[k]) || 0) + 1);
      }
    }
  }

  _tsvMap = map;
  _prefixIndex = index;
  return map;
}

/**
 * Node only: read a TSV file from disk and load it. Returns the map, or null
 * when the file cannot be read (the caller degrades to bundled data).
 * @param {string} filePath
 */
function loadFromFile(filePath) {
  if (!nodeFs || typeof filePath !== 'string') return null;
  try {
    const text = nodeFs.readFileSync(filePath, 'utf8');
    return loadFromTSV(text);
  } catch (_) {
    return null;
  }
}

/** Default dataset location (repo `data/openings.tsv`; see data/README-openings.md). */
function defaultTSVPath() {
  if (!nodePath) return null;
  return nodePath.join(__dirname, '..', 'data', 'openings.tsv');
}

/**
 * Node only: load data/openings.tsv once. Idempotent; returns true when a
 * non-empty TSV map is available (already loaded or loaded now).
 */
function ensureDefaultLoaded() {
  if (_tsvMap && _tsvMap.size > 0) return true;
  if (_defaultLoadAttempted) return false;
  _defaultLoadAttempted = true;
  const p = defaultTSVPath();
  if (!p) return false;
  const map = loadFromFile(p);
  return !!(map && map.size > 0);
}

/**
 * Get the currently loaded TSV map (or null if not loaded).
 * @returns {Map<string, {eco, name, moves}>|null}
 */
function getTSVMap() {
  return _tsvMap;
}

/**
 * Return the bundled real-data opening entries.
 * @returns {object[]} array of {eco, name, moves}
 */
function getBundledOpenings() {
  return BUNDLED_OPENINGS.map(o => ({ eco: o.eco, name: o.name, moves: o.moves.slice() }));
}

/**
 * Convert PGN movetext (SAN) to UCI moves with chess.js (Node only; the
 * browser build never receives the `pgn` column). Returns [] when chess.js is
 * unavailable or the movetext is invalid — a row is then skipped, not guessed.
 *
 * @param {string} pgn  — PGN movetext (no headers)
 * @returns {string[]}  — UCI move strings (e.g. ['e2e4', 'e7e5'])
 */
function _pgnToUci(pgn) {
  if (!pgn || !ChessCtor) return [];
  try {
    const c = new ChessCtor();
    c.loadPgn(String(pgn));
    return c.history({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''));
  } catch (_) {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Opening explorer                                                   *
 * ------------------------------------------------------------------ */

/**
 * Lookup opening info for a move sequence.
 *
 * Tries the TSV map first (if loaded), then the bundled real-data entries,
 * then falls back to the existing findOpening from openings-db.js.
 *
 * @param {string[]} moves  — UCI move strings e.g. ['e2e4', 'e7e5']
 * @returns {object} { eco, name, matchedPlies, isExact, stats? }
 */
function exploreOpening(moves) {
  if (!moves || !Array.isArray(moves) || moves.length === 0) {
    return { eco: 'A00', name: 'Starting Position', matchedPlies: 0, isExact: true };
  }

  // 1. Try TSV map (exact key match, then prefix)
  if (_tsvMap && _tsvMap.size > 0) {
    const result = _prefixLookup(_tsvMap, moves);
    if (result) {
      const out = {
        eco: result.entry.eco,
        name: result.entry.name,
        matchedPlies: result.matchedPlies,
        isExact: result.matchedPlies === moves.length
      };
      if (result.entry.pgn) out.pgn = result.entry.pgn;
      return out;
    }
  }

  // 2. Try bundled real-data entries (exact, then prefix)
  const bundledResult = _prefixLookupBundled(moves);
  if (bundledResult) {
    return {
      eco: bundledResult.entry.eco,
      name: bundledResult.entry.name,
      matchedPlies: bundledResult.matchedPlies,
      isExact: bundledResult.matchedPlies === moves.length
    };
  }

  // 3. Fallback to openings-db.js findOpening
  if (OpeningsDB && typeof OpeningsDB.findOpening === 'function') {
    const fallback = OpeningsDB.findOpening(moves);
    if (fallback) {
      return {
        eco: fallback.eco || 'A00',
        name: fallback.name || 'Unknown Opening',
        matchedPlies: fallback.matchedPlies || 0,
        isExact: fallback.isExact || false
      };
    }
  }

  return { eco: 'A00', name: 'Unknown Opening', matchedPlies: 0, isExact: false };
}

/**
 * Prefix lookup in a Map keyed by space-joined UCI moves.
 * @param {Map} map
 * @param {string[]} moves
 * @returns {{entry, matchedPlies}|null}
 */
function _prefixLookup(map, moves) {
  for (let i = moves.length; i > 0; i--) {
    const key = moves.slice(0, i).join(' ');
    if (map.has(key)) {
      return { entry: map.get(key), matchedPlies: i };
    }
  }
  return null;
}

/**
 * Prefix lookup in the bundled openings array.
 * @param {string[]} moves
 * @returns {{entry, matchedPlies}|null}
 */
function _prefixLookupBundled(moves) {
  let best = null;
  let bestPlies = 0;
  for (const entry of BUNDLED_OPENINGS) {
    if (entry.moves.length === 0) continue;
    if (entry.moves.length > moves.length) continue;
    let match = true;
    for (let i = 0; i < entry.moves.length; i++) {
      if (entry.moves[i] !== moves[i]) { match = false; break; }
    }
    if (match && entry.moves.length > bestPlies) {
      best = entry;
      bestPlies = entry.moves.length;
    }
  }
  return best ? { entry: best, matchedPlies: bestPlies } : null;
}

/* ------------------------------------------------------------------ *
 * Continuations (what the TSV knows after a given move sequence)     *
 * ------------------------------------------------------------------ */

function _normalizeMoves(moves) {
  if (Array.isArray(moves)) return moves.filter(m => typeof m === 'string' && m.length > 0);
  if (typeof moves === 'string') return moves.trim().split(/\s+/).filter(m => m.length > 0);
  return [];
}

/**
 * TSV entries whose move list strictly extends `moves` (same prefix, longer).
 * Empty when no TSV is loaded.
 * @param {string[]|string} moves
 * @returns {Array<{eco,name,moves,pgn?}>}
 */
function linesExtending(moves) {
  if (!_tsvMap || _tsvMap.size === 0) return [];
  const arr = _normalizeMoves(moves);
  const n = arr.length;
  const out = [];
  for (const entry of _tsvMap.values()) {
    if (entry.moves.length <= n) continue;
    let ok = true;
    for (let i = 0; i < n; i++) {
      if (entry.moves[i] !== arr[i]) { ok = false; break; }
    }
    if (ok) out.push(entry);
  }
  return out;
}

/**
 * Next moves seen in TSV lines that continue from `moves`.
 * `lines` = how many named TSV lines continue with that move (NOT a game count).
 * `eco`/`name` come from the position reached if it is itself named, else from
 * the shortest named line through that move.
 * @param {string[]|string} moves
 * @returns {Array<{uci:string, lines:number, eco:string|null, name:string|null, named:boolean}>}
 */
function continuations(moves) {
  if (!_prefixIndex) return [];
  const arr = _normalizeMoves(moves);
  const bucket = _prefixIndex.get(arr.join(' '));
  if (!bucket) return [];
  const out = [];
  for (const [uci, lines] of bucket.entries()) {
    const nextKey = arr.concat(uci).join(' ');
    const direct = _tsvMap.get(nextKey);
    let eco = null, name = null, named = false;
    if (direct) {
      eco = direct.eco; name = direct.name; named = true;
    } else {
      let best = null;
      for (const e of linesExtending(arr.concat(uci))) {
        if (!best || e.moves.length < best.moves.length) best = e;
      }
      if (best) { eco = best.eco; name = best.name; }
    }
    out.push({ uci, lines, eco, name, named });
  }
  out.sort((a, b) => b.lines - a.lines || a.uci.localeCompare(b.uci));
  return out;
}

/**
 * Is `moves` a known book line — exactly a TSV entry, or a prefix of one?
 * The empty sequence (start position) is a prefix of every line.
 * @param {string[]|string} moves
 * @returns {boolean}
 */
function isKnownLine(moves) {
  if (!_tsvMap || _tsvMap.size === 0) return false;
  const arr = _normalizeMoves(moves);
  const key = arr.join(' ');
  if (_tsvMap.has(key)) return true;
  return !!(_prefixIndex && _prefixIndex.has(key));
}

/* ------------------------------------------------------------------ *
 * Personal explorer (queries the game archive)                       *
 * ------------------------------------------------------------------ */

/**
 * Query the game archive for the player's actual results in a position.
 *
 * Matches games whose move sequence starts with the given prefix.
 * Returns real win/draw/loss counts — never fabricated.
 *
 * @param {object} archive      — GameArchive instance (or module with listGames)
 * @param {string[]|string} movesOrFen — UCI move array or space-joined string
 * @returns {object|null} { count, wins, draws, losses, winRate, drawRate, lossRate, games[] }
 *                        Returns null when archive is unavailable or query fails.
 *                        Returns {count: 0, ...} when no games match.
 */
function personalExplorer(archive, movesOrFen) {
  if (!archive) return null;

  // Normalize moves to array
  let movesArr;
  if (Array.isArray(movesOrFen)) {
    movesArr = movesOrFen;
  } else if (typeof movesOrFen === 'string') {
    movesArr = movesOrFen.trim().split(/\s+/).filter(m => m.length > 0);
  } else {
    return null;
  }

  // We need listGames or searchGames to query the archive
  let listFn = null;
  if (typeof archive.listGames === 'function') listFn = archive.listGames.bind(archive);
  else if (typeof archive.list === 'function') listFn = archive.list.bind(archive);
  else if (typeof archive.searchGames === 'function') {
    // Fall back to searchGames with moves query
    listFn = archive.searchGames.bind(archive);
  }

  if (!listFn) return null;

  try {
    // Fetch all games (up to a reasonable limit) and filter by move prefix
    const limit = 1000;
    let games;
    if (typeof archive.searchGames === 'function' && movesArr.length > 0) {
      // searchGames with a moves string pattern will LIKE-match the moves column
      const prefix = movesArr.join(' ');
      games = archive.searchGames(prefix, { limit });
    } else {
      games = listFn({ limit });
    }

    if (!Array.isArray(games)) return null;

    // Filter games whose moves field starts with our prefix
    const prefix = movesArr.join(' ');
    const matched = games.filter(function (g) {
      if (!g.moves || typeof g.moves !== 'string') return false;
      // The moves field is space-joined UCI; match whole plies only
      // ('e7e8' must not match a game starting 'e7e8q ...').
      if (movesArr.length === 0) return true;
      return g.moves === prefix || g.moves.startsWith(prefix + ' ');
    });

    const count = matched.length;
    let wins = 0, draws = 0, losses = 0;

    for (const game of matched) {
      const result = game.result || '*';
      if (result === '1-0') wins++;
      else if (result === '0-1') losses++;
      else if (result === '1/2-1/2') draws++;
    }

    return {
      count,
      wins,
      draws,
      losses,
      winRate: count > 0 ? Math.round((wins / count) * 100) : 0,
      drawRate: count > 0 ? Math.round((draws / count) * 100) : 0,
      lossRate: count > 0 ? Math.round((losses / count) * 100) : 0,
      games: matched.map(function (g) {
        return { id: g.id, white: g.white, black: g.black, result: g.result, date: g.date, eco: g.eco };
      })
    };
  } catch (_) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Module exports                                                     *
 * ------------------------------------------------------------------ */

const OpeningsExplorerAPI = {
  loadFromTSV,
  loadFromFile,
  ensureDefaultLoaded,
  defaultTSVPath,
  getTSVMap,
  exploreOpening,
  continuations,
  linesExtending,
  isKnownLine,
  personalExplorer,
  getBundledOpenings,
  BUNDLED_OPENINGS
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = OpeningsExplorerAPI;
}

if (typeof window !== 'undefined') {
  window.OpeningsExplorer = OpeningsExplorerAPI;
}