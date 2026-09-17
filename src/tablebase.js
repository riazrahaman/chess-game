/**
 * tablebase.js — A2.5 Tablebase (online probe, 7-piece WDL/DTZ).
 *
 * Pure, analysis-only module. It probes the lichess Syzygy tablebase endpoint
 * (tablebase.lichess.ovh) for the best move / outcome of an endgame FEN in a
 * single fetch, and degrades gracefully to "no tablebase data" (reason:
 * fallback) when the position is too complex (> 7 pieces) or the network call
 * fails. The caller (the analysis worker) then uses its own engine eval as the
 * offline fallback — so this module never computes or mutates game state.
 *
 * Gate-4 safe: no makeMove/createInitialBoard, no require of the referee /
 * rules-engine / engine. The network transport is dependency-injected
 * (`opts.fetchImpl`, defaulting to the global `fetch`), so the selftest stubs
 * it and performs no real network access.
 *
 * Determinism: no Math.random anywhere.
 *
 * Dual-format module: CommonJS (Node) and browser script.
 */
(function () {
    'use strict';

   var LICHES_TT_URL = 'https://tablebase.lichess.ovh/standard';
   var MAX_PIECES = 7;

    /**
    * Count the pieces on the board from a FEN string.
    * @param {string} fen
    * @returns {number}
    */
   function countPiecesInFen(fen) {
      if (typeof fen !== 'string') return 0;
      var board = fen.trim().split(/\s+/)[0] || '';
      var count = 0;
      for (var i = 0; i < board.length; i++) {
        var c = board[i];
          // Only letters are pieces; digits are empty-square runs, '/' is the
          // row separator.
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) count++;
          }
      return count;
       }

    /**
    * Build the tablebase probe URL for a FEN.
    * @param {string} fen
    * @param {('wdl'|'dtz')} type
    * @returns {string}
    */
   function buildUrl(fen, type) {
      var t = (type === 'dtz') ? 'dtz' : 'wdl';
      return LICHES_TT_URL + '?type=' + t + '&fen=' + encodeURIComponent(fen);
      }

    /**
    * Parse a lichess tablebase response. Returns a normalized result or null.
    * @param {*} json
    * @returns {{move:string, wdl:Array, dtz:(number|null), bestEval:number|null}|null}
    */
   function parseResponse(json) {
      if (!json || typeof json !== 'object') return null;
      var best = json.best;
      if (!best) return null;
      var move = (typeof best.mv === 'string' && best.mv) ? best.mv : null;
      var wdl = null;
      var dtz = null;
      var bestEval = null;
      if (best.score) {
        if (best.score.wdl) {
          wdl = [best.score.wdl.w || 0, best.score.wdl.d || 0, best.score.wdl.l || 0];
         }
        if (typeof best.score.dtz === 'number') {
          dtz = best.score.dtz;
          }
        }
      if (typeof best.eval === 'number') {
        bestEval = best.eval;
        }
      if (!move && wdl === null && dtz === null && bestEval === null) return null;
      return { move: move, wdl: wdl, dtz: dtz, bestEval: bestEval };
      }

    /**
    * Resolve the transport. Prefers an injected fetch, then the global one.
    */
   function resolveFetch(opts) {
      if (opts && typeof opts.fetchImpl === 'function') return opts.fetchImpl;
      if (typeof fetch === 'function') return fetch;
      if (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function') return globalThis.fetch;
      return null;
      }

    /**
    * Whether a position is within tablebase reach (<= 7 pieces) AND has two kings
    * (a legal endgame the tablebase can score).
    */
   function isEndgame(fen, maxPieces) {
      var cap = (typeof maxPieces === 'number') ? maxPieces : MAX_PIECES;
      var n = countPiecesInFen(fen);
      if (n > cap) return false;
       // Count kings directly in the board row (a legal position has exactly 2).
      var board = fen.trim().split(/\s+/)[0] || '';
      var kingsFound = 0;
      for (var i = 0; i < board.length; i++) {
        var c = board[i];
        if (c === 'K' || c === 'k') kingsFound++;
         }
      return kingsFound === 2;
      }

    /**
    * Probe the tablebase for a FEN. Always resolves; on any error or unreachable
    * position it resolves to a fallback descriptor so the caller falls back to its
    * own engine eval.
    *
    * @param {string} fen
    * @param {Object} opts { type?, fetchImpl?, maxPieces?, signal? }
    * @returns {Promise<Object>}
    */
   function probe(fen, opts) {
      opts = opts || {};
      var type = (opts.type === 'dtz') ? 'dtz' : 'wdl';
      var cap = (typeof opts.maxPieces === 'number') ? opts.maxPieces : MAX_PIECES;

       // No transport available -> immediate offline fallback.
      var doFetch = resolveFetch(opts);
      if (!doFetch) {
        return Promise.resolve({ ok: false, source: 'fallback', reason: 'no-transport', fen: fen, type: type });
        }

       // Piece count guard: the tablebase only covers <= cap pieces.
      var pieces = countPiecesInFen(fen);
      if (pieces > cap) {
        return Promise.resolve({ ok: false, source: 'fallback', reason: 'too-many-pieces', fen: fen, pieces: pieces, cap: cap });
        }
      if (!isEndgame(fen, cap)) {
        return Promise.resolve({ ok: false, source: 'fallback', reason: 'not-endgame', fen: fen, pieces: pieces });
        }

      var url = buildUrl(fen, type);
      var reqOpts = {};
      if (opts.signal) reqOpts.signal = opts.signal;

      return Promise.resolve(doFetch(url, reqOpts))
        .then(function (res) {
          if (!res) throw new Error('null response');
          return res.ok ? res.json() : Promise.reject(new Error('http ' + res.status));
          })
        .then(function (json) {
          var parsed = parseResponse(json);
          if (!parsed) {
            return { ok: false, source: 'fallback', reason: 'unparseable', fen: fen, type: type };
            }
          return {
            ok: true,
            source: 'tablebase',
            fen: fen,
            type: type,
            pieces: pieces,
            url: url,
            best: parsed
             };
          })
        .catch(function (err) {
          return { ok: false, source: 'fallback', fen: fen, type: type, reason: String((err && err.message) || err) };
          });
      }

   var api = {
      LICHES_TT_URL: LICHES_TT_URL,
      MAX_PIECES: MAX_PIECES,
      countPiecesInFen: countPiecesInFen,
      buildUrl: buildUrl,
      parseResponse: parseResponse,
      isEndgame: isEndgame,
      probe: probe,
      resolveFetch: resolveFetch
      };

   if (typeof module !== 'undefined' && module.exports) {
     module.exports = api;
      }
   if (typeof window !== 'undefined') {
     window.Tablebase = api;
      }
  })();
