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

function getRandomPuzzle() {
  if (puzzles.length === 0) return null;
  return puzzles[Math.floor(Math.random() * puzzles.length)];
}

function getPuzzle(id) {
  return puzzlesById.get(String(id)) || null;
}

function puzzleCount() {
  return puzzles.length;
}

const PuzzleService = {
  parseLichessCsv,
  uciToSan,
  loadPuzzles,
  loadPuzzlesFromFile,
  getRandomPuzzle,
  getPuzzle,
  puzzleCount
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PuzzleService;
}
if (typeof window !== 'undefined') {
  window.PuzzleService = PuzzleService;
}
