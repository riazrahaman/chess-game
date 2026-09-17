/**
 * social-graph-selftest.js — S5 Social graph lite selftest.
 */
'use strict';

const { SocialGraph } = require('../src/social-graph.js');

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

test('follow / isFollowing', () => {
    const g = new SocialGraph();
    assert(g.follow('a', 'b') === true);
    assert(g.isFollowing('a', 'b') === true);
    assert(g.isFollowing('b', 'a') === false);
});

test('cannot follow self', () => {
    const g = new SocialGraph();
    assert(g.follow('a', 'a') === false);
    assert(g.isFollowing('a', 'a') === false);
});

test('unfollow', () => {
    const g = new SocialGraph();
    g.follow('a', 'b');
    assert(g.unfollow('a', 'b') === true);
    assert(g.isFollowing('a', 'b') === false);
    assert(g.unfollow('a', 'b') === false, 'unfollow non-existent returns false');
});

test('mutual follow = friends', () => {
    const g = new SocialGraph();
    g.follow('a', 'b');
    g.follow('b', 'a');
    assert(g.areFriends('a', 'b') === true);
    assert(g.areFriends('b', 'a') === true);
    assert(g.mutualFriends('a').includes('b'));
    assert(g.mutualFriends('b').includes('a'));
});

test('one-way follow is not friendship', () => {
    const g = new SocialGraph();
    g.follow('a', 'b');
    assert(g.areFriends('a', 'b') === false);
});

test('followersOf', () => {
    const g = new SocialGraph();
    g.follow('a', 'c');
    g.follow('b', 'c');
    const f = g.followersOf('c').sort();
    assert(f.length === 2);
    assert(f[0] === 'a' && f[1] === 'b');
});

test('followingOf', () => {
    const g = new SocialGraph();
    g.follow('a', 'b');
    g.follow('a', 'c');
    const f = g.followingOf('a').sort();
    assert(f.length === 2);
    assert(f.includes('b') && f.includes('c'));
});

test('block prevents follow and removes reverse follow', () => {
    const g = new SocialGraph();
    g.follow('a', 'b');
    g.follow('b', 'a');
    g.block('a', 'b');
    assert(g.isBlocked('a', 'b') === true);
    assert(g.isFollowing('a', 'b') === false, 'block removes forward follow');
    assert(g.isFollowing('b', 'a') === false, 'block removes reverse follow');
    assert(g.follow('a', 'b') === false, 'cannot re-follow a blocked user');
});

test('unblock', () => {
    const g = new SocialGraph();
    g.block('a', 'b');
    assert(g.unblock('a', 'b') === true);
    assert(g.isBlocked('a', 'b') === false);
    assert(g.follow('a', 'b') === true, 'can follow after unblock');
});

test('blockedBy', () => {
    const g = new SocialGraph();
    g.block('a', 'b');
    const list = g.blockedBy('b');
    assert(list.includes('a'));
});

test('persistence backend round-trip', () => {
    let stored = null;
    const backend = {
        loadGraph: () => stored,
        saveGraph: (d) => { stored = d; }
    };
    const g = new SocialGraph({ backend });
    g.follow('a', 'b');
    g.follow('b', 'a');
    const g2 = new SocialGraph({ backend });
    assert(g2.areFriends('a', 'b') === true, 'friendship survives reload');
});

test('null backend degrades to in-memory', () => {
    const g = new SocialGraph();
    g.follow('a', 'b');
    assert(g.isFollowing('a', 'b') === true);
});

console.log('\nAll ' + passed + ' tests passed successfully!');
if (failed > 0) process.exit(1);
