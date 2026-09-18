(function() {
'use strict';

/**
 * masters-db.js — A2.4 book-theory mistake whitelist.
 *
 * "Book" here means: the move sequence lies on a NAMED OPENING LINE in
 * data/openings.tsv (lichess-org/chess-openings, CC0 — see
 * data/README-openings.md). It is a presence check, nothing more.
 *
 * Wave 2 / E3: the previous version of this file shipped 21 positions with
 * uncited round-number "master game counts" (42000, 38000, …) and called them
 * a "real-data subset". Those numbers were invented and are gone. This module
 * exposes NO game counts: every `games` field is `null`, and
 * `MIN_MASTER_GAMES` no longer exists. If real master-game statistics are ever
 * wanted they must come from a cited source (e.g. explorer.lichess.ovh/masters,
 * proxied) — never from a literal in this file.
 *
 * Book data source, by runtime:
 *   Node    — auto-loaded from the TSV through openings-explorer.js
 *             (`ensureDefaultLoaded`), so the server and the selftests see the
 *             full ~3,800-line book.
 *   Browser — the TSV is server-side only. The Analysis view feeds the answers
 *             of GET /api/openings/lookup into `addBookPosition(moves,
 *             continuations)`; positions not yet looked up are "unknown", not
 *             "not book" (`isBookPosition(...).known === false`).
 *
 * Gate 4: pure analysis/display layer — never calls makeMove or
 * createInitialBoard, never touches referee state.
 *
 * Public API:
 *   isBookPosition(moves)     — { book, known, games: null, continuations: [{move, games: null, lines?}] }
 *   isBookMove(moves, uci)    — { book, known, games: null }
 *   whitelistMistakes(review, moves) — reclassify flagged moves that are book
 *   addBookPosition(moves, continuations) — browser: cache a server lookup
 *   loadBookLines(lines)      — bulk: array of UCI move arrays (or strings)
 *   getMastersDbSize()        — number of known book positions
 *   BOOK_SOURCE
 */

const BOOK_SOURCE = 'lichess-org/chess-openings (data/openings.tsv, CC0)';

let explorer = null;
if (typeof require === 'function') {
  try { explorer = require('./openings-explorer.js'); } catch (_) { explorer = null; }
}

// Browser-side cache: key (space-joined UCI) → Array<{ move, games: null, lines }>
// Populated by addBookPosition / loadBookLines. In Node the TSV is authoritative
// and this cache is only consulted when the TSV is unavailable.
const BOOK_CACHE = new Map();

function normalizeMoves(moves) {
  if (Array.isArray(moves)) return moves.filter(m => typeof m === 'string' && m.length > 0).map(m => m.toLowerCase());
  if (typeof moves === 'string') return moves.trim().split(/\s+/).filter(m => m.length > 0).map(m => m.toLowerCase());
  return [];
}

function tsvAvailable() {
  if (!explorer || typeof explorer.ensureDefaultLoaded !== 'function') return false;
  try { return explorer.ensureDefaultLoaded(); } catch (_) { return false; }
}

/**
 * Continuations for the position reached by `moves`, or null when the position
 * is unknown to every available source.
 */
function continuationsFor(arr) {
  const key = arr.join(' ');
  if (tsvAvailable()) {
    if (!explorer.isKnownLine(arr)) return null;
    return explorer.continuations(arr).map(c => ({ move: c.uci, games: null, lines: c.lines, eco: c.eco, name: c.name }));
  }
  if (BOOK_CACHE.has(key)) return BOOK_CACHE.get(key).slice();
  return null;
}

/**
 * Is the position reached by `moves` on a known book line?
 * `known` is false when no source has information about this position
 * (browser before a lookup) — callers should show "unknown", not "not book".
 * @returns {{book:boolean, known:boolean, games:null, continuations:Array}}
 */
function isBookPosition(moves) {
  const arr = normalizeMoves(moves);
  if (arr.length === 0) {
    // The start position is on every line; it is book if any book exists.
    const any = tsvAvailable() || BOOK_CACHE.size > 0;
    return { book: any, known: any, games: null, continuations: any ? (continuationsFor(arr) || []) : [] };
  }
  const conts = continuationsFor(arr);
  if (conts === null) return { book: false, known: false, games: null, continuations: [] };
  return { book: true, known: true, games: null, continuations: conts };
}

/**
 * Is `uci` (the next move from the position reached by `moves`) a book
 * continuation?
 * @returns {{book:boolean, known:boolean, games:null}}
 */
function isBookMove(moves, uci) {
  if (typeof uci !== 'string') return { book: false, known: false, games: null };
  const arr = normalizeMoves(moves);
  const conts = continuationsFor(arr);
  if (conts === null) return { book: false, known: false, games: null };
  const hit = conts.some(c => c.move === uci.toLowerCase());
  return { book: hit, known: true, games: null };
}

/**
 * Downgrade engine-flagged mistakes that are actually book-true moves.
 * `review` = output of MoveReview.reviewGame (has .moves[] with key, move, color, ply).
 * `moveHistory` = full UCI move list for the game. Returns a COPY.
 *
 * A move classified as mistake/blunder/inaccuracy is reclassified to BEST
 * (with `bookTheory: true`) when the move is a known book continuation of the
 * position before it. Unknown positions are left untouched.
 */
function whitelistMistakes(review, moveHistory) {
  if (!review || !Array.isArray(review.moves)) return review;
  const moves = normalizeMoves(moveHistory);
  const flaggedKeys = { mistake: true, blunder: true, inaccuracy: true };

  const copy = {
    whiteAccuracy: review.whiteAccuracy,
    blackAccuracy: review.blackAccuracy,
    counts: review.counts,
    moves: review.moves.map(m => ({ ...m }))
  };

  for (const m of copy.moves) {
    if (!flaggedKeys[m.key]) continue;
    const ply = m.ply || 0;
    if (ply < 1) continue;
    const prefix = moves.slice(0, ply - 1);
    const played = m.move;
    if (!played) continue;
    const check = isBookMove(prefix, played);
    if (check.book) {
      m.key = 'best';
      m.label = 'Best';
      m.bookTheory = true;
      m.bookSource = BOOK_SOURCE;
      m.accuracy = 100;
    }
  }
  return copy;
}

/**
 * Browser: record what GET /api/openings/lookup said about a position.
 * `continuations` = [{ uci|move, lines? }] (the route's shape is accepted as-is).
 */
function addBookPosition(moves, continuations) {
  const arr = normalizeMoves(moves);
  const list = Array.isArray(continuations) ? continuations : [];
  BOOK_CACHE.set(arr.join(' '), list
    .map(c => ({ move: String(c.uci || c.move || '').toLowerCase(), games: null, lines: typeof c.lines === 'number' ? c.lines : null, eco: c.eco || null, name: c.name || null }))
    .filter(c => c.move.length >= 4));
}

/**
 * Bulk-load book lines (array of UCI move arrays or space-joined strings).
 * Every prefix of every line becomes a known position.
 */
function loadBookLines(lines) {
  if (!Array.isArray(lines)) return 0;
  let added = 0;
  for (const line of lines) {
    const arr = normalizeMoves(line);
    for (let k = 0; k < arr.length; k++) {
      const key = arr.slice(0, k).join(' ');
      const bucket = BOOK_CACHE.get(key) || [];
      const existing = bucket.find(c => c.move === arr[k]);
      if (existing) existing.lines = (existing.lines || 0) + 1;
      else bucket.push({ move: arr[k], games: null, lines: 1, eco: null, name: null });
      BOOK_CACHE.set(key, bucket);
      added++;
    }
  }
  return added;
}

function getMastersDbSize() {
  if (tsvAvailable()) {
    const map = explorer.getTSVMap();
    return map ? map.size : 0;
  }
  return BOOK_CACHE.size;
}

const MastersDbModule = {
  BOOK_SOURCE,
  isBookPosition,
  isBookMove,
  whitelistMistakes,
  addBookPosition,
  loadBookLines,
  getMastersDbSize
};

if (typeof window !== 'undefined') {
  window.MastersDb = MastersDbModule;
}
if (typeof module !== 'undefined') {
  module.exports = MastersDbModule;
}
})();
