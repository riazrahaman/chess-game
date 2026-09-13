#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const stockfish = require('./stockfish-worker.js');
const server = require('./server.js');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`PASS: ${message}`);
    passed++;
  } else {
    console.error(`FAIL: ${message}`);
    failed++;
  }
}

async function main() {
  console.log('--- Running Phase 2 Stockfish 17 NNUE WASM Self-Tests ---\n');

  // 1. parseFen tests
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const parsed = stockfish.parseFen(startFen);
  assert(parsed && parsed.turn === 'white', 'parseFen parses turn correctly');
  assert(parsed.castling === 'KQkq', 'parseFen captures castling availability');
  assert(Object.keys(parsed.pieces).length === 32, 'parseFen identifies all 32 pieces');

  // 2. evaluatePosition tests
  const startEval = stockfish.evaluatePosition(parsed);
  assert(startEval === 0, 'starting position evaluates to 0');

  // Imbalance test: White up a Queen (+900 base value)
  const whiteUpQueenFen = 'rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const whiteUpQueen = stockfish.parseFen(whiteUpQueenFen);
  const whiteAdvantage = stockfish.evaluatePosition(whiteUpQueen);
  assert(whiteAdvantage >= 800, `white has significant advantage (+${whiteAdvantage}) when black lacks queen`);

  // 3. UCI Engine Controller & Protocol Tests
  const outputLines = [];
  const engine = new stockfish.StockfishEngine((line) => {
    outputLines.push(line);
  });

  // Test UCI initialization handshake
  engine.processCommand('uci');
  assert(outputLines.includes('id name Stockfish 17 NNUE WASM'), 'engine responds with id name Stockfish 17 NNUE WASM');
  assert(outputLines.some(l => l.includes('option name MultiPV')), 'engine declares MultiPV option');
  assert(outputLines.some(l => l.includes('option name Threads')), 'engine declares Threads option');
  assert(outputLines[outputLines.length - 1] === 'uciok', 'engine concludes uci command with uciok');

  // Test isready
  outputLines.length = 0;
  engine.processCommand('isready');
  assert(outputLines.includes('readyok'), 'engine responds to isready with readyok');

  // Test setoption MultiPV
  engine.processCommand('setoption name MultiPV value 3');
  assert(engine.multiPv === 3, 'engine updates multiPv option to 3');

  // Test position command + go depth search
  outputLines.length = 0;
  engine.processCommand(`position fen ${startFen}`);
  const results = engine.processCommand('go depth 2');
  assert(results && results.length === 3, 'MultiPV search returns top 3 candidate moves');
  assert(outputLines.some(l => l.startsWith('info depth') && l.includes('multipv 1')), 'emits UCI info line for multipv 1');
  assert(outputLines.some(l => l.startsWith('info depth') && l.includes('multipv 2')), 'emits UCI info line for multipv 2');
  assert(outputLines.some(l => l.startsWith('info depth') && l.includes('multipv 3')), 'emits UCI info line for multipv 3');
  assert(outputLines.some(l => l.startsWith('bestmove')), 'emits bestmove UCI line');

  // 4. Candidate moves generation
  const candidates = stockfish.generateCandidateMoves(parsed);
  assert(candidates.length === 20, `starting position has exactly 20 legal candidate moves (got ${candidates.length})`);

  // 5. Position startpos moves sequence
  engine.processCommand('position startpos moves e2e4 e7e5 g1f3');
  assert(engine.parsedPosition.turn === 'black', 'after e2e4 e7e5 g1f3, side to move is black');
  assert(engine.parsedPosition.pieces['f3'] && engine.parsedPosition.pieces['f3'].type === 'n', 'knight is positioned on f3');

  // 6. Server MIME and ALLOWED_FILES for WASM
  const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert(serverSource.includes("'.wasm': 'application/wasm'"), 'server.js defines .wasm MIME type application/wasm');
  assert(serverSource.includes("'stockfish.wasm'"), 'server.js includes stockfish.wasm in ALLOWED_FILES');

  // 7. Backward compatibility check with findBestMove
  const best = stockfish.findBestMove(parsed);
  assert(best && typeof best.bestMove === 'string' && best.bestMove.length >= 4, 'findBestMove returns best move in UCI notation');

  console.log('\n--- Phase 2 Stockfish 17 NNUE WASM Self-Test Summary ---');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
  console.log('\nAll Phase 2 Stockfish 17 NNUE WASM self-tests PASSED successfully!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
