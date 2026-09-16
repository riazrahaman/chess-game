#!/usr/bin/env node
'use strict';

const assert = require('assert');
const PuzzleRacer = require('./puzzle-racer.js');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS: ${name}`); }

console.log('=== Puzzle Racer Self-Test ===\n');

function puzzles(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, fen: '8/8/8/8/8/8/8/8 w - - 0 1', rating: 1000 + i * 10 }));
}

test('race is deterministic with a fixed seed', () => {
  const a = PuzzleRacer.createRace({ puzzles: puzzles(10), seed: 's', now: 1000 });
  const b = PuzzleRacer.createRace({ puzzles: puzzles(10), seed: 's', now: 1000 });
  assert.deepStrictEqual(a.sequence.map(p => p.id), b.sequence.map(p => p.id));
});

test('a joined player starts at zero', () => {
  const race = PuzzleRacer.createRace({ puzzles: puzzles(5), now: 0 });
  race.join('alice', 0);
  const p = race.players.get('alice');
  assert.strictEqual(p.score, 0);
  assert.strictEqual(p.streak, 0);
});

test('correct answers score points and advance the shared round', () => {
  const race = PuzzleRacer.createRace({ puzzles: puzzles(5), now: 0 });
  race.join('alice', 0);
  const r1 = race.answerPuzzle('alice', true, 1000);
  assert.strictEqual(r1.gained, 2);       // 2 * 2^0
  assert.strictEqual(r1.player.score, 2);
  assert.strictEqual(race.round, 1);

  const r2 = race.answerPuzzle('alice', true, 2000);
  assert.strictEqual(r2.gained, 4);       // 2 * 2^1
  assert.strictEqual(r2.player.score, 6);
  assert.strictEqual(race.round, 2);
});

test('streak multiplier is capped', () => {
  const race = PuzzleRacer.createRace({ puzzles: puzzles(20), now: 0 });
  race.join('bob', 0);
  for (let i = 0; i < 12; i++) race.answerPuzzle('bob', true, i * 1000);
  const p = race.players.get('bob');
  assert(p.score > 0);
  // cap is ×8: beyond streak 4 gains are constant (2 * 8 = 16)
  assert.strictEqual(PuzzleRacer.MAX_STREAK_MULTIPLIER, 8);
});

test('a wrong answer resets the streak but not the score', () => {
  const race = PuzzleRacer.createRace({ puzzles: puzzles(5), now: 0 });
  race.join('carol', 0);
  race.answerPuzzle('carol', true, 1000);
  race.answerPuzzle('carol', true, 2000);
  const before = race.players.get('carol').score;
  const wrong = race.answerPuzzle('carol', false, 3000);
  assert.strictEqual(wrong.player.streak, 0);
  assert.strictEqual(wrong.player.score, before);
  assert.strictEqual(race.round, 2); // wrong answers don't advance
});

test('leaderboard sorts by score desc', () => {
  const race = PuzzleRacer.createRace({ puzzles: puzzles(10), now: 0 });
  race.join('a', 0); race.join('b', 0);
  race.answerPuzzle('a', true, 1000);
  race.answerPuzzle('a', true, 2000); // a: 6
  race.answerPuzzle('b', true, 3000); // b: 2
  const lb = race.leaderboard(0);
  assert.deepStrictEqual(lb.map(e => e.id), ['a', 'b']);
  assert.deepStrictEqual(lb.map(e => e.rank), [1, 2]);
});

test('race expires at the deadline', () => {
  const race = PuzzleRacer.createRace({ puzzles: puzzles(5), durationSec: 10, now: 0 });
  race.join('a', 0);
  assert.strictEqual(race.isActive(5000), true);
  assert.strictEqual(race.isActive(10000), false);
  const r = race.answerPuzzle('a', true, 20000);
  assert.strictEqual(r.error, 'finished');
});

test('answering without joining returns not-joined', () => {
  const race = PuzzleRacer.createRace({ puzzles: puzzles(5), now: 0 });
  assert.strictEqual(race.answerPuzzle('ghost', true, 1000).error, 'not-joined');
});

test('empty puzzle set yields no current puzzle', () => {
  const race = PuzzleRacer.createRace({ puzzles: [], now: 0 });
  assert.strictEqual(race.currentPuzzle(), null);
  assert.strictEqual(race.state(0).totalRounds, 0);
});

test('state exposes a full snapshot', () => {
  const race = PuzzleRacer.createRace({ puzzles: puzzles(3), now: 0, roomId: 'room-1' });
  race.join('a', 0);
  const s = race.state(0);
  assert.strictEqual(s.roomId, 'room-1');
  assert.strictEqual(s.finished, false);
  assert.strictEqual(s.totalRounds, 3);
  assert.strictEqual(s.leaderboard.length, 1);
});

console.log(`\nAll ${passed} tests passed successfully!`);
