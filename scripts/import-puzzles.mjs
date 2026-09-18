#!/usr/bin/env node
// scripts/import-puzzles.mjs — lichess puzzle CSV tooling (Wave 2, roadmap E4).
//
// Two modes, both streaming (line by line — the full lichess dump is ~5M rows):
//
//   1. IMPORT a lichess-format CSV into the SQLite `puzzles` table
//        node scripts/import-puzzles.mjs data/puzzles-sample.csv
//        node scripts/import-puzzles.mjs lichess_db_puzzle.csv --db games.db --limit 200000
//        zstd -dc lichess_db_puzzle.csv.zst | node scripts/import-puzzles.mjs -
//      Rows whose UCI line does not replay legally in chess.js are skipped and
//      counted (never abort a multi-million-row import for one bad row).
//
//   2. SAMPLE a stratified subset (what produced data/puzzles-sample.csv):
//        curl -sL https://database.lichess.org/lichess_db_puzzle.csv.zst \
//          | zstd -dc | node scripts/import-puzzles.mjs - --sample-out data/puzzles-sample.csv --max 9000
//      Reservoir-samples per (rating band × main theme) cell so the subset is
//      balanced across 600–2400 and the main tactical themes, keeps the lichess
//      header and 10-column layout verbatim, and validates every kept row.
//
// Input columns (lichess): PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,
// NbPlays,Themes,GameUrl,OpeningTags[,DailyDate]. Extra trailing columns are ignored;
// MovesSan is computed at import time.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { Chess } = require(path.join(ROOT, 'node_modules', 'chess.js'));

const LICHESS_HEADER = 'PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags';
const MAIN_THEMES = ['mate', 'mateIn1', 'mateIn2', 'fork', 'pin', 'skewer', 'discoveredAttack',
  'hangingPiece', 'endgame', 'opening', 'middlegame', 'advantage', 'crushing'];
const BAND_MIN = 600;
const BAND_MAX = 2400;
const BAND_SIZE = 200;

function parseArgs(argv) {
  const args = { input: null, db: null, sampleOut: null, max: 9000, limit: Infinity, minPopularity: 50, minPlays: 100, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') args.db = argv[++i];
    else if (a === '--sample-out') args.sampleOut = argv[++i];
    else if (a === '--max') args.max = Number(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--min-popularity') args.minPopularity = Number(argv[++i]);
    else if (a === '--min-plays') args.minPlays = Number(argv[++i]);
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (!args.input) args.input = a;
  }
  if (!args.input) { printHelp(); process.exit(2); }
  return args;
}

function printHelp() {
  process.stderr.write(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).map(l => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
}

/** Minimal RFC-4180 line splitter (lichess rows never contain quoted newlines). */
export function splitCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field.length === 0) {
      quoted = true;
    } else if (ch === ',') {
      out.push(field); field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/** Converts one lichess row (array of 10 fields) into a puzzle record, or throws. */
export function rowToPuzzle(fields) {
  const [id, fen, movesText, rating, rd, popularity, nbPlays, themes, gameUrl, openingTags] = fields;
  if (!id || !fen || !movesText) throw new Error('missing id/fen/moves');
  const moves = movesText.trim().split(/\s+/).filter(Boolean);
  const chess = new Chess(fen);
  const movesSan = moves.map(uci => {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw new Error(`bad uci ${uci}`);
    const mv = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
    if (uci.length === 5) mv.promotion = uci[4];
    const res = chess.move(mv);
    if (!res) throw new Error(`illegal uci ${uci}`);
    return res.san;
  });
  if (moves.length < 2) throw new Error('puzzle needs an opponent move plus a solution move');
  return {
    id: id.trim(),
    fen: fen.trim(),
    moves: moves.join(' '),
    movesSan: movesSan.join(' '),
    rating: Number(rating) || 1500,
    ratingDeviation: Number(rd) || 100,
    popularity: Number(popularity) || 0,
    nbPlays: Number(nbPlays) || 0,
    themes: (themes || '').trim(),
    gameUrl: (gameUrl || '').trim(),
    openingTags: (openingTags || '').trim()
  };
}

function openInput(input) {
  return input === '-' ? process.stdin : fs.createReadStream(input, { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// Mode 2: stratified reservoir sample
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let v = s;
    v = Math.imul(v ^ (v >>> 15), v | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}

async function sample(args) {
  const rng = mulberry32(20260918);
  const bands = [];
  for (let lo = BAND_MIN; lo < BAND_MAX; lo += BAND_SIZE) bands.push(lo);
  const cells = new Map(); // key -> { seen, kept: [] }
  const perCell = Math.max(1, Math.floor(args.max / (bands.length * MAIN_THEMES.length)));
  const rl = readline.createInterface({ input: openInput(args.input), crlfDelay: Infinity });
  let header = null;
  let total = 0;
  for await (const line of rl) {
    if (!line) continue;
    if (!header) { header = line.replace(/^\uFEFF/, ''); continue; }
    total++;
    const f = splitCsvLine(line);
    if (f.length < 8) continue;
    const rating = Number(f[3]);
    if (!(rating >= BAND_MIN && rating < BAND_MAX)) continue;
    if (Number(f[5]) < args.minPopularity || Number(f[6]) < args.minPlays) continue;
    const themes = f[7].split(/\s+/);
    const matching = MAIN_THEMES.filter(t => themes.includes(t));
    if (matching.length === 0) continue;
    // Assign the row to the currently emptiest matching theme cell so rarer
    // themes (skewer, discoveredAttack) fill up instead of being drowned out.
    const band = Math.floor((rating - BAND_MIN) / BAND_SIZE) * BAND_SIZE + BAND_MIN;
    let key = null;
    let bestSeen = Infinity;
    for (const t of matching) {
      const k = `${band}|${t}`;
      const c = cells.get(k);
      const seen = c ? c.seen : 0;
      if (seen < bestSeen) { bestSeen = seen; key = k; }
    }
    let cell = cells.get(key);
    if (!cell) { cell = { seen: 0, kept: [] }; cells.set(key, cell); }
    cell.seen++;
    if (cell.kept.length < perCell) cell.kept.push(line);
    else {
      const j = Math.floor(rng() * cell.seen);
      if (j < perCell) cell.kept[j] = line;
    }
    if (total % 500000 === 0 && !args.quiet) process.stderr.write(`  scanned ${total} rows\n`);
  }
  const seenIds = new Set();
  const out = [];
  let invalid = 0;
  for (const cell of cells.values()) {
    for (const line of cell.kept) {
      const f = splitCsvLine(line);
      if (seenIds.has(f[0])) continue;
      try { rowToPuzzle(f); } catch (_) { invalid++; continue; }
      seenIds.add(f[0]);
      out.push(line);
    }
  }
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  fs.mkdirSync(path.dirname(args.sampleOut), { recursive: true });
  fs.writeFileSync(args.sampleOut, (header || LICHESS_HEADER) + '\n' + out.join('\n') + '\n', 'utf8');
  const bytes = fs.statSync(args.sampleOut).size;
  process.stderr.write(`sampled ${out.length} of ${total} rows into ${args.sampleOut} (${(bytes / 1024).toFixed(0)} KiB, ${cells.size} cells, ${invalid} invalid dropped)\n`);
}

// ---------------------------------------------------------------------------
// Mode 1: import into SQLite through game-archive.js
// ---------------------------------------------------------------------------
async function importCsv(args) {
  if (args.db) process.env.CHESS_DB_FILE = args.db;
  const gameArchive = require(path.join(ROOT, 'src', 'game-archive.js'));
  const archive = gameArchive.getArchive();
  const rl = readline.createInterface({ input: openInput(args.input), crlfDelay: Infinity });
  let header = null;
  let imported = 0;
  let skipped = 0;
  let batch = [];
  const flush = () => { if (batch.length) { archive.savePuzzles(batch); batch = []; } };
  for await (const line of rl) {
    if (!line) continue;
    if (!header) { header = line; continue; }
    if (imported >= args.limit) break;
    try {
      batch.push(rowToPuzzle(splitCsvLine(line)));
      imported++;
    } catch (_) {
      skipped++;
    }
    if (batch.length >= 500) {
      flush();
      if (!args.quiet && imported % 50000 === 0) process.stderr.write(`  imported ${imported}\n`);
    }
  }
  flush();
  process.stderr.write(`imported ${imported} puzzles (${skipped} skipped) into ${archive.backendType} store; table now holds ${archive.countPuzzles()}\n`);
  archive.close();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  (args.sampleOut ? sample(args) : importCsv(args)).catch(err => {
    process.stderr.write(`import-puzzles: ${err && err.stack || err}\n`);
    process.exit(1);
  });
}
