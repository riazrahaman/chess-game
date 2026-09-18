#!/usr/bin/env node
'use strict';

/**
 * wave2-puzzles-selftest.js — Wave 2 Worker B: real puzzle product.
 *
 *  - data/puzzles-sample.csv loads with >= 1,000 rows across >= 8 themes and
 *    imports into the SQLite puzzles table via puzzle-service + game-archive
 *  - /api/puzzle/* routes via createServer(): themes, daily (stable per day),
 *    next (theme filter), batch, GET :id (solution hidden), try (correct, wrong,
 *    illegal, alternate mate), solve (rating moves up on win / down on loss,
 *    forged wins rejected), review scheduling + queue, dashboard, storm
 *    determinism + result flow, anonymous cookie identity.
 *
 * All state files go to os.tmpdir() via CHESS_DB_FILE / CHESS_STATE_FILE.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wave2-puzzles-'));
process.env.CHESS_DB_FILE = path.join(TMP, 'games.db');
process.env.CHESS_JSON_ARCHIVE_FILE = path.join(TMP, 'archive.json');
process.env.CHESS_STATE_FILE = path.join(TMP, 'referee-state.json');
process.env.CHESS_JOURNAL_FILE = path.join(TMP, 'referee-journal.jsonl');

const ROOT = path.join(__dirname, '..');
const serverModule = require('../server.js');
const gameArchive = require('../src/game-archive.js');
const PuzzleService = require('../src/puzzle-service.js');
const routes = require('../src/routes-puzzles.js');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL: ${name} — ${err && err.stack ? err.stack : err}`);
  }
}

function request(server, options, bodyData) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const req = http.request({
      host: '127.0.0.1', port, path: options.path, method: options.method || 'GET',
      headers: Object.assign({ 'Content-Type': 'application/json' }, options.headers || {})
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
      });
    });
    req.on('error', reject);
    if (bodyData) req.write(typeof bodyData === 'string' ? bodyData : JSON.stringify(bodyData));
    req.end();
  });
}

/** Per-player HTTP client that carries the puzzle_player cookie. */
function client(server) {
  let cookie = '';
  return async (method, p, body) => {
    const res = await request(server, { method, path: p, headers: cookie ? { Cookie: cookie } : {} }, body);
    const set = res.headers['set-cookie'];
    if (set && set.length) cookie = set[0].split(';')[0];
    res.cookie = cookie;
    return res;
  };
}

function solutionOf(id) {
  const full = gameArchive.getPuzzle(id);
  return full.moves.split(' ');
}

async function run() {
  console.log('=== Wave 2 Puzzles Self-Test (data + routes + rating + review + storm) ===\n');
  const csvPath = path.join(ROOT, 'data', 'puzzles-sample.csv');

  await test('data/puzzles-sample.csv exists, <= 2 MB, lichess header, >= 1,000 rows across >= 8 themes', async () => {
    assert(fs.existsSync(csvPath), 'missing data/puzzles-sample.csv');
    const stat = fs.statSync(csvPath);
    assert(stat.size <= 2 * 1024 * 1024, `sample is ${stat.size} bytes (> 2 MB)`);
    const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
    assert(lines[0].startsWith('PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags'), 'header is not the lichess layout');
    assert(lines.length - 1 >= 1000, `only ${lines.length - 1} rows`);
    assert(lines.length - 1 <= 10000, `too many rows: ${lines.length - 1}`);
    const themes = new Set();
    const ratings = [];
    for (const line of lines.slice(1)) {
      const f = line.split(',');
      ratings.push(Number(f[3]));
      for (const t of f[7].split(' ')) themes.add(t);
    }
    assert(themes.size >= 8, `only ${themes.size} themes`);
    for (const must of ['mate', 'mateIn1', 'mateIn2', 'fork', 'pin', 'skewer', 'discoveredAttack', 'hangingPiece', 'endgame', 'opening', 'middlegame', 'advantage', 'crushing']) {
      assert(themes.has(must), `theme ${must} missing from sample`);
    }
    assert(Math.min(...ratings) < 1000 && Math.max(...ratings) > 2000, 'rating spread too narrow');
    assert(fs.existsSync(path.join(ROOT, 'data', 'README.md')), 'data/README.md missing');
    assert(fs.existsSync(path.join(ROOT, 'scripts', 'import-puzzles.mjs')), 'scripts/import-puzzles.mjs missing');
  });

  await test('puzzle-service imports the sample into the SQLite puzzles table (store-backed API)', async () => {
    const archive = gameArchive.getArchive();
    assert.strictEqual(archive.backendType, 'sqlite', 'expected node:sqlite backend');
    PuzzleService.setStore(gameArchive);
    assert.strictEqual(PuzzleService.puzzleCount(), 0);
    const { imported, skipped } = PuzzleService.importCsvIntoStore(csvPath);
    assert(imported >= 1000, `imported ${imported}`);
    assert.strictEqual(skipped, 0, `${skipped} rows skipped`);
    assert.strictEqual(PuzzleService.puzzleCount(), imported);
    const forks = PuzzleService.listPuzzles({ theme: 'fork', limit: 5 });
    assert.strictEqual(forks.length, 5);
    assert(forks.every(p => p.themes.includes('fork')));
    assert(Array.isArray(forks[0].movesUci) && Array.isArray(forks[0].moves), 'normalized puzzle has movesUci + SAN moves');
    const near = PuzzleService.pickNearRating(900, { theme: 'mateIn1' });
    assert(near && Math.abs(near.rating - 900) <= 100, `pickNearRating drifted: ${near && near.rating}`);
    assert(PuzzleService.listThemes().length >= 8);
    PuzzleService.setStore(null);
    routes.resetForTests();
  });

  const server = serverModule.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  try {
    await test('GET /api/puzzle/themes lists themes with counts (table already seeded, no re-import)', async () => {
      const res = await request(server, { path: '/api/puzzle/themes' });
      assert.strictEqual(res.status, 200);
      assert(res.body.ok && res.body.total >= 1000, `total ${res.body.total}`);
      assert(res.body.themes.length >= 9);
      assert.strictEqual(res.body.themes[0].key, 'mix');
      assert(res.body.themes.some(t => t.key === 'fork' && t.count > 0));
    });

    await test('anonymous player gets a puzzle_player cookie; GET /:id hides the solution', async () => {
      const call = client(server);
      const res = await call('GET', '/api/puzzle/daily');
      assert.strictEqual(res.status, 200);
      assert(/puzzle_player=/.test(res.cookie), 'no puzzle_player cookie set');
      const p = res.body.puzzle;
      assert(p && p.id && p.fen && p.initialFen && p.opponentMove && p.solverColor, 'puzzle view incomplete');
      assert.strictEqual(p.moves, undefined);
      assert.strictEqual(p.movesUci, undefined);
      assert.strictEqual(p.solution, undefined);
      const one = await call('GET', `/api/puzzle/${p.id}`);
      assert.strictEqual(one.body.puzzle.id, p.id);
      assert.strictEqual(one.body.puzzle.moves, undefined);
      assert.strictEqual(one.body.player.rating, 1500);
    });

    await test('GET /api/puzzle/daily is stable across calls and players', async () => {
      const a = await request(server, { path: '/api/puzzle/daily' });
      const b = await request(server, { path: '/api/puzzle/daily' });
      assert.strictEqual(a.body.puzzle.id, b.body.puzzle.id);
      assert.strictEqual(a.body.date, new Date().toISOString().slice(0, 10));
    });

    await test('GET /api/puzzle/next?theme=fork returns a fork near the requested rating; unknown theme 404s', async () => {
      const res = await request(server, { path: '/api/puzzle/next?theme=fork&rating=1200' });
      assert.strictEqual(res.status, 200);
      assert(res.body.puzzle.themes.includes('fork'));
      assert(Math.abs(res.body.puzzle.rating - 1200) <= 400, `rating ${res.body.puzzle.rating}`);
      assert.strictEqual(res.body.theme, 'fork');
      const none = await request(server, { path: '/api/puzzle/next?theme=noSuchThemeXyz' });
      assert.strictEqual(none.status, 404);
    });

    await test('GET /api/puzzle/batch/:theme?nb= caps at 50 and filters by theme', async () => {
      const res = await request(server, { path: '/api/puzzle/batch/mateIn1?nb=7' });
      assert.strictEqual(res.body.puzzles.length, 7);
      assert(res.body.puzzles.every(p => p.themes.includes('mateIn1')));
      const big = await request(server, { path: '/api/puzzle/batch/mix?nb=500' });
      assert.strictEqual(big.body.puzzles.length, 50);
    });

    await test('POST /try: correct solution line step by step, opponent replies, complete at the end', async () => {
      const call = client(server);
      const next = await call('GET', '/api/puzzle/next?theme=mateIn2&rating=1000');
      const p = next.body.puzzle;
      const sol = solutionOf(p.id);
      let moves = [];
      let last = null;
      for (let i = 1; i < sol.length; i += 2) {
        last = await call('POST', `/api/puzzle/${p.id}/try`, { move: sol[i], moves });
        assert.strictEqual(last.status, 200);
        assert.strictEqual(last.body.correct, true, `move ${sol[i]} rejected: ${JSON.stringify(last.body)}`);
        moves = last.body.moves;
        if (i + 1 < sol.length) {
          assert.strictEqual(last.body.complete, false);
          assert.strictEqual(last.body.reply.uci, sol[i + 1]);
        }
      }
      assert.strictEqual(last.body.complete, true);
      assert.deepStrictEqual(last.body.solution.uci, sol);
      assert.strictEqual(moves.length, Math.ceil((sol.length - 1) / 2));
    });

    await test('POST /try: wrong move is legal:true/correct:false with pre-move FEN; illegal move is legal:false; forged prefix 400s', async () => {
      const call = client(server);
      const next = await call('GET', '/api/puzzle/next?theme=fork&rating=1500');
      const p = next.body.puzzle;
      const sol = solutionOf(p.id);
      const { Chess } = require('chess.js');
      const chess = new Chess(p.fen);
      const legal = chess.moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''));
      const wrong = legal.find(u => u !== sol[1] && !(() => { const c = new Chess(p.fen); c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); return c.isCheckmate(); })());
      assert(wrong, 'no non-solution non-mating legal move found');
      const res = await call('POST', `/api/puzzle/${p.id}/try`, { move: wrong, moves: [] });
      assert.strictEqual(res.body.legal, true);
      assert.strictEqual(res.body.correct, false);
      assert.strictEqual(res.body.fen, p.fen, 'wrong move must not advance the position');
      const illegal = await call('POST', `/api/puzzle/${p.id}/try`, { move: 'a1a1', moves: [] });
      assert.strictEqual(illegal.body.legal, false);
      const forged = await call('POST', `/api/puzzle/${p.id}/try`, { move: sol[1], moves: [wrong] });
      assert.strictEqual(forged.status, 400, 'a fake committed prefix must be rejected');
      const garbage = await call('POST', `/api/puzzle/${p.id}/try`, 'not json');
      assert.strictEqual(garbage.status, 400);
    });

    await test('POST /try: alternate checkmate is accepted (chess.js confirms mate) and completes the puzzle', async () => {
      // Synthetic fixture: Black king h8 boxed by its own g7/h7 pawns, White rooks
      // a1 + b1. After Black's ...c5 both Ra8# and Rb8# mate; the stored solution
      // records only one of them.
      const { Chess } = require('chess.js');
      const fen = '7k/6pp/2p5/8/8/8/8/RR4K1 b - - 0 1';
      const c = new Chess(fen);
      c.move({ from: 'c6', to: 'c5' });
      const mates = c.moves({ verbose: true }).filter(m => { const t = new Chess(c.fen()); t.move(m); return t.isCheckmate(); }).map(m => m.from + m.to);
      assert(mates.length >= 2, `need >= 2 mating moves, got ${mates}`);
      gameArchive.savePuzzles([{ id: 'wave2AltMate', fen, moves: `c6c5 ${mates[0]}`, movesSan: 'c5 Ra8#', rating: 800, ratingDeviation: 80, popularity: 100, nbPlays: 10, themes: 'mate mateIn1 oneMove', gameUrl: '', openingTags: '' }]);
      const call = client(server);
      const alt = await call('POST', '/api/puzzle/wave2AltMate/try', { move: mates[1], moves: [] });
      assert.strictEqual(alt.status, 200, alt.raw);
      assert.strictEqual(alt.body.correct, true, JSON.stringify(alt.body));
      assert.strictEqual(alt.body.complete, true);
      assert.strictEqual(alt.body.alternateMate, true);
      const solved = await call('POST', '/api/puzzle/wave2AltMate/solve', { moves: [mates[1]], timeMs: 3000, win: true });
      assert.strictEqual(solved.status, 200, solved.raw);
      assert.strictEqual(solved.body.win, true);
      assert(solved.body.rating.delta > 0);
    });

    await test('POST /solve: win raises the rating, loss lowers it and schedules a review; forged win rejected', async () => {
      const call = client(server);
      const first = await call('GET', '/api/puzzle/next?rating=1500');
      const p = first.body.puzzle;
      const sol = solutionOf(p.id);
      const moves = sol.filter((_, i) => i % 2 === 1);
      const forged = await call('POST', `/api/puzzle/${p.id}/solve`, { moves: [], timeMs: 100, win: true });
      assert.strictEqual(forged.status, 400, 'a win without the validated line must be rejected');
      const win = await call('POST', `/api/puzzle/${p.id}/solve`, { moves, timeMs: 8000, win: true });
      assert.strictEqual(win.status, 200, win.raw);
      assert.strictEqual(win.body.rating.before, 1500);
      assert(win.body.rating.after > 1500, `rating did not rise: ${JSON.stringify(win.body.rating)}`);
      assert.strictEqual(win.body.review, null);
      assert.deepStrictEqual(win.body.solution.uci, sol);
      const second = await call('GET', '/api/puzzle/next?rating=1500');
      assert.notStrictEqual(second.body.puzzle.id, p.id, 'recently attempted puzzle should not be served again');
      const loss = await call('POST', `/api/puzzle/${second.body.puzzle.id}/solve`, { moves: [], timeMs: 20000, win: false });
      assert.strictEqual(loss.status, 200);
      assert(loss.body.rating.after < loss.body.rating.before, 'loss must lower the rating');
      assert(loss.body.review && loss.body.review.intervalDays === 1 && loss.body.review.step === 0, 'loss must be scheduled for review');
      const me = await call('GET', `/api/puzzle/${p.id}`);
      assert.strictEqual(me.body.player.rating, loss.body.rating.after, 'rating persists per player');
      const other = client(server);
      const otherView = await other('GET', `/api/puzzle/${p.id}`);
      assert.strictEqual(otherView.body.player.rating, 1500, 'another anonymous player starts fresh');
    });

    await test('GET /api/puzzle/review lists the missed puzzle as upcoming; a correct review advances the interval', async () => {
      const call = client(server);
      const next = await call('GET', '/api/puzzle/next?theme=pin&rating=1200');
      const p = next.body.puzzle;
      await call('POST', `/api/puzzle/${p.id}/solve`, { moves: [], timeMs: 1000, win: false });
      const review = await call('GET', '/api/puzzle/review');
      assert.strictEqual(review.status, 200);
      assert.strictEqual(review.body.counts.due, 0);
      assert.strictEqual(review.body.counts.upcoming, 1);
      assert.strictEqual(review.body.upcoming[0].puzzle.id, p.id);
      assert.strictEqual(review.body.upcoming[0].puzzle.moves, undefined, 'review queue must not leak solutions');
      assert.deepStrictEqual(review.body.intervals, [1, 2, 4, 8, 16, 32]);
      const sol = solutionOf(p.id);
      const moves = sol.filter((_, i) => i % 2 === 1);
      const again = await call('POST', `/api/puzzle/${p.id}/solve`, { moves, timeMs: 5000, win: true, mode: 'review' });
      assert.strictEqual(again.status, 200, again.raw);
      assert.strictEqual(again.body.review.step, 1);
      assert.strictEqual(again.body.review.intervalDays, 2);
      assert.strictEqual(again.body.review.reviewCount, 2);
    });

    await test('GET /api/puzzle/dashboard/:days aggregates attempts per theme for this player only', async () => {
      const call = client(server);
      const a = await call('GET', '/api/puzzle/next?theme=fork&rating=1000');
      const solA = solutionOf(a.body.puzzle.id);
      await call('POST', `/api/puzzle/${a.body.puzzle.id}/solve`, { moves: solA.filter((_, i) => i % 2 === 1), timeMs: 3000, win: true });
      const b = await call('GET', '/api/puzzle/next?theme=fork&rating=1000');
      await call('POST', `/api/puzzle/${b.body.puzzle.id}/solve`, { moves: [], timeMs: 3000, win: false });
      const dash = await call('GET', '/api/puzzle/dashboard/30');
      assert.strictEqual(dash.status, 200);
      assert.strictEqual(dash.body.global.nb, 2);
      assert.strictEqual(dash.body.global.wins, 1);
      const fork = dash.body.themes.find(t => t.theme === 'fork');
      assert(fork && fork.nb === 2 && fork.wins === 1 && fork.winRate === 50, JSON.stringify(fork));
      assert.strictEqual(dash.body.player.authenticated, false);
      assert.strictEqual(dash.body.recent.length, 2);
      const fresh = await client(server)('GET', '/api/puzzle/dashboard/30');
      assert.strictEqual(fresh.body.global.nb, 0);
    });

    await test('Storm: same seed → same first puzzle and pool; results advance; wrong sessions rejected', async () => {
      const call = client(server);
      const s1 = await call('GET', '/api/puzzle/storm/start?seed=wave2-seed');
      const s2 = await call('GET', '/api/puzzle/storm/start?seed=wave2-seed');
      assert.strictEqual(s1.status, 200);
      assert.strictEqual(s1.body.storm.status, 'active');
      assert.strictEqual(s1.body.storm.puzzle.id, s2.body.storm.puzzle.id, 'seeded storm must be deterministic');
      assert.notStrictEqual(s1.body.storm.sessionId, s2.body.storm.sessionId);
      assert.strictEqual(s1.body.storm.durationSec, 180);
      const other = await client(server)('GET', '/api/puzzle/storm/start?seed=other-seed');
      assert.notStrictEqual(other.body.storm.puzzle.id, s1.body.storm.puzzle.id);

      const active = s1.body.storm.puzzle;
      const sol = solutionOf(active.id);
      const fakeWin = await call('POST', '/api/puzzle/storm/result', { sessionId: s1.body.storm.sessionId, result: 'solved', moves: [] });
      assert.strictEqual(fakeWin.status, 400, 'storm solve without validated line must be rejected');
      const solved = await call('POST', '/api/puzzle/storm/result', { sessionId: s1.body.storm.sessionId, puzzleId: active.id, result: 'solved', timeMs: 4000, moves: sol.filter((_, i) => i % 2 === 1) });
      assert.strictEqual(solved.status, 200, solved.raw);
      assert.strictEqual(solved.body.storm.solved, 1);
      assert.strictEqual(solved.body.storm.streak, 1);
      assert.deepStrictEqual(solved.body.solution.uci, sol);
      assert(solved.body.storm.puzzle && solved.body.storm.puzzle.id !== active.id, 'next storm puzzle must be served');
      const second = solved.body.storm.puzzle;
      // Deterministic continuation: replay the same result on the twin session
      const twin = await call('POST', '/api/puzzle/storm/result', { sessionId: s2.body.storm.sessionId, result: 'solved', timeMs: 4000, moves: sol.filter((_, i) => i % 2 === 1) });
      assert.strictEqual(twin.body.storm.puzzle.id, second.id, 'same seed + same results → same next puzzle');
      const failed = await call('POST', '/api/puzzle/storm/result', { sessionId: s1.body.storm.sessionId, result: 'failed', timeMs: 2000 });
      assert.strictEqual(failed.body.storm.failed, 1);
      assert.strictEqual(failed.body.storm.streak, 0);
      const stranger = await client(server)('POST', '/api/puzzle/storm/result', { sessionId: s1.body.storm.sessionId, result: 'failed' });
      assert.strictEqual(stranger.status, 403);
      const missing = await call('POST', '/api/puzzle/storm/result', { sessionId: 'nope', result: 'failed' });
      assert.strictEqual(missing.status, 404);
      const rating = await call('GET', `/api/puzzle/${active.id}`);
      assert.strictEqual(rating.body.player.rating, 1500, 'storm must stay unrated');
    });

    await test('unknown puzzle id and unknown sub-route 404 with JSON', async () => {
      const a = await request(server, { path: '/api/puzzle/doesNotExist' });
      assert.strictEqual(a.status, 404);
      assert.strictEqual(a.body.ok, false);
      const b = await request(server, { path: '/api/puzzle/storm/whatever' });
      assert.strictEqual(b.status, 404);
    });
  } finally {
    await new Promise(r => server.close(r));
    try { gameArchive.resetArchive(); } catch (_) {}
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log(`All ${passed} tests passed successfully!`);
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
