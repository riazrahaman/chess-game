#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const GameArchive = require('../src/game-archive.js');
const RatingsPool = require('../src/ratings-pool.js');

let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS: ${name}`);
}

function established(id, rating) {
  return { id, username: id, rating, rd: 80, vol: 0.06 };
}

console.log('=== Ratings Pool & Leaderboard Self-Test ===\n');

test('time-control pools remain separated', () => {
  const store = new RatingsPool.RatingsPoolStore({ archive: null });
  store.setPlayer('blitz', established('alice', 1700));
  store.setPlayer('rapid', established('alice', 1400));
  assert.strictEqual(store.getPlayer('blitz', 'alice').rating, 1700);
  assert.strictEqual(store.getPlayer('rapid', 'alice').rating, 1400);
});

test('RD above 110 is provisional while the boundary is established', () => {
  assert.strictEqual(RatingsPool.isProvisional({ rd: 111 }), true);
  assert.strictEqual(RatingsPool.isProvisional({ rd: 110 }), false);
  assert.strictEqual(RatingsPool.createPoolPlayer({ id: 'newcomer' }).provisional, true);
});

test('bot games are explicitly unrated and leave human rating unchanged', () => {
  let persistenceWrites = 0;
  const archive = {
    savePoolRating() { persistenceWrites++; },
    getPoolRating() { return null; }
  };
  const store = new RatingsPool.RatingsPoolStore({ archive });
  store.setPlayer('blitz', established('human', 1500));
  const before = store.getPlayer('blitz', 'human');
  persistenceWrites = 0;
  const result = store.recordMatch({
    timeControl: 'blitz',
    playerA: 'human',
    playerB: { id: 'bot-8', isBot: true, rating: 2200, rd: 50 },
    result: 'win'
  });
  assert.strictEqual(result.rated, false);
  assert.strictEqual(result.reason, 'bot-game');
  assert.deepStrictEqual(store.getPlayer('blitz', 'human'), before);
  assert.strictEqual(persistenceWrites, 0);
});

test('unknown bots never enter human pool membership after an unrated match', () => {
  const store = new RatingsPool.RatingsPoolStore({ archive: null });
  store.setPlayer('blitz', established('human', 1500));
  const before = store.getLeaderboard('blitz').map(player => player.playerId);
  assert.deepStrictEqual(before, ['human']);

  store.recordMatch({
    timeControl: 'blitz',
    playerA: 'human',
    playerB: { id: 'unknown-bot', username: 'Unknown Bot', isBot: true, rating: 2200, rd: 50 },
    result: 'loss'
  });

  const after = store.getLeaderboard('blitz').map(player => player.playerId);
  assert.deepStrictEqual(after, ['human']);
  assert.strictEqual(store.pools.get('blitz').has('unknown-bot'), false);
});

test('peekPlayer is read-only: unknown players return null and never enter the pool', () => {
  const store = new RatingsPool.RatingsPoolStore({ archive: null });
  assert.strictEqual(store.peekPlayer('blitz', 'ghost'), null);
  assert.strictEqual(store.getLeaderboard('blitz', { includeProvisional: true }).length, 0);
  store.recordMatch({ timeControl: 'blitz', playerA: 'alice', playerB: 'bob', result: 'win' });
  assert.ok(store.peekPlayer('blitz', 'alice').rating > 1500);
  assert.strictEqual(store.peekPlayer('rapid', 'alice'), null, 'pools stay separated');
});

test('rated human games update both Glicko-2 states', () => {
  const store = new RatingsPool.RatingsPoolStore({ archive: null });
  store.setPlayer('rapid', established('winner', 1500));
  store.setPlayer('rapid', established('loser', 1500));
  const result = store.recordMatch({
    timeControl: 'rapid', playerA: 'winner', playerB: 'loser', result: 'win'
  });
  assert.strictEqual(result.rated, true);
  assert(result.playerA.rating > 1500);
  assert(result.playerB.rating < 1500);
  assert.strictEqual(store.getPlayer('rapid', 'winner').rating, result.playerA.rating);
});

test('leaderboard sorts established players and excludes provisionals by default', () => {
  const players = [
    established('second', 1800),
    established('first', 2000),
    { id: 'provisional', rating: 2300, rd: 111, vol: 0.06 }
  ];
  const board = RatingsPool.getLeaderboard(players);
  assert.deepStrictEqual(board.map(entry => entry.playerId), ['first', 'second']);
  assert.deepStrictEqual(board.map(entry => entry.rank), [1, 2]);
  assert(board.every(entry => entry.provisional === false));
  assert(board.every(entry => Number.isFinite(entry.confidence.low) && Number.isFinite(entry.confidence.high)));

  const withProvisional = RatingsPool.getLeaderboard(players, { includeProvisional: true });
  assert.strictEqual(withProvisional[2].playerId, 'provisional');
  assert.strictEqual(withProvisional[2].rank, null);
  assert.strictEqual(withProvisional[2].provisional, true);
});

test('archive persistence round-trips pool state and lists it for leaderboards', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-ratings-pool-'));
  const jsonPath = path.join(directory, 'archive.json');
  try {
    const firstArchive = GameArchive.createGameArchive({ forceJson: true, jsonPath });
    const first = new RatingsPool.RatingsPoolStore({ archive: firstArchive });
    first.setPlayer('classical', established('persisted', 1875));
    firstArchive.close();

    const secondArchive = GameArchive.createGameArchive({ forceJson: true, jsonPath });
    const second = new RatingsPool.RatingsPoolStore({ archive: secondArchive });
    assert.strictEqual(second.getPlayer('classical', 'persisted').rating, 1875);
    assert.strictEqual(second.getLeaderboard('classical')[0].playerId, 'persisted');
    assert.strictEqual(secondArchive.listPoolRatings('blitz').length, 0);
    secondArchive.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite ratings_pool persistence round-trips when available', () => {
  const archive = GameArchive.createGameArchive({ dbPath: ':memory:' });
  const store = new RatingsPool.RatingsPoolStore({ archive });
  store.setPlayer('rapid', established('sqlite-player', 1650));
  assert.strictEqual(archive.getPoolRating('rapid', 'sqlite-player').rating, 1650);
  assert.strictEqual(archive.listPoolRatings('rapid').length, 1);
  archive.close();
});

test('null or failing archives degrade to the in-memory pool', () => {
  const memory = new RatingsPool.RatingsPoolStore({ archive: null });
  memory.setPlayer('rapid', established('memory-player', 1600));
  assert.strictEqual(memory.getLeaderboard('rapid')[0].rating, 1600);

  const failing = new RatingsPool.RatingsPoolStore({
    archive: {
      savePoolRating() { throw new Error('offline'); },
      getPoolRating() { throw new Error('offline'); },
      listPoolRatings() { throw new Error('offline'); }
    }
  });
  failing.setPlayer('blitz', established('offline-player', 1550));
  assert.strictEqual(failing.getPlayer('blitz', 'offline-player').rating, 1550);
  assert.strictEqual(failing.getLeaderboard('blitz').length, 1);
});

test('browser-compatible module is present in the server allowlist', () => {
  const serverSource = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  assert(serverSource.includes("'src/ratings-pool.js'"));
});

console.log(`\nAll ${passed} tests passed successfully!`);
