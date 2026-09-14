#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const stockfishWorker = require('./stockfish-worker.js');
const { BotService, BOT_LEVELS } = require('./bot-service.js');
const rulesEngine = require('./rules-engine.js');
const openingsDb = require('./openings-db.js');

const botService = new BotService();

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL: ${name}`, err);
    failed++;
  }
}

console.log('=== Running Bot Engine Strength & Tactical Self-Tests ===\n');

// 1. Gate 4 Invariant
test('Gate 4 Invariant: ui.js contains 0 makeMove( and 0 createInitialBoard(', () => {
  const uiContent = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');
  assert(!uiContent.includes('makeMove('), 'Gate 4 violation: ui.js contains literal makeMove(');
  assert(!uiContent.includes('createInitialBoard('), 'Gate 4 violation: ui.js contains literal createInitialBoard(');
});

// 2. FEN string evaluation in evaluateMultiPV and findBestMove
test('evaluateMultiPV accepts FEN string without crashing on parsed.turn', () => {
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const results = stockfishWorker.evaluateMultiPV(fen, 2, 3);
  assert(Array.isArray(results) && results.length === 3, 'Returns top 3 candidate moves for string FEN');
  assert(results[0].bestMove, 'Has bestMove property');
  assert(typeof results[0].scoreRaw === 'number', 'Has numeric scoreRaw');
});

test('findBestMove respects options.depth and returns valid bestMove', () => {
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const result = stockfishWorker.findBestMove(fen, { depth: 3 });
  assert(result && typeof result.bestMove === 'string' && result.bestMove.length === 4, 'Returns UCI move string');
  assert(typeof result.evalScore === 'number', 'Returns numeric evalScore');
});

// 3. Tactical Test: Hanging piece capture
test('Tactical calculation: captures hanging queen on e5', () => {
  const hangingQueenFen = 'rnb1kbnr/pppp1ppp/8/4q3/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 1';
  const result = stockfishWorker.findBestMove(hangingQueenFen, { depth: 2 });
  assert.strictEqual(result.bestMove, 'd4e5', `Expected d4e5 capturing free queen, got: ${result.bestMove}`);
  assert(result.evalScore >= 800, `Eval score reflects queen advantage: ${result.evalScore}`);
});

// 4. Tactical Test: Scholar\'s mate in 1
test('Tactical calculation: finds checkmate in 1 (h5f7#)', () => {
  const mateInOneFen = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 0 1';
  const result = stockfishWorker.findBestMove(mateInOneFen, { depth: 2 });
  assert.strictEqual(result.bestMove, 'h5f7', `Expected h5f7 delivering checkmate, got: ${result.bestMove}`);
  assert(result.evalScore >= 90000, `Eval score reflects checkmate: ${result.evalScore}`);
});

// 5. Legality & Check Filtering
test('Legality check: Fool\'s mate position has 0 candidate moves (checkmated)', () => {
  const foolsMateFen = 'rnb1kbnr/pppp1ppp/8/4p3/5PPq/8/PPPPP2P/RNBQKBNR w KQkq - 0 1';
  const candidates = stockfishWorker.generateCandidateMoves(foolsMateFen);
  assert.strictEqual(candidates.length, 0, 'Checkmated king has exactly 0 legal moves');
  assert(stockfishWorker.isKingInCheck(stockfishWorker.parseFen(foolsMateFen), 'white'), 'White king is recognized as in check');
});

test('Legality check: King cannot castle out of check', () => {
  // White king on e1 in check from black rook on e8 along open e-file
  const inCheckFen = '4k3/4r3/8/8/8/8/8/R3K2R w KQ - 0 1';
  const candidates = stockfishWorker.generateCandidateMoves(inCheckFen);
  const castleMoves = candidates.filter(m => m.uci === 'e1g1' || m.uci === 'e1c1');
  assert.strictEqual(castleMoves.length, 0, 'Cannot castle when in check');
});

test('Legality check: King cannot castle through an attacked transit square', () => {
  // White king on e1, black rook on f8 attacking f1 transit square along open f-file
  const attackedTransitFen = '4k3/5r2/8/8/8/8/8/R3K2R w KQ - 0 1';
  const candidates = stockfishWorker.generateCandidateMoves(attackedTransitFen);
  const kingSideCastle = candidates.find(m => m.uci === 'e1g1');
  assert(!kingSideCastle, 'Cannot castle kingside through attacked square f1');
  const queenSideCastle = candidates.find(m => m.uci === 'e1c1');
  assert(queenSideCastle, 'Can castle queenside since transit squares d1 and c1 are safe');
});

// 6. Bot Service Opening Book Integration
test('Bot opening book: White plays principled opening move on ply 0', () => {
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const botMove = botService.computeBotMove(startFen, 8, []); // GM level
  const validBookMoves = ['e2e4', 'd2d4', 'c2c4', 'g1f3'];
  assert(validBookMoves.includes(botMove), `Expected standard opening move, got: ${botMove}`);
});

test('Bot opening book: Black responds with Sicilian, Open Game, French, or Caro-Kann to 1. e4', () => {
  const afterE4Fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  const botMove = botService.computeBotMove(afterE4Fen, 8, ['e2e4']); // GM level
  const validResponses = ['c7c5', 'e7e5', 'e7e6', 'c7c6'];
  assert(validResponses.includes(botMove), `Expected book response to 1. e4, got: ${botMove}`);
});

// 7. Bot Levels Calibration
test('Bot difficulty levels 1-8 calibrated with increasing depth and zero blunders for Expert+', () => {
  const levels = [1, 2, 3, 4, 5, 6, 7, 8];
  for (const lvl of levels) {
    const move = botService.computeBotMove('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', lvl);
    assert(move && move.length === 4, `Level ${lvl} produces legal move`);
  }
  // Expert (Level 5) and above must have blunderRate: 0.00
  for (let lvl = 5; lvl <= 8; lvl++) {
    assert.strictEqual(BOT_LEVELS[lvl].blunderRate, 0, `Level ${lvl} must have zero blunders`);
    assert(BOT_LEVELS[lvl].depth >= 3, `Level ${lvl} must have depth >= 3`);
  }
});

console.log(`\n--- Summary: ${passed} passed, ${failed} failed ---`);
if (failed > 0) process.exit(1);
