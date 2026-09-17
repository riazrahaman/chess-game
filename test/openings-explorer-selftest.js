#!/usr/bin/env node
'use strict';

/**
 * openings-explorer-selftest.js — Real opening explorer self-tests.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const Explorer = require('../src/openings-explorer.js');
const {
  loadFromTSV,
  getTSVMap,
  exploreOpening,
  personalExplorer,
  getBundledOpenings,
  BUNDLED_OPENINGS
} = Explorer;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL: ${name} — ${err.message}`);
    failed++;
  }
}

console.log('\n=== Real Opening Explorer Self-Tests ===\n');

// --- Section 1: Module exports & bundled data ---

test('module exports all public functions', () => {
  assert.strictEqual(typeof loadFromTSV, 'function');
  assert.strictEqual(typeof getTSVMap, 'function');
  assert.strictEqual(typeof exploreOpening, 'function');
  assert.strictEqual(typeof personalExplorer, 'function');
  assert.strictEqual(typeof getBundledOpenings, 'function');
});

test('BUNDLED_OPENINGS has 25 entries matching openings-db.js', () => {
  assert.ok(BUNDLED_OPENINGS.length >= 25, 'should have at least 25 bundled openings');
});

test('getBundledOpenings returns copies', () => {
  const a = getBundledOpenings();
  const b = getBundledOpenings();
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a[0].moves, b[0].moves, 'moves arrays should be different references');
});

test('bundled entries have eco, name, moves — no fabricated stats', () => {
  for (const entry of BUNDLED_OPENINGS) {
    assert.ok(entry.eco, 'every entry should have an eco code');
    assert.ok(entry.name, 'every entry should have a name');
    assert.ok(Array.isArray(entry.moves), 'every entry should have a moves array');
    // CRITICAL: no fabricated stats property
    assert.strictEqual(entry.stats, undefined, 'bundled entries must NOT have fabricated stats');
    // CRITICAL: no fabricated frequency
    assert.strictEqual(entry.frequency, undefined, 'bundled entries must NOT have fabricated frequency');
  }
});

test('bundled Starting Position has empty moves', () => {
  const start = BUNDLED_OPENINGS.find(e => e.eco === 'A00');
  assert.ok(start);
  assert.deepStrictEqual(start.moves, []);
});

// --- Section 2: TSV parser ---

test('loadFromTSV parses basic TSV with eco/name/uci columns', () => {
  const tsv = [
    'eco\tname\tuci',
    'B00\tKing\'s Pawn Opening\te2e4',
    'C20\tOpen Game\te2e4 e7e5',
    'C40\tKing\'s Knight Opening\te2e4 e7e5 g1f3'
  ].join('\n');
  const map = loadFromTSV(tsv);
  assert.ok(map instanceof Map);
  assert.strictEqual(map.size, 3);
  assert.ok(map.has('e2e4'));
  assert.strictEqual(map.get('e2e4').eco, 'B00');
  assert.strictEqual(map.get('e2e4').name, "King's Pawn Opening");
  assert.deepStrictEqual(map.get('e2e4').moves, ['e2e4']);
});

test('loadFromTSV handles multi-move UCI sequences', () => {
  const tsv = 'eco\tname\tuci\nC50\tItalian Game\te2e4 e7e5 g1f3 b8c6 f1c4';
  const map = loadFromTSV(tsv);
  const entry = map.get('e2e4 e7e5 g1f3 b8c6 f1c4');
  assert.ok(entry);
  assert.strictEqual(entry.eco, 'C50');
  assert.deepStrictEqual(entry.moves, ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4']);
});

test('loadFromTSV handles empty/malformed input gracefully', () => {
  assert.strictEqual(loadFromTSV(null).size, 0);
  assert.strictEqual(loadFromTSV('').size, 0);
  assert.strictEqual(loadFromTSV('eco\tname\tuci').size, 0); // header only
});

test('loadFromTSV skips comment lines starting with #', () => {
  const tsv = 'eco\tname\tuci\n# this is a comment\nB00\tKing\'s Pawn\te2e4';
  const map = loadFromTSV(tsv);
  assert.strictEqual(map.size, 1);
  assert.ok(map.has('e2e4'));
});

test('loadFromTSV handles moves column name as alternative to uci', () => {
  const tsv = 'eco\tname\tmoves\nB00\tKing\'s Pawn\te2e4';
  const map = loadFromTSV(tsv);
  assert.ok(map.has('e2e4'));
});

test('loadFromTSV populates getTSVMap', () => {
  loadFromTSV('eco\tname\tuci\nB00\tTest\te2e4');
  const map = getTSVMap();
  assert.ok(map);
  assert.ok(map.has('e2e4'));
  // Clean up for subsequent tests
  loadFromTSV('');
});

// --- Section 3: exploreOpening — exact & prefix matching ---

test('exploreOpening: empty moves returns Starting Position', () => {
  const result = exploreOpening([]);
  assert.strictEqual(result.eco, 'A00');
  assert.strictEqual(result.name, 'Starting Position');
  assert.strictEqual(result.matchedPlies, 0);
  assert.strictEqual(result.isExact, true);
});

test('exploreOpening: exact match for single move e4', () => {
  const result = exploreOpening(['e2e4']);
  assert.strictEqual(result.eco, 'B00');
  assert.strictEqual(result.name, "King's Pawn Opening");
  assert.strictEqual(result.matchedPlies, 1);
  assert.strictEqual(result.isExact, true);
});

test('exploreOpening: exact match for Italian Game', () => {
  const result = exploreOpening(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4']);
  assert.strictEqual(result.eco, 'C50');
  assert.strictEqual(result.name, 'Italian Game');
  assert.strictEqual(result.matchedPlies, 5);
  assert.strictEqual(result.isExact, true);
});

test('exploreOpening: prefix match when moves go deeper than data', () => {
  // e4 e5 Nf3 Nc6 Bc4 Bc5 c3 — goes past Giuoco Piano (6 plies)
  const result = exploreOpening(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'c2c3']);
  assert.ok(result.matchedPlies >= 6, 'should match at least 6 plies (Giuoco Piano)');
  assert.strictEqual(result.isExact, false);
});

test('exploreOpening: Najdorf full 10-ply exact match', () => {
  const result = exploreOpening(['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'a7a6']);
  assert.strictEqual(result.eco, 'B90');
  assert.strictEqual(result.matchedPlies, 10);
  assert.strictEqual(result.isExact, true);
});

test('exploreOpening: no match returns Unknown Opening', () => {
  const result = exploreOpening(['h2h4', 'h7h5']);
  assert.strictEqual(result.matchedPlies, 0);
  assert.strictEqual(result.isExact, false);
});

// --- Section 4: exploreOpening with TSV loaded ---

test('exploreOpening: uses TSV map when loaded', () => {
  const tsv = 'eco\tname\tuci\nZ99\tCustom Opening\th2h4';
  loadFromTSV(tsv);
  const result = exploreOpening(['h2h4']);
  assert.strictEqual(result.eco, 'Z99');
  assert.strictEqual(result.name, 'Custom Opening');
  assert.strictEqual(result.matchedPlies, 1);
  assert.strictEqual(result.isExact, true);
  // Clean up TSV for subsequent tests
  loadFromTSV('');
});

test('exploreOpening: TSV prefix lookup works', () => {
  const tsv = [
    'eco\tname\tuci',
    'X10\tLine A\th2h4 h7h5',
    'X20\tLine B\th2h4 h7h5 g1f3'
  ].join('\n');
  loadFromTSV(tsv);
  // Query deeper than both entries
  const result = exploreOpening(['h2h4', 'h7h5', 'g1f3', 'b8c6']);
  assert.strictEqual(result.eco, 'X20');
  assert.strictEqual(result.matchedPlies, 3);
  assert.strictEqual(result.isExact, false);
  loadFromTSV('');
});

// --- Section 5: exploreOpening falls back to openings-db.js ---

test('exploreOpening: falls back to bundled data when no TSV', () => {
  loadFromTSV('');
  const result = exploreOpening(['d2d4', 'd7d5', 'c2c4']);
  assert.strictEqual(result.eco, 'D06');
  assert.strictEqual(result.name, "Queen's Gambit");
});

test('exploreOpening: returns no stats field (no fabricated data)', () => {
  loadFromTSV('');
  const result = exploreOpening(['e2e4']);
  assert.strictEqual(result.stats, undefined, 'exploreOpening must NOT return fabricated stats');
});

// --- Section 6: personalExplorer ---

test('personalExplorer: null archive returns null (graceful degradation)', () => {
  const result = personalExplorer(null, ['e2e4']);
  assert.strictEqual(result, null);
});

test('personalExplorer: archive without list/search methods returns null', () => {
  const fakeArchive = { foo: 'bar' };
  const result = personalExplorer(fakeArchive, ['e2e4']);
  assert.strictEqual(result, null);
});

test('personalExplorer: returns count 0 when no games match', () => {
  const fakeArchive = {
    listGames: () => [],
    searchGames: () => []
  };
  const result = personalExplorer(fakeArchive, ['e2e4']);
  assert.ok(result);
  assert.strictEqual(result.count, 0);
  assert.strictEqual(result.wins, 0);
  assert.strictEqual(result.draws, 0);
  assert.strictEqual(result.losses, 0);
});

test('personalExplorer: counts wins/draws/losses from real games', () => {
  const fakeArchive = {
    listGames: () => [
      { id: 'g1', moves: 'e2e4 e7e5 g1f3 b8c6', result: '1-0', white: 'A', black: 'B' },
      { id: 'g2', moves: 'e2e4 e7e5 g1f3 b8c6', result: '0-1', white: 'C', black: 'D' },
      { id: 'g3', moves: 'e2e4 e7e5 g1f3 b8c6', result: '1/2-1/2', white: 'E', black: 'F' },
      { id: 'g4', moves: 'e2e4 c7c5 g1f3', result: '1-0', white: 'G', black: 'H' }
    ]
  };
  const result = personalExplorer(fakeArchive, ['e2e4', 'e7e5', 'g1f3', 'b8c6']);
  assert.strictEqual(result.count, 3);
  assert.strictEqual(result.wins, 1);
  assert.strictEqual(result.losses, 1);
  assert.strictEqual(result.draws, 1);
  assert.strictEqual(result.winRate, 33);
  assert.strictEqual(result.lossRate, 33);
  assert.strictEqual(result.drawRate, 33);
});

test('personalExplorer: accepts string moves input', () => {
  const fakeArchive = {
    listGames: () => [
      { id: 'g1', moves: 'e2e4 e7e5', result: '1-0' }
    ]
  };
  const result = personalExplorer(fakeArchive, 'e2e4 e7e5');
  assert.strictEqual(result.count, 1);
  assert.strictEqual(result.wins, 1);
});

test('personalExplorer: does not fabricate rates when count is 0', () => {
  const fakeArchive = {
    listGames: () => []
  };
  const result = personalExplorer(fakeArchive, ['e2e4']);
  assert.strictEqual(result.count, 0);
  assert.strictEqual(result.winRate, 0);
  assert.strictEqual(result.drawRate, 0);
  assert.strictEqual(result.lossRate, 0);
});

test('personalExplorer: returns null on archive exception', () => {
  const fakeArchive = {
    listGames: () => { throw new Error('DB locked'); }
  };
  const result = personalExplorer(fakeArchive, ['e2e4']);
  assert.strictEqual(result, null);
});

test('personalExplorer: games list includes summary fields', () => {
  const fakeArchive = {
    listGames: () => [
      { id: 'g1', moves: 'e2e4 e7e5', result: '1-0', white: 'Alice', black: 'Bob', date: '2024.01.01', eco: 'C20' }
    ]
  };
  const result = personalExplorer(fakeArchive, ['e2e4', 'e7e5']);
  assert.strictEqual(result.games.length, 1);
  assert.strictEqual(result.games[0].id, 'g1');
  assert.strictEqual(result.games[0].white, 'Alice');
  assert.strictEqual(result.games[0].result, '1-0');
});

// --- Section 7: No fabricated data assertion ---

test('No fabricated stats: bundled entries have no stats property', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'openings-explorer.js'), 'utf8');
  const bundled = getBundledOpenings();
  for (const entry of bundled) {
    assert.strictEqual(entry.stats, undefined);
  }
  // The BUNDLED_OPENINGS array literal should not contain `stats:` keys
  // (except in comments explaining what we DON'T do)
  const bundledSection = code.substring(
    code.indexOf('const BUNDLED_OPENINGS'),
    code.indexOf('/* -----')
  );
  assert.ok(!bundledSection.includes('stats: {'), 'BUNDLED_OPENINGS must not contain fabricated stats objects');
});

test('No fabricated stats: exploreOpening result has no stats field', () => {
  loadFromTSV('');
  const result = exploreOpening(['e2e4', 'e7e5']);
  assert.strictEqual(result.stats, undefined, 'exploreOpening must not include fabricated stats');
});

// --- Section 8: Gate-4 invariant ---

test('Gate-4: openings-explorer.js contains no makeMove( calls', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'openings-explorer.js'), 'utf8');
  assert(!code.includes('makeMove('), 'openings-explorer.js must not call makeMove(');
});

test('Gate-4: openings-explorer.js contains no createInitialBoard( calls', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'openings-explorer.js'), 'utf8');
  assert(!code.includes('createInitialBoard('), 'openings-explorer.js must not call createInitialBoard(');
});

// --- Section 9: ECO code consistency ---

test('Bundled ECO codes match openings-db.js keys', () => {
  // Spot-check: Italian Game should be C50 in both
  const italian = BUNDLED_OPENINGS.find(e => e.eco === 'C50');
  assert.ok(italian);
  assert.strictEqual(italian.name, 'Italian Game');
  assert.deepStrictEqual(italian.moves, ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4']);

  const ruy = BUNDLED_OPENINGS.find(e => e.eco === 'C60');
  assert.ok(ruy);
  assert.strictEqual(ruy.name, 'Ruy Lopez (Spanish Opening)');
});

test('exploreOpening: Queen\'s Gambit Declined exact match', () => {
  loadFromTSV('');
  const result = exploreOpening(['d2d4', 'd7d5', 'c2c4', 'e7e6']);
  assert.strictEqual(result.eco, 'D30');
  assert.strictEqual(result.name, "Queen's Gambit Declined");
  assert.strictEqual(result.isExact, true);
});

// --- Summary ---

console.log(`\n=== Real Opening Explorer Self-Test Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
console.log('\nAll openings-explorer self-tests PASSED successfully!');