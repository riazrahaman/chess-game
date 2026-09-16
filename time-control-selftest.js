/**
 * time-control-selftest.js — standalone selftest for time-control.js (G3).
 * Exits non-zero on any assertion failure.
 */
'use strict';

const TimeControl = require('./time-control.js');
const referee = require('./referee-service.js');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

// --- Section 1: label + category (Lichess 40·increment formula) ---

test('getLabel returns name when present', () => {
    assert(TimeControl.getLabel({ name: 'Blitz 3+2', baseSeconds: 180, incrementSeconds: 2 }) === 'Blitz 3+2', 'name used');
});

test('getLabel builds from base/increment', () => {
    assert(TimeControl.getLabel({ baseSeconds: 125, incrementSeconds: 5 }) === '2:05+5', '125s = 2:05+5');
    assert(TimeControl.getLabel({ baseSeconds: 120, incrementSeconds: 0 }) === '2', '120s = 2');
    assert(TimeControl.getLabel({ baseSeconds: 3600, incrementSeconds: 0 }) === '60', '3600s = 60');
});

test('getLabel handles null/empty', () => {
    assert(TimeControl.getLabel(null) === 'Custom', 'null -> Custom');
});

test('getCategory uses the 40·increment formula', () => {
     // 15+10 = 15 + 40·10 = 415s -> Blitz (< 900).
    assert(TimeControl.getCategory({ baseSeconds: 15, incrementSeconds: 10 }) === 'Blitz', '15+10 -> Blitz, got ' + TimeControl.getCategory({ baseSeconds: 15, incrementSeconds: 10 }));
      // 3+2 = 3 + 80 = 83 -> Bullet.
    assert(TimeControl.getCategory({ baseSeconds: 3, incrementSeconds: 2 }) === 'Bullet', '3+2 -> Bullet');
     // 1+0 = 1 -> UltraBullet.
    assert(TimeControl.getCategory({ baseSeconds: 1, incrementSeconds: 0 }) === 'UltraBullet', '1+0 -> UltraBullet');
        // 10min+15 = 600 + 600 = 1200 -> Rapid.
    assert(TimeControl.getCategory({ baseSeconds: 600, incrementSeconds: 15 }) === 'Rapid', '10+15 -> Rapid, got ' + TimeControl.getCategory({ baseSeconds: 600, incrementSeconds: 15 }));
         // 15min+10 = 900 + 400 = 1300 -> Rapid (> 900 Blitz cap).
    assert(TimeControl.getCategory({ baseSeconds: 900, incrementSeconds: 10 }) === 'Rapid', '15+10 -> Rapid, got ' + TimeControl.getCategory({ baseSeconds: 900, incrementSeconds: 10 }));
       // 30min+0 = 1800 >= 1800 boundary? 1800 not < 1800 -> Rapid.
    assert(TimeControl.getCategory({ baseSeconds: 1800, incrementSeconds: 0 }) === 'Rapid', '30+0 -> Rapid, got ' + TimeControl.getCategory({ baseSeconds: 1800, incrementSeconds: 0 }));
});

test('getCategory boundaries (no increment)', () => {
    assert(TimeControl.getCategory({ baseSeconds: 10 }) === 'UltraBullet', '10s UltraBullet');
    assert(TimeControl.getCategory({ baseSeconds: 30 }) === 'Bullet', '30s Bullet');
    assert(TimeControl.getCategory({ baseSeconds: 180 }) === 'Blitz', '180s(3min) Blitz');
    assert(TimeControl.getCategory({ baseSeconds: 900 }) === 'Rapid', '900s(15min) Rapid');
    assert(TimeControl.getCategory({ baseSeconds: 3600 }) === 'Classical', '3600s(60min) Classical');
});

test('labelFormula classifies by initial + 40·increment', () => {
    assert(TimeControl.labelFormula({ baseSeconds: 6, incrementSeconds: 0 }) === 'UltraBullet', '6s UltraBullet');
    assert(TimeControl.labelFormula({ baseSeconds: 36, incrementSeconds: 0 }) === 'Bullet', '36s Bullet');
       assert(TimeControl.labelFormula({ baseSeconds: 5, incrementSeconds: 3 }) === 'Bullet', '5+3 = 125 Bullet');
     assert(TimeControl.labelFormula({ baseSeconds: 1800, incrementSeconds: 0 }) === 'Rapid', '30min Rapid');
});

// --- Section 2: presets (incl. >15s increments) ---

test('PRESETS include an increment > 15s', () => {
    assert(TimeControl.PRESETS['rapid_30_30'].incrementSeconds === 30, '30+30 preset');
    assert(TimeControl.PRESETS['rapid_30_20'].incrementSeconds === 20, '30+20 preset');
});

test('normalize resolves a named preset', () => {
    var tc = TimeControl.normalize({ preset: 'blitz_3_2' });
    assert(tc.baseSeconds === 180 && tc.incrementSeconds === 2, 'blitz_3_2 values');
    assert(tc.category === 'Blitz', 'category Blitz');
});

test('normalize builds a custom TC and clamps >15s increment', () => {
    var tc = TimeControl.normalize({ baseSeconds: 420, incrementSeconds: 45 });
    assert(tc.preset === 'custom', 'custom preset');
    assert(tc.baseSeconds === 420, 'base 420');
    assert(tc.incrementSeconds === 45, 'increment 45 (not clamped at 15)');
});

test('normalize clamps out-of-range base/increment', () => {
    var tc = TimeControl.normalize({ baseSeconds: 99999, incrementSeconds: 999 });
    assert(tc.baseSeconds === 72000, 'base clamped to 72000');
    assert(tc.incrementSeconds === 120, 'increment clamped to 120');
});

// --- Section 3: per-color clocks ---

test('normalize supports per-color clocks', () => {
    var tc = TimeControl.normalize({ baseSeconds: 600, incrementSeconds: 0, white: 600, black: 300 });
    var clocks = TimeControl.startingClocks(tc);
    assert(clocks.white === 600, 'white 600');
    assert(clocks.black === 300, 'black 300');
});

test('startingClocks falls back to base when per-color absent', () => {
    var tc = TimeControl.normalize({ preset: 'bullet_1_0' });
    var clocks = TimeControl.startingClocks(tc);
    assert(clocks.white === 60 && clocks.black === 60, 'both 60');
});

// --- Section 4: delay + Bronstein ---

test('advanceClock applies simple delay (free seconds)', () => {
    // 60s remaining, 10s move, 5s delay, no increment: clock used = 10-5 = 5.
    var out = TimeControl.advanceClock({ remaining: 60, baseSeconds: 60, incrementSeconds: 0, moveDuration: 10, delay: 5 });
    assert(out === 55, 'delay reduces clock used, got ' + out);
});

test('advanceClock applies standard increment', () => {
    var out = TimeControl.advanceClock({ remaining: 60, baseSeconds: 60, incrementSeconds: 2, moveDuration: 3, delay: 0 });
    // 60 - 3 + 2 = 59.
    assert(out === 59, 'standard increment, got ' + out);
});

test('advanceClock Bronstein only accrues when move >= delay and caps at base', () => {
    // Short move (< delay) under Bronstein: no increment added.
     var short = TimeControl.advanceClock({ remaining: 60, baseSeconds: 60, incrementSeconds: 10, moveDuration: 3, delay: 10, bronstein: true });
    // short move (< delay): clockUsed = max(0, 3-10) = 0, no increment -> 60.
    assert(short === 60, 'short Bronstein move: clockUsed 0, no incr -> 60, got ' + short);
    // Long move (>= delay) adds the increment, capped at base.
    var tc = TimeControl.normalize({ baseSeconds: 60, incrementSeconds: 10, delay: 10, bronstein: true });
    assert(tc.bronstein === true, 'bronstein flag set');
    var long = TimeControl.advanceClock({ remaining: 40, baseSeconds: 60, incrementSeconds: 10, moveDuration: 15, delay: 10, bronstein: true });
    // clockUsed = 15-10 = 5; added = min(10, 60-40)=10; after = 40 + 10 - 5 = 45.
    assert(long === 45, 'long Bronstein move, got ' + long);
});

// --- Section 5: odds / handicap ---

test('normalize carries a handicap odds descriptor', () => {
    var tc = TimeControl.normalize({ baseSeconds: 600, incrementSeconds: 0, odds: 'rook', oddsFor: 'white' });
    assert(tc.odds !== null, 'odds present');
    assert(tc.odds.type === 'rook' && tc.odds.material === 5, 'rook material 5');
    assert(tc.odds.color === 'white', 'odds for white');
});

test('unknown odds type falls back to none', () => {
    var tc = TimeControl.normalize({ baseSeconds: 600, odds: 'wizard' });
    assert(tc.odds.type === 'none' && tc.odds.material === 0, 'unknown odds -> none');
});

// --- Section 6: referee per-color support (backwards-compatible) ---

async function runRefereeTests() {
    var tmp = fs.mkdtempSync(os.tmpdir() + 'g3tc-');
    var ref = new referee.RefereeService({
        roomId: 'g3-tc',
        stateFile: path.join(tmp, 's.json'),
        journalFile: path.join(tmp, 'j.jsonl')
        });

    // Backwards-compatible: single base/increment still works.
    var r1 = await ref.enqueue({ id: 't1', type: 'time-control', args: { preset: 'blitz_3_2' } });
    assert(r1.ok === true, 'presetset ok');
    assert(r1.timeControl.baseSeconds === 180, 'blitz_3_2 base 180');
    assert(r1.clocks.white === 180 && r1.clocks.black === 180, 'both 180');
    passed++;
    console.log('PASS: referee time-control backward-compatible (preset, equal clocks)');

    // Per-color clocks.
    var r2 = await ref.enqueue({ id: 't2', type: 'time-control', args: { baseSeconds: 600, incrementSeconds: 0, white: 600, black: 300 } });
    assert(r2.ok === true, 'per-color ok');
    assert(r2.clocks.white === 600, 'white 600');
    assert(r2.clocks.black === 300, 'black 300');
    passed++;
    console.log('PASS: referee time-control per-color clocks');

    // Delay + bronstein are recorded.
    var r3 = await ref.enqueue({ id: 't3', type: 'time-control', args: { baseSeconds: 600, incrementSeconds: 10, delay: 5, bronstein: true } });
    assert(r3.ok === true, 'delay ok');
    assert(r3.timeControl.delay === 5, 'delay 5');
    assert(r3.timeControl.bronstein === true, 'bronstein true');
    passed++;
    console.log('PASS: referee time-control records delay + bronstein');

    fs.rmSync(tmp, { recursive: true, force: true });
}

runRefereeTests().then(function () {
    console.log('\nAll ' + passed + ' tests passed successfully!');
}).catch(function (err) {
    console.error('FAIL: ' + ((err && err.message) || err));
    process.exit(1);
});
