#!/usr/bin/env node
'use strict';

/**
 * direct-id-authorization-selftest.js — kanban card `fix-archived-game-idor`.
 *
 * Live-HTTP coverage for the FOUR direct-ID archived-game paths that
 * previously bypassed the requester-aware scoping the LIST path enforces:
 *
 *   1. GET  /api/games/:id
 *   2. GET  /api/games/:id/pgn
 *   3. GET  /api/games/:id/missed-tactics
 *   4. POST /api/study { kind:'game', gameId }
 *
 * For each operation we assert the full authorization matrix:
 *   - owner A reading A's owned archived game -> 200 with expected data
 *   - signed-in B reading A's owned game -> 404 'game not found' (no leak)
 *   - anonymous reading A's owned game -> 404 'game not found' (no leak)
 *   - anonymous reading an UNOWNED game -> 200 / 201 (guest scope preserved)
 *   - signed-in A or B reading an UNOWNED game by id -> 404 (consistent with
 *     GET /api/games, where signed-in users see only their own rows)
 *   - any requester reading a missing id -> 404 'game not found' (same shape
 *     as unauthorized, so existence is not enumerable)
 *
 * Additionally: a rejected missed-tactics must NOT start engine analysis
 * (the 404 is returned before respondMisses runs — no evals/misses/engine in
 * the body); cross-user/anon Study attempts create NO chapter; scoped LIST
 * behaviour still passes.
 *
 * All state lives under os.tmpdir(); env vars are set BEFORE server.js is
 * required because the module-level path constants read them at load time.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-idor-'));
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

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function cleanup() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

async function run() {
  console.log('=== Direct-ID authorization self-test (fix-archived-game-idor) ===\n');

  const server = serverModule.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  try {
    // ---- fixtures -----------------------------------------------------------
    // Two registered accounts A and B.
    const A = await register(server, 'ownerA');
    const B = await register(server, 'ownerB');

    // An archived game OWNED by account A (owner_id = A.id). UCI moves so the
    // missed-tactics path and the PGN export both have a usable move list.
    const ownedA = GameArchive.saveGame({
      white: 'Owner A', black: 'Opponent', result: '1-0', source: 'local',
      owner_id: String(A.id),
      moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5']
    });
    assert.ok(ownedA.id, 'ownedA game seeded');
    assert.strictEqual(String(ownedA.owner_id), String(A.id), 'ownedA owner_id is A');

    // An UNOWNED archived game (owner_id null) — the guest scope.
    const unowned = GameArchive.saveGame({
      white: 'Guest White', black: 'Guest Black', result: '0-1', source: 'local',
      moves: ['d2d4', 'd7d5', 'c2c4', 'c7c6', 'b1c3']
    });
    assert.ok(unowned.id, 'unowned game seeded');
    assert.strictEqual(unowned.owner_id, null, 'unowned game has null owner');

    // A random id that does not exist in the archive.
    const missingId = 'no-such-game-' + Date.now();

    const expectedSAN = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'];
    const unownedSAN = ['d4', 'd5', 'c4', 'c6', 'Nc3'];

    // ---- GET /api/games/:id ------------------------------------------------
    await test('GET /api/games/:id — owner A reads own game (200, expected data)', async () => {
      const res = await request(server, { path: '/api/games/' + encodeURIComponent(ownedA.id), headers: authHeaders(A.token) });
      assert.strictEqual(res.status, 200, res.raw);
      assert.strictEqual(res.body.ok, true);
      assert.strictEqual(res.body.game.id, ownedA.id);
      assert.deepStrictEqual(res.body.game.solutionSan || res.body.game.solution || (res.body.game.positions || []).slice(1).map(p => p.san), expectedSAN, 'owner sees the moves');
    });

    await test('GET /api/games/:id — signed-in B reads A game (404 safe body, no leak)', async () => {
      const res = await request(server, { path: '/api/games/' + encodeURIComponent(ownedA.id), headers: authHeaders(B.token) });
      assert.strictEqual(res.status, 404, 'B must not read A game: ' + res.raw);
      assert.strictEqual(res.body.error, 'game not found');
      assert.strictEqual(res.body.ok, false);
      // No game/moves/pgn marker of any kind.
      assert.strictEqual(res.body.game, undefined, 'no game object leaks');
      assert.strictEqual(res.raw.includes('e2e4'), false, 'no UCI move leaks in body');
      assert.strictEqual(res.raw.includes('Owner A'), false, 'no owner identity leaks');
    });

    await test('GET /api/games/:id — anonymous reads A game (404 same shape)', async () => {
      const res = await request(server, { path: '/api/games/' + encodeURIComponent(ownedA.id) });
      assert.strictEqual(res.status, 404, 'anon must not read A game: ' + res.raw);
      assert.strictEqual(res.body.error, 'game not found');
      assert.strictEqual(res.body.ok, false);
    });

    await test('GET /api/games/:id — anonymous reads UNOWNED game (200, guest scope)', async () => {
      const res = await request(server, { path: '/api/games/' + encodeURIComponent(unowned.id) });
      assert.strictEqual(res.status, 200, 'anon may read unowned: ' + res.raw);
      assert.strictEqual(res.body.ok, true);
      assert.strictEqual(res.body.game.id, unowned.id);
    });

    await test('GET /api/games/:id — signed-in A reads UNOWNED game by id (404, consistent with list)', async () => {
      const res = await request(server, { path: '/api/games/' + encodeURIComponent(unowned.id), headers: authHeaders(A.token) });
      assert.strictEqual(res.status, 404, 'signed-in must not reach unowned by id: ' + res.raw);
      assert.strictEqual(res.body.error, 'game not found');
    });

    await test('GET /api/games/:id — signed-in B reads UNOWNED game by id (404)', async () => {
      const res = await request(server, { path: '/api/games/' + encodeURIComponent(unowned.id), headers: authHeaders(B.token) });
      assert.strictEqual(res.status, 404, 'signed-in B must not reach unowned by id: ' + res.raw);
    });

    await test('GET /api/games/:id — missing id (404 same shape as unauthorized)', async () => {
      const res = await request(server, { path: '/api/games/' + encodeURIComponent(missingId), headers: authHeaders(A.token) });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error, 'game not found');
    });

    // ---- GET /api/games/:id/pgn -------------------------------------------
    await test('GET /api/games/:id/pgn — owner A downloads own PGN (200, Content-Disposition)', async () => {
      const res = await request(server, { path: '/api/games/' + encodeURIComponent(ownedA.id) + '/pgn', headers: authHeaders(A.token) });
      assert.strictEqual(res.status, 200, res.raw);
      assert.match(res.headers['content-type'], /application\/x-chess-pgn/);
      assert.match(res.headers['content-disposition'] || '', new RegExp(ownedA.id + '\\.pgn'), 'filename uses the archive id for allowed requests');
      assert.ok(res.raw.length > 0, 'pgn body present');
    });

    await test('GET /api/games/:id/pgn — signed-in B (404, no id in filename, no PGN body)', async () => {
      const res = await request(server, { path: '/api/games/' + encodeURIComponent(ownedA.id) + '/pgn', headers: authHeaders(B.token) });
      assert.strictEqual(res.status, 404, 'B must not download A pgn: ' + res.raw);
      assert.strictEqual(res.raw.includes('e4'), false, 'no PGN move leaks');
      const cd = res.headers['content-disposition'] || '';
      assert.strictEqual(cd.includes(ownedA.id), false, 'rejected request must not expose archive id via filename');
    });

    await test('GET /api/games/:id/pgn — anonymous (404 same shape)', async () => {
      const res = await request(server, { path: '/api/games/' + encodeURIComponent(ownedA.id) + '/pgn' });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error, 'game not found');
    });

    await test('GET /api/games/:id/pgn — anonymous UNOWNED (200, pgn body)', async () => {
      const res = await request(server, { path: '/api/games/' + encodeURIComponent(unowned.id) + '/pgn' });
      assert.strictEqual(res.status, 200, 'anon may download unowned pgn: ' + res.raw);
      assert.ok(res.raw.length > 0);
    });

    await test('GET /api/games/:id/pgn — missing id (404)', async () => {
      const res = await request(server, { path: '/api/games/' + encodeURIComponent(missingId) + '/pgn', headers: authHeaders(A.token) });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error, 'game not found');
    });

    // ---- GET /api/games/:id/missed-tactics ---------------------------------
    await test('GET /api/games/:id/missed-tactics — owner A (200, analysis runs)', async () => {
      const res = await request(server, { path: '/api/games/' + encodeURIComponent(ownedA.id) + '/missed-tactics', headers: authHeaders(A.token) });
      // Engine may or may not be available in the test env; either way the
      // handler reaches respondMisses, so the body has the review shape.
      assert.strictEqual(res.status, 200, 'owner reaches review: ' + res.raw);
      assert.strictEqual(res.body.ok, true);
      assert.strictEqual(res.body.gameId, ownedA.id);
      assert.ok(Array.isArray(res.body.evals), 'evals array present for allowed request');
      assert.ok(Array.isArray(res.body.misses), 'misses array present for allowed request');
    });

    await test('GET /api/games/:id/missed-tactics — signed-in B (404, NO analysis started)', async () => {
      const res = await request(server, { path: '/api/games/' + encodeURIComponent(ownedA.id) + '/missed-tactics', headers: authHeaders(B.token) });
      assert.strictEqual(res.status, 404, 'B must not review A game: ' + res.raw);
      assert.strictEqual(res.body.error, 'game not found');
      // respondMisses never ran: no review-shape keys.
      assert.strictEqual(res.body.evals, undefined, 'a rejected request must not start engine analysis (no evals)');
      assert.strictEqual(res.body.misses, undefined, 'a rejected request must not start engine analysis (no misses)');
      assert.strictEqual(res.body.engine, undefined, 'no engine marker');
      assert.strictEqual(res.body.gameId, undefined, 'no gameId leak');
    });

    await test('GET /api/games/:id/missed-tactics — anonymous (404, NO analysis)', async () => {
      const res = await request(server, { path: '/api/games/' + encodeURIComponent(ownedA.id) + '/missed-tactics' });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error, 'game not found');
      assert.strictEqual(res.body.evals, undefined, 'no analysis started for anon');
    });

    await test('GET /api/games/:id/missed-tactics — anonymous UNOWNED (200, analysis may run)', async () => {
      const res = await request(server, { path: '/api/games/' + encodeURIComponent(unowned.id) + '/missed-tactics' });
      assert.strictEqual(res.status, 200, 'anon may review unowned: ' + res.raw);
      assert.strictEqual(res.body.gameId, unowned.id);
      assert.ok(Array.isArray(res.body.evals), 'evals present for allowed unowned review');
    });

    await test('GET /api/games/:id/missed-tactics — signed-in A UNOWNED (404)', async () => {
      const res = await request(server, { path: '/api/games/' + encodeURIComponent(unowned.id) + '/missed-tactics', headers: authHeaders(A.token) });
      assert.strictEqual(res.status, 404, 'signed-in must not review unowned by id');
      assert.strictEqual(res.body.evals, undefined, 'no analysis for signed-in on unowned');
    });

    await test('GET /api/games/:id/missed-tactics — missing id (404, NO analysis)', async () => {
      const res = await request(server, { path: '/api/games/' + encodeURIComponent(missingId) + '/missed-tactics', headers: authHeaders(A.token) });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error, 'game not found');
      assert.strictEqual(res.body.evals, undefined, 'missing id must not start analysis');
    });

    // ---- POST /api/study { kind:'game', gameId } --------------------------
    await test('POST /api/study kind=game — owner A imports own game (201, expected line)', async () => {
      const res = await request(server, { path: '/api/study', method: 'POST', headers: authHeaders(A.token) }, { kind: 'game', gameId: ownedA.id });
      assert.strictEqual(res.status, 201, 'A imports own game: ' + res.raw);
      assert.strictEqual(res.body.ok, true);
      const ch = res.body.chapter;
      assert.strictEqual(ch.kind, 'game');
      assert.deepStrictEqual(ch.solutionSan, expectedSAN, 'A sees the imported line');
      assert.strictEqual(ch.totalMoves, 5);
    });

    await test('POST /api/study kind=game — signed-in B imports A game (404, NO chapter created)', async () => {
      const before = await request(server, { path: '/api/study', headers: authHeaders(B.token) });
      const beforeCount = before.body.chapters.length;
      const res = await request(server, { path: '/api/study', method: 'POST', headers: authHeaders(B.token) }, { kind: 'game', gameId: ownedA.id });
      assert.strictEqual(res.status, 404, 'B must not import A game: ' + res.raw);
      assert.strictEqual(res.body.error, 'game not found');
      assert.strictEqual(res.body.ok, false);
      const after = await request(server, { path: '/api/study', headers: authHeaders(B.token) });
      assert.strictEqual(after.body.chapters.length, beforeCount, 'cross-user import created NO chapter');
    });

    await test('POST /api/study kind=game — anonymous imports A game (404, NO chapter)', async () => {
      // Fresh anonymous client (no study_player cookie yet).
      const res = await request(server, { path: '/api/study', method: 'POST' }, { kind: 'game', gameId: ownedA.id });
      assert.strictEqual(res.status, 404, 'anon must not import A game: ' + res.raw);
      assert.strictEqual(res.body.error, 'game not found');
    });

    await test('POST /api/study kind=game — anonymous imports UNOWNED game (201, guest scope preserved)', async () => {
      // Fresh anonymous client.
      const res = await request(server, { path: '/api/study', method: 'POST' }, { kind: 'game', gameId: unowned.id });
      assert.strictEqual(res.status, 201, 'anon may import unowned: ' + res.raw);
      assert.strictEqual(res.body.ok, true);
      const ch = res.body.chapter;
      assert.strictEqual(ch.kind, 'game');
      assert.deepStrictEqual(ch.solutionSan, unownedSAN, 'anon sees the unowned imported line');
    });

    await test('POST /api/study kind=game — signed-in A imports UNOWNED game (404, consistent with list)', async () => {
      const res = await request(server, { path: '/api/study', method: 'POST', headers: authHeaders(A.token) }, { kind: 'game', gameId: unowned.id });
      assert.strictEqual(res.status, 404, 'signed-in must not import unowned by id: ' + res.raw);
      assert.strictEqual(res.body.error, 'game not found');
    });

    await test('POST /api/study kind=game — missing id (404 same shape as unauthorized)', async () => {
      const res = await request(server, { path: '/api/study', method: 'POST', headers: authHeaders(A.token) }, { kind: 'game', gameId: missingId });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error, 'game not found');
    });

    // ---- scoped LIST still passes -----------------------------------------
    await test('GET /api/games — scoped list still works: A sees own, B sees none of A, anon sees unowned', async () => {
      const aList = await request(server, { path: '/api/games', headers: authHeaders(A.token) });
      assert.strictEqual(aList.status, 200);
      const aIds = aList.body.games.map(g => g.id);
      assert.ok(aIds.includes(ownedA.id), 'A sees own game in list');
      assert.strictEqual(aIds.includes(unowned.id), false, 'A does not see unowned in list');

      const bList = await request(server, { path: '/api/games', headers: authHeaders(B.token) });
      assert.strictEqual(bList.status, 200);
      const bIds = bList.body.games.map(g => g.id);
      assert.strictEqual(bIds.includes(ownedA.id), false, 'B does not see A game in list');

      const anonList = await request(server, { path: '/api/games' });
      assert.strictEqual(anonList.status, 200);
      const anonIds = anonList.body.games.map(g => g.id);
      assert.ok(anonIds.includes(unowned.id), 'anon sees unowned in list');
      assert.strictEqual(anonIds.includes(ownedA.id), false, 'anon does not see A owned game in list');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    await new Promise(r => server.close(r));
    // The server module leaves a state-watcher interval running, which would
    // keep this process alive after the suite finishes; exit explicitly.
    if (typeof serverModule.stopStateWatcher === 'function') {
      try { serverModule.stopStateWatcher(); } catch (_) {}
    }
  }
  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  cleanup();
  process.exit(1);
});