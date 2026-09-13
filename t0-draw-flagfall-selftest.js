#!/usr/bin/env node
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { RefereeService } = require('./referee-service.js');
const { createServer } = require('./server.js');

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

async function run() {
  console.log('=== Test Suite 1: RefereeService Draw Rules & Flag-Fall ===');

  const testDir = path.join(__dirname, '.test-t0-draw-flagfall');
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

  const stateFile = path.join(testDir, 'referee-state.json');
  const journalFile = path.join(testDir, 'referee-journal.jsonl');

  // Helper to create clean referee instance
  function createTestReferee(roomId = 'test-room') {
    const sFile = path.join(testDir, `referee-state-${roomId}.json`);
    const jFile = path.join(testDir, `referee-journal-${roomId}.jsonl`);
    try { fs.unlinkSync(sFile); } catch (_) {}
    try { fs.unlinkSync(jFile); } catch (_) {}
    return new RefereeService({ roomId, stateFile: sFile, journalFile: jFile });
  }

  // 1. Automatic threefold repetition on moves
  const ref1 = createTestReferee('threefold-room');
  // Knight shuffle 2 cycles (8 plies) brings the starting position 3 times:
  // 1. initial position
  // 2. after move 4 (f6g8)
  // 3. after move 8 (f6g8) -> threefold repetition!
  const shuffleMoves = [
    'g1f3', 'g8f6', 'f3g1', 'f6g8',
    'g1f3', 'g8f6', 'f3g1', 'f6g8'
  ];

  for (let i = 0; i < shuffleMoves.length; i++) {
    const res = await ref1.enqueue({ id: `move-${i}`, type: 'move', args: { move: shuffleMoves[i] } });
    if (i < shuffleMoves.length - 1) {
      assert(res.ok === true && !res.gameOver, `Move ${i + 1} (${shuffleMoves[i]}) applied normally`);
    } else {
      // 8th move completes threefold repetition
      assert(res.ok === true, '8th move applied');
      assert(res.gameOver === true, 'Automatic draw triggered on threefold repetition');
      assert(res.status === 'draw', 'Game status is draw');
      assert(res.drawReason === 'threefold', 'Draw reason is threefold');
      assert(res.result === '½-½', 'Result is ½-½');
    }
  }

  // 2. Claimable draw endpoint / action
  const ref2 = createTestReferee('claim-room');
  // Initial position: no claimable draw
  const falseClaim = await ref2.enqueue({ id: 'claim-1', type: 'draw', args: { action: 'claim' } });
  assert(falseClaim.ok === false, 'False draw claim rejected');
  assert(falseClaim.httpStatus === 400, 'Rejection returns 400');

  // Set position with 50-move rule claimable
  const fiftyFen = '8/5k2/8/8/8/8/5K2/8 w - - 100 50';
  ref2.state.board = require('./rules-engine.js').fenToBoard(fiftyFen);
  ref2.state.fen = fiftyFen;
  const validClaim = await ref2.enqueue({ id: 'claim-2', type: 'draw', args: { action: 'claim' } });
  assert(validClaim.ok === true, 'Valid 50-move draw claim succeeds');
  assert(validClaim.draw === true && validClaim.drawReason === 'fifty-move', 'Claimed reason is fifty-move');

  // 3. Draw Offer / Accept / Decline negotiation
  const ref3 = createTestReferee('offer-room');
  await ref3.enqueue({ id: 'move-e4', type: 'move', args: { move: 'e2e4' } });

  // White offers draw
  const offerRes = await ref3.enqueue({ id: 'offer-1', type: 'draw', args: { action: 'offer', color: 'white' } });
  assert(offerRes.ok === true, 'Draw offer recorded');
  assert(ref3.getState().drawOffer === 'white', 'State records drawOffer: white');

  // Black declines
  const declineRes = await ref3.enqueue({ id: 'decline-1', type: 'draw', args: { action: 'decline', color: 'black' } });
  assert(declineRes.ok === true, 'Draw decline processed');
  assert(ref3.getState().drawOffer === null, 'Draw offer cleared after decline');

  // Move clears draw offer
  await ref3.enqueue({ id: 'offer-2', type: 'draw', args: { action: 'offer', color: 'black' } });
  assert(ref3.getState().drawOffer === 'black', 'Black offered draw');
  await ref3.enqueue({ id: 'move-e5', type: 'move', args: { move: 'e7e5' } });
  assert(ref3.getState().drawOffer === null, 'Move clears pending draw offer');

  // Opponent accepts
  await ref3.enqueue({ id: 'offer-3', type: 'draw', args: { action: 'offer', color: 'white' } });
  const acceptRes = await ref3.enqueue({ id: 'accept-1', type: 'draw', args: { action: 'accept', color: 'black' } });
  assert(acceptRes.ok === true && acceptRes.gameOver === true, 'Opponent acceptance concludes game as draw');
  assert(acceptRes.drawReason === 'agreement', 'Draw reason is agreement');

  // 4. Flag-fall timeout detection
  const ref4 = createTestReferee('flag-room');
  const now = Date.now();
  await ref4.enqueue({ id: 'flag-e4', type: 'move', args: { move: 'e2e4', clientSentAt: now } });

  // Black is on the clock with 600s
  assert(ref4.getState().board.turn === 'black', 'Black is to move');
  assert(ref4.getState().gameOver === false, 'Game is ongoing');

  // Check flag-fall at t0 + 10s -> not flagged
  const check1 = ref4.checkFlagFall(now + 10000);
  assert(check1.flagged === false, 'Not flagged at 10 seconds');
  assert(ref4.getState().gameOver === false, 'Game still ongoing');

  // Check flag-fall at t0 + 601s -> FLAGGED!
  const check2 = ref4.checkFlagFall(now + 601000);
  assert(check2.flagged === true, 'Flag fall detected at 601 seconds');
  assert(check2.color === 'black', 'Black flagged');
  assert(ref4.getState().gameOver === true, 'Game marked gameOver');
  assert(ref4.getState().status === 'timeout', 'Status is timeout');
  assert(ref4.getState().flagged === 'black', 'Flagged player recorded as black');
  assert(ref4.getState().result === '1-0 on time', 'Result recorded as 1-0 on time');

  console.log('\n=== Test Suite 2: HTTP Integration Tests via Server ===');

  const server = createServer();
  const TEST_PORT = 39892;

  await new Promise(resolve => server.listen(TEST_PORT, '127.0.0.1', resolve));

  try {
    function request(path, options = {}) {
      return new Promise((resolve, reject) => {
        const req = http.request(`http://127.0.0.1:${TEST_PORT}${path}`, options, res => {
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

    const room = 'http-t0-test';

    // Reset room
    await request(`/api/reset?room=${room}`, { method: 'POST' });

    // Claim White and Black seats
    const cW = await request('/api/seat/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'white', room })
    });
    const cB = await request('/api/seat/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'black', room })
    });
    const tokenW = cW.json.token;
    const tokenB = cB.json.token;

    // Test /api/draw-claim endpoint when no draw condition exists
    const falseClaimRes = await request(`/api/draw-claim?room=${room}`, {
      method: 'POST',
      headers: { 'X-Seat-Token': tokenW }
    });
    assert(falseClaimRes.status === 400, `POST /api/draw-claim returns 400 when not claimable (got ${falseClaimRes.status})`);

    // Test /api/draw/offer
    const offerHttp = await request(`/api/draw/offer?room=${room}`, {
      method: 'POST',
      headers: { 'X-Seat-Token': tokenW }
    });
    assert(offerHttp.status === 200, 'POST /api/draw/offer succeeds 200');

    // Check state reflects offer
    const stateWithOffer = await request(`/api/state?room=${room}`);
    assert(stateWithOffer.json.drawOffer === 'white', 'State reflects drawOffer: white');

    // Test /api/draw/decline
    const declineHttp = await request(`/api/draw/decline?room=${room}`, {
      method: 'POST',
      headers: { 'X-Seat-Token': tokenB }
    });
    assert(declineHttp.status === 200, 'POST /api/draw/decline succeeds 200');

    const stateDeclined = await request(`/api/state?room=${room}`);
    assert(stateDeclined.json.drawOffer === null, 'Draw offer cleared after decline');

    // Test /api/draw/accept
    await request(`/api/draw/offer?room=${room}`, {
      method: 'POST',
      headers: { 'X-Seat-Token': tokenW }
    });
    const acceptHttp = await request(`/api/draw/accept?room=${room}`, {
      method: 'POST',
      headers: { 'X-Seat-Token': tokenB }
    });
    assert(acceptHttp.status === 200, 'POST /api/draw/accept succeeds 200');

    const stateAccepted = await request(`/api/state?room=${room}`);
    assert(stateAccepted.json.gameOver === true, 'Game is over after accept');
    assert(stateAccepted.json.status === 'draw', 'Game status is draw');
    assert(stateAccepted.json.drawReason === 'agreement', 'Draw reason is agreement');

    // Test /api/flag endpoint
    const flagRoom = 'http-flag-test';
    await request(`/api/reset?room=${flagRoom}`, { method: 'POST' });
    await request(`/api/move?room=${flagRoom}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ move: 'e2e4' })
    });

    // Before clock expiration
    const flagCheckNotYet = await request(`/api/flag?room=${flagRoom}`);
    assert(flagCheckNotYet.status === 200, 'GET /api/flag returns 200');
    assert(flagCheckNotYet.json.ok === false, 'Clock has not expired yet');

    // Fast-forward clock in referee to simulate timeout
    const refFlag = require('./referee-service.js').getReferee(flagRoom);
    refFlag.state.clocks.black = 0.5;
    refFlag.state.moveStartTs = Date.now() - 2000; // 2 seconds elapsed on 0.5s clock

    // Now call /api/flag
    const flagCheckExpired = await request(`/api/flag?room=${flagRoom}`);
    assert(flagCheckExpired.status === 200, 'GET /api/flag returns 200');
    assert(flagCheckExpired.json.ok === true && flagCheckExpired.json.flagged === true, 'Flag fall detected via /api/flag');
    assert(flagCheckExpired.json.color === 'black', 'Flagged player is black');

    // Verify GET /api/state reflects timeout
    const flagState = await request(`/api/state?room=${flagRoom}`);
    assert(flagState.json.gameOver === true, 'State reflects gameOver after flag fall');
    assert(flagState.json.status === 'timeout', 'State reflects status: timeout');
    assert(flagState.json.result === '1-0 on time', 'State reflects result: 1-0 on time');

  } finally {
    server.close();
    // Cleanup test directory
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
