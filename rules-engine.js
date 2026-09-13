/**
 * RulesEngine adapter — wraps chess.js (jhlywa) as an alternative rules
 * authority. Provides the same conceptual surface as the in-house engine.js
 * (legal moves, make-move, check/mate/stalemate, SAN, FEN in/out) but backed
 * by the canonical chess.js library.
 *
 * Dual-format module: works as CommonJS (Node.js) and as a browser script.
 * In the browser, `chess.js` must be loaded before this file (it attaches
 * `Chess` to the global scope or as an ESM import depending on the build).
 *
 * Board <-> FEN conversion bridges the in-house board representation (object
 * with `pieces` keyed by algebraic square, `castling`, `enPassant`, `turn`,
 * `halfmoveClock`, `fullmoveNumber`) and chess.js's FEN string interface.
 */

(function () {
  'use strict';

  var FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  var RANKS = ['1', '2', '3', '4', '5', '6', '7', '8'];

  function loadChessJs() {
    if (typeof module !== 'undefined' && module.exports) {
      return require('chess.js').Chess;
    }
    if (typeof globalThis !== 'undefined' && globalThis.Chess) {
      return globalThis.Chess;
    }
    if (typeof window !== 'undefined' && window.Chess) {
      return window.Chess;
    }
    throw new Error('rules-engine.js: chess.js (Chess constructor) not found');
  }

  var Chess = loadChessJs();

  var PIECE_TYPE_MAP = {
    p: 'p', n: 'n', b: 'b', r: 'r', q: 'q', k: 'k'
  };

  function boardToFen(board) {
    if (!board || !board.pieces) {
      throw new Error('boardToFen: invalid board object');
    }
    var rows = [];
    for (var ri = 8; ri >= 1; ri--) {
      var row = '';
      var empty = 0;
      for (var fi = 0; fi < 8; fi++) {
        var sq = FILES[fi] + ri;
        var p = board.pieces[sq];
        if (!p) {
          empty++;
        } else {
          if (empty > 0) { row += empty; empty = 0; }
          var letter = PIECE_TYPE_MAP[p.type] || p.type;
          row += (p.color === 'white') ? letter.toUpperCase() : letter.toLowerCase();
        }
      }
      if (empty > 0) row += empty;
      rows.push(row);
    }
    var placement = rows.join('/');

    var turn = board.turn === 'black' ? 'b' : 'w';

    var castling = '';
    if (board.castling) {
      if (board.castling.white && board.castling.white.kingSide) castling += 'K';
      if (board.castling.white && board.castling.white.queenSide) castling += 'Q';
      if (board.castling.black && board.castling.black.kingSide) castling += 'k';
      if (board.castling.black && board.castling.black.queenSide) castling += 'q';
    }
    if (castling === '') castling = '-';

    var ep = board.enPassant || '-';
    var halfmove = (typeof board.halfmoveClock === 'number') ? board.halfmoveClock : 0;
    var fullmove = (typeof board.fullmoveNumber === 'number') ? board.fullmoveNumber : 1;

    return placement + ' ' + turn + ' ' + castling + ' ' + ep + ' ' + halfmove + ' ' + fullmove;
  }

  function fenToBoard(fen) {
    if (typeof fen !== 'string') throw new Error('fenToBoard: fen must be a string');
    var parts = fen.split(/\s+/);
    var placement = parts[0];
    var turn = parts[1] || 'w';
    var castlingStr = parts[2] || '-';
    var ep = parts[3] || '-';
    var halfmove = parts[4] !== undefined ? parseInt(parts[4], 10) : 0;
    var fullmove = parts[5] !== undefined ? parseInt(parts[5], 10) : 1;

    var pieces = {};
    for (var i = 0; i < 8; i++) {
      for (var j = 0; j < 8; j++) {
        pieces[FILES[j] + RANKS[i]] = null;
      }
    }

    var rows = placement.split('/');
    for (var ri = 0; ri < 8; ri++) {
      var rank = 8 - ri;
      var fileIdx = 0;
      var rowStr = rows[ri] || '';
      for (var ci = 0; ci < rowStr.length; ci++) {
        var ch = rowStr[ci];
        if (ch >= '1' && ch <= '8') {
          fileIdx += parseInt(ch, 10);
        } else {
          var color = (ch === ch.toUpperCase()) ? 'white' : 'black';
          var type = ch.toLowerCase();
          var sq = FILES[fileIdx] + rank;
          pieces[sq] = { type: type, color: color };
          fileIdx++;
        }
      }
    }

    return {
      pieces: pieces,
      castling: {
        white: {
          kingSide: castlingStr.indexOf('K') !== -1,
          queenSide: castlingStr.indexOf('Q') !== -1
        },
        black: {
          kingSide: castlingStr.indexOf('k') !== -1,
          queenSide: castlingStr.indexOf('q') !== -1
        }
      },
      enPassant: (ep && ep !== '-') ? ep : null,
      turn: turn === 'b' ? 'black' : 'white',
      halfmoveClock: halfmove,
      fullmoveNumber: fullmove
    };
  }

  function create(boardOrFen) {
    var fen;
    if (typeof boardOrFen === 'string') {
      fen = boardOrFen;
    } else if (boardOrFen && boardOrFen.pieces) {
      fen = boardToFen(boardOrFen);
    } else {
      fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    }
    return new Chess(fen);
  }

  function legalMoves(boardOrFen) {
    var instance = create(boardOrFen);
    var verbose = instance.moves({ verbose: true });
    var result = [];
    for (var i = 0; i < verbose.length; i++) {
      var m = verbose[i];
      var from = m.from;
      var to = m.to;
      // chess.js returns one verbose move per promotion piece, each carrying
      // a `promotion` field. Use it directly instead of re-expanding.
      if (m.promotion) {
        result.push(from + to + m.promotion);
      } else {
        result.push(from + to);
      }
    }
    return result;
  }

  function legalMovesForSquare(boardOrFen, square) {
    var instance = create(boardOrFen);
    var verbose = instance.moves({ verbose: true, square: square });
    var result = [];
    for (var i = 0; i < verbose.length; i++) {
      var m = verbose[i];
      if (m.promotion) {
        result.push(m.to + m.promotion);
      } else {
        result.push(m.to);
      }
    }
    return result;
  }

  function makeMove(boardOrFen, from, to, promotion) {
    var instance = create(boardOrFen);
    var moveObj = {
      from: from,
      to: to
    };
    if (promotion) {
      moveObj.promotion = promotion;
    }
    var result = instance.move(moveObj);
    if (!result) return null;
    return {
      fen: instance.fen(),
      board: fenToBoard(instance.fen()),
      san: result.san,
      move: result
    };
  }

  function isCheck(boardOrFen) {
    var instance = create(boardOrFen);
    return instance.isCheck();
  }

  function isCheckmate(boardOrFen) {
    var instance = create(boardOrFen);
    return instance.isCheckmate();
  }

  function isStalemate(boardOrFen) {
    var instance = create(boardOrFen);
    return instance.isStalemate();
  }

  function getGameStatus(boardOrFen) {
    var instance = create(boardOrFen);
    if (instance.isCheckmate()) return 'checkmate';
    if (instance.isStalemate()) return 'stalemate';
    if (instance.isCheck()) return 'check';
    return 'ongoing';
  }

  function san(boardOrFen, from, to, promotion) {
    var instance = create(boardOrFen);
    var moveObj = { from: from, to: to };
    if (promotion) moveObj.promotion = promotion;
    var result = instance.move(moveObj);
    if (!result) return null;
    return result.san;
  }

  function historyToSan(history) {
    var instance = new Chess();
    var sans = [];
    for (var i = 0; i < history.length; i++) {
      var moveStr = history[i];
      var from = moveStr.slice(0, 2);
      var to = moveStr.slice(2, 4);
      var promo = moveStr[4];
      var moveObj = { from: from, to: to };
      if (promo) moveObj.promotion = promo;
      var result = instance.move(moveObj);
      if (!result) {
        sans.push(moveStr);
      } else {
        sans.push(result.san);
      }
    }
    return sans;
  }

  function buildPgn(sanMoves, result) {
    var pgn = '';
    for (var i = 0; i < sanMoves.length; i++) {
      if (i % 2 === 0) {
        pgn += (i / 2 + 1) + '. ' + sanMoves[i];
      } else {
        pgn += ' ' + sanMoves[i];
      }
      pgn += ' ';
    }
    pgn += (result || '*');
    return pgn.trim();
  }

  function fen(boardOrFen) {
    if (typeof boardOrFen === 'string') return boardOrFen;
    return boardToFen(boardOrFen);
  }

  function board(fenStr) {
    return fenToBoard(fenStr);
  }

  function turn(boardOrFen) {
    var instance = create(boardOrFen);
    return instance.turn() === 'w' ? 'white' : 'black';
  }

  var api = {
    boardToFen: boardToFen,
    fenToBoard: fenToBoard,
    create: create,
    legalMoves: legalMoves,
    legalMovesForSquare: legalMovesForSquare,
    makeMove: makeMove,
    isCheck: isCheck,
    isCheckmate: isCheckmate,
    isStalemate: isStalemate,
    getGameStatus: getGameStatus,
    san: san,
    historyToSan: historyToSan,
    buildPgn: buildPgn,
    fen: fen,
    board: board,
    turn: turn
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.RulesEngine = api;
  }
})();