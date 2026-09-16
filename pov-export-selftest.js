/**
 * pov-export-selftest.js — V2 Annotated-POV exports selftest.
 */
'use strict';

const pov = require('./pov-export.js');

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

const moves = [
    { san: 'e4', evalCp: 30, accuracy: 95 },
    { san: 'e5', evalCp: -10, accuracy: 90 },
    { san: 'Nf3', evalCp: 25, accuracy: 88 },
    { san: 'Nc6', evalCp: -5, accuracy: 92 }
];

test('buildPovPgn tags + result', () => {
    const pgn = pov.buildPovPgn({ moves, pov: 'white', result: '1-0', tags: { Event: 'Test' } });
    assert(pgn.includes('[Event "Test"]'));
    assert(pgn.includes('1-0'));
});

test('POV white: only white plies annotated', () => {
    const pgn = pov.buildPovPgn({ moves, pov: 'white' });
    assert(pgn.includes('1. e4 {eval +30cp; acc 95%}'), 'white ply 0 annotated');
    assert(pgn.includes('2. Nf3 {eval +25cp; acc 88%}'), 'white ply 2 annotated');
    // black ply 1 (e5) should NOT carry a comment
    assert(!/\d\. e5 \{/.test(pgn), 'black ply not annotated');
});

test('POV black: only black plies annotated', () => {
    const pgn = pov.buildPovPgn({ moves, pov: 'black' });
    assert(pgn.includes('e5 {eval -10cp; acc 90%}'), 'black ply annotated');
    assert(!/e4 \{/.test(pgn), 'white ply not annotated');
});

test('comment and classification included', () => {
    const m = [{ san: 'd4', evalCp: 50, accuracy: 99, classification: 'Best', comment: 'book' }];
    const pgn = pov.buildPovPgn({ moves: m, pov: 'white' });
    assert(pgn.includes('Best'), 'classification present');
    assert(pgn.includes('book'), 'comment present');
});

test('summarize white POV', () => {
    const s = pov.summarize({ moves, pov: 'white', result: '1-0' });
    assert(s.pov === 'white');
    assert(s.ownPlyCount === 2);
    assert(s.moveCount === 4);
    assert(s.result === '1-0');
    // accuracy = (95 + 88) / 2 = 91.5
    assert(Math.abs(s.avgAccuracy - 91.5) < 0.001);
    // eval = (30 + 25) / 2 = 27.5
    assert(Math.abs(s.avgEvalCp - 27.5) < 0.001);
});

test('summarize black POV', () => {
    const s = pov.summarize({ moves, pov: 'black' });
    assert(s.ownPlyCount === 2);
    assert(Math.abs(s.avgAccuracy - 91) < 0.001, '(90+92)/2');
});

test('summaryCardSvg is valid SVG with fields', () => {
    const s = pov.summarize({ moves, pov: 'white', result: '1/2-1/2' });
    const svg = pov.summaryCardSvg(s);
    assert(svg.startsWith('<svg'));
    assert(svg.includes('</svg>'));
    assert(svg.includes('1/2-1/2'));
    assert(svg.includes('92%'), 'rounded accuracy 91.5 -> 92%');
});

test('escapePgnComment strips braces', () => {
    assert(pov.escapePgnComment('a {b} c') === 'a b c');
});

console.log('\nAll ' + passed + ' tests passed successfully!');
if (failed > 0) process.exit(1);
