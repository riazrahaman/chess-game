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

function generateCandidateMoves(parsed) {
  if (!parsed || !parsed.pieces) return [];
  const turn = parsed.turn;
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

      // Castling
      const castling = parsed.castling || '';
      if (turn === 'white' && sq === 'e1') {
        if (castling.includes('K') && isSquareEmpty('f1') && isSquareEmpty('g1')) addMove('e1', 'g1');
        if (castling.includes('Q') && isSquareEmpty('d1') && isSquareEmpty('c1') && isSquareEmpty('b1')) addMove('e1', 'c1');
      } else if (turn === 'black' && sq === 'e8') {
        if (castling.includes('k') && isSquareEmpty('f8') && isSquareEmpty('g8')) addMove('e8', 'g8');
        if (castling.includes('q') && isSquareEmpty('d8') && isSquareEmpty('c8') && isSquareEmpty('b8')) addMove('e8', 'c8');
      }
    }
  }

  return moves;
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
    return evaluatePosition(parsed);
  }

  // Move ordering: evaluate captures first
  moves.sort((a, b) => {
    const capA = parsed.pieces[a.to] ? PIECE_VALUES[parsed.pieces[a.to].type] : 0;
    const capB = parsed.pieces[b.to] ? PIECE_VALUES[parsed.pieces[b.to].type] : 0;
    return capB - capA;
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
function evaluateMultiPV(parsed, depth = 3, multiPvCount = 1) {
  if (!parsed) return [];
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

function findBestMove(parsed) {
  const results = evaluateMultiPV(parsed, 2, 1);
  if (results.length > 0) {
    return { bestMove: results[0].bestMove, evalScore: results[0].scoreRaw };
  }
  return { bestMove: 'e2e4', evalScore: 0 };
}

// Stockfish Engine UCI Controller
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

// Worker message handling
if (typeof self !== 'undefined') {
  const workerEngine = new StockfishEngine((line) => {
    self.postMessage({ type: 'uci', line });
  });

  self.onmessage = function (event) {
    const data = event.data;
    if (!data) return;

    if (typeof data === 'string') {
      workerEngine.processCommand(data);
    } else if (data.type === 'uci' && typeof data.command === 'string') {
      workerEngine.processCommand(data.command);
    } else if (data.fen || data.type === 'position') {
      const fen = data.fen;
      workerEngine.processCommand(`position fen ${fen}`);
      const depth = data.depth || 3;
      const results = workerEngine.processCommand(`go depth ${depth}`);
      const primary = results && results[0];
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
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    parseFen,
    evaluatePosition,
    findBestMove,
    generateCandidateMoves,
    evaluateMultiPV,
    StockfishEngine
  };
}
