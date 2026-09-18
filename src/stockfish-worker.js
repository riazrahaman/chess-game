'use strict';

// Analysis Web Worker: real Stockfish 19 (lite WASM) with a PST fallback.
// The primary engine is the vendored Stockfish 19 lite single-threaded build
// (vendor/stockfish/, GPL-3.0), bridged over UCI by WasmEngine below. When it
// cannot load (old browser, CSP, offline first visit) the Lightweight Local
// Heuristic Engine (PST + material, alpha-beta) in this file answers instead.
// Every evaluation message says which engine produced it (`engine`, `depth`)
// and the `uci` handshake reports the honest engine identity — no aliasing
// (B8, docs/06-world-class-roadmap.md; E1 real engine).

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
      const epRank = p.color === 'white' ? 5 : 4;
      for (const df of [-1, 1]) {
        const capFile = file + df;
        if (capFile >= 0 && capFile <= 7) {
          const capSq = `${String.fromCharCode(97 + capFile)}${nextRank}`;
          const isEp = rank === epRank && Boolean(parsed.enPassant) && capSq === parsed.enPassant;
          if (isEnemySquare(capSq) || isEp) {
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

// --- Stockfish 19 (lite) WASM Engine Bridge ---
// Drives the vendored Stockfish 19 lite single-threaded build
// (vendor/stockfish/, GPL-3.0 — see vendor/stockfish/README.md) from inside
// this Web Worker. The emscripten loader is designed to run as its own
// worker (it reads the .wasm URL from its location hash, speaks raw UCI
// strings over postMessage, and serialises `go`/`setoption` while a search
// is running), so we spawn it as a nested Worker and bridge UCI over it.
// On any failure (no nested-Worker support, 404, CSP, timeout) the caller
// keeps the PST+Material engine active — nothing here throws outward.
//
// Under Node this class is inert: load() reports failure immediately so the
// PST exports (parseFen, findBestMove, ...) stay usable by bot-service.js and
// the selftests. The Node engine lives in src/engine-server.js.

const SF_LOADER_URL = '/vendor/stockfish/stockfish-19-lite-single.js';
const SF_WASM_URL = '/vendor/stockfish/stockfish-19-lite-single.wasm';
const SF_ENGINE_ID = 'stockfish19-lite';
const SF_ENGINE_NAME = 'Stockfish 19 Lite WASM (via chess-game worker)';
const PST_ENGINE_ID = 'pst';
const PST_ENGINE_NAME = 'Lightweight Local Engine (PST+Material)';
const SF_DEFAULT_DEPTH = 16;       // live-play search depth
const SF_DEFAULT_MOVETIME_MS = 1500; // wall-clock cap so slow devices stay responsive
const PST_DEFAULT_DEPTH = 3;
const SF_LOAD_TIMEOUT_MS = 30000;  // 1.8 MB download + compile on first visit
const SF_PARTIAL_MIN_DEPTH = 6;    // stream intermediate evals from this depth on
// Mate scores map onto the same magnitude the PST search() uses for
// checkmate (±100000), so evalHistory / review / ACPL see one scale.
const MATE_SCORE_RAW = 100000;

function fenTurn(fen) {
  const parts = typeof fen === 'string' ? fen.trim().split(/\s+/) : [];
  return parts[1] === 'b' ? 'black' : 'white';
}

class WasmEngine {
  constructor(postFn) {
    this.postFn = postFn || (() => {});
    // onEval receives structured evaluation messages (see _emitEval).
    this.onEval = null;
    this.wasmReady = false;
    this.wasmFailed = false;
    this.failReason = null;
    this.engineId = SF_ENGINE_ID;
    this.engineName = SF_ENGINE_NAME;
    this.loadMs = null;
    this.pendingCommands = [];
    this._lineBuffer = '';
    this.currentFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    this.lastBestMove = null;
    this.lastMultiPvResults = [];
    this._collectingEval = false;
    // Search state machine (Stockfish is single-threaded: one search at a time;
    // a new request while searching sends `stop` and waits for `bestmove`).
    this.isSearching = false;
    this.searchingFen = null;
    this.searchDepth = 0;
    this.searchAbandoned = false;
    this.pendingSearch = null; // latest-wins slot: { fen, goCommand, depth }
    this._lastPartialDepth = 0;
    this._watchdog = null;
    this.childWorker = null;
    this._handshake = null;
  }

  send(line) {
    this.postFn(line);
    this._processEngineLine(line);
  }

  // Parses one UCI output line from the engine.
  _processEngineLine(line) {
    if (!line || typeof line !== 'string') return;

    if (line.startsWith('info') && /\bscore (cp|mate)\b/.test(line)) {
      if (/\b(lowerbound|upperbound)\b/.test(line)) return; // aspiration-window noise
      const pvMatch = line.match(/\bpv\s+(.+)$/);
      const cpMatch = line.match(/score cp\s+(-?\d+)/);
      const mateMatch = line.match(/score mate\s+(-?\d+)/);
      const multipvMatch = line.match(/multipv\s+(\d+)/);
      const depthMatch = line.match(/\bdepth\s+(\d+)/);

      {
        const pvIndex = multipvMatch ? parseInt(multipvMatch[1], 10) : 1;
        const depth = depthMatch ? parseInt(depthMatch[1], 10) : 0;
        // A terminal position (mate 0 / stalemate) has a score but no pv.
        const pv = pvMatch ? pvMatch[1].trim().split(/\s+/) : [];
        const bestMove = pv[0] || null;
        // Stockfish scores are from the side to move; the UI (eval bar, evalHistory,
        // review, coach) works in White's perspective like the PST engine.
        const sign = fenTurn(this.searchingFen || this.currentFen) === 'black' ? -1 : 1;
        let scoreRaw = 0;
        let mate = null;
        if (mateMatch) {
          const plies = parseInt(mateMatch[1], 10);
          mate = plies * sign;
          const mag = MATE_SCORE_RAW - Math.min(Math.abs(plies), 999);
          scoreRaw = plies === 0 ? -sign * MATE_SCORE_RAW : (plies > 0 ? sign * mag : -sign * mag);
        } else if (cpMatch) {
          scoreRaw = parseInt(cpMatch[1], 10) * sign;
        }

        while (this.lastMultiPvResults.length < pvIndex) {
          this.lastMultiPvResults.push(null);
        }
        this.lastMultiPvResults[pvIndex - 1] = {
          pvIndex,
          bestMove,
          scoreCp: scoreRaw / 100,
          scoreRaw,
          depth,
          mate,
          pv
        };
        this._collectingEval = true;

        if (pvIndex === 1 && this.isSearching && !this.searchAbandoned &&
            depth >= SF_PARTIAL_MIN_DEPTH && depth > this._lastPartialDepth) {
          this._lastPartialDepth = depth;
          this._emitEval(true);
        }
      }
      return;
    }

    if (line.startsWith('bestmove')) {
      const mv = line.replace('bestmove ', '').trim().split(/\s+/)[0] || null;
      this.lastBestMove = mv && mv !== '(none)' ? mv : null;
      this._flushEval();
      return;
    }
  }

  _buildEvalMessage(partial) {
    const lines = this.lastMultiPvResults.filter(Boolean);
    const primary = lines[0] || {
      pvIndex: 1,
      bestMove: this.lastBestMove,
      scoreCp: 0,
      scoreRaw: 0,
      depth: 0,
      mate: null,
      pv: this.lastBestMove ? [this.lastBestMove] : []
    };
    const bestMove = partial ? primary.bestMove : (this.lastBestMove || primary.bestMove);
    return {
      type: 'eval',
      fen: this.searchingFen || this.currentFen,
      eval: primary.scoreRaw,
      evalCp: primary.scoreCp,
      mate: primary.mate === undefined ? null : primary.mate,
      bestMove: bestMove || null,
      pv: primary.pv && primary.pv.length ? primary.pv : (bestMove ? [bestMove] : []),
      multipv: lines.length > 0 ? lines : [primary],
      engine: this.engineId,
      depth: primary.depth || this.searchDepth || 0,
      partial: !!partial
    };
  }

  _emitEval(partial) {
    if (typeof this.onEval === 'function') {
      try { this.onEval(this._buildEvalMessage(partial)); } catch (_) { /* display layer only */ }
    }
  }

  _flushEval() {
    if (this.lastBestMove || this.isSearching) {
      if (!this.searchAbandoned) this._emitEval(false);
    }
    this.lastMultiPvResults = [];
    this._collectingEval = false;
    this._clearWatchdog();
    this.isSearching = false;
    this.searchAbandoned = false;
    this.searchingFen = null;
    this._lastPartialDepth = 0;
    this._startPendingSearch();
  }

  _startPendingSearch() {
    const next = this.pendingSearch;
    if (!next || this.isSearching || !this.wasmReady) return;
    this.pendingSearch = null;
    this.currentFen = next.fen;
    this.searchingFen = next.fen;
    this.searchDepth = next.depth;
    this.isSearching = true;
    this.searchAbandoned = false;
    this._lastPartialDepth = 0;
    this.lastMultiPvResults = [];
    this.lastBestMove = null;
    this._sendRaw(`position fen ${next.fen}`);
    this._sendRaw(next.goCommand);
    this._armWatchdog(next.movetime);
  }

  _armWatchdog(movetime) {
    this._clearWatchdog();
    if (typeof setTimeout !== 'function') return;
    const budget = (movetime || SF_DEFAULT_MOVETIME_MS) + 4000;
    this._watchdog = setTimeout(() => {
      this._watchdog = null;
      if (this.isSearching) this._sendRaw('stop');
    }, budget);
  }

  _clearWatchdog() {
    if (this._watchdog && typeof clearTimeout === 'function') clearTimeout(this._watchdog);
    this._watchdog = null;
  }

  _sendRaw(cmd) {
    if (!this.childWorker) return;
    try { this.childWorker.postMessage(cmd); } catch (_) { /* engine gone; watchdog/fallback handles it */ }
  }

  _fail(reason) {
    this.wasmFailed = true;
    this.wasmReady = false;
    this.failReason = reason || 'unknown';
    this._clearWatchdog();
    if (this.childWorker) {
      try { this.childWorker.terminate(); } catch (_) { /* ignore */ }
      this.childWorker = null;
    }
    return false;
  }

  // Spawns the vendored Stockfish loader as a nested Worker and completes the
  // `uci` / `isready` handshake. Resolves true when the engine answers,
  // false otherwise (never rejects).
  async load(loaderUrl, wasmUrl) {
    if (this.wasmFailed) return false;
    if (this.wasmReady) return true;
    const isBrowserWorker = typeof importScripts === 'function' && typeof Worker === 'function';
    if (!isBrowserWorker) return this._fail('not-a-browser-worker');

    const loader = loaderUrl || SF_LOADER_URL;
    const wasm = wasmUrl || SF_WASM_URL;
    const startedAt = Date.now();

    // Fail fast on a definite HTTP error (404, 403): errors thrown inside the
    // nested worker do not reliably reach child.onerror, so without this a
    // missing binary would only surface as the 30 s handshake timeout. A
    // network exception is NOT fatal here — offline, the service worker may
    // still serve the cached GET to the child.
    if (typeof fetch === 'function') {
      try {
        const head = await fetch(wasm, { method: 'HEAD' });
        if (head && head.ok === false) return this._fail(`wasm HTTP ${head.status}`);
      } catch (_) { /* proceed; the handshake timeout is the backstop */ }
    }

    let child;
    try {
      // The loader reads its .wasm URL from the first comma-separated hash segment.
      child = new Worker(`${loader}#${encodeURIComponent(wasm)}`);
    } catch (err) {
      return this._fail('nested-worker: ' + (err && err.message ? err.message : String(err)));
    }
    this.childWorker = child;

    const handshake = new Promise((resolve) => {
      let sawUciok = false;
      const timer = setTimeout(() => resolve({ ok: false, reason: 'handshake-timeout' }), SF_LOAD_TIMEOUT_MS);
      child.onerror = (ev) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: 'worker-error: ' + ((ev && ev.message) || 'unknown') });
      };
      child.onmessage = (ev) => {
        const line = typeof ev.data === 'string' ? ev.data : '';
        if (line === 'uciok') { sawUciok = true; this._sendRaw('isready'); return; }
        if (line === 'readyok' && sawUciok) { clearTimeout(timer); resolve({ ok: true }); }
      };
    });
    this._sendRaw('uci');
    const result = await handshake;
    if (!result.ok) return this._fail(result.reason);

    this.loadMs = Date.now() - startedAt;
    this.wasmReady = true;
    this.wasmFailed = false;
    child.onerror = () => { /* post-handshake errors surface via the watchdog */ };
    child.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let line = ev.data;
      if (line.startsWith('id name ')) line = `id name ${SF_ENGINE_NAME}`;
      this.send(line);
    };
    return true;
  }

  // Sends a UCI command to Stockfish. Returns true if handled, false when the
  // engine is not ready (caller falls back to the PST engine).
  processCommand(rawCmd) {
    if (!this.wasmReady || !this.childWorker) return false;
    if (!rawCmd || typeof rawCmd !== 'string') return true;
    const cmd = rawCmd.trim();
    if (!cmd) return true;
    const tokens = cmd.split(/\s+/);
    const op = tokens[0].toLowerCase();

    if (op === 'position') {
      // Held back and sent together with the next `go` so a search in flight
      // is never re-rooted underneath Stockfish.
      if (tokens[1] === 'fen') {
        const movesIdx = tokens.findIndex((t, i) => i > 1 && t === 'moves');
        const fenParts = movesIdx >= 0 ? tokens.slice(2, movesIdx) : tokens.slice(2);
        this.currentFen = fenParts.join(' ');
      } else if (tokens[1] === 'startpos') {
        this.currentFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      }
      return true;
    }

    if (op === 'go') {
      const depthIdx = tokens.findIndex(t => t.toLowerCase() === 'depth');
      const mtIdx = tokens.findIndex(t => t.toLowerCase() === 'movetime');
      const depth = depthIdx >= 0 ? (parseInt(tokens[depthIdx + 1], 10) || SF_DEFAULT_DEPTH) : SF_DEFAULT_DEPTH;
      const movetime = mtIdx >= 0 ? (parseInt(tokens[mtIdx + 1], 10) || SF_DEFAULT_MOVETIME_MS) : null;
      this.pendingSearch = { fen: this.currentFen, goCommand: cmd, depth, movetime };
      if (this.isSearching) {
        this.searchAbandoned = true; // its bestmove belongs to a superseded position
        this._sendRaw('stop');
      } else {
        this._startPendingSearch();
      }
      return true;
    }

    if (op === 'stop') {
      this.pendingSearch = null;
      if (this.isSearching) this._sendRaw('stop');
      return true;
    }

    this._sendRaw(cmd);
    return true;
  }
}

// Unified Engine: routes UCI commands to Stockfish when available, falls back to PST.
class UnifiedEngine {
  constructor(postFn) {
    this._postFn = postFn || (() => {});
    this.pstEngine = new StockfishEngine((line) => this._postFn(line));
    this.wasmEngine = new WasmEngine((line) => this._postFn(line));
    this.activeEngine = this.pstEngine; // start with PST until Stockfish is ready
    this.wasmLoadAttempted = false;
    this.wasmLoadPromise = null;
  }

  get postFn() {
    return this._postFn;
  }

  set postFn(fn) {
    this._postFn = fn || (() => {});
  }

  async tryLoadWasm(loaderUrl, wasmUrl) {
    if (this.wasmLoadAttempted) return this.wasmEngine.wasmReady;
    this.wasmLoadAttempted = true;
    this.wasmLoadPromise = this.wasmEngine.load(loaderUrl, wasmUrl);
    const ok = await this.wasmLoadPromise;
    if (ok) {
      this.activeEngine = this.wasmEngine;
      this.wasmEngine.processCommand('ucinewgame');
      this.wasmEngine.processCommand(`setoption name MultiPV value ${this.pstEngine.multiPv}`);
    }
    return ok;
  }

  get wasmReady() {
    return this.wasmEngine.wasmReady;
  }

  get engineId() {
    return this.wasmReady ? this.wasmEngine.engineId : PST_ENGINE_ID;
  }

  get engineName() {
    return this.wasmReady ? this.wasmEngine.engineName : PST_ENGINE_NAME;
  }

  get defaultDepth() {
    return this.wasmReady ? SF_DEFAULT_DEPTH : PST_DEFAULT_DEPTH;
  }

  get multiPv() {
    return this.pstEngine.multiPv;
  }

  get parsedPosition() {
    return this.pstEngine.parsedPosition;
  }

  // Synchronous command processing (used by tests and PST fallback path).
  // When Stockfish is active, commands are piped asynchronously and results
  // come back via the child worker — so we return [] for that path.
  processCommand(rawCmd) {
    if (this.activeEngine === this.wasmEngine && this.wasmEngine.wasmReady) {
      const op = typeof rawCmd === 'string' ? rawCmd.trim().split(/\s+/)[0].toLowerCase() : '';
      // Keep the PST engine's option state in sync so a later fallback (and
      // the multiPv getter) reflect what the UI asked for.
      if (op === 'setoption') this.pstEngine.processCommand(rawCmd);
      const handled = this.wasmEngine.processCommand(rawCmd);
      if (handled) return [];
    }
    return this.pstEngine.processCommand(rawCmd);
  }
}

// Worker message handling
if (typeof self !== 'undefined' && typeof importScripts === 'function') {
  const unified = new UnifiedEngine((line) => {
    self.postMessage({ type: 'uci', line });
  });
  let latestRequest = null; // { fen, depth, movetime } — re-run once Stockfish is up

  function postEval(msg) {
    self.postMessage(msg);
  }

  unified.wasmEngine.onEval = (msg) => {
    if (!msg.partial) {
      try {
        saveEvalToCache(msg.fen, {
          cp: msg.eval,
          depth: msg.depth,
          mate: msg.mate,
          bestmove: msg.bestMove,
          engine: msg.engine,
          multipv: msg.multipv
        });
      } catch (_) { /* graceful degradation */ }
    }
    postEval(msg);
  };

  function requestAnalysis(fen, depth, movetime) {
    const engineId = unified.engineId;
    const targetDepth = depth || unified.defaultDepth;

    const cached = getEvalFromCache(fen);
    if (cached && cached.engine === engineId && (cached.depth || 0) >= targetDepth) {
      postEval({
        type: 'eval',
        fen,
        eval: cached.cp || 0,
        evalCp: (cached.cp || 0) / 100,
        mate: cached.mate === undefined ? null : cached.mate,
        bestMove: cached.bestmove || null,
        pv: cached.bestmove ? [cached.bestmove] : [],
        multipv: Array.isArray(cached.multipv) ? cached.multipv : [],
        engine: engineId,
        depth: cached.depth || 0,
        partial: false,
        cached: true
      });
      return;
    }

    if (unified.wasmReady) {
      // Stockfish path: results arrive asynchronously via wasmEngine.onEval.
      unified.processCommand(`position fen ${fen}`);
      unified.processCommand(`go depth ${targetDepth} movetime ${movetime || SF_DEFAULT_MOVETIME_MS}`);
      return;
    }

    // PST path: synchronous.
    unified.processCommand(`position fen ${fen}`);
    const results = unified.processCommand(`go depth ${targetDepth}`);
    const primary = results && results[0];
    if (primary) {
      try {
        saveEvalToCache(fen, {
          cp: primary.scoreRaw,
          depth: targetDepth,
          mate: null,
          bestmove: primary.bestMove,
          engine: PST_ENGINE_ID,
          multipv: results
        });
      } catch (_) { /* graceful degradation */ }
    }
    postEval({
      type: 'eval',
      fen,
      eval: primary ? primary.scoreRaw : 0,
      evalCp: primary ? primary.scoreCp : 0,
      mate: null,
      bestMove: primary ? primary.bestMove : null,
      pv: primary ? [primary.bestMove] : [],
      multipv: results || [],
      engine: PST_ENGINE_ID,
      depth: targetDepth,
      partial: false
    });
  }

  // Load Stockfish on worker startup; on failure the PST engine stays active.
  const loadStartedAt = Date.now();
  unified.tryLoadWasm(SF_LOADER_URL, SF_WASM_URL).catch(() => false).then((ok) => {
    self.postMessage({
      type: 'engine-ready',
      engine: unified.engineId,
      name: unified.engineName,
      depth: unified.defaultDepth,
      loadMs: Date.now() - loadStartedAt,
      fallbackReason: ok ? null : (unified.wasmEngine.failReason || 'unknown')
    });
    // Upgrade whatever the PST engine answered while Stockfish was loading.
    if (ok && latestRequest) {
      requestAnalysis(latestRequest.fen, latestRequest.depth, latestRequest.movetime);
    }
  });

  self.onmessage = function (event) {
    const data = event.data;
    if (!data) return;

    if (typeof data === 'string') {
      unified.processCommand(data);
    } else if (data.type === 'uci' && typeof data.command === 'string') {
      unified.processCommand(data.command);
    } else if (data.fen || data.type === 'position') {
      if (typeof data.fen !== 'string' || !data.fen) return;
      latestRequest = { fen: data.fen, depth: data.depth || null, movetime: data.movetime || null };
      requestAnalysis(latestRequest.fen, latestRequest.depth, latestRequest.movetime);
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
    saveEvalToCache,
    SF_LOADER_URL,
    SF_WASM_URL,
    SF_ENGINE_ID,
    SF_ENGINE_NAME,
    PST_ENGINE_ID,
    PST_ENGINE_NAME,
    SF_DEFAULT_DEPTH,
    SF_DEFAULT_MOVETIME_MS
  };
}
