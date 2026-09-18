'use strict';
// B3: referee-authoritative per-ply positions + claimableDraw in state.
// The client must render history from state.positions (FEN/SAN/lastMove)
// and never replay moves itself. See docs/06-world-class-roadmap.md §2 B3.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-b3-'));
process.env.CHESS_STATE_FILE = path.join(tmp, '.referee-state.json');
process.env.CHESS_JOURNAL_FILE = path.join(tmp, '.referee-journal.jsonl');
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

const referee = require('../src/referee-service.js');

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

let seq = 0;
const cmd = (ref, type, args) => ref.enqueue({ id: 'b3-' + (++seq), type, args: args || {} });

(async () => {
  const ref = new referee.RefereeService({ roomId: 'b3', stateFile: path.join(tmp, 's.json'), journalFile: path.join(tmp, 'j.jsonl') });

  test('new game exposes positions[0] with start FEN and claimableDraw=false', () => {
    const s = ref.getState();
    assert(Array.isArray(s.positions) && s.positions.length === 1);
    assert(s.positions[0].fen.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w'));
    assert.strictEqual(s.positions[0].san, null);
    assert.strictEqual(s.positions[0].lastMove, null);
    assert.deepStrictEqual(s.claimableDraw, { claimable: false, reason: null });
  });

  await atest('each applied move appends { fen, san, lastMove }', async () => {
    for (const m of ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5']) {
      const r = await cmd(ref, 'move', { move: m });
      assert(r.ok, 'move ' + m + ' rejected: ' + r.error);
    }
    const s = ref.getState();
    assert.strictEqual(s.positions.length, 6);
    assert.deepStrictEqual(s.positions.slice(1).map(p => p.san), ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
    assert.deepStrictEqual(s.positions[5].lastMove, { from: 'f1', to: 'b5' });
    assert.strictEqual(s.positions[5].fen, s.fen, 'last position FEN equals state.fen');
    assert.strictEqual(s.positions[2].fen.split(' ')[1], 'w', 'ply 2 is white to move');
  });

  await atest('command responses (stateView) carry positions + claimableDraw', async () => {
    const r = await cmd(ref, 'move', { move: 'a7a6' });
    assert(r.ok);
    assert(Array.isArray(r.positions) && r.positions.length === 7);
    assert(Object.prototype.hasOwnProperty.call(r, 'claimableDraw'));
  });

  await atest('undo truncates positions consistently', async () => {
    const r = await cmd(ref, 'undo');
    assert(r.ok && r.undone);
    const s = ref.getState();
    assert.strictEqual(s.positions.length, s.history.length + 1);
    assert.strictEqual(s.positions[s.positions.length - 1].fen, s.fen);
  });

  await atest('referee policy: threefold auto-draws and claimableDraw clears on game over', async () => {
    // After the undo it is black to move (…5.Bb5). Shuffle Nc6-b8-c6 / Bb5-a4-b5
    // twice so the position recurs a third time. The referee auto-draws here
    // (t0-draw-flagfall policy), so the claim flow is for 50-move positions.
    const shuffle = ['c6b8', 'b5a4', 'b8c6', 'a4b5', 'c6b8', 'b5a4', 'b8c6', 'a4b5'];
    let last = null;
    for (const m of shuffle) {
      last = await cmd(ref, 'move', { move: m });
      assert(last.ok, 'shuffle move ' + m + ' rejected: ' + last.error);
    }
    const s = ref.getState();
    assert(s.gameOver && s.drawReason === 'threefold', 'auto-draw on threefold');
    assert.strictEqual(s.claimableDraw, null, 'no claim once the game is over');
    assert.strictEqual(s.positions.length, s.history.length + 1);
  });

  test('a 50-move position surfaces claimableDraw.reason = fifty-move', () => {
    const fen = '8/5k2/8/8/8/8/5K2/8 w - - 100 50';
    const rulesEngine = require('../src/rules-engine.js');
    const legacy = Object.assign(JSON.parse(JSON.stringify(ref.getState())), {
      board: rulesEngine.fenToBoard(fen), fen, history: [], moveTimestamps: [],
      gameOver: false, status: 'ongoing', result: null, draw: false, drawReason: null
    });
    delete legacy.positions;
    delete legacy.claimableDraw;
    const sf = path.join(tmp, 'fifty.json');
    fs.writeFileSync(sf, JSON.stringify(legacy));
    const ref3 = new referee.RefereeService({ roomId: 'b3-fifty', stateFile: sf, journalFile: path.join(tmp, 'fifty.jsonl') });
    const s3 = ref3.getState();
    assert.deepStrictEqual(s3.claimableDraw, { claimable: true, reason: 'fifty-move' });
    assert.strictEqual(s3.positions.length, 1);
    assert.strictEqual(s3.positions[0].fen.split(' ')[0], fen.split(' ')[0]);
  });

  test('legacy snapshot without positions is rebuilt on boot', () => {
    const legacy = JSON.parse(JSON.stringify(ref.getState()));
    delete legacy.positions;
    delete legacy.claimableDraw;
    const sf = path.join(tmp, 'legacy.json');
    fs.writeFileSync(sf, JSON.stringify(legacy));
    const ref2 = new referee.RefereeService({ roomId: 'b3-legacy', stateFile: sf, journalFile: path.join(tmp, 'legacy.jsonl') });
    const s2 = ref2.getState();
    assert.strictEqual(s2.positions.length, s2.history.length + 1);
    assert.strictEqual(s2.positions[s2.positions.length - 1].fen, s2.fen);
    assert(Object.prototype.hasOwnProperty.call(s2, 'claimableDraw'));
  });

  test('buildPositions() is pure and rejects illegal histories', () => {
    const ok = referee.buildPositions(['e2e4', 'e7e5']);
    assert(ok && ok.length === 3 && ok[2].san === 'e5');
    assert.strictEqual(referee.buildPositions(['e2e5']), null);
  });

  await atest('setup from a custom FEN seeds positions[0] with that FEN', async () => {
    const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    const r = await cmd(ref, 'setup', { fen });
    assert(r.ok, 'setup rejected: ' + r.error);
    const s = ref.getState();
    assert.strictEqual(s.positions.length, 1);
    assert.strictEqual(s.positions[0].fen.split(' ')[0], fen.split(' ')[0]);
  });

  test('ui.js renders history from state.positions and owns no move replay', () => {
    const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui.js'), 'utf8');
    assert(/function fenToDisplayBoard\(/.test(ui), 'display-only FEN parser exists');
    assert(/positionsToHistorySnapshots\(/.test(ui), 'history snapshots come from positions');
    assert(!/\bhistoryToSan\b/.test(ui), 'no client-side SAN replay');
    assert(!/(make|Initial)['"]\s*\+\s*['"](Move|Board)/.test(ui), 'no concatenated engine lookups');
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log(`\nAll ${passed} tests passed successfully!`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
