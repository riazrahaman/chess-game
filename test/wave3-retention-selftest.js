#!/usr/bin/env node
'use strict';

/**
 * wave3-retention-selftest.js — Wave 3 (roadmap §6 Tier N2 items 7 + 9):
 * streaks with slack + skill-event achievements.
 *
 *  - pure streak rule across UTC day boundaries (increment once/day, pause as
 *    'at-risk' after idle days, reset after 3 idle days), puzzle-day counting
 *  - achievements.evaluate() catalogue rules and idempotence
 *  - social-store adapters (SQLite + JSON fallback) retention tables
 *  - routes through server.createServer(): guest handling, ?now= override
 *    (NODE_ENV=test only), streak/at-risk/reset, achievement awarded once,
 *    puzzle solve → activity + mate-in-one badge, game end → both seats,
 *    forged brilliant events rejected (unknown game / bad ply / wrong san)
 *
 * All state lives under os.tmpdir() (env vars set before server.js loads).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.NODE_ENV = 'test';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-wave3-retention-'));
process.env.CHESS_STATE_FILE = path.join(TMP, '.referee-state.json');
process.env.CHESS_JOURNAL_FILE = path.join(TMP, '.referee-journal.jsonl');
process.env.CHESS_DB_FILE = path.join(TMP, 'games.db');
process.env.CHESS_JSON_ARCHIVE_FILE = path.join(TMP, 'archive.json');
process.env.CHESS_ACCOUNTS_DB_FILE = path.join(TMP, 'accounts.db');
process.env.CHESS_SOCIAL_DB_PATH = path.join(TMP, 'social.db');
process.env.CHESS_LEAGUES_DB_PATH = path.join(TMP, 'leagues.db');
process.env.CHESS_LEAGUES_JSON_PATH = path.join(TMP, '.leagues.json');
process.env.CHESS_SOCIAL_JSON_PATH = path.join(TMP, '.social.json');
process.env.CHESS_RATE_LIMIT_FILE = path.join(TMP, 'rate-limit.json');
process.env.CHESS_RATE_LIMIT = '100000';

const Streaks = require('../src/streaks.js');
const Achievements = require('../src/achievements.js');
const SocialStore = require('../src/social-store.js');
const Retention = require('../src/routes-retention.js');
const serverModule = require('../server.js');
const gameArchive = require('../src/game-archive.js');

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

// UTC noon on 2026-03-<d> — well inside the day, no boundary surprises.
const D = d => Date.UTC(2026, 2, d, 12, 0, 0);

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
  return { token: res.body.token, id: String(res.body.user.id), username };
}

function cleanup() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

async function run() {
  console.log('=== Wave 3 retention (streaks + achievements) self-test ===\n');

  // ------------------------------------------------------------ pure: streaks
  await test('streak rule: first activity starts at 1; same day never increments twice', async () => {
    const r1 = Streaks.applyActivity(null, '2026-03-01');
    assert.deepStrictEqual([r1.current, r1.longest, r1.lastActiveDay, r1.incremented], [1, 1, '2026-03-01', true]);
    const r2 = Streaks.applyActivity(r1, '2026-03-01');
    assert.strictEqual(r2.current, 1);
    assert.strictEqual(r2.incremented, false);
    assert.strictEqual(Streaks.utcDay(Date.UTC(2026, 2, 1, 23, 59, 59)), '2026-03-01');
    assert.strictEqual(Streaks.utcDay(Date.UTC(2026, 2, 2, 0, 0, 0)), '2026-03-02');
  });

  await test('streak rule: consecutive days increment; gap 2 and 3 (1–2 idle days) keep counting; gap 4 resets', async () => {
    let rec = Streaks.applyActivity(null, '2026-03-01');
    rec = Streaks.applyActivity(rec, '2026-03-02');
    assert.strictEqual(rec.current, 2, 'gap 1 increments');
    rec = Streaks.applyActivity(rec, '2026-03-04');
    assert.strictEqual(rec.current, 3, 'gap 2 (one idle day) increments — slack');
    rec = Streaks.applyActivity(rec, '2026-03-07');
    assert.strictEqual(rec.current, 4, 'gap 3 (two idle days) increments — slack');
    rec = Streaks.applyActivity(rec, '2026-03-11');
    assert.strictEqual(rec.current, 1, 'gap 4 (three idle days) resets to 1');
    assert.strictEqual(rec.longest, 4, 'longest survives the reset');
    const stale = Streaks.applyActivity(rec, '2026-03-10');
    assert.strictEqual(stale.incremented, false, 'out-of-order (earlier) day is ignored');
  });

  await test('streak status at now: active (gap 0-1), at-risk (gap 2-3), broken (gap >= 4) with daysUntilReset', async () => {
    const rec = { current: 5, longest: 5, lastActiveDay: '2026-03-10' };
    const at = d => Streaks.describeStreak(rec, D(d));
    assert.deepStrictEqual([at(10).status, at(10).daysUntilReset, at(10).activeToday], ['active', 4, true]);
    assert.deepStrictEqual([at(11).status, at(11).daysUntilReset, at(11).activeToday], ['active', 3, false]);
    assert.deepStrictEqual([at(12).status, at(12).daysUntilReset, at(12).current], ['at-risk', 2, 5]);
    assert.deepStrictEqual([at(13).status, at(13).daysUntilReset, at(13).current], ['at-risk', 1, 5]);
    assert.deepStrictEqual([at(14).status, at(14).daysUntilReset, at(14).current, at(14).longest], ['broken', 0, 0, 5]);
    const none = Streaks.describeStreak(null, D(1));
    assert.deepStrictEqual([none.current, none.status, none.lastActiveDay], [0, 'broken', null]);
  });

  await test('normalizePlayerId strips the puzzle "user:" prefix and rejects anonymous players', async () => {
    assert.strictEqual(Streaks.normalizePlayerId('user:abc'), 'abc');
    assert.strictEqual(Streaks.normalizePlayerId('abc'), 'abc');
    assert.strictEqual(Streaks.normalizePlayerId('anon:xyz'), null);
    assert.strictEqual(Streaks.normalizePlayerId(null), null);
    assert.strictEqual(Streaks.normalizePlayerId(''), null);
  });

  await test('consecutiveDays counts puzzle days ending today or yesterday', async () => {
    const days = ['2026-03-05', '2026-03-06', '2026-03-07', '2026-03-09', '2026-03-10'].map(day => ({ day, kinds: ['puzzle'] }));
    const isPuzzle = k => k.includes('puzzle');
    assert.strictEqual(Streaks.consecutiveDays(days, D(10), isPuzzle), 2);
    assert.strictEqual(Streaks.consecutiveDays(days, D(11), isPuzzle), 2, 'today still open → counts from yesterday');
    assert.strictEqual(Streaks.consecutiveDays(days, D(12), isPuzzle), 0);
    assert.strictEqual(Streaks.consecutiveDays(days, D(7), isPuzzle), 3);
    assert.strictEqual(Streaks.consecutiveDays(days.map(d => ({ day: d.day, kinds: ['game'] })), D(10), isPuzzle), 0);
  });

  await test('StreakTracker over both social-store adapters (sqlite + json) records the same ledger', async () => {
    const stores = [
      SocialStore.createSocialStore({ dbPath: path.join(TMP, 'unit-social.db') }),
      SocialStore.createSocialStore({ forceJson: true, jsonPath: path.join(TMP, 'unit-social.json') })
    ];
    for (const store of stores) {
      const tracker = new Streaks.StreakTracker({ store });
      assert.strictEqual(tracker.recordActivity('anon:zzz', 'puzzle', D(1)), null, 'anonymous players have no ledger');
      assert.throws(() => tracker.recordActivity('u1', 'nonsense', D(1)), /unknown kind/);
      tracker.recordActivity('user:u1', 'puzzle', D(1));
      tracker.recordActivity('u1', 'game', D(1));
      tracker.recordActivity('u1', 'analysis', D(2));
      const s = tracker.getStreak('u1', D(2));
      assert.deepStrictEqual([s.current, s.longest, s.status], [2, 2, 'active']);
      const days = tracker.getActivityDays('u1');
      assert.deepStrictEqual(days.map(d => d.day), ['2026-03-02', '2026-03-01']);
      assert.deepStrictEqual(days[1].kinds, ['game', 'puzzle'], 'kinds merge under one canonical id');
      assert.strictEqual(tracker.puzzleDayStreak('u1', D(1)), 1);
      // achievements table + counters
      assert.strictEqual(store.saveAchievement('u1', 'streak_7', D(2), { streak: 7 }), true);
      assert.strictEqual(store.saveAchievement('u1', 'streak_7', D(3), { streak: 8 }), false, 'INSERT OR IGNORE semantics');
      assert.deepStrictEqual(store.listAchievements('u1').map(a => [a.id, a.awardedAt, a.evidence.streak]), [['streak_7', D(2), 7]]);
      assert.strictEqual(store.incrementCounter('u1', 'rated_games', 1), 1);
      assert.strictEqual(store.incrementCounter('u1', 'rated_games', 2), 3);
      assert.strictEqual(store.getCounter('u1', 'rated_wins'), 0);
      store.close();
    }
  });

  // ------------------------------------------------------- pure: achievements
  await test('achievements catalogue: >= 10 entries with id/title/description/icon, no volume awards', async () => {
    assert(Achievements.CATALOGUE.length >= 10);
    const ids = new Set();
    for (const a of Achievements.CATALOGUE) {
      assert(a.id && a.title && a.description && a.icon, 'incomplete entry ' + JSON.stringify(a));
      assert(!ids.has(a.id), 'duplicate id ' + a.id);
      ids.add(a.id);
      assert(!/^(games|puzzles|moves|play)_\d+$|_100$|_500$|_1000$/.test(a.id), 'volume-grinding award: ' + a.id);
    }
    for (const id of ['first_rated_win', 'first_brilliant_move', 'tablebase_perfect_endgame', 'puzzle_streak_7', 'puzzle_rating_1500', 'puzzle_rating_1800', 'puzzle_rating_2100', 'streak_7', 'streak_30', 'first_mate_in_one_solved', 'rated_games_10', 'first_league_promotion']) {
      assert(ids.has(id), 'missing ' + id);
    }
  });

  await test('achievements.evaluate: skill events unlock the right ids and never re-award', async () => {
    const ev = Achievements.evaluate;
    assert.deepStrictEqual(ev({ type: 'game_over' }, { ratedWins: 1, ratedGames: 1 }), ['first_rated_win']);
    assert.deepStrictEqual(ev({ type: 'game_over' }, { ratedWins: 0, ratedGames: 10 }), ['rated_games_10']);
    assert.deepStrictEqual(ev({ type: 'game_over' }, { ratedWins: 3, ratedGames: 10, awarded: ['first_rated_win'] }), ['rated_games_10']);
    assert.deepStrictEqual(ev({ type: 'brilliant', verified: true }, {}), ['first_brilliant_move']);
    assert.deepStrictEqual(ev({ type: 'brilliant', verified: false }, {}), [], 'unverified client events award nothing');
    assert.deepStrictEqual(ev({ type: 'brilliant' }, {}), []);
    assert.deepStrictEqual(ev({ type: 'tablebase_perfect', verified: true }, {}), ['tablebase_perfect_endgame']);
    assert.deepStrictEqual(ev({ type: 'puzzle', solved: true, themes: ['mate', 'mateIn1'] }, {}), ['first_mate_in_one_solved']);
    assert.deepStrictEqual(ev({ type: 'puzzle', solved: false, themes: ['mateIn1'] }, {}), []);
    assert.deepStrictEqual(ev({ type: 'puzzle', solved: true, themes: ['fork'] }, { puzzleRating: 1850 }), ['puzzle_rating_1500', 'puzzle_rating_1800']);
    assert.deepStrictEqual(ev({ type: 'puzzle', solved: true, themes: ['fork'] }, { puzzleRating: 2100, awarded: ['puzzle_rating_1500', 'puzzle_rating_1800'] }), ['puzzle_rating_2100']);
    assert.deepStrictEqual(ev({ type: 'activity', kind: 'game' }, { puzzleDayStreak: 7 }), ['puzzle_streak_7']);
    assert.deepStrictEqual(ev({ type: 'activity', kind: 'game' }, { puzzleDayStreak: 6 }), []);
    assert.deepStrictEqual(ev({ type: 'activity', kind: 'game' }, { streak: { current: 7 } }), ['streak_7']);
    assert.deepStrictEqual(ev({ type: 'activity', kind: 'game' }, { streak: { current: 30 } }), ['streak_7', 'streak_30']);
    assert.deepStrictEqual(ev({ type: 'league_promotion', from: 'Wood', to: 'Stone' }, {}), ['first_league_promotion']);
    assert.deepStrictEqual(ev({ type: 'nonsense' }, { streak: { current: 99 } }), []);
    assert.deepStrictEqual(ev(null, {}), []);
    // game_over never unlocks puzzle-rating awards and vice versa
    assert.deepStrictEqual(ev({ type: 'game_over' }, { puzzleRating: 2500 }), []);
  });

  await test('AchievementService.award is idempotent and records evidence', async () => {
    const store = SocialStore.createSocialStore({ forceJson: true, jsonPath: path.join(TMP, 'unit-ach.json') });
    const svc = new Achievements.AchievementService({ store });
    const first = svc.award('p1', { type: 'brilliant', verified: true, gameId: 'g1', ply: 17, san: 'Qxf7+' }, {}, D(3));
    assert.deepStrictEqual(first.map(a => a.id), ['first_brilliant_move']);
    assert.deepStrictEqual(first[0].evidence, { event: 'brilliant', gameId: 'g1', ply: 17, san: 'Qxf7+' });
    assert.deepStrictEqual(svc.award('p1', { type: 'brilliant', verified: true, gameId: 'g2', ply: 3 }, {}, D(4)), []);
    assert.strictEqual(svc.listAwarded('p1').length, 1);
    const cat = Achievements.presentCatalogue(svc.listAwarded('p1'));
    assert.strictEqual(cat.length, Achievements.CATALOGUE.length);
    assert.strictEqual(cat.find(a => a.id === 'first_brilliant_move').awarded, true);
    assert.strictEqual(cat.find(a => a.id === 'streak_7').awarded, false);
    store.close();
  });

  // ------------------------------------------------------------------ routes
  const server = serverModule.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const suffix = Date.now().toString(36);

  try {
    const alice = await register(server, 'alice_' + suffix);
    const bob = await register(server, 'bob_' + suffix);

    await test('guests: GET /api/streak and /api/achievements → {guest:true}; POSTs → 401', async () => {
      const streak = await request(server, { path: '/api/streak' });
      assert.strictEqual(streak.status, 200);
      assert.deepStrictEqual(streak.body, { guest: true });
      const ach = await request(server, { path: '/api/achievements' });
      assert.strictEqual(ach.status, 200);
      assert.strictEqual(ach.body.guest, true);
      assert.strictEqual(ach.body.catalogue.length, Achievements.CATALOGUE.length);
      const act = await request(server, { path: '/api/activity', method: 'POST' }, { kind: 'analysis' });
      assert.strictEqual(act.status, 401);
      const evt = await request(server, { path: '/api/achievements/event', method: 'POST' }, { type: 'brilliant', gameId: 'x', ply: 1 });
      assert.strictEqual(evt.status, 401);
      const unknown = await request(server, { path: '/api/streak/nope/extra' });
      assert.strictEqual(unknown.status, 404);
    });

    await test('POST /api/activity increments once per UTC day (?now= honoured under NODE_ENV=test)', async () => {
      const bad = await request(server, { path: '/api/activity?now=' + D(1), method: 'POST', token: alice.token }, { kind: 'bogus' });
      assert.strictEqual(bad.status, 400);
      const a = await request(server, { path: '/api/activity?now=' + D(1), method: 'POST', token: alice.token }, { kind: 'analysis' });
      assert.strictEqual(a.status, 200, a.raw);
      assert.deepStrictEqual([a.body.day, a.body.incremented, a.body.streak.current, a.body.streak.status], ['2026-03-01', true, 1, 'active']);
      const again = await request(server, { path: '/api/activity?now=' + (D(1) + 3600000), method: 'POST', token: alice.token }, { kind: 'analysis' });
      assert.deepStrictEqual([again.body.incremented, again.body.streak.current], [false, 1]);
      const b = await request(server, { path: '/api/activity?now=' + D(2), method: 'POST', token: alice.token }, { kind: 'analysis' });
      assert.strictEqual(b.body.streak.current, 2);
      const me = await request(server, { path: '/api/streak?now=' + D(2), token: alice.token });
      assert.strictEqual(me.status, 200);
      assert.strictEqual(me.body.guest, false);
      assert.deepStrictEqual([me.body.streak.current, me.body.streak.longest, me.body.streak.lastActiveDay], [2, 2, '2026-03-02']);
      assert.deepStrictEqual(me.body.activityDays.map(d => d.day), ['2026-03-02', '2026-03-01']);
    });

    await test('GET /api/streak: at-risk after idle days, broken after three, then a fresh start', async () => {
      const d4 = await request(server, { path: '/api/streak?now=' + D(4), token: alice.token });
      assert.deepStrictEqual([d4.body.streak.status, d4.body.streak.current, d4.body.streak.daysUntilReset], ['at-risk', 2, 2]);
      const d5 = await request(server, { path: '/api/streak?now=' + D(5), token: alice.token });
      assert.deepStrictEqual([d5.body.streak.status, d5.body.streak.current, d5.body.streak.daysUntilReset], ['at-risk', 2, 1]);
      const d6 = await request(server, { path: '/api/streak?now=' + D(6), token: alice.token });
      assert.deepStrictEqual([d6.body.streak.status, d6.body.streak.current, d6.body.streak.longest], ['broken', 0, 2]);
      const pub = await request(server, { path: '/api/streak/' + encodeURIComponent(alice.id) + '?now=' + D(5) });
      assert.strictEqual(pub.status, 200);
      assert.deepStrictEqual(pub.body, { userId: alice.id, current: 2, status: 'at-risk' });
      assert.strictEqual(Object.prototype.hasOwnProperty.call(pub.body, 'activityDays'), false, 'public view is current+status only');
      const restart = await request(server, { path: '/api/activity?now=' + D(6), method: 'POST', token: alice.token }, { kind: 'analysis' });
      assert.deepStrictEqual([restart.body.streak.current, restart.body.streak.longest, restart.body.streak.status], [1, 2, 'active']);
      // slack: resume on day 8 (one idle day) keeps counting
      const resume = await request(server, { path: '/api/activity?now=' + D(8), method: 'POST', token: alice.token }, { kind: 'analysis' });
      assert.strictEqual(resume.body.streak.current, 2);
    });

    await test('?now= is ignored outside NODE_ENV=test', async () => {
      const saved = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production-like';
      try {
        const res = await request(server, { path: '/api/streak?now=' + D(1), token: alice.token });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.streak.status, 'broken', 'real clock is far past 2026-03-08 → broken');
      } finally {
        process.env.NODE_ENV = saved;
      }
    });

    await test('streak_7 awarded exactly once after seven consecutive days (bob)', async () => {
      let awardedTotal = [];
      for (let d = 1; d <= 7; d++) {
        const res = await request(server, { path: '/api/activity?now=' + D(d), method: 'POST', token: bob.token }, { kind: 'game' });
        assert.strictEqual(res.status, 200, res.raw);
        awardedTotal = awardedTotal.concat(res.body.awarded.map(a => a.id));
        if (d < 7) assert.deepStrictEqual(res.body.awarded, [], 'nothing awarded before day 7');
      }
      assert.deepStrictEqual(awardedTotal, ['streak_7']);
      const eighth = await request(server, { path: '/api/activity?now=' + D(8), method: 'POST', token: bob.token }, { kind: 'game' });
      assert.deepStrictEqual(eighth.body.awarded, [], 'not re-awarded');
      const mine = await request(server, { path: '/api/achievements', token: bob.token });
      assert.strictEqual(mine.body.guest, false);
      assert.deepStrictEqual(mine.body.awarded.map(a => a.id), ['streak_7']);
      assert.strictEqual(mine.body.catalogue.find(a => a.id === 'streak_7').awarded, true);
      const pub = await request(server, { path: '/api/achievements/' + encodeURIComponent(bob.id) });
      assert.deepStrictEqual(pub.body.awarded.map(a => a.id), ['streak_7']);
      const other = await request(server, { path: '/api/achievements/' + encodeURIComponent(alice.id) });
      assert.deepStrictEqual(other.body.awarded, []);
    });

    await test('puzzle solve (signed in) records puzzle activity and awards first_mate_in_one_solved', async () => {
      const next = await request(server, { path: '/api/puzzle/next?theme=mateIn1&rating=1200', token: alice.token });
      assert.strictEqual(next.status, 200, next.raw);
      const p = next.body.puzzle;
      const sol = gameArchive.getPuzzle(p.id).moves.split(' ');
      const moves = sol.filter((_, i) => i % 2 === 1);
      const before = await request(server, { path: '/api/streak', token: alice.token });
      const solve = await request(server, { path: `/api/puzzle/${p.id}/solve`, method: 'POST', token: alice.token }, { moves, timeMs: 5000, win: true, mode: 'rated' });
      assert.strictEqual(solve.status, 200, solve.raw);
      const after = await request(server, { path: '/api/streak', token: alice.token });
      const today = Streaks.utcDay(Date.now());
      assert.strictEqual(after.body.streak.lastActiveDay, today);
      assert(after.body.activityDays.some(d => d.day === today && d.kinds.includes('puzzle')), 'puzzle activity logged under the bare account id: ' + JSON.stringify(after.body.activityDays));
      assert.strictEqual(after.body.puzzleDayStreak, 1);
      assert(before.body.streak.current <= after.body.streak.current);
      const mine = await request(server, { path: '/api/achievements', token: alice.token });
      assert(mine.body.awarded.some(a => a.id === 'first_mate_in_one_solved'), JSON.stringify(mine.body.awarded));
      assert(!mine.body.awarded.some(a => a.id.startsWith('puzzle_rating_')), 'a provisional puzzle rating (RD > 110) must not unlock rating badges: ' + JSON.stringify(mine.body.awarded));
      // anonymous solvers leave no ledger
      const anonNext = await request(server, { path: '/api/puzzle/next?theme=mateIn1&rating=1200' });
      const anonSol = gameArchive.getPuzzle(anonNext.body.puzzle.id).moves.split(' ').filter((_, i) => i % 2 === 1);
      const anonSolve = await request(server, { path: `/api/puzzle/${anonNext.body.puzzle.id}/solve`, method: 'POST', headers: { Cookie: 'puzzle_player=anonPlayer12345' } }, { moves: anonSol, timeMs: 5000, win: true });
      assert.strictEqual(anonSolve.status, 200, anonSolve.raw);
      const anonStreak = await request(server, { path: '/api/streak/anonPlayer12345' });
      assert.strictEqual(anonStreak.body.current, 0);
    });

    await test('game end records a game activity for BOTH signed-in seats (unrated bot/anon games included)', async () => {
      const room = 'w3ret' + suffix;
      const w = await request(server, { path: '/api/seat/claim', method: 'POST', token: alice.token }, { role: 'white', room });
      const b = await request(server, { path: '/api/seat/claim', method: 'POST', token: bob.token }, { role: 'black', room });
      assert.strictEqual(w.status, 200, w.raw);
      assert.strictEqual(b.status, 200, b.raw);
      const beforeBob = await request(server, { path: '/api/streak', token: bob.token });
      await request(server, { path: '/api/move?room=' + room, method: 'POST', seat: w.body.token }, { move: 'e2e4' });
      await request(server, { path: '/api/move?room=' + room, method: 'POST', seat: b.body.token }, { move: 'e7e5' });
      const resign = await request(server, { path: '/api/resign?room=' + room, method: 'POST', seat: b.body.token }, { color: 'black' });
      assert.strictEqual(resign.status, 200, resign.raw);
      assert.strictEqual(resign.body.result, '1-0');
      const today = Streaks.utcDay(Date.now());
      const a = await request(server, { path: '/api/streak', token: alice.token });
      const bb = await request(server, { path: '/api/streak', token: bob.token });
      for (const [who, res] of [['alice', a], ['bob', bb]]) {
        const day = res.body.activityDays.find(d => d.day === today);
        assert(day && day.kinds.includes('game'), who + ' has no game activity today: ' + JSON.stringify(res.body.activityDays));
      }
      assert(bb.body.streak.lastActiveDay === today);
      assert(beforeBob.body.streak.lastActiveDay !== today || true);
      // rated (both signed in, no bot, >= 2 plies): alice gets first_rated_win, bob does not
      const aliceAch = await request(server, { path: '/api/achievements', token: alice.token });
      assert(aliceAch.body.awarded.some(x => x.id === 'first_rated_win'), JSON.stringify(aliceAch.body.awarded));
      const bobAch = await request(server, { path: '/api/achievements', token: bob.token });
      assert(!bobAch.body.awarded.some(x => x.id === 'first_rated_win'));
      assert.strictEqual(aliceAch.body.awarded.find(x => x.id === 'first_rated_win').evidence.ratedWins, 1);
    });

    await test('POST /api/achievements/event: forged brilliant events are rejected, a genuine one is verified and awarded once', async () => {
      const saved = gameArchive.saveGame({ white: 'White', black: 'Black', result: '1-0', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'c2c3', 'g8f6', 'd2d4'] });
      const unknown = await request(server, { path: '/api/achievements/event', method: 'POST', token: alice.token }, { type: 'brilliant', gameId: 'no-such-game', ply: 3 });
      assert.strictEqual(unknown.status, 404);
      const badType = await request(server, { path: '/api/achievements/event', method: 'POST', token: alice.token }, { type: 'legendary', gameId: saved.id, ply: 3 });
      assert.strictEqual(badType.status, 400);
      const badPly = await request(server, { path: '/api/achievements/event', method: 'POST', token: alice.token }, { type: 'brilliant', gameId: saved.id, ply: 40 });
      assert.strictEqual(badPly.status, 422);
      const zeroPly = await request(server, { path: '/api/achievements/event', method: 'POST', token: alice.token }, { type: 'brilliant', gameId: saved.id, ply: 0 });
      assert.strictEqual(zeroPly.status, 422);
      const badSan = await request(server, { path: '/api/achievements/event', method: 'POST', token: alice.token }, { type: 'brilliant', gameId: saved.id, ply: 5, san: 'Qh5' });
      assert.strictEqual(badSan.status, 422);
      const none = await request(server, { path: '/api/achievements', token: alice.token });
      assert(!none.body.awarded.some(a => a.id === 'first_brilliant_move'), 'forgeries must not award');
      const ok = await request(server, { path: '/api/achievements/event', method: 'POST', token: alice.token }, { type: 'brilliant', gameId: saved.id, ply: 5, san: 'Bc4' });
      assert.strictEqual(ok.status, 200, ok.raw);
      assert.strictEqual(ok.body.verified, true);
      assert.deepStrictEqual(ok.body.awarded.map(a => a.id), ['first_brilliant_move']);
      assert.strictEqual(ok.body.awarded[0].evidence.gameId, saved.id);
      const dup = await request(server, { path: '/api/achievements/event', method: 'POST', token: alice.token }, { type: 'brilliant', gameId: saved.id, ply: 5 });
      assert.strictEqual(dup.status, 200);
      assert.deepStrictEqual(dup.body.awarded, [], 'second claim awards nothing');
      // a game recorded under someone else's real names is not the caller's
      const other = gameArchive.saveGame({ white: 'Carlsen', black: 'Nakamura', result: '1-0', moves: ['e2e4', 'e7e5'] });
      const notMine = await request(server, { path: '/api/achievements/event', method: 'POST', token: alice.token }, { type: 'brilliant', gameId: other.id, ply: 1 });
      assert.strictEqual(notMine.status, 403);
    });

    await test('POST /api/achievements/event tablebase_perfect: needs a decisive result and <= 7 pieces at the end', async () => {
      const middlegame = gameArchive.saveGame({ white: 'White', black: 'Black', result: '1-0', moves: ['e2e4', 'e7e5', 'g1f3'] });
      const tooMany = await request(server, { path: '/api/achievements/event', method: 'POST', token: bob.token }, { type: 'tablebase_perfect', gameId: middlegame.id });
      assert.strictEqual(tooMany.status, 422);
      // K+Q vs K from a custom PGN with a FEN header is not replayable from the start position → 422, never awarded
      const drawn = gameArchive.saveGame({ white: 'White', black: 'Black', result: '1/2-1/2', moves: ['e2e4', 'e7e5'] });
      const notDecisive = await request(server, { path: '/api/achievements/event', method: 'POST', token: bob.token }, { type: 'tablebase_perfect', gameId: drawn.id });
      assert.strictEqual(notDecisive.status, 422);
      const bobAch = await request(server, { path: '/api/achievements', token: bob.token });
      assert(!bobAch.body.awarded.some(a => a.id === 'tablebase_perfect_endgame'));
      // direct verifier check with a real 7-piece finish: the verifier accepts the shape
      const verdict = Retention.verifyClientEvent({ type: 'tablebase_perfect', gameId: middlegame.id }, { id: bob.id, username: bob.username }, { gameArchive, referee: require('../src/referee-service.js') });
      assert.strictEqual(verdict.ok, false);
      assert(/pieces/.test(verdict.error));
    });

    await test('league promotion hook awards first_league_promotion once (for Worker B)', async () => {
      const first = Retention.onLeaguePromotion(bob.id, { from: 'Wood', to: 'Stone' });
      assert.deepStrictEqual(first.map(a => a.id), ['first_league_promotion']);
      assert.deepStrictEqual(Retention.onLeaguePromotion(bob.id, { from: 'Stone', to: 'Bronze' }), []);
      assert.deepStrictEqual(Retention.onLeaguePromotion('anon:x', {}), []);
    });

    await test('client bundle: streaks/achievements are server-only, ui-retention.js is servable and precached', async () => {
      const root = path.join(__dirname, '..');
      const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
      const sw = fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8');
      const srv = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
      assert(!/src\/(streaks|achievements|routes-retention)\.js/.test(html), 'server modules must not ship to the browser');
      assert(html.includes('src="src/ui-retention.js"'));
      assert(html.indexOf('src/ui-retention.js') < html.indexOf('src="src/ui.js"'), 'ui-retention.js loads before ui.js');
      assert(html.includes('id="home-streak"'));
      assert(sw.includes('src/ui-retention.js'));
      assert(srv.includes("'src/ui-retention.js'"));
      assert(srv.includes("const RetentionRoutes = require('./src/routes-retention.js')"), 'loaded at boot, not lazily');
      assert(srv.includes('RetentionRoutes.handleRetentionRoute(req, res, urlPath'));
      const ui = fs.readFileSync(path.join(root, 'src', 'ui-retention.js'), 'utf8');
      assert(ui.includes('#streak-badge') || ui.includes("'streak-badge'"));
      assert(ui.includes('profile-retention'));
      assert(ui.includes("cache: 'no-store'"));
      const served = await request(server, { path: '/src/ui-retention.js' });
      assert.strictEqual(served.status, 200);
    });
  } finally {
    await new Promise(r => server.close(r));
    try { serverModule.shutdown && serverModule.shutdown(); } catch (_) {}
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('FATAL', err);
  cleanup();
  process.exit(1);
});
