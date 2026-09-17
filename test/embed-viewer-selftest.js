/**
 * embed-viewer-selftest.js — V3 Embed viewer selftest.
 */
'use strict';

const ev = require('../src/embed-viewer.js');

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

const START_BOARD = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

test('fenBoardToArray length 64', () => {
    const b = ev.fenBoardToArray(START_BOARD);
    assert(b.length === 64);
});

test('fenBoardToArray maps ranks correctly', () => {
    const b = ev.fenBoardToArray(START_BOARD);
    assert(b[0] === 'r', 'a8 black rook');
    assert(b[7] === 'r', 'h8 black rook');
    assert(b[56] === 'R', 'a1 white rook');
    assert(b[63] === 'R', 'h1 white rook');
    assert(b[8] === 'p', 'a7 black pawn');
});

test('fenBoardToArray empty middle rank', () => {
    const b = ev.fenBoardToArray('8/8/8/8/8/8/8/8');
    assert(b.every(x => x === ''));
});

test('squareToIndex', () => {
    assert(ev.squareToIndex('a8') === 0);
    assert(ev.squareToIndex('h8') === 7);
    assert(ev.squareToIndex('a1') === 56);
    assert(ev.squareToIndex('h1') === 63);
    assert(ev.squareToIndex('e4') === 36);
    assert(ev.squareToIndex('z9') === -1);
});

test('boardSvg renders 64 squares + 32 pieces', () => {
    const b = ev.fenBoardToArray(START_BOARD);
    const svg = ev.boardSvg(b);
    assert(svg.startsWith('<svg'));
    assert(svg.endsWith('</svg>'));
    const rectCount = (svg.match(/<rect/g) || []).length;
    assert(rectCount === 64, '64 square rects');
    const pieceCount = (svg.match(/<text/g) || []).length;
    assert(pieceCount === 32, '32 piece glyphs');
});

test('iframeSnippet from fen', () => {
    const html = ev.iframeSnippet({ fen: START_BOARD + ' w KQkq - 0 1', title: 'Game' });
    assert(html.includes('<!doctype html>'));
    assert(html.includes('<svg'));
    assert(html.includes('Game'));
});

test('iframeSnippet from board array', () => {
    const b = ev.fenBoardToArray(START_BOARD);
    const html = ev.iframeSnippet({ board: b });
    assert(html.includes('<svg'));
});

test('iframeSnippet null on no board', () => {
    assert(ev.iframeSnippet({}) === null);
});

test('piece glyphs defined for all 12', () => {
    const keys = Object.keys(ev.PIECE_GLYPH);
    assert(keys.length === 12);
});

console.log('\nAll ' + passed + ' tests passed successfully!');
if (failed > 0) process.exit(1);
