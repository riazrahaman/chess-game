'use strict';

/**
 * study-tree.js — Studies-style analysis variation tree.
 *
 * A pure-data structure for representing chess game trees with branching
 * variations (sidelines).  Nodes are linked parent→children; each child is
 * either the mainline continuation or a named sideline.  Supports PGN
 * round-trip with RAV (Recursive Annotation Variations, i.e. parenthesized
 * nested variations).
 *
 * Gate 4: This module is a pure display/analysis layer.  It never calls
 * makeMove or createInitialBoard and never touches referee state.
 *
 * Public API:
 *   createNode(move, opts)           — create a standalone node
 *   createTree()                     — create an empty root node
 *   addChild(parent, move, opts)     — append a child node, returns the child
 *   findNode(root, id)               — BFS search by node id
 *   getMainline(root)                — array of nodes along first-child chain
 *   getCurrentPath(root, nodeId)     — array of nodes from root → nodeId
 *   getChildren(node)                — array of child nodes
 *   getSiblings(node)                — array of sibling nodes (excluding self)
 *   removeNode(root, nodeId)         — remove a node + its subtree
 *   traverse(root, callback)         — depth-first traversal
 *   toPGN(root)                      — export tree as PGN string with RAVs
 *   fromPGN(pgnString)               — parse PGN into a tree (RAV → branches)
 *   nameVariation(node, name)        — set a human-readable label on a node
 *   getVariationName(node)           — get the label (or null)
 *   getNodeMove(node)                — get the SAN move string
 *   getDepth(root, nodeId)           — depth (ply count) from root to node
 *   countNodes(root)                 — total nodes in tree
 *   cloneSubtree(node)               — deep clone a node and its descendants
 */

/* ------------------------------------------------------------------ *
 * Node structure:                                                    *
 *   { id, move, comment, nags, children, parent, variationName }     *
 *   - children[0] is the mainline continuation                        *
 *   - children[1..] are sidelines                                    *
 * ------------------------------------------------------------------ */

let _idCounter = 0;
function _genId() {
  return 'node_' + (++_idCounter);
}

/**
 * Create a standalone node.
 * @param {string} move   — SAN move string (e.g. "e4", "Nf3")
 * @param {object} [opts] — { comment, nags, variationName, id }
 * @returns {object} node
 */
function createNode(move, opts) {
  opts = opts || {};
  return {
    id: opts.id || _genId(),
    move: move || '',
    comment: opts.comment || null,
    nags: Array.isArray(opts.nags) ? opts.nags.slice() : [],
    children: [],
    parent: null,
    variationName: opts.variationName || null
  };
}

/**
 * Create an empty tree (root node with no move).
 * @returns {object} root node
 */
function createTree() {
  return createNode('', { id: 'root' });
}

/**
 * Append a child node to a parent.  The first child added becomes the
 * mainline continuation; subsequent children are sidelines.
 *
 * @param {object} parent   — parent node
 * @param {string} move     — SAN move string
 * @param {object} [opts]   — { comment, nags, variationName, id }
 * @returns {object} the new child node
 */
function addChild(parent, move, opts) {
  if (!parent || typeof parent !== 'object') {
    throw new Error('addChild: parent node is required');
  }
  opts = opts || {};
  const child = createNode(move, opts);
  child.parent = parent;
  parent.children.push(child);
  return child;
}

/**
 * Find a node by id using BFS.
 * @param {object} root  — tree root
 * @param {string} id    — node id
 * @returns {object|null}
 */
function findNode(root, id) {
  if (!root) return null;
  const queue = [root];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node.id === id) return node;
    for (const child of node.children) {
      queue.push(child);
    }
  }
  return null;
}

/**
 * Get the mainline: array of nodes from root along first-child chain.
 * @param {object} root
 * @returns {object[]} array of nodes (excluding root)
 */
function getMainline(root) {
  const result = [];
  if (!root) return result;
  let node = root;
  while (node.children.length > 0) {
    node = node.children[0];
    result.push(node);
  }
  return result;
}

/**
 * Get the path from root to a given node (inclusive of both).
 * @param {object} root
 * @param {string} nodeId
 * @returns {object[]} array of nodes from root to target (including root)
 */
function getCurrentPath(root, nodeId) {
  if (!root) return [];
  const target = findNode(root, nodeId);
  if (!target) return [];
  const path = [];
  let node = target;
  while (node) {
    path.unshift(node);
    node = node.parent;
  }
  return path;
}

/**
 * Get children of a node.
 * @param {object} node
 * @returns {object[]} array of child nodes
 */
function getChildren(node) {
  if (!node) return [];
  return node.children.slice();
}

/**
 * Get siblings of a node (excluding self).
 * @param {object} node
 * @returns {object[]}
 */
function getSiblings(node) {
  if (!node || !node.parent) return [];
  return node.parent.children.filter(function (c) { return c !== node; });
}

/**
 * Remove a node and its entire subtree from the tree.
 * @param {object} root
 * @param {string} nodeId
 * @returns {boolean} true if removed, false if not found
 */
function removeNode(root, nodeId) {
  if (!root) return false;
  if (root.id === nodeId) return false; // can't remove root
  const target = findNode(root, nodeId);
  if (!target) return false;
  if (!target.parent) return false;
  const idx = target.parent.children.indexOf(target);
  if (idx >= 0) {
    target.parent.children.splice(idx, 1);
    return true;
  }
  return false;
}

/**
 * Depth-first traversal.
 * @param {object} root
 * @param {function} callback — called with (node, depth)
 */
function traverse(root, callback) {
  if (!root || typeof callback !== 'function') return;
  function _walk(node, depth) {
    callback(node, depth);
    for (const child of node.children) {
      _walk(child, depth + 1);
    }
  }
  _walk(root, 0);
}

/**
 * Get depth (ply count) from root to a node.
 * @param {object} root
 * @param {string} nodeId
 * @returns {number} depth (root = 0)
 */
function getDepth(root, nodeId) {
  const path = getCurrentPath(root, nodeId);
  return path.length - 1;
}

/**
 * Count total nodes in tree (including root).
 * @param {object} root
 * @returns {number}
 */
function countNodes(root) {
  if (!root) return 0;
  let count = 0;
  traverse(root, function () { count++; });
  return count;
}

/**
 * Set a variation name on a node.
 * @param {object} node
 * @param {string} name
 */
function nameVariation(node, name) {
  if (!node) return;
  node.variationName = name || null;
}

/**
 * Get the variation name of a node.
 * @param {object} node
 * @returns {string|null}
 */
function getVariationName(node) {
  if (!node) return null;
  return node.variationName || null;
}

/**
 * Get the SAN move of a node.
 * @param {object} node
 * @returns {string}
 */
function getNodeMove(node) {
  if (!node) return '';
  return node.move || '';
}

/**
 * Deep clone a subtree (new ids, same structure).
 * @param {object} node
 * @returns {object} cloned node
 */
function cloneSubtree(node) {
  if (!node) return null;
  const clone = createNode(node.move, {
    comment: node.comment,
    nags: node.nags ? node.nags.slice() : [],
    variationName: node.variationName
  });
  for (const child of node.children) {
    const childClone = cloneSubtree(child);
    childClone.parent = clone;
    clone.children.push(childClone);
  }
  return clone;
}

/* ------------------------------------------------------------------ *
 * PGN / RAV serialization                                            *
 * ------------------------------------------------------------------ */

/**
 * Format a move number prefix.
 * @param {number} ply — 0-based ply index from root
 * @param {boolean} isBlack — whether it's black's move
 * @returns {string}
 */
function _moveNumberPrefix(ply, isBlack) {
  if (ply < 0) return '';
  const moveNum = Math.floor(ply / 2) + 1;
  if (isBlack) {
    return moveNum + '... ';
  }
  return moveNum + '. ';
}

/**
 * Export a tree as a PGN string with RAV variations.
 * Mainline moves are in sequence; sidelines are wrapped in parentheses.
 *
 * @param {object} root
 * @returns {string} PGN movetext (no headers)
 */
function toPGN(root) {
  if (!root) return '';
  const tokens = [];
  _emitNode(tokens, root, -1);
  return tokens.join(' ').trim();
}

/**
 * Recursively emit PGN tokens for a node and its children.
 * @param {string[]} tokens
 * @param {object} node
 * @param {number} ply — ply index of this node (root = -1, first move = 0)
 */
function _emitNode(tokens, node, ply) {
  if (node.move) {
    const moveNum = Math.floor(ply / 2) + 1;
    const isWhite = (ply % 2 === 0);
    if (isWhite) {
      tokens.push(moveNum + '. ' + node.move);
    } else {
      // Black move: no number prefix unless this is the first move in a sideline
      // (handled by the caller via a flag). For mainline just emit the move.
      tokens.push(node.move);
    }
    if (node.comment) {
      tokens.push('{' + node.comment + '}');
    }
    for (const nag of node.nags) {
      tokens.push('$' + nag);
    }
  }

  if (node.children.length === 0) return;

  // Emit sidelines first (before mainline continuation)
  for (let i = 1; i < node.children.length; i++) {
    tokens.push('(');
    _emitSideline(tokens, node.children[i], ply + 1);
    tokens.push(')');
  }

  // Emit mainline continuation
  _emitNode(tokens, node.children[0], ply + 1);
}

/**
 * Emit a sideline branch.  The first move in a sideline gets a move number
 * prefix with "..." if it's a black move, or a normal prefix if white.
 *
 * @param {string[]} tokens
 * @param {object} node
 * @param {number} ply
 */
function _emitSideline(tokens, node, ply) {
  if (node.move) {
    const moveNum = Math.floor(ply / 2) + 1;
    const isWhite = (ply % 2 === 0);
    if (isWhite) {
      tokens.push(moveNum + '. ' + node.move);
    } else {
      tokens.push(moveNum + '... ' + node.move);
    }
    if (node.comment) {
      tokens.push('{' + node.comment + '}');
    }
    for (const nag of node.nags) {
      tokens.push('$' + nag);
    }
  }

  if (node.children.length === 0) return;

  // Sidelines within sidelines
  for (let i = 1; i < node.children.length; i++) {
    tokens.push('(');
    _emitSideline(tokens, node.children[i], ply + 1);
    tokens.push(')');
  }

  // Mainline continuation of this sideline
  _emitSideline(tokens, node.children[0], ply + 1);
}

/**
 * Parse a PGN movetext string into a variation tree.
 * Handles RAVs (parenthesized variations), comments { }, NAGs $N.
 *
 * @param {string} pgnString
 * @returns {object} root node
 */
function fromPGN(pgnString) {
  if (!pgnString || typeof pgnString !== 'string') {
    return createTree();
  }

  // Strip headers
  let body = pgnString.replace(/^\s*\[[A-Za-z0-9_]+\s+"[^"]*"\]\s*/gm, '').trim();

  // Remove result at end
  body = body.replace(/(1-0|0-1|1\/2-1\/2|\*)\s*$/, '').trim();

  const root = createTree();
  const tokens = _tokenizePGN(body);

  // Stack-based parser: each stack frame is { parent, lastChild }
  // "parent" is where the next move attaches; "lastChild" is the node
  // that comments/NAGs should attach to.
  let currentParent = root;
  let lastChild = null;
  const stack = [];
  let pendingMainlineInsert = false;

  for (const tok of tokens) {
    if (tok === '(') {
      // A RAV after a move is an alternative to that move's mainline
      // continuation.  So sideline moves are children of lastChild.
      // We save lastChild so that after ')' the mainline continues from it.
      const altParent = lastChild || currentParent;
      stack.push(lastChild);
      currentParent = altParent;
      lastChild = null;
    } else if (tok === ')') {
      // End sideline — restore: mainline continues from the node that
      // was lastChild before the '(' was opened.  The next move should
      // be inserted as children[0] (mainline position) if the parent
      // already has sideline children.
      const restoreNode = stack.pop();
      if (restoreNode) {
        currentParent = restoreNode;
        lastChild = restoreNode;
        pendingMainlineInsert = true;
      }
    } else if (tok.startsWith('{') && tok.endsWith('}')) {
      // Comment — attach to lastChild
      if (lastChild) {
        lastChild.comment = tok.slice(1, -1).trim();
      }
    } else if (tok.startsWith('$')) {
      // NAG — attach to lastChild
      if (lastChild) {
        lastChild.nags.push(tok.slice(1));
      }
    } else if (/^\d+\.+$/.test(tok)) {
      // Move number prefix — skip (we generate them in toPGN)
      continue;
    } else {
      // It's a move — strip any leading move number
      const cleanMove = tok.replace(/^\d+\.+\s*/, '');
      if (!cleanMove) continue;
      // Skip result tokens
      if (['1-0', '0-1', '1/2-1/2', '*'].includes(cleanMove)) continue;

      const child = addChild(currentParent, cleanMove);
      // If this is a mainline move after a RAV, ensure it's children[0]
      if (pendingMainlineInsert && currentParent.children.length > 1) {
        const idx = currentParent.children.indexOf(child);
        if (idx > 0) {
          currentParent.children.splice(idx, 1);
          currentParent.children.unshift(child);
        }
      }
      pendingMainlineInsert = false;
      currentParent = child;
      lastChild = child;
    }
  }

  return root;
}

/**
 * Tokenize PGN movetext: split on whitespace but keep parens, comments,
 * and NAGs as separate tokens.
 *
 * @param {string} body
 * @returns {string[]} tokens
 */
function _tokenizePGN(body) {
  const tokens = [];
  let i = 0;
  while (i < body.length) {
    // Skip whitespace
    while (i < body.length && /\s/.test(body[i])) i++;
    if (i >= body.length) break;

    if (body[i] === '(') {
      tokens.push('(');
      i++;
    } else if (body[i] === ')') {
      tokens.push(')');
      i++;
    } else if (body[i] === '{') {
      // Read until closing }
      let end = body.indexOf('}', i);
      if (end === -1) end = body.length;
      tokens.push(body.slice(i, end + 1));
      i = end + 1;
    } else if (body[i] === '$') {
      // Read NAG number
      let end = i + 1;
      while (end < body.length && /\d/.test(body[end])) end++;
      tokens.push(body.slice(i, end));
      i = end;
    } else {
      // Read until whitespace or special char
      let end = i;
      while (end < body.length && !/[\s(){}$]/.test(body[end])) end++;
      tokens.push(body.slice(i, end));
      i = end;
    }
  }
  return tokens;
}

/* ------------------------------------------------------------------ *
 * Module exports                                                     *
 * ------------------------------------------------------------------ */

const StudyTreeAPI = {
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
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = StudyTreeAPI;
}

if (typeof window !== 'undefined') {
  window.StudyTree = StudyTreeAPI;
}