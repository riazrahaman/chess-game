#!/usr/bin/env node
'use strict';

/**
 * wave3-hygiene-selftest.js — Wave 3 Worker D (kanban: w3-room-file-gc,
 * w3-csp-inline-hash, w3-missed-tactics).
 *
 *   A. Auto-room state-file GC (server.js gcRooms + referee-service helpers):
 *      idle finished game → archived + files deleted; idle unstarted → deleted;
 *      live seat / in-progress / recent → kept; default room never touched;
 *      cap eviction (CHESS_ROOM_MAX) picks the oldest idle rooms first;
 *      GET /api/admin/rooms is 404 without CHESS_ADMIN_TOKEN, 401 with a wrong
 *      token, 200 with the right one; POST /api/admin/rooms/gc runs a sweep.
 *   B. CSP: script-src has no 'unsafe-inline'; index.html has no inline
 *      <script> (every <script> carries src=); sw-register.js is servable.
 *   C. findMissedTactics on a synthetic fixture finds exactly the planted miss.
 *   D. GET /api/games/:id/missed-tactics on a short archived game returns a
 *      well-formed array (engine on; ≤ 6 plies so it stays fast).
 *
 * All state lives under os.tmpdir(); nothing is written to the repo root.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-wave3-hygiene-'));
process.env.CHESS_STATE_FILE = path.join(TMP, '.referee-state.json');
process.env.CHESS_JOURNAL_FILE = path.join(TMP, '.referee-journal.jsonl');
process.env.CHESS_DB_FILE = path.join(TMP, 'games.db');
process.env.CHESS_JSON_ARCHIVE_FILE = path.join(TMP, '.games-archive.json');
process.env.CHESS_ACCOUNTS_DB_FILE = path.join(TMP, 'accounts.db');
process.env.CHESS_SOCIAL_DB_PATH = path.join(TMP, 'social.db');
process.env.CHESS_ROOM_GC = '0'; // never let a scheduler run inside a test
delete process.env.CHESS_ADMIN_TOKEN;
delete process.env.CHESS_CSP;
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

const ROOT = path.join(__dirname, '..');
const referee = require('../src/referee-service.js');
const gameArchive = require('../src/game-archive.js');
const server = require('../server.js');
// missed-tactics.js is required lazily inside sections C/D.

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('PASS: ' + msg); }
  else { failed++; console.error('FAIL: ' + msg); }
}
async function test(name, fn) {
  try { await fn(); }
  catch (err) { failed++; console.error('FAIL: ' + name + ' — ' + (err && err.stack || err)); }
}

const HOUR = 3600 * 1000;
function ageFiles(roomId, ageMs) {
  const t = new Date(Date.now() - ageMs);
  for (const f of [referee.getRoomStateFile(roomId), referee.getRoomJournalFile(roomId)]) {
    try { fs.utimesSync(f, t, t); } catch (_) {}
  }
}
function writeSnapshot(roomId, state) {
  referee.atomicSaveSnapshot(state, referee.getRoomStateFile(roomId));
  fs.writeFileSync(referee.getRoomJournalFile(roomId), '');
}
async function playRoom(roomId, moves) {
  const ref = referee.getReferee(roomId);
  let last = null;
  for (const m of moves) {
    last = await ref.enqueue({ id: roomId + ':' + m, type: 'move', args: { move: m } });
    if (!last.ok) throw new Error('move rejected ' + m + ': ' + last.error);
  }
  return last;
}
function fileExists(f) { try { fs.statSync(f); return true; } catch (_) { return false; } }
function request(port, method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const FOOLS_MATE = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];
const QUEEN_MATE = ['e2e4', 'f7f6', 'd2d4', 'g7g5', 'd1h5']; // 3.Qh5#

async function sectionRoomGc() {
  console.log('\n=== A. auto-room GC ===');
  referee.getReferee('default'); // default room exists on disk
  const defaultState = referee.getRoomStateFile('default');
  const defaultJournal = referee.getRoomJournalFile('default');

  // 1. idle finished game (played through the referee, then "server restarted")
  const fin = await playRoom('gc-finished', FOOLS_MATE);
  assert(fin.gameOver === true, 'fixture: fool\'s mate ends the game');
  referee.resetInstance('gc-finished');
  ageFiles('gc-finished', 25 * HOUR);

  // 2. idle unstarted room (snapshot written directly, as a visitor would leave it)
  writeSnapshot('gc-empty', referee.newGame());
  ageFiles('gc-empty', 25 * HOUR);

  // 3. idle unstarted room with a live human seat
  writeSnapshot('gc-seated', referee.newGame());
  ageFiles('gc-seated', 25 * HOUR);
  const claim = server.seatAuthManager.claimSeat('gc-seated', 'white');
  assert(claim.ok, 'fixture: white seat claimed in gc-seated');

  // 4. idle game in progress (moves, not over)
  await playRoom('gc-playing', ['e2e4', 'e7e5']);
  referee.resetInstance('gc-playing');
  ageFiles('gc-playing', 25 * HOUR);

  // 5. recent unstarted room
  writeSnapshot('gc-recent', referee.newGame());

  // 6. finished room whose game is already archived (client auto-save happened)
  const qm = await playRoom('gc-archived', QUEEN_MATE);
  assert(qm.gameOver === true, 'fixture: 3.Qh5# ends the game');
  referee.resetInstance('gc-archived');
  ageFiles('gc-archived', 25 * HOUR);
  gameArchive.saveGame({ white: 'White', black: 'Black', result: '1-0', moves: QUEEN_MATE });

  // 7. bot seat only (bot seats never expire in seat-auth) — must not pin the room
  writeSnapshot('gc-botseat', referee.newGame());
  ageFiles('gc-botseat', 25 * HOUR);
  server.seatAuthManager.claimSeat('gc-botseat', 'black', { isBot: true });

  const before = referee.listRoomIds();
  assert(!before.includes('default'), 'listRoomIds never lists the default room');
  assert(['gc-finished', 'gc-empty', 'gc-seated', 'gc-playing', 'gc-recent', 'gc-archived', 'gc-botseat'].every(r => before.includes(r)),
    'listRoomIds discovers on-disk rooms without instantiating referees (' + before.join(',') + ')');
  assert(!referee.getRoomStateFile('gc-empty').endsWith('.referee-state.json') && referee.inspectRoom('gc-empty').inMemory === false,
    'inspectRoom reads the snapshot without creating an in-memory referee');

  const archivedBefore = gameArchive.listGames({ limit: 100 }).length;
  const summary = server.gcRooms({ log: false });
  const collectedIds = summary.rooms.map(r => r.roomId).sort();
  assert(summary.ok && summary.scanned === before.length, 'sweep scans every non-default room (' + summary.scanned + ')');
  assert(collectedIds.includes('gc-finished'), 'idle finished game is collected');
  assert(collectedIds.includes('gc-empty'), 'idle unstarted room is collected');
  assert(collectedIds.includes('gc-archived'), 'idle finished game already in the archive is collected');
  assert(collectedIds.includes('gc-botseat'), 'a bot-only seat does not pin an idle room');
  assert(!collectedIds.includes('gc-seated'), 'room with a live human seat is kept');
  assert(!collectedIds.includes('gc-playing'), 'idle game in progress is kept');
  assert(!collectedIds.includes('gc-recent'), 'recent unstarted room is kept');
  const finRow = summary.rooms.find(r => r.roomId === 'gc-finished');
  assert(finRow && finRow.archived === true && finRow.archiveId, 'finished game not in the archive is archived before deletion');
  const archRow = summary.rooms.find(r => r.roomId === 'gc-archived');
  assert(archRow && archRow.archived === false && archRow.archiveReason === 'already archived', 'finished game already archived (by move signature) is not archived twice');
  assert(gameArchive.listGames({ limit: 100 }).length === archivedBefore + 1, 'archive grew by exactly one game');
  const saved = gameArchive.getGame(finRow.archiveId);
  assert(saved && saved.moves === FOOLS_MATE.join(' ') && saved.result === '0-1' && saved.white === 'White' && saved.black === 'Black',
    'archived record matches ui-archive.js auto-save fields (white/black/result/moves) — got ' + JSON.stringify(saved && { moves: saved.moves, result: saved.result }));
  assert(saved && /1\. f3 e5 2\. g4 Qh4# 0-1/.test(saved.pgn), 'archived PGN built from referee SAN: ' + (saved && saved.pgn.split('\n\n')[1]));
  for (const id of ['gc-finished', 'gc-empty', 'gc-archived', 'gc-botseat']) {
    assert(!fileExists(referee.getRoomStateFile(id)) && !fileExists(referee.getRoomJournalFile(id)), `state + journal files deleted for ${id}`);
  }
  for (const id of ['gc-seated', 'gc-playing', 'gc-recent']) {
    assert(fileExists(referee.getRoomStateFile(id)), `state file kept for ${id}`);
  }
  assert(fileExists(defaultState), 'default room snapshot untouched (' + path.basename(defaultState) + ')');
  assert(!fileExists(defaultJournal) || fs.statSync(defaultJournal).isFile(), 'default room journal untouched');
  assert(referee.listRoomIds().length === 3, 'three rooms remain after the sweep');
  assert(server.seatAuthManager.getStatus('gc-seated').whiteOccupied === true, 'kept room keeps its seat');

  // Second sweep is a no-op.
  const again = server.gcRooms({ log: false });
  assert(again.collected === 0 && again.kept === 3, 'second sweep collects nothing');

  // Cap eviction: more rooms than CHESS_ROOM_MAX → oldest idle first, but never busy rooms.
  writeSnapshot('cap-a', referee.newGame()); ageFiles('cap-a', 30 * 60 * 1000);
  writeSnapshot('cap-b', referee.newGame()); ageFiles('cap-b', 20 * 60 * 1000);
  writeSnapshot('cap-c', referee.newGame()); ageFiles('cap-c', 10 * 60 * 1000);
  writeSnapshot('cap-d', referee.newGame()); // fresh (< minIdleMs) — never evicted
  // 7 rooms total (3 kept + 4 cap-*); cap at 5 → evict the 2 oldest eligible.
  const capped = server.gcRooms({ log: false, maxRooms: 5, minIdleMs: 60 * 1000 });
  const evicted = capped.rooms.map(r => r.roomId).sort();
  assert(evicted.join(',') === 'cap-a,cap-b', 'cap eviction removes the oldest idle rooms first (' + evicted.join(',') + ')');
  assert(fileExists(referee.getRoomStateFile('cap-c')) && fileExists(referee.getRoomStateFile('cap-d')), 'cap eviction stops once under the cap');
  assert(fileExists(referee.getRoomStateFile('gc-seated')) && fileExists(referee.getRoomStateFile('gc-playing')), 'cap eviction never touches busy rooms');
  const overCap = server.gcRooms({ log: false, maxRooms: 1, minIdleMs: 60 * 1000 });
  assert(overCap.collected === 1 && overCap.rooms[0].roomId === 'cap-c' && overCap.overCap === 3,
    'cap eviction below the cap is reported as overCap when only busy/fresh rooms remain');

  // In-memory room with an SSE client / recent touch is kept.
  writeSnapshot('gc-touched', referee.newGame()); ageFiles('gc-touched', 25 * HOUR);
  server.touchRoom('gc-touched');
  const touched = server.gcRooms({ log: false });
  assert(!touched.rooms.some(r => r.roomId === 'gc-touched'), 'a room seen by an API request is not idle even if its file is old');

  // Admin routes.
  const srv = server.createServer();
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    let r = await request(port, 'GET', '/api/admin/rooms');
    assert(r.status === 404, 'GET /api/admin/rooms is 404 when CHESS_ADMIN_TOKEN is unset (' + r.status + ')');
    r = await request(port, 'POST', '/api/admin/rooms/gc');
    assert(r.status === 404, 'POST /api/admin/rooms/gc is 404 when CHESS_ADMIN_TOKEN is unset');
    process.env.CHESS_ADMIN_TOKEN = 'wave3-secret';
    r = await request(port, 'GET', '/api/admin/rooms', { headers: { 'X-Admin-Token': 'nope' } });
    assert(r.status === 401, 'wrong X-Admin-Token is 401');
    r = await request(port, 'GET', '/api/admin/rooms');
    assert(r.status === 401, 'missing X-Admin-Token is 401 when the env is set');
    r = await request(port, 'GET', '/api/admin/rooms', { headers: { 'X-Admin-Token': 'wave3-secret' } });
    assert(r.status === 200 && r.json && Array.isArray(r.json.rooms), 'GET /api/admin/rooms lists rooms with the right token');
    const row = r.json && r.json.rooms.find(x => x.roomId === 'gc-playing');
    assert(row && row.plies === 2 && row.gameOver === false && typeof row.idleMs === 'number' && row.seats && Array.isArray(row.blockedBy) && row.blockedBy.includes('game in progress') && !('_info' in row),
      'room listing carries plies/gameOver/idleMs/seats/blockedBy and no internal fields: ' + JSON.stringify(row));
    assert(r.json.config && r.json.config.idleMs === 24 * HOUR && r.json.config.maxRooms === 2000, 'listing reports GC config defaults (24h idle, 2000 rooms)');
    writeSnapshot('gc-http', referee.newGame()); ageFiles('gc-http', 25 * HOUR);
    r = await request(port, 'POST', '/api/admin/rooms/gc', { headers: { 'X-Admin-Token': 'wave3-secret' } });
    assert(r.status === 200 && r.json && r.json.ok && r.json.rooms.some(x => x.roomId === 'gc-http'), 'POST /api/admin/rooms/gc runs a sweep now');
    // a request naming a room touches it
    await request(port, 'GET', '/api/state?room=gc-touched');
    const listed = server.listRooms().find(x => x.roomId === 'gc-touched');
    assert(listed && listed.idleMs < 5000, 'GET /api/state?room= refreshes the room\'s idle clock');
  } finally {
    delete process.env.CHESS_ADMIN_TOKEN;
    server.stopStateWatcher();
    await new Promise(r => srv.close(r));
  }
}

async function sectionCsp() {
  console.log('\n=== B. CSP without unsafe-inline scripts ===');
  const csp = server.buildCsp();
  const directive = name => {
    const d = csp.split(';').map(s => s.trim()).find(s => s.startsWith(name + ' '));
    return d ? d.split(/\s+/).slice(1) : [];
  };
  const scriptSrc = directive('script-src');
  assert(scriptSrc.includes("'self'") && !scriptSrc.includes("'unsafe-inline'"), "script-src has no 'unsafe-inline': " + scriptSrc.join(' '));
  assert(scriptSrc.includes("'wasm-unsafe-eval'") && !scriptSrc.includes("'unsafe-eval'"), 'script-src keeps wasm-unsafe-eval and no unsafe-eval');
  assert(scriptSrc.includes('https://accounts.google.com/gsi/client'), 'script-src still allows the Google GSI client');
  assert(directive('style-src').includes("'unsafe-inline'"), "style-src keeps 'unsafe-inline' (inline <style> + style= attributes remain)");

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const inlineScripts = [];
  const re = /<script\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) if (!/\bsrc\s*=/.test(m[1])) inlineScripts.push(m[0]);
  assert(inlineScripts.length === 0, 'index.html has no inline <script> block (' + inlineScripts.length + ')');
  assert(!/\son[a-z]+\s*=/i.test(html), 'index.html has no inline on*= handlers');
  assert(/<script\s+src="src\/sw-register\.js"><\/script>/.test(html), 'index.html loads src/sw-register.js');
  const swReg = fs.readFileSync(path.join(ROOT, 'src', 'sw-register.js'), 'utf8');
  assert(swReg.includes("navigator.serviceWorker.register('/service-worker.js')"), 'sw-register.js registers /service-worker.js');
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert(serverSrc.includes("'src/sw-register.js'"), 'sw-register.js is in ALLOWED_FILES');

  const srv = server.createServer();
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await request(srv.address().port, 'GET', '/src/sw-register.js');
    assert(r.status === 200 && /application\/javascript/.test(r.headers['content-type'] || ''), 'GET /src/sw-register.js is served as JavaScript');
    const h = await request(srv.address().port, 'GET', '/');
    const live = (h.headers['content-security-policy'] || '').split(';').map(s => s.trim()).find(s => s.startsWith('script-src ')) || '';
    assert(live && !live.split(/\s+/).includes("'unsafe-inline'"), 'live CSP header script-src has no unsafe-inline');
  } finally {
    await new Promise(r => srv.close(r));
  }
}

async function sectionMissedTactics() {
  console.log('\n=== C. findMissedTactics ===');
  const missedTactics = require('../src/missed-tactics.js');
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  // Synthetic 6-ply game: after Black's ply 4 the eval jumps +300 for White
  // (Black blundered), White's ply 5 gives most of it back → Miss at ply 5.
  // Ply 3 is a normal move (small drift) and must NOT be flagged.
  const positions = [
    { fen: START, san: null, lastMove: null },
    { fen: 'p1 b', san: 'e4', lastMove: { from: 'e2', to: 'e4' } },
    { fen: 'p2 w', san: 'e5', lastMove: { from: 'e7', to: 'e5' } },
    { fen: 'p3 b', san: 'Nf3', lastMove: { from: 'g1', to: 'f3' } },
    { fen: 'p4 w', san: 'f6', lastMove: { from: 'f7', to: 'f6' } },
    { fen: 'p5 b', san: 'Nc3', lastMove: { from: 'b1', to: 'c3' } },
    { fen: 'p6 w', san: 'Nc6', lastMove: { from: 'b8', to: 'c6' } }
  ];
  const evals = [
    { cp: 20, bestmove: 'e2e4' },
    { cp: 30, bestmove: 'e7e5' },
    { cp: 25, bestmove: 'g1f3' },
    { cp: 30, bestmove: 'b8c6' },
    { cp: 330, bestmove: 'f3e5' },   // Black's f6?? — White should play Nxe5
    { cp: 40, bestmove: 'b8c6' },    // White played Nc3, giving back 290 cp
    { cp: 35, bestmove: 'f1c4' }
  ];
  const misses = missedTactics.findMissedTactics(positions, evals);
  assert(Array.isArray(misses) && misses.length === 1, 'exactly one miss found (' + (misses && misses.length) + ')');
  const miss = misses[0] || {};
  assert(miss.ply === 5 && miss.color === 'white', 'the miss is White\'s ply 5: ' + JSON.stringify(miss));
  assert(miss.fen === 'p4 w' && miss.bestMove === 'f3e5' && miss.playedMove === 'b1c3', 'miss carries the pre-move fen, engine best move and the played move');
  assert(miss.swingCp === 300 && miss.giveBackCp === 290, `swing/giveback in cp: swing=${miss.swingCp} giveBack=${miss.giveBackCp}`);
  assert(typeof miss.swingWinProb === 'number' && miss.swingWinProb > 10 && typeof miss.giveBackWinProb === 'number', 'win-probability deltas reported via the move-review logistic');
  assert(missedTactics.findMissedTactics(positions, evals, { color: 'black' }).length === 0, 'color filter: no Black misses in this fixture');
  assert(missedTactics.findMissedTactics(positions, evals.map(e => e.cp)).length === 1, 'accepts plain numeric evals (bestMove then null)');
  // A small swing (< 150 cp) or small give-back (< 100 cp) is not a miss.
  const calm = evals.map(e => ({ cp: Math.max(-60, Math.min(60, e.cp)), bestmove: e.bestmove }));
  assert(missedTactics.findMissedTactics(positions, calm).length === 0, 'no miss in a calm game');
  const kept = evals.slice(); kept[5] = { cp: 300, bestmove: 'x' };
  assert(missedTactics.findMissedTactics(positions, kept).length === 0, 'punishing the blunder (keeping the swing) is not a miss');
  // A full-blown blunder stays a blunder, not a miss.
  const blunder = evals.slice(); blunder[5] = { cp: -600, bestmove: 'x' };
  const bl = missedTactics.findMissedTactics(positions, blunder);
  assert(!bl.some(m => m.ply === 5), 'a reply that loses the game outright (ply 5) is a Blunder, not a Miss');
  assert(bl.length === 1 && bl[0].ply === 6 && bl[0].color === 'black', 'and Black failing to keep that gift (ply 6, back to level) is a Miss: ' + JSON.stringify(bl.map(m => m.ply)));
  // Walking back into the mate the opponent had threatened (the live 1.e4 e5 2.Qh5 Nc6
  // 3.Bc4 Nf6?? 4.Nc3?? d6?? game: Black could take the queen, instead allows Qxf7#) is a Blunder.
  const mateBack = [
    { cp: 30 }, { cp: 30 }, { cp: 30 }, { cp: -30 }, { cp: -30 }, { cp: -25 },
    { cp: 9990, bestmove: 'h5f7' },   // after 3...Nf6?? White mates in 1
    { cp: -952, bestmove: 'f6h5' },   // 4.Nc3?? hands Black the queen
    { cp: 9990, bestmove: 'h5f7' }    // 4...d6?? allows the mate again
  ];
  const posN = Array.from({ length: 9 }, (_, i) => ({ fen: `p${i} ${i % 2 ? 'b' : 'w'}`, san: 'x', lastMove: { from: 'a1', to: 'a2' } }));
  assert(missedTactics.findMissedTactics(posN, mateBack).length === 0, 'walking back into a lost position (allowing the mate) is a Blunder, not a Miss');
  // A missed mate-in-1 in an otherwise level game IS a Miss, and the cp numbers are clamped.
  const missedMate = mateBack.slice(); missedMate[7] = { cp: 40, bestmove: 'b1c3' }; missedMate[8] = { cp: 35 };
  const mm = missedTactics.findMissedTactics(posN, missedMate);
  assert(mm.length === 1 && mm[0].ply === 7 && mm[0].color === 'white' && mm[0].bestMove === 'h5f7', 'a missed mate-in-1 in a level game is a Miss: ' + JSON.stringify(mm.map(m => m.ply)));
  assert(mm[0].swingCp === 2000 + 25 && mm[0].giveBackCp === 2000 - 40, `mate scores are clamped to ±2000 before the cp arithmetic (swing=${mm[0].swingCp} giveBack=${mm[0].giveBackCp})`);
  // move-review integration: applyMissLabels reclassifies the ply in a reviewGame() result.
  const MoveReview = require('../src/move-review.js');
  assert(MoveReview.CLASSIFICATIONS.MISS && MoveReview.CLASSIFICATIONS.MISS.key === 'miss', 'move-review exposes a Miss classification');
  const review = MoveReview.reviewGame(positions.slice(1).map(p => p.lastMove.from + p.lastMove.to), evals.map(e => e.cp));
  assert(review.counts.white.miss === 0 && review.counts.black.miss === 0, 'reviewGame counts carry a miss slot (0 before labelling)');
  const labelled = MoveReview.applyMissLabels(review, misses);
  assert(labelled.moves[4].key === 'miss' && labelled.counts.white.miss === 1 && Object.keys(labelled.counts.white).filter(k => k !== 'miss').reduce((a, k) => a + labelled.counts.white[k], 0) === 2,
    'applyMissLabels relabels ply 5 as Miss and moves its count: ' + JSON.stringify(labelled.counts.white));
  assert(missedTactics.MISS_SWING_CP === 150 && missedTactics.MISS_GIVEBACK_CP === 100, 'thresholds: swing ≥150 cp, give-back ≥100 cp');
}

async function sectionMissedTacticsRoute() {
  console.log('\n=== D. GET /api/games/:id/missed-tactics ===');
  const engineServer = require('../src/engine-server.js');
  const saved = gameArchive.saveGame({ white: 'White', black: 'Black', result: '0-1', moves: FOOLS_MATE });
  const srv = server.createServer();
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    let r = await request(port, 'GET', '/api/games/nope-' + Date.now() + '/missed-tactics');
    assert(r.status === 404, 'unknown game id is 404');
    const t0 = Date.now();
    r = await request(port, 'GET', `/api/games/${encodeURIComponent(saved.id)}/missed-tactics`);
    const dt = Date.now() - t0;
    assert(r.status === 200 && r.json && r.json.ok === true, 'route answers 200 ok (' + r.status + ' ' + (r.body || '').slice(0, 120) + ')');
    const j = r.json || {};
    assert(Array.isArray(j.misses), 'misses is an array');
    assert(j.plies === FOOLS_MATE.length && Array.isArray(j.evals) && j.evals.length === FOOLS_MATE.length + 1, 'evals cover every position (' + (j.evals && j.evals.length) + ')');
    assert(j.evals.every(e => e && typeof e.cp === 'number' || (e && typeof e.mate === 'number')), 'every eval carries cp (or mate)');
    assert(j.evaluated === j.evals.length || j.engine === null, 'evaluated count reported: ' + JSON.stringify({ evaluated: j.evaluated, cached: j.cached, engine: j.engine }));
    if (engineServer.isAvailable()) {
      assert(j.engine === engineServer.ENGINE_NAME, 'engine name reported: ' + j.engine);
      assert(j.misses.every(m => typeof m.ply === 'number' && typeof m.fen === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m.bestMove) && /^[a-h][1-8][a-h][1-8]/.test(m.playedMove) && typeof m.swingCp === 'number'),
        'every miss is well-formed {ply,fen,bestMove,playedMove,swingCp}');
      // Fool's mate: after 2.g4?? Black mates — White's g4 is a blunder, not a miss;
      // Black's Qh4# punishes, so no miss is expected. Whatever the engine says,
      // the shape is what matters, and ply 4 must never be a miss.
      assert(!j.misses.some(m => m.ply === 4), 'the mating move is never a miss');
      // Second call hits the eval cache.
      r = await request(port, 'GET', `/api/games/${encodeURIComponent(saved.id)}/missed-tactics`);
      assert(r.json && r.json.cached === r.json.evals.length, 'second call is fully served from eval_cache (' + (r.json && r.json.cached) + ')');
      const black = await request(port, 'GET', `/api/games/${encodeURIComponent(saved.id)}/missed-tactics?color=black`);
      assert(black.json && black.json.misses.every(m => m.color === 'black'), 'color filter honoured');
      const post = await request(port, 'POST', '/api/review/missed-tactics', { headers: { 'Content-Type': 'application/json' }, body: { moves: FOOLS_MATE } });
      assert(post.status === 200 && post.json && Array.isArray(post.json.misses) && post.json.plies === 4, 'POST /api/review/missed-tactics {moves} works for unarchived (room) games');
      const bad = await request(port, 'POST', '/api/review/missed-tactics', { headers: { 'Content-Type': 'application/json' }, body: { moves: ['e2e4', 'zz'] } });
      assert(bad.status === 400, 'malformed UCI list is 400');
    } else {
      console.log('SKIP: engine unavailable — shape-only checks ran');
    }
    console.log(`(missed-tactics route took ${dt} ms for ${FOOLS_MATE.length} plies)`);
  } finally {
    await new Promise(r => srv.close(r));
    try { await engineServer.shutdown(); } catch (_) {}
  }
}

(async () => {
  await test('room gc', sectionRoomGc);
  await test('csp', sectionCsp);
  await test('missed tactics', sectionMissedTactics);
  await test('missed tactics route', sectionMissedTacticsRoute);
  console.log(`\n${failed > 0 ? 'Failed: ' + failed + ', ' : ''}Passed: ${passed}`);
  try { gameArchive.resetArchive(); } catch (_) {}
  process.exit(failed > 0 ? 1 : 0);
})();
