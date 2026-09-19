#!/usr/bin/env node
'use strict';

/**
 * wave3-insights-selftest.js — Wave 3 (N2.8 leagues + N3.15 Insights).
 *
 * Unit: league weeks / enrol / points / standings / closeWeek promotion math
 * with fixed weeks; computeInsights on a synthetic game set.
 * Routes: guest 401, catalogue, signed-in insights payload shape, league after
 * a rated human game driven through the lobby, admin close-week gating.
 *
 * Every DB/state artifact lives under os.tmpdir(); env vars are set BEFORE
 * server.js is required. The engine is never touched (no compute=1).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-wave3-insights-'));
process.env.CHESS_STATE_FILE = path.join(TMP, '.referee-state.json');
process.env.CHESS_JOURNAL_FILE = path.join(TMP, '.referee-journal.jsonl');
process.env.CHESS_DB_FILE = path.join(TMP, 'games.db');
process.env.CHESS_ACCOUNTS_DB_FILE = path.join(TMP, 'accounts.db');
process.env.CHESS_SOCIAL_DB_PATH = path.join(TMP, 'social.db');
process.env.CHESS_SOCIAL_JSON_PATH = path.join(TMP, '.social.json');
process.env.CHESS_LEAGUES_DB_PATH = path.join(TMP, 'leagues.db');
process.env.CHESS_LEAGUES_JSON_PATH = path.join(TMP, '.leagues.json');
process.env.CHESS_RATE_LIMIT_FILE = path.join(TMP, 'rate-limit.json');
process.env.CHESS_RATE_LIMIT = '100000';
delete process.env.CHESS_ADMIN_TOKEN;

const Leagues = require('../src/leagues.js');
const LeaguesStore = require('../src/leagues-store.js');
const Insights = require('../src/insights.js');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`PASS: ${name}`);
}

function request(server, options, bodyData) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const headers = Object.assign({}, options.headers || {});
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.seat) headers['X-Seat-Token'] = options.seat;
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

const W = '2026-W30'; // fixed past week (Mon 2026-07-20 .. Sun 2026-07-26)

async function unitTests() {
  await test('ISO weeks are UTC Monday-based and round-trip', async () => {
    assert.strictEqual(Leagues.weekOf(Date.UTC(2026, 8, 19)), '2026-W38');
    assert.strictEqual(Leagues.weekOf(Date.UTC(2024, 0, 1)), '2024-W01');
    assert.strictEqual(Leagues.weekOf(Date.UTC(2021, 0, 3)), '2020-W53', 'Sunday 3 Jan 2021 is still ISO 2020-W53');
    assert.strictEqual(new Date(Leagues.weekStartMs('2026-W30')).toISOString(), '2026-07-20T00:00:00.000Z');
    assert.strictEqual(Leagues.weekEndMs('2026-W30') - Leagues.weekStartMs('2026-W30'), 7 * 86400000);
    assert.strictEqual(Leagues.nextWeek('2020-W53'), '2021-W01');
    assert.strictEqual(Leagues.isValidWeek('2021-W53'), false);
    assert.strictEqual(Leagues.isValidWeek('2020-W53'), true);
    assert.strictEqual(Leagues.weekOf(Leagues.weekEndMs('2026-W30') - 1), '2026-W30', 'Sunday 23:59:59.999 UTC is still the same week');
    assert.strictEqual(Leagues.weekOf(Leagues.weekEndMs('2026-W30')), '2026-W31');
  });

  await test('enrol: first rated result auto-enrols into Wood; explicit enroll is idempotent', async () => {
    const lg = Leagues.createLeague(LeaguesStore.createMemoryStore(), { now: () => Date.UTC(2026, 6, 22) });
    assert.strictEqual(lg.standings('alice', W), null, 'not enrolled yet');
    const m = lg.recordResult('alice', 'win', W, { username: 'Alice' });
    assert.strictEqual(m.divisionId, `${W}:Wood:1`);
    assert.strictEqual(m.points, 1);
    const again = lg.enroll('alice', W);
    assert.strictEqual(again.points, 1, 'enroll after a result keeps points');
    assert.strictEqual(lg.enroll('alice', W).divisionId, m.divisionId);
    assert.throws(() => lg.recordResult('alice', 'nonsense', W), /win \| draw \| loss/);
    assert.throws(() => lg.enroll('bob', '2026-W99'), /invalid week/);
  });

  await test('points: win 1, draw 0.5, loss 0; standings sort points > wins > fewer games', async () => {
    const lg = Leagues.createLeague(LeaguesStore.createMemoryStore(), { now: () => Date.UTC(2026, 6, 22) });
    lg.recordResult('a', 'win', W); lg.recordResult('a', 'loss', W);        // 1 pt, 1 win, 2 games
    lg.recordResult('b', 'draw', W); lg.recordResult('b', 'draw', W);        // 1 pt, 0 wins
    lg.recordResult('c', 'win', W);                                          // 1 pt, 1 win, 1 game
    lg.recordResult('d', 'loss', W);                                         // 0 pt
    lg.recordResult('e', 'win', W); lg.recordResult('e', 'draw', W);         // 1.5 pt
    const st = lg.standings('a', W);
    assert.deepStrictEqual(st.rows.map(r => r.playerId), ['e', 'c', 'a', 'b', 'd']);
    assert.strictEqual(st.rows[0].points, 1.5);
    assert.strictEqual(st.rows[3].points, 1);
    assert.strictEqual(st.rows[4].points, 0);
    assert.strictEqual(st.me.rank, 3);
    assert.strictEqual(st.size, 5);
    assert.strictEqual(st.tier, 'Wood');
    assert.strictEqual(st.nextTier, 'Stone');
    assert.strictEqual(st.weekEndsAt, Leagues.weekEndMs(W));
    // 5 players -> ceil(20%) = 1 promotes
    assert.strictEqual(st.promoteCount, 1);
    assert.deepStrictEqual(st.rows.map(r => r.promotes), [true, false, false, false, false]);
    // standings by division id works too
    assert.strictEqual(lg.standings(`${W}:Wood:1`, W).size, 5);
  });

  await test('divisions cap at 50 and overflow into :2', async () => {
    const lg = Leagues.createLeague(LeaguesStore.createMemoryStore(), { now: () => Date.UTC(2026, 6, 22) });
    for (let i = 0; i < 60; i++) lg.enroll('p' + String(i).padStart(2, '0'), W);
    assert.strictEqual(lg.standings('p00', W).divisionId, `${W}:Wood:1`);
    assert.strictEqual(lg.standings('p00', W).size, 50);
    assert.strictEqual(lg.standings('p59', W).divisionId, `${W}:Wood:2`);
    assert.strictEqual(lg.standings('p59', W).size, 10);
    assert.strictEqual(Leagues.promoteCount(50), 10);
    assert.strictEqual(Leagues.promoteCount(10), 2);
    assert.strictEqual(Leagues.promoteCount(1), 1);
  });

  await test('closeWeek: top 20% with points promote, nobody relegates, idempotent, fires onPromotion', async () => {
    const lg = Leagues.createLeague(LeaguesStore.createMemoryStore(), { now: () => Date.UTC(2026, 6, 29) }); // after W30 ended
    const promos = [];
    lg.onPromotion((p, from, to) => promos.push([p, from, to]));
    for (let i = 0; i < 10; i++) lg.recordResult('p' + i, i < 3 ? 'win' : 'loss', W);
    const summary = lg.closeWeek(W);
    assert.strictEqual(summary.week, W);
    assert.strictEqual(summary.divisions, 1);
    assert.strictEqual(summary.promoted.length, 2, 'ceil(10 * 0.2) = 2');
    assert.deepStrictEqual(summary.promoted.map(p => p.toTier), ['Stone', 'Stone']);
    assert.deepStrictEqual(promos, [['p0', 'Wood', 'Stone'], ['p1', 'Wood', 'Stone']]);
    assert.strictEqual(lg.playerTier('p0'), 'Stone');
    assert.strictEqual(lg.playerTier('p2'), 'Wood', 'third winner just misses the cut');
    assert.strictEqual(lg.playerTier('p9'), 'Wood', 'no relegation below Wood and no demotion');
    const again = lg.closeWeek(W);
    assert.strictEqual(again.alreadyClosed, true);
    assert.strictEqual(promos.length, 2, 'second close fires nothing');
    assert.strictEqual(lg.standings('p0', W).closed, true);
    assert.throws(() => lg.recordResult('p0', 'win', W), /closed/);
    // next week: fresh divisions, promoted player lands in a Stone division
    const next = Leagues.nextWeek(W);
    assert.strictEqual(lg.enroll('p0', next).divisionId, `${next}:Stone:1`);
    assert.strictEqual(lg.enroll('p9', next).divisionId, `${next}:Wood:1`);
  });

  await test('closeWeek refuses the current/future week unless forced; zero-point divisions promote nobody', async () => {
    const lg = Leagues.createLeague(LeaguesStore.createMemoryStore(), { now: () => Date.UTC(2026, 6, 22) }); // inside W30
    lg.recordResult('x', 'loss', W);
    assert.throws(() => lg.closeWeek(W), /not ended/);
    const forced = lg.closeWeek(W, { force: true });
    assert.strictEqual(forced.promoted.length, 0, 'a division with 0 points promotes nobody');
    // Legend is the ceiling
    const store = LeaguesStore.createMemoryStore();
    store.savePlayerTier('champ', 'Legend', null);
    const lg2 = Leagues.createLeague(store, { now: () => Date.UTC(2026, 6, 29) });
    lg2.recordResult('champ', 'win', W);
    assert.strictEqual(lg2.standings('champ', W).nextTier, null);
    assert.strictEqual(lg2.standings('champ', W).promoteCount, 0);
    assert.strictEqual(lg2.closeWeek(W).promoted.length, 0);
    assert.strictEqual(lg2.playerTier('champ'), 'Legend');
  });

  await test('autoClose closes every finished open week and skips the current one', async () => {
    const lg = Leagues.createLeague(LeaguesStore.createMemoryStore(), { now: () => Date.UTC(2026, 7, 5) }); // inside W32
    lg.recordResult('a', 'win', '2026-W30');
    lg.recordResult('a', 'win', '2026-W31');
    lg.recordResult('a', 'win', '2026-W32');
    const closed = lg.autoClose();
    assert.deepStrictEqual(closed.map(s => s.week), ['2026-W30', '2026-W31']);
    // both divisions were Wood (W31 was joined before W30 closed), so the tier rises once
    assert.strictEqual(lg.playerTier('a'), 'Stone');
    assert.strictEqual(closed[1].promoted[0].fromTier, 'Wood');
    assert.strictEqual(lg.standings('a', '2026-W32').closed, false);
    assert.strictEqual(lg.autoClose().length, 0);
  });

  await test('onRatedGame adapter: rated events score both sides, unrated events are ignored', async () => {
    const lg = Leagues.createLeague(LeaguesStore.createMemoryStore());
    const at = Date.UTC(2026, 6, 22);
    const ev = { rated: true, result: '1-0', at, white: { accountId: 'w', username: 'W' }, black: { accountId: 'b', username: 'B' } };
    const out = lg.onRatedGame(ev);
    assert.strictEqual(out.week, W);
    assert.strictEqual(out.white.points, 1);
    assert.strictEqual(out.black.points, 0);
    assert.strictEqual(lg.onRatedGame(Object.assign({}, ev, { rated: false })), null);
    assert.strictEqual(lg.onRatedGame(Object.assign({}, ev, { result: '½-½' })).black.points, 0.5);
    assert.strictEqual(lg.standings('w', W).rows[0].username, 'W');
  });

  await test('leagues-store: sqlite adapter persists across instances', async () => {
    const dbPath = path.join(TMP, 'unit-leagues.db');
    const s1 = LeaguesStore.createLeaguesStore({ dbPath, jsonPath: path.join(TMP, 'unit-leagues.json') });
    const lg1 = Leagues.createLeague(s1, { now: () => Date.UTC(2026, 6, 22) });
    lg1.recordResult('persist', 'win', W, { username: 'Persist' });
    s1.close();
    const s2 = LeaguesStore.createLeaguesStore({ dbPath, jsonPath: path.join(TMP, 'unit-leagues.json') });
    const lg2 = Leagues.createLeague(s2, { now: () => Date.UTC(2026, 6, 22) });
    const st = lg2.standings('persist', W);
    assert.ok(st && st.me.points === 1 && st.me.username === 'Persist');
    assert.deepStrictEqual(s2.listOpenWeeks(), [W]);
    s2.close();
  });

  // ------------------------------------------------------------ insights
  const synthetic = [
    { id: 'g1', white: 'alice', black: 'Stockfish L3', result: '1-0', eco: 'C20', pgn: '[Event "x"]\n[TimeControl "600+15"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0', moves: 'e2e4 e7e5 d1h5 b8c6 f1c4 g8f6 h5f7', created_at: Date.UTC(2026, 8, 15, 14) },
    { id: 'g2', white: 'bob', black: 'alice', result: '1/2-1/2', eco: 'B20', pgn: '[Event "x"]\n\n1. e4 c5 1/2-1/2', moves: 'e2e4 c7c5', created_at: Date.UTC(2026, 8, 16, 20), evals: [20, 30, 25] },
    { id: 'g3', white: 'alice', black: 'bob', result: '0-1', eco: 'D00', pgn: '[Event "x"]\n[TimeControl "180+2"]\n\n1. d4 d5 2. c4 0-1', moves: 'd2d4 d7d5 c2c4', created_at: Date.UTC(2026, 8, 17, 9), evals: [15, 10, 20, -50] },
    { id: 'g4', white: 'White', black: 'Black', result: '1-0', eco: '', pgn: '1. e4 1-0', moves: 'e2e4', created_at: Date.UTC(2026, 8, 13, 9) }
  ];
  const ctx = { username: 'alice' };

  await test('insights: results x colour from the player\'s side, unknown side falls back to White', async () => {
    const r = Insights.computeInsights(synthetic, { metric: 'results', dimension: 'colour', ctx });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.games, 4);
    assert.strictEqual(r.unknownColour, 1);
    assert.strictEqual(r.perspective, 'mixed');
    const by = Object.fromEntries(r.buckets.map(b => [b.key, b]));
    assert.deepStrictEqual([by.white.wins, by.white.losses, by.white.winPct], [1, 1, 50]);
    assert.deepStrictEqual([by.black.draws, by.black.drawPct, by.black.score], [1, 100, 50]);
    assert.strictEqual(by.unknown.wins, 1, 'White-perspective for unbound games');
    assert.deepStrictEqual(r.buckets.map(b => b.key), ['white', 'black', 'unknown'], 'ordinal bucket order');
  });

  await test('insights: acpl x phase uses acpl.js phase split and reports eval coverage', async () => {
    const r = Insights.computeInsights(synthetic, { metric: 'acpl', dimension: 'phase', ctx });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.coverage, { gamesWithEvals: 2, gamesTotal: 4 });
    assert.deepStrictEqual(r.buckets.map(b => b.key), ['opening', 'middlegame', 'endgame']);
    // g2: alice black, loss on ply 2 (black): after-before = 25-30 -> 0 loss; ply1 white. black acpl 0.
    // g3: alice white; white plies: 15->10 (5), 20->-50 (70) => 37.5
    assert.strictEqual(r.buckets[0].count, 2);
    assert.strictEqual(r.buckets[0].value, 18.8);
    assert.strictEqual(r.buckets[1].count, 0);
    assert.strictEqual(r.buckets[1].value, null);
    const overall = Insights.computeInsights(synthetic, { metric: 'acpl', dimension: 'colour', ctx });
    assert.strictEqual(overall.buckets.find(b => b.key === 'white').value, 37.5);
    assert.strictEqual(overall.buckets.find(b => b.key === 'black').value, 0);
  });

  await test('insights: length x method + opening/timeControl/weekday/hour dimensions', async () => {
    const r = Insights.computeInsights(synthetic, { metric: 'length', dimension: 'method', ctx });
    const by = Object.fromEntries(r.buckets.map(b => [b.key, b]));
    assert.strictEqual(by.mate.value, 7, 'Qxf7# is detected as mate');
    assert.strictEqual(by.draw.count, 1);
    assert.strictEqual(by.other.count, 2, 'resign vs flag is indistinguishable without a Termination tag');
    const op = Insights.computeInsights(synthetic, { metric: 'results', dimension: 'opening', ctx });
    assert.ok(op.buckets.some(b => b.key === 'C20' && /Open Game|C20/.test(b.label)));
    assert.ok(op.buckets.some(b => b.key === 'unknown'));
    const tc = Insights.computeInsights(synthetic, { metric: 'results', dimension: 'timeControl', ctx });
    assert.deepStrictEqual(tc.buckets.map(b => b.key).sort(), ['180+2', '600+15', 'unknown']);
    const wd = Insights.computeInsights(synthetic, { metric: 'results', dimension: 'weekday', ctx });
    assert.deepStrictEqual(wd.buckets.map(b => b.key), ['Sun', 'Tue', 'Wed', 'Thu']);
    const hr = Insights.computeInsights(synthetic, { metric: 'length', dimension: 'hour', ctx });
    assert.deepStrictEqual(hr.buckets.map(b => b.key), ['09', '14', '20']);
    assert.strictEqual(hr.buckets[0].count, 2);
  });

  await test('insights: filters (date range, colour, tc, opponent) and unavailable metrics', async () => {
    const bot = Insights.computeInsights(synthetic, { metric: 'results', dimension: 'all', filters: { opponent: 'bot' }, ctx });
    assert.strictEqual(bot.games, 1);
    assert.strictEqual(bot.buckets[0].wins, 1);
    const human = Insights.computeInsights(synthetic, { metric: 'results', dimension: 'all', filters: { opponent: 'human' }, ctx });
    assert.strictEqual(human.games, 2);
    const black = Insights.computeInsights(synthetic, { metric: 'results', dimension: 'all', filters: { color: 'black' }, ctx });
    assert.strictEqual(black.games, 1);
    const tc = Insights.computeInsights(synthetic, { metric: 'results', dimension: 'all', filters: { tc: '180+2' }, ctx });
    assert.strictEqual(tc.games, 1);
    const range = Insights.computeInsights(synthetic, { metric: 'results', dimension: 'all', filters: { from: '2026-09-16', to: '2026-09-17' }, ctx });
    assert.strictEqual(range.games, 2);
    const mt = Insights.computeInsights(synthetic, { metric: 'moveTime', dimension: 'all' });
    assert.strictEqual(mt.ok, false);
    assert.strictEqual(mt.available, false);
    const rg = Insights.computeInsights(synthetic, { metric: 'ratingGain', dimension: 'all' });
    assert.strictEqual(rg.available, false);
    const bad = Insights.computeInsights(synthetic, { metric: 'results', dimension: 'phase' });
    assert.strictEqual(bad.ok, false, 'phase only applies to acpl');
    const cat = Insights.catalogue();
    assert.ok(cat.metrics.find(m => m.id === 'moveTime').available === false);
    assert.ok(cat.metrics.find(m => m.id === 'acpl').dimensions.includes('phase'));
    assert.strictEqual(cat.dimensions.length, 8);
  });

  await test('insights: loadGames falls back to scope archive, honours selectGames/owner_id', async () => {
    const fakeArchive = { listGames: () => synthetic.slice(0, 2), getEval: () => null };
    const a = Insights.loadGames({ archive: fakeArchive, playerId: 'u1', username: 'alice' });
    assert.strictEqual(a.scope, 'archive');
    assert.strictEqual(a.total, 2);
    assert.strictEqual(a.games[0].color, 'white', 'username match binds the side');
    const owned = { listGames: () => synthetic.map((g, i) => Object.assign({}, g, { owner_id: i % 2 ? 'u1' : 'u2' })) };
    const b = Insights.loadGames({ archive: owned, playerId: 'u1' });
    assert.strictEqual(b.scope, 'player');
    assert.strictEqual(b.total, 2);
    const c = Insights.loadGames({ selectGames: () => [synthetic[3]], playerId: 'u1' });
    assert.strictEqual(c.scope, 'player');
    assert.strictEqual(c.total, 1);
    // eval cache glue: evals attach only when every position is cached
    const cache = new Map();
    const fens = Insights.fensFor(a.games[1]);
    fens.forEach((f, i) => cache.set(f.split(' ').slice(0, 4).join(' '), { cp: i * 10 }));
    const cachedArchive = { listGames: () => [synthetic[1]], getEval: (fen) => cache.get(fen.split(' ').slice(0, 4).join(' ')) || null };
    const d = Insights.loadGames({ archive: cachedArchive, username: 'alice' });
    assert.deepStrictEqual(d.games[0].evals, [20, 30, 25], 'row-provided evals win');
    const e = Insights.loadGames({ archive: { listGames: () => [Object.assign({}, synthetic[1], { evals: undefined })], getEval: cachedArchive.getEval }, username: 'alice' });
    assert.deepStrictEqual(e.games[0].evals, [0, 10, 20]);
  });
}

async function routeTests() {
  const serverModule = require('../server.js');
  const InsightsRoutes = require('../src/routes-insights.js');
  const SocialRoutes = require('../src/routes-social.js');
  const server = serverModule.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const suffix = Date.now().toString(36);
  try {
    await test('guest: /api/insights and /api/league are 401 with guest:true; catalogue and tiers are public', async () => {
      const ins = await request(server, { path: '/api/insights?metric=results&dimension=colour' });
      assert.strictEqual(ins.status, 401);
      assert.strictEqual(ins.body.guest, true);
      const lg = await request(server, { path: '/api/league' });
      assert.strictEqual(lg.status, 401);
      const cat = await request(server, { path: '/api/insights/dimensions' });
      assert.strictEqual(cat.status, 200);
      assert.ok(Array.isArray(cat.body.metrics) && cat.body.metrics.length === 5);
      assert.ok(Array.isArray(cat.body.filters) && cat.body.filters.some(f => f.id === 'opponent'));
      const tiers = await request(server, { path: '/api/league/tiers' });
      assert.strictEqual(tiers.status, 200);
      assert.deepStrictEqual(tiers.body.tiers, ['Wood', 'Stone', 'Bronze', 'Silver', 'Crystal', 'Elite', 'Champion', 'Legend']);
      assert.strictEqual(tiers.body.divisionSize, 50);
    });

    const alice = await register(server, 'alice_' + suffix);
    const bob = await register(server, 'bob_' + suffix);

    await test('signed in: /api/insights payload shape, scope archive until games bind to accounts', async () => {
      // seed the archive with one finished game (as the client auto-save does)
      const saved = await request(server, { path: '/api/games', method: 'POST' }, { white: 'White', black: 'Black', result: '1-0', moves: ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6', 'h5f7'], pgn: '[Event "Casual Game"]\n[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0' });
      assert.strictEqual(saved.status, 201, saved.raw);
      const res = await request(server, { path: '/api/insights?metric=results&dimension=method', token: alice.token });
      assert.strictEqual(res.status, 200, res.raw);
      const b = res.body;
      assert.strictEqual(b.ok, true);
      assert.strictEqual(b.scope, 'archive');
      assert.strictEqual(b.metric, 'results');
      assert.strictEqual(b.dimension, 'method');
      assert.strictEqual(b.player.id, alice.id);
      assert.ok(b.games >= 1);
      assert.ok(Array.isArray(b.buckets) && b.buckets.some(x => x.key === 'mate' && x.count >= 1));
      assert.ok('unknownColour' in b && 'perspective' in b && 'filters' in b);
      const bad = await request(server, { path: '/api/insights?metric=moveTime', token: alice.token });
      assert.strictEqual(bad.status, 400);
      assert.strictEqual(bad.body.available, false);
      const acpl = await request(server, { path: '/api/insights?metric=acpl&dimension=phase', token: alice.token });
      assert.strictEqual(acpl.status, 200);
      assert.ok(acpl.body.coverage && typeof acpl.body.coverage.gamesWithEvals === 'number');
      assert.strictEqual(acpl.body.compute, undefined, 'no engine work without compute=1');
      const filtered = await request(server, { path: '/api/insights?metric=length&dimension=all&from=2000-01-01&to=2000-01-02', token: alice.token });
      assert.strictEqual(filtered.body.games, 0);
    });

    await test('league: not enrolled before a rated game', async () => {
      const res = await request(server, { path: '/api/league', token: alice.token });
      assert.strictEqual(res.status, 200, res.raw);
      assert.strictEqual(res.body.enrolled, false);
      assert.strictEqual(res.body.standings, null);
      assert.strictEqual(res.body.tier, 'Wood');
      assert.strictEqual(res.body.week, Leagues.weekOf(Date.now()));
      assert.ok(res.body.weekEndsAt > Date.now());
    });

    await test('league: a rated human game (lobby seek/accept + resignation) enrols both players', async () => {
      const seek = await request(server, { path: '/api/lobby/seek', method: 'POST', token: alice.token }, { tc: 'blitz_3_2', ratingRange: 150 });
      assert.strictEqual(seek.status, 201, seek.raw);
      const acc = await request(server, { path: '/api/lobby/accept/' + seek.body.seek.id, method: 'POST', token: bob.token });
      assert.strictEqual(acc.status, 201, acc.raw);
      const roomId = acc.body.roomId;
      const bobSeat = acc.body.seatToken;
      const mine = await request(server, { path: '/api/lobby/mine', token: alice.token });
      const aliceSeat = mine.body.match.seatToken;
      const aliceColor = mine.body.match.color;
      const whiteSeat = aliceColor === 'white' ? aliceSeat : bobSeat;
      const blackSeat = aliceColor === 'white' ? bobSeat : aliceSeat;
      assert.strictEqual((await request(server, { path: '/api/move?room=' + roomId, method: 'POST', seat: whiteSeat }, { move: 'e2e4' })).status, 200);
      assert.strictEqual((await request(server, { path: '/api/move?room=' + roomId, method: 'POST', seat: blackSeat }, { move: 'e7e5' })).status, 200);
      const resign = await request(server, { path: '/api/resign?room=' + roomId, method: 'POST', seat: blackSeat }, { color: 'black' });
      assert.strictEqual(resign.status, 200, resign.raw);
      assert.strictEqual(resign.body.result, '1-0');

      const winner = aliceColor === 'white' ? alice : bob;
      const loser = aliceColor === 'white' ? bob : alice;
      const w = await request(server, { path: '/api/league', token: winner.token });
      assert.strictEqual(w.status, 200, w.raw);
      assert.strictEqual(w.body.enrolled, true);
      assert.strictEqual(w.body.standings.tier, 'Wood');
      assert.strictEqual(w.body.standings.divisionId, `${w.body.week}:Wood:1`);
      assert.strictEqual(w.body.standings.me.points, 1);
      assert.strictEqual(w.body.standings.me.wins, 1);
      assert.strictEqual(w.body.standings.me.rank, 1);
      assert.strictEqual(w.body.standings.me.promotes, true);
      assert.strictEqual(w.body.standings.size, 2);
      const l = await request(server, { path: '/api/league', token: loser.token });
      assert.strictEqual(l.body.standings.me.points, 0);
      assert.strictEqual(l.body.standings.me.losses, 1);
      assert.strictEqual(l.body.standings.me.promotes, false);
      assert.strictEqual(l.body.standings.rows[0].username, winner.username);
    });

    await test('league: bot games do not enrol (rating hook says unrated)', async () => {
      const carol = await register(server, 'carol_' + suffix);
      const botRoom = 'botroom-' + suffix;
      const claim = await request(server, { path: '/api/seat/claim', method: 'POST', token: carol.token }, { role: 'white', room: botRoom });
      assert.strictEqual(claim.status, 200);
      const bot = await request(server, { path: '/api/bot?room=' + botRoom, method: 'POST', seat: claim.body.token }, { enabled: true, level: 1, color: 'black' });
      assert.strictEqual(bot.status, 200, bot.raw);
      assert.strictEqual((await request(server, { path: '/api/move?room=' + botRoom, method: 'POST', seat: claim.body.token }, { move: 'e2e4' })).status, 200);
      const resign = await request(server, { path: '/api/resign?room=' + botRoom, method: 'POST', seat: claim.body.token }, { color: 'white' });
      assert.strictEqual(resign.status, 200, resign.raw);
      const res = await request(server, { path: '/api/league', token: carol.token });
      assert.strictEqual(res.body.enrolled, false);
      await request(server, { path: '/api/bot?room=' + botRoom, method: 'POST', seat: claim.body.token }, { enabled: false });
    });

    await test('admin close-week: 404 without CHESS_ADMIN_TOKEN, 403 wrong token, 200 with it', async () => {
      const off = await request(server, { path: '/api/league/close-week', method: 'POST', token: alice.token }, { week: '2026-W30' });
      assert.strictEqual(off.status, 404);
      process.env.CHESS_ADMIN_TOKEN = 'secret-' + suffix;
      try {
        const wrong = await request(server, { path: '/api/league/close-week', method: 'POST', headers: { 'X-Admin-Token': 'nope' } }, { week: '2026-W30' });
        assert.strictEqual(wrong.status, 403);
        const current = await request(server, { path: '/api/league/close-week', method: 'POST', headers: { 'X-Admin-Token': process.env.CHESS_ADMIN_TOKEN } }, { week: Leagues.weekOf(Date.now()) });
        assert.strictEqual(current.status, 409, 'current week cannot be closed: ' + current.raw);
        // seed a past week through the promotion feed, then close it
        const promos = [];
        const off2 = InsightsRoutes.onPromotion((p, f, t) => promos.push([p, f, t]));
        InsightsRoutes.onRatedGame({ rated: true, result: '0-1', at: Date.UTC(2026, 6, 22), white: { accountId: alice.id, username: alice.username }, black: { accountId: bob.id, username: bob.username } });
        const ok = await request(server, { path: '/api/league/close-week', method: 'POST', headers: { 'X-Admin-Token': process.env.CHESS_ADMIN_TOKEN } }, { week: '2026-W30' });
        assert.strictEqual(ok.status, 200, ok.raw);
        assert.strictEqual(ok.body.week, '2026-W30');
        assert.strictEqual(ok.body.promoted.length, 1);
        assert.strictEqual(ok.body.promoted[0].playerId, bob.id);
        assert.deepStrictEqual(promos, [[bob.id, 'Wood', 'Stone']]);
        off2();
        const again = await request(server, { path: '/api/league/close-week', method: 'POST', headers: { 'X-Admin-Token': process.env.CHESS_ADMIN_TOKEN } }, { week: '2026-W30' });
        assert.strictEqual(again.body.alreadyClosed, true);
        const bobNow = await request(server, { path: '/api/league', token: bob.token });
        assert.strictEqual(bobNow.body.tier, 'Stone');
        const past = await request(server, { path: '/api/league?week=2026-W30', token: bob.token });
        assert.strictEqual(past.body.standings.closed, true);
      } finally {
        delete process.env.CHESS_ADMIN_TOKEN;
      }
    });

    await test('leagues persist under tmpdir, and unknown /api paths still 404', async () => {
      assert.ok(fs.existsSync(process.env.CHESS_LEAGUES_DB_PATH) || fs.existsSync(process.env.CHESS_LEAGUES_JSON_PATH), 'league store created under tmpdir');
      const res = await request(server, { path: '/api/league/whatever' });
      assert.strictEqual(res.status, 404);
    });
  } finally {
    server.close();
    try { serverModule.stopStateWatcher(); } catch (_) {}
    try { SocialRoutes.resetSocialState(); } catch (_) {}
    try { InsightsRoutes.resetInsightsState(); } catch (_) {}
  }
}

async function run() {
  console.log('=== Wave 3 leagues + insights self-test ===\n');
  try {
    await unitTests();
    await routeTests();
  } finally {
    cleanup();
  }
  console.log(`\nAll ${passed} tests passed successfully!`);
  process.exit(0);
}

run().catch(err => {
  console.error('FAIL:', err && err.stack || err);
  cleanup();
  process.exit(1);
});
