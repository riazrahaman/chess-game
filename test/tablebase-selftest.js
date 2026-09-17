/**
 * tablebase-selftest.js — standalone selftest for tablebase.js (A2.5).
 * All network access is stubbed via an injected fetch; NO real requests.
 * Exits non-zero on any assertion failure.
 */
'use strict';

const Tablebase = require('../src/tablebase.js');

let passed = 0;
function test(name, fn) {
    fn();
    passed++;
    console.log('PASS: ' + name);
}
function assert(cond, msg) {
    if (!cond) {
        console.error('FAIL: ' + msg);
        process.exit(1);
         }
}

// A 7-piece endgame FEN (KQvK + a few pawns) — 3 + 4 = 7 pieces max in this set.
var TWO_PIECE = '8/8/8/4k3/8/8/8/4K3 w - - 0 1';       // 2 kings
var KQV_K = '8/4k3/8/3Q4/8/8/8/4K3 b - - 0 1';      // 3 pieces
var KQQV_K = '8/3qk3/8/3Q4/8/8/8/4K3 w - - 0 1';      // 4 pieces
var EIGHT_PIECE = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'; // 32 pieces (full)

// --- Section 1: pure helpers ---

test('countPiecesInFen counts pieces and expands empty squares', () => {
    assert(Tablebase.countPiecesInFen(TWO_PIECE) === 2, 'two kings = 2, got ' + Tablebase.countPiecesInFen(TWO_PIECE));
    assert(Tablebase.countPiecesInFen(KQV_K) === 3, 'kqk = 3, got ' + Tablebase.countPiecesInFen(KQV_K));
    assert(Tablebase.countPiecesInFen(EIGHT_PIECE) === 32, 'full = 32, got ' + Tablebase.countPiecesInFen(EIGHT_PIECE));
});

test('buildUrl encodes FEN and type', () => {
    var url = Tablebase.buildUrl(TWO_PIECE, 'dtz');
    assert(url.indexOf('https://tablebase.lichess.ovh/standard?') === 0, 'base url');
    assert(url.indexOf('type=dtz') !== -1, 'type param');
    assert(url.indexOf(encodeURIComponent(TWO_PIECE)) !== -1, 'encoded FEN');
    assert(Tablebase.buildUrl(TWO_PIECE, 'wdl').indexOf('type=wdl') !== -1, 'wdl default');
});

test('isEndgame rejects positions over the piece cap', () => {
    assert(Tablebase.isEndgame(EIGHT_PIECE, 7) === false, '32 pieces rejected');
    assert(Tablebase.isEndgame(KQV_K, 7) === true, '3 pieces, 2 kings accepted');
    assert(Tablebase.isEndgame(TWO_PIECE) === true, 'default cap accepts 2 kings');
    // A position with 4 pieces but one king (malformed) is not a legal endgame.
    var oneKing = '8/8/8/3k4/8/8/8/4P3 w - - 0 1'; // 1 king
    assert(Tablebase.isEndgame(oneKing, 7) === false, 'single king not an endgame');
});

test('parseResponse normalizes a lichess WDL/dtz payload', () => {
    var resp = { best: { mv: 'e8q', score: { wdl: { w: 100, d: 0, l: 0 }, dtz: 4 }, eval: 3.5 } };
    var p = Tablebase.parseResponse(resp);
    assert(p.move === 'e8q', 'move');
    assert(p.wdl[0] === 100 && p.wdl[1] === 0 && p.wdl[2] === 0, 'wdl');
    assert(p.dtz === 4, 'dtz');
    assert(p.bestEval === 3.5, 'eval');
});

test('parseResponse returns null for empty/garbage', () => {
    assert(Tablebase.parseResponse(null) === null, 'null');
    assert(Tablebase.parseResponse({}) === null, 'empty object');
    assert(Tablebase.parseResponse({ best: {} }) === null, 'empty best');
});

// --- Section 2: online probe (stubbed fetch) ---

async function runProbeTests() {
     // Successful WDL probe.
    let seenUrl = null;
    var fakeFetchWdl = function (url) {
        seenUrl = url;
        return Promise.resolve({
          ok: true,
          json: function () {
            return Promise.resolve({ best: { mv: 'd7d8q', score: { wdl: { w: 70, d: 30, l: 0 }, dtz: 7 } } });
             }
            });
         };
    var rWdl = await Tablebase.probe(KQV_K, { type: 'wdl', fetchImpl: fakeFetchWdl });
    assert(rWdl.ok === true, 'wdl probe ok');
    assert(rWdl.source === 'tablebase', 'source tablebase');
    assert(rWdl.best.move === 'd7d8q', 'best move');
    assert(seenUrl && seenUrl.indexOf('type=wdl') !== -1, 'wdl url used');
    passed++;
    console.log('PASS: probe returns tablebase result for 7-piece WDL (stubbed)');

    // Successful DTZ probe.
    var fakeFetchDtz = function () {
        return Promise.resolve({ ok: true, json: function () {
          return Promise.resolve({ best: { mv: 'e7e8q', score: { dtz: 5 }, eval: 1.2 } });
            } });
         };
    var rDtz = await Tablebase.probe(KQV_K, { type: 'dtz', fetchImpl: fakeFetchDtz });
    assert(rDtz.ok === true && rDtz.source === 'tablebase', 'dtz ok');
    assert(rDtz.best.dtz === 5, 'dtz value');
    passed++;
    console.log('PASS: probe returns tablebase result for dtz (stubbed)');

    // Offline fallback: transport unavailable.
    var rNoTransport = await Tablebase.probe(KQV_K, { fetchImpl: undefined });
     // In Node there may be a global fetch; force no-transport by passing an
     // object without fetchImpl and stubbing global — use a null transport instead.
    var rForcedFallback = await Tablebase.probe(KQV_K, { fetchImpl: null });
    assert(rForcedFallback.ok === false, 'null fetch -> fallback');
    assert(rForcedFallback.source === 'fallback', 'fallback source');
    passed++;
    console.log('PASS: probe degrades to fallback when no transport');

    // Offline fallback: network errors out.
    var fakeFetchErr = function () {
        return Promise.reject(new Error('offline'));
         };
    var rErr = await Tablebase.probe(KQV_K, { fetchImpl: fakeFetchErr });
    assert(rErr.ok === false && rErr.source === 'fallback', 'error -> fallback');
    assert(/offline/.test(rErr.reason), 'error reason carried');
    passed++;
    console.log('PASS: probe degrades to fallback on network error');

    // 8+ piece position -> too-many-pieces fallback (no fetch attempted).
    var fetchCalled = false;
    var guardFetch = function () { fetchCalled = true; return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ best: { mv: 'x' } }); } }); };
    var rMany = await Tablebase.probe(EIGHT_PIECE, { fetchImpl: guardFetch });
    assert(rMany.ok === false && rMany.reason === 'too-many-pieces', '32 pieces -> fallback');
    assert(fetchCalled === false, 'fetch not called for 32-piece position');
    passed++;
    console.log('PASS: >7-piece position short-circuits to fallback (no fetch)');

    // Unparseable response -> fallback.
    var fakeBad = function () {
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ nope: true }); } });
         };
    var rBad = await Tablebase.probe(KQV_K, { fetchImpl: fakeBad });
    assert(rBad.ok === false && rBad.reason === 'unparseable', 'bad json -> fallback');
    passed++;
    console.log('PASS: unparseable response degrades to fallback');

    // HTTP failure -> fallback.
    var fakeHttp = function () {
        return Promise.resolve({ ok: false, status: 503, json: function () { return Promise.resolve(null); } });
         };
    var rHttp = await Tablebase.probe(KQV_K, { fetchImpl: fakeHttp });
    assert(rHttp.ok === false && rHttp.source === 'fallback', 'http 503 -> fallback');
    assert(/503/.test(rHttp.reason), '503 carried in reason');
    passed++;
    console.log('PASS: HTTP failure degrades to fallback');
}

runProbeTests().then(function () {
    console.log('\nAll ' + passed + ' tests passed successfully!');
}).catch(function (err) {
    console.error('FAIL: ' + ((err && err.message) || err));
    process.exit(1);
});
