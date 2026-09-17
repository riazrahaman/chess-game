#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Accounts = require('../src/accounts.js');

let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS: ${name}`);
}

function memoryManager() {
  return new Accounts.AccountsManager({ storage: null });
}

console.log('=== Accounts & Profiles Self-Test ===\n');

test('create and verify account round-trip succeeds', () => {
  const manager = memoryManager();
  const created = manager.createAccount({ username: 'Riaz', password: 'local-first-secret' });
  const verified = manager.verifyAccount({ username: 'Riaz', password: 'local-first-secret' });
  assert(created.id);
  assert.deepStrictEqual(verified, created);
});

test('wrong password is rejected', () => {
  const manager = memoryManager();
  manager.createAccount({ username: 'Player', password: 'correct-password' });
  assert.strictEqual(manager.verifyAccount({ username: 'Player', password: 'wrong-password' }), null);
});

test('duplicate usernames are rejected case-insensitively', () => {
  const manager = memoryManager();
  manager.createAccount({ username: 'ChessFan', password: 'first-password' });
  assert.throws(
    () => manager.createAccount({ username: ' chessfan ', password: 'second-password' }),
    error => error && error.code === 'ACCOUNT_EXISTS'
  );
});

test('verifyPassword uses crypto.timingSafeEqual', () => {
  const storedHash = Accounts.hashPassword('timing-secret', 'fixed-test-salt');
  const original = crypto.timingSafeEqual;
  let comparisons = 0;
  crypto.timingSafeEqual = function instrumentedTimingSafeEqual(left, right) {
    comparisons++;
    return original(left, right);
  };
  try {
    assert.strictEqual(Accounts.verifyPassword('timing-secret', storedHash), true);
    assert.strictEqual(Accounts.verifyPassword('not-the-secret', storedHash), false);
  } finally {
    crypto.timingSafeEqual = original;
  }
  assert.strictEqual(comparisons, 2);
});

test('public account lookups never expose password material', () => {
  const manager = memoryManager();
  const created = manager.createAccount({ username: 'Private', password: 'hidden-password' });
  for (const account of [created, manager.getAccount('Private'), manager.getAccountById(created.id)]) {
    assert(account);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(account, 'password'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(account, 'passwordHash'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(account, 'salt'), false);
  }
});

test('JSON adapter persists accounts across manager instances', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-accounts-'));
  const jsonPath = path.join(directory, 'accounts.json');
  try {
    const first = new Accounts.AccountsManager({ forceJson: true, jsonPath });
    const created = first.createAccount({ username: 'Persistent', password: 'saved-password' });
    first.close();
    const second = new Accounts.AccountsManager({ forceJson: true, jsonPath });
    assert.deepStrictEqual(second.verifyAccount({ username: 'Persistent', password: 'saved-password' }), created);
    second.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('playerProfile aggregates history, openings, and accuracy trend', () => {
  const records = [
    { id: 'g1', white: 'Riaz', black: 'A', result: '1-0', eco: 'C20', opening: 'Open Game', date: '2026.01.01', created_at: 1, review: { whiteAccuracy: 92 } },
    { id: 'g2', white: 'B', black: 'Riaz', result: '0-1', eco: 'C20', opening: 'Open Game', date: '2026.01.02', created_at: 2, blackAccuracy: 84 },
    { id: 'g3', white: 'Riaz', black: 'C', result: '0-1', eco: 'B20', opening: 'Sicilian Defense', date: '2026.01.03', created_at: 3, accuracy: { white: 71 } },
    { id: 'g4', white: 'D', black: 'Riaz', result: '1/2-1/2', eco: 'B20', opening: 'Sicilian Defense', date: '2026.01.04', created_at: 4, moves: ['e2e4', 'c7c5'], evalHistory: [0, 20, 10] },
    { id: 'noise', white: 'NotRiaz', black: 'Malice', result: '1-0', eco: 'A00', date: '2026.01.05', created_at: 5 }
  ];
  const archive = { searchGames: () => records };
  const profile = Accounts.playerProfile(archive, 'riaz');
  assert.strictEqual(profile.totalGames, 4);
  assert.strictEqual(profile.wins, 2);
  assert.strictEqual(profile.draws, 1);
  assert.strictEqual(profile.losses, 1);
  assert.strictEqual(profile.winRate, 50);
  assert.strictEqual(profile.games.some(game => game.id === 'noise'), false);

  const openGame = profile.winRateByOpening.find(item => item.eco === 'C20');
  const sicilian = profile.winRateByOpening.find(item => item.eco === 'B20');
  assert.deepStrictEqual(
    { games: openGame.games, wins: openGame.wins, winRate: openGame.winRate },
    { games: 2, wins: 2, winRate: 100 }
  );
  assert.deepStrictEqual(
    { games: sicilian.games, wins: sicilian.wins, draws: sicilian.draws, losses: sicilian.losses },
    { games: 2, wins: 0, draws: 1, losses: 1 }
  );
  assert.strictEqual(profile.accuracyTrend.length, 4);
  assert.deepStrictEqual(profile.accuracyTrend.slice(0, 3).map(point => point.accuracy), [92, 84, 71]);
  assert(Number.isFinite(profile.accuracyTrend[3].accuracy));
});

test('playerProfile degrades to an empty profile for null or failing archives', () => {
  const noArchive = Accounts.playerProfile(null, 'Nobody');
  assert.strictEqual(noArchive.totalGames, 0);
  assert.deepStrictEqual(noArchive.winRateByOpening, []);
  assert.deepStrictEqual(noArchive.accuracyTrend, []);

  const failing = Accounts.playerProfile({ searchGames: () => { throw new Error('offline'); } }, 'Nobody');
  assert.strictEqual(failing.totalGames, 0);
});

console.log(`\nAll ${passed} tests passed successfully!`);
