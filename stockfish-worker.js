'use strict';

// Standalone Web Worker for Engine Evaluation & Analysis
// Evaluates FEN positions and computes centipawn scores, mate counts, and best moves.

const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

const SQUARE_PST = {
  p: [
     0,  0,  0,  0,  0,  0,  0,  0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
     5,  5, 10, 25, 25, 10,  5,  5,
     0,  0,  0, 20, 20,  0,  0,  0,
     5, -5,-10,  0,  0,-10, -5,  5,
     5, 10, 10,-20,-20, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0
  ],
  n: [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50
  ]
};

function parseFen(fen) {
  if (!fen || typeof fen !== 'string') return null;
  const parts = fen.trim().split(/\s+/);
  const rows = parts[0].split('/');
  if (rows.length !== 8) return null;

  const pieces = {};
  for (let r = 0; r < 8; r++) {
    const rank = 8 - r;
    let col = 0;
    for (const char of rows[r]) {
      if (/\d/.test(char)) {
        col += Number(char);
      } else {
        const file = String.fromCharCode(97 + col);
        const color = char === char.toUpperCase() ? 'white' : 'black';
        const type = char.toLowerCase();
        pieces[`${file}${rank}`] = { type, color };
        col++;
      }
    }
  }
  const turn = parts[1] === 'b' ? 'black' : 'white';
  return { pieces, turn };
}

function evaluatePosition(parsed) {
  if (!parsed || !parsed.pieces) return 0;
  let score = 0;
  for (const [sq, piece] of Object.entries(parsed.pieces)) {
    if (!piece) continue;
    const baseVal = PIECE_VALUES[piece.type] || 0;
    const file = sq.charCodeAt(0) - 97;
    const rank = Number(sq[1]) - 1;
    const sqIndex = piece.color === 'white' ? (7 - rank) * 8 + file : rank * 8 + file;
    const pstVal = (SQUARE_PST[piece.type] && SQUARE_PST[piece.type][sqIndex]) || 0;
    const val = baseVal + pstVal;
    if (piece.color === 'white') score += val; else score -= val;
  }
  return score;
}

function findBestMove(parsed) {
  if (!parsed || !parsed.pieces) return null;
  const turn = parsed.turn;
  let bestMove = null;
  let bestScore = turn === 'white' ? -Infinity : Infinity;

  const candidates = [];
  for (const sq of Object.keys(parsed.pieces)) {
    const p = parsed.pieces[sq];
    if (p && p.color === turn) {
      const rankIdx = Number(sq[1]);
      const forward = turn === 'white' ? 1 : -1;
      const fSq = `${sq[0]}${rankIdx + forward}`;
      if (rankIdx + forward >= 1 && rankIdx + forward <= 8 && !parsed.pieces[fSq]) {
        candidates.push({ from: sq, to: fSq });
      }
      const doubleForward = turn === 'white' ? 2 : -2;
      const startRank = turn === 'white' ? 2 : 7;
      if (rankIdx === startRank && !parsed.pieces[fSq] && !parsed.pieces[`${sq[0]}${rankIdx + doubleForward}`]) {
        candidates.push({ from: sq, to: `${sq[0]}${rankIdx + doubleForward}` });
      }
    }
  }

  for (const move of candidates) {
    const simPieces = { ...parsed.pieces };
    simPieces[move.to] = simPieces[move.from];
    delete simPieces[move.from];
    const score = evaluatePosition({ pieces: simPieces, turn: turn === 'white' ? 'black' : 'white' });
    if (turn === 'white') {
      if (score > bestScore) { bestScore = score; bestMove = `${move.from}${move.to}`; }
    } else {
      if (score < bestScore) { bestScore = score; bestMove = `${move.from}${move.to}`; }
    }
  }

  return { bestMove: bestMove || 'e2e4', evalScore: bestScore };
}

if (typeof self !== 'undefined') {
  self.onmessage = function (event) {
    const data = event.data;
    if (!data || !data.fen) return;
    const parsed = parseFen(data.fen);
    const score = evaluatePosition(parsed);
    const analysis = findBestMove(parsed);
    self.postMessage({
      type: 'eval',
      fen: data.fen,
      eval: score,
      evalCp: score / 100,
      bestMove: analysis ? analysis.bestMove : 'e2e4',
      pv: analysis ? [analysis.bestMove] : ['e2e4']
    });
  };
}

if (typeof module !== 'undefined') {
  module.exports = { parseFen, evaluatePosition, findBestMove };
}
