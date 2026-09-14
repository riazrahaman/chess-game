'use strict';

// Lightweight Local Heuristic Engine & UCI Web Worker
// Fast in-browser fallback engine (PST + material evaluation, alpha-beta search).
// Supports Universal Chess Interface (UCI) protocol, depth calculation,
// Multi-PV candidate analysis, and centipawn scoring.
// Retains Stockfish 17 UCI alias for protocol backward compatibility.

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
  ],
  b: [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20
  ],
  r: [
      0,  0,  0,  0,  0,  0,  0,  0,
      5, 10, 10, 10, 10, 10, 10,  5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
      0,  0,  0,  5,  5,  0,  0,  0
  ],
  q: [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5,  5,  5,  5,  0, -5,
      0,  0,  5,  5,  5,  5,  0, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20
  ],
  k: [
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -10,-20,-20,-20,-20,-20,-20,-10,
     20, 20,  0,  0,  0,  0, 20, 20,
     20, 30, 10,  0,  0, 10, 30, 20
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
  const castling = parts[2] || '-';
  const enPassant = parts[3] && parts[3] !== '-' ? parts[3] : null;
  const halfmove = parseInt(parts[4], 10) || 0;
  const fullmove = parseInt(parts[5], 10) || 1;

  return { pieces, turn, castling, enPassant, halfmove, fullmove };
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

function isSquareAttacked(parsed, targetSq, byColor) {
  if (!parsed || !parsed.pieces || !targetSq) return false;
  const pieces = parsed.pieces;
  const targetFile = targetSq.charCodeAt(0) - 97;
  const targetRank = Number(targetSq[1]);

  // 1. Attacked by pawn?
  const pawnRank = byColor === 'white' ? targetRank - 1 : targetRank + 1;
  if (pawnRank >= 1 && pawnRank <= 8) {
    for (const df of [-1, 1]) {
      const pf = targetFile + df;
      if (pf >= 0 && pf <= 7) {
        const pSq = `${String.fromCharCode(97 + pf)}${pawnRank}`;
        const p = pieces[pSq];
        if (p && p.color === byColor && p.type === 'p') return true;
      }
    }
  }

  // 2. Attacked by knight?
  const knightOffsets = [
    [-2, -1], [-2, 1], [-1, -2], [-1, 2],
    [1, -2], [1, 2], [2, -1], [2, 1]
  ];
  for (const [df, dr] of knightOffsets) {
    const nf = targetFile + df;
    const nr = targetRank + dr;
    if (nf >= 0 && nf <= 7 && nr >= 1 && nr <= 8) {
      const p = pieces[`${String.fromCharCode(97 + nf)}${nr}`];
      if (p && p.color === byColor && p.type === 'n') return true;
    }
  }

  // 3. Attacked by king?
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (df === 0 && dr === 0) continue;
      const kf = targetFile + df;
      const kr = targetRank + dr;
      if (kf >= 0 && kf <= 7 && kr >= 1 && kr <= 8) {
        const p = pieces[`${String.fromCharCode(97 + kf)}${kr}`];
        if (p && p.color === byColor && p.type === 'k') return true;
      }
    }
  }

  // 4. Sliding pieces: bishops, queens (diagonals)
  const diagDirs = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  for (const [df, dr] of diagDirs) {
    let step = 1;
    while (true) {
      const f = targetFile + step * df;
      const r = targetRank + step * dr;
      if (f < 0 || f > 7 || r < 1 || r > 8) break;
      const p = pieces[`${String.fromCharCode(97 + f)}${r}`];
      if (p) {
        if (p.color === byColor && (p.type === 'b' || p.type === 'q')) return true;
        break;
      }
      step++;
    }
  }

  // 5. Sliding pieces: rooks, queens (orthogonals)
  const straightDirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [df, dr] of straightDirs) {
    let step = 1;
    while (true) {
      const f = targetFile + step * df;
      const r = targetRank + step * dr;
      if (f < 0 || f > 7 || r < 1 || r > 8) break;
      const p = pieces[`${String.fromCharCode(97 + f)}${r}`];
      if (p) {
        if (p.color === byColor && (p.type === 'r' || p.type === 'q')) return true;
        break;
      }
      step++;
    }
  }

  return false;
}

function isKingInCheck(parsed, color) {
  if (!parsed || !parsed.pieces) return false;
  let kingSq = null;
  for (const sq of Object.keys(parsed.pieces)) {
    const p = parsed.pieces[sq];
    if (p && p.type === 'k' && p.color === color) {
      kingSq = sq;
      break;
    }
  }
  if (!kingSq) return false;
  return isSquareAttacked(parsed, kingSq, color === 'white' ? 'black' : 'white');
}

function generateCandidateMoves(parsedOrFen, options = {}) {
  const parsed = typeof parsedOrFen === 'string' ? parseFen(parsedOrFen) : parsedOrFen;
  if (!parsed || !parsed.pieces) return [];
  const turn = parsed.turn;
  const oppColor = turn === 'white' ? 'black' : 'white';
  const moves = [];
  const pieces = parsed.pieces;

  const addMove = (from, to, promo = null) => {
    moves.push({ from, to, promo, uci: `${from}${to}${promo || ''}` });
  };

  const isSquareEmpty = (sq) => !pieces[sq];
  const isEnemySquare = (sq) => pieces[sq] && pieces[sq].color !== turn;

  for (const sq of Object.keys(pieces)) {
    const p = pieces[sq];
    if (!p || p.color !== turn) continue;

    const file = sq.charCodeAt(0) - 97;
    const rank = Number(sq[1]);

    if (p.type === 'p') {
      const dir = turn === 'white' ? 1 : -1;
      const startRank = turn === 'white' ? 2 : 7;
      const promoRank = turn === 'white' ? 8 : 1;

      // 1-square push
      const nextRank = rank + dir;
      const fwdSq = `${String.fromCharCode(97 + file)}${nextRank}`;
      if (nextRank >= 1 && nextRank <= 8 && isSquareEmpty(fwdSq)) {
        if (nextRank === promoRank) {
          ['q', 'r', 'b', 'n'].forEach(pr => addMove(sq, fwdSq, pr));
        } else {
          addMove(sq, fwdSq);
          // 2-square push
          const dblRank = rank + 2 * dir;
          const dblSq = `${String.fromCharCode(97 + file)}${dblRank}`;
          if (rank === startRank && isSquareEmpty(dblSq)) {
            addMove(sq, dblSq);
          }
        }
      }

      // Captures
      for (const df of [-1, 1]) {
        const capFile = file + df;
        if (capFile >= 0 && capFile <= 7) {
          const capSq = `${String.fromCharCode(97 + capFile)}${nextRank}`;
          if (isEnemySquare(capSq) || (parsed.enPassant && capSq === parsed.enPassant)) {
            if (nextRank === promoRank) {
              ['q', 'r', 'b', 'n'].forEach(pr => addMove(sq, capSq, pr));
            } else {
              addMove(sq, capSq);
            }
          }
        }
      }
    } else if (p.type === 'n') {
      const knightOffsets = [
        [-2, -1], [-2, 1], [-1, -2], [-1, 2],
        [1, -2], [1, 2], [2, -1], [2, 1]
      ];
      for (const [df, dr] of knightOffsets) {
        const nf = file + df;
        const nr = rank + dr;
        if (nf >= 0 && nf <= 7 && nr >= 1 && nr <= 8) {
          const destSq = `${String.fromCharCode(97 + nf)}${nr}`;
          if (isSquareEmpty(destSq) || isEnemySquare(destSq)) {
            addMove(sq, destSq);
          }
        }
      }
    } else if (p.type === 'b' || p.type === 'r' || p.type === 'q') {
      const directions = [];
      if (p.type === 'b' || p.type === 'q') {
        directions.push([-1, -1], [-1, 1], [1, -1], [1, 1]);
      }
      if (p.type === 'r' || p.type === 'q') {
        directions.push([-1, 0], [1, 0], [0, -1], [0, 1]);
      }
      for (const [df, dr] of directions) {
        let step = 1;
        while (true) {
          const nf = file + step * df;
          const nr = rank + step * dr;
          if (nf < 0 || nf > 7 || nr < 1 || nr > 8) break;
          const destSq = `${String.fromCharCode(97 + nf)}${nr}`;
          if (isSquareEmpty(destSq)) {
            addMove(sq, destSq);
          } else {
            if (isEnemySquare(destSq)) addMove(sq, destSq);
            break;
          }
          step++;
        }
      }
    } else if (p.type === 'k') {
      for (let df = -1; df <= 1; df++) {
        for (let dr = -1; dr <= 1; dr++) {
          if (df === 0 && dr === 0) continue;
          const nf = file + df;
          const nr = rank + dr;
          if (nf >= 0 && nf <= 7 && nr >= 1 && nr <= 8) {
            const destSq = `${String.fromCharCode(97 + nf)}${nr}`;
            if (isSquareEmpty(destSq) || isEnemySquare(destSq)) {
              addMove(sq, destSq);
            }
          }
        }
      }

      // Castling rules: King cannot be in check, transit square cannot be attacked, destination cannot be attacked
      const castling = parsed.castling || '';
      const inCheck = isKingInCheck(parsed, turn);
      if (!inCheck) {
        if (turn === 'white' && sq === 'e1') {
          if (castling.includes('K') && isSquareEmpty('f1') && isSquareEmpty('g1') && !isSquareAttacked(parsed, 'f1', oppColor) && !isSquareAttacked(parsed, 'g1', oppColor)) {
            addMove('e1', 'g1');
          }
          if (castling.includes('Q') && isSquareEmpty('d1') && isSquareEmpty('c1') && isSquareEmpty('b1') && !isSquareAttacked(parsed, 'd1', oppColor) && !isSquareAttacked(parsed, 'c1', oppColor)) {
            addMove('e1', 'c1');
          }
        } else if (turn === 'black' && sq === 'e8') {
          if (castling.includes('k') && isSquareEmpty('f8') && isSquareEmpty('g8') && !isSquareAttacked(parsed, 'f8', oppColor) && !isSquareAttacked(parsed, 'g8', oppColor)) {
            addMove('e8', 'g8');
          }
          if (castling.includes('q') && isSquareEmpty('d8') && isSquareEmpty('c8') && isSquareEmpty('b8') && !isSquareAttacked(parsed, 'd8', oppColor) && !isSquareAttacked(parsed, 'c8', oppColor)) {
            addMove('e8', 'c8');
          }
        }
      }
    }
  }

  if (options && options.pseudo === true) return moves;

  // Filter candidate moves to strictly legal moves (king must not remain in check)
  const legalMoves = [];
  for (const m of moves) {
    const sim = cloneParsed(parsed);
    applyUciMoveToParsed(sim, m.uci);
    if (!isKingInCheck(sim, turn)) {
      legalMoves.push(m);
    }
  }

  return legalMoves;
}

function applyUciMoveToParsed(parsed, moveUci) {
  if (!parsed || !parsed.pieces || !moveUci || moveUci.length < 4) return;
  const from = moveUci.slice(0, 2);
  const to = moveUci.slice(2, 4);
  const promo = moveUci[4];
  const movingPiece = parsed.pieces[from];
  if (!movingPiece) return;

  delete parsed.pieces[from];
  if (promo) {
    parsed.pieces[to] = { type: promo.toLowerCase(), color: movingPiece.color };
  } else {
    parsed.pieces[to] = movingPiece;
  }

  // En-passant capture: remove captured pawn behind target square
  if (movingPiece.type === 'p' && to === parsed.enPassant && from[0] !== to[0]) {
    const capRank = movingPiece.color === 'white' ? 5 : 4;
    delete parsed.pieces[`${to[0]}${capRank}`];
  }

  // Castling rook move
  if (movingPiece.type === 'k') {
    if (from === 'e1' && to === 'g1') { delete parsed.pieces['h1']; parsed.pieces['f1'] = { type: 'r', color: 'white' }; }
    if (from === 'e1' && to === 'c1') { delete parsed.pieces['a1']; parsed.pieces['d1'] = { type: 'r', color: 'white' }; }
    if (from === 'e8' && to === 'g8') { delete parsed.pieces['h8']; parsed.pieces['f8'] = { type: 'r', color: 'black' }; }
    if (from === 'e8' && to === 'c8') { delete parsed.pieces['a8']; parsed.pieces['d8'] = { type: 'r', color: 'black' }; }
  }

  parsed.turn = parsed.turn === 'white' ? 'black' : 'white';
}

function cloneParsed(parsed) {
  return {
    pieces: { ...parsed.pieces },
    turn: parsed.turn,
    castling: parsed.castling,
    enPassant: parsed.enPassant,
    halfmove: parsed.halfmove,
    fullmove: parsed.fullmove
  };
}

// Alpha-Beta Minimax Search with depth
function search(parsed, depth, alpha, beta, isWhite) {
  if (depth <= 0) {
    return evaluatePosition(parsed);
  }

  const moves = generateCandidateMoves(parsed);
  if (moves.length === 0) {
    // Checkmate or Stalemate
    if (isKingInCheck(parsed, parsed.turn)) {
      return parsed.turn === 'white' ? (-100000 - depth) : (100000 + depth);
    }
    return 0; // Stalemate
  }

  // Move ordering: MVV-LVA (Most Valuable Victim - Least Valuable Attacker)
  moves.sort((a, b) => {
    const victimA = parsed.pieces[a.to] ? PIECE_VALUES[parsed.pieces[a.to].type] : 0;
    const attackerA = parsed.pieces[a.from] ? PIECE_VALUES[parsed.pieces[a.from].type] : 0;
    const scoreA = victimA > 0 ? (victimA * 10 - attackerA) : 0;

    const victimB = parsed.pieces[b.to] ? PIECE_VALUES[parsed.pieces[b.to].type] : 0;
    const attackerB = parsed.pieces[b.from] ? PIECE_VALUES[parsed.pieces[b.from].type] : 0;
    const scoreB = victimB > 0 ? (victimB * 10 - attackerB) : 0;

    return scoreB - scoreA;
  });

  if (isWhite) {
    let maxEval = -Infinity;
    for (const m of moves) {
      const sim = cloneParsed(parsed);
      applyUciMoveToParsed(sim, m.uci);
      const ev = search(sim, depth - 1, alpha, beta, false);
      maxEval = Math.max(maxEval, ev);
      alpha = Math.max(alpha, ev);
      if (beta <= alpha) break;
    }
    return maxEval;
  } else {
    let minEval = Infinity;
    for (const m of moves) {
      const sim = cloneParsed(parsed);
      applyUciMoveToParsed(sim, m.uci);
      const ev = search(sim, depth - 1, alpha, beta, true);
      minEval = Math.min(minEval, ev);
      beta = Math.min(beta, ev);
      if (beta <= alpha) break;
    }
    return minEval;
  }
}

// Multi-PV candidate evaluator
function evaluateMultiPV(parsedOrFen, depth = 3, multiPvCount = 1) {
  const parsed = typeof parsedOrFen === 'string' ? parseFen(parsedOrFen) : parsedOrFen;
  if (!parsed || !parsed.pieces) return [];
  const moves = generateCandidateMoves(parsed);
  if (moves.length === 0) return [];

  const isWhite = parsed.turn === 'white';
  const evaluatedMoves = [];

  for (const m of moves) {
    const sim = cloneParsed(parsed);
    applyUciMoveToParsed(sim, m.uci);
    const score = search(sim, Math.max(0, depth - 1), -Infinity, Infinity, !isWhite);
    evaluatedMoves.push({
      move: m.uci,
      scoreRaw: score,
      scoreCp: score / 100
    });
  }

  // Sort descending for white, ascending for black
  evaluatedMoves.sort((a, b) => isWhite ? b.scoreRaw - a.scoreRaw : a.scoreRaw - b.scoreRaw);

  const results = [];
  const limit = Math.min(multiPvCount, evaluatedMoves.length);
  for (let i = 0; i < limit; i++) {
    const entry = evaluatedMoves[i];
    results.push({
      pvIndex: i + 1,
      bestMove: entry.move,
      scoreRaw: entry.scoreRaw,
      scoreCp: entry.scoreCp,
      depth,
      pv: [entry.move]
    });
  }

  return results;
}

function findBestMove(parsedOrFen, options = {}) {
  const parsed = typeof parsedOrFen === 'string' ? parseFen(parsedOrFen) : parsedOrFen;
  if (!parsed || !parsed.pieces) return { bestMove: 'e2e4', evalScore: 0 };
  const depth = typeof options === 'number' ? options : ((options && options.depth) || 3);
  const results = evaluateMultiPV(parsed, depth, 1);
  if (results.length > 0) {
    return { bestMove: results[0].bestMove, evalScore: results[0].scoreRaw };
  }
  return { bestMove: 'e2e4', evalScore: 0 };
}

/**
 * Normalizes a FEN to a 4-field cache key (strips halfmove/fullmove counters).
 * Transpositions with identical board+turn+castling+enPassant share a key.
 * @param {string} fen  Full FEN string.
 * @returns {string}    4-field cache key.
 */
function fenCacheKey(fen) {
  if (!fen || typeof fen !== 'string') return '';
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) return fen;
  return parts.slice(0, 4).join(' ');
}

/**
 * Attempts to retrieve a cached eval for the given FEN.
 * Uses game-archive.js when available (Node/test context), else an in-memory Map.
 * Returns null on cache miss or when no backend is available (graceful degradation).
 */
let _evalCacheBackend = null;
let _evalCacheBackendInit = false;
let _memoryEvalCache = new Map();

function _getEvalCacheBackend() {
  if (_evalCacheBackendInit) return _evalCacheBackend;
  _evalCacheBackendInit = true;
  if (typeof require === 'function') {
    try {
      const archive = require('./game-archive.js');
      if (archive && typeof archive.getEval === 'function' && typeof archive.saveEval === 'function') {
        _evalCacheBackend = archive;
      }
    } catch (_) { /* graceful degradation */ }
  }
  return _evalCacheBackend;
}

function getEvalFromCache(fen) {
  const key = fenCacheKey(fen);
  if (!key) return null;
  const backend = _getEvalCacheBackend();
  if (backend) {
    try { return backend.getEval(key); } catch (_) { return null; }
  }
  return _memoryEvalCache.get(key) || null;
}

function saveEvalToCache(fen, evalData) {
  const key = fenCacheKey(fen);
  if (!key) return null;
  const backend = _getEvalCacheBackend();
  if (backend) {
    try { return backend.saveEval(key, evalData); } catch (_) { return null; }
  }
  _memoryEvalCache.set(key, { fen: key, ...evalData, created_at: Date.now() });
  return { fen: key, ...evalData };
}

// Stockfish Engine UCI Controller (PST+Material fallback engine)
class StockfishEngine {
  constructor(postFn) {
    this.postFn = postFn || (() => {});
    this.multiPv = 1;
    this.threads = 1;
    this.hashSize = 16;
    this.currentFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    this.parsedPosition = parseFen(this.currentFen);
    this.isSearching = false;
  }

  send(line) {
    this.postFn(line);
  }

  processCommand(rawCmd) {
    if (!rawCmd || typeof rawCmd !== 'string') return [];
    const cmd = rawCmd.trim();
    if (!cmd) return [];
    const tokens = cmd.split(/\s+/);
    const op = tokens[0].toLowerCase();

    if (op === 'uci') {
      this.send('id name Lightweight Local Engine (PST+Material)');
      this.send('id alias Stockfish 17 NNUE WASM');
      this.send('id author Chess Game Contributors & Stockfish Compatibility Layer');
      this.send('option name MultiPV type spin default 1 min 1 max 500');
      this.send('option name Threads type spin default 1 min 1 max 512');
      this.send('option name Hash type spin default 16 min 1 max 33554432');
      this.send('uciok');
      return [];
    } else if (op === 'isready') {
      this.send('readyok');
      return [];
    } else if (op === 'setoption') {
      const nameIdx = tokens.findIndex(t => t.toLowerCase() === 'name');
      const valIdx = tokens.findIndex(t => t.toLowerCase() === 'value');
      if (nameIdx >= 0 && valIdx > nameIdx) {
        const optName = tokens.slice(nameIdx + 1, valIdx).join(' ').toLowerCase();
        const optVal = tokens.slice(valIdx + 1).join(' ');
        if (optName === 'multipv') {
          this.multiPv = Math.max(1, parseInt(optVal, 10) || 1);
        } else if (optName === 'threads') {
          this.threads = Math.max(1, parseInt(optVal, 10) || 1);
        }
      }
      return [];
    } else if (op === 'ucinewgame') {
      this.currentFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      this.parsedPosition = parseFen(this.currentFen);
      return [];
    } else if (op === 'position') {
      if (tokens[1] === 'fen') {
        const movesIdx = tokens.findIndex((t, i) => i > 1 && t === 'moves');
        const fenParts = movesIdx >= 0 ? tokens.slice(2, movesIdx) : tokens.slice(2);
        this.currentFen = fenParts.join(' ');
        this.parsedPosition = parseFen(this.currentFen);
        if (movesIdx >= 0) {
          const moves = tokens.slice(movesIdx + 1);
          for (const m of moves) {
            applyUciMoveToParsed(this.parsedPosition, m);
          }
        }
      } else if (tokens[1] === 'startpos') {
        this.currentFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
        this.parsedPosition = parseFen(this.currentFen);
        const movesIdx = tokens.findIndex((t, i) => i > 1 && t === 'moves');
        if (movesIdx >= 0) {
          const moves = tokens.slice(movesIdx + 1);
          for (const m of moves) {
            applyUciMoveToParsed(this.parsedPosition, m);
          }
        }
      }
      return [];
    } else if (op === 'go') {
      let depth = 3;
      const depthIdx = tokens.findIndex(t => t.toLowerCase() === 'depth');
      if (depthIdx >= 0 && tokens[depthIdx + 1]) {
        depth = parseInt(tokens[depthIdx + 1], 10) || 3;
      }
      this.isSearching = true;
      const results = evaluateMultiPV(this.parsedPosition, depth, this.multiPv);
      for (const res of results) {
        this.send(`info depth ${depth} seldepth ${depth + 2} multipv ${res.pvIndex} score cp ${Math.round(res.scoreRaw)} pv ${res.bestMove}`);
      }
      const best = results[0] ? results[0].bestMove : 'e2e4';
      this.send(`bestmove ${best}`);
      this.isSearching = false;
      return results;
    } else if (op === 'stop') {
      this.isSearching = false;
      const best = 'e2e4';
      this.send(`bestmove ${best}`);
      return [];
    }
    return [];
  }
}

// --- Stockfish WASM Engine Bridge ---
// Attempts to load stockfish.wasm (full-strength NNUE) and bridge UCI commands.
// On any failure, the caller falls back to the PST+Material engine.
class WasmEngine {
  constructor(postFn) {
    this.postFn = postFn || (() => {});
    this.wasmReady = false;
    this.wasmFailed = false;
    this.pendingCommands = [];
    this._lineBuffer = '';
    this.currentFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    this.lastBestMove = null;
    this.lastMultiPvResults = [];
    this._collectingEval = false;
  }

  send(line) {
    this.postFn(line);
    this._processEngineLine(line);
  }

  _processEngineLine(line) {
    if (!line) return;

    // Collect info lines and bestmove to build eval message
    if (line.startsWith('info') && line.includes(' pv ')) {
      // Parse multipv, score cp, pv from info line
      const pvMatch = line.match(/\bpv\s+(\S+)/);
      const scoreMatch = line.match(/score cp\s+(-?\d+)/);
      const multipvMatch = line.match(/multipv\s+(\d+)/);
      const depthMatch = line.match(/depth\s+(\d+)/);

      if (pvMatch) {
        const pvIndex = multipvMatch ? parseInt(multipvMatch[1], 10) : 1;
        const scoreCp = scoreMatch ? parseInt(scoreMatch[1], 10) / 100 : 0;
        const depth = depthMatch ? parseInt(depthMatch[1], 10) : 0;
        const bestMove = pvMatch[1];

        // Ensure array is large enough
        while (this.lastMultiPvResults.length < pvIndex) {
          this.lastMultiPvResults.push(null);
        }
        this.lastMultiPvResults[pvIndex - 1] = {
          pvIndex,
          bestMove,
          scoreCp,
          scoreRaw: scoreCp * 100,
          depth,
          pv: [bestMove]
        };
        this._collectingEval = true;
      }
    }

    if (line.startsWith('bestmove')) {
      this.lastBestMove = line.replace('bestmove ', '').trim().split(/\s+/)[0] || null;
      this._flushEval();
      return;
    }
  }

  _flushEval() {
    if (!this.lastBestMove) return;
    const primary = this.lastMultiPvResults[0] || {
      pvIndex: 1,
      bestMove: this.lastBestMove,
      scoreCp: 0,
      scoreRaw: 0,
      depth: 0,
      pv: [this.lastBestMove]
    };

    if (typeof self !== 'undefined' && self.postMessage) {
      self.postMessage({
        type: 'eval',
        fen: this.currentFen,
        eval: primary.scoreRaw,
        evalCp: primary.scoreCp,
        bestMove: this.lastBestMove,
        pv: primary.pv || [this.lastBestMove],
        multipv: this.lastMultiPvResults.length > 0 ? this.lastMultiPvResults : [primary]
      });
    }

    this.lastMultiPvResults = [];
    this._collectingEval = false;
  }

  // Attempt to load stockfish.wasm. Returns a promise that resolves to true/false.
  async load(wasmUrl) {
    if (this.wasmFailed) return false;
    try {
      const response = await fetch(wasmUrl || 'stockfish.wasm');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const contentType = response.headers.get('content-type') || '';
      let instance;

      if (contentType.includes('application/wasm')) {
        instance = await WebAssembly.instantiateStreaming(response, this._wasmImports());
      } else {
        const buffer = await response.arrayBuffer();
        instance = await WebAssembly.instantiate(buffer, this._wasmImports());
      }

      this.wasmInstance = instance.instance || instance;
      this.wasmModule = this.wasmInstance.exports || {};

      // Stockfish WASM typically exposes a main() or _main entry and a stdout
      // callback. The standard stockfish.wasm (nnue) uses a JS glue layer.
      // We support both the raw-WASM-with-print-import pattern and the
      // emscripten-glue pattern. For raw WASM, we call the exported main()
      // to start the UCI loop, then pipe commands via a shared stdin mechanism.
      if (this.wasmModule.main) {
        try { this.wasmModule.main(); } catch (e) { /* may throw on synchronous exit */ }
      }

      this.wasmReady = true;
      return true;
    } catch (err) {
      this.wasmFailed = true;
      this.wasmReady = false;
      return false;
    }
  }

  _wasmImports() {
    const self = this;
    return {
      env: {
        print: function (ptr, len) {
          // Emscripten-style: ptr/len refer to WASM memory
          if (!self.wasmModule || !self.wasmModule.memory) return;
          const view = new Uint8Array(self.wasmModule.memory.buffer, ptr, len);
          const text = new TextDecoder().decode(view);
          self.send(text);
        },
        println: function (ptr, len) {
          if (!self.wasmModule || !self.wasmModule.memory) return;
          const view = new Uint8Array(self.wasmModule.memory.buffer, ptr, len);
          const text = new TextDecoder().decode(view);
          self.send(text);
        },
        print_err: function (ptr, len) {},
        // Stockfish JS glue typically requires these stubs
        emscripten_resize_heap: function (size) { return false; },
        emscripten_memcpy_js: function (dest, src, num) {
          if (!self.wasmModule || !self.wasmModule.memory) return 0;
          const view = new Uint8Array(self.wasmModule.memory.buffer);
          view.copyWithin(dest, src, src + num);
          return dest;
        },
        exit: function (code) {},
        abort: function () {}
      }
    };
  }

  // Send a UCI command to the WASM engine.
  // Returns true if the command was handled by WASM, false if not.
  processCommand(rawCmd) {
    if (!this.wasmReady || !this.wasmInstance) return false;
    if (!rawCmd || typeof rawCmd !== 'string') return true;

    const cmd = rawCmd.trim();
    if (!cmd) return true;
    const tokens = cmd.split(/\s+/);
    const op = tokens[0].toLowerCase();

    // Track current FEN for eval messages
    if (op === 'position') {
      if (tokens[1] === 'fen') {
        const movesIdx = tokens.findIndex((t, i) => i > 1 && t === 'moves');
        const fenParts = movesIdx >= 0 ? tokens.slice(2, movesIdx) : tokens.slice(2);
        this.currentFen = fenParts.join(' ');
      } else if (tokens[1] === 'startpos') {
        this.currentFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      }
    }

    // Pipe command to WASM
    this._writeToWasm(cmd + '\n');
    return true;
  }

  _writeToWasm(text) {
    // Write text to the WASM stdin buffer.
    // Stockfish WASM typically exposes a function to receive stdin input.
    // Common export names: _stdin_write, _fputs, or via a shared buffer.
    const mod = this.wasmModule;
    if (!mod) return;

    // Try common stdin input functions
    if (mod.stdin_write) {
      const encoder = new TextEncoder();
      const bytes = encoder.encode(text);
      if (mod.memory) {
        const view = new Uint8Array(mod.memory.buffer);
        // Write to a known stdin buffer offset if available
        if (mod.stdin_buffer) {
          view.set(bytes, mod.stdin_buffer);
          mod.stdin_write(bytes.length);
        }
      }
      return;
    }

    if (mod._stdin_write) {
      const encoder = new TextEncoder();
      const bytes = encoder.encode(text);
      if (mod.memory) {
        const view = new Uint8Array(mod.memory.buffer);
        if (mod._stdin_buffer) {
          view.set(bytes, mod._stdin_buffer);
          mod._stdin_write(bytes.length);
        }
      }
      return;
    }

    // Fallback: some Stockfish WASM builds expose a direct command function
    if (mod.uci_command || mod._uci_command) {
      const fn = mod.uci_command || mod._uci_command;
      // Allocate string in WASM memory
      const encoder = new TextEncoder();
      const bytes = encoder.encode(text + '\0');
      if (mod.memory && mod.malloc) {
        const ptr = mod.malloc(bytes.length);
        const view = new Uint8Array(mod.memory.buffer);
        view.set(bytes, ptr);
        fn(ptr);
        mod.free(ptr);
      }
    }
  }
}

// Unified Engine: routes UCI commands to WASM when available, falls back to PST.
class UnifiedEngine {
  constructor(postFn) {
    this._postFn = postFn || (() => {});
    this.pstEngine = new StockfishEngine((line) => this._postFn(line));
    this.wasmEngine = new WasmEngine((line) => this._postFn(line));
    this.activeEngine = this.pstEngine; // start with PST until WASM is ready
    this.wasmLoadAttempted = false;
    this.wasmLoadPromise = null;
  }

  get postFn() {
    return this._postFn;
  }

  set postFn(fn) {
    this._postFn = fn || (() => {});
  }

  async tryLoadWasm(wasmUrl) {
    if (this.wasmLoadAttempted) return this.wasmEngine.wasmReady;
    this.wasmLoadAttempted = true;
    this.wasmLoadPromise = this.wasmEngine.load(wasmUrl);
    const ok = await this.wasmLoadPromise;
    if (ok) {
      this.activeEngine = this.wasmEngine;
      // Re-send initial UCI handshake to WASM
      this.wasmEngine.processCommand('uci');
    }
    return ok;
  }

  get wasmReady() {
    return this.wasmEngine.wasmReady;
  }

  get multiPv() {
    return this.pstEngine.multiPv;
  }

  get parsedPosition() {
    return this.pstEngine.parsedPosition;
  }

  // Synchronous command processing (used by tests and PST fallback path).
  // When WASM is active, commands are piped asynchronously and results
  // come back via the print callback — so we return [] for the sync path.
  processCommand(rawCmd) {
    if (this.activeEngine === this.wasmEngine && this.wasmEngine.wasmReady) {
      // Pipe to WASM; results come back asynchronously
      const handled = this.wasmEngine.processCommand(rawCmd);
      if (handled) return [];
    }
    // Fallback to PST engine (synchronous)
    return this.pstEngine.processCommand(rawCmd);
  }
}

// Worker message handling
if (typeof self !== 'undefined') {
  const unified = new UnifiedEngine((line) => {
    self.postMessage({ type: 'uci', line });
  });

  // Attempt WASM load on worker startup; on failure, PST engine remains active.
  unified.tryLoadWasm('stockfish.wasm').catch(() => {});

  self.onmessage = function (event) {
    const data = event.data;
    if (!data) return;

    if (typeof data === 'string') {
      unified.processCommand(data);
    } else if (data.type === 'uci' && typeof data.command === 'string') {
      unified.processCommand(data.command);
    } else if (data.fen || data.type === 'position') {
      const fen = data.fen;
      const depth = data.depth || 3;

      // Check eval cache before computing
      const cached = getEvalFromCache(fen);
      if (cached) {
        self.postMessage({
          type: 'eval',
          fen,
          eval: cached.cp || 0,
          evalCp: cached.cp || 0,
          bestMove: cached.bestmove || 'e2e4',
          pv: cached.bestmove ? [cached.bestmove] : ['e2e4'],
          multipv: [],
          cached: true
        });
        return;
      }

      if (unified.wasmReady) {
        // WASM path: pipe commands, results arrive asynchronously via print callback
        unified.processCommand(`position fen ${fen}`);
        unified.processCommand(`go depth ${depth}`);
      } else {
        // PST path: synchronous, return results immediately
        unified.processCommand(`position fen ${fen}`);
        const results = unified.processCommand(`go depth ${depth}`);
        const primary = results && results[0];

        // Persist eval to cache
        if (primary) {
          try {
            saveEvalToCache(fen, {
              cp: primary.scoreRaw,
              depth: depth,
              mate: null,
              bestmove: primary.bestMove
            });
          } catch (_) { /* graceful degradation */ }
        }

        self.postMessage({
          type: 'eval',
          fen,
          eval: primary ? primary.scoreRaw : 0,
          evalCp: primary ? primary.scoreCp : 0,
          bestMove: primary ? primary.bestMove : 'e2e4',
          pv: primary ? [primary.bestMove] : ['e2e4'],
          multipv: results || []
        });
      }
    }
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    parseFen,
    evaluatePosition,
    findBestMove,
    generateCandidateMoves,
    evaluateMultiPV,
    StockfishEngine,
    WasmEngine,
    UnifiedEngine,
    isSquareAttacked,
    isKingInCheck,
    fenCacheKey,
    getEvalFromCache,
    saveEvalToCache
  };
}
