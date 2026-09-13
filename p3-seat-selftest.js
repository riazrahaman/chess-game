#!/usr/bin/env node
'use strict';

const { SeatAuthManager } = require('./seat-auth.js');
const http = require('http');
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

    // Release white seat
    const relRes = await request('/api/seat/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: tokenW, room: 'testroom' })
    });
    assert(relRes.status === 200, 'POST /api/seat/release returns 200');

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
