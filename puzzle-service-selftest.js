#!/usr/bin/env node
'use strict';

const assert = require('assert');
const PuzzleService = require('./puzzle-service.js');

let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS: ${name}`);
}

const header = 'PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags';
const rows = [
  'alpha,"r3k2r/ppp2ppp/2n5/3pP3/8/2N5/PPP2PPP/R3K2R w KQkq d6 0 12","e5d6 e8c8",1732,74,91,1200,"mateIn2 middlegame",https://lichess.org/a,',
  'beta,"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1","e2e4 e7e5 g1f3",2050,80,88,640,"opening short",https://lichess.org/b,"Sicilian, Defense"',
  'gamma,"7k/5Q2/6K1/8/8/8/8/8 w - - 0 1",f7f8,1200,60,100,42,mateIn1,https://lichess.org/c,'
];

console.log('=== Lichess Puzzle Service Self-Test ===\n');

test('detects and skips the lichess header row', () => {
  const parsed = PuzzleService.parseLichessCsv([header, ...rows].join('\n'));
  assert.strictEqual(parsed.length, 3);
  assert.strictEqual(parsed[0].id, 'alpha');
});

test('parses FEN castling and en-passant fields intact', () => {
  const [puzzle] = PuzzleService.parseLichessCsv(rows[0]);
  assert.strictEqual(puzzle.fen, 'r3k2r/ppp2ppp/2n5/3pP3/8/2N5/PPP2PPP/R3K2R w KQkq d6 0 12');
});

test('preserves the raw multi-move Lichess UCI solution line', () => {
  const [puzzle] = PuzzleService.parseLichessCsv(rows[0]);
  assert.deepStrictEqual(puzzle.movesUci, ['e5d6', 'e8c8']);
});

test('converts the multi-move UCI solution line to SAN from its FEN', () => {
  const [puzzle] = PuzzleService.parseLichessCsv(rows[0]);
  assert.deepStrictEqual(puzzle.moves, ['exd6', 'O-O-O']);
});

test('exports UCI-to-SAN conversion for puzzle consumers', () => {
  assert.strictEqual(typeof PuzzleService.uciToSan, 'function');
  assert.deepStrictEqual(
    PuzzleService.uciToSan('7k/5Q2/6K1/8/8/8/8/8 w - - 0 1', ['f7f8']),
    ['Qf8#']
  );
});

test('parses numeric ratings and multiple themes', () => {
  const [puzzle] = PuzzleService.parseLichessCsv(rows[0]);
  assert.strictEqual(puzzle.rating, 1732);
  assert.deepStrictEqual(puzzle.themes, ['mateIn2', 'middlegame']);
});

test('handles quoted fields containing commas', () => {
  const parsed = PuzzleService.parseLichessCsv(rows[1]);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].id, 'beta');
  assert.deepStrictEqual(parsed[0].movesUci, ['e2e4', 'e7e5', 'g1f3']);
  assert.deepStrictEqual(parsed[0].moves, ['e4', 'e5', 'Nf3']);
});

test('handles CRLF input and a trailing line ending', () => {
  const parsed = PuzzleService.parseLichessCsv(`${header}\r\n${rows.join('\r\n')}\r\n`);
  assert.strictEqual(parsed.length, 3);
  assert.strictEqual(parsed[2].id, 'gamma');
});

test('loads parsed puzzles into the in-memory store', () => {
  const loaded = PuzzleService.loadPuzzles([header, ...rows].join('\n'));
  assert.strictEqual(loaded.length, 3);
  assert.strictEqual(PuzzleService.puzzleCount(), 3);
});

test('retrieves a stored puzzle by id', () => {
  assert.strictEqual(PuzzleService.getPuzzle('beta').rating, 2050);
  assert.strictEqual(PuzzleService.getPuzzle('missing'), null);
});

test('returns a random puzzle from the store', () => {
  const random = PuzzleService.getRandomPuzzle();
  assert(random);
  assert(['alpha', 'beta', 'gamma'].includes(random.id));
  assert.strictEqual(PuzzleService.getPuzzle(random.id), random);
});

console.log(`\nAll ${passed} tests passed successfully!`);
