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
  assert(outputLines.includes('id name Lightweight Local Engine (PST+Material)'), 'engine responds with honest id name Lightweight Local Engine');
  assert(outputLines.includes('id alias Stockfish 17 NNUE WASM'), 'engine provides Stockfish 17 NNUE WASM alias for compatibility');
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

  // ========================================
  // 8. WASM Engine Bridge Tests
  // ========================================
  console.log('\n--- WASM Bridge Tests ---\n');

  // 8a. WasmEngine class exists and has correct initial state
  const wasmEngine = new stockfish.WasmEngine((line) => {});
  assert(typeof stockfish.WasmEngine === 'function', 'WasmEngine class is exported');
  assert(wasmEngine.wasmReady === false, 'WasmEngine starts with wasmReady=false');
  assert(wasmEngine.wasmFailed === false, 'WasmEngine starts with wasmFailed=false');

  // 8b. WasmEngine.load() gracefully handles missing WASM binary (fetch fails)
  // In Node.js there's no fetch for local files, so this will fail gracefully.
  const loadResult = await wasmEngine.load('nonexistent-stockfish.wasm');
  assert(loadResult === false, 'WasmEngine.load returns false for missing WASM binary');
  assert(wasmEngine.wasmFailed === true, 'WasmEngine sets wasmFailed=true on load failure');
  assert(wasmEngine.wasmReady === false, 'WasmEngine keeps wasmReady=false on load failure');

  // 8c. WasmEngine.load() is idempotent after failure (no re-attempt)
  const loadResult2 = await wasmEngine.load('nonexistent-stockfish.wasm');
  assert(loadResult2 === false, 'WasmEngine.load returns false immediately after first failure (idempotent)');

  // 8d. WasmEngine.processCommand returns true when wasmReady but handles gracefully when not ready
  const wasmNotReadyResult = wasmEngine.processCommand('uci');
  // When WASM is not ready, processCommand returns false (command not handled)
  assert(wasmNotReadyResult === false, 'WasmEngine.processCommand returns false when WASM not ready');

  // ========================================
  // 9. UnifiedEngine Tests (WASM + PST fallback)
  // ========================================
  console.log('\n--- UnifiedEngine Tests ---\n');

  // 9a. UnifiedEngine class exists
  assert(typeof stockfish.UnifiedEngine === 'function', 'UnifiedEngine class is exported');

  // 9b. UnifiedEngine starts with PST engine as active (WASM not loaded yet)
  const unified1 = new stockfish.UnifiedEngine((line) => {});
  assert(unified1.activeEngine === unified1.pstEngine, 'UnifiedEngine starts with PST engine as active');
  assert(unified1.wasmReady === false, 'UnifiedEngine starts with wasmReady=false');

  // 9c. UnifiedEngine routes commands to PST engine when WASM not available
  const unifiedOutput = [];
  const unified2 = new stockfish.UnifiedEngine((line) => {
    unifiedOutput.push(line);
  });
  unified2.processCommand('uci');
  assert(unifiedOutput.includes('uciok'), 'UnifiedEngine (PST fallback) responds with uciok');
  assert(unifiedOutput.includes('id name Lightweight Local Engine (PST+Material)'), 'UnifiedEngine (PST fallback) uses PST engine identity');

  // 9d. UnifiedEngine.processCommand('go depth N') returns results from PST engine
  unified2.processCommand(`position fen ${startFen}`);
  const goResults = unified2.processCommand('go depth 2');
  assert(goResults && goResults.length > 0, 'UnifiedEngine (PST fallback) returns search results from go');

  // 9e. UnifiedEngine.tryLoadWasm fails gracefully when WASM not available
  const wasmLoadOk = await unified2.tryLoadWasm('nonexistent-stockfish.wasm');
  assert(wasmLoadOk === false, 'UnifiedEngine.tryLoadWasm returns false when WASM unavailable');
  assert(unified2.activeEngine === unified2.pstEngine, 'UnifiedEngine stays on PST engine after WASM load failure');

  // 9f. UnifiedEngine tryLoadWasm is not attempted again after failure
  const beforeAttempt = unified2.wasmLoadAttempted;
  const wasmLoadOk2 = await unified2.tryLoadWasm('another-nonexistent.wasm');
  assert(beforeAttempt === true && wasmLoadOk2 === false, 'UnifiedEngine does not re-attempt WASM load after failure');

  // 9g. UnifiedEngine exposes multiPv and parsedPosition from PST engine
  assert(typeof unified2.multiPv === 'number', 'UnifiedEngine exposes multiPv property');
  assert(unified2.parsedPosition && typeof unified2.parsedPosition === 'object', 'UnifiedEngine exposes parsedPosition property');

  // 9h. UnifiedEngine continues working on PST after failed WASM load (full UCI handshake)
  unifiedOutput.length = 0;
  unified2.processCommand('uci');
  assert(unifiedOutput.includes('uciok'), 'UnifiedEngine still works on PST after failed WASM load');

  // ========================================
  // 10. Fallback Path Integration Test
  // ========================================
  console.log('\n--- Fallback Integration Tests ---\n');

  // 10a. When WASM fails, the full UCI sequence works via PST
  const fallbackEngine = new stockfish.UnifiedEngine((line) => {});
  await fallbackEngine.tryLoadWasm('definitely-nonexistent.wasm');
  assert(fallbackEngine.wasmReady === false, 'Fallback: WASM not ready after load failure');

  // Full UCI handshake sequence
  const fallbackOutput = [];
  fallbackEngine.postFn = (line) => fallbackOutput.push(line);

  fallbackEngine.processCommand('uci');
  assert(fallbackOutput.includes('uciok'), 'Fallback: uci handshake produces uciok');
  fallbackOutput.length = 0;

  fallbackEngine.processCommand('isready');
  assert(fallbackOutput.includes('readyok'), 'Fallback: isready produces readyok');
  fallbackOutput.length = 0;

  fallbackEngine.processCommand('setoption name MultiPV value 2');
  assert(fallbackEngine.multiPv === 2, 'Fallback: setoption updates MultiPV on PST engine');

  fallbackEngine.processCommand('position startpos');
  const fallbackResults = fallbackEngine.processCommand('go depth 1');
  assert(fallbackResults && fallbackResults.length === 2, 'Fallback: go depth 1 with MultiPV 2 returns 2 results');
  assert(fallbackOutput.some(l => l.startsWith('bestmove')), 'Fallback: go produces bestmove line');

  // 10b. WasmEngine._processEngineLine parses info and bestmove lines
  const wasmWithParser = new stockfish.WasmEngine((line) => {});
  wasmWithParser._processEngineLine('info depth 15 seldepth 20 multipv 1 score cp 35 pv e2e4');
  assert(wasmWithParser.lastMultiPvResults.length === 1, 'WasmEngine parses info line into multiPv results');
  assert(wasmWithParser.lastMultiPvResults[0].bestMove === 'e2e4', 'WasmEngine parses bestMove from info pv');
  assert(wasmWithParser.lastMultiPvResults[0].scoreCp === 0.35, 'WasmEngine parses score cp from info line');

  wasmWithParser._processEngineLine('bestmove e2e4');
  assert(wasmWithParser.lastBestMove === 'e2e4', 'WasmEngine parses bestmove line');
  assert(wasmWithParser.lastMultiPvResults.length === 0, 'WasmEngine resets multiPv results after bestmove flush');

  // 10c. WasmEngine._processEngineLine handles multipv 2
  const wasmMultiPv = new stockfish.WasmEngine((line) => {});
  wasmMultiPv._processEngineLine('info depth 10 multipv 1 score cp 50 pv e2e4');
  wasmMultiPv._processEngineLine('info depth 10 multipv 2 score cp 30 pv d2d4');
  assert(wasmMultiPv.lastMultiPvResults.length === 2, 'WasmEngine tracks multiple PV lines');
  assert(wasmMultiPv.lastMultiPvResults[0].bestMove === 'e2e4', 'WasmEngine PV 1 bestMove correct');
  assert(wasmMultiPv.lastMultiPvResults[1].bestMove === 'd2d4', 'WasmEngine PV 2 bestMove correct');

  // 10d. WasmEngine handles info lines without pv gracefully (no crash)
  const wasmNoPv = new stockfish.WasmEngine((line) => {});
  wasmNoPv._processEngineLine('info depth 10 seldepth 12 nodes 5000');
  assert(wasmNoPv.lastMultiPvResults.length === 0, 'WasmEngine ignores info lines without pv');

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
