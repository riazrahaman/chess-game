#!/usr/bin/env node
'use strict';

/**
 * missed-tactics-bounded-selftest.js — perf-missed-tactics-bounded.
 *
 * Pins the per-request budget in src/routes-review.js evaluatePositions():
 * a cold, long game must never launch more than REVIEW_MAX_EVALS new engine
 * searches or spend more than REVIEW_BUDGET_MS wall clock on them, cache hits
 * and terminal positions are free, and every position skipped for a budget
 * reason comes back as a null eval with `truncated` set.
 *
 * Fast + deterministic: no server, no network, no Stockfish. The engine seam
 * is `evaluatePositions(positions, gameArchive, opts)` where opts.analyser is a
 * stub `{ isAvailable(), analyse(), ENGINE_NAME }` and opts.maxEvals /
 * opts.budgetMs override the module defaults. The same seam is exercised by the
 * real route when opts is omitted (analyser/now default to engineServer/Date.now).
 */

const routesReview = require('../src/routes-review.js');
const missedTactics = require('../src/missed-tactics.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS: ' + name);
  } catch (err) {
    failed++;
    console.error('FAIL: ' + name + ' — ' + (err && err.message ? err.message : err));
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS: ' + name);
  } catch (err) {
    failed++;
    console.error('FAIL: ' + name + ' — ' + (err && err.message ? err.message : err));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Valid, non-terminal FENs so terminalEval() always falls through to the
// analyser (terminal positions would be scored for free and consume no budget).
const FENS = [
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
  'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
  'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
  'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
  'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
  'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
  'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R b KQkq - 0 4',
  'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 1 5',
  'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2PP1N2/PP3PPP/RNBQK2R b KQkq - 0 5',
  'r1bqk2r/ppp2ppp/2np1n2/2b1p3/2B1P3/2PP1N2/PP3PPP/RNBQK2R w KQkq - 0 6',
  'r1bqk2r/ppp2ppp/2np1n2/2b1p3/1PB1P3/2PP1N2/P4PPP/RNBQK2R b KQkq - 0 6',
  'r1bqk2r/ppp2ppp/1bnp1n2/4p3/1PB1P3/2PP1N2/P4PPP/RNBQK2R w KQkq - 1 7'
];

function positionsFrom(fens) { return fens.map(fen => ({ fen })); }

function fakeArchive(store) {
  const map = store || new Map();
  return {
    map,
    getEval(fen) { return map.has(fen) ? map.get(fen) : null; },
    saveEval(fen, ev) { map.set(fen, ev); }
  };
}

/** Stub analyser: counts calls, advances a virtual clock by `tickMs` per call. */
function stubAnalyser(clock, tickMs) {
  return {
    calls: 0,
    ENGINE_NAME: 'stub-engine',
    isAvailable() { return true; },
    analyse() {
      this.calls++;
      clock.value += tickMs;
      return Promise.resolve({
        engine: this.ENGINE_NAME,
        bestMove: 'e2e4',
        lines: [{ move: 'e2e4', scoreCp: 20, mate: null, depth: 12 }]
      });
    }
  };
}

/** Cache every position at depth >= REVIEW_DEPTH so cacheUsable() is true. */
function primeAll(archive, fens) {
  for (const fen of fens) archive.saveEval(fen, { cp: 10, mate: null, bestmove: 'e2e4', depth: routesReview.REVIEW_DEPTH });
}

function cachedCountOf(evals) { return evals.filter(e => e && typeof e.depth === 'number').length; }

async function main() {
  console.log('=== missed-tactics bounded budget ===');

  await testAsync('(a) every eval is stored in the archive and readable back', async () => {
    const archive = fakeArchive();
    const clock = { value: 0 };
    const analyser = stubAnalyser(clock, 10);
    const positions = positionsFrom(FENS);
    const r = await routesReview.evaluatePositions(positions, archive, { analyser, now: () => clock.value, maxEvals: 100, budgetMs: 100000 });
    assert(r.evaluated === FENS.length, 'all positions evaluated: ' + r.evaluated + '/' + FENS.length);
    assert(r.evals.length === FENS.length, 'evals length matches positions: ' + r.evals.length);
    assert(r.evals.every(Boolean), 'no null evals when unbounded');
    assert(archive.map.size === FENS.length, 'every eval persisted: ' + archive.map.size);
    const saved = archive.getEval(FENS[3]);
    assert(saved && typeof saved.cp === 'number' && saved.cp === r.evals[3].cp, 'saved eval is readable and matches the returned eval');
  });

  await testAsync('(b) REVIEW_MAX_EVALS caps NEW searches; unevaluated positions are null + truncated', async () => {
    const archive = fakeArchive();
    const clock = { value: 0 };
    const analyser = stubAnalyser(clock, 100000); // wall clock no issue; count is the limit
    const maxEvals = 5;
    const positions = positionsFrom(FENS);
    const r = await routesReview.evaluatePositions(positions, archive, { analyser, now: () => clock.value, maxEvals, budgetMs: 100000000 });
    assert(analyser.calls === maxEvals, 'exactly maxEvals engine searches ran: ' + analyser.calls);
    assert(r.evaluated === maxEvals, 'evaluated === maxEvals: ' + r.evaluated);
    assert(r.truncated === true, 'truncated set when the count cap is hit');
    assert(r.truncatedReason === 'budget', 'truncatedReason is budget: ' + r.truncatedReason);
    assert(r.evals.length === FENS.length, 'response still covers every position: ' + r.evals.length);
    assert(r.evals.slice(0, maxEvals).every(Boolean), 'the first maxEvals evals are present');
    assert(r.evals.slice(maxEvals).every(e => e === null), 'every skipped position is null');
  });

  await testAsync('(c) REVIEW_BUDGET_MS caps wall clock for NEW searches', async () => {
    const archive = fakeArchive();
    const clock = { value: 0 };
    const analyser = stubAnalyser(clock, 100); // 100 ms per search
    const positions = positionsFrom(FENS);
    const r = await routesReview.evaluatePositions(positions, archive, { analyser, now: () => clock.value, maxEvals: 1000, budgetMs: 300 });
    // Searches 1,2,3 run (clock 300 after the third); the 4th is blocked because
    // elapsed (300) >= budget (300). In-flight search may overshoot by one tick.
    assert(analyser.calls === 3, 'wall-clock budget stopped after 3 searches: ' + analyser.calls);
    assert(r.evaluated === 3, 'evaluated === 3: ' + r.evaluated);
    assert(r.truncated === true && r.truncatedReason === 'budget', 'truncated for the wall-clock budget: ' + r.truncatedReason);
    assert(r.evals.slice(3).every(e => e === null), 'positions after the budget are null');
  });

  await testAsync('(d) cache hits do NOT consume budget and a fully-cached game is never truncated', async () => {
    const archive = fakeArchive();
    primeAll(archive, FENS);
    const clock = { value: 0 };
    const analyser = stubAnalyser(clock, 99999);
    const positions = positionsFrom(FENS);
    const r = await routesReview.evaluatePositions(positions, archive, { analyser, now: () => clock.value, maxEvals: 0, budgetMs: 0 });
    assert(analyser.calls === 0, 'no engine search on a fully-cached game: ' + analyser.calls);
    assert(r.cached === FENS.length, 'every position counted as cached: ' + r.cached);
    assert(r.evaluated === 0, 'no new eval counted: ' + r.evaluated);
    assert(r.truncated === false && r.truncatedReason === null, 'fully-cached game is not truncated');
    assert(r.evals.length === FENS.length && r.evals.every(Boolean), 'all cached evals returned');
    assert(cachedCountOf(r.evals) === FENS.length, 'all returned evals carry their depth');
    // With a maxEvals=2 budget, exactly 2 new searches run and the rest are null.
    const archive2 = fakeArchive();
    primeAll(archive2, FENS.slice(0, 4));
    const analyser2 = stubAnalyser(clock, 10);
    const r2 = await routesReview.evaluatePositions(positions, archive2, { analyser: analyser2, now: () => clock.value, maxEvals: 2, budgetMs: 1000000 });
    assert(analyser2.calls === 2, 'cache hits did not consume the count budget: ' + analyser2.calls);
    assert(r2.cached === 4, 'cached count is exact: ' + r2.cached);
    assert(r2.evaluated === 2, 'exactly the remaining budget of new evals: ' + r2.evaluated);
    assert(cachedCountOf(r2.evals) === 6, '4 cached + 2 new are non-null: ' + cachedCountOf(r2.evals));
    assert(r2.evals.slice(6).every(e => e === null), 'the budgeted-out tail is null');
    assert(r2.truncated === true, 'the budgeted game is truncated');
  });

  await testAsync('(e) terminal evals do NOT consume the count budget; maxEvals 0 means no new evals', async () => {
    // A one-ply game ending in checkmate: positions[0] is the opening (engine),
    // positions[1] is mate (terminal, no engine). With maxEvals 0 the opening
    // search is blocked, the terminal mate is still scored for free.
    const archive = fakeArchive();
    const clock = { value: 0 };
    const analyser = stubAnalyser(clock, 10);
    const positions = [
      { fen: FENS[0] },
      { fen: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3' } // 2.f3?? Qh4# — White to move, mated
    ];
    const r = await routesReview.evaluatePositions(positions, archive, { analyser, now: () => clock.value, maxEvals: 0, budgetMs: 100000 });
    assert(analyser.calls === 0, 'no engine call with maxEvals 0: ' + analyser.calls);
    assert(r.evals[0] === null, 'the uncached opening is skipped under a 0 budget');
    assert(r.evals[1] && typeof r.evals[1].cp === 'number', 'the terminal mate is scored for free');
    assert(r.truncated === true, 'skipping the opening still marks truncation');
    assert(r.truncatedReason === 'budget', 'the reason for the 0 budget is budget: ' + r.truncatedReason);

    // [engine, TERMINAL, engine] with maxEvals 2: the middle terminal must not
    // consume the count budget, so BOTH real engine searches run unharmed.
    const archive2 = fakeArchive();
    const analyser2 = stubAnalyser(clock, 10);
    const mixed = [
      { fen: FENS[0] },
      { fen: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3' }, // terminal mate
      { fen: FENS[2] }
    ];
    const r2 = await routesReview.evaluatePositions(mixed, archive2, { analyser: analyser2, now: () => clock.value, maxEvals: 2, budgetMs: 100000 });
    assert(analyser2.calls === 2, 'both engine positions ran despite the terminal between them: ' + analyser2.calls);
    assert(r2.evaluated === 3, 'all three positions scored (2 engine + 1 terminal): ' + r2.evaluated);
    assert(r2.truncated === false && r2.truncatedReason === null, 'the terminal did not exhaust the count budget');
    assert(r2.evals.every(Boolean), 'all three evals are present');
  });

  await testAsync('(f) findMissedTactics tolerates null evals (does not fabricate or throw)', async () => {
    const positions = positionsFrom(FENS);
    const evals = FENS.map((_, i) => (i % 3 === 1 ? null : { cp: 0, mate: 0, bestmove: 'e2e4', depth: 12 }));
    let misses;
    try {
      misses = missedTactics.findMissedTactics(positions, evals, { color: 'white' });
    } catch (err) {
      throw new Error('findMissedTactics threw on null evals: ' + err.message);
    }
    assert(Array.isArray(misses), 'findMissedTactics returns an array');
    assert(misses.length === 0, 'flat evals with nulls produce no misses: ' + misses.length);
    // A crafted miss that spans no nulls is still found, proving nulls only skip
    // the windows that touch them rather than disabling the scan.
    const withGap = positions.slice(0, 6);
    const gapEvals = [
      { cp: 0, bestmove: 'e2e4' },
      { cp: 0, bestmove: 'e2e4' },
      { cp: 400, bestmove: 'd1h5' },   // opponent handed over the win
      { cp: -50, bestmove: 'g1f3' },   // player gave it back
      { cp: -50, bestmove: 'g1f3' },
      null
    ];
    const found = missedTactics.findMissedTactics(withGap, gapEvals, { color: 'white' });
    assert(found.length === 1 && found[0].ply === 3, 'the miss before the null is still found: ' + JSON.stringify(found.map(m => m.ply)));
  });

  await testAsync('(g) bounded request keeps the response contract intact', async () => {
    // Exercise the same shape respondMisses builds without a server: evaluate a
    // truncated game and confirm misses are computed from the evals that exist.
    const archive = fakeArchive();
    const clock = { value: 0 };
    const analyser = stubAnalyser(clock, 10);
    const positions = positionsFrom(FENS);
    const r = await routesReview.evaluatePositions(positions, archive, { analyser, now: () => clock.value, maxEvals: 4, budgetMs: 100000 });
    const misses = missedTactics.findMissedTactics(positions, r.evals, { color: null });
    assert(Array.isArray(misses), 'misses is an array even when truncated');
    for (const m of misses) {
      assert(typeof m.ply === 'number' && typeof m.fen === 'string', 'miss is well-formed: ' + JSON.stringify(m));
      assert(r.evals[m.ply - 1] && r.evals[m.ply], 'a reported miss must sit on evaluated positions (not null)');
    }
    assert(r.evals.length === positions.length, 'evals length === positions length');
    assert(r.truncatedReason === 'budget', 'reason preserved for the response');
  });

  await testAsync('(h) positions past MAX_PLIES truncate with reason max-plies', async () => {
    // No-cache archive: repeated synthetic FENs must not become cache hits.
    const archive = { getEval() { return null; }, saveEval() {} };
    const clock = { value: 0 };
    const analyser = stubAnalyser(clock, 10);
    // MAX_PLIES + 3 positions: i = 0..MAX_PLIES are processed (so MAX_PLIES+1 of
    // them), indices strictly greater than MAX_PLIES are skipped.
    const count = routesReview.MAX_PLIES + 3;
    const positions = [];
    for (let i = 0; i < count; i++) positions.push({ fen: FENS[i % FENS.length] });
    // Budgets high enough that only the MAX_PLIES cap truncates: positions
    // 0..MAX_PLIES are scored, MAX_PLIES+1.. are skipped with the max-plies
    // reason. (301 stub searches, no delay — still a fast test.)
    const r = await routesReview.evaluatePositions(positions, archive, { analyser, now: () => clock.value, maxEvals: 100000, budgetMs: 10000000 });
    assert(analyser.calls === routesReview.MAX_PLIES + 1, 'engine ran once per position up to the cap: ' + analyser.calls);
    assert(r.evals.length === count, 'evals still cover every position: ' + r.evals.length);
    assert(r.truncated === true, 'over-long game is truncated');
    assert(r.truncatedReason === 'max-plies', 'reason is max-plies: ' + r.truncatedReason);
    assert(r.evaluated === routesReview.MAX_PLIES + 1, 'positions up to the cap are scored: ' + r.evaluated);
    assert(r.evals.slice(routesReview.MAX_PLIES + 1).every(e => e === null), 'positions past MAX_PLIES are null');
  });

  console.log(`\n${failed > 0 ? 'Failed: ' + failed + ', ' : ''}Passed: ${passed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FAIL: unexpected error — ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
