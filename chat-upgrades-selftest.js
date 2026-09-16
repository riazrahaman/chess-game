/**
 * chat-upgrades-selftest.js — S6 Chat upgrades selftest.
 */
'use strict';

const { Chat, MAX_HISTORY } = require('./chat-upgrades.js');

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

test('send basic chat', () => {
    const c = new Chat();
    const m = c.send('alice', 'hello');
    assert(m.type === 'chat');
    assert(m.author === 'alice');
    assert(m.body === 'hello');
    assert(c.history().length === 1);
});

test('move reference message', () => {
    const c = new Chat();
    const m = c.sendMoveRef('alice', 'Nf3', 'rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1');
    assert(m.type === 'move');
    assert(m.refs.san === 'Nf3');
});

test('draw offer message', () => {
    const c = new Chat();
    const m = c.sendDrawOffer('bob');
    assert(m.type === 'draw_offer');
});

test('reactions attach and dedupe', () => {
    const c = new Chat();
    const m = c.send('alice', 'nice move');
    assert(c.sendReaction('bob', m.id, '👍') === 1);
    assert(c.sendReaction('carol', m.id, '👍') === 2);
    assert(c.sendReaction('bob', m.id, '👍') === 2, 'same author counted once');
    assert(m.reactions['👍'].length === 2);
});

test('reaction on unknown message returns null', () => {
    const c = new Chat();
    assert(c.sendReaction('bob', 999, '👍') === null);
});

test('moderation filter masks banned words', () => {
    const c = new Chat();
    assert(c.filter('you are an idiot') === 'you are an ****');
    assert(c.containsBanned('you are an idiot') === true);
    assert(c.containsBanned('nice game') === false);
});

test('sendFiltered stores moderated text', () => {
    const c = new Chat();
    const m = c.sendFiltered('alice', 'that was stupid');
    assert(m.body === 'that was ****');
});

test('history is capped', () => {
    const c = new Chat({ maxHistory: 5 });
    for (let i = 0; i < 10; i++) c.send('a', 'msg' + i);
    assert(c.history().length === 5);
    assert(c.history()[0].body === 'msg5', 'oldest dropped');
});

test('default MAX_HISTORY constant exported', () => {
    assert(MAX_HISTORY === 200);
});

console.log('\nAll ' + passed + ' tests passed successfully!');
if (failed > 0) process.exit(1);
