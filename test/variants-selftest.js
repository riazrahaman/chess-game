/**
 * variants-selftest.js — V4 Variants selftest.
 */
'use strict';

const V = require('../src/variants.js');

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

const EMPTY = new Array(64).fill('');

test('crazyhouseCapture flips color and adds to pocket', () => {
    const pocket = V.crazyhouseCapture([], 'N');
    assert(pocket.length === 1);
    assert(pocket[0] === 'n', 'white knight captured -> black knight in pocket');
});

test('crazyhouseCapture excludes pawns', () => {
    const pocket = V.crazyhouseCapture([], 'P');
    assert(pocket.length === 0, 'pawn not kept in pocket');
});

test('crazyhouseDrop removes piece and rejects occupied', () => {
    const pocket = V.crazyhouseDrop(['n', 'n'], 'n', 20, EMPTY);
    assert(pocket.length === 1, 'one knight removed');
    const occupied = { 20: true };
    assert(V.crazyhouseDrop(['n'], 'n', 20, occupied) === null, 'cannot drop on occupied');
    assert(V.crazyhouseDrop([], 'n', 20, EMPTY) === null, 'piece not in pocket');
});

test('atomicCaptureSquares returns empty on non-capture', () => {
    const board = EMPTY.slice();
    board[12] = 'Q';
    assert(V.atomicCaptureSquares(12, 20, board).length === 0, 'empty target = no explosion');
});

test('atomicCaptureSquares removes capturer + target + non-pawn neighbors', () => {
    const board = EMPTY.slice();
    // target at e4 (idx 36); neighbors include pawn (excluded) and knight (included)
    board[36] = 'q';          // target
    board[27] = 'p';          // d5 pawn (excluded from explosion)
    board[28] = 'N';          // e5 knight (included)
    const removed = V.atomicCaptureSquares(27, 36, board);
    assert(removed.indexOf(27) !== -1, 'capturer removed');
    assert(removed.indexOf(36) !== -1, 'target removed');
    assert(removed.indexOf(28) !== -1, 'non-pawn neighbor removed');
    assert(removed.indexOf(27) !== -1);
});

test('king-of-the-hill win detection', () => {
    const board = EMPTY.slice();
    board[V.squareIndex('e4')] = 'K';
    assert(V.isKingOfTheHillWin(board, 'white') === true);
    assert(V.isKingOfTheHillWin(board, 'black') === false);
});

test('king-of-the-hill non-win', () => {
    const board = EMPTY.slice();
    board[V.squareIndex('e1')] = 'K';
    assert(V.isKingOfTheHillWin(board, 'white') === false);
});

test('squareIndex mapping', () => {
    assert(V.squareIndex('a8') === 0);
    assert(V.squareIndex('h1') === 63);
    assert(V.squareIndex('d4') === 35);
});

test('threeCheck state and win', () => {
    let c = { white: 0, black: 0 };
    c = V.threeCheckState(c, 'white');
    c = V.threeCheckState(c, 'white');
    c = V.threeCheckState(c, 'white');
    assert(V.threeCheckWin(c) === 'white');
    assert(V.threeCheckWin({ white: 2, black: 0 }) === null);
});

test('KING_HILL_SQUARES constant', () => {
    assert(V.KING_HILL_SQUARES.length === 4);
    assert(V.KING_HILL_SQUARES.indexOf('e4') !== -1);
});

console.log('\nAll ' + passed + ' tests passed successfully!');
if (failed > 0) process.exit(1);
