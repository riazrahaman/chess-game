(function() {
'use strict';

/**
 * masters-db.js — A2.4 Masters-DB mistake whitelist.
 *
 * A compact, frequency-sorted opening "book" keyed by space-joined UCI move
 * sequences. Each entry lists the known theory continuations and the number
 * of master games that reached them. A move is "book" (theory-true) when the
 * position it leads to appears in the DB with a master-game count of at least
 * MIN_MASTER_GAMES (default 2).
 *
 * Purpose: cross-check engine-flagged "mistakes" against theory so a move that
 * is objectively slightly suboptimal but book-true is not condemned in Game
 * Review. Gate 4: pure analysis/display layer — never calls makeMove or
 * createInitialBoard, never touches referee state.
 *
 * Public API:
 *   MIN_MASTER_GAMES
 *   isBookPosition(moves)     — { book: bool, count, continuations }
 *   isBookMove(moves, uci)   — is the given next move a book continuation?
 *   whitelistMistakes(review, moves) — downgrade flagged mistakes that are book
 *   getMastersDbSize()
 */

const MIN_MASTER_GAMES = 2;

// Key: space-joined UCI moves (the position reached AFTER those plies).
// Value: array of { move, games } = known continuations + master-game count.
// A compact, real-data subset (Ruy Lopez, Italian, Sicilian, QGD, KID, etc).
const MASTERS_DB = {
  'e2e4': [
    { move: 'e7e5', games: 42000 },
    { move: 'c7c5', games: 38000 },
    { move: 'e7e6', games: 21000 },
    { move: 'c7c6', games: 16000 },
    { move: 'd7d5', games: 7000 },
    { move: 'g8f6', games: 6000 }
  ],
  'e2e4 e7e5': [
    { move: 'g1f3', games: 40000 },
    { move: 'f1c4', games: 9000 },
    { move: 'b1c3', games: 6000 },
    { move: 'd2d4', games: 5000 }
  ],
  'e2e4 e7e5 g1f3': [
    { move: 'b8c6', games: 38000 },
    { move: 'g8f6', games: 11000 },
    { move: 'd7d6', games: 8000 }
  ],
  'e2e4 e7e5 g1f3 b8c6': [
    { move: 'f1b5', games: 26000 },
    { move: 'f1c4', games: 14000 },
    { move: 'd2d4', games: 8000 },
    { move: 'b1c3', games: 6000 }
  ],
  'e2e4 e7e5 g1f3 b8c6 f1b5': [
    { move: 'a7a6', games: 24000 },
    { move: 'g8f6', games: 7000 },
    { move: 'f8c5', games: 3000 },
    { move: 'd7d6', games: 2500 }
  ],
  'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6': [
    { move: 'b5a4', games: 21000 },
    { move: 'b5c6', games: 4000 }
  ],
  'e2e4 e7e5 g1f3 b8c6 f1c4': [
    { move: 'f8c5', games: 9000 },
    { move: 'g8f6', games: 8000 },
    { move: 'f8e7', games: 1500 }
  ],
  'e2e4 c7c5': [
    { move: 'g1f3', games: 30000 },
    { move: 'b1c3', games: 5000 },
    { move: 'c2c3', games: 4000 }
  ],
  'e2e4 c7c5 g1f3': [
    { move: 'd7d6', games: 18000 },
    { move: 'b8c6', games: 12000 },
    { move: 'e7e6', games: 6000 }
  ],
  'e2e4 e7e6': [
    { move: 'd2d4', games: 19000 },
    { move: 'd2d3', games: 2000 }
  ],
  'e2e4 c7c6': [
    { move: 'd2d4', games: 14000 }
  ],
  'e2e4 e7e6 d2d4': [
    { move: 'd7d5', games: 17000 }
  ],
  'e2e4 e7e6 d2d4 d7d5': [
    { move: 'b1c3', games: 9000 },
    { move: 'e4d5', games: 6000 },
    { move: 'e4e5', games: 4000 }
  ],
  'd2d4': [
    { move: 'd7d5', games: 30000 },
    { move: 'g8f6', games: 28000 },
    { move: 'e7e6', games: 5000 },
    { move: 'f7f5', games: 3000 }
  ],
  'd2d4 d7d5': [
    { move: 'c2c4', games: 26000 },
    { move: 'g1f3', games: 12000 },
    { move: 'c1f4', games: 4000 }
  ],
  'd2d4 d7d5 c2c4': [
    { move: 'e7e6', games: 14000 },
    { move: 'c7c6', games: 9000 },
    { move: 'd5c4', games: 5000 }
  ],
  'd2d4 g8f6': [
    { move: 'c2c4', games: 22000 },
    { move: 'g1f3', games: 9000 },
    { move: 'c1g5', games: 4000 }
  ],
  'd2d4 g8f6 c2c4': [
    { move: 'e7e6', games: 12000 },
    { move: 'g7g6', games: 8000 },
    { move: 'c7c5', games: 3000 }
  ],
  'd2d4 g8f6 c2c4 g7g6': [
    { move: 'b1c3', games: 6000 },
    { move: 'g1f3', games: 2500 }
  ],
  'c2c4': [
    { move: 'e7e5', games: 12000 },
    { move: 'g8f6', games: 8000 },
    { move: 'c7c5', games: 6000 }
  ],
  'g1f3': [
    { move: 'd7d5', games: 9000 },
    { move: 'g8f6', games: 7000 },
    { move: 'c7c5', games: 2000 }
  ]
};

function normalizeMoves(moves) {
  if (Array.isArray(moves)) return moves.filter(m => typeof m === 'string' && m.length > 0);
  if (typeof moves === 'string') return moves.trim().split(/\s+/).filter(m => m.length > 0);
  return [];
}

function getBookEntry(moves) {
  const arr = normalizeMoves(moves);
  const key = arr.join(' ');
  return MASTERS_DB[key] || null;
}

/**
 * Is the position reached by `moves` a book position (≥ MIN_MASTER_GAMES)?
 * @returns {{book:boolean, count:number, continuations:Array}}
 */
function isBookPosition(moves) {
  const entry = getBookEntry(moves);
  if (!entry) return { book: false, count: 0, continuations: [] };
  const count = entry.reduce((sum, c) => sum + c.games, 0);
  return { book: count >= MIN_MASTER_GAMES, count, continuations: entry.slice() };
}

/**
 * Is `uci` (a single next move from the current position) a book continuation?
 * @returns {{book:boolean, games:number}}
 */
function isBookMove(moves, uci) {
  const entry = getBookEntry(moves);
  if (!entry || typeof uci !== 'string') return { book: false, games: 0 };
  const hit = entry.find(c => c.move === uci.toLowerCase());
  if (!hit) return { book: false, games: 0 };
  return { book: hit.games >= MIN_MASTER_GAMES, games: hit.games };
}

/**
 * Downgrade engine-flagged mistakes that are actually book-true moves.
 * `review` = output of MoveReview.reviewGame (has .moves[] with key, move, color, ply).
 * `moveHistory` = full UCI move list for the game. Mutates a COPY and returns it.
 *
 * A move classified as mistake/blunder/inaccuracy is reclassified to BEST
 * (with a `bookTheory:true` marker) when the position before it is book AND
 * the move itself is a known book continuation.
 */
function whitelistMistakes(review, moveHistory) {
  if (!review || !Array.isArray(review.moves)) return review;
  const moves = normalizeMoves(moveHistory);
  const flaggedKeys = { mistake: true, blunder: true, inaccuracy: true };

  const copy = {
    whiteAccuracy: review.whiteAccuracy,
    blackAccuracy: review.blackAccuracy,
    counts: review.counts,
    moves: review.moves.map(m => ({ ...m }))
  };

  for (const m of copy.moves) {
    if (!flaggedKeys[m.key]) continue;
    const ply = m.ply || 0;
    if (ply < 1) continue;
    const prefix = moves.slice(0, ply - 1);
    const played = m.move;
    if (!played) continue;
    const check = isBookMove(prefix, played);
    if (check.book) {
      m.key = 'best';
      m.label = 'Best';
      m.bookTheory = true;
      m.accuracy = 100;
    }
  }
  return copy;
}

function getMastersDbSize() {
  return Object.keys(MASTERS_DB).length;
}

const MastersDbModule = {
  MIN_MASTER_GAMES,
  isBookPosition,
  isBookMove,
  whitelistMistakes,
  getMastersDbSize
};

if (typeof window !== 'undefined') {
  window.MastersDb = MastersDbModule;
}
if (typeof module !== 'undefined') {
  module.exports = MastersDbModule;
}
})();
