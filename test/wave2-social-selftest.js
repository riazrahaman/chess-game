#!/usr/bin/env node
'use strict';

/**
 * wave2-social-selftest.js — Wave 2 R2: lobby / ratings / arena / social routes
 * and the rating-on-game-end hook, exercised end-to-end through server.js.
 *
 * Every DB/state artifact lives under os.tmpdir() (env vars are set BEFORE
 * server.js is required because the module-level path constants read them at
 * load time). The folder is removed on exit.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-wave2-social-'));
process.env.CHESS_STATE_FILE = path.join(TMP, '.referee-state.json');
process.env.CHESS_JOURNAL_FILE = path.join(TMP, '.referee-journal.jsonl');
process.env.CHESS_DB_FILE = path.join(TMP, 'games.db');
process.env.CHESS_JSON_ARCHIVE_FILE = path.join(TMP, '.games-archive.json');
process.env.CHESS_ACCOUNTS_DB_FILE = path.join(TMP, 'accounts.db');
process.env.CHESS_SOCIAL_DB_PATH = path.join(TMP, 'social.db');
process.env.CHESS_LEAGUES_DB_PATH = path.join(TMP, 'leagues.db');
process.env.CHESS_LEAGUES_JSON_PATH = path.join(TMP, '.leagues.json');
process.env.CHESS_SOCIAL_JSON_PATH = path.join(TMP, '.social.json');
process.env.CHESS_RATE_LIMIT_FILE = path.join(TMP, 'rate-limit.json');
process.env.CHESS_RATE_LIMIT = '100000';

const serverModule = require('../server.js');
const RatingHook = require('../src/rating-hook.js');
const SocialRoutes = require('../src/routes-social.js');

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

async function run() {
  console.log('=== Wave 2 social/compete routes + rating hook self-test ===\n');
  const server = serverModule.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const suffix = Date.now().toString(36);

  try {
    // ------------------------------------------------------------ unit: rule
    await test('rating rule: pool comes from the lichess TC label formula', async () => {
      assert.strictEqual(RatingHook.poolForTimeControl({ baseSeconds: 600, incrementSeconds: 15 }), 'rapid');
      assert.strictEqual(RatingHook.poolForTimeControl({ baseSeconds: 180, incrementSeconds: 2 }), 'blitz');
      assert.strictEqual(RatingHook.poolForTimeControl({ baseSeconds: 60, incrementSeconds: 0 }), 'bullet');
      assert.strictEqual(RatingHook.poolForTimeControl({ baseSeconds: 3600, incrementSeconds: 0 }), 'classical');
      assert.strictEqual(RatingHook.poolForTimeControl(null), 'rapid');
    });

    await test('rating rule: anonymous, bot, same-account and aborted games are unrated', async () => {
      const over = { gameOver: true, result: '0-1', status: 'resigned', history: ['e2e4', 'e7e5'], timeControl: { baseSeconds: 600, incrementSeconds: 15 } };
      const a = { accountId: 'A', isBot: false }; const b = { accountId: 'B', isBot: false };
      assert.strictEqual(RatingHook.shouldRate(over, { white: a, black: b }, false).rated, true);
      assert.strictEqual(RatingHook.shouldRate(over, { white: a, black: b }, true).reason, 'bot-game');
      assert.strictEqual(RatingHook.shouldRate(over, { white: a, black: { accountId: null, isBot: false } }, false).reason, 'anonymous');
      assert.strictEqual(RatingHook.shouldRate(over, { white: a, black: null }, false).reason, 'anonymous');
      assert.strictEqual(RatingHook.shouldRate(over, { white: a, black: { accountId: 'A', isBot: false } }, false).reason, 'same-account');
      assert.strictEqual(RatingHook.shouldRate(over, { white: a, black: { accountId: 'B', isBot: true } }, false).reason, 'bot-game');
      assert.strictEqual(RatingHook.shouldRate({ ...over, history: [] }, { white: a, black: b }, false).reason, 'aborted');
      assert.strictEqual(RatingHook.shouldRate({ ...over, gameOver: false }, { white: a, black: b }, false).reason, 'not-over');
      assert.strictEqual(RatingHook.shouldRate({ ...over, result: '1-0 on time' }, { white: a, black: b }, false).score, 1);
      assert.strictEqual(RatingHook.shouldRate({ ...over, result: '½-½' }, { white: a, black: b }, false).score, 0.5);
    });

    // -------------------------------------------------------------- accounts
    const alice = await register(server, 'alice_' + suffix);
    const bob = await register(server, 'bob_' + suffix);

    await test('mutations require an auth session', async () => {
      const seek = await request(server, { path: '/api/lobby/seek', method: 'POST' }, { tc: 'blitz' });
      assert.strictEqual(seek.status, 401);
      const arena = await request(server, { path: '/api/arena', method: 'POST' }, { name: 'x', tc: 'blitz' });
      assert.strictEqual(arena.status, 401);
      const follow = await request(server, { path: '/api/social/follow/' + bob.id, method: 'POST' });
      assert.strictEqual(follow.status, 401);
      const me = await request(server, { path: '/api/ratings/me' });
      assert.strictEqual(me.status, 401);
    });

    // ----------------------------------------------------------------- lobby
    let seekId = null;
    await test('POST /api/lobby/seek creates a seek listed by GET /api/lobby/seeks', async () => {
      const bad = await request(server, { path: '/api/lobby/seek', method: 'POST', token: alice.token }, { tc: 'nonsense' });
      assert.strictEqual(bad.status, 400);
      const res = await request(server, { path: '/api/lobby/seek', method: 'POST', token: alice.token }, { tc: 'blitz_3_2', ratingRange: 150 });
      assert.strictEqual(res.status, 201, res.raw);
      assert.strictEqual(res.body.seek.pool, 'blitz');
      assert.strictEqual(res.body.seek.tc.preset, 'blitz_3_2');
      assert.strictEqual(res.body.seek.ratingRange, 150);
      assert.strictEqual(res.body.seek.username, alice.username);
      seekId = res.body.seek.id;
      const list = await request(server, { path: '/api/lobby/seeks' });
      assert.strictEqual(list.status, 200);
      assert.ok(list.body.seeks.some(s => s.id === seekId), 'seek visible to anyone');
      const dup = await request(server, { path: '/api/lobby/seek', method: 'POST', token: alice.token }, { tc: '3+2' });
      assert.strictEqual(dup.status, 409, 'duplicate seek in same pool rejected');
      const mine = await request(server, { path: '/api/lobby/mine', token: alice.token });
      assert.strictEqual(mine.body.seeks.length, 1);
      assert.strictEqual(mine.body.match, null);
    });

    let roomId = null;
    let aliceSeat = null;
    let bobSeat = null;
    let aliceColor = null;
    await test('POST /api/lobby/accept/:seekId creates a room both players can see with their seats', async () => {
      const self = await request(server, { path: '/api/lobby/accept/' + seekId, method: 'POST', token: alice.token });
      assert.strictEqual(self.status, 409, 'seeker cannot accept own seek');
      const res = await request(server, { path: '/api/lobby/accept/' + seekId, method: 'POST', token: bob.token });
      assert.strictEqual(res.status, 201, res.raw);
      roomId = res.body.roomId;
      assert.ok(serverModule.isValidRoomId(roomId), 'room id valid');
      assert.ok(res.body.seatToken && ['white', 'black'].includes(res.body.color));
      assert.strictEqual(res.body.opponent.username, alice.username);
      bobSeat = res.body.seatToken;
      const bobColor = res.body.color;

      const mine = await request(server, { path: '/api/lobby/mine', token: alice.token });
      assert.strictEqual(mine.body.seeks.length, 0, 'accepted seek is no longer open');
      assert.strictEqual(mine.body.match.roomId, roomId);
      assert.notStrictEqual(mine.body.match.color, bobColor);
      aliceSeat = mine.body.match.seatToken;
      aliceColor = mine.body.match.color;
      assert.notStrictEqual(aliceSeat, bobSeat);

      const state = await request(server, { path: '/api/state?room=' + roomId });
      assert.strictEqual(state.status, 200);
      assert.strictEqual(state.body.timeControl.preset, 'blitz_3_2', 'room carries the seek time control');
      const seats = await request(server, { path: '/api/seat/status?room=' + roomId });
      assert.strictEqual(seats.body.whiteOccupied, true);
      assert.strictEqual(seats.body.blackOccupied, true);
      const again = await request(server, { path: '/api/lobby/accept/' + seekId, method: 'POST', token: bob.token });
      assert.strictEqual(again.status, 404, 'a matched seek cannot be accepted twice');
    });

    // ----------------------------------------------------- rated human game
    await test('a rated human game (two signed-in seats, resignation) moves both ratings', async () => {
      const before = await request(server, { path: '/api/ratings/me', token: alice.token });
      assert.strictEqual(before.status, 200);
      assert.strictEqual(before.body.pools.length, 0, 'no rating before any game');

      const whiteSeat = aliceColor === 'white' ? aliceSeat : bobSeat;
      const blackSeat = aliceColor === 'white' ? bobSeat : aliceSeat;
      const m1 = await request(server, { path: '/api/move?room=' + roomId, method: 'POST', seat: whiteSeat }, { move: 'e2e4' });
      assert.strictEqual(m1.status, 200, m1.raw);
      const m2 = await request(server, { path: '/api/move?room=' + roomId, method: 'POST', seat: blackSeat }, { move: 'e7e5' });
      assert.strictEqual(m2.status, 200, m2.raw);
      // Black resigns -> 1-0
      const resign = await request(server, { path: '/api/resign?room=' + roomId, method: 'POST', seat: blackSeat }, { color: 'black' });
      assert.strictEqual(resign.status, 200, resign.raw);
      assert.strictEqual(resign.body.result, '1-0');

      const winner = aliceColor === 'white' ? alice : bob;
      const loser = aliceColor === 'white' ? bob : alice;
      const w = await request(server, { path: '/api/ratings/me', token: winner.token });
      const l = await request(server, { path: '/api/ratings/me', token: loser.token });
      assert.strictEqual(w.body.pools.length, 1);
      assert.strictEqual(w.body.pools[0].pool, 'blitz');
      assert.ok(w.body.pools[0].rating > 1500, 'winner above 1500: ' + w.body.pools[0].rating);
      assert.ok(l.body.pools[0].rating < 1500, 'loser below 1500: ' + l.body.pools[0].rating);
      assert.strictEqual(w.body.pools[0].provisional, true, 'one game -> still provisional (RD>110)');
      assert.strictEqual(w.body.pools[0].rd < 350, true, 'RD shrank');

      // persisted through game-archive ratings_pool
      const saved = serverModule.gameArchive.getPoolRating('blitz', winner.id);
      assert.ok(saved && saved.rating > 1500, 'rating row persisted in archive');

      // idempotent: a repeat change event after game over does not re-rate
      const ratedBefore = serverModule.ratingHook.ratedGames.size;
      const offer = await request(server, { path: '/api/draw/offer?room=' + roomId, method: 'POST', seat: whiteSeat }, { color: 'white' });
      assert.ok([200, 409].includes(offer.status));
      const w2 = await request(server, { path: '/api/ratings/me', token: winner.token });
      assert.strictEqual(w2.body.pools[0].rating, w.body.pools[0].rating, 'rating unchanged after post-game events');
      assert.strictEqual(serverModule.ratingHook.ratedGames.size, ratedBefore);
    });

    await test('GET /api/leaderboard/:tc lists both players; unknown pool is 400', async () => {
      const bad = await request(server, { path: '/api/leaderboard/turbo' });
      assert.strictEqual(bad.status, 400);
      const lb = await request(server, { path: '/api/leaderboard/blitz?limit=10' });
      assert.strictEqual(lb.status, 200);
      const names = lb.body.ranked.concat(lb.body.provisional).map(r => r.username);
      assert.ok(names.includes(alice.username) && names.includes(bob.username), 'both rated players present: ' + names.join(','));
      const rapid = await request(server, { path: '/api/leaderboard/rapid' });
      assert.strictEqual(rapid.body.ranked.length + rapid.body.provisional.length, 0, 'pools are separate');
    });

    await test('a bot game does not change any rating', async () => {
      const botRoom = 'botroom-' + suffix;
      // Alice sits as white (signed in); bot takes black.
      const claim = await request(server, { path: '/api/seat/claim', method: 'POST', token: alice.token }, { role: 'white', room: botRoom });
      assert.strictEqual(claim.status, 200);
      assert.strictEqual(claim.body.accountId, alice.id, 'seat carries account link');
      const bot = await request(server, { path: '/api/bot?room=' + botRoom, method: 'POST', seat: claim.body.token }, { enabled: true, level: 1, color: 'black' });
      assert.strictEqual(bot.status, 200, bot.raw);
      const before = await request(server, { path: '/api/ratings/me', token: alice.token });
      const m1 = await request(server, { path: '/api/move?room=' + botRoom, method: 'POST', seat: claim.body.token }, { move: 'e2e4' });
      assert.strictEqual(m1.status, 200, m1.raw);
      const resign = await request(server, { path: '/api/resign?room=' + botRoom, method: 'POST', seat: claim.body.token }, { color: 'white' });
      assert.strictEqual(resign.status, 200, resign.raw);
      const after = await request(server, { path: '/api/ratings/me', token: alice.token });
      assert.deepStrictEqual(after.body.pools, before.body.pools, 'bot game unrated');
      const events = Array.from(serverModule.ratingHook.ratedGames.values()).filter(e => e.roomId === botRoom);
      assert.ok(events.length === 1 && events[0].rated === false && ['bot-game', 'anonymous', 'aborted'].includes(events[0].reason), 'bot game recorded as unrated: ' + JSON.stringify(events));
      await request(server, { path: '/api/bot?room=' + botRoom, method: 'POST', seat: claim.body.token }, { enabled: false });
    });

    await test('an anonymous game (no session on a seat) is unrated', async () => {
      const anonRoom = 'anon-' + suffix;
      const w = await request(server, { path: '/api/seat/claim', method: 'POST', token: alice.token }, { role: 'white', room: anonRoom });
      const b = await request(server, { path: '/api/seat/claim', method: 'POST' }, { role: 'black', room: anonRoom });
      assert.strictEqual(b.body.accountId, null);
      await request(server, { path: '/api/move?room=' + anonRoom, method: 'POST', seat: w.body.token }, { move: 'e2e4' });
      await request(server, { path: '/api/move?room=' + anonRoom, method: 'POST', seat: b.body.token }, { move: 'e7e5' });
      const resign = await request(server, { path: '/api/resign?room=' + anonRoom, method: 'POST', seat: b.body.token }, { color: 'black' });
      assert.strictEqual(resign.status, 200, resign.raw);
      const events = Array.from(serverModule.ratingHook.ratedGames.values()).filter(e => e.roomId === anonRoom);
      assert.strictEqual(events[0].rated, false);
      assert.strictEqual(events[0].reason, 'anonymous');
    });

    // ----------------------------------------------------------------- arena
    let arenaId = null;
    await test('arena create / list / join / standings', async () => {
      const created = await request(server, { path: '/api/arena', method: 'POST', token: alice.token }, { name: 'Friday Blitz', tc: 'blitz' });
      assert.strictEqual(created.status, 201, created.raw);
      arenaId = created.body.arena.id;
      assert.strictEqual(created.body.arena.playerCount, 1, 'creator auto-joins');
      const list = await request(server, { path: '/api/arena' });
      assert.ok(list.body.arenas.some(a => a.id === arenaId));
      const join = await request(server, { path: '/api/arena/' + arenaId + '/join', method: 'POST', token: bob.token });
      assert.strictEqual(join.status, 200, join.raw);
      assert.strictEqual(join.body.joined, true);
      assert.strictEqual(join.body.arena.playerCount, 2);
      const rejoin = await request(server, { path: '/api/arena/' + arenaId + '/join', method: 'POST', token: bob.token });
      assert.strictEqual(rejoin.body.joined, false, 'joining twice is a no-op');
      const standings = await request(server, { path: '/api/arena/' + arenaId + '/standings' });
      assert.strictEqual(standings.status, 200);
      assert.strictEqual(standings.body.standings.length, 2);
      assert.ok(standings.body.standings.every(r => r.score === 0 && r.rank >= 1));
      const missing = await request(server, { path: '/api/arena/nope/standings' });
      assert.strictEqual(missing.status, 404);
    });

    await test('a rated game between two arena members feeds the arena standings', async () => {
      SocialRoutes.onRatedGame({ rated: true, pool: 'blitz', result: '1-0', white: { accountId: alice.id }, black: { accountId: bob.id } });
      const standings = await request(server, { path: '/api/arena/' + arenaId + '/standings' });
      assert.strictEqual(standings.body.standings[0].id, alice.id);
      assert.strictEqual(standings.body.standings[0].score, 1);
      assert.strictEqual(standings.body.standings[1].score, 0);
      assert.strictEqual(standings.body.results.length, 1);
    });

    // ---------------------------------------------------------------- social
    await test('follow / friends / followers / unfollow / block', async () => {
      const bad = await request(server, { path: '/api/social/follow/no-such-user', method: 'POST', token: alice.token });
      assert.strictEqual(bad.status, 404);
      const lookup = await request(server, { path: '/api/social/lookup?username=' + encodeURIComponent(bob.username) });
      assert.strictEqual(lookup.body.user.id, bob.id);
      const f1 = await request(server, { path: '/api/social/follow/' + bob.id, method: 'POST', token: alice.token });
      assert.strictEqual(f1.status, 200, f1.raw);
      assert.strictEqual(f1.body.following, true);
      assert.strictEqual(f1.body.friends, false);
      let friends = await request(server, { path: '/api/social/friends', token: alice.token });
      assert.strictEqual(friends.body.friends.length, 0, 'one-way follow is not friendship');
      const bobFollowers = await request(server, { path: '/api/social/followers', token: bob.token });
      assert.strictEqual(bobFollowers.body.followers[0].username, alice.username);
      const f2 = await request(server, { path: '/api/social/follow/' + alice.id, method: 'POST', token: bob.token });
      assert.strictEqual(f2.body.friends, true, 'mutual follow = friends');
      friends = await request(server, { path: '/api/social/friends', token: alice.token });
      assert.strictEqual(friends.body.friends[0].username, bob.username);
      const un = await request(server, { path: '/api/social/unfollow/' + bob.id, method: 'POST', token: alice.token });
      assert.strictEqual(un.body.following, false);
      friends = await request(server, { path: '/api/social/friends', token: bob.token });
      assert.strictEqual(friends.body.friends.length, 0);
      const block = await request(server, { path: '/api/social/block/' + alice.id, method: 'POST', token: bob.token });
      assert.strictEqual(block.body.blocked, true);
      const blockedFollow = await request(server, { path: '/api/social/follow/' + bob.id, method: 'POST', token: alice.token });
      assert.strictEqual(blockedFollow.status, 403, 'blocked users cannot follow');
      const mine = await request(server, { path: '/api/social/followers', token: bob.token });
      assert.strictEqual(mine.body.blocked[0].id, alice.id);
    });

    await test('social graph persists in the tmp social.db (not in the repo)', async () => {
      assert.ok(fs.existsSync(process.env.CHESS_SOCIAL_DB_PATH) || fs.existsSync(process.env.CHESS_SOCIAL_JSON_PATH), 'social store file created under tmpdir');
      assert.ok(!fs.existsSync(path.join(__dirname, '..', 'social.db')) || fs.statSync(path.join(__dirname, '..', 'social.db')).mtimeMs < Date.now() - 60000, 'repo-root social.db untouched by this run');
    });

    await test('unknown /api/ paths still 404 after the social hook', async () => {
      const res = await request(server, { path: '/api/lobby/whatever' });
      assert.strictEqual(res.status, 404);
    });
  } finally {
    server.close();
    try { serverModule.stopStateWatcher(); } catch (_) {}
    try { SocialRoutes.resetSocialState(); } catch (_) {}
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
