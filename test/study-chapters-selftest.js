#!/usr/bin/env node
'use strict';

/**
 * study-chapters-selftest.js — A2.2 Study chapters end-to-end through server.js.
 *
 * Covers the study store (SQLite + JSON fallback), POST /api/study for all
 * three chapter kinds (PGN with RAV + NAGs, FEN with a recorded line, archived
 * game by id), the hidden-move quiz loop (correct / wrong / illegal / alternate
 * mate), the solution never being in a quiz GET payload, reveal, DELETE
 * ownership, FEN validation rejection, and PGN export with $1–$9 NAG glyphs
 * that round-trips through study-tree.fromPGN.
 *
 * All state lives under os.tmpdir(); env vars are set BEFORE server.js is
 * required because the module-level path constants read them at load time.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-study-'));
process.env.CHESS_STATE_FILE = path.join(TMP, '.referee-state.json');
process.env.CHESS_JOURNAL_FILE = path.join(TMP, '.referee-journal.jsonl');
process.env.CHESS_DB_FILE = path.join(TMP, 'games.db');
process.env.CHESS_JSON_ARCHIVE_FILE = path.join(TMP, '.games-archive.json');
process.env.CHESS_ACCOUNTS_DB_FILE = path.join(TMP, 'accounts.db');
process.env.CHESS_ACCOUNTS_JSON_FILE = path.join(TMP, '.accounts.json');
process.env.CHESS_SOCIAL_DB_PATH = path.join(TMP, 'social.db');
process.env.CHESS_SOCIAL_JSON_PATH = path.join(TMP, '.social.json');
process.env.CHESS_LEAGUES_DB_PATH = path.join(TMP, 'leagues.db');
process.env.CHESS_LEAGUES_JSON_PATH = path.join(TMP, '.leagues.json');
process.env.CHESS_RATE_LIMIT_FILE = path.join(TMP, 'rate-limit.json');
process.env.CHESS_RATE_LIMIT = '100000';
process.env.CHESS_STUDY_DB_PATH = path.join(TMP, 'study.db');
process.env.CHESS_STUDY_JSON_PATH = path.join(TMP, '.study.json');

const StudyStore = require('../src/study-store.js');
const StudyTree = require('../src/study-tree.js');
const GameArchive = require('../src/game-archive.js');
const serverModule = require('../server.js');

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
    const headers = Object.assign({}, options.headers || {});
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (bodyData !== undefined) headers['Content-Type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, path: options.path, method: options.method || 'GET', headers }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
      });
    });
    req.on('error', reject);
    if (bodyData !== undefined) req.write(typeof bodyData === 'string' ? bodyData : JSON.stringify(bodyData));
    req.end();
  });
}

async function register(server, username) {
  const res = await request(server, { path: '/api/auth/register', method: 'POST' }, { username, password: 'pw-' + username });
  assert.strictEqual(res.status, 200, 'register ' + username + ': ' + res.raw);
  return { token: res.body.token, id: res.body.user.id, username };
}

/** Per-visitor HTTP client that carries the study_player anon cookie. */
function anonClient(server) {
  let cookie = '';
  return async (method, p, body) => {
    const res = await request(server, { method, path: p, headers: cookie ? { Cookie: cookie } : {} }, body);
    const set = res.headers['set-cookie'];
    if (set && set.length) cookie = set[0].split(';')[0];
    res.cookie = cookie;
    return res;
  };
}

const hasSqlite = (() => {
  if (process.env.CHESS_ARCHIVE_FORCE_JSON === '1') return false;
  try { const { DatabaseSync } = require('node:sqlite'); return typeof DatabaseSync === 'function'; }
  catch (_) { return false; }
})();

// A short PGN with a sideline and NAG annotations ($1 good, $2 mistake).
// A legal mainline carrying every NAG code $1–$9 plus a RAV sideline.
const STUDY_PGN = `[Event "Study PGN"]
[Site "Local"]
[White "Alice"]
[Black "Bob"]

1. e4 $1 e5 $2 2. Nf3 $3 (2. Bc4 Nf6) Nc6 $4 3. Bb5 $5 a6 $6 4. Ba4 $7 Nf6 $8 5. O-O $9 Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 *`;

function cleanup() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

async function run() {
  console.log('=== A2.2 Study chapters self-test ===\n');

  // ------------------------------------------------------------------ store
  await test('createStudyStore: sqlite or JSON fallback, save/get/list/delete round-trip', async () => {
    const store = StudyStore.createStudyStore({ forceJson: true, jsonPath: path.join(TMP, 'store-unit.json') });
    const saved = store.saveChapter({
      id: 'unit-1', owner: null, kind: 'fen', title: 'Unit', startFen: '8/8/8/8/8/8/8/K6k w - - 0 1',
      solution: ['a1a2'], solutionSan: ['Ka2'], tree: null, quiz: true
    });
    assert.strictEqual(saved.id, 'unit-1');
    assert.ok(saved.updatedAt > 0);
    const got = store.getChapter('unit-1');
    assert.strictEqual(got.title, 'Unit');
    assert.deepStrictEqual(got.solution, ['a1a2']);
    assert.strictEqual(got.quiz, true);
    assert.strictEqual(store.listChapters({ owner: null }).length, 1);
    assert.strictEqual(store.listChapters({ owner: 'someone' }).length, 0);
    // Per-viewer reveal tracking (drives the B1 export guard).
    assert.strictEqual(store.isRevealed('unit-1', 'anon:A'), false);
    store.markRevealed('unit-1', 'anon:A');
    assert.strictEqual(store.isRevealed('unit-1', 'anon:A'), true);
    assert.strictEqual(store.isRevealed('unit-1', 'anon:B'), false, 'reveal is per-viewer');
    assert.strictEqual(store.deleteChapter('unit-1'), true);
    assert.strictEqual(store.getChapter('unit-1'), null);
    assert.strictEqual(store.isRevealed('unit-1', 'anon:A'), false, 'reveal rows are purged with the chapter');
    store.close();
  });

  if (hasSqlite) {
    await test('SqliteStudyAdapter: table created, save/get/list/delete + reveal tracking work', async () => {
      const store = new StudyStore.SqliteStudyAdapter(path.join(TMP, 'sqlite-unit.db'));
      store.saveChapter({ id: 'sql-1', owner: 'u1', kind: 'pgn', title: 'S', startFen: 'x', solution: [], solutionSan: [], tree: null, quiz: false });
      assert.strictEqual(store.getChapter('sql-1').owner, 'u1');
      assert.strictEqual(store.listChapters({ owner: 'u1' }).length, 1);
      assert.strictEqual(store.isRevealed('sql-1', 'u1'), false);
      store.markRevealed('sql-1', 'u1');
      assert.strictEqual(store.isRevealed('sql-1', 'u1'), true);
      assert.strictEqual(store.isRevealed('sql-1', 'u2'), false);
      assert.strictEqual(store.deleteChapter('sql-1'), true);
      assert.strictEqual(store.isRevealed('sql-1', 'u1'), false);
      store.close();
    });
  } else {
    console.log('SKIP: SqliteStudyAdapter (node:sqlite unavailable on Node < 22.5)');
  }

  // ------------------------------------------------------------------ server routes
  const server = serverModule.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  try {
    // Seed an archived game so the game chapter kind has something to import.
    const seeded = GameArchive.saveGame({
      white: 'Seed', black: 'Opponent', result: '1-0', source: 'local',
      moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5']
    });
    const seedGameId = seeded.id;
    assert.ok(seedGameId, 'seeded game has an id');

    // Two anonymous visitors (separate study_player cookies) plus a signed-in one.
    const guestA = anonClient(server);
    const guestB = anonClient(server);

    let chapterId = null;

    await test('POST /api/study kind=fen creates a chapter; GET /api/study lists it; GET single ships positions', async () => {
      const created = await guestA('POST', '/api/study',
        { kind: 'fen', title: 'Ruy Lopez line', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', line: '1. e4 e5 2. Nf3 Nc6 3. Bb5' });
      assert.strictEqual(created.status, 201, created.raw);
      assert.strictEqual(created.body.ok, true);
      assert.strictEqual(created.body.chapter.kind, 'fen');
      assert.strictEqual(created.body.chapter.totalMoves, 5);
      assert.strictEqual(created.body.chapter.positions.length, 6);
      assert.deepStrictEqual(created.body.chapter.solutionSan, ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
      chapterId = created.body.chapter.id;
      // The same cookie sees it; a different anon visitor does not.
      const list = await guestA('GET', '/api/study');
      assert.strictEqual(list.status, 200);
      assert.strictEqual(list.body.chapters.length, 1);
      assert.strictEqual(list.body.owner, 'guest');
      const otherList = await guestB('GET', '/api/study');
      assert.strictEqual(otherList.body.chapters.length, 0, 'another anon cannot list this guest chapter');
      const one = await guestA('GET', '/api/study/' + encodeURIComponent(chapterId));
      assert.strictEqual(one.status, 200);
      assert.ok(Array.isArray(one.body.chapter.positions));
      assert.strictEqual(one.body.chapter.positions[3].san, 'Nf3');
    });

    await test('POST /api/study kind=fen rejects an invalid FEN (400)', async () => {
      const bad = await guestA('POST', '/api/study', { kind: 'fen', fen: 'this is not a fen', line: '1. e4' });
      assert.strictEqual(bad.status, 400);
      assert.strictEqual(bad.body.ok, false);
      assert.match(bad.body.error, /invalid fen/i);
    });

    await test('POST /api/study kind=fen rejects an illegal move in the line (400)', async () => {
      const bad = await guestA('POST', '/api/study',
        { kind: 'fen', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', line: '1. e5' });
      assert.strictEqual(bad.status, 400);
      assert.match(bad.body.error, /illegal move/i);
    });

    await test('POST /api/study kind=pgn parses RAV variations + NAGs into a tree', async () => {
      const created = await guestA('POST', '/api/study', { kind: 'pgn', pgn: STUDY_PGN });
      assert.strictEqual(created.status, 201, created.raw);
      const ch = created.body.chapter;
      assert.strictEqual(ch.kind, 'pgn');
      assert.strictEqual(ch.title, 'Alice – Bob');
      // Mainline e4 e5 Nf3 Nc6 Bb5
      assert.deepStrictEqual(ch.solutionSan.slice(0, 5), ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
      // Rehydrated tree holds the sideline (2. Bc4 …) + NAGs.
      const tree = require('../src/routes-study.js').rehydrateTree(ch.tree);
      assert.ok(tree, 'tree serialized');
      const mainline = StudyTree.getMainline(tree);
      assert.strictEqual(mainline[2].move, 'Nf3');
      assert.deepStrictEqual(mainline[1].nags, ['2'], 'e5 carries $2');
      assert.deepStrictEqual(mainline[3].nags, ['4'], 'Nc6 carries $4');
      const total = StudyTree.countNodes(tree);
      assert.ok(total >= 8, `tree has the sideline nodes (got ${total})`);
    });

    await test('POST /api/study kind=game imports an archived game by id', async () => {
      const created = await guestA('POST', '/api/study', { kind: 'game', gameId: seedGameId });
      assert.strictEqual(created.status, 201, created.raw);
      const ch = created.body.chapter;
      assert.strictEqual(ch.kind, 'game');
      assert.strictEqual(ch.totalMoves, 5);
      assert.deepStrictEqual(ch.solutionSan, ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
      assert.strictEqual(ch.positions.length, 6);
      const missing = await guestA('POST', '/api/study', { kind: 'game', gameId: 'no-such-game' });
      assert.strictEqual(missing.status, 400);
      assert.match(missing.body.error, /not found/i);
    });

    await test('quiz: wrong move does not reveal and keeps the board live; correct completes and reveals', async () => {
      const created = await guestA('POST', '/api/study', { kind: 'fen', title: 'Quiz: mate in 1', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', line: '1. e4', quiz: true });
      assert.strictEqual(created.status, 201, created.raw);
      const id = created.body.chapter.id;
      // Public quiz GET must NOT contain the solution.
      const pub = await guestA('GET', '/api/study/' + encodeURIComponent(id));
      assert.strictEqual(pub.status, 200);
      assert.strictEqual(pub.body.chapter.quiz, true);
      assert.strictEqual(pub.body.chapter.solutionSan, undefined, 'quiz GET must not ship solutionSan');
      assert.strictEqual(pub.body.chapter.positions, undefined, 'quiz GET must not ship positions');
      // Wrong guess: legal, not correct, no solution leaked.
      const wrong = await guestA('POST', `/api/study/${encodeURIComponent(id)}/guess`, { move: 'd2d4', moves: [] });
      assert.strictEqual(wrong.status, 200);
      assert.strictEqual(wrong.body.legal, true);
      assert.strictEqual(wrong.body.correct, false);
      assert.strictEqual(wrong.body.solution, undefined, 'wrong guess must not leak the solution');
      // Correct guess completes and ships the solution.
      const right = await guestA('POST', `/api/study/${encodeURIComponent(id)}/guess`, { move: 'e2e4', moves: [] });
      assert.strictEqual(right.status, 200);
      assert.strictEqual(right.body.correct, true);
      assert.strictEqual(right.body.complete, true);
      assert.deepStrictEqual(right.body.solution.uci, ['e2e4']);
      // Illegal move.
      const illegal = await guestA('POST', `/api/study/${encodeURIComponent(id)}/guess`, { move: 'e2e5', moves: [] });
      assert.strictEqual(illegal.body.legal, false);
      // Reveal endpoint returns the full chapter.
      const rev = await guestA('POST', `/api/study/${encodeURIComponent(id)}/reveal`, {});
      assert.strictEqual(rev.status, 200);
      assert.ok(Array.isArray(rev.body.chapter.positions));
      assert.deepStrictEqual(rev.body.chapter.solutionSan, ['e4']);
    });

    await test('B1: a concealed quiz never leaks its solution through GET /api/study/:id/pgn', async () => {
      const created = await guestA('POST', '/api/study', { kind: 'fen', title: 'Quiz: no export leak', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', line: '1. e4 e5 2. Nf3', quiz: true });
      assert.strictEqual(created.status, 201, created.raw);
      const id = created.body.chapter.id;
      // The public GET is already concealed…
      const pub = await guestA('GET', '/api/study/' + encodeURIComponent(id));
      assert.strictEqual(pub.body.chapter.solutionSan, undefined);
      assert.strictEqual(pub.body.chapter.positions, undefined);
      // …and the PGN export must refuse too (no movetext, no headers).
      const exp = await guestA('GET', `/api/study/${encodeURIComponent(id)}/pgn`);
      assert.strictEqual(exp.status, 403, `concealed export must be 403, got ${exp.status}: ${exp.raw.slice(0, 120)}`);
      assert.strictEqual(exp.body.ok, false);
      assert.match(exp.body.error, /hidden until the quiz is completed or revealed/i);
      assert.ok(!exp.raw.includes('Nf3'), 'no solution movetext in the refusal body');
      // The raw text variant is refused the same way.
      const raw = await guestA('GET', `/api/study/${encodeURIComponent(id)}/pgn?format=raw`);
      assert.strictEqual(raw.status, 403);
      assert.ok(!raw.raw.includes('Nf3'), 'raw export leaks the solution');
      // A query param cannot spoof reveal.
      const spoof = await guestA('GET', `/api/study/${encodeURIComponent(id)}/pgn?reveal=1`);
      assert.strictEqual(spoof.status, 403, 'reveal must not be spoofable by query param');
      // After an explicit reveal, export works and carries the movetext.
      const rev = await guestA('POST', `/api/study/${encodeURIComponent(id)}/reveal`, {});
      assert.strictEqual(rev.status, 200);
      const exp2 = await guestA('GET', `/api/study/${encodeURIComponent(id)}/pgn`);
      assert.strictEqual(exp2.status, 200, 'revealed export works');
      assert.match(exp2.body.pgn, /Nf3/, 'revealed export carries the line');
      // A different anon visitor still cannot export it.
      const stranger = await guestB('GET', `/api/study/${encodeURIComponent(id)}/pgn`);
      assert.strictEqual(stranger.status, 404, 'another anon cannot even see the chapter');
    });

    await test('B1: completing a quiz unlocks that viewer’s PGN export', async () => {
      const created = await guestA('POST', '/api/study', { kind: 'fen', title: 'Quiz: complete unlocks export', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', line: '1. e4', quiz: true });
      const id = created.body.chapter.id;
      const blocked = await guestA('GET', `/api/study/${encodeURIComponent(id)}/pgn`);
      assert.strictEqual(blocked.status, 403);
      const done = await guestA('POST', `/api/study/${encodeURIComponent(id)}/guess`, { move: 'e2e4', moves: [] });
      assert.strictEqual(done.body.complete, true);
      const exp = await guestA('GET', `/api/study/${encodeURIComponent(id)}/pgn`);
      assert.strictEqual(exp.status, 200, 'export unlocked by completion');
      assert.match(exp.body.pgn, /e4/);
    });

    await test('quiz: guess on a non-quiz chapter is rejected (400)', async () => {
      const noquiz = await guestA('POST', `/api/study/${encodeURIComponent(chapterId)}/guess`, { move: 'e2e4', moves: [] });
      assert.strictEqual(noquiz.status, 400);
      assert.match(noquiz.body.error, /not in quiz mode/i);
    });

    await test('quiz: multi-move line auto-plays the scripted reply and validates the next guess', async () => {
      const created = await guestA('POST', '/api/study',
        { kind: 'fen', title: 'Quiz: two moves', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', line: '1. e4 e5 2. Nf3', quiz: true });
      const id = created.body.chapter.id;
      const g1 = await guestA('POST', `/api/study/${encodeURIComponent(id)}/guess`, { move: 'e2e4', moves: [] });
      assert.strictEqual(g1.body.correct, true);
      assert.strictEqual(g1.body.complete, false);
      assert.strictEqual(g1.body.reply.san, 'e5', 'scripted black reply auto-played');
      const g2 = await guestA('POST', `/api/study/${encodeURIComponent(id)}/guess`, { move: 'g1f3', moves: ['e2e4'] });
      assert.strictEqual(g2.body.correct, true);
      assert.strictEqual(g2.body.complete, true);
      assert.strictEqual(g2.body.reply, null);
    });

    await test('quiz: an alternate checkmate is accepted for a mate-in-1', async () => {
      // Both Ra8# and Rb8# mate here; the stored solution is Ra8#.
      const created = await guestA('POST', '/api/study',
        { kind: 'fen', title: 'Quiz: alternate mate', fen: '6k1/5ppp/8/8/8/8/5PPP/RR4K1 w - - 0 1', line: 'Ra8#', quiz: true });
      assert.strictEqual(created.status, 201, created.raw);
      const id = created.body.chapter.id;
      const alt = await guestA('POST', `/api/study/${encodeURIComponent(id)}/guess`, { move: 'b1b8', moves: [] });
      assert.strictEqual(alt.status, 200);
      assert.strictEqual(alt.body.correct, true, 'alternate mate accepted');
      assert.strictEqual(alt.body.alternateMate, true);
      assert.strictEqual(alt.body.complete, true);
    });

    await test('PGN export emits $1–$9 NAG glyphs and round-trips through fromPGN', async () => {
      const created = await guestA('POST', '/api/study', { kind: 'pgn', title: 'NAG export', pgn: STUDY_PGN });
      const id = created.body.chapter.id;
      const exp = await guestA('GET', `/api/study/${encodeURIComponent(id)}/pgn`);
      assert.strictEqual(exp.status, 200);
      // Every NAG code $1–$9 is exercised by this fixture and must survive.
      for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
        assert.match(exp.body.pgn, new RegExp('\\$' + n + '\\b'), `export contains $${n}`);
      }
      assert.match(exp.body.pgn, /\(\s*2\.\.\. Bc4/, 'export keeps the RAV sideline');
      // Round-trip the movetext back through fromPGN.
      const movetext = exp.body.pgn.replace(/^\s*\[[^\]]*\]\s*$/gm, '').trim();
      const reparsed = StudyTree.fromPGN(movetext);
      let nagCount = 0;
      StudyTree.traverse(reparsed, n => { nagCount += n.nags.length; });
      assert.ok(nagCount >= 2, `round-trip preserved NAGs (got ${nagCount})`);
      // Raw format is text/pgn.
      const raw = await guestA('GET', `/api/study/${encodeURIComponent(id)}/pgn?format=raw`);
      assert.strictEqual(raw.status, 200);
      assert.match(raw.raw, /\$1/);
    });

    await test('ownership: signed-in chapters are scoped to the account; guests cannot see or delete them', async () => {
      const alice = await register(server, 'alice');
      const created = await request(server, { path: '/api/study', method: 'POST', token: alice.token },
        { kind: 'fen', title: 'Alice study', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', line: '1. e4' });
      assert.strictEqual(created.status, 201, created.raw);
      assert.strictEqual(created.body.chapter.owned, true);
      const aliceList = await request(server, { path: '/api/study', token: alice.token });
      assert.strictEqual(aliceList.body.chapters.length, 1);
      assert.strictEqual(aliceList.body.chapters[0].title, 'Alice study');
      // A guest list does not see Alice's chapter.
      const guestList = await guestA('GET', '/api/study');
      assert.ok(!guestList.body.chapters.some(c => c.title === 'Alice study'), 'guest cannot list account chapters');
      // A guest GET is 404 (invisible), and a guest DELETE is 404 too.
      const guestGet = await guestA('GET', '/api/study/' + encodeURIComponent(created.body.chapter.id));
      assert.strictEqual(guestGet.status, 404);
      const guestDel = await guestA('DELETE', '/api/study/' + encodeURIComponent(created.body.chapter.id));
      assert.strictEqual(guestDel.status, 404);
      // The owner can delete their own chapter.
      const del = await request(server, { path: '/api/study/' + encodeURIComponent(created.body.chapter.id), method: 'DELETE', token: alice.token });
      assert.strictEqual(del.status, 200);
      assert.strictEqual(del.body.removed, true);
    });

    await test('M1: a different anon cookie cannot read, delete or un-quiz another guest’s chapter; the same cookie can', async () => {
      const created = await guestA('POST', '/api/study', { kind: 'fen', title: 'A private quiz', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', line: '1. e4', quiz: true });
      const id = created.body.chapter.id;
      // Guest B cannot read it (404, not 403 — invisibility preserves privacy).
      const bGet = await guestB('GET', '/api/study/' + encodeURIComponent(id));
      assert.strictEqual(bGet.status, 404, 'another anon cannot read this chapter');
      // Guest B cannot un-quiz it to expose the solution.
      const bUnquiz = await guestB('POST', `/api/study/${encodeURIComponent(id)}/quiz`, { quiz: false });
      assert.strictEqual(bUnquiz.status, 404, 'another anon cannot toggle quiz');
      // Guest B cannot delete it.
      const bDel = await guestB('DELETE', '/api/study/' + encodeURIComponent(id));
      assert.strictEqual(bDel.status, 404, 'another anon cannot delete this chapter');
      // Guest B's list never contains it.
      const bList = await guestB('GET', '/api/study');
      assert.ok(!bList.body.chapters.some(c => c.id === id), 'another anon cannot list this chapter');
      // The owning cookie still has full control.
      const aGet = await guestA('GET', '/api/study/' + encodeURIComponent(id));
      assert.strictEqual(aGet.status, 200, 'the owning cookie can read');
      const aUnquiz = await guestA('POST', `/api/study/${encodeURIComponent(id)}/quiz`, { quiz: false });
      assert.strictEqual(aUnquiz.status, 200, 'the owning cookie can toggle quiz');
      assert.ok(Array.isArray(aUnquiz.body.chapter.positions), 'un-quiz exposes positions to the owner');
      const aDel = await guestA('DELETE', '/api/study/' + encodeURIComponent(id));
      assert.strictEqual(aDel.status, 200, 'the owning cookie can delete');
      assert.strictEqual(aDel.body.removed, true);
    });

    await test('unknown routes 404 and a bad kind is 400', async () => {
      const bogus = await guestA('GET', '/api/study/xyz/nope');
      assert.strictEqual(bogus.status, 404);
      const badKind = await guestA('POST', '/api/study', { kind: 'chess' });
      assert.strictEqual(badKind.status, 400);
    });
  } finally {
    await new Promise(r => server.close(r));
    try { GameArchive.resetArchive(); } catch (_) {}
    try { serverModule.stopStateWatcher && serverModule.stopStateWatcher(); } catch (_) {}
    cleanup();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log(`All ${passed} study chapter tests passed successfully!`);
  process.exit(0);
}

run().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  cleanup();
  process.exit(1);
});
