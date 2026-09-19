#!/usr/bin/env node
'use strict';

// G4: Undo as a request with opponent consent.
//
// In solo / local / unseated / bot games POST /api/undo is unilateral and
// unchanged. When BOTH seats are occupied by non-bot humans, a bare
// POST /api/undo records a pending request instead of mutating the board, and
// the opponent answers via POST /api/undo/respond (alias /api/undo-respond)
// with { consent: true|false }.

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Keep every runtime file under os.tmpdir() BEFORE requiring server.js. The
// referee derives per-room snapshot/journal paths from CHESS_STATE_FILE /
// CHESS_JOURNAL_FILE at call time, so this makes the whole run hermetic.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-g4-undo-'));
process.env.CHESS_STATE_FILE = path.join(TMP_DIR, '.referee-state.json');
process.env.CHESS_JOURNAL_FILE = path.join(TMP_DIR, '.referee-journal.jsonl');
process.env.CHESS_SOCIAL_DB_PATH = path.join(TMP_DIR, 'social.db');
process.env.CHESS_LEAGUES_DB_PATH = path.join(TMP_DIR, 'leagues.db');
process.env.CHESS_DB_FILE = path.join(TMP_DIR, 'games.db');
process.env.CHESS_JSON_ARCHIVE_FILE = path.join(TMP_DIR, 'archive.json');
process.env.CHESS_ACCOUNTS_DB_FILE = path.join(TMP_DIR, 'accounts.db');
process.on('exit', () => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

const { createServer } = require('../server.js');

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

const TEST_PORT = 39911;

async function run() {
  const server = createServer();
  await new Promise(resolve => server.listen(TEST_PORT, '127.0.0.1', resolve));

  function request(p, options = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${TEST_PORT}${p}`, options, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch (e) {}
          resolve({ status: res.statusCode, headers: res.headers, body: data, json });
        });
      });
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  function jsonPost(p, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-Seat-Token'] = token;
    return request(p, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  }

  function post(p, token) {
    const headers = {};
    if (token) headers['X-Seat-Token'] = token;
    return request(p, { method: 'POST', headers });
  }

  async function claim(room, role) {
    const res = await jsonPost('/api/seat/claim', { role, room });
    return res.json && res.json.token;
  }

  async function move(room, moveStr, token) {
    return jsonPost(`/api/move?room=${room}`, { move: moveStr }, token);
  }

  // /api/state returns the raw referee state (history is UCI string[]);
  // command responses return stateView (plyCount / history SAN string).
  function plyOf(stateJson) {
    if (!stateJson) return -1;
    if (Array.isArray(stateJson.history)) return stateJson.history.length;
    if (typeof stateJson.plyCount === 'number') return stateJson.plyCount;
    return -1;
  }

  try {
    // ---------------------------------------------------------------------
    // 1. Solo / unseated: undo is still immediate and backward compatible.
    // ---------------------------------------------------------------------
    console.log('=== Test Suite 1: solo / unseated undo stays unilateral ===');
    const soloRoom = 'g4-solo';
    await post(`/api/reset?room=${soloRoom}`);
    await move(soloRoom, 'e2e4');
    await move(soloRoom, 'e7e5');
    const soloUndo = await post(`/api/undo?room=${soloRoom}`);
    assert(soloUndo.status === 200, `unseated POST /api/undo succeeds (got ${soloUndo.status})`);
    assert(soloUndo.json.undone === true, 'unseated undo applies immediately');
    assert(Array.isArray(soloUndo.json.history) || soloUndo.json.plyCount !== undefined, 'unseated undo returns state');
    assert(soloUndo.json.plyCount === 1 || soloUndo.json.history === '1. e2e4', 'unseated undo removed one ply');
    assert(!soloUndo.json.undoRequest, 'unseated undo never creates a pending request');

    // ---------------------------------------------------------------------
    // 2. Human vs human: undo becomes a request, board unchanged.
    // ---------------------------------------------------------------------
    console.log('\n=== Test Suite 2: human-vs-human undo requires consent ===');
    const h2hRoom = 'g4-h2h';
    await post(`/api/reset?room=${h2hRoom}`);
    const tokenW = await claim(h2hRoom, 'white');
    const tokenB = await claim(h2hRoom, 'black');
    assert(typeof tokenW === 'string' && typeof tokenB === 'string', 'claimed white + black human seats');

    await move(h2hRoom, 'e2e4', tokenW);
    await move(h2hRoom, 'e7e5', tokenB);
    const beforeReq = await request(`/api/state?room=${h2hRoom}`);
    assert(plyOf(beforeReq.json) === 2, 'two plies before the request');

    // White requests undo (board must NOT change).
    const reqRes = await jsonPost(`/api/undo?room=${h2hRoom}`, {}, tokenW);
    assert(reqRes.status === 200, `seated human undo request returns 200 (got ${reqRes.status})`);
    assert(reqRes.json.undone !== true, 'human-vs-human undo does NOT apply immediately');
    assert(plyOf(reqRes.json) === 2, 'board is unchanged by the request');
    assert(reqRes.json.undoRequest === 'white', 'state.undoRequest records the requester colour');

    // Idempotent re-request from the same colour returns the existing request.
    const reReq = await jsonPost(`/api/undo?room=${h2hRoom}`, {}, tokenW);
    assert(plyOf(reReq.json) === 2, 'idempotent re-request leaves the board unchanged');
    assert(reReq.json.undoRequest === 'white', 'idempotent re-request keeps the same requester');

    // ---------------------------------------------------------------------
    // 3. Requester cannot consent to their own request.
    // ---------------------------------------------------------------------
    console.log('\n=== Test Suite 3: requester cannot self-consent ===');
    const selfRes = await jsonPost(`/api/undo/respond?room=${h2hRoom}`, { consent: true }, tokenW);
    assert(selfRes.status === 403 || selfRes.json.ok === false, `requester self-consent rejected (got ${selfRes.status})`);
    assert(plyOf(selfRes.json) === 2, 'self-consent leaves the board unchanged');
    assert(selfRes.json.undoRequest === 'white', 'self-consent leaves the pending request intact');

    // ---------------------------------------------------------------------
    // 4. Opponent declines: request cleared, board unchanged.
    // ---------------------------------------------------------------------
    console.log('\n=== Test Suite 4: opponent declines ===');
    const declineRes = await jsonPost(`/api/undo-respond?room=${h2hRoom}`, { consent: false }, tokenB);
    assert(declineRes.status === 200, `opponent decline returns 200 (got ${declineRes.status})`);
    assert(declineRes.json.ok === true, 'decline is accepted');
    assert(declineRes.json.undoRequest === null, 'decline clears state.undoRequest');
    assert(plyOf(declineRes.json) === 2, 'decline leaves the board unchanged');

    // ---------------------------------------------------------------------
    // 5. Opponent consents: undo is performed, request cleared.
    // ---------------------------------------------------------------------
    console.log('\n=== Test Suite 5: opponent consents ===');
    await jsonPost(`/api/undo?room=${h2hRoom}`, {}, tokenB); // black requests
    const offerState = await request(`/api/state?room=${h2hRoom}`);
    assert(offerState.json.undoRequest === 'black', 'black now has the pending undo request');
    const acceptRes = await jsonPost(`/api/undo/respond?room=${h2hRoom}`, { consent: true }, tokenW);
    assert(acceptRes.status === 200, `opponent consent returns 200 (got ${acceptRes.status})`);
    assert(acceptRes.json.undone === true, 'consent performs the undo');
    assert(plyOf(acceptRes.json) === 1, 'consent removed exactly one ply');
    assert(acceptRes.json.undoRequest === null, 'consent clears state.undoRequest');

    // The alias endpoint must work identically.
    await move(h2hRoom, 'e7e5', tokenB);
    await jsonPost(`/api/undo?room=${h2hRoom}`, {}, tokenW);
    const aliasAccept = await jsonPost(`/api/undo/respond?room=${h2hRoom}`, { accept: true }, tokenB);
    assert(aliasAccept.status === 200 && aliasAccept.json.undone === true, 'accept:true alias on /api/undo/respond performs the undo');

    // ---------------------------------------------------------------------
    // 6. A move clears a stale pending request.
    // ---------------------------------------------------------------------
    console.log('\n=== Test Suite 6: a move clears the pending request ===');
    const moveRoom = 'g4-move-clear';
    await post(`/api/reset?room=${moveRoom}`);
    const mW = await claim(moveRoom, 'white');
    const mB = await claim(moveRoom, 'black');
    await move(moveRoom, 'e2e4', mW);
    await move(moveRoom, 'e7e5', mB);
    await jsonPost(`/api/undo?room=${moveRoom}`, {}, mW);
    const pendingBefore = await request(`/api/state?room=${moveRoom}`);
    assert(pendingBefore.json.undoRequest === 'white', 'pending request recorded before the move');
    await move(moveRoom, 'g1f3', mW);
    const pendingAfter = await request(`/api/state?room=${moveRoom}`);
    assert(pendingAfter.json.undoRequest === null, 'a move clears the stale undo request');
    assert(plyOf(pendingAfter.json) === 3, 'the move itself was applied');

    // A reset also clears it.
    await jsonPost(`/api/undo?room=${moveRoom}`, {}, mB);
    await post(`/api/reset?room=${moveRoom}`, mW);
    const afterReset = await request(`/api/state?room=${moveRoom}`);
    assert(afterReset.json.undoRequest === null, 'a reset clears any pending undo request');

    // ---------------------------------------------------------------------
    // 7. Bot game: undo stays unilateral even with a seat token.
    // ---------------------------------------------------------------------
    console.log('\n=== Test Suite 7: bot game undo stays unilateral ===');
    const botRoom = 'g4-bot';
    await post(`/api/reset?room=${botRoom}`);
    const botWToken = await claim(botRoom, 'white');
    await jsonPost(`/api/bot?room=${botRoom}`, { enabled: true, color: 'black', level: 1 });
    // One human (white) + one bot (black): not both-seats-human.
    await move(botRoom, 'e2e4', botWToken);
    const botUndo = await jsonPost(`/api/undo?room=${botRoom}`, {}, botWToken);
    assert(botUndo.status === 200, `bot game undo returns 200 (got ${botUndo.status})`);
    assert(botUndo.json.undone === true, 'bot game undo applies immediately (not a request)');
    assert(!botUndo.json.undoRequest, 'bot game undo creates no pending request');

    // ---------------------------------------------------------------------
    // 8. Crash recovery: a replayed journal must not resurrect a stale request
    //    or double-apply an undo.
    // ---------------------------------------------------------------------
    console.log('\n=== Test Suite 8: journal replay / crash recovery ===');
    const { RefereeService, readJournal } = require('../src/referee-service.js');
    const replayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-g4-replay-'));
    const sFile = path.join(replayDir, 'state.json');
    const jFile = path.join(replayDir, 'journal.jsonl');
    try {
      const r1 = new RefereeService({ roomId: 'replay', stateFile: sFile, journalFile: jFile });
      await r1.enqueue({ id: 'r1', type: 'move', args: { move: 'e2e4' } });
      await r1.enqueue({ id: 'r2', type: 'move', args: { move: 'e7e5' } });
      await r1.enqueue({ id: 'r3', type: 'undo', args: { action: 'request', color: 'white', bothSeatsHuman: true } });
      const r2 = new RefereeService({ roomId: 'replay', stateFile: sFile, journalFile: jFile });
      assert(plyOf(r2.state) === 2, 'replay keeps both plies after a request');
      assert(r2.state.undoRequest === 'white', 'replay restores the pending undo request');

      // A declined request replays as cleared (no board change).
      await r2.enqueue({ id: 'r4', type: 'undo', args: { action: 'respond', color: 'black', consent: false } });
      const r3 = new RefereeService({ roomId: 'replay', stateFile: sFile, journalFile: jFile });
      assert(plyOf(r3.state) === 2, 'replay of a decline leaves the board unchanged');
      assert(r3.state.undoRequest === null, 'replay of a decline clears the pending request');

      // A consented request replays as a single undo.
      await r3.enqueue({ id: 'r5', type: 'undo', args: { action: 'request', color: 'black', bothSeatsHuman: true } });
      await r3.enqueue({ id: 'r6', type: 'undo', args: { action: 'respond', color: 'white', consent: true } });
      const r4 = new RefereeService({ roomId: 'replay', stateFile: sFile, journalFile: jFile });
      assert(plyOf(r4.state) === 1, 'replay of a consent applies exactly one undo');
      assert(r4.state.undoRequest === null, 'replay of a consent clears the pending request');

      // A move after a request replays with the request cleared.
      await r4.enqueue({ id: 'r7', type: 'undo', args: { action: 'request', color: 'white', bothSeatsHuman: true } });
      await r4.enqueue({ id: 'r8', type: 'move', args: { move: 'e7e5' } });
      const r5 = new RefereeService({ roomId: 'replay', stateFile: sFile, journalFile: jFile });
      assert(plyOf(r5.state) === 2, 'replay applies the move after the request');
      assert(r5.state.undoRequest === null, 'replay of a move clears the stale request');
    } finally {
      try { fs.rmSync(replayDir, { recursive: true, force: true }); } catch (_) {}
    }

    // ---------------------------------------------------------------------
    // 9. A finished game rejects every undo action (gameOver guard).
    //    Regression: a dangling request could previously resurrect the board.
    // ---------------------------------------------------------------------
    console.log('\n=== Test Suite 9: a finished game rejects undo ===');

    // 9a. Draw by claim: a pending request must not survive the claim, and a
    //     later consent must be refused with 409 without touching the board.
    const claimRoom = 'g4-draw-claim';
    await post(`/api/reset?room=${claimRoom}`);
    const cW = await claim(claimRoom, 'white');
    const cB = await claim(claimRoom, 'black');
    // Knight shuffle twice brings the start position back a third time ->
    // threefold, exposed as claimable (not automatic).
    const shuffle = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
    for (let i = 0; i < shuffle.length; i++) {
      await move(claimRoom, shuffle[i], i % 2 === 0 ? cW : cB);
    }
    const claimable = await request(`/api/state?room=${claimRoom}`);
    assert(claimable.json.claimableDraw && claimable.json.claimableDraw.claimable === true, 'threefold position is claimable pre-claim');
    // White requests an undo, then the game ends by claim (black claims).
    await jsonPost(`/api/undo?room=${claimRoom}`, {}, cW);
    const pendingBeforeClaim = await request(`/api/state?room=${claimRoom}`);
    assert(pendingBeforeClaim.json.undoRequest === 'white', 'undo request pending before the draw claim');
    const claimRes = await jsonPost(`/api/undo?room=${claimRoom}`, {}, cW);
    assert(claimRes.json.undoRequest === 'white', 're-confirming the pending request changed nothing');
    const claimDraw = await jsonPost(`/api/draw/claim?room=${claimRoom}`, {}, cB);
    assert(claimDraw.status === 200 && claimDraw.json.gameOver === true, 'threefold draw claim ends the game');
    const afterClaimState = await request(`/api/state?room=${claimRoom}`);
    assert(afterClaimState.json.undoRequest === null, 'draw claim clears the pending undo request');
    const afterClaimPly = plyOf(afterClaimState.json);
    const claimConsent = await jsonPost(`/api/undo/respond?room=${claimRoom}`, { consent: true }, cB);
    assert(claimConsent.status === 409, `consent after a draw claim is 409 (got ${claimConsent.status})`);
    assert(claimConsent.json.error === 'game over', 'consent after a draw claim reports game over');
    const afterClaimConsent = await request(`/api/state?room=${claimRoom}`);
    assert(plyOf(afterClaimConsent.json) === afterClaimPly, 'consent after a draw claim does not change the board');
    assert(afterClaimConsent.json.gameOver === true && afterClaimConsent.json.draw === true, 'game stays drawn after the refused consent');

    // 9b. Resignation, then consent -> 409, board/result unchanged.
    const resignRoom = 'g4-resign';
    await post(`/api/reset?room=${resignRoom}`);
    const rW = await claim(resignRoom, 'white');
    const rB = await claim(resignRoom, 'black');
    await move(resignRoom, 'e2e4', rW);
    await move(resignRoom, 'e7e5', rB);
    await jsonPost(`/api/undo?room=${resignRoom}`, {}, rW);
    const resignRes = await jsonPost(`/api/resign?room=${resignRoom}`, { color: 'black' }, rB);
    assert(resignRes.status === 200 && resignRes.json.gameOver === true, 'black resigns');
    const resignResult = resignRes.json.result;
    const resignPly = plyOf(resignRes.json);
    const afterResignState = await request(`/api/state?room=${resignRoom}`);
    assert(afterResignState.json.undoRequest === null, 'resignation clears the pending undo request');
    const resignConsent = await jsonPost(`/api/undo/respond?room=${resignRoom}`, { consent: true }, rW);
    assert(resignConsent.status === 409, `consent after resignation is 409 (got ${resignConsent.status})`);
    assert(resignConsent.json.error === 'game over', 'consent after resignation reports game over');
    const afterResignConsent = await request(`/api/state?room=${resignRoom}`);
    assert(plyOf(afterResignConsent.json) === resignPly, 'consent after resignation does not change the board');
    assert(afterResignConsent.json.result === resignResult, 'consent after resignation does not change the result');

    // 9c. Timeout, then consent -> 409.
    const timeoutRoom = 'g4-timeout';
    await post(`/api/reset?room=${timeoutRoom}`);
    const tW = await claim(timeoutRoom, 'white');
    const tB = await claim(timeoutRoom, 'black');
    await move(timeoutRoom, 'e2e4', tW);
    await jsonPost(`/api/undo?room=${timeoutRoom}`, {}, tB);
    const { getReferee } = require('../src/referee-service.js');
    const tRef = getReferee(timeoutRoom);
    tRef.state.clocks.black = 0.5;
    tRef.state.moveStartTs = Date.now() - 2000;
    const flagRes = await request(`/api/flag?room=${timeoutRoom}`);
    assert(flagRes.json.ok === true && flagRes.json.flagged === true, 'black flags on time');
    const afterTimeoutState = await request(`/api/state?room=${timeoutRoom}`);
    assert(afterTimeoutState.json.undoRequest === null, 'timeout clears the pending undo request');
    const timeoutPly = plyOf(afterTimeoutState.json);
    const timeoutConsent = await jsonPost(`/api/undo/respond?room=${timeoutRoom}`, { consent: true }, tW);
    assert(timeoutConsent.status === 409, `consent after timeout is 409 (got ${timeoutConsent.status})`);
    assert(timeoutConsent.json.error === 'game over', 'consent after timeout reports game over');
    const afterTimeoutConsent = await request(`/api/state?room=${timeoutRoom}`);
    assert(plyOf(afterTimeoutConsent.json) === timeoutPly, 'consent after timeout does not change the board');

    // 9d. Post-game legacy unilateral POST /api/undo -> 409, no silent revive.
    const legacyRoom = 'g4-legacy-postgame';
    await post(`/api/reset?room=${legacyRoom}`);
    await move(legacyRoom, 'e2e4');
    await move(legacyRoom, 'e7e5');
    const legacyResign = await jsonPost(`/api/resign?room=${legacyRoom}`, { color: 'white' });
    assert(legacyResign.status === 200 && legacyResign.json.gameOver === true, 'solo game ended by resignation');
    const legacyPly = plyOf(legacyResign.json);
    const legacyUndo = await post(`/api/undo?room=${legacyRoom}`);
    assert(legacyUndo.status === 409, `post-game legacy /api/undo is 409 (got ${legacyUndo.status})`);
    assert(legacyUndo.json.error === 'game over', 'post-game legacy undo reports game over');
    const afterLegacy = await request(`/api/state?room=${legacyRoom}`);
    assert(plyOf(afterLegacy.json) === legacyPly, 'post-game legacy undo does not revive the board');
    assert(afterLegacy.json.gameOver === true, 'game stays over after the refused legacy undo');

    // 9e. Expiry-independent consent: an idle-expired seat still counts as a
    //     human occupant for this game, so undo keeps requiring consent.
    //     Force expiry directly on the seat record (the API offers no way to
    //     age a seat), then confirm the server-side predicate.
    const { seatAuthManager } = require('../server.js');
    const expiryRoom = 'g4-expiry';
    await post(`/api/reset?room=${expiryRoom}`);
    const eW = await claim(expiryRoom, 'white');
    const eB = await claim(expiryRoom, 'black');
    const seatRoom = seatAuthManager._getRoom(expiryRoom);
    const oldSeen = Date.now() - (300000 + 60000); // older than the 5-min idle timeout
    seatRoom.white.lastSeen = oldSeen;
    seatRoom.black.lastSeen = oldSeen;
    const accounts = seatAuthManager.getSeatAccounts(expiryRoom);
    assert(accounts.white.expired === true && accounts.black.expired === true, 'both seats report expired after forced idle');
    // Mirror server.js undoSeatsAreHuman: both seats exist and are non-bot.
    const bothSeatsHuman = !!(accounts.white && !accounts.white.isBot) && !!(accounts.black && !accounts.black.isBot);
    assert(bothSeatsHuman === true, 'bothSeatsHuman stays true for occupied human seats despite expiry');
    // End-to-end: an expired-but-occupied room still treats undo as a request.
    // validateMutation refreshes lastSeen only for a matching token, so send one.
    await move(expiryRoom, 'e2e4', eW);
    seatRoom.white.lastSeen = oldSeen;
    seatRoom.black.lastSeen = oldSeen;
    await move(expiryRoom, 'e7e5', eB);
    seatRoom.white.lastSeen = oldSeen;
    seatRoom.black.lastSeen = oldSeen;
    const expiryUndo = await jsonPost(`/api/undo?room=${expiryRoom}`, {}, eW);
    assert(expiryUndo.status === 200, `expired-seat undo request returns 200 (got ${expiryUndo.status})`);
    assert(expiryUndo.json.undone !== true, 'expired-seat human-vs-human undo does not apply unilaterally');
    assert(expiryUndo.json.undoRequest === 'white', 'expired-seat undo records a consent request');

    // 9f. Journal replay of a game-ending transition also drops the pending
    //     request, so crash recovery cannot restore one into a finished game.
    const replayRoom = 'g4-replay-end';
    const replayDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-g4-replay-end-'));
    const rsFile = path.join(replayDir2, 'state.json');
    const rjFile = path.join(replayDir2, 'journal.jsonl');
    try {
      const q1 = new RefereeService({ roomId: replayRoom, stateFile: rsFile, journalFile: rjFile });
      await q1.enqueue({ id: 'q1', type: 'move', args: { move: 'e2e4' } });
      await q1.enqueue({ id: 'q2', type: 'move', args: { move: 'e7e5' } });
      await q1.enqueue({ id: 'q3', type: 'undo', args: { action: 'request', color: 'white', bothSeatsHuman: true } });
      await q1.enqueue({ id: 'q4', type: 'resign', args: { color: 'black' } });
      const q2 = new RefereeService({ roomId: replayRoom, stateFile: rsFile, journalFile: rjFile });
      assert(q2.state.gameOver === true, 'replay restores the completed game');
      assert(q2.state.undoRequest === null, 'replay of a resignation drops the pending undo request');

      const replayRoomTc = 'g4-replay-timeout';
      const rsFile2 = path.join(replayDir2, 'state2.json');
      const rjFile2 = path.join(replayDir2, 'journal2.jsonl');
      const w1 = new RefereeService({ roomId: replayRoomTc, stateFile: rsFile2, journalFile: rjFile2 });
      await w1.enqueue({ id: 'w1', type: 'move', args: { move: 'e2e4' } });
      await w1.enqueue({ id: 'w2', type: 'undo', args: { action: 'request', color: 'black', bothSeatsHuman: true } });
      // A timeout is only journaled internally by checkFlagFall (not a command
      // type), so drive it directly.
      w1.state.clocks.black = 0.5;
      w1.state.moveStartTs = Date.now() - 2000;
      const flagged = w1.checkFlagFall();
      assert(flagged.flagged === true, 'forced flag fall journals a timeout');
      const w2 = new RefereeService({ roomId: replayRoomTc, stateFile: rsFile2, journalFile: rjFile2 });
      assert(w2.state.gameOver === true && w2.state.status === 'timeout', 'replay restores the timeout');
      assert(w2.state.undoRequest === null, 'replay of a timeout drops the pending undo request');
    } finally {
      try { fs.rmSync(replayDir2, { recursive: true, force: true }); } catch (_) {}
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  } finally {
    server.close();
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
