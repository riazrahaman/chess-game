'use strict';
// M5 (feat/m5-performance-pass): the referee evaluates the automatic draw and
// the claimable-draw flag from ONE history replay per move instead of two.
//
// Background: automaticDraw() and claimableDraw() each call createFromHistory()
// to rebuild position counts, so the old post-move path replayed a long game
// twice per ply (measured 8.4 ms/ply at 160 plies, ~all of it in the replays).
// rulesEngine.drawStatus() replays once and evaluates both. This suite pins
// (a) exact equivalence with the standalone helpers and (b) the referee's
// observable draw behaviour, so the optimisation cannot drift from FIDE policy.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-m5-'));
process.env.CHESS_STATE_FILE = path.join(tmp, '.referee-state.json');
process.env.CHESS_JOURNAL_FILE = path.join(tmp, '.referee-journal.jsonl');
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

const referee = require('../src/referee-service.js');
const rulesEngine = require('../src/rules-engine.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS: ' + name); }
  catch (e) { failed++; console.log('FAIL: ' + name + ' — ' + e.message); }
}
async function atest(name, fn) {
  try { await fn(); passed++; console.log('PASS: ' + name); }
  catch (e) { failed++; console.log('FAIL: ' + name + ' — ' + e.message); }
}

let seed = 123456789;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

(async () => {
  test('drawStatus is exported and returns both verdicts in one call', () => {
    assert.strictEqual(typeof rulesEngine.drawStatus, 'function', 'drawStatus is exported');
    const r = rulesEngine.drawStatus('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', []);
    assert.deepStrictEqual(r, {
      automatic: { draw: false, reason: null },
      claimable: { claimable: false, reason: null }
    });
  });

  test('drawStatus matches automaticDraw()+claimableDraw() on FEN edge cases', () => {
    const edges = [
      '8/5k2/8/8/8/8/5K2/8 w - - 99 60',
      '8/5k2/8/8/8/8/5K2/8 w - - 100 60',
      '8/5k2/8/8/8/8/5K2/8 w - - 149 90',
      '8/5k2/8/8/8/8/5K2/8 w - - 150 90',
      '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
      '4k3/8/8/8/8/8/8/3BK3 w - - 0 1',
      '4k3/8/8/8/8/8/8/3RK3 w - - 0 1',
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      '8/8/8/8/8/8/8/k6K w - - 100 1',
      '8/8/8/8/8/8/8/k6K w - - 150 1'
    ];
    for (const fen of edges) {
      for (const history of [undefined, []]) {
        assert.deepStrictEqual(
          rulesEngine.drawStatus(fen, history),
          { automatic: rulesEngine.automaticDraw(fen, history), claimable: rulesEngine.claimableDraw(fen, history) },
          'divergence at ' + fen);
      }
    }
  });

  test('drawStatus matches legacy pair across deterministic random games', () => {
    let cases = 0;
    for (let game = 0; game < 25; game++) {
      const inst = rulesEngine.create();
      const hist = [];
      for (let ply = 0; ply < 100; ply++) {
        const legal = inst.moves({ verbose: true });
        if (!legal.length || inst.isGameOver()) break;
        const m = legal[Math.floor(rnd() * legal.length)];
        inst.move(m);
        hist.push(m.from + m.to + (m.promotion || ''));
        const fen = inst.fen();
        for (const h of [hist, undefined]) {
          cases++;
          assert.deepStrictEqual(
            rulesEngine.drawStatus(fen, h),
            { automatic: rulesEngine.automaticDraw(fen, h), claimable: rulesEngine.claimableDraw(fen, h) },
            'divergence: game ' + game + ' ply ' + ply + ' fen ' + fen);
        }
      }
    }
    assert(cases > 1000, 'expected a broad sample, saw ' + cases + ' cases');
  });

  test('drawStatus treats a non-replayable history the same as the pair', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const bad = ['e2e5', 'zzzz'];
    assert.deepStrictEqual(
      rulesEngine.drawStatus(fen, bad),
      { automatic: rulesEngine.automaticDraw(fen, bad), claimable: rulesEngine.claimableDraw(fen, bad) });
  });

  // The split below is the whole point of drawStatus(): the halfmove-clock,
  // seventyfive-move, insufficient-material and fifty-move checks read the
  // board's OWN FEN (fenInstance), while repetition reads the replay. Supplying
  // a non-empty replayable history whose clock DISAGREES with the board FEN is
  // what catches a mutant that routes the FEN-only checks through `replayed`.
  test('drawStatus: FEN-only checks ignore the replay (board clock 100 + short history)', () => {
    const fen = '4k3/8/8/8/8/8/8/R3K3 w - - 100 60'; // R+K vs K; board clock 100
    const hist = ['e2e4'];                              // replays to halfmove 0
    assert.strictEqual(rulesEngine.createFromHistory(hist)._halfMoves, 0,
      'the replay genuinely disagrees with the board clock');
    assert.deepStrictEqual(rulesEngine.drawStatus(fen, hist).claimable,
      { claimable: true, reason: 'fifty-move' }, 'fifty-move comes from the FEN clock, not the history');
    assert.deepStrictEqual(rulesEngine.drawStatus(fen, hist).automatic, { draw: false, reason: null },
      'the replay must not fabricate an automatic draw here');
    // The replay is not itself a draw, so a mutant would report claimable=false.
    assert.deepStrictEqual(rulesEngine.drawStatus(fen, undefined).claimable, { claimable: true, reason: 'fifty-move' });
  });

  test('drawStatus: seventyfive-move ignores the replay (board clock 150 + short history)', () => {
    const fen = '4k3/8/8/8/8/8/8/R3K3 w - - 150 90';
    const hist = ['e2e4'];
    assert.strictEqual(rulesEngine.createFromHistory(hist)._halfMoves, 0, 'replay disagrees with the board clock');
    assert.deepStrictEqual(rulesEngine.drawStatus(fen, hist).automatic,
      { draw: true, reason: 'seventyfive-move' }, 'seventyfive-move comes from the FEN clock');
    assert.deepStrictEqual(rulesEngine.drawStatus(fen, hist).claimable,
      { claimable: true, reason: 'fifty-move' });
  });

  test('drawStatus: insufficient material ignores the replay', () => {
    const fen = '8/8/8/8/8/8/8/k6K w - - 0 1'; // K vs K
    const hist = ['e2e4'];
    assert.deepStrictEqual(rulesEngine.drawStatus(fen, hist).automatic,
      { draw: true, reason: 'insufficient' }, 'insufficient comes from the FEN board');
    assert.deepStrictEqual(rulesEngine.drawStatus(fen, undefined).automatic,
      { draw: true, reason: 'insufficient' });
  });

  test('drawStatus: repetition DOES come from the replay (the other side of the split)', () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const four = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
    const eight = four.concat(four);
    const sixteen = [];
    for (let i = 0; i < 16; i++) sixteen.push(four[i % 4]);
    // FEN alone carries no counts, so only the replay exposes repetition.
    assert.deepStrictEqual(rulesEngine.drawStatus(start, undefined).claimable,
      { claimable: false, reason: null });
    assert.deepStrictEqual(rulesEngine.drawStatus(start, eight).claimable,
      { claimable: true, reason: 'threefold' }, 'threefold is found via the replay');
    assert.deepStrictEqual(rulesEngine.drawStatus(start, sixteen).automatic,
      { draw: true, reason: 'fivefold' }, 'fivefold is found via the replay');
  });

  test('referee routes the post-move draw path through the single-replay helper', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'referee-service.js'), 'utf8');
    assert(/applyDrawStatus\(/.test(src), 'referee uses the single-replay helper');
    assert(/rulesEngine\.drawStatus\(/.test(src), 'helper calls drawStatus');
    // The only direct automaticDraw() left is the defensive fallback branch;
    // the primary path must not call automaticDraw()+claimableDraw() per move.
    const directAutomatic = (src.match(/rulesEngine\.automaticDraw\(/g) || []).length;
    assert.strictEqual(directAutomatic, 1, 'expected only the fallback automaticDraw call, saw ' + directAutomatic);
    assert(/function applyDrawStatus/.test(src), 'falls back gracefully when drawStatus is unavailable');
  });

  let seq = 0;
  const cmd = (ref, type, args) => ref.enqueue({ id: 'm5-' + (++seq), type, args: args || {} });

  await atest('referee: fivefold repetition is still an automatic draw', async () => {
    const ref = new referee.RefereeService({ roomId: 'm5-five', stateFile: path.join(tmp, 'five.json'), journalFile: path.join(tmp, 'five.jsonl') });
    const cycle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
    for (let i = 0; i < 16; i++) {
      const r = await cmd(ref, 'move', { move: cycle[i % 4] });
      if (i < 15) assert(r.ok, 'move ' + i + ' rejected: ' + r.error);
    }
    const s = ref.getState();
    assert(s.gameOver, 'fivefold ends the game automatically');
    assert(s.draw && s.drawReason === 'fivefold', 'reason is fivefold: ' + s.drawReason);
    assert.strictEqual(s.claimableDraw, null);
  });

  await atest('referee: threefold stays claimable, not automatic', async () => {
    const ref = new referee.RefereeService({ roomId: 'm5-three', stateFile: path.join(tmp, 'three.json'), journalFile: path.join(tmp, 'three.jsonl') });
    const seq3 = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
    for (const m of seq3) {
      const r = await cmd(ref, 'move', { move: m });
      assert(r.ok, 'move ' + m + ' rejected: ' + r.error);
    }
    const s = ref.getState();
    assert(!s.gameOver, 'threefold is a claim, not automatic');
    assert.deepStrictEqual(s.claimableDraw, { claimable: true, reason: 'threefold' });
  });

  await atest('referee: fifty-move rule is claimable from the halfmove clock', async () => {
    const ref = new referee.RefereeService({ roomId: 'm5-fifty', stateFile: path.join(tmp, 'fifty.json'), journalFile: path.join(tmp, 'fifty.jsonl') });
    const fen = '8/5k2/8/8/8/8/5K2/8 w - - 100 50';
    const legacy = Object.assign(JSON.parse(JSON.stringify(ref.getState())), {
      board: rulesEngine.fenToBoard(fen), fen, history: [], moveTimestamps: [],
      gameOver: false, status: 'ongoing', result: null, draw: false, drawReason: null
    });
    delete legacy.positions;
    delete legacy.claimableDraw;
    const sf = path.join(tmp, 'fifty-state.json');
    fs.writeFileSync(sf, JSON.stringify(legacy));
    const ref2 = new referee.RefereeService({ roomId: 'm5-fifty-2', stateFile: sf, journalFile: path.join(tmp, 'fifty2.jsonl') });
    assert.deepStrictEqual(ref2.getState().claimableDraw, { claimable: true, reason: 'fifty-move' });
  });

  // End-to-end: the reviewer's reachable path — POST /api/setup with an edited
  // halfmove clock, then a real move. The move must be legal FROM THE STANDARD
  // START (the referee's createFromHistory replays from there), so g1f3 keeps
  // the edited clock; a pawn move would reset it to 0 and hide the split.
  await atest('referee e2e: /api/setup clock 100 + g1f3 → fifty-move from the FEN clock, not the replay', async () => {
    const ref = new referee.RefereeService({ roomId: 'm5-e2e-fifty', stateFile: path.join(tmp, 'e2ef.json'), journalFile: path.join(tmp, 'e2ef.jsonl') });
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 100 60';
    const setup = await cmd(ref, 'setup', { fen });
    assert(setup.ok, 'setup rejected: ' + setup.error);
    const move = await cmd(ref, 'move', { move: 'g1f3' });
    assert(move.ok, 'move rejected: ' + move.error);
    const s = ref.getState();
    assert(Number(s.fen.split(' ')[4]) >= 100, 'edited clock survived: ' + s.fen.split(' ')[4]);
    assert(rulesEngine.createFromHistory(s.history)._halfMoves < 50,
      'the replay (g1f3 from the start) is far below the fifty-move threshold — it disagrees with the board');
    assert.deepStrictEqual(s.claimableDraw, { claimable: true, reason: 'fifty-move' },
      'fifty-move is claimed from the FEN clock, not the replay');
    assert(!s.gameOver && !s.draw, 'not an automatic draw yet');
  });

  await atest('referee e2e: /api/setup clock 150 + g1f3 → seventyfive-move automatic from the FEN clock', async () => {
    const ref = new referee.RefereeService({ roomId: 'm5-e2e-75', stateFile: path.join(tmp, 'e2e75.json'), journalFile: path.join(tmp, 'e2e75.jsonl') });
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 150 90';
    const setup = await cmd(ref, 'setup', { fen });
    assert(setup.ok, 'setup rejected: ' + setup.error);
    const move = await cmd(ref, 'move', { move: 'g1f3' });
    assert(move.ok, 'move rejected: ' + move.error);
    const s = ref.getState();
    assert(rulesEngine.createFromHistory(s.history)._halfMoves < 150, 'replay disagrees with the board');
    assert(s.gameOver && s.draw && s.drawReason === 'seventyfive-move',
      'seventyfive-move drawn from the FEN clock; got ' + s.drawReason);
  });

  await atest('referee: a drawStatus-less engine still applies the automatic draw (fallback)', async () => {
    // Simulate an older rules-engine without drawStatus by temporarily hiding it.
    const saved = rulesEngine.drawStatus;
    delete rulesEngine.drawStatus;
    try {
      const ref = new referee.RefereeService({ roomId: 'm5-fallback', stateFile: path.join(tmp, 'fb.json'), journalFile: path.join(tmp, 'fb.jsonl') });
      const cycle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
      for (let i = 0; i < 16; i++) {
        const r = await cmd(ref, 'move', { move: cycle[i % 4] });
        if (i < 15) assert(r.ok, 'fallback move ' + i + ' rejected: ' + r.error);
      }
      const s = ref.getState();
      assert(s.gameOver && s.drawReason === 'fivefold', 'fallback still ends on fivefold: ' + s.drawReason);
    } finally {
      rulesEngine.drawStatus = saved;
    }
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log(`\nAll ${passed} tests passed successfully!`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
