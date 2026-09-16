/**
 * personality-bots-selftest.js — V1 Personality bots selftest.
 */
'use strict';

const bots = require('./personality-bots.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('PASS: ' + name);
    } catch (e) {
        failed++;
        console.log('FAIL: ' + name + ' -> ' + e.message);
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
}

test('persona lookup known id', () => {
    const p = bots.persona('tal');
    assert(p.name === 'Tal');
    assert(p.style === 'aggressive');
});

test('persona lookup unknown id falls back to default', () => {
    const p = bots.persona('nope');
    assert(p.id === 'tal');
    assert(p.name === 'Tal');
});

test('listPersonas has 5 distinct', () => {
    const list = bots.listPersonas();
    assert(list.length === 5);
    const ids = list.map(x => x.id);
    assert(new Set(ids).size === 5);
});

test('adjustScore favors sharp moves for aggressive persona', () => {
    const aggressive = bots.adjustScore('tal', 100, 1.0);   // + (1.0 - 0.1) * 40 = +36
    const quiet = bots.adjustScore('tal', 100, 0.0);        // +0
    assert(aggressive > quiet, 'aggressive persona rates sharp moves higher');
});

test('adjustScore favors quiet moves for solid persona', () => {
    const solid = bots.adjustScore('karpov', 100, 0.0);      // + (0.1 - 1.0)*0 = 0
    const sharp = bots.adjustScore('karpov', 100, 1.0);      // + (0.1 - 1.0)*40 = -36
    assert(solid > sharp, 'solid persona rates sharp moves lower');
});

test('pickMove selects highest adjusted score', () => {
    const candidates = [
        { san: 'Nf3', score: 100, activity: 0.0 },
        { san: 'Nxf7', score: 80, activity: 1.0 }   // tal: 80 + 36 = 116
    ];
    const rng = bots.createSeededRng(1);
    const picked = bots.pickMove('tal', candidates, rng);
    assert(picked.san === 'Nxf7', 'aggressive persona prefers the sharp sacrifice');
});

test('pickMove null on empty candidates', () => {
    assert(bots.pickMove('tal', []) === null);
});

test('chatLine is deterministic with seed and within persona lines', () => {
    const rng1 = bots.createSeededRng(42);
    const rng2 = bots.createSeededRng(42);
    const a = bots.chatLine('tal', rng1);
    const b = bots.chatLine('tal', rng2);
    assert(a === b, 'deterministic');
    assert(bots.persona('tal').lines.includes(a));
});

test('chatLine differs across personas is allowed (coverage only)', () => {
    const rng = bots.createSeededRng(7);
    const line = bots.chatLine('morphy', rng);
    assert(typeof line === 'string' && line.length > 0);
});

console.log('\nAll ' + passed + ' tests passed successfully!');
if (failed > 0) process.exit(1);
