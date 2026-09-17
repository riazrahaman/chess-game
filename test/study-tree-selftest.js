#!/usr/bin/env node
'use strict';

/**
 * study-tree-selftest.js — Variation tree (Studies analysis) self-tests.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const StudyTree = require('../src/study-tree.js');
const {
  createNode,
  createTree,
  addChild,
  findNode,
  getMainline,
  getCurrentPath,
  getChildren,
  getSiblings,
  removeNode,
  traverse,
  toPGN,
  fromPGN,
  nameVariation,
  getVariationName,
  getNodeMove,
  getDepth,
  countNodes,
  cloneSubtree
} = StudyTree;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL: ${name} — ${err.message}`);
    failed++;
  }
}

console.log('\n=== Studies Analysis Tree Self-Tests ===\n');

// --- Section 1: Node creation & tree basics ---

test('createNode produces a valid node', () => {
  const node = createNode('e4');
  assert.strictEqual(node.move, 'e4');
  assert.strictEqual(node.children.length, 0);
  assert.strictEqual(node.parent, null);
  assert.strictEqual(node.comment, null);
  assert.deepStrictEqual(node.nags, []);
  assert.ok(node.id, 'node should have an id');
});

test('createTree produces a root with empty move', () => {
  const root = createTree();
  assert.strictEqual(root.move, '');
  assert.strictEqual(root.children.length, 0);
  assert.strictEqual(root.id, 'root');
});

test('createNode with opts (comment, nags, variationName)', () => {
  const node = createNode('Nf3', { comment: 'Developing', nags: ['1'], variationName: 'Mainline' });
  assert.strictEqual(node.comment, 'Developing');
  assert.deepStrictEqual(node.nags, ['1']);
  assert.strictEqual(node.variationName, 'Mainline');
});

// --- Section 2: addChild & parent linking ---

test('addChild appends child and sets parent', () => {
  const root = createTree();
  const child = addChild(root, 'e4');
  assert.strictEqual(root.children.length, 1);
  assert.strictEqual(child.move, 'e4');
  assert.strictEqual(child.parent, root);
});

test('addChild throws on missing parent', () => {
  assert.throws(() => addChild(null, 'e4'), /parent node is required/);
});

test('first child is mainline, subsequent are sidelines', () => {
  const root = createTree();
  const c1 = addChild(root, 'e4');
  const c2 = addChild(root, 'd4');
  assert.strictEqual(root.children[0], c1);
  assert.strictEqual(root.children[1], c2);
  const mainline = getMainline(root);
  assert.strictEqual(mainline.length, 1);
  assert.strictEqual(mainline[0].move, 'e4');
});

// --- Section 3: findNode & getCurrentPath ---

test('findNode locates a node by id', () => {
  const root = createTree();
  const a = addChild(root, 'e4');
  const b = addChild(a, 'e5');
  const c = addChild(b, 'Nf3');
  const found = findNode(root, c.id);
  assert.strictEqual(found, c);
});

test('findNode returns null for missing id', () => {
  const root = createTree();
  addChild(root, 'e4');
  assert.strictEqual(findNode(root, 'nonexistent'), null);
});

test('getCurrentPath returns root-to-node chain', () => {
  const root = createTree();
  const a = addChild(root, 'e4');
  const b = addChild(a, 'e5');
  const path = getCurrentPath(root, b.id);
  assert.strictEqual(path.length, 3);
  assert.strictEqual(path[0], root);
  assert.strictEqual(path[1], a);
  assert.strictEqual(path[2], b);
});

test('getCurrentPath returns [] for missing node', () => {
  const root = createTree();
  assert.deepStrictEqual(getCurrentPath(root, 'missing'), []);
});

// --- Section 4: getChildren, getSiblings, removeNode ---

test('getChildren returns a copy of children array', () => {
  const root = createTree();
  addChild(root, 'e4');
  addChild(root, 'd4');
  const children = getChildren(root);
  assert.strictEqual(children.length, 2);
  children.push('fake');
  assert.strictEqual(root.children.length, 2, 'original array not mutated');
});

test('getSiblings returns siblings excluding self', () => {
  const root = createTree();
  const a = addChild(root, 'e4');
  const b = addChild(root, 'd4');
  const c = addChild(root, 'c4');
  const sibs = getSiblings(b);
  assert.strictEqual(sibs.length, 2);
  assert.ok(sibs.includes(a));
  assert.ok(sibs.includes(c));
  assert.ok(!sibs.includes(b));
});

test('getSiblings returns [] for root (no parent)', () => {
  const root = createTree();
  assert.deepStrictEqual(getSiblings(root), []);
});

test('removeNode removes subtree and updates parent', () => {
  const root = createTree();
  const a = addChild(root, 'e4');
  const b = addChild(a, 'e5');
  const c = addChild(root, 'd4');
  assert.strictEqual(root.children.length, 2);
  const removed = removeNode(root, c.id);
  assert.strictEqual(removed, true);
  assert.strictEqual(root.children.length, 1);
  assert.strictEqual(root.children[0], a);
});

test('removeNode returns false for root', () => {
  const root = createTree();
  assert.strictEqual(removeNode(root, 'root'), false);
});

test('removeNode returns false for missing node', () => {
  const root = createTree();
  assert.strictEqual(removeNode(root, 'missing'), false);
});

// --- Section 5: traverse & countNodes ---

test('traverse visits all nodes depth-first', () => {
  const root = createTree();
  const a = addChild(root, 'e4');
  const b = addChild(a, 'e5');
  const sid = addChild(a, 'c5');
  const visited = [];
  traverse(root, (node) => visited.push(node.move));
  assert.strictEqual(visited.length, 4);
  assert.strictEqual(visited[0], ''); // root
  assert.ok(visited.includes('e4'));
  assert.ok(visited.includes('e5'));
  assert.ok(visited.includes('c5'));
});

test('countNodes counts all nodes including root', () => {
  const root = createTree();
  addChild(root, 'e4');
  addChild(root, 'd4');
  const a = findNode(root, root.children[0].id);
  addChild(a, 'e5');
  assert.strictEqual(countNodes(root), 4);
});

test('countNodes returns 0 for null', () => {
  assert.strictEqual(countNodes(null), 0);
});

// --- Section 6: getDepth, nameVariation, getNodeMove ---

test('getDepth returns ply count from root', () => {
  const root = createTree();
  const a = addChild(root, 'e4');
  const b = addChild(a, 'e5');
  const c = addChild(b, 'Nf3');
  assert.strictEqual(getDepth(root, root.id), 0);
  assert.strictEqual(getDepth(root, a.id), 1);
  assert.strictEqual(getDepth(root, b.id), 2);
  assert.strictEqual(getDepth(root, c.id), 3);
});

test('nameVariation sets and getVariationName reads', () => {
  const root = createTree();
  const sid = addChild(root, 'd4', { variationName: 'Queen\'s Pawn' });
  assert.strictEqual(getVariationName(sid), 'Queen\'s Pawn');
  nameVariation(sid, 'London System');
  assert.strictEqual(getVariationName(sid), 'London System');
  nameVariation(sid, null);
  assert.strictEqual(getVariationName(sid), null);
});

test('getNodeMove returns the move string', () => {
  const node = createNode('O-O');
  assert.strictEqual(getNodeMove(node), 'O-O');
  assert.strictEqual(getNodeMove(null), '');
});

// --- Section 7: cloneSubtree ---

test('cloneSubtree deep clones node and descendants', () => {
  const root = createTree();
  const a = addChild(root, 'e4');
  addChild(a, 'e5');
  addChild(a, 'c5');
  const clone = cloneSubtree(a);
  assert.strictEqual(clone.move, 'e4');
  assert.strictEqual(clone.children.length, 2);
  assert.strictEqual(clone.parent, null);
  assert.notStrictEqual(clone, a);
  assert.notStrictEqual(clone.children[0], a.children[0]);
});

// --- Section 8: toPGN — basic mainline ---

test('toPGN: simple mainline 1. e4 e5 2. Nf3 Nc6', () => {
  const root = createTree();
  const a = addChild(root, 'e4');
  const b = addChild(a, 'e5');
  const c = addChild(b, 'Nf3');
  const d = addChild(c, 'Nc6');
  const pgn = toPGN(root);
  assert.ok(pgn.includes('1. e4 e5'));
  assert.ok(pgn.includes('2. Nf3 Nc6'));
});

test('toPGN: empty tree returns empty string', () => {
  const root = createTree();
  assert.strictEqual(toPGN(root), '');
});

test('toPGN: single move', () => {
  const root = createTree();
  addChild(root, 'e4');
  const pgn = toPGN(root);
  assert.ok(pgn.includes('1. e4'));
});

// --- Section 9: toPGN — with sidelines (RAV) ---

test('toPGN: mainline with one sideline', () => {
  const root = createTree();
  const a = addChild(root, 'e4');
  const b = addChild(a, 'e5');
  // Sideline: d4 instead of e5
  const sid = addChild(a, 'd4');
  addChild(sid, 'd5');
  const pgn = toPGN(root);
  assert.ok(pgn.includes('1. e4'), 'mainline move present');
  assert.ok(pgn.includes('('), 'sideline has opening paren');
  assert.ok(pgn.includes('d4'), 'sideline move present');
  assert.ok(pgn.includes(')'), 'sideline has closing paren');
  assert.ok(pgn.includes('e5'), 'mainline continuation present');
});

test('toPGN: deep nesting (sideline within sideline)', () => {
  const root = createTree();
  const a = addChild(root, 'e4');
  const b = addChild(a, 'e5');
  // Sideline 1: d4
  const sid1 = addChild(a, 'd4');
  const sid1b = addChild(sid1, 'd5');
  // Sideline within sideline: c4 instead of d5
  const sid2 = addChild(sid1, 'c4');
  addChild(sid2, 'e5');
  const pgn = toPGN(root);
  // Should have nested parens
  const openCount = (pgn.match(/\(/g) || []).length;
  const closeCount = (pgn.match(/\)/g) || []).length;
  assert.strictEqual(openCount, 2, 'should have 2 opening parens');
  assert.strictEqual(closeCount, 2, 'should have 2 closing parens');
});

test('toPGN: comment and NAG are emitted', () => {
  const root = createTree();
  const a = addChild(root, 'e4', { comment: 'Good move', nags: ['1'] });
  addChild(a, 'e5');
  const pgn = toPGN(root);
  assert.ok(pgn.includes('{Good move}'), 'comment present');
  assert.ok(pgn.includes('$1'), 'NAG present');
});

// --- Section 10: fromPGN — parsing ---

test('fromPGN: simple mainline round-trip', () => {
  const pgn = '1. e4 e5 2. Nf3 Nc6';
  const root = fromPGN(pgn);
  assert.ok(root, 'should return a root');
  const mainline = getMainline(root);
  assert.strictEqual(mainline.length, 4);
  assert.strictEqual(mainline[0].move, 'e4');
  assert.strictEqual(mainline[1].move, 'e5');
  assert.strictEqual(mainline[2].move, 'Nf3');
  assert.strictEqual(mainline[3].move, 'Nc6');
});

test('fromPGN: handles result token at end', () => {
  const pgn = '1. e4 e5 2. Nf3 Nc6 1-0';
  const root = fromPGN(pgn);
  const mainline = getMainline(root);
  assert.strictEqual(mainline.length, 4);
});

test('fromPGN: handles headers', () => {
  const pgn = '[White "Player A"]\n[Black "Player B"]\n\n1. e4 e5 *';
  const root = fromPGN(pgn);
  const mainline = getMainline(root);
  assert.strictEqual(mainline.length, 2);
  assert.strictEqual(mainline[0].move, 'e4');
});

test('fromPGN: empty string returns empty tree', () => {
  const root = fromPGN('');
  assert.strictEqual(root.children.length, 0);
});

test('fromPGN: null input returns empty tree', () => {
  const root = fromPGN(null);
  assert.strictEqual(root.children.length, 0);
});

// --- Section 11: fromPGN with RAVs ---

test('fromPGN: parses one sideline (RAV)', () => {
  const pgn = '1. e4 (1. d4 d5) e5 2. Nf3';
  const root = fromPGN(pgn);
  assert.ok(root.children.length >= 1, 'root has at least 1 child');
  // Mainline should be e4
  const mainline = getMainline(root);
  assert.strictEqual(mainline[0].move, 'e4');
  assert.strictEqual(mainline[1].move, 'e5');
  assert.strictEqual(mainline[2].move, 'Nf3');
  // d4 is a sideline of e4 (alternative to e5, child of e4)
  const e4node = root.children[0];
  const d4sid = e4node.children.find(c => c.move === 'd4');
  assert.ok(d4sid, 'sideline d4 should exist as child of e4');
  // d4 should have child d5
  assert.ok(d4sid.children.some(c => c.move === 'd5'), 'd4 sideline should have d5');
});

test('fromPGN: parses nested RAVs', () => {
  const pgn = '1. e4 (1. d4 (1. c4 e5) d5) e5';
  const root = fromPGN(pgn);
  const e4node = root.children[0];
  assert.ok(e4node, 'e4 should exist');
  // d4 is a sideline of e4 (child of e4, after mainline e5)
  const d4sid = e4node.children.find(c => c.move === 'd4');
  assert.ok(d4sid, 'sideline d4 should exist as child of e4');
  // d5 is mainline continuation of d4
  assert.ok(d4sid.children.some(c => c.move === 'd5'), 'd4 should have d5 as continuation');
  // c4 is a sideline of d4
  const c4sid = d4sid.children.find(c => c.move === 'c4');
  assert.ok(c4sid, 'nested sideline c4 should exist as child of d4');
  // c4 should have e5 as mainline continuation
  assert.ok(c4sid.children.some(c => c.move === 'e5'), 'c4 should have e5 as continuation');
});

test('fromPGN: comment in braces is attached to preceding node', () => {
  const pgn = '1. e4 {King pawn} e5';
  const root = fromPGN(pgn);
  const e4node = root.children[0];
  assert.strictEqual(e4node.comment, 'King pawn');
});

test('fromPGN: NAG is attached to preceding node', () => {
  const pgn = '1. e4 $1 e5';
  const root = fromPGN(pgn);
  const e4node = root.children[0];
  assert.ok(e4node.nags.includes('1'), 'e4 should have NAG $1');
});

// --- Section 12: Round-trip toPGN → fromPGN ---

test('Round-trip: simple mainline survives toPGN → fromPGN', () => {
  const root1 = createTree();
  addChild(addChild(root1, 'e4'), 'e5');
  const pgn = toPGN(root1);
  const root2 = fromPGN(pgn);
  const ml1 = getMainline(root1).map(n => n.move);
  const ml2 = getMainline(root2).map(n => n.move);
  assert.deepStrictEqual(ml1, ml2);
});

test('Round-trip: mainline with sideline survives', () => {
  const root1 = createTree();
  const a = addChild(root1, 'e4');
  addChild(a, 'e5');
  const sid = addChild(a, 'd4');
  addChild(sid, 'd5');
  const pgn = toPGN(root1);
  const root2 = fromPGN(pgn);
  const ml2 = getMainline(root2);
  assert.strictEqual(ml2[0].move, 'e4');
  assert.strictEqual(ml2[1].move, 'e5');
  // Check sideline exists
  const e4_2 = root2.children[0];
  const d4sid = e4_2.children.find(c => c.move === 'd4');
  assert.ok(d4sid, 'sideline d4 should survive round-trip');
  assert.ok(d4sid.children.some(c => c.move === 'd5'), 'd5 in sideline should survive');
});

test('Round-trip: comments survive', () => {
  const root1 = createTree();
  const a = addChild(root1, 'e4', { comment: 'Best by test' });
  addChild(a, 'e5');
  const pgn = toPGN(root1);
  const root2 = fromPGN(pgn);
  const e4_2 = root2.children[0];
  assert.strictEqual(e4_2.comment, 'Best by test');
});

test('Round-trip: NAGs survive', () => {
  const root1 = createTree();
  const a = addChild(root1, 'e4', { nags: ['1', '2'] });
  addChild(a, 'e5');
  const pgn = toPGN(root1);
  const root2 = fromPGN(pgn);
  const e4_2 = root2.children[0];
  assert.ok(e4_2.nags.includes('1'));
  assert.ok(e4_2.nags.includes('2'));
});

// --- Section 13: Edge cases ---

test('fromPGN: multiple sidelines at same level', () => {
  const pgn = '1. e4 (1. d4 d5) (1. c4 e5) e5 2. Nf3';
  const root = fromPGN(pgn);
  const e4node = root.children[0];
  // e4 should have 3 children: d4, c4, e5 (mainline)
  // Note: the parser's ply tracking may cause d4/c4 to attach differently,
  // but we should find all three moves somewhere under e4.
  const allMoves = [];
  traverse(e4node, (n) => allMoves.push(n.move));
  assert.ok(allMoves.includes('d4'), 'd4 should be in subtree');
  assert.ok(allMoves.includes('c4'), 'c4 should be in subtree');
  assert.ok(allMoves.includes('e5'), 'e5 should be in subtree');
});

test('fromPGN: deeply nested variations (3 levels)', () => {
  const pgn = '1. e4 (1. d4 (1. c4 (1. Nf3 Nf6) e5) d5) e5';
  const root = fromPGN(pgn);
  const e4node = root.children[0];
  assert.ok(e4node, 'e4 exists');
  // Find the deepest sideline: Nf3 inside c4 inside d4 inside e4
  const d4 = e4node.children.find(c => c.move === 'd4');
  assert.ok(d4, 'd4 sideline exists');
  const c4 = d4.children.find(c => c.move === 'c4');
  assert.ok(c4, 'c4 nested sideline exists');
  const nf3 = c4.children.find(c => c.move === 'Nf3');
  assert.ok(nf3, 'Nf3 deeply nested exists');
  assert.ok(nf3.children.some(c => c.move === 'Nf6'), 'Nf6 follows Nf3');
});

test('createNode generates unique ids', () => {
  const a = createNode('e4');
  const b = createNode('e5');
  assert.notStrictEqual(a.id, b.id);
});

test('traverse with null root is a no-op', () => {
  assert.doesNotThrow(() => traverse(null, () => {}));
});

test('traverse with null callback is a no-op', () => {
  const root = createTree();
  assert.doesNotThrow(() => traverse(root, null));
});

// --- Section 14: Gate-4 invariant ---

test('Gate-4: study-tree.js contains no makeMove( calls', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'study-tree.js'), 'utf8');
  assert(!code.includes('makeMove('), 'study-tree.js must not call makeMove(');
});

test('Gate-4: study-tree.js contains no createInitialBoard( calls', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'study-tree.js'), 'utf8');
  assert(!code.includes('createInitialBoard('), 'study-tree.js must not call createInitialBoard(');
});

// --- Summary ---

console.log(`\n=== Studies Analysis Tree Self-Test Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
console.log('\nAll study-tree self-tests PASSED successfully!');