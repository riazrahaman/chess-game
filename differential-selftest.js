#!/usr/bin/env node
/**
 * differential-selftest.js
 *
 * Gate 2 differential test: runs N>=200 randomized legal games through BOTH
 * the in-house engine.js AND chess.js (via rules-engine.js adapter), asserting
 * at every ply:
 *   - identical legal-move sets (normalized, sorted, promotion-expanded)
 *   - identical check / checkmate / stalemate verdicts
 *   - identical SAN for every legal move
 *
 * On any divergence, prints the ply number + FEN + both engines' outputs and
 * exits with code 1.
 *
 * The in-house engine drives move selection (random pick from its legal list).
 * After each applied move, both engines are advanced and compared again.
 *
 * Usage:
 *   node differential-selftest.js [numGames] [seed]
 */

(function () {
  'use strict';

  const engine = require('./engine.js');
  const rulesEngine = require('./rules-engine.js');

  const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const RANKS = ['1', '2', '3', '4', '5', '6', '7', '8'];
  const SQUARES = [];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      SQUARES.push(FILES[f] + RANKS[r]);
    }
  }

  const NUM_GAMES = parseInt(process.argv[2] || '200', 10);
  const SEED = parseInt(process.argv[3] || '0', 10);

  // Simple seeded PRNG (mulberry32) for reproducibility.
  function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  let rng = makeRng(SEED || 12345);

  function allLegalMovesInHouse(board, turn) {
    const moves = [];
    for (const sq of SQUARES) {
      const p = board.pieces[sq];
      if (!p || p.color !== turn) continue;
      const dests = engine.getLegalMoves(board, sq, turn);
      for (const to of dests) {
        if (p.type === 'p' && (to[1] === '8' || to[1] === '1')) {
          for (const promo of ['q', 'r', 'b', 'n']) {
            moves.push(sq + to + promo);
          }
        } else {
          moves.push(sq + to);
        }
      }
    }
    return moves.sort();
  }

  function normalizeMoveList(moves) {
    return moves.slice().sort();
  }

  function fail(game, ply, label, fen, inHouseVal, chessJsVal) {
    console.error('');
    console.error('=== DIFFERENTIAL TEST FAILURE ===');
    console.error('Game #' + game + ', ply ' + ply + ', check: ' + label);
    console.error('FEN: ' + fen);
    console.error('In-house engine: ' + JSON.stringify(inHouseVal));
    console.error('chess.js:        ' + JSON.stringify(chessJsVal));
    console.error('=== END FAILURE ===');
    process.exit(1);
  }

  let totalPlies = 0;
  let totalGames = 0;
  let totalDivergences = 0;

  function playOneGame(gameNum) {
    let board = engine.createInitialBoard();
    let ply = 0;
    const maxPlies = 200;

    while (ply < maxPlies) {
      const turn = board.turn;
      const fen = rulesEngine.boardToFen(board);

      // 1. Compare legal move sets
      const ihMoves = normalizeMoveList(allLegalMovesInHouse(board, turn));
      const cjMoves = normalizeMoveList(rulesEngine.legalMoves(board));
      if (ihMoves.length !== cjMoves.length || ihMoves.join(',') !== cjMoves.join(',')) {
        totalDivergences++;
        fail(gameNum, ply, 'legal-move-set', fen, ihMoves, cjMoves);
      }

      // 2. Compare check / checkmate / stalemate verdicts
      const ihCheck = engine.isCheck(board, turn);
      const cjCheck = rulesEngine.isCheck(board);
      if (ihCheck !== cjCheck) {
        totalDivergences++;
        fail(gameNum, ply, 'isCheck', fen, ihCheck, cjCheck);
      }

      const ihMate = engine.isCheckmate(board, turn);
      const cjMate = rulesEngine.isCheckmate(board);
      if (ihMate !== cjMate) {
        totalDivergences++;
        fail(gameNum, ply, 'isCheckmate', fen, ihMate, cjMate);
      }

      const ihStale = engine.isStalemate(board, turn);
      const cjStale = rulesEngine.isStalemate(board);
      if (ihStale !== cjStale) {
        totalDivergences++;
        fail(gameNum, ply, 'isStalemate', fen, ihStale, cjStale);
      }

      // 3. Compare SAN for every legal move
      for (const moveStr of ihMoves) {
        const from = moveStr.slice(0, 2);
        const to = moveStr.slice(2, 4);
        const promo = moveStr[4] || undefined;

        let ihSan, cjSan;
        try {
          ihSan = engine.moveToSan(board, moveStr);
        } catch (e) {
          ihSan = '__ERROR__:' + e.message;
        }
        try {
          cjSan = rulesEngine.san(board, from, to, promo);
        } catch (e) {
          cjSan = '__ERROR__:' + e.message;
        }

        if (ihSan !== cjSan) {
          totalDivergences++;
          fail(gameNum, ply, 'SAN for move ' + moveStr, fen, ihSan, cjSan);
        }
      }

      // 4. If game is over, stop
      if (ihMate || ihStale) break;
      if (ihMoves.length === 0) break;

      // 5. Pick a random legal move and apply it on both engines
      const pickIdx = Math.floor(rng() * ihMoves.length);
      const chosen = ihMoves[pickIdx];
      const from = chosen.slice(0, 2);
      const to = chosen.slice(2, 4);
      const promo = chosen[4] || undefined;

      // Apply on in-house engine
      board = engine.makeMove(board, from, to, promo);
      ply++;
      totalPlies++;
    }

    totalGames++;
  }

  console.log('Differential selftest: ' + NUM_GAMES + ' games, seed=' + (SEED || 12345));

  for (let g = 0; g < NUM_GAMES; g++) {
    playOneGame(g + 1);
    if ((g + 1) % 50 === 0) {
      console.log('  ...completed ' + (g + 1) + ' games, ' + totalPlies + ' plies checked, 0 divergences');
    }
  }

  console.log('');
  console.log('Differential selftest PASSED: ' + totalGames + '/' + NUM_GAMES + ' games, ' +
    totalPlies + ' plies checked, ' + totalDivergences + ' divergences.');
  process.exit(0);
})();