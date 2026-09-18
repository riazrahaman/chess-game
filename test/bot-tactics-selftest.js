#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const stockfishWorker = require('../src/stockfish-worker.js');
const { BotService, BOT_LEVELS } = require('../src/bot-service.js');
const engineServer = require('../src/engine-server.js');

const botService = new BotService();

let passed = 0;
let failed = 0;
const tests = [];

// Tests are queued and run sequentially (several await the async bot engine).
function test(name, fn) {
  tests.push({ name, fn });
}

console.log('=== Running Bot Engine Strength & Tactical Self-Tests ===\n');

// 1. Gate 4 Invariant
test('Gate 4 Invariant: ui.js contains 0 makeMove( and 0 createInitialBoard(', () => {
  const uiContent = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui.js'), 'utf8');
  assert(!uiContent.includes('makeMove('), 'Gate 4 violation: ui.js contains literal makeMove(');
  assert(!uiContent.includes('createInitialBoard('), 'Gate 4 violation: ui.js contains literal createInitialBoard(');
});

// 2. FEN string evaluation in evaluateMultiPV and findBestMove (PST fallback engine)
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

// 6. Bot Service Opening Book Integration (book is consulted by L1-L4 only)
test('Bot opening book: Level 4 White plays a principled opening move on ply 0', async () => {
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const botMove = await botService.computeBotMove(startFen, 4, []);
  const validBookMoves = ['e2e4', 'd2d4', 'c2c4', 'g1f3'];
  assert(validBookMoves.includes(botMove), `Expected standard opening move, got: ${botMove}`);
});

test('Bot opening book: Level 4 Black responds with Sicilian, Open Game, French, or Caro-Kann to 1. e4', async () => {
  const afterE4Fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  const botMove = await botService.computeBotMove(afterE4Fen, 4, ['e2e4']);
  const validResponses = ['c7c5', 'e7e5', 'e7e6', 'c7c6'];
  assert(validResponses.includes(botMove), `Expected book response to 1. e4, got: ${botMove}`);
});

test('Level 8 ignores the illustrative book and plays a legal engine move from the start position', async () => {
  assert.strictEqual(BOT_LEVELS[8].useBook, false, 'Level 8 must not consult openings-db');
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const botMove = await botService.computeBotMove(startFen, 8, []);
  assert(/^[a-h][1-8][a-h][1-8]$/.test(botMove), `Level 8 produces a legal UCI move: ${botMove}`);
});

// 6b. Real engine (E1b): Stockfish 19 lite via engine-server.js
test('engine-server: vendored Stockfish 19 lite is available and analyses in a worker thread', async () => {
  assert(engineServer.isAvailable(), 'engine-server reports the vendored engine as available');
  const r = await engineServer.analyse('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', { depth: 6, multiPv: 3 });
  assert.strictEqual(r.engine, 'stockfish19-lite');
  assert(/^[a-h][1-8][a-h][1-8]$/.test(r.bestMove), `bestMove is UCI: ${r.bestMove}`);
  assert.strictEqual(r.lines.length, 3, 'MultiPV 3 returns three lines');
  assert.strictEqual(r.lines[0].move, r.bestMove, 'first line is the best move');
  assert(typeof r.lines[0].scoreCp === 'number', 'line carries a centipawn score');
  assert(r.lines[0].depth >= 6, 'line reached the requested depth');
});

test('engine-server: UCI_Elo / Skill Level options do not leak between searches', async () => {
  const fen = 'rnb1kbnr/ppp2ppp/4p3/3p4/3Q4/8/PPPP1PPP/RNB1KBNR w KQkq - 0 4';
  await engineServer.analyse(fen, { depth: 1, skill: 0 });
  await engineServer.analyse(fen, { movetime: 100, elo: 1400 });
  const full = await engineServer.analyse(fen, { depth: 12 });
  assert.strictEqual(full.bestMove, 'd4e3', `full-strength search after limited ones still finds d4e3, got ${full.bestMove}`);
  assert(full.lines[0].scoreCp > 500, `white is winning a piece: ${full.lines[0].scoreCp}`);
});

test('engine-server: mated position yields no best move; bad FEN rejects', async () => {
  const r = await engineServer.analyse('rnb1kbnr/pppp1ppp/8/4p3/5PPq/8/PPPPP2P/RNBQKBNR w KQkq - 0 1', { depth: 2 });
  assert.strictEqual(r.bestMove, null, 'checkmated side has no best move');
  await assert.rejects(engineServer.analyse('', { depth: 1 }), /fen/);
});

// 6c. Tactical: the probe position where the PST engine hung its queen (d4d5?? e6xd5)
test('Level 8 does NOT play the queen blunder d4d5 in the probe position (5 runs)', async () => {
  const probeFen = 'rnb1kbnr/ppp2ppp/4p3/3p4/3Q4/8/PPPP1PPP/RNB1KBNR w KQkq - 0 4';
  const history = ['e2e4', 'e7e6', 'd2d4', 'd7d5', 'e4d5', 'e6d5', 'd1d4'];
  for (let i = 0; i < 5; i++) {
    const move = await botService.computeBotMove(probeFen, 8, history);
    assert.notStrictEqual(move, 'd4d5', `run ${i + 1}: Level 8 hung its queen with d4d5`);
    assert(/^d4[a-h][1-8]$/.test(move), `run ${i + 1}: Level 8 moves the attacked queen, got ${move}`);
  }
});

test('Level 8 finds checkmate in 1 (h5f7#) through the bot service', async () => {
  const mateInOneFen = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 0 1';
  const history = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'x', 'y', 'z', 'w'];
  for (let i = 0; i < 2; i++) {
    const move = await botService.computeBotMove(mateInOneFen, 8, history);
    assert.strictEqual(move, 'h5f7', `run ${i + 1}: expected h5f7#, got ${move}`);
  }
});

// 7. Bot Levels Calibration (E2 on the real engine)
test('Bot difficulty levels 1-8: real-engine ladder, monotonic, no duplicates, no forced blunders from L3', async () => {
  const levels = [1, 2, 3, 4, 5, 6, 7, 8];
  for (const lvl of levels) {
    const move = await botService.computeBotMove('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', lvl);
    assert(move && move.length === 4, `Level ${lvl} produces legal move`);
  }
  // Level 3 and above never roll a random blunder; L1-L2 may (beginner realism).
  for (let lvl = 3; lvl <= 8; lvl++) {
    assert.strictEqual(BOT_LEVELS[lvl].blunderRate, 0, `Level ${lvl} must have zero forced blunders`);
  }
  // L1-L3: Stockfish Skill Level at a shallow fixed depth. L4-L8: UCI_LimitStrength + UCI_Elo
  // (Stockfish accepts 1320-3190) with a movetime cap so the server stays responsive.
  for (let lvl = 1; lvl <= 3; lvl++) {
    assert(BOT_LEVELS[lvl].skill !== null && BOT_LEVELS[lvl].elo === null, `Level ${lvl} is a Skill Level rung`);
    assert(BOT_LEVELS[lvl].depth >= 1, `Level ${lvl} has a depth cap`);
  }
  for (let lvl = 4; lvl <= 8; lvl++) {
    assert(BOT_LEVELS[lvl].elo !== null && BOT_LEVELS[lvl].skill === null, `Level ${lvl} is a UCI_Elo rung`);
    assert(BOT_LEVELS[lvl].elo >= engineServer.UCI_ELO_MIN && BOT_LEVELS[lvl].elo <= engineServer.UCI_ELO_MAX, `Level ${lvl} UCI_Elo in range`);
    assert.strictEqual(BOT_LEVELS[lvl].rating, BOT_LEVELS[lvl].elo, `Level ${lvl} advertises the UCI_Elo it targets`);
    assert(BOT_LEVELS[lvl].movetime > 0 && BOT_LEVELS[lvl].movetime <= 800, `Level ${lvl} movetime cap <= 800ms`);
  }
  // E2: no two levels may share an identical strength configuration
  const sig = lvl => `${BOT_LEVELS[lvl].skill}|${BOT_LEVELS[lvl].elo}|${BOT_LEVELS[lvl].depth}|${BOT_LEVELS[lvl].movetime}|${BOT_LEVELS[lvl].blunderRate}`;
  const seen = new Set();
  for (const lvl of levels) {
    assert(!seen.has(sig(lvl)), `Level ${lvl} duplicates another level's configuration`);
    seen.add(sig(lvl));
  }
  // E2: ratings must be monotonic and honest for a lite Stockfish at <= 600ms/move
  for (let lvl = 2; lvl <= 8; lvl++) {
    assert(BOT_LEVELS[lvl].rating > BOT_LEVELS[lvl - 1].rating, `Level ${lvl} rating increases`);
  }
  assert(BOT_LEVELS[8].rating <= 2300, 'Top level rating must not overstate the lite engine at short movetime');
});

(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`PASS: ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`FAIL: ${t.name}`, err);
      failed++;
    }
  }
  console.log(`\n--- Summary: ${passed} passed, ${failed} failed ---`);
  try { await engineServer.shutdown(); } catch (_) {}
  process.exit(failed > 0 ? 1 : 0);
})();
