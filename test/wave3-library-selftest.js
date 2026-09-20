#!/usr/bin/env node
'use strict';

/**
 * wave3-library-selftest.js — Wave 3 retention: games bound to accounts,
 * external history import (lichess / Chess.com, stubbed network) and the
 * Library routes exercised end-to-end through server.js.
 *
 * All state lives under os.tmpdir(); env vars are set BEFORE server.js is
 * required because the module-level path constants read them at load time.
 * No real network: every fetch goes through a stub `fetchImpl`.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-wave3-library-'));
process.env.CHESS_STATE_FILE = path.join(TMP, '.referee-state.json');
process.env.CHESS_JOURNAL_FILE = path.join(TMP, '.referee-journal.jsonl');
process.env.CHESS_DB_FILE = path.join(TMP, 'games.db');
process.env.CHESS_JSON_ARCHIVE_FILE = path.join(TMP, '.games-archive.json');
process.env.CHESS_ACCOUNTS_DB_FILE = path.join(TMP, 'accounts.db');
process.env.CHESS_ACCOUNTS_JSON_FILE = path.join(TMP, '.accounts.json');
process.env.CHESS_SOCIAL_DB_PATH = path.join(TMP, 'social.db');
process.env.CHESS_LEAGUES_DB_PATH = path.join(TMP, 'leagues.db');
process.env.CHESS_LEAGUES_JSON_PATH = path.join(TMP, '.leagues.json');
process.env.CHESS_SOCIAL_JSON_PATH = path.join(TMP, '.social.json');
process.env.CHESS_RATE_LIMIT_FILE = path.join(TMP, 'rate-limit.json');
process.env.CHESS_RATE_LIMIT = '100000';

const GameArchive = require('../src/game-archive.js');
const ImportExternal = require('../src/import-external.js');
const LibraryRoutes = require('../src/routes-library.js');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`PASS: ${name}`);
}

const hasSqlite = (() => {
  if (process.env.CHESS_ARCHIVE_FORCE_JSON === '1') return false;
  try { const { DatabaseSync } = require('node:sqlite'); return typeof DatabaseSync === 'function'; }
  catch (_) { return false; }
})();

// ---------------------------------------------------------------------------
// fixtures: real-looking upstream payloads
// ---------------------------------------------------------------------------
function lichessPgn(id, { white = 'alice', black = 'bob', result = '1-0', date = '2025.03.10', time = '18:22:05' } = {}) {
  return `[Event "Rated Blitz game"]
[Site "https://lichess.org/${id}"]
[Date "${date}"]
[White "${white}"]
[Black "${black}"]
[Result "${result}"]
[UTCDate "${date}"]
[UTCTime "${time}"]
[WhiteElo "1712"]
[BlackElo "1698"]
[Variant "Standard"]
[TimeControl "180+2"]
[ECO "C50"]
[Opening "Italian Game"]
[Termination "Normal"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d4 exd4 6. cxd4 Bb4+ 7. Nc3 Nxe4 8. O-O ${result}
`;
}

function chesscomGame(idNum, { white = 'carol', black = 'dave', result = '0-1', endTime = 1741630925 } = {}) {
  const d = new Date(endTime * 1000).toISOString().slice(0, 10).replace(/-/g, '.');
  const pgn = `[Event "Live Chess"]
[Site "Chess.com"]
[Date "${d}"]
[Round "-"]
[White "${white}"]
[Black "${black}"]
[Result "${result}"]
[CurrentPosition "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"]
[Timezone "UTC"]
[ECO "B20"]
[ECOUrl "https://www.chess.com/openings/Sicilian-Defense"]
[UTCDate "${d}"]
[UTCTime "12:15:25"]
[WhiteElo "1450"]
[BlackElo "1470"]
[TimeControl "600"]
[Termination "${black} won by resignation"]
[Link "https://www.chess.com/game/live/${idNum}"]

1. e4 {[%clk 0:09:58]} 1... c5 {[%clk 0:09:57]} 2. Nf3 {[%clk 0:09:55]} 2... d6 {[%clk 0:09:50]} 3. d4 {[%clk 0:09:40]} 3... cxd4 {[%clk 0:09:45]} 4. Nxd4 {[%clk 0:09:38]} 4... Nf6 {[%clk 0:09:40]} ${result}
`;
  return {
    url: `https://www.chess.com/game/live/${idNum}`,
    pgn,
    time_control: '600',
    end_time: endTime,
    rated: true,
    time_class: 'rapid',
    rules: 'chess',
    white: { rating: 1450, result: result === '1-0' ? 'win' : 'resigned', username: white },
    black: { rating: 1470, result: result === '0-1' ? 'win' : 'resigned', username: black }
  };
}

function jsonResponse(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: k => h.get(String(k).toLowerCase()) || null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body)
  };
}

/** Stub fetch: routes by URL; records calls; optional 429 script. */
function makeStubFetch(routes, opts = {}) {
  const calls = [];
  let rateLimitHits = opts.rateLimit429 || 0;
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    if (rateLimitHits > 0) { rateLimitHits--; return jsonResponse(429, 'Too Many Requests', { 'Retry-After': '0' }); }
    for (const [re, handler] of routes) {
      const m = String(url).match(re);
      if (m) return handler(m, new URL(String(url)));
    }
    return jsonResponse(404, { error: 'not found' });
  };
  fn.calls = calls;
  return fn;
}

const LICHESS_ROUTES = (games) => [[/lichess\.org\/api\/games\/user\/([^?]+)/, (m, u) => {
  const user = decodeURIComponent(m[1]);
  if (user === 'nobody') return jsonResponse(404, '');
  const max = Number(u.searchParams.get('max') || 300);
  const until = u.searchParams.get('until') ? Number(u.searchParams.get('until')) : null;
  const since = u.searchParams.get('since') ? Number(u.searchParams.get('since')) : null;
  let list = games.slice();
  if (until != null) list = list.filter(g => g.ts <= until);
  if (since != null) list = list.filter(g => g.ts >= since);
  list.sort((a, b) => b.ts - a.ts);
  return jsonResponse(200, list.slice(0, max).map(g => g.pgn).join('\n\n'), { 'Content-Type': 'application/x-chess-pgn' });
}]];

const CHESSCOM_ROUTES = (months) => [
  [/api\.chess\.com\/pub\/player\/([^/]+)\/games\/archives$/, (m) => {
    if (m[1] === 'nobody') return jsonResponse(404, { code: 0, message: 'User "nobody" not found.' });
    return jsonResponse(200, { archives: Object.keys(months).sort().map(k => `https://api.chess.com/pub/player/${m[1]}/games/${k}`) });
  }],
  [/api\.chess\.com\/pub\/player\/([^/]+)\/games\/(\d{4}\/\d{2})$/, (m) => jsonResponse(200, { games: months[m[2]] || [] })]
];

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

function cleanup() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

async function run() {
  console.log('=== Wave 3 library / ownership / external import self-test ===\n');

  // ------------------------------------------------------------ 1. schema
  if (hasSqlite) {
    await test('schema migration: pre-Wave-3 games.db gains owner/source/external/room columns, data intact', async () => {
      const { DatabaseSync } = require('node:sqlite');
      const dbPath = path.join(TMP, 'legacy.db');
      const legacy = new DatabaseSync(dbPath);
      legacy.exec(`CREATE TABLE games (id TEXT PRIMARY KEY, white TEXT, black TEXT, date TEXT, result TEXT, eco TEXT, pgn TEXT, moves TEXT, created_at INTEGER);
        INSERT INTO games VALUES ('legacy-1', 'Ann', 'Ben', '2024.01.01', '1-0', 'C20', '[Result "1-0"]\n\n1. e4 e5 1-0', 'e2e4 e7e5', 1000);`);
      legacy.close();
      const archive = GameArchive.createGameArchive({ dbPath });
      assert.strictEqual(archive.backendType, 'sqlite');
      const cols = archive.storage.gamesColumns();
      for (const c of ['owner_id', 'source', 'external_id', 'room_id']) assert(cols.includes(c), 'column ' + c);
      const row = archive.getGame('legacy-1');
      assert.strictEqual(row.white, 'Ann');
      assert.strictEqual(row.moves, 'e2e4 e7e5');
      assert.strictEqual(row.owner_id, null);
      assert.strictEqual(row.source, null);
      archive.close();
      // Re-open: idempotent (no duplicate-column error), data still there.
      const again = GameArchive.createGameArchive({ dbPath });
      assert.strictEqual(again.listGames().length, 1);
      assert.strictEqual(again.storage.gamesColumns().length, 13);
      again.close();
    });
  } else {
    console.log('SKIP: schema migration: pre-Wave-3 games.db gains owner/source/external/room columns, data intact (node:sqlite unavailable on Node < 22.5)');
  }

  await test('owner filters: absent = all, id = that account, null = unowned; source + room filters', async () => {
    const archive = GameArchive.createGameArchive({ dbPath: path.join(TMP, 'filters.db') });
    archive.saveGame({ id: 'g-guest', white: 'Guest', black: 'Bot', moves: ['e2e4'], room_id: 'game-abc123' });
    archive.saveGame({ id: 'g-u1', white: 'U1', black: 'X', moves: ['d2d4'], owner_id: 'u1', source: 'local' });
    archive.saveGame({ id: 'g-u1-li', white: 'U1', black: 'Y', moves: ['c2c4'], owner_id: 'u1', source: 'lichess', external_id: 'AbCdEfGh' });
    archive.saveGame({ id: 'g-u2', white: 'U2', black: 'Z', moves: ['g1f3'], owner_id: 'u2', source: 'pgn' });
    assert.strictEqual(archive.listGames().length, 4, 'absent owner = all');
    assert.deepStrictEqual(archive.listGames({ owner: 'u1' }).map(g => g.id).sort(), ['g-u1', 'g-u1-li']);
    assert.deepStrictEqual(archive.listGames({ owner: null }).map(g => g.id), ['g-guest']);
    assert.deepStrictEqual(archive.listGames({ owner: undefined }).map(g => g.id), ['g-guest'], 'owner:undefined counts as unowned');
    assert.deepStrictEqual(archive.listGames({ source: 'local' }).map(g => g.id).sort(), ['g-guest', 'g-u1'], "source 'local' includes legacy NULL rows");
    assert.deepStrictEqual(archive.listGames({ owner: 'u1', source: 'lichess' }).map(g => g.id), ['g-u1-li']);
    assert.deepStrictEqual(archive.listGames({ roomId: 'game-abc123' }).map(g => g.id), ['g-guest']);
    assert.deepStrictEqual(archive.searchGames('U1', { owner: 'u1' }).map(g => g.id).sort(), ['g-u1', 'g-u1-li']);
    assert.deepStrictEqual(archive.searchGames('U1', { owner: null }).map(g => g.id), []);
    assert.deepStrictEqual(archive.searchGames({ white: 'U' }, { owner: 'u2' }).map(g => g.id), ['g-u2']);
    assert.strictEqual(archive.countGames({ owner: 'u1' }), 2);
    assert.strictEqual(archive.countGames({ owner: null }), 1);
    assert.strictEqual(archive.findGameByExternal('lichess', 'AbCdEfGh').id, 'g-u1-li');
    assert.strictEqual(archive.findGameByExternal('lichess', 'nope'), null);
    assert.throws(() => archive.saveGame({ white: 'a', black: 'b', moves: ['e2e4'], source: 'bogus' }), /unknown source/);
    archive.close();
  });

  await test('claimGames: assigns only unowned games matching room ids / ids, idempotent', async () => {
    const archive = GameArchive.createGameArchive({ dbPath: path.join(TMP, 'claim.db') });
    archive.saveGame({ id: 'c1', white: 'a', black: 'b', moves: ['e2e4'], room_id: 'game-r1' });
    archive.saveGame({ id: 'c2', white: 'a', black: 'b', moves: ['e2e4'], room_id: 'game-r1' });
    archive.saveGame({ id: 'c3', white: 'a', black: 'b', moves: ['e2e4'], room_id: 'game-r2', owner_id: 'other' });
    archive.saveGame({ id: 'c4', white: 'a', black: 'b', moves: ['e2e4'] });
    assert.deepStrictEqual(archive.claimGames('me', ['game-r1', 'game-r2', 'game-missing']).sort(), ['c1', 'c2']);
    assert.strictEqual(archive.getGame('c3').owner_id, 'other', 'owned games are never re-claimed');
    assert.deepStrictEqual(archive.claimGames('me', ['game-r1']), [], 'second claim is a no-op');
    assert.deepStrictEqual(archive.claimGames('me', { ids: ['c4'] }), ['c4']);
    assert.strictEqual(archive.countGames({ owner: 'me' }), 3);
    archive.close();
  });

  await test('JSON fallback backend supports the same ownership API', async () => {
    const archive = GameArchive.createGameArchive({ forceJson: true, jsonPath: path.join(TMP, 'fallback.json') });
    assert.strictEqual(archive.backendType, 'json');
    archive.saveGame({ id: 'j1', white: 'a', black: 'b', moves: ['e2e4'], owner_id: 'u1', source: 'chesscom', external_id: 'https://www.chess.com/game/live/1' });
    archive.saveGame({ id: 'j2', white: 'a', black: 'b', moves: ['e2e4'], room_id: 'game-x' });
    assert.deepStrictEqual(archive.listGames({ owner: null }).map(g => g.id), ['j2']);
    assert.deepStrictEqual(archive.listGames({ owner: 'u1', source: 'chesscom' }).map(g => g.id), ['j1']);
    assert.strictEqual(archive.findGameByExternal('chesscom', 'https://www.chess.com/game/live/1').id, 'j1');
    assert.deepStrictEqual(archive.claimGames('u1', ['game-x']), ['j2']);
    assert.strictEqual(archive.countGames({ owner: 'u1' }), 2);
    archive.saveImport({ ownerId: 'u1', source: 'chesscom', username: 'carol', imported: 1, total: 1, nextSince: 42 });
    assert.strictEqual(archive.listImports('u1')[0].nextSince, 42);
    archive.close();
    const reopened = GameArchive.createGameArchive({ forceJson: true, jsonPath: path.join(TMP, 'fallback.json') });
    assert.strictEqual(reopened.getGame('j2').owner_id, 'u1', 'claim persisted to disk');
    assert.strictEqual(reopened.listImports('u1').length, 1);
    reopened.close();
  });

  // ------------------------------------------------------- 2. importers
  const T0 = Date.parse('2025-03-10T18:22:05Z');
  const lichessGames = [
    { id: 'aB3dE7gH', ts: T0, pgn: lichessPgn('aB3dE7gH', { time: '18:22:05' }) },
    { id: 'Zq9wX2vK', ts: T0 - 3600 * 1000, pgn: lichessPgn('Zq9wX2vK', { white: 'bob', black: 'alice', result: '0-1', time: '17:22:05' }) },
    { id: 'Mn4Pq8Rs', ts: T0 - 2 * 3600 * 1000, pgn: lichessPgn('Mn4Pq8Rs', { result: '1/2-1/2', time: '16:22:05' }) }
  ];

  await test('splitPgnGames / lichess id + timestamp parsing', async () => {
    const parts = ImportExternal.splitPgnGames(lichessGames.map(g => g.pgn).join('\n\n'));
    assert.strictEqual(parts.length, 3);
    const parsed = GameArchive.parsePgn(parts[0]);
    assert.strictEqual(ImportExternal.lichessGameId(parsed), 'aB3dE7gH');
    assert.strictEqual(ImportExternal.lichessTimestamp(parsed), T0);
    assert.strictEqual(parsed.eco, 'C50');
    assert.strictEqual(parsed.moves[0], 'e4');
  });

  await test('importLichess: stubbed PGN export -> 3 games owned by the account, duplicates skipped on re-run', async () => {
    const archive = GameArchive.createGameArchive({ dbPath: path.join(TMP, 'li.db') });
    const fetchImpl = makeStubFetch(LICHESS_ROUTES(lichessGames));
    const r1 = await ImportExternal.importLichess({ username: 'alice', ownerId: 'acct-1', archive, fetchImpl, sleepImpl: async () => {} });
    assert.deepStrictEqual({ imported: r1.imported, skipped: r1.skipped, total: r1.total }, { imported: 3, skipped: 0, total: 3 });
    assert.strictEqual(r1.nextSince, T0 + 1);
    assert.strictEqual(fetchImpl.calls.length, 1, 'one page (fewer than max returned)');
    assert.match(fetchImpl.calls[0].url, /^https:\/\/lichess\.org\/api\/games\/user\/alice\?/);
    assert.match(fetchImpl.calls[0].url, /max=300/);
    assert.match(fetchImpl.calls[0].url, /opening=true/);
    assert.strictEqual(fetchImpl.calls[0].init.headers.Accept, 'application/x-chess-pgn');
    assert.strictEqual(fetchImpl.calls[0].init.headers['User-Agent'], ImportExternal.USER_AGENT);
    const rows = archive.listGames({ owner: 'acct-1', source: 'lichess' });
    assert.strictEqual(rows.length, 3);
    assert.deepStrictEqual(rows.map(r => r.external_id).sort(), ['Mn4Pq8Rs', 'Zq9wX2vK', 'aB3dE7gH']);
    assert.strictEqual(rows.find(r => r.external_id === 'Zq9wX2vK').result, '0-1');
    assert.strictEqual(rows[0].eco, 'C50');
    assert.match(rows[0].pgn, /\[Opening "Italian Game"\]/);
    // re-run (full, no since) -> all skipped
    const r2 = await ImportExternal.importLichess({ username: 'alice', ownerId: 'acct-1', archive, fetchImpl, sleepImpl: async () => {} });
    assert.deepStrictEqual({ imported: r2.imported, skipped: r2.skipped, total: r2.total }, { imported: 0, skipped: 3, total: 3 });
    assert.strictEqual(archive.countGames({ owner: 'acct-1' }), 3);
    // incremental: since = nextSince -> stub returns nothing
    const r3 = await ImportExternal.importLichess({ username: 'alice', ownerId: 'acct-1', archive, fetchImpl, since: r1.nextSince, sleepImpl: async () => {} });
    assert.strictEqual(r3.total, 0);
    assert.strictEqual(r3.nextSince, r1.nextSince);
    archive.close();
  });

  await test('importLichess: paginates by until with capped max, stops at the cap', async () => {
    const many = [];
    for (let i = 0; i < 7; i++) {
      const id = 'Pg' + String(i).padStart(6, '0');
      many.push({ id, ts: T0 - i * 60000, pgn: lichessPgn(id, { time: `18:${String(22 - i).padStart(2, '0')}:05` }) });
    }
    const archive = GameArchive.createGameArchive({ dbPath: path.join(TMP, 'li-page.db') });
    const fetchImpl = makeStubFetch(LICHESS_ROUTES(many));
    // Force small pages by asking for max=5: page 1 -> 5 games, page 2 -> the rest (cap stops at 5 anyway)
    const r = await ImportExternal.importLichess({ username: 'alice', ownerId: 'a', archive, fetchImpl, max: 5, sleepImpl: async () => {} });
    assert.strictEqual(r.imported, 5);
    assert.strictEqual(fetchImpl.calls.length, 1, 'cap reached on the first page');
    // Now a cap larger than the page: exercise `until`
    const archive2 = GameArchive.createGameArchive({ dbPath: path.join(TMP, 'li-page2.db') });
    const stub2 = makeStubFetch(LICHESS_ROUTES(many));
    // 3-per-page: 3 + 3 + 1 -> three requests, the last one short (= last page)
    const r2 = await ImportExternal.importLichess({ username: 'alice', ownerId: 'a', archive: archive2, fetchImpl: stub2, pageSize: 3, sleepImpl: async () => {} });
    assert.strictEqual(r2.imported, 7);
    assert.strictEqual(stub2.calls.length, 3, 'walked three pages: ' + stub2.calls.length);
    assert.match(stub2.calls[1].url, /until=\d+/);
    assert.match(stub2.calls[0].url, /max=3/);
    const untilParam = Number(new URL(stub2.calls[1].url).searchParams.get('until'));
    assert.strictEqual(untilParam, many[2].ts - 1, 'until = oldest game of the previous page - 1');
    archive.close(); archive2.close();
  });

  await test('importChesscom: archives listing -> monthly JSON, newest first, duplicates skipped, nextSince from end_time', async () => {
    const months = {
      '2025/02': [chesscomGame(1001, { endTime: 1739880000 }), chesscomGame(1002, { endTime: 1739966400, result: '1-0' })],
      '2025/03': [chesscomGame(1003, { endTime: 1741630925 })]
    };
    const archive = GameArchive.createGameArchive({ dbPath: path.join(TMP, 'cc.db') });
    const fetchImpl = makeStubFetch(CHESSCOM_ROUTES(months));
    const r = await ImportExternal.importChesscom({ username: 'Carol', ownerId: 'acct-2', archive, fetchImpl, sleepImpl: async () => {} });
    assert.deepStrictEqual({ imported: r.imported, skipped: r.skipped, total: r.total }, { imported: 3, skipped: 0, total: 3 });
    assert.strictEqual(r.nextSince, 1741630925 * 1000 + 1);
    assert.strictEqual(fetchImpl.calls[0].url, 'https://api.chess.com/pub/player/carol/games/archives');
    assert.match(fetchImpl.calls[1].url, /\/games\/2025\/03$/, 'newest month first');
    assert.match(fetchImpl.calls[2].url, /\/games\/2025\/02$/);
    const rows = archive.listGames({ owner: 'acct-2', source: 'chesscom' });
    assert.deepStrictEqual(rows.map(g => g.external_id).sort(), ['https://www.chess.com/game/live/1001', 'https://www.chess.com/game/live/1002', 'https://www.chess.com/game/live/1003']);
    assert.strictEqual(rows.find(g => g.external_id.endsWith('1002')).result, '1-0');
    assert.strictEqual(rows[0].eco, 'B20');
    assert.deepStrictEqual(GameArchive.parsePgn(rows[0].pgn).moves.slice(0, 3), ['e4', 'c5', 'Nf3'], 'clock comments stripped by parsePgn');
    const r2 = await ImportExternal.importChesscom({ username: 'carol', ownerId: 'acct-2', archive, fetchImpl, sleepImpl: async () => {} });
    assert.deepStrictEqual({ imported: r2.imported, skipped: r2.skipped }, { imported: 0, skipped: 3 });
    // incremental: since after Feb -> only March fetched, nothing new
    const before = fetchImpl.calls.length;
    const r3 = await ImportExternal.importChesscom({ username: 'carol', ownerId: 'acct-2', archive, fetchImpl, since: 1741000000 * 1000, sleepImpl: async () => {} });
    assert.strictEqual(r3.total, 1);
    assert.strictEqual(fetchImpl.calls.length - before, 2, 'archives + March only (Feb skipped by since)');
    archive.close();
  });

  await test('429 backoff: retries with injected sleep, then succeeds; gives up after MAX retries', async () => {
    const archive = GameArchive.createGameArchive({ dbPath: path.join(TMP, 'li-429.db') });
    const sleeps = [];
    const fetchImpl = makeStubFetch(LICHESS_ROUTES(lichessGames), { rateLimit429: 2 });
    const r = await ImportExternal.importLichess({ username: 'alice', ownerId: 'a', archive, fetchImpl, sleepImpl: async ms => { sleeps.push(ms); }, backoffMs: 10 });
    assert.strictEqual(r.imported, 3);
    assert.strictEqual(sleeps.length, 2, 'slept once per 429');
    assert.strictEqual(fetchImpl.calls.length, 3);
    const forever = makeStubFetch(LICHESS_ROUTES(lichessGames), { rateLimit429: 99 });
    await assert.rejects(
      ImportExternal.importLichess({ username: 'alice', ownerId: 'a', archive, fetchImpl: forever, sleepImpl: async () => {}, backoffMs: 1 }),
      err => err instanceof ImportExternal.ImportError && err.status === 429
    );
    archive.close();
  });

  await test('importer errors: unknown user -> 404 ImportError, invalid username -> 400, missing owner -> 401', async () => {
    const archive = GameArchive.createGameArchive({ dbPath: path.join(TMP, 'li-err.db') });
    const fetchImpl = makeStubFetch(LICHESS_ROUTES([]));
    await assert.rejects(ImportExternal.importLichess({ username: 'nobody', ownerId: 'a', archive, fetchImpl }), e => e.status === 404 && /not found/.test(e.message));
    await assert.rejects(ImportExternal.importLichess({ username: 'bad name!', ownerId: 'a', archive, fetchImpl }), e => e.status === 400);
    await assert.rejects(ImportExternal.importLichess({ username: 'alice', archive, fetchImpl }), e => e.status === 401);
    const cc = makeStubFetch(CHESSCOM_ROUTES({}));
    await assert.rejects(ImportExternal.importChesscom({ username: 'nobody', ownerId: 'a', archive, fetchImpl: cc }), e => e.status === 404);
    assert.strictEqual(fetchImpl.calls.length, 1, 'no network call for rejected inputs');
    archive.close();
  });

  // ------------------------------------------------------------ 3. routes
  const serverModule = require('../server.js');
  const server = serverModule.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const suffix = Date.now().toString(36);
  const months = { '2025/03': [chesscomGame(2001, { endTime: 1741630925 }), chesscomGame(2002, { endTime: 1741700000, result: '1-0' })] };
  LibraryRoutes.setTestHooks({
    fetchImpl: makeStubFetch([...LICHESS_ROUTES(lichessGames), ...CHESSCOM_ROUTES(months)]),
    sleepImpl: async () => {},
    backoffMs: 1
  });

  try {
    const guestRoom = 'game-guest' + suffix;
    let guestGameId = null;

    await test('POST /api/games (guest, ?room=) stores an unowned local game bound to the room; client owner fields are ignored', async () => {
      const res = await request(server, { path: `/api/games?room=${guestRoom}`, method: 'POST' },
        { white: 'White', black: 'Black', result: '1-0', moves: ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6', 'h5f7'], pgn: '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0', owner_id: 'attacker', source: 'lichess', external_id: 'x' });
      assert.strictEqual(res.status, 201, res.raw);
      guestGameId = res.body.id;
      const row = serverModule.gameArchive.getGame(guestGameId);
      assert.strictEqual(row.owner_id, null);
      assert.strictEqual(row.source, 'local');
      assert.strictEqual(row.external_id, null);
      assert.strictEqual(row.room_id, guestRoom);
    });

    await test('POST /api/games with only pgn (Library paste) is tagged source=pgn', async () => {
      const res = await request(server, { path: '/api/games', method: 'POST' }, { pgn: '[White "Paste"]\n[Black "Test"]\n[Result "*"]\n\n1. d4 d5 2. c4 *' });
      assert.strictEqual(res.status, 201, res.raw);
      const row = serverModule.gameArchive.getGame(res.body.id);
      assert.strictEqual(row.source, 'pgn');
      assert.strictEqual(row.room_id, null);
    });

    await test('GET /api/library as guest lists unowned games only (no 401)', async () => {
      const res = await request(server, { path: '/api/library' });
      assert.strictEqual(res.status, 200, res.raw);
      assert.strictEqual(res.body.owner, 'guest');
      assert(res.body.games.some(g => g.id === guestGameId));
      assert(res.body.games.every(g => g.owned === false));
      const row = res.body.games.find(g => g.id === guestGameId);
      assert.strictEqual(row.plies, 7);
      assert.strictEqual(row.source, 'local');
      assert.strictEqual(row.roomId, guestRoom);
      assert.strictEqual(typeof res.body.total, 'number');
      const bad = await request(server, { path: '/api/library?source=bogus' });
      assert.strictEqual(bad.status, 400);
    });

    await test('auth-only routes return 401 for guests', async () => {
      for (const [method, p, body] of [['POST', '/api/import/lichess', { username: 'alice' }], ['POST', '/api/import/chesscom', { username: 'carol' }], ['GET', '/api/import/status'], ['POST', '/api/library/claim', { roomIds: [guestRoom] }]]) {
        const res = await request(server, { path: p, method }, body);
        assert.strictEqual(res.status, 401, method + ' ' + p + ' -> ' + res.status);
      }
      const unknown = await request(server, { path: '/api/import/fics', method: 'POST' }, { username: 'x' });
      assert.strictEqual(unknown.status, 404, 'unknown import source');
    });

    const alice = await register(server, 'alice_' + suffix);
    const bob = await register(server, 'bob_' + suffix);

    await test('signed-in POST /api/games binds owner_id from the session (never from the body)', async () => {
      const res = await request(server, { path: '/api/games', method: 'POST', token: alice.token }, { white: 'W', black: 'B', result: '*', moves: ['g1f3'], pgn: '1. Nf3 *', owner_id: bob.id });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(serverModule.gameArchive.getGame(res.body.id).owner_id, String(alice.id));
    });

    await test('POST /api/import/lichess imports for the signed-in account; status recorded; re-run incremental', async () => {
      const res = await request(server, { path: '/api/import/lichess', method: 'POST', token: alice.token }, { username: 'alice' });
      assert.strictEqual(res.status, 200, res.raw);
      assert.strictEqual(res.body.imported, 3);
      assert.strictEqual(res.body.skipped, 0);
      assert.strictEqual(res.body.total, 3);
      assert.strictEqual(res.body.nextSince, T0 + 1);
      const status = await request(server, { path: '/api/import/status', token: alice.token });
      assert.strictEqual(status.status, 200);
      const li = status.body.imports.find(i => i.source === 'lichess');
      assert.strictEqual(li.imported, 3);
      assert.strictEqual(li.username, 'alice');
      assert.strictEqual(li.nextSince, T0 + 1);
      assert.strictEqual(status.body.running, null);
      // incremental re-run resumes from nextSince: the stub has nothing newer
      const again = await request(server, { path: '/api/import/lichess', method: 'POST', token: alice.token }, { username: 'alice' });
      assert.strictEqual(again.status, 200, again.raw);
      assert.strictEqual(again.body.total, 0);
      // full re-scan skips duplicates
      const full = await request(server, { path: '/api/import/lichess', method: 'POST', token: alice.token }, { username: 'alice', full: true });
      assert.deepStrictEqual({ imported: full.body.imported, skipped: full.body.skipped }, { imported: 0, skipped: 3 });
    });

    await test('POST /api/import/chesscom imports; unknown user -> 404; bad username -> 400', async () => {
      const res = await request(server, { path: '/api/import/chesscom', method: 'POST', token: alice.token }, { username: 'carol', max: 10 });
      assert.strictEqual(res.status, 200, res.raw);
      assert.strictEqual(res.body.imported, 2);
      const nf = await request(server, { path: '/api/import/chesscom', method: 'POST', token: alice.token }, { username: 'nobody' });
      assert.strictEqual(nf.status, 404);
      assert.match(nf.body.error, /not found/);
      const bad = await request(server, { path: '/api/import/lichess', method: 'POST', token: alice.token }, { username: 'no spaces allowed' });
      assert.strictEqual(bad.status, 400);
      const status = await request(server, { path: '/api/import/status', token: alice.token });
      assert.deepStrictEqual(status.body.imports.map(i => i.source).sort(), ['chesscom', 'lichess']);
    });

    await test('GET /api/library for a signed-in user: own games only, source filter, search, pagination', async () => {
      const all = await request(server, { path: '/api/library?owner=me&pageSize=50', token: alice.token });
      assert.strictEqual(all.status, 200);
      assert.strictEqual(all.body.owner, 'me');
      assert.strictEqual(all.body.total, 6, '1 local + 3 lichess + 2 chesscom');
      assert(all.body.games.every(g => g.owned === true));
      assert(!all.body.games.some(g => g.id === guestGameId), 'guest game not visible to alice');
      const li = await request(server, { path: '/api/library?source=lichess', token: alice.token });
      assert.strictEqual(li.body.games.length, 3);
      assert(li.body.games.every(g => g.source === 'lichess' && /^https:\/\/lichess\.org\/[A-Za-z0-9]{8}$/.test(g.externalUrl)));
      assert.strictEqual(li.body.games[0].opening, 'Italian Game');
      assert.strictEqual(li.body.games[0].eco, 'C50');
      const cc = await request(server, { path: '/api/library?source=chesscom', token: alice.token });
      assert.strictEqual(cc.body.games.length, 2);
      assert.match(cc.body.games[0].externalUrl, /chess\.com\/game\/live/);
      const q = await request(server, { path: '/api/library?q=carol', token: alice.token });
      assert.strictEqual(q.body.games.length, 2);
      const p1 = await request(server, { path: '/api/library?pageSize=4&page=1', token: alice.token });
      const p2 = await request(server, { path: '/api/library?pageSize=4&page=2', token: alice.token });
      assert.strictEqual(p1.body.games.length, 4);
      assert.strictEqual(p1.body.hasMore, true);
      assert.strictEqual(p2.body.games.length, 2);
      assert.strictEqual(p2.body.hasMore, false);
      const bobList = await request(server, { path: '/api/library', token: bob.token });
      assert.strictEqual(bobList.body.total, 0, 'bob sees none of alice\'s games');
      const asGuest = await request(server, { path: '/api/library?owner=guest', token: alice.token });
      assert.strictEqual(asGuest.body.owner, 'guest');
      assert(asGuest.body.games.some(g => g.id === guestGameId));
    });

    await test('POST /api/library/claim binds the guest room games to the account; bogus/owned rooms ignored', async () => {
      const res = await request(server, { path: '/api/library/claim', method: 'POST', token: bob.token }, { roomIds: [guestRoom, 'not a room id', 'game-unknown'] });
      assert.strictEqual(res.status, 200, res.raw);
      assert.deepStrictEqual(res.body.claimed, [guestGameId]);
      assert.strictEqual(serverModule.gameArchive.getGame(guestGameId).owner_id, String(bob.id));
      const again = await request(server, { path: '/api/library/claim', method: 'POST', token: alice.token }, { roomIds: [guestRoom] });
      assert.strictEqual(again.body.count, 0, 'already-claimed games cannot be taken by another account');
      const bobList = await request(server, { path: '/api/library', token: bob.token });
      assert.strictEqual(bobList.body.total, 1);
      const guestList = await request(server, { path: '/api/library' });
      assert(!guestList.body.games.some(g => g.id === guestGameId), 'claimed game left the guest library');
      const empty = await request(server, { path: '/api/library/claim', method: 'POST', token: bob.token }, {});
      assert.strictEqual(empty.status, 400);
    });

    await test('GET /api/games/:id for an imported (SAN) game still ships referee-built positions', async () => {
      const li = await request(server, { path: '/api/library?source=lichess', token: alice.token });
      const id = li.body.games[0].id;
      // B25: archived games are requester-scoped — an owned game is readable
      // only by its owner, so this fetch carries alice's token (previously it
      // was anonymous and only passed because the by-id read was unscoped).
      const res = await request(server, { path: '/api/games/' + encodeURIComponent(id), token: alice.token });
      assert.strictEqual(res.status, 200);
      assert(Array.isArray(res.body.game.positions) && res.body.game.positions.length === 16, 'positions for 15 plies + start');
      assert.strictEqual(res.body.game.positions[1].san, 'e4');
      const pgn = await request(server, { path: '/api/games/' + encodeURIComponent(id) + '/pgn', token: alice.token });
      assert.strictEqual(pgn.status, 200);
      assert.match(pgn.raw, /\[Site "https:\/\/lichess\.org\//);
    });
  } finally {
    LibraryRoutes.resetLibraryState();
    server.close();
    try { serverModule.stopStateWatcher && serverModule.stopStateWatcher(); } catch (_) {}
  }

  console.log(`\nAll ${passed} Wave 3 library tests passed.`);
}

run().then(() => { cleanup(); process.exit(0); }).catch(err => {
  console.error('\nFAIL:', err && err.stack ? err.stack : err);
  cleanup();
  process.exit(1);
});
