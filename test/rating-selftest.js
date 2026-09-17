#!/usr/bin/env node
'use strict';

// Glicko-2 Rating Engine Self-Test
// Validates the Glicko-2 implementation against known values from
// Mark Glickman's paper "Example of the Glicko-2 system" (2013).
// http://www.glicko.net/glicko/glicko2.pdf

const rating = require('../src/rating.js');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`PASS: ${message}`);
    passed++;
  } else {
    console.error(`FAIL: ${message}`);
    failed++;
  }
}

function approx(actual, expected, tolerance) {
  return Math.abs(actual - expected) < tolerance;
}

console.log('=== Glicko-2 Rating Engine Self-Test ===\n');

// --- Section 1: Module exports & constants ---

console.log('--- Section 1: Module Exports & Constants ---');
assert(typeof rating.createPlayer === 'function', 'createPlayer is exported');
assert(typeof rating.updateRating === 'function', 'updateRating is exported');
assert(typeof rating.rateMatches === 'function', 'rateMatches is exported');
assert(typeof rating.expectedScore === 'function', 'expectedScore is exported');
assert(typeof rating.confidenceInterval === 'function', 'confidenceInterval is exported');
assert(rating.GLICKO2_SCALE === 173.7178, `GLICKO2_SCALE = 173.7178 (got ${rating.GLICKO2_SCALE})`);
assert(rating.EPSILON === 0.000001, `EPSILON = 0.000001 (got ${rating.EPSILON})`);
assert(rating.DEFAULT_TAU === 0.5, `DEFAULT_TAU = 0.5 (got ${rating.DEFAULT_TAU})`);

// --- Section 2: createPlayer defaults ---

console.log('\n--- Section 2: createPlayer Defaults ---');
const p = rating.createPlayer();
assert(p.rating === 1500, `Default rating = 1500 (got ${p.rating})`);
assert(p.rd === 350, `Default rd = 350 (got ${p.rd})`);
assert(p.vol === 0.06, `Default vol = 0.06 (got ${p.vol})`);

const p2 = rating.createPlayer(2000, 100, 0.05);
assert(p2.rating === 2000 && p2.rd === 100 && p2.vol === 0.05, 'Custom player values preserved');

// --- Section 3: Glickman Paper Test Case (Known Values) ---
// The paper provides a worked example:
//   Player: rating=1500, RD=200, vol=0.06
//   3 opponents + results:
//     Opponent 1: 1400, 30, 0.06 → score = 1.0 (win)
//     Opponent 2: 1550, 100, 0.05 → score = 0.0 (loss)
//     Opponent 3: 1700, 300, 0.07 → score = 0.0 (loss)
//   tau = 0.5
//
// Expected results (from paper, rounded):
//   New rating ≈ 1464.06
//   New RD ≈ 151.52
//   New vol ≈ 0.05999

console.log('\n--- Section 3: Glickman Paper Known-Value Test ---');

const player = rating.createPlayer(1500, 200, 0.06);
const opp1 = rating.createPlayer(1400, 30, 0.06);
const opp2 = rating.createPlayer(1550, 100, 0.05);
const opp3 = rating.createPlayer(1700, 300, 0.07);

const matches = [
  { opponent: opp1, score: 1.0 },
  { opponent: opp2, score: 0.0 },
  { opponent: opp3, score: 0.0 }
];

const result = rating.updateRating(player, matches, 0.5);

assert(
  approx(result.rating, 1464.06, 2),
  `Paper test: new rating ≈ 1464.06 (got ${result.rating.toFixed(2)})`
);
assert(
  approx(result.rd, 151.52, 2),
  `Paper test: new RD ≈ 151.52 (got ${result.rd.toFixed(2)})`
);
assert(
  approx(result.vol, 0.05999, 0.002),
  `Paper test: new vol ≈ 0.05999 (got ${result.vol.toFixed(6)})`
);

// --- Section 4: No-game RD inflation ---

console.log('\n--- Section 4: No-Game RD Inflation ---');
const idlePlayer = rating.createPlayer(1500, 200, 0.06);
const idleResult = rating.updateRating(idlePlayer, [], 0.5);
assert(idleResult.rating === 1500, `No-game: rating unchanged (got ${idleResult.rating})`);
assert(idleResult.rd > 200, `No-game: RD inflated > 200 (got ${idleResult.rd.toFixed(2)})`);
assert(idleResult.vol === 0.06, `No-game: vol unchanged (got ${idleResult.vol})`);

// RD inflation formula: phi* = sqrt(phi^2 + sigma^2), back to Glicko scale
const expectedRd = Math.sqrt((200 / 173.7178) ** 2 + 0.06 ** 2) * 173.7178;
assert(
  approx(idleResult.rd, expectedRd, 0.01),
  `No-game: RD matches formula phi*=${expectedRd.toFixed(4)} (got ${idleResult.rd.toFixed(4)})`
);

// --- Section 5: expectedScore ---

console.log('\n--- Section 5: expectedScore ---');
const es = rating.expectedScore(
  rating.createPlayer(1500, 350),
  rating.createPlayer(1500, 350)
);
assert(approx(es, 0.5, 0.01), `Equal players: expected score ≈ 0.5 (got ${es.toFixed(4)})`);

const esHigher = rating.expectedScore(
  rating.createPlayer(1800, 100),
  rating.createPlayer(1500, 100)
);
assert(esHigher > 0.7, `Higher-rated player expected > 0.7 (got ${esHigher.toFixed(4)})`);
assert(esHigher < 1.0, `Expected score < 1.0 (got ${esHigher.toFixed(4)})`);

// --- Section 6: confidenceInterval ---

console.log('\n--- Section 6: confidenceInterval ---');
const ci = rating.confidenceInterval(rating.createPlayer(1500, 100));
assert(approx(ci.low, 1304, 1), `CI low ≈ 1500-1.96*100=1304 (got ${ci.low.toFixed(2)})`);
assert(approx(ci.high, 1696, 1), `CI high ≈ 1500+1.96*100=1696 (got ${ci.high.toFixed(2)})`);

// --- Section 7: rateMatches multi-player ---

console.log('\n--- Section 7: rateMatches Multi-Player ---');
const players = [
  rating.createPlayer(1500, 350, 0.06),
  rating.createPlayer(1400, 30, 0.06),
  rating.createPlayer(1550, 100, 0.05)
];
const matchResults = [
  { playerIdx: 0, opponentIdx: 1, score: 1.0 },
  { playerIdx: 0, opponentIdx: 2, score: 0.5 },
  { playerIdx: 1, opponentIdx: 0, score: 0.0 },
  { playerIdx: 1, opponentIdx: 2, score: 1.0 },
  { playerIdx: 2, opponentIdx: 0, score: 0.5 },
  { playerIdx: 2, opponentIdx: 1, score: 0.0 }
];
const updatedPlayers = rating.rateMatches(players, matchResults, 0.5);
assert(Array.isArray(updatedPlayers) && updatedPlayers.length === 3, 'rateMatches returns 3 players');
assert(updatedPlayers[0].rating > 1500, `Player 0 (won vs 1400, drew vs 1550): rating increased (got ${updatedPlayers[0].rating.toFixed(2)})`);
assert(updatedPlayers[1].rating > 1400, `Player 1 (lost vs 1500, won vs 1550): rating changed (got ${updatedPlayers[1].rating.toFixed(2)})`);

// --- Section 8: rateMatches no results (RD inflation for all) ---

console.log('\n--- Section 8: rateMatches No Results ---');
const noResultPlayers = [
  rating.createPlayer(1500, 200, 0.06),
  rating.createPlayer(1800, 100, 0.06)
];
const noResultUpdated = rating.rateMatches(noResultPlayers, [], 0.5);
assert(noResultUpdated[0].rating === 1500, 'No-results: player 0 rating unchanged');
assert(noResultUpdated[0].rd > 200, `No-results: player 0 RD inflated (got ${noResultUpdated[0].rd.toFixed(2)})`);
assert(noResultUpdated[1].rating === 1800, 'No-results: player 1 rating unchanged');
assert(noResultUpdated[1].rd > 100, `No-results: player 1 RD inflated (got ${noResultUpdated[1].rd.toFixed(2)})`);

// --- Section 9: Multiple rating periods (convergence) ---

console.log('\n--- Section 9: Multiple Rating Periods (Convergence) ---');
let pConverge = rating.createPlayer(1500, 200, 0.06);
const strongOpp = rating.createPlayer(1900, 50, 0.05);
for (let i = 0; i < 25; i++) {
  pConverge = rating.updateRating(pConverge, [{ opponent: strongOpp, score: 0.0 }], 0.5);
}
assert(pConverge.rd < 140, `After 25 losses: RD converges < 140 (got ${pConverge.rd.toFixed(2)})`);
assert(pConverge.rating < 1400, `After 25 losses vs 1900: rating < 1400 (got ${pConverge.rating.toFixed(2)})`);

// --- Section 10: Draw vs Decisive produces different ratings ---
// In Glicko-2, RD (phi) depends on opponent uncertainty and game count,
// not on the score — so RD is nearly identical for the same opponent set.
// However, the rating (mu) change differs: a win pushes up, a draw keeps
// near the expected, and a loss pushes down.

console.log('\n--- Section 10: Draw vs Decisive Rating Changes ---');
const drawPlayer = rating.updateRating(
  rating.createPlayer(1500, 350, 0.06),
  [{ opponent: rating.createPlayer(1800, 100, 0.06), score: 0.5 }],
  0.5
);
const winPlayer = rating.updateRating(
  rating.createPlayer(1500, 350, 0.06),
  [{ opponent: rating.createPlayer(1800, 100, 0.06), score: 1.0 }],
  0.5
);
const lossPlayer = rating.updateRating(
  rating.createPlayer(1500, 350, 0.06),
  [{ opponent: rating.createPlayer(1800, 100, 0.06), score: 0.0 }],
  0.5
);
assert(winPlayer.rating > drawPlayer.rating, `Win rating (${winPlayer.rating.toFixed(2)}) > Draw rating (${drawPlayer.rating.toFixed(2)})`);
assert(drawPlayer.rating > lossPlayer.rating, `Draw rating (${drawPlayer.rating.toFixed(2)}) > Loss rating (${lossPlayer.rating.toFixed(2)})`);
assert(drawPlayer.rating > 1500, `Draw vs higher opponent: rating increases (${drawPlayer.rating.toFixed(2)})`);

console.log(`\n=== Glicko-2 Self-Test Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

process.exit(failed === 0 ? 0 : 1);