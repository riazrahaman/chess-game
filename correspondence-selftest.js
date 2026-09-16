/**
 * correspondence-selftest.js — S7 Correspondence mode selftest.
 */
'use strict';

const { CorrespondenceGame, DAY_MS } = require('./correspondence.js');

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

test('turn order and move recording', () => {
    const g = new CorrespondenceGame({ players: ['alice', 'bob'], daysPerMove: 1 });
    assert(g.turnPlayer() === 'alice');
    g.makeMove('e4', 'alice');
    assert(g.turnPlayer() === 'bob');
    assert(g.moves.length === 1);
    assert(g.moves[0].by === 'alice');
});

test('moving out of turn throws', () => {
    const g = new CorrespondenceGame({ players: ['alice', 'bob'] });
    let threw = false;
    try { g.makeMove('e4', 'bob'); } catch (e) { threw = true; }
    assert(threw);
});

test('clock deadline = daysPerMove days', () => {
    const g = new CorrespondenceGame({ players: ['a', 'b'], daysPerMove: 2, clockStartedAt: 1000 });
    assert(g.deadlineAt === 1000 + 2 * DAY_MS);
});

test('hoursRemaining positive then flag', () => {
    const g = new CorrespondenceGame({ players: ['a', 'b'], daysPerMove: 1, clockStartedAt: Date.now() });
    assert(g.hoursRemaining() > 0);
    assert(g.isFlagged() === false);
});

test('isFlagged when past deadline', () => {
    const g = new CorrespondenceGame({ players: ['a', 'b'], daysPerMove: 1, clockStartedAt: Date.now() - 2 * DAY_MS });
    assert(g.isFlagged() === true);
});

test('notification increments for opponent', () => {
    const g = new CorrespondenceGame({ players: ['alice', 'bob'] });
    g.makeMove('e4', 'alice');
    assert(g.notifications['bob'].newMoves === 1);
    assert(!g.notifications['alice']);
    g.clearNotifications('bob');
    assert(g.notifications['bob'].newMoves === 0);
});

test('conditional premove only when opponent to move', () => {
    const g = new CorrespondenceGame({ players: ['alice', 'bob'] });
    // alice to move; bob may set a conditional premove
    g.setConditionalPremove('bob', 'e4', 'e5');
    let threw = false;
    try { g.setConditionalPremove('alice', 'x', 'y'); } catch (e) { threw = true; }
    assert(threw, 'player to move cannot set conditional premove');
});

test('conditional premove resolves on predicted reply', () => {
    const g = new CorrespondenceGame({ players: ['alice', 'bob'] });
    g.setConditionalPremove('bob', 'e4', 'e5');
    g.makeMove('e4', 'alice');
    const reply = g.resolveConditionalPremove('e4', 'alice');
    assert(reply === 'e5');
});

test('conditional premove does not resolve on wrong reply', () => {
    const g = new CorrespondenceGame({ players: ['alice', 'bob'] });
    g.setConditionalPremove('bob', 'e4', 'e5');
    g.makeMove('d4', 'alice');
    assert(g.resolveConditionalPremove('d4', 'alice') === null);
});

test('store persistence round-trip', () => {
    let saved = null;
    const store = {
        load: () => saved,
        save: (d) => { saved = d; }
    };
    const g = new CorrespondenceGame({ players: ['alice', 'bob'], store });
    g.makeMove('e4', 'alice');
    const g2 = new CorrespondenceGame({ players: ['alice', 'bob'], store });
    assert(g2.moves.length === 1, 'move survives reload');
    assert(g2.turnPlayer() === 'bob', 'turn survives reload');
});

console.log('\nAll ' + passed + ' tests passed successfully!');
if (failed > 0) process.exit(1);
