/**
 * arena-selftest.js — S4 Arena tournament selftest.
 */
'use strict';

const Arena = require('../src/arena.js');

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

// 1. addPlayer / duplicate / remove
test('addPlayer adds unique players', () => {
    const a = new Arena.Arena();
    assert(a.addPlayer('p1', 'Alice', 1600) === true);
    assert(a.addPlayer('p1', 'Alice2', 1500) === false, 'duplicate rejected');
    assert(a.players.length === 1);
    assert(a.removePlayer('p1') === true);
    assert(a.players.length === 0);
    assert(a.removePlayer('p1') === false);
});

// 2. addPlayer requires id + name
test('addPlayer requires id and name', () => {
    const a = new Arena.Arena();
    let threw = false;
    try { a.addPlayer(null, 'x'); } catch (e) { threw = true; }
    assert(threw);
});

// 3. standings with no results = all zero
test('standings empty = zero rows sorted', () => {
    const a = new Arena.Arena();
    a.addPlayer('a', 'A', 1500);
    a.addPlayer('b', 'B', 1600);
    const s = a.standings();
    assert(s.length === 2);
    assert(s[0].score === 0 && s[1].score === 0);
});

// 4. result scoring: win/loss/draw
test('result scoring', () => {
    const a = new Arena.Arena();
    a.addPlayer('a', 'A', 1500);
    a.addPlayer('b', 'B', 1500);
    a.recordResult('a', 'b', '1-0');
    const s = a.standings();
    const sa = s.find(r => r.id === 'a');
    const sb = s.find(r => r.id === 'b');
    assert(sa.score === 1 && sa.wins === 1);
    assert(sb.score === 0 && sb.wins === 0);
    assert(s[0].id === 'a', 'winner sorts first');
});

// 5. draw scores 0.5 each
test('draw scoring', () => {
    const a = new Arena.Arena();
    a.addPlayer('a', 'A', 1500);
    a.addPlayer('b', 'B', 1500);
    a.recordResult('a', 'b', '1/2-1/2');
    const s = a.standings();
    assert(s.find(r => r.id === 'a').score === 0.5);
    assert(s.find(r => r.id === 'b').score === 0.5);
});

// 6. berserk doubles win points
test('berserk doubles win points', () => {
    const a = new Arena.Arena();
    a.addPlayer('a', 'A', 1500);
    a.addPlayer('b', 'B', 1500);
    a.recordResult('a', 'b', '1-0', { whiteBerserk: true });
    const s = a.standings();
    assert(s.find(r => r.id === 'a').score === 2, 'berserk win = 2');
});

// 7. invalid result throws
test('invalid result throws', () => {
    const a = new Arena.Arena();
    let threw = false;
    try { a.recordResult('a', 'b', 'x'); } catch (e) { threw = true; }
    assert(threw);
});

// 8. pairings: even players
test('pairings even count', () => {
    const a = new Arena.Arena();
    ['a', 'b', 'c', 'd'].forEach(id => a.addPlayer(id, id, 1500));
    const p = a.pairNextRound();
    assert(p.length === 2);
    const all = p.flatMap(x => [x.white, x.black]);
    assert(all.length === 4);
});

// 9. pairings: odd count gets a bye
test('pairings odd count bye', () => {
    const a = new Arena.Arena();
    ['a', 'b', 'c'].forEach(id => a.addPlayer(id, id, 1500));
    const p = a.pairNextRound();
    const bye = p.find(x => x.bye);
    assert(bye, 'odd count yields a bye');
    assert(bye.black === null);
});

// 10. Buchholz tie-break
test('buchholz tie-break', () => {
    const a = new Arena.Arena();
    a.addPlayer('a', 'A', 1500);
    a.addPlayer('b', 'B', 1500);
    a.addPlayer('c', 'C', 1500);
    a.addPlayer('d', 'D', 1500);
    // a beats b, c beats d
    a.recordResult('a', 'b', '1-0');
    a.recordResult('c', 'd', '1-0');
    // a beats c (a's opponents: b=0, c=1 -> buchholz 1)
    a.recordResult('a', 'c', '1-0');
    const s = a.standings();
    const sa = s.find(r => r.id === 'a');
    assert(sa.score === 2);
    assert(sa.buchholz === 1, 'buchholz = sum of opponent scores (0 + 1)');
});

// 11. Sonneborn-Berger
test('sonneborn-berger', () => {
    const a = new Arena.Arena();
    a.addPlayer('a', 'A', 1500);
    a.addPlayer('b', 'B', 1500);
    a.addPlayer('c', 'C', 1500);
    a.recordResult('a', 'b', '1-0');
    a.recordResult('a', 'c', '1/2-1/2');
    // a beat b (b score 0 -> 0), drew c (c score 0.5 -> 0.25)
    const s = a.standings();
    const sa = s.find(r => r.id === 'a');
    assert(sa.sonneborn === 0.25, 'sonneborn = sum(wins: opp score) + sum(draws: opp score/2) = 0 + 0.25');
});

// 12. seeded rng determinism
test('seeded rng deterministic', () => {
    const r1 = Arena.createSeededRng(12345);
    const r2 = Arena.createSeededRng(12345);
    const seq1 = [r1(), r1(), r1()];
    const seq2 = [r2(), r2(), r2()];
    assert(seq1[0] === seq2[0] && seq1[1] === seq2[1] && seq1[2] === seq2[2]);
});

// 13. streak tracked (does not affect score directly, but resets on loss)
test('streak resets on loss', () => {
    const a = new Arena.Arena();
    a.addPlayer('a', 'A', 1500);
    a.addPlayer('b', 'B', 1500);
    a.addPlayer('c', 'C', 1500);
    a.recordResult('a', 'b', '1-0');
    a.recordResult('a', 'c', '0-1');
    const s = a.standings();
    assert(s.find(r => r.id === 'a').streak === 0);
});

console.log('\nAll ' + passed + ' tests passed successfully!');
if (failed > 0) process.exit(1);
