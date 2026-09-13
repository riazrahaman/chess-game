#!/usr/bin/env node
/**
 * draw-selftest.js — Gate 2 hermetic draw-rules tests.
 *
 * Tests draw detection via rules-engine.js (chess.js adapter) and the
 * referee-helper.cjs CLI:
 *   D1: threefold repetition via knight shuffle (history path)
 *   D2: insufficient material K vs K (fenToBoard path)
 *   D3: agreement draw still works and sets drawReason='agreement'
 *   D4: false draw-claim rejected with {ok:false}
 *   D5: valid draw-claim on threefold position succeeds with correct reason
 *   D6: drawReason persisted in state file
 *   D7: gameEndPresentation maps drawReason to specific banners
 *   D8: evaluateDraw priority ordering (fivefold > 75-move > insufficient >
 *       threefold > 50-move)
 *   D9: 50-move rule detection via FEN halfmove clock
 *   D10: 75-move rule auto-draw detection
 *   D11: post-draw moves rejected
 */
(function () {
  'use strict';

  const { execSync } = require('child_process');
  const fs = require('fs');
  const path = require('path');

  const engine = require('./engine.js');
  const rulesEngine = require('./rules-engine.js');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log('PASS: ' + message);
      passed++;
    } else {
      console.error('FAIL: ' + message);
      failed++;
    }
  }

  // --- Hermetic state-file setup (same pattern as engine-selftest.js) ---
  const stateFile = path.join(__dirname, '.referee-state.json');
  const originalStateFile = fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null;
  process.env.CHESS_STATE_FILE = stateFile;
  process.once('exit', function () {
    if (originalStateFile === null) {
      try { fs.unlinkSync(stateFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    } else {
      fs.writeFileSync(stateFile, originalStateFile);
    }
  });

  function refereeCli() {
    var args = Array.prototype.slice.call(arguments);
    var out = execSync('node referee-helper.cjs ' + args.join(' '), { cwd: __dirname }).toString();
    return JSON.parse(out);
  }

  function refereeCliExpectFail() {
    var args = Array.prototype.slice.call(arguments);
    try {
      var out = execSync('node referee-helper.cjs ' + args.join(' '), { cwd: __dirname }).toString();
      return JSON.parse(out);
    } catch (e) {
      return JSON.parse(e.stdout.toString());
    }
  }

  function readState() {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  }

  console.log('--- Running Draw Rules Self-Tests ---\n');

  var START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  // D1: threefold repetition via knight shuffle (history path)
  // A fresh Chess from FEN does NOT carry position counts, so we must pass
  // both board and history to evaluateDraw for repetition detection.
  (function () {
    var knightCycle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
    var history = [];
    for (var i = 0; i < 3; i++) history.push.apply(history, knightCycle);
    var result = rulesEngine.evaluateDraw(START_FEN, history);
    assert(result.draw === true && result.reason === 'threefold',
      'D1: evaluateDraw(board, history) detects threefold repetition after 3 knight-shuffle cycles');

    var claim = rulesEngine.claimableDraw(START_FEN, history);
    assert(claim.claimable === true && claim.reason === 'threefold',
      'D1: claimableDraw(board, history) returns claimable threefold');
  })();

  // D1b: one cycle is NOT threefold (position appears twice: start + after 1 cycle)
  (function () {
    var knightCycle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
    var history = [];
    for (var i = 0; i < 1; i++) history.push.apply(history, knightCycle);
    var result = rulesEngine.evaluateDraw(START_FEN, history);
    assert(result.draw === false,
      'D1b: evaluateDraw(board, history) does NOT trigger threefold after only 1 cycle');
  })();

  // D2: insufficient material K vs K (fenToBoard path)
  (function () {
    var kvkFen = '8/8/8/3k4/8/8/3K4/8 w - - 0 1';
    var kvkBoard = rulesEngine.fenToBoard(kvkFen);
    var result = rulesEngine.evaluateDraw(kvkBoard);
    assert(result.draw === true && result.reason === 'insufficient',
      'D2: evaluateDraw(K vs K board) detects insufficient material');

    assert(rulesEngine.isInsufficientMaterial(kvkBoard) === true,
      'D2: isInsufficientMaterial returns true for K vs K');
  })();

  // D2b: K vs K is NOT claimable (it's automatic)
  (function () {
    var kvkFen = '8/8/8/3k4/8/8/3K4/8 w - - 0 1';
    var kvkBoard = rulesEngine.fenToBoard(kvkFen);
    var claim = rulesEngine.claimableDraw(kvkBoard);
    assert(claim.claimable === false,
      'D2b: claimableDraw(K vs K) is NOT claimable (insufficient is automatic)');
  })();

  // D3: agreement draw via referee CLI sets drawReason='agreement'
  (function () {
    refereeCli('reset');
    var drawn = refereeCli('draw');
    assert(drawn.ok === true && drawn.gameOver === true && drawn.status === 'draw' &&
      drawn.drawReason === 'agreement' && drawn.result === '½-½',
      'D3: referee draw command sets drawReason=agreement with ½-½ result');

    var st = readState();
    assert(st.drawReason === 'agreement' && st.draw === true,
      'D3: state file persists drawReason=agreement');
  })();

  // D4: false draw-claim rejected with {ok:false}
  (function () {
    refereeCli('reset');
    var claim = refereeCliExpectFail('draw-claim');
    assert(claim.ok === false && typeof claim.error === 'string',
      'D4: false draw-claim rejected with {ok:false,error}');
  })();

  // D5: valid draw-claim on threefold position succeeds
  // We need a position where threefold exists but the game hasn't auto-ended.
  // Since the referee auto-applies threefold, we test claimableDraw directly
  // and also test the 50-move claim path via a constructed state.
  (function () {
    // Test via rules-engine: threefold is claimable
    var knightCycle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
    var history = [];
    for (var i = 0; i < 3; i++) history.push.apply(history, knightCycle);
    var claim = rulesEngine.claimableDraw(START_FEN, history);
    assert(claim.claimable === true && claim.reason === 'threefold',
      'D5: claimableDraw confirms threefold is claimable');

    // Test 50-move claim via constructed state with halfmove clock
    var fiftyFen = '8/8/8/3k4/8/8/3K4/3R4 w - - 100 1';
    var fiftyBoard = rulesEngine.fenToBoard(fiftyFen);
    var fiftyClaim = rulesEngine.claimableDraw(fiftyBoard);
    assert(fiftyClaim.claimable === true && fiftyClaim.reason === 'fifty-move',
      'D5: claimableDraw confirms 50-move rule is claimable via FEN halfmove clock');
  })();

  // D6: drawReason persisted in state file after auto threefold
  (function () {
    refereeCli('reset');
    var knightCycle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
    // After 3 cycles the starting position appears 4 times (initial + 3 returns)
    // which triggers threefold. The last move of the 3rd cycle will auto-draw.
    for (var i = 0; i < 3; i++) {
      for (var j = 0; j < knightCycle.length; j++) {
        refereeCliExpectFail('move', knightCycle[j]);
      }
    }
    var st = readState();
    assert(st.gameOver === true && st.status === 'draw' && st.drawReason === 'threefold',
      'D6: state file persists drawReason=threefold after auto threefold draw');
  })();

  // D7: gameEndPresentation maps drawReason to specific banners
  (function () {
    var presentation;

    presentation = engine.gameEndPresentation({ gameOver: true, status: 'draw', drawReason: 'agreement' });
    assert(presentation && presentation.banner === 'Draw by agreement',
      'D7: gameEndPresentation maps agreement to "Draw by agreement"');

    presentation = engine.gameEndPresentation({ gameOver: true, status: 'draw', drawReason: 'threefold' });
    assert(presentation && presentation.banner === 'Draw by threefold repetition',
      'D7: gameEndPresentation maps threefold to "Draw by threefold repetition"');

    presentation = engine.gameEndPresentation({ gameOver: true, status: 'draw', drawReason: 'fivefold' });
    assert(presentation && presentation.banner === 'Draw by fivefold repetition',
      'D7: gameEndPresentation maps fivefold to "Draw by fivefold repetition"');

    presentation = engine.gameEndPresentation({ gameOver: true, status: 'draw', drawReason: 'fifty-move' });
    assert(presentation && presentation.banner === 'Draw by 50-move rule',
      'D7: gameEndPresentation maps fifty-move to "Draw by 50-move rule"');

    presentation = engine.gameEndPresentation({ gameOver: true, status: 'draw', drawReason: 'seventyfive-move' });
    assert(presentation && presentation.banner === 'Draw by 75-move rule',
      'D7: gameEndPresentation maps seventyfive-move to "Draw by 75-move rule"');

    presentation = engine.gameEndPresentation({ gameOver: true, status: 'draw', drawReason: 'insufficient' });
    assert(presentation && presentation.banner === 'Draw by insufficient material',
      'D7: gameEndPresentation maps insufficient to "Draw by insufficient material"');

    // Backward compat: no drawReason defaults to agreement
    presentation = engine.gameEndPresentation({ gameOver: true, status: 'draw' });
    assert(presentation && presentation.banner === 'Draw by agreement',
      'D7: gameEndPresentation defaults to "Draw by agreement" when drawReason missing');
  })();

  // D8: evaluateDraw priority ordering
  (function () {
    // Fivefold should be detected before threefold
    var knightCycle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
    var history5 = [];
    for (var i = 0; i < 5; i++) history5.push.apply(history5, knightCycle);
    var result5 = rulesEngine.evaluateDraw(START_FEN, history5);
    assert(result5.draw === true && result5.reason === 'fivefold',
      'D8: evaluateDraw returns fivefold (not threefold) after 5 cycles');
  })();

  // D9: 50-move rule detection via FEN halfmove clock
  (function () {
    var fiftyFen = '8/8/8/3k4/8/8/3K4/3R4 w - - 100 1';
    var result = rulesEngine.evaluateDraw(fiftyFen);
    assert(result.draw === true && result.reason === 'fifty-move',
      'D9: evaluateDraw detects 50-move rule via FEN halfmove clock >= 100');

    // 99 halfmoves should NOT trigger
    var almostFen = '8/8/8/3k4/8/8/3K4/3R4 w - - 99 1';
    var almostResult = rulesEngine.evaluateDraw(almostFen);
    assert(almostResult.draw === false,
      'D9: evaluateDraw does NOT trigger 50-move at 99 halfmoves');
  })();

  // D10: 75-move rule auto-draw detection
  (function () {
    var fen75 = '8/8/8/3k4/8/8/3K4/3R4 w - - 150 1';
    var result = rulesEngine.evaluateDraw(fen75);
    assert(result.draw === true && result.reason === 'seventyfive-move',
      'D10: evaluateDraw detects 75-move rule at halfmove clock >= 150');

    assert(rulesEngine.isDrawBySeventyfiveMoves(fen75) === true,
      'D10: isDrawBySeventyfiveMoves returns true at 150 halfmoves');

    var fen149 = '8/8/8/3k4/8/8/3K4/3R4 w - - 149 1';
    assert(rulesEngine.isDrawBySeventyfiveMoves(fen149) === false,
      'D10: isDrawBySeventyfiveMoves returns false at 149 halfmoves');
  })();

  // D11: post-draw moves rejected
  (function () {
    refereeCli('reset');
    refereeCli('draw');
    var moveAfterDraw = refereeCliExpectFail('move', 'e2e4');
    assert(moveAfterDraw.ok === false && moveAfterDraw.error === 'game over',
      'D11: post-draw moves are rejected with "game over"');
  })();

  // D12: fivefold repetition detection
  (function () {
    var knightCycle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
    var history = [];
    for (var i = 0; i < 5; i++) history.push.apply(history, knightCycle);
    assert(rulesEngine.isFivefoldRepetition(START_FEN, history) === true,
      'D12: isFivefoldRepetition returns true after 5 cycles');

    var history3 = [];
    for (var j = 0; j < 3; j++) history3.push.apply(history3, knightCycle);
    assert(rulesEngine.isFivefoldRepetition(START_FEN, history3) === false,
      'D12: isFivefoldRepetition returns false after 3 cycles (threefold but not fivefold)');
  })();

  // D13: createFromHistory produces correct FEN
  (function () {
    var instance = rulesEngine.createFromHistory(['e2e4', 'e7e5']);
    var fen = instance.fen();
    assert(fen.indexOf('4P3') !== -1 && fen.indexOf('4p3') !== -1,
      'D13: createFromHistory replays moves to correct position');

    var emptyInstance = rulesEngine.createFromHistory([]);
    assert(emptyInstance.fen().indexOf('rnbqkbnr') !== -1,
      'D13: createFromHistory([]) produces starting position');
  })();

  refereeCli('reset');

  console.log('\n--- Draw Self-Test Summary ---');
  console.log('Passed: ' + passed);
  console.log('Failed: ' + failed);

  if (failed > 0) {
    console.error('\nDraw self-test FAILED with ' + failed + ' failure(s).');
    process.exit(1);
  } else {
    console.log('\nAll draw self-tests PASSED successfully!');
    process.exit(0);
  }
})();