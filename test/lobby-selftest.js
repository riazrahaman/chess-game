#!/usr/bin/env node
'use strict';

const assert = require('assert');
const Lobby = require('../src/lobby.js');

let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS: ${name}`);
}

function fixedClock() {
  let now = 1000;
  return () => now++;
}

console.log('=== Lobby & Matchmaking Self-Test ===\n');

test('creates and lists open seeks with rating-store lookup', () => {
  const ratingsStore = { getPlayer: (pool, id) => ({ playerId: id, rating: pool === 'blitz' ? 1725 : 1500 }) };
  const lobby = Lobby.createLobby({ ratingsStore, now: fixedClock() });
  const seek = lobby.createSeek({ playerId: 'alice', username: 'Alice', timeControl: 'BLITZ' });
  assert.strictEqual(seek.rating, 1725);
  assert.strictEqual(seek.timeControl, 'blitz');
  assert.deepStrictEqual(lobby.listOpenSeeks().map(item => item.id), [seek.id]);
});

test('cancels an owned seek without affecting other seeks', () => {
  const lobby = Lobby.createLobby({ now: fixedClock() });
  const alice = lobby.createSeek({ playerId: 'alice' });
  lobby.createSeek({ playerId: 'bob' });
  assert.strictEqual(lobby.cancelSeek(alice.id, 'mallory'), false);
  assert.strictEqual(lobby.cancelSeek(alice.id, 'alice'), true);
  assert.deepStrictEqual(lobby.listOpenSeeks().map(item => item.playerId), ['bob']);
});

test('accepts a challenge and creates a valid room pairing', () => {
  const lobby = Lobby.createLobby({ seed: 'challenge', now: fixedClock() });
  const challenge = lobby.createChallenge({
    challengerId: 'alice', challengedId: 'bob', timeControl: 'rapid', challengerRating: 1600, challengedRating: 1580
  });
  const accepted = lobby.acceptChallenge(challenge.id, 'bob');
  assert.strictEqual(accepted.challenge.status, 'accepted');
  assert.strictEqual(accepted.pairing.timeControl, 'rapid');
  assert.strictEqual(Lobby.isValidRoomId(accepted.pairing.roomId), true);
  assert.deepStrictEqual(new Set([accepted.pairing.whiteId, accepted.pairing.blackId]), new Set(['alice', 'bob']));
  assert.strictEqual(lobby.acceptChallenge(challenge.id, 'bob'), null);
});

test('declines a challenge without creating a pairing', () => {
  const lobby = Lobby.createLobby({ now: fixedClock() });
  const challenge = lobby.createChallenge({ challengerId: 'alice', challengedId: 'bob' });
  assert.strictEqual(lobby.declineChallenge(challenge.id, 'alice'), null);
  const declined = lobby.declineChallenge(challenge.id, 'bob');
  assert.strictEqual(declined.status, 'declined');
  assert.strictEqual(lobby.pairings.size, 0);
});

test('rating-bracketed matchmaking pairs an in-range opponent', () => {
  const lobby = Lobby.createLobby({ seed: 'in-range', ratingTolerance: 100, now: fixedClock() });
  lobby.createSeek({ playerId: 'near', rating: 1580, timeControl: 'rapid' });
  lobby.createSeek({ playerId: 'far', rating: 1750, timeControl: 'rapid' });
  const pairing = lobby.matchmake({ playerId: 'requester', rating: 1600, timeControl: 'rapid' });
  assert(pairing);
  assert.strictEqual(pairing.playerBId, 'near');
  assert.strictEqual(lobby.listOpenSeeks().some(seek => seek.playerId === 'near'), false);
  assert.strictEqual(lobby.listOpenSeeks().some(seek => seek.playerId === 'far'), true);
});

test('out-of-bracket and incompatible seeks do not pair', () => {
  const lobby = Lobby.createLobby({ ratingTolerance: 50, now: fixedClock() });
  lobby.createSeek({ playerId: 'far', rating: 1800, timeControl: 'rapid' });
  lobby.createSeek({ playerId: 'wrong-pool', rating: 1510, timeControl: 'blitz' });
  lobby.createSeek({ playerId: 'unrated', rating: 1510, timeControl: 'rapid', rated: false });
  assert.strictEqual(lobby.matchmake({ playerId: 'requester', rating: 1500, timeControl: 'rapid' }), null);
  assert.strictEqual(lobby.listOpenSeeks().length, 3);
});

test('empty lobby operations do not crash', () => {
  const lobby = Lobby.createLobby();
  assert.deepStrictEqual(lobby.listOpenSeeks(), []);
  assert.deepStrictEqual(lobby.listChallenges(), []);
  assert.strictEqual(lobby.cancelSeek('missing'), false);
  assert.strictEqual(lobby.acceptChallenge('missing'), null);
  assert.strictEqual(lobby.declineChallenge('missing'), null);
  assert.strictEqual(lobby.matchmake({ playerId: 'solo', rating: 1500 }), null);
});

test('same seed deterministically selects the same equal-distance opponent', () => {
  function selectedOpponent(seed) {
    const lobby = Lobby.createLobby({ seed, now: fixedClock(), ratingTolerance: 200 });
    lobby.createSeek({ playerId: 'lower', rating: 1450 });
    lobby.createSeek({ playerId: 'upper', rating: 1550 });
    return lobby.matchmake({ playerId: 'requester', rating: 1500 }).playerBId;
  }
  assert.strictEqual(selectedOpponent('repeatable-seed'), selectedOpponent('repeatable-seed'));
});

test('custom room ids enforce the server room-id contract', () => {
  const lobby = Lobby.createLobby({ seed: 'room', now: fixedClock() });
  lobby.createSeek({ playerId: 'alice', rating: 1500 });
  const pairing = lobby.matchmake({ playerId: 'bob', rating: 1500, roomId: 'rated_room-42' });
  assert.strictEqual(pairing.roomId, 'rated_room-42');

  const invalidLobby = Lobby.createLobby({ seed: 'room-invalid', now: fixedClock() });
  invalidLobby.createSeek({ playerId: 'alice', rating: 1500 });
  assert.throws(
    () => invalidLobby.matchmake({ playerId: 'bob', rating: 1500, roomId: '../bad' }),
    /unsupported characters/
  );
});

test('acceptSeek pairs the acceptor with a specific seek and exposes pairings', () => {
  const lobby = Lobby.createLobby({ seed: 'accept', now: fixedClock() });
  const seek = lobby.createSeek({ playerId: 'alice', rating: 1500, timeControl: 'blitz' });
  assert.strictEqual(lobby.acceptSeek(seek.id, 'alice'), null, 'seeker cannot accept own seek');
  assert.strictEqual(lobby.acceptSeek('seek-999', 'bob'), null, 'unknown seek returns null');
  const accepted = lobby.acceptSeek(seek.id, 'bob', { rating: 1600, roomId: 'lobby-abc123' });
  assert.strictEqual(accepted.seek.status, 'matched');
  assert.strictEqual(accepted.pairing.roomId, 'lobby-abc123');
  assert.strictEqual(accepted.pairing.timeControl, 'blitz');
  assert.deepStrictEqual([accepted.pairing.whiteId, accepted.pairing.blackId].sort(), ['alice', 'bob']);
  assert.strictEqual(lobby.listOpenSeeks().length, 0, 'accepted seek no longer open');
  assert.strictEqual(lobby.acceptSeek(seek.id, 'carol'), null, 'a matched seek cannot be accepted twice');
  assert.strictEqual(lobby.listPairings({ playerId: 'alice' }).length, 1);
  assert.strictEqual(lobby.listPairings({ playerId: 'carol' }).length, 0);
  assert.strictEqual(lobby.getSeek(seek.id).roomId, 'lobby-abc123');
});

console.log(`\nAll ${passed} tests passed successfully!`);
