/**
 * fen-setup.js — FEN setup / board editor.
 *
 * Validates and canonicalizes an arbitrary FEN so a room can be started from a
 * training position, composed problem, or handicap setup. Gate-4-safe: this
 * module only reads/validates a FEN string (via chess.js); it never mutates
 * referee state. The referee's own `setup` command performs the authoritative
 * board swap.
 *
 * Dual-format module: CommonJS (Node) and browser script (requires chess.js
 * loaded globally in the browser).
 */
(function () {
  'use strict';

  function loadChess() {
    if (typeof module !== 'undefined' && module.exports) {
      return require('chess.js').Chess;
    }
    if (typeof window !== 'undefined' && window.Chess) return window.Chess;
    if (typeof globalThis !== 'undefined' && globalThis.Chess) return globalThis.Chess;
    throw new Error('fen-setup.js: chess.js (Chess constructor) not found');
  }

  var Chess = loadChess();

  /**
   * Parse + validate a FEN string. Returns a normalized board descriptor or null
   * when the FEN is malformed / rejected by chess.js.
   *
   * @param {string} fen
   * @returns {{pieces:Object, turn:string, castling:Object, enPassant:string|null,
   *            halfmoveClock:number, fullmoveNumber:number, fen:string}|null}
   */
  function parseFen(fen) {
    if (typeof fen !== 'string' || !fen.trim()) return null;
    var instance;
    try {
      instance = new Chess(fen.trim());
    } catch (e) {
      return null;
    }
    var canonical = instance.fen();
    var parts = canonical.split(/\s+/);
    var turn = parts[1] === 'b' ? 'black' : 'white';
    var castlingStr = parts[2] || '-';
    var ep = parts[3] || '-';
    return {
      fen: canonical,
      turn: turn,
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
      halfmoveClock: parseInt(parts[4] || '0', 10),
      fullmoveNumber: parseInt(parts[5] || '1', 10)
    };
  }

  /**
   * Canonicalize a FEN string via chess.js (fills in missing halfmove/fullmove
   * fields, normalizes castling, strips trailing whitespace).
   * @param {string} fen
   * @returns {string|null} canonical FEN, or null if invalid.
   */
  function canonicalize(fen) {
    var parsed = parseFen(fen);
    return parsed ? parsed.fen : null;
  }

  /**
   * @param {string} fen
   * @returns {boolean}
   */
  function isValid(fen) {
    return parseFen(fen) !== null;
  }

  var api = {
    parseFen: parseFen,
    canonicalize: canonicalize,
    isValid: isValid
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.FenSetup = api;
  }
})();
