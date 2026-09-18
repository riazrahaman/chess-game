#!/usr/bin/env node
'use strict';

/**
 * wave2-analysis-selftest.js — Wave 2 Worker D: real opening data (E3) +
 * Analysis view wiring (R5).
 *
 * State files go to os.tmpdir() (CHESS_STATE_FILE / CHESS_JOURNAL_FILE /
 * CHESS_DB_FILE) so nothing is written into the repo.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2d-analysis-'));
process.env.CHESS_STATE_FILE = path.join(tmpDir, 'referee-state.json');
process.env.CHESS_JOURNAL_FILE = path.join(tmpDir, 'referee-journal.jsonl');
process.env.CHESS_DB_FILE = path.join(tmpDir, 'games.db');
process.env.CHESS_JSON_ARCHIVE_FILE = path.join(tmpDir, 'games-archive.json');

const ROOT = path.join(__dirname, '..');
const Routes = require('../src/routes-openings.js');
const Explorer = require('../src/openings-explorer.js');
const MastersDb = require('../src/masters-db.js');
const OpeningsDb = require('../src/openings-db.js');
const GameArchive = require('../src/game-archive.js');
const { BotService, BOT_LEVELS } = require('../src/bot-service.js');

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// Minimal req/res doubles for handleOpeningsRoute.
function fakeReq(method, url, body) {
  return { method, url, headers: {}, _body: body };
}
function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: null, headersSent: false };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.end = (s) => { res.body = s ? JSON.parse(s) : null; res.headersSent = true; res._resolve && res._resolve(); };
  res.done = new Promise(r => { res._resolve = r; });
  return res;
}
const ctx = {
  sendJson: (res, status, payload) => { res.statusCode = status; res.end(JSON.stringify(payload)); },
  sendJsonError: (res, status, message) => { res.statusCode = status; res.end(JSON.stringify({ ok: false, error: message })); },
  readJsonBody: (req) => Promise.resolve(req._body)
};
async function call(method, url, body, extraCtx) {
  const req = fakeReq(method, url, body);
  const res = fakeRes();
  const handled = Routes.handleOpeningsRoute(req, res, url.split('?')[0], Object.assign({}, ctx, extraCtx || {}));
  if (!handled) return { handled: false };
  await res.done;
  return { handled: true, status: res.statusCode, body: res.body };
}

// ---------------------------------------------------------------- dataset
test('data/openings.tsv is vendored with a provenance README (lichess chess-openings, CC0)', () => {
  const tsv = fs.readFileSync(path.join(ROOT, 'data', 'openings.tsv'), 'utf8');
  const lines = tsv.split('\n').filter(Boolean);
  assert.strictEqual(lines[0], 'eco\tname\tpgn', 'header row');
  assert(lines.length > 3000 && lines.length < 6000, `expected ~3,800 rows, got ${lines.length}`);
  assert(Buffer.byteLength(tsv) < 1024 * 1024, '< 1 MB');
  const readme = fs.readFileSync(path.join(ROOT, 'data', 'README-openings.md'), 'utf8');
  assert(/lichess-org\/chess-openings/.test(readme) && /CC0/.test(readme), 'README cites source + licence');
  assert(Explorer.ensureDefaultLoaded(), 'explorer loads the default TSV');
  assert.strictEqual(Explorer.getTSVMap().size, lines.length - 1, 'every row converted SAN→UCI');
});

// ---------------------------------------------------------------- lookup route
test('GET /api/openings/lookup: e2e4,e7e5,g1f3,b8c6,f1b5 → C60 Ruy Lopez with continuations', async () => {
  const r = await call('GET', '/api/openings/lookup?moves=e2e4,e7e5,g1f3,b8c6,f1b5');
  assert(r.handled && r.status === 200);
  assert.strictEqual(r.body.eco, 'C60');
  assert.strictEqual(r.body.name, 'Ruy Lopez');
  assert.strictEqual(r.body.pgn, '1. e4 e5 2. Nf3 Nc6 3. Bb5');
  assert.strictEqual(r.body.isExact, true);
  assert.strictEqual(r.body.book, true);
  assert(r.body.continuations.some(c => c.uci === 'a7a6' && /Morphy/.test(c.name)), 'a6 Morphy Defense continuation');
  for (const c of r.body.continuations) {
    assert(typeof c.lines === 'number' && c.lines >= 1, 'lines = named TSV lines');
    assert(!('games' in c) && !('frequency' in c) && !('winRate' in c), 'no fabricated game/frequency fields');
  }
  assert(/chess-openings/.test(r.body.source));
});

test('GET /api/openings/lookup: longest-prefix match + off-book flag; start position; bad input → 400', async () => {
  const deep = await call('GET', '/api/openings/lookup?moves=e2e4,e7e5,g1f3,b8c6,f1b5,h7h5,h2h4');
  assert.strictEqual(deep.body.eco, 'C60');
  assert.strictEqual(deep.body.isExact, false);
  assert.strictEqual(deep.body.matchedPlies, 5);
  assert.strictEqual(deep.body.book, false, 'off any named line');
  assert.deepStrictEqual(deep.body.continuations, []);

  const start = await call('GET', '/api/openings/lookup?moves=');
  assert.strictEqual(start.status, 200);
  assert.strictEqual(start.body.book, true);
  assert(start.body.continuations.some(c => c.uci === 'e2e4') && start.body.continuations.some(c => c.uci === 'd2d4'));

  const bad = await call('GET', '/api/openings/lookup?moves=e2e4,zz');
  assert.strictEqual(bad.status, 400);
  const unhandled = await call('GET', '/api/openings/nope');
  assert.strictEqual(unhandled.handled, false, 'unknown paths fall through to the server 404');
});

// ---------------------------------------------------------------- personal route
test('GET /api/openings/personal: W/D/L from a seeded archive (own games only, no fabrication)', async () => {
  const archive = GameArchive.createGameArchive({ forceJson: true, jsonPath: path.join(tmpDir, 'personal.json') });
  archive.saveGame({ id: 'p1', white: 'Me', black: 'A', result: '1-0', moves: 'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6', date: '2026.01.01' });
  archive.saveGame({ id: 'p2', white: 'Me', black: 'B', result: '0-1', moves: 'e2e4 e7e5 g1f3 b8c6 f1b5 g8f6', date: '2026.01.02' });
  archive.saveGame({ id: 'p3', white: 'Me', black: 'C', result: '1/2-1/2', moves: 'e2e4 e7e5 g1f3 b8c6 f1c4', date: '2026.01.03' });
  archive.saveGame({ id: 'p4', white: 'Me', black: 'D', result: '1-0', moves: 'd2d4 d7d5', date: '2026.01.04' });

  const ruy = await call('GET', '/api/openings/personal?moves=e2e4,e7e5,g1f3,b8c6,f1b5', null, { archive });
  assert.strictEqual(ruy.status, 200);
  assert.strictEqual(ruy.body.label, 'your games');
  assert.strictEqual(ruy.body.count, 2);
  assert.strictEqual(ruy.body.wins, 1);
  assert.strictEqual(ruy.body.losses, 1);
  assert.strictEqual(ruy.body.draws, 0);
  assert.deepStrictEqual(ruy.body.games.map(g => g.id).sort(), ['p1', 'p2']);

  const e4 = await call('GET', '/api/openings/personal?moves=e2e4', null, { archive });
  assert.strictEqual(e4.body.count, 3);
  assert.strictEqual(e4.body.draws, 1);

  const none = await call('GET', '/api/openings/personal?moves=c2c4', null, { archive });
  assert.strictEqual(none.body.count, 0);
  assert.strictEqual(none.body.winRate, 0, 'zero games → zero rates, nothing invented');
  archive.close();
});

// ---------------------------------------------------------------- fen validate
test('POST /api/fen/validate accepts a legal FEN and rejects garbage / kingless boards', async () => {
  const good = await call('POST', '/api/fen/validate', { fen: '4k3/8/8/8/8/8/8/4K2R w K - 0 1' });
  assert.strictEqual(good.status, 200);
  assert.strictEqual(good.body.valid, true);
  assert.strictEqual(good.body.turn, 'white');
  assert.strictEqual(good.body.pieces, 3);
  assert.strictEqual(good.body.fen, '4k3/8/8/8/8/8/8/4K2R w K - 0 1');

  const bad = await call('POST', '/api/fen/validate', { fen: 'not a fen' });
  assert.strictEqual(bad.status, 200, "invalid FEN is answered with valid:false, not an HTTP error");
  assert.strictEqual(bad.body.valid, false);
  assert(bad.body.error);

  const noKing = await call('POST', '/api/fen/validate', { fen: '8/8/8/8/8/8/8/8 w - - 0 1' });
  assert.strictEqual(noKing.body.valid, false);

  const empty = await call('POST', '/api/fen/validate', {});
  assert.strictEqual(empty.body.valid, false);
  const notJson = await call('POST', '/api/fen/validate', null);
  assert.strictEqual(notJson.status, 400);
});

// ---------------------------------------------------------------- fabricated numbers gone
test('openings-db.js contains no fabricated statistics (no frequency:/stats: tokens; findOpening returns eco/name only)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'src', 'openings-db.js'), 'utf8');
  assert(!/frequency:/.test(code), 'no frequency: in openings-db.js');
  assert(!/stats:/.test(code), 'no stats: in openings-db.js');
  assert(!/popularMoves/.test(code), 'no popularMoves in openings-db.js');
  const o = OpeningsDb.findOpening(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5']);
  assert.strictEqual(o.eco, 'C60');
  assert.deepStrictEqual(Object.keys(o).sort(), ['eco', 'isExact', 'matchedPlies', 'name']);
  const masters = fs.readFileSync(path.join(ROOT, 'src', 'masters-db.js'), 'utf8');
  assert(!/games:\s*\d/.test(masters), 'no numeric game counts in masters-db.js');
  assert(!/real-data subset/.test(masters), 'the "real-data subset" claim is gone');
});

// ---------------------------------------------------------------- bot book
test('bot book (L1–L4) picks only moves the TSV names as continuations; L5+ skip the book', async () => {
  const bot = new BotService({ validateMutation: () => ({ ok: true }) });
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const startConts = new Set(Explorer.continuations([]).map(c => c.uci));
  for (let i = 0; i < 12; i++) {
    const mv = await bot.computeBotMove(startFen, 1, []);
    assert(startConts.has(mv), `L1 first move ${mv} must be a TSV continuation`);
  }
  const afterRuy = 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
  const hist = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'];
  const ruyConts = new Set(Explorer.continuations(hist).map(c => c.uci));
  for (let i = 0; i < 12; i++) {
    const mv = await bot.computeBotMove(afterRuy, 4, hist);
    assert(ruyConts.has(mv), `L4 reply ${mv} must be a TSV continuation of the Ruy Lopez`);
  }
  // pickBookMove is a uniform pick over lines: with a legality filter that
  // rejects everything it must return null (never invents a move).
  assert.strictEqual(BotService.pickBookMove([], () => false), null);
  for (const lvl of [5, 6, 7, 8]) assert.strictEqual(BOT_LEVELS[lvl].useBook, false);
});

// ---------------------------------------------------------------- masters whitelist
test('masters whitelist reclassifies a book-line move and leaves a random move flagged', () => {
  const review = {
    whiteAccuracy: 80, blackAccuracy: 60, counts: {},
    moves: [
      { key: 'best', move: 'e2e4', color: 'white', ply: 1 },
      { key: 'best', move: 'e7e5', color: 'black', ply: 2 },
      { key: 'best', move: 'g1f3', color: 'white', ply: 3 },
      { key: 'best', move: 'b8c6', color: 'black', ply: 4 },
      { key: 'mistake', move: 'f1b5', color: 'white', ply: 5, label: 'Mistake', accuracy: 40 },
      { key: 'blunder', move: 'h7h5', color: 'black', ply: 6, label: 'Blunder', accuracy: 5 }
    ]
  };
  const out = MastersDb.whitelistMistakes(review, ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'h7h5']);
  assert.strictEqual(out.moves[4].key, 'best', '3. Bb5 (Ruy Lopez) is book → Best');
  assert.strictEqual(out.moves[4].bookTheory, true);
  assert.strictEqual(out.moves[5].key, 'blunder', '3...h5 is not a named line → stays a blunder');
  assert.strictEqual(MastersDb.isBookPosition(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5']).games, null, 'no counts');
  assert.strictEqual(MastersDb.MIN_MASTER_GAMES, undefined);
});

// ---------------------------------------------------------------- view wiring
test('ui-analysis.js is wired (ALLOWED_FILES, PRECACHE, <script> before ui.js), registers the analysis view, and is Gate-4 clean', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'service-worker.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const ui = fs.readFileSync(path.join(ROOT, 'src', 'ui-analysis.js'), 'utf8');
  assert(/'src\/ui-analysis\.js'/.test(server), 'ALLOWED_FILES');
  assert(/'\/src\/ui-analysis\.js'/.test(sw), 'PRECACHE_ASSETS');
  const a = html.indexOf('src="src/ui-analysis.js"');
  const u = html.indexOf('src="src/ui.js"');
  assert(a > 0 && u > a, 'script tag present and before ui.js');
  assert(/require\('\.\/src\/routes-openings\.js'\)\.handleOpeningsRoute\(/.test(server), 'server.js hook line');
  assert(/id: 'analysis'/.test(ui) && /registerView\(/.test(ui), 'registers the analysis view');
  assert(/new Worker\('\/src\/stockfish-worker\.js'\)/.test(ui), 'owns a second analysis worker');
  for (const banned of ['makeMove', 'createInitialBoard', 'historyToSan']) {
    assert(!new RegExp('\\b' + banned + '\\b').test(ui), `Gate 4: ui-analysis.js must not reference ${banned}`);
  }
  assert(!/\/api\/move|\/api\/resign|\/api\/undo|\/api\/draw/.test(ui), 'display only: no referee command endpoints');
  for (const g of ['Tablebase', 'Acpl', 'MastersDb', 'PovExport', 'EmbedViewer']) {
    assert(new RegExp('window\\.' + g + '\\b').test(ui), `uses window.${g}`);
  }
  const reach = fs.readFileSync(path.join(ROOT, 'test', 'reachability-selftest.js'), 'utf8');
  for (const m of ['openings-explorer.js', 'masters-db.js', 'acpl.js', 'tablebase.js', 'pov-export.js', 'embed-viewer.js']) {
    assert(!new RegExp("'" + m.replace('.', '\\.') + "':").test(reach), `${m} removed from KNOWN_DARK`);
  }
});

(async () => {
  console.log('=== Wave 2 Worker D: real openings + Analysis view self-test ===\n');
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log('PASS: ' + t.name);
    } catch (err) {
      failed++;
      console.error('FAIL: ' + t.name + '\n  ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n  ') : err));
    }
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  console.log(`\nPassed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
  console.log('All wave2-analysis self-tests passed successfully!');
  process.exit(0);
})();
