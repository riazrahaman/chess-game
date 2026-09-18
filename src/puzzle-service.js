'use strict';

let fs = null;
let Chess = null;
if (typeof require === 'function') {
  try { fs = require('fs'); } catch (_) {}
  try { Chess = require('chess.js').Chess; } catch (_) {}
}
if (!Chess && typeof globalThis !== 'undefined' && globalThis.Chess) {
  Chess = globalThis.Chess;
}

let puzzles = [];
let puzzlesById = new Map();

/**
 * Parses CSV text, including quoted fields, escaped quotes, and quoted newlines.
 * @param {string} text
 * @returns {string[][]}
 */
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (char === '\r' && text[i + 1] === '\n') i++;
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Replays a Lichess coordinate line locally from its FEN and returns SAN.
 * This only translates puzzle data; it never reads or mutates referee state.
 * @param {string} fen
 * @param {string[]} uciMoves
 * @returns {string[]}
 */
function uciToSan(fen, uciMoves) {
  if (!Chess) throw new Error('puzzle-service.js: chess.js (Chess constructor) not found');
  if (typeof fen !== 'string' || !Array.isArray(uciMoves)) {
    throw new TypeError('uciToSan expects a FEN string and an array of UCI moves');
  }

  const chess = new Chess(fen);
  return uciMoves.map(uci => {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) {
      throw new Error(`Invalid UCI puzzle move: ${uci}`);
    }
    const move = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
    if (uci.length === 5) move.promotion = uci[4];
    const result = chess.move(move);
    if (!result) throw new Error(`Illegal UCI puzzle move: ${uci}`);
    return result.san;
  });
}

/**
 * Parses the public lichess puzzle database CSV format.
 * Lichess stores coordinate moves. `movesUci` preserves that source data,
 * while `moves` contains SAN translated from the puzzle FEN for display.
 * @param {string} text
 * @returns {Array<{id:string, fen:string, moves:string[], movesUci:string[], rating:number|null, themes:string[]}>}
 */
function parseLichessCsv(text) {
  if (typeof text !== 'string' || text.length === 0) return [];

  const rows = parseCsvRows(text);
  if (rows.length > 0) rows[0][0] = rows[0][0].replace(/^\uFEFF/, '');
  if (rows.length > 0 && rows[0][0].trim() === 'PuzzleId') rows.shift();

  return rows
    .filter(row => row.some(field => field.trim() !== ''))
    .map(row => {
      const parsedRating = Number(row[3]);
      const fen = (row[1] || '').trim();
      const movesUci = (row[2] || '').trim().split(/\s+/).filter(Boolean);
      return {
        id: (row[0] || '').trim(),
        fen,
        moves: uciToSan(fen, movesUci),
        movesUci,
        rating: row[3] != null && row[3].trim() !== '' && Number.isFinite(parsedRating) ? parsedRating : null,
        themes: (row[7] || '').trim().split(/\s+/).filter(Boolean)
      };
    });
}

function replaceStore(importedPuzzles) {
  puzzles = importedPuzzles.slice();
  puzzlesById = new Map(puzzles.map(puzzle => [puzzle.id, puzzle]));
  return puzzles.slice();
}

function loadPuzzlesFromText(text) {
  return replaceStore(parseLichessCsv(text));
}

function loadPuzzlesFromFile(filePath) {
  if (!fs) throw new Error('File-system puzzle loading is only available in Node.js');
  return loadPuzzlesFromText(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Loads CSV text, a Node.js file path, or a browser File/Blob into the store.
 * Browser File/Blob inputs return a Promise; text and Node paths return an array.
 * @param {string|File|Blob} fileOrText
 * @returns {Array|Promise<Array>}
 */
function loadPuzzles(fileOrText) {
  if (typeof fileOrText === 'string') {
    if (fs && !/[\r\n]/.test(fileOrText) && fs.existsSync(fileOrText)) {
      return loadPuzzlesFromFile(fileOrText);
    }
    return loadPuzzlesFromText(fileOrText);
  }

  if (typeof FileReader !== 'undefined' && fileOrText && typeof fileOrText === 'object') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          resolve(loadPuzzlesFromText(String(reader.result || '')));
        } catch (error) {
          reject(error);
        }
      };
      reader.onerror = () => reject(reader.error || new Error('Unable to read puzzle file'));
      reader.readAsText(fileOrText);
    });
  }

  throw new TypeError('loadPuzzles expects CSV text, a Node.js file path, or a browser File');
}

/* ------------------------------------------------------------------ *
 * Persistent store (Wave 2 E4). When a game-archive.js instance (or any
 * object with the same puzzles surface) is attached via setStore(), the
 * getters below read from it; without one they fall back to the in-memory
 * array filled by loadPuzzles(), so the pure parser API keeps working in
 * the browser and in unit tests.
 * ------------------------------------------------------------------ */

let store = null;

function setStore(archive) {
  store = archive && typeof archive.listPuzzles === 'function' ? archive : null;
  return store;
}

function getStore() {
  return store;
}

function hasStore() {
  return !!store;
}

/** Normalises a store row or a parsed CSV row into the shape the routes serve. */
function normalizePuzzle(p) {
  if (!p) return null;
  const movesUci = Array.isArray(p.movesUci)
    ? p.movesUci
    : (typeof p.moves === 'string' ? p.moves.split(/\s+/).filter(Boolean) : (Array.isArray(p.moves) ? p.moves : []));
  const movesSan = Array.isArray(p.moves) && !Array.isArray(p.movesUci) ? p.moves
    : (typeof p.movesSan === 'string' ? p.movesSan.split(/\s+/).filter(Boolean) : (Array.isArray(p.moves) ? p.moves : []));
  const themes = Array.isArray(p.themes) ? p.themes : String(p.themes || '').split(/\s+/).filter(Boolean);
  return {
    id: String(p.id),
    fen: p.fen,
    movesUci,
    moves: movesSan,
    rating: Number.isFinite(Number(p.rating)) ? Number(p.rating) : null,
    ratingDeviation: Number.isFinite(Number(p.ratingDeviation)) ? Number(p.ratingDeviation) : 100,
    popularity: Number(p.popularity) || 0,
    nbPlays: Number(p.nbPlays) || 0,
    themes,
    gameUrl: p.gameUrl || '',
    openingTags: p.openingTags || ''
  };
}

/** Converts a parsed CSV puzzle into the flat record savePuzzles() stores. */
function toStoreRecord(p) {
  const n = normalizePuzzle(p);
  return {
    id: n.id,
    fen: n.fen,
    moves: n.movesUci.join(' '),
    movesSan: n.moves.join(' '),
    rating: n.rating == null ? 1500 : n.rating,
    ratingDeviation: n.ratingDeviation,
    popularity: n.popularity,
    nbPlays: n.nbPlays,
    themes: n.themes.join(' '),
    gameUrl: n.gameUrl,
    openingTags: n.openingTags
  };
}

/**
 * Imports lichess CSV text (or a Node file path) into the attached store.
 * Rows that fail SAN conversion are skipped and counted, never fatal.
 * @returns {{imported:number, skipped:number}}
 */
function importCsvIntoStore(fileOrText, options = {}) {
  if (!store) throw new Error('puzzle-service.js: importCsvIntoStore needs setStore() first');
  let text = fileOrText;
  if (fs && typeof text === 'string' && !/[\r\n]/.test(text) && fs.existsSync(text)) {
    text = fs.readFileSync(text, 'utf8');
  }
  const rows = parseCsvRows(String(text || ''));
  if (rows.length > 0) rows[0][0] = rows[0][0].replace(/^\uFEFF/, '');
  if (rows.length > 0 && rows[0][0].trim() === 'PuzzleId') rows.shift();
  const limit = Number.isFinite(options.limit) ? options.limit : Infinity;
  let imported = 0;
  let skipped = 0;
  let batch = [];
  for (const row of rows) {
    if (imported >= limit) break;
    if (!row.some(field => field.trim() !== '')) continue;
    try {
      const fen = (row[1] || '').trim();
      const movesUci = (row[2] || '').trim().split(/\s+/).filter(Boolean);
      if (movesUci.length < 2) throw new Error('needs opponent move + solution');
      batch.push(toStoreRecord({
        id: (row[0] || '').trim(),
        fen,
        movesUci,
        moves: uciToSan(fen, movesUci),
        rating: Number(row[3]),
        ratingDeviation: Number(row[4]),
        popularity: Number(row[5]),
        nbPlays: Number(row[6]),
        themes: (row[7] || '').trim(),
        gameUrl: (row[8] || '').trim(),
        openingTags: (row[9] || '').trim()
      }));
      imported++;
    } catch (_) {
      skipped++;
    }
    if (batch.length >= 500) { store.savePuzzles(batch); batch = []; }
  }
  if (batch.length) store.savePuzzles(batch);
  return { imported, skipped };
}

function getRandomPuzzle() {
  if (store) {
    const [p] = store.listPuzzles({ random: true, limit: 1 });
    return normalizePuzzle(p);
  }
  if (puzzles.length === 0) return null;
  return puzzles[Math.floor(Math.random() * puzzles.length)];
}

function getPuzzle(id) {
  if (store) return normalizePuzzle(store.getPuzzle(String(id)));
  return puzzlesById.get(String(id)) || null;
}

function puzzleCount() {
  if (store) return store.countPuzzles();
  return puzzles.length;
}

/**
 * Filtered listing. options: { theme, minRating, maxRating, limit, offset, random, excludeIds }
 */
function listPuzzles(options = {}) {
  if (store) return store.listPuzzles(options).map(normalizePuzzle);
  const exclude = new Set((options.excludeIds || []).map(String));
  let items = puzzles.filter(p => {
    if (options.theme && !p.themes.includes(options.theme)) return false;
    if (Number.isFinite(options.minRating) && !(p.rating >= options.minRating)) return false;
    if (Number.isFinite(options.maxRating) && !(p.rating <= options.maxRating)) return false;
    return !exclude.has(p.id);
  });
  if (options.random) items = items.slice().sort(() => Math.random() - 0.5);
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 50;
  const offset = Number.isFinite(options.offset) && options.offset >= 0 ? options.offset : 0;
  return items.slice(offset, offset + limit);
}

function listPuzzleIds() {
  if (store) return store.listPuzzleIds();
  return puzzles.map(p => p.id).sort();
}

function listThemes() {
  if (store) return store.listPuzzleThemes();
  const counts = new Map();
  for (const p of puzzles) for (const t of p.themes) counts.set(t, (counts.get(t) || 0) + 1);
  return Array.from(counts.entries()).map(([theme, count]) => ({ theme, count })).sort((a, b) => b.count - a.count || a.theme.localeCompare(b.theme));
}

/**
 * Picks the puzzle closest to `rating` within ±band (widening if needed),
 * preferring a random candidate among the closest few so repeats are rare.
 */
function pickNearRating(rating, options = {}) {
  const target = Number.isFinite(Number(rating)) ? Number(rating) : 1500;
  const excludeIds = options.excludeIds || [];
  for (const band of [100, 200, 400, 800, Infinity]) {
    const candidates = listPuzzles({
      theme: options.theme,
      minRating: band === Infinity ? undefined : target - band,
      maxRating: band === Infinity ? undefined : target + band,
      excludeIds,
      random: true,
      limit: 20
    });
    if (candidates.length > 0) {
      const sorted = candidates.slice().sort((a, b) => Math.abs(a.rating - target) - Math.abs(b.rating - target));
      const top = sorted.slice(0, Math.min(5, sorted.length));
      return top[Math.floor(Math.random() * top.length)];
    }
  }
  return null;
}

const PuzzleService = {
  parseLichessCsv,
  uciToSan,
  loadPuzzles,
  loadPuzzlesFromFile,
  getRandomPuzzle,
  getPuzzle,
  puzzleCount,
  // store-backed surface (Wave 2)
  setStore,
  getStore,
  hasStore,
  normalizePuzzle,
  toStoreRecord,
  importCsvIntoStore,
  listPuzzles,
  listPuzzleIds,
  listThemes,
  pickNearRating
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PuzzleService;
}
if (typeof window !== 'undefined') {
  window.PuzzleService = PuzzleService;
}
