/**
 * chess960.js — Chess960 (Fischer Random) start-position generation and
 * castling rules.
 *
 * Self-contained, pure-data + rules module (no referee mutation). Generates the
 * 960 legal starting positions via the Scharnagl SP-number scheme (N = 0..959)
 * and evaluates Chess960 castling per FIDE rules:
 *
 *   - Kingside castling (O-O):  king ends on the g-file, rook on the f-file.
 *   - Queenside castling (O-O-O): king ends on the c-file, rook on the d-file.
 *   - The squares between the king's start and target, and between the rook's
 *     start and target, must be empty (apart from the two moving pieces).
 *   - The king may not start on, pass through, or land on an attacked square.
 *
 * The generated start position is expressed both as a FEN string and as a
 * board object using the same shape as engine.js ({ pieces, castling,
 * enPassant, turn, halfmoveClock, fullmoveNumber }).
 *
 * Dual-format module: CommonJS (Node) and browser script.
 */
(function () {
  'use strict';

  var FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

  // The 10 ways to place two knights among 5 remaining empty squares
  // (0-based indices into the 5-square list). Standard Chess960 N5N table.
  var KNIGHT_PLACEMENTS = [
    [0, 1], [0, 2], [0, 3], [0, 4],
    [1, 2], [1, 3], [1, 4],
    [2, 3], [2, 4],
    [3, 4]
  ];

  function clonePieces(pieces) {
    var out = {};
    for (var k in pieces) {
      if (Object.prototype.hasOwnProperty.call(pieces, k)) out[k] = pieces[k];
    }
    return out;
  }

  /**
   * Generate a Chess960 starting position from an SP number (0..959).
   * Returns { sp, pieces, fen, kingFile, rookFiles } where pieces is the
   * board map keyed by algebraic square and rookFiles = { white: {k, q},
   * black: {k, q} } gives the rook files (a..h) for each castling side.
   */
  function generatePosition(sp) {
    var originalSp = ((sp % 960) + 960) % 960;
    var n = originalSp;

    // 1. Bishops: one on each color (light-squared bishop first).
    var b1 = n % 4;              n = Math.floor(n / 4); // light-squared bishop
    var b2 = n % 4;              n = Math.floor(n / 4); // dark-squared bishop
    // 2. Queen.
    var q = n % 6;               n = Math.floor(n / 6);
    // 3. Knights.
    var knightIdx = n;           // 0..9

    // Back-rank order a..h (indices 0..7).
    var backRank = [null, null, null, null, null, null, null, null];

    // a1 is a dark square; light squares are the odd file indices (b,d,f,h).
    //   light-squared bishop -> file 2*b1+1 (odd indices = light squares)
    //   dark-squared bishop  -> file 2*b2   (even indices = dark squares)
    backRank[b1 * 2 + 1] = 'b';
    backRank[b2 * 2] = 'b';

    // Queen on the (q)th empty square.
    var empty = [];
    for (var i = 0; i < 8; i++) { if (backRank[i] === null) empty.push(i); }
    backRank[empty[q]] = 'q';

    // Knights on the knightIdx-th combination of the 5 remaining squares.
    empty = [];
    for (var j = 0; j < 8; j++) { if (backRank[j] === null) empty.push(j); }
    var combo = KNIGHT_PLACEMENTS[knightIdx];
    backRank[empty[combo[0]]] = 'n';
    backRank[empty[combo[1]]] = 'n';

    // Remaining 3 squares: rook, king, rook.
    empty = [];
    for (var m = 0; m < 8; m++) { if (backRank[m] === null) empty.push(m); }
    backRank[empty[0]] = 'r';
    backRank[empty[1]] = 'k';
    backRank[empty[2]] = 'r';

    // Build the pieces map.
    var pieces = {};
    var squares = [];
    for (var f = 0; f < 8; f++) {
      for (var r = 1; r <= 8; r++) {
        squares.push(FILES[f] + r);
        pieces[FILES[f] + r] = null;
      }
    }
    // White back rank (rank 1) and black back rank (rank 8).
    for (var bi = 0; bi < 8; bi++) {
      pieces[FILES[bi] + '1'] = { type: backRank[bi], color: 'white' };
      pieces[FILES[bi] + '8'] = { type: backRank[bi], color: 'black' };
    }
    // Pawns.
    for (var pf = 0; pf < 8; pf++) {
      pieces[FILES[pf] + '2'] = { type: 'p', color: 'white' };
      pieces[FILES[pf] + '7'] = { type: 'p', color: 'black' };
    }

    // Locate king + rook files.
    var kingFileW = -1, rookKFileW = -1, rookQFileW = -1;
    for (var rf = 0; rf < 8; rf++) {
      var t = backRank[rf];
      if (t === 'k') kingFileW = rf;
      else if (t === 'r') {
        if (rookQFileW === -1) rookQFileW = rf; else rookKFileW = rf;
      }
    }
    // Ensure rookQ is the one left of the king, rookK right of the king.
    if (rookQFileW > kingFileW) { var tmpR = rookQFileW; rookQFileW = rookKFileW; rookKFileW = tmpR; }

    var fen = buildFen(pieces);

    return {
      sp: originalSp,
      pieces: pieces,
      fen: fen,
      kingFile: { white: FILES[kingFileW], black: FILES[kingFileW] },
      rookFiles: {
        white: { k: FILES[rookKFileW], q: FILES[rookQFileW] },
        black: { k: FILES[rookKFileW], q: FILES[rookQFileW] }
      },
      board: {
        pieces: pieces,
        castling: {
          white: { kingSide: true, queenSide: true },
          black: { kingSide: true, queenSide: true }
        },
        enPassant: null,
        turn: 'white',
        halfmoveClock: 0,
        fullmoveNumber: 1
      }
    };
  }

  function buildFen(pieces) {
    var rows = [];
    for (var r = 8; r >= 1; r--) {
      var row = '';
      var emptyCount = 0;
      for (var f = 0; f < 8; f++) {
        var p = pieces[FILES[f] + r];
        if (!p) { emptyCount++; continue; }
        if (emptyCount > 0) { row += emptyCount; emptyCount = 0; }
        var ch = p.type;
        if (p.color === 'white') ch = ch.toUpperCase();
        row += ch;
      }
      if (emptyCount > 0) row += emptyCount;
      rows.push(row);
    }
    return rows.join('/') + ' w KQkq - 0 1';
  }

  /**
   * Check whether a square is attacked by `byColor` on the given pieces map.
   * Lightweight attack detection (king, queen, rook, bishop, knight, pawn)
   * sufficient for castling legality (king-passage squares).
   */
  function isSquareAttacked(pieces, targetSq, byColor) {
    var tf = targetSq.charCodeAt(0) - 97;
    var tr = parseInt(targetSq[1], 10);
    var opp = byColor === 'white' ? 'black' : 'white';

    // Pawn attacks: a pawn of `byColor` attacks diagonally "forward".
    var pawnDir = byColor === 'white' ? 1 : -1;
    var pr = tr - pawnDir;
    if (pr >= 1 && pr <= 8) {
      for (var pdf = -1; pdf <= 1; pdf += 2) {
        var paf = tf + pdf;
        if (paf >= 0 && paf < 8) {
          var pp = pieces[FILES[paf] + pr];
          if (pp && pp.type === 'p' && pp.color === byColor) return true;
        }
      }
    }

    // Knight.
    var knightOffsets = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
    for (var ko = 0; ko < knightOffsets.length; ko++) {
      var kf = tf + knightOffsets[ko][0];
      var kr = tr + knightOffsets[ko][1];
      if (kf >= 0 && kf < 8 && kr >= 1 && kr <= 8) {
        var np = pieces[FILES[kf] + kr];
        if (np && np.type === 'n' && np.color === byColor) return true;
      }
    }

    // King.
    var kingOffsets = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
    for (var go = 0; go < kingOffsets.length; go++) {
      var gf = tf + kingOffsets[go][0];
      var gr = tr + kingOffsets[go][1];
      if (gf >= 0 && gf < 8 && gr >= 1 && gr <= 8) {
        var gp = pieces[FILES[gf] + gr];
        if (gp && gp.type === 'k' && gp.color === byColor) return true;
      }
    }

    // Sliding pieces: rook/queen (orthogonal) and bishop/queen (diagonal).
    var rookDirs = [[1,0],[-1,0],[0,1],[0,-1]];
    var bishopDirs = [[1,1],[1,-1],[-1,1],[-1,-1]];
    for (var d = 0; d < 4; d++) {
      // Rook/queen along rookDirs.
      var rf2 = tf, rr2 = tr;
      while (true) {
        rf2 += rookDirs[d][0]; rr2 += rookDirs[d][1];
        if (rf2 < 0 || rf2 >= 8 || rr2 < 1 || rr2 > 8) break;
        var sp = pieces[FILES[rf2] + rr2];
        if (sp) {
          if (sp.color === byColor && (sp.type === 'r' || sp.type === 'q')) return true;
          break;
        }
      }
      // Bishop/queen along bishopDirs.
      var bf = tf, br = tr;
      while (true) {
        bf += bishopDirs[d][0]; br += bishopDirs[d][1];
        if (bf < 0 || bf >= 8 || br < 1 || br > 8) break;
        var bp = pieces[FILES[bf] + br];
        if (bp) {
          if (bp.color === byColor && (bp.type === 'b' || bp.type === 'q')) return true;
          break;
        }
      }
    }

    return false;
  }

  /**
   * Determine whether castling is legal for `color` on `side` ('k' kingside or
   * 'q' queenside) from a Chess960 position, and return the resulting board if
   * legal, or null if illegal.
   *
   * @param {Object} board - { pieces, castling, turn, ... } (engine.js shape).
   * @param {'white'|'black'} color - the side to move (must equal board.turn).
   * @param {'k'|'q'} side
   * @param {string} [kingFile] - file letter of the king (defaults to e).
   * @param {string} [rookFile] - file letter of the castling rook.
   */
  function castle(board, color, side, kingFile, rookFile) {
    if (!board || !board.pieces) return null;
    var opp = color === 'white' ? 'black' : 'white';
    var rank = color === 'white' ? '1' : '8';

    var kf = kingFile || 'e';
    var rr = rookFile || (side === 'k'
      ? (color === 'white' ? 'h' : 'h')
      : (color === 'white' ? 'a' : 'a'));

    var kingFrom = kf + rank;
    var rookFrom = rr + rank;

    var king = board.pieces[kingFrom];
    var rook = board.pieces[rookFrom];
    if (!king || king.type !== 'k' || king.color !== color) return null;
    if (!rook || rook.type !== 'r' || rook.color !== color) return null;

    var castlingFlag = side === 'k' ? 'kingSide' : 'queenSide';
    if (!board.castling || !board.castling[color] || !board.castling[color][castlingFlag]) {
      return null;
    }

    // Target squares are the same as standard chess regardless of start files.
    var kingTo = (side === 'k' ? 'g' : 'c') + rank;
    var rookTo = (side === 'k' ? 'f' : 'd') + rank;

    // King may not currently be in check.
    if (isSquareAttacked(board.pieces, kingFrom, opp)) return null;

    // All squares between king start and target (inclusive of target) that the
    // king traverses must not be attacked, and the path must be clear.
    var kfIdx = kf.charCodeAt(0) - 97;
    var ktIdx = (side === 'k' ? 6 : 2); // g=6, c=2
    var step = ktIdx > kfIdx ? 1 : -1;
    for (var x = kfIdx; x !== ktIdx; x += step) {
      var sq = FILES[x] + rank;
      if (isSquareAttacked(board.pieces, sq, opp)) return null;
    }
    // Target square attacked check.
    if (isSquareAttacked(board.pieces, kingTo, opp)) return null;

    // Path-clear check: squares strictly between the king/rook start and their
    // final squares must be empty (ignoring the two moving pieces themselves).
    var rfIdx = rr.charCodeAt(0) - 97;
    var rtIdx = (side === 'k' ? 5 : 3); // f=5, d=3
    var kmin = Math.min(kfIdx, ktIdx), kmax = Math.max(kfIdx, ktIdx);
    var rmin = Math.min(rfIdx, rtIdx), rmax = Math.max(rfIdx, rtIdx);
    for (var fi = 0; fi < 8; fi++) {
      var isKingPath = fi >= kmin && fi <= kmax;
      var isRookPath = fi >= rmin && fi <= rmax;
      if (!isKingPath && !isRookPath) continue;
      var sqP = FILES[fi] + rank;
      var occupant = board.pieces[sqP];
      if (!occupant) continue;
      var sqStr = FILES[fi];
      if (sqStr === kf || sqStr === rr) continue; // the two castling pieces
      return null; // blocked
    }

    // Build resulting board.
    var newPieces = clonePieces(board.pieces);
    newPieces[kingFrom] = null;
    newPieces[rookFrom] = null;
    newPieces[kingTo] = { type: 'k', color: color };
    newPieces[rookTo] = { type: 'r', color: color };

    var castling = {
      white: {
        kingSide: board.castling.white.kingSide,
        queenSide: board.castling.white.queenSide
      },
      black: {
        kingSide: board.castling.black.kingSide,
        queenSide: board.castling.black.queenSide
      }
    };
    castling[color].kingSide = false;
    castling[color].queenSide = false;

    return {
      pieces: newPieces,
      castling: castling,
      enPassant: null,
      turn: opp,
      halfmoveClock: (board.halfmoveClock || 0) + 1,
      fullmoveNumber: board.fullmoveNumber || 1
    };
  }

  /**
   * Validate a SP number and return a normalized 0..959 value (or null).
   */
  function normalizeSp(sp) {
    if (typeof sp !== 'number' || !Number.isFinite(sp) || sp < 0 || sp >= 960) return null;
    if (sp !== Math.floor(sp)) return null;
    return sp;
  }

  var api = {
    generatePosition: generatePosition,
    isSquareAttacked: isSquareAttacked,
    castle: castle,
    normalizeSp: normalizeSp,
    FILES: FILES,
    KNIGHT_PLACEMENTS: KNIGHT_PLACEMENTS,
    TOTAL_POSITIONS: 960
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.Chess960 = api;
  }
})();
