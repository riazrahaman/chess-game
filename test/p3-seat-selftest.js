#!/usr/bin/env node
'use strict';

const { SeatAuthManager } = require('../src/seat-auth.js');
const http = require('http');
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

async function main() {
  console.log('=== Test Suite 1: Unit Tests for SeatAuthManager ===');

  const mgr = new SeatAuthManager();

  // 1. Initial status
  let status = mgr.getStatus('room1');
  assert(status.whiteOccupied === false, 'Room1 white seat initially free');
  assert(status.blackOccupied === false, 'Room1 black seat initially free');

  // 2. Claim white seat
  const whiteClaim = mgr.claimSeat('room1', 'white');
  assert(whiteClaim.ok === true, 'White seat claimed successfully');
  assert(typeof whiteClaim.token === 'string' && whiteClaim.token.length > 20, 'White received valid cryptographic token');
  assert(whiteClaim.role === 'white', 'Role is white');

  // 3. Reject duplicate claim on occupied seat
  const dupWhite = mgr.claimSeat('room1', 'white');
  assert(dupWhite.ok === false, 'Duplicate white seat claim rejected');
  assert(dupWhite.status === 409, `Rejection status is 409 Conflict (got ${dupWhite.status})`);

  // 4. Claim black seat
  const blackClaim = mgr.claimSeat('room1', 'black');
  assert(blackClaim.ok === true, 'Black seat claimed successfully');

  // 5. Spectator claim
  const specClaim = mgr.claimSeat('room1', 'spectator');
  assert(specClaim.ok === true, 'Spectator claimed successfully');
  assert(specClaim.role === 'spectator', 'Role is spectator');

  status = mgr.getStatus('room1');
  assert(status.whiteOccupied === true, 'Status shows white occupied');
  assert(status.blackOccupied === true, 'Status shows black occupied');
  assert(status.spectatorsCount === 1, 'Status shows 1 spectator');

  // 6. Move validation
  // White's turn with white token -> allowed
  const valWhite = mgr.validateMove('room1', whiteClaim.token, 'white');
  assert(valWhite.ok === true, 'White token allowed to move on white turn');

  // White's turn with black token -> rejected 403
  const valBlackOnWhite = mgr.validateMove('room1', blackClaim.token, 'white');
  assert(valBlackOnWhite.ok === false, 'Black token rejected on white turn');
  assert(valBlackOnWhite.status === 403, `Got 403 forbidden (got ${valBlackOnWhite.status})`);

  // White's turn with spectator token -> rejected 403
  const valSpec = mgr.validateMove('room1', specClaim.token, 'white');
  assert(valSpec.ok === false, 'Spectator token rejected from moving');

  // White's turn with no token -> rejected 401
  const valNoToken = mgr.validateMove('room1', null, 'white');
  assert(valNoToken.ok === false, 'Missing token rejected when seat is occupied');
  assert(valNoToken.status === 401, `Got 401 unauthorized (got ${valNoToken.status})`);

  // 7. Backward compatibility on unseated room
  const valUnseated = mgr.validateMove('empty-room', null, 'white');
  assert(valUnseated.ok === true, 'Move allowed when no seats claimed (backward compatibility)');
  assert(valUnseated.unseated === true, 'Marked as unseated');

  // 8. Heartbeat & Release
  const hb = mgr.heartbeat('room1', whiteClaim.token);
  assert(hb.ok === true, 'Heartbeat succeeded for white seat');

  const rel = mgr.releaseSeat('room1', whiteClaim.token);
  assert(rel.ok === true, 'White seat released successfully');

  // Now white seat can be claimed again
  const reclaim = mgr.claimSeat('room1', 'white');
  assert(reclaim.ok === true, 'White seat successfully reclaimed after release');

  // 9. Bot seat claim and unseated mutation allowance
  const botClaim = mgr.claimSeat('botroom', 'black', { isBot: true });
  assert(botClaim.ok === true, 'Bot seat claimed successfully with isBot: true');
  const botRoomMutation = mgr.validateMutation('botroom', null);
  assert(botRoomMutation.ok === true && botRoomMutation.unseated === true, 'Unseated player allowed to mutate/reset when only bot is seated');

  console.log('\n=== Test Suite 2: HTTP Integration Tests via Server ===');

  const server = createServer();
  const TEST_PORT = 39891;

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

    // Reset game state
    await request('/api/reset', { method: 'POST' });

    // Test GET /api/seat/status
    const stRes = await request('/api/seat/status?room=testroom');
    assert(stRes.status === 200, 'GET /api/seat/status returns 200');
    assert(stRes.json.whiteOccupied === false, 'Initially white seat is free');

    // Claim white seat via API
    const claimRes = await request('/api/seat/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'white', room: 'testroom' })
    });
    assert(claimRes.status === 200, 'POST /api/seat/claim returns 200');
    assert(typeof claimRes.json.token === 'string', 'Received seat token');
    const tokenW = claimRes.json.token;

    // Second claim on white seat returns 409 Conflict
    const conflictRes = await request('/api/seat/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'white', room: 'testroom' })
    });
    assert(conflictRes.status === 409, 'Duplicate claim returns 409 Conflict');

    // Test move rejection with wrong token
    const wrongMoveRes = await request('/api/move?room=testroom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Seat-Token': 'bogus-token-123' },
      body: JSON.stringify({ move: 'e2e4' })
    });
    assert(wrongMoveRes.status === 403, `Move with invalid seat token rejected 403 (got ${wrongMoveRes.status})`);

    // Test move acceptance with valid token
    const validMoveRes = await request('/api/move?room=testroom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Seat-Token': tokenW },
      body: JSON.stringify({ move: 'e2e4' })
    });
    assert(validMoveRes.status === 200, `Move with valid seat token accepted 200 (got ${validMoveRes.status})`);

    // --- T0.2 & T0.3 Mutation & Heartbeat Tests ---
    console.log('\n--- T0.2 & T0.3 Mutation & Heartbeat Tests ---');

    // 1. Observer without token cannot reset seated room
    const obsReset = await request('/api/reset?room=testroom', { method: 'POST' });
    assert(obsReset.status === 401, `Observer cannot reset seated room (expected 401, got ${obsReset.status})`);

    // 2. Observer with invalid token cannot reset seated room
    const badReset = await request('/api/reset?room=testroom', {
      method: 'POST',
      headers: { 'X-Seat-Token': 'bogus-token' }
    });
    assert(badReset.status === 403, `Bogus token cannot reset seated room (expected 403, got ${badReset.status})`);

    // 3. Spectator cannot mutate seated room
    const specClaimRes = await request('/api/seat/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'spectator', room: 'testroom' })
    });
    const tokenSpec = specClaimRes.json.token;
    const specUndo = await request('/api/undo?room=testroom', {
      method: 'POST',
      headers: { 'X-Seat-Token': tokenSpec }
    });
    assert(specUndo.status === 403, `Spectator cannot undo in seated room (expected 403, got ${specUndo.status})`);

    // 4. Seated White player CAN undo
    const whiteUndo = await request('/api/undo?room=testroom', {
      method: 'POST',
      headers: { 'X-Seat-Token': tokenW }
    });
    assert(whiteUndo.status === 200, `Seated player can undo in seated room (expected 200, got ${whiteUndo.status})`);

    // 5. Seated White player cannot resign as black
    const whiteResignBlack = await request('/api/resign?color=black&room=testroom', {
      method: 'POST',
      headers: { 'X-Seat-Token': tokenW }
    });
    assert(whiteResignBlack.status === 403, `White cannot resign as black (expected 403, got ${whiteResignBlack.status})`);

    // 6. Seated White player CAN offer/accept draw
    const whiteDraw = await request('/api/draw?room=testroom', {
      method: 'POST',
      headers: { 'X-Seat-Token': tokenW }
    });
    assert(whiteDraw.status === 200, `Seated player can draw in seated room (expected 200, got ${whiteDraw.status})`);

    // 7. Heartbeat keeps seat alive
    const hbRes = await request('/api/seat/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: 'testroom', token: tokenW })
    });
    assert(hbRes.status === 200, `Heartbeat succeeds for active seat (got ${hbRes.status})`);

    // 8. Seated White player CAN reset room
    const whiteReset = await request('/api/reset?room=testroom', {
      method: 'POST',
      headers: { 'X-Seat-Token': tokenW }
    });
    assert(whiteReset.status === 200, `Seated player can reset seated room (expected 200, got ${whiteReset.status})`);

    // Release white seat
    const relRes = await request('/api/seat/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: tokenW, room: 'testroom' })
    });
    assert(relRes.status === 200, 'POST /api/seat/release returns 200');

    // 9. After release (unseated), anyone can reset (backward compatibility)
    const unseatedReset = await request('/api/reset?room=testroom', { method: 'POST' });
    assert(unseatedReset.status === 200, `Unseated room permits reset without token (backward compatibility, got ${unseatedReset.status})`);

    // 10. Room with autonomous bot allows reset without token
    await request('/api/bot?room=botroom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, level: 3, color: 'black' })
    });
    const botReset = await request('/api/reset?room=botroom', { method: 'POST' });
    assert(botReset.status === 200, `Room with active bot permits reset without token (got ${botReset.status})`);

  } finally {
    server.close();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
