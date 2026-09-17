#!/usr/bin/env node
/**
 * p3-multiroom-selftest.js
 *
 * Phase 3 Self-Test: Multi-Tenant Room Router and Management (/game/:id)
 *
 * Verifies:
 * 1. Serving /game/room-alpha and /game/room-beta with index.html.
 * 2. Independent moves in room-alpha and room-beta without state collision.
 * 3. SSE broadcast isolation between rooms.
 * 4. Backward compatibility of /api/* endpoints without room parameter (defaulting to 'default').
 * 5. Route header room resolution (x-room-id / room headers).
 * 6. Isolated state file persistence per room.
 * 7. Security: invalid room ID validation and dotfile protection.
 * 8. ui.js room detection and architectural invariants.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createServer, stopStateWatcher, readRoomStateJson, getRoomStateFile } = require('../server.js');
const referee = require('../src/referee-service.js');

const DIR = __dirname;
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

function httpGet(server, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'GET',
      path: urlPath,
      headers
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpPost(server, urlPath, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'POST',
      path: urlPath,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      }
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runTests() {
  console.log('--- Phase 3 Multi-Room Router Self-Test ---\n');

  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const testRooms = ['room-alpha', 'room-beta', 'room-gamma', 'room-sse-a', 'room-sse-b'];

  try {
    // Clean any leftover room files from previous runs
    for (const rId of testRooms) {
      referee.resetInstance(rId);
      const sf = getRoomStateFile(rId);
      const jf = referee.getRoomJournalFile(rId);
      try { fs.unlinkSync(sf); } catch (_) {}
      try { fs.unlinkSync(jf); } catch (_) {}
    }
    referee.resetInstance('default');

    // =========================================================================
    // 1. Dynamic room routing: /game/:roomId serves index.html
    // =========================================================================
    console.log('\n[1] Dynamic Room Routing (/game/:roomId)');

    const resAlpha = await httpGet(server, '/game/room-alpha');
    assert(resAlpha.status === 200, 'GET /game/room-alpha returns 200');
    assert(resAlpha.headers['content-type'] && resAlpha.headers['content-type'].includes('text/html'),
      'GET /game/room-alpha returns text/html content-type');
    assert(resAlpha.body.includes('Chess UI'), 'GET /game/room-alpha body contains index.html content');

    const resBeta = await httpGet(server, '/game/room-beta');
    assert(resBeta.status === 200, 'GET /game/room-beta returns 200');
    assert(resBeta.body.includes('Chess UI'), 'GET /game/room-beta body contains index.html content');

    const resTrailingSlash = await httpGet(server, '/game/room-alpha/');
    assert(resTrailingSlash.status === 200, 'GET /game/room-alpha/ (with trailing slash) returns 200');

    const resSubAsset = await httpGet(server, '/game/room-alpha/src/engine.js');
    assert(resSubAsset.status === 200, 'GET /game/room-alpha/src/engine.js serves engine.js asset');
    assert(resSubAsset.headers['content-type'] && resSubAsset.headers['content-type'].includes('javascript'),
      'engine.js has application/javascript content-type');

    const resNoRoom = await httpGet(server, '/game/');
    assert(resNoRoom.status === 404, 'GET /game/ without room returns 404');

    const resInvalidRoomRoute = await httpGet(server, '/game/invalid!room');
    assert(resInvalidRoomRoute.status === 404, 'GET /game/invalid!room returns 404');

    // =========================================================================
    // 2. Backward compatibility of /api/* endpoints without room parameter
    // =========================================================================
    console.log('\n[2] Backward Compatibility (No room param defaults to "default")');

    const resDefaultReset = await httpPost(server, '/api/reset', {});
    assert(resDefaultReset.status === 200, 'POST /api/reset (no room) returns 200');
    const defaultResetBody = JSON.parse(resDefaultReset.body);
    assert(defaultResetBody.ok === true && defaultResetBody.reset === true, 'Default room reset confirmed');

    const resDefaultState = await httpGet(server, '/api/state');
    assert(resDefaultState.status === 200, 'GET /api/state (no room) returns 200');
    const defaultState = JSON.parse(resDefaultState.body);
    assert(Array.isArray(defaultState.history) && defaultState.history.length === 0,
      'Default room has empty history after reset');
    assert(defaultState.board && defaultState.board.turn === 'white', 'Default room turn is white');

    const resDefaultMove = await httpPost(server, '/api/move', { move: 'c2c4' });
    assert(resDefaultMove.status === 200, 'POST /api/move (no room) returns 200');
    const defaultMoveBody = JSON.parse(resDefaultMove.body);
    assert(defaultMoveBody.ok === true && defaultMoveBody.applied === 'c2c4',
      'Move c2c4 applied in default room');

    const resDefaultStateAfter = await httpGet(server, '/api/state');
    const defaultStateAfter = JSON.parse(resDefaultStateAfter.body);
    assert(defaultStateAfter.history && defaultStateAfter.history[0] === 'c2c4',
      'GET /api/state reflects move c2c4 in default room');

    // =========================================================================
    // 3. Independent moves and multi-tenant isolation
    // =========================================================================
    console.log('\n[3] Multi-Tenant Room Isolation');

    // Reset room-alpha and room-beta
    const resetAlpha = await httpPost(server, '/api/reset?room=room-alpha', {});
    assert(resetAlpha.status === 200, 'POST /api/reset?room=room-alpha succeeds');

    const resetBeta = await httpPost(server, '/api/reset?room=room-beta', {});
    assert(resetBeta.status === 200, 'POST /api/reset?room=room-beta succeeds');

    // Move in room-alpha: e2e4
    const moveAlpha1 = await httpPost(server, '/api/move?room=room-alpha', { move: 'e2e4' });
    assert(moveAlpha1.status === 200, 'POST /api/move?room=room-alpha (e2e4) returns 200');
    const bodyAlpha1 = JSON.parse(moveAlpha1.body);
    assert(bodyAlpha1.ok === true && bodyAlpha1.applied === 'e2e4', 'Move e2e4 applied to room-alpha');

    // Verify room-alpha has e2e4 and turn is black
    const stateAlpha1 = JSON.parse((await httpGet(server, '/api/state?room=room-alpha')).body);
    assert(stateAlpha1.history && stateAlpha1.history.length === 1 && stateAlpha1.history[0] === 'e2e4',
      'room-alpha state has history [e2e4]');
    assert(stateAlpha1.board.turn === 'black', 'room-alpha board turn is black');

    // Verify room-beta is completely empty and turn is white
    const stateBeta0 = JSON.parse((await httpGet(server, '/api/state?room=room-beta')).body);
    assert(stateBeta0.history && stateBeta0.history.length === 0,
      'room-beta state is unpolluted by room-alpha (history length 0)');
    assert(stateBeta0.board.turn === 'white', 'room-beta board turn is white');

    // Move in room-beta: d2d4
    const moveBeta1 = await httpPost(server, '/api/move?room=room-beta', { move: 'd2d4' });
    assert(moveBeta1.status === 200, 'POST /api/move?room=room-beta (d2d4) returns 200');

    // Move in room-alpha: e7e5
    const moveAlpha2 = await httpPost(server, '/api/move?room=room-alpha', { move: 'e7e5' });
    assert(moveAlpha2.status === 200, 'POST /api/move?room=room-alpha (e7e5) returns 200');

    // Verify independent states
    const stateAlpha2 = JSON.parse((await httpGet(server, '/api/state?room=room-alpha')).body);
    const stateBeta1 = JSON.parse((await httpGet(server, '/api/state?room=room-beta')).body);

    assert(stateAlpha2.history.length === 2 && stateAlpha2.history[0] === 'e2e4' && stateAlpha2.history[1] === 'e7e5',
      'room-alpha state has 2 plies [e2e4, e7e5]');
    assert(stateBeta1.history.length === 1 && stateBeta1.history[0] === 'd2d4',
      'room-beta state has 1 ply [d2d4]');

    // Resign in room-beta
    const resignBeta = await httpPost(server, '/api/resign?w&room=room-beta', {});
    assert(resignBeta.status === 200, 'POST /api/resign?w&room=room-beta succeeds');
    const stateBetaResigned = JSON.parse((await httpGet(server, '/api/state?room=room-beta')).body);
    assert(stateBetaResigned.gameOver === true && stateBetaResigned.resigned === 'white',
      'room-beta is game over due to white resignation');

    // Verify room-alpha is still ongoing
    const stateAlphaStillOngoing = JSON.parse((await httpGet(server, '/api/state?room=room-alpha')).body);
    assert(stateAlphaStillOngoing.gameOver === false && stateAlphaStillOngoing.status === 'ongoing',
      'room-alpha remains ongoing after room-beta resignation');

    // Undo in room-alpha
    const undoAlpha = await httpPost(server, '/api/undo?room=room-alpha', {});
    assert(undoAlpha.status === 200, 'POST /api/undo?room=room-alpha succeeds');
    const stateAlphaAfterUndo = JSON.parse((await httpGet(server, '/api/state?room=room-alpha')).body);
    assert(stateAlphaAfterUndo.history.length === 1 && stateAlphaAfterUndo.history[0] === 'e2e4',
      'room-alpha undo pops e7e5, leaving [e2e4]');

    // Check persistence files exist per room
    const alphaStateFile = getRoomStateFile('room-alpha');
    const betaStateFile = getRoomStateFile('room-beta');
    assert(fs.existsSync(alphaStateFile), `State file ${path.basename(alphaStateFile)} exists on disk`);
    assert(fs.existsSync(betaStateFile), `State file ${path.basename(betaStateFile)} exists on disk`);

    const alphaFileContent = JSON.parse(fs.readFileSync(alphaStateFile, 'utf8'));
    assert(alphaFileContent.history[0] === 'e2e4', 'alpha state file contains e2e4');

    // =========================================================================
    // 4. Route header room resolution (x-room-id / room)
    // =========================================================================
    console.log('\n[4] Route Header Room Resolution');

    // Use x-room-id header
    const resHeaderX = await httpGet(server, '/api/state', { 'x-room-id': 'room-alpha' });
    assert(resHeaderX.status === 200, 'GET /api/state with x-room-id header returns 200');
    const headerStateX = JSON.parse(resHeaderX.body);
    assert(headerStateX.history && headerStateX.history[0] === 'e2e4',
      'x-room-id header resolved room-alpha state');

    // Use room header
    const resHeaderRoom = await httpGet(server, '/api/state', { 'room': 'room-beta' });
    assert(resHeaderRoom.status === 200, 'GET /api/state with room header returns 200');
    const headerStateRoom = JSON.parse(resHeaderRoom.body);
    assert(headerStateRoom.resigned === 'white', 'room header resolved room-beta state');

    // =========================================================================
    // 5. SSE Isolation between rooms
    // =========================================================================
    console.log('\n[5] SSE Broadcast Isolation Between Rooms');

    // Reset SSE test rooms
    await httpPost(server, '/api/reset?room=room-sse-a', {});
    await httpPost(server, '/api/reset?room=room-sse-b', {});

    let sseBufA = '';
    let sseBufB = '';

    const reqA = http.request({
      host: '127.0.0.1', port, method: 'GET', path: '/api/events?room=room-sse-a'
    }, (res) => {
      res.on('data', chunk => { sseBufA += chunk.toString(); });
    });
    reqA.end();

    const reqB = http.request({
      host: '127.0.0.1', port, method: 'GET', path: '/api/events?room=room-sse-b'
    }, (res) => {
      res.on('data', chunk => { sseBufB += chunk.toString(); });
    });
    reqB.end();

    // Wait for initial SSE connections
    await sleep(250);
    assert(sseBufA.includes('event: state'), 'SSE client A connected and received initial state');
    assert(sseBufB.includes('event: state'), 'SSE client B connected and received initial state');

    // Clear buffers before testing cross-talk
    sseBufA = '';
    sseBufB = '';

    // POST move to room-sse-a: e2e4
    await httpPost(server, '/api/move?room=room-sse-a', { move: 'e2e4' });
    await sleep(300);

    assert(sseBufA.includes('e2e4'), 'SSE client A received state update with e2e4');
    assert(!sseBufB.includes('e2e4'), 'SSE client B NEVER received e2e4 (SSE isolation confirmed)');

    // Clear buffers and POST move to room-sse-b: g1f3
    sseBufA = '';
    sseBufB = '';

    await httpPost(server, '/api/move?room=room-sse-b', { move: 'g1f3' });
    await sleep(300);

    assert(sseBufB.includes('g1f3'), 'SSE client B received state update with g1f3');
    assert(!sseBufA.includes('g1f3'), 'SSE client A NEVER received g1f3 (SSE isolation confirmed)');

    reqA.destroy();
    reqB.destroy();

    // =========================================================================
    // 6. Security: Invalid room ID rejection & dotfile blocking
    // =========================================================================
    console.log('\n[6] Security & Validation');

    const resBadRoom = await httpGet(server, '/api/state?room=../evil');
    assert(resBadRoom.status === 400, 'GET /api/state?room=../evil rejected with 400');
    const badRoomJson = JSON.parse(resBadRoom.body);
    assert(badRoomJson.error === 'invalid room id', 'Error message is "invalid room id"');

    const resDotfileBlocked = await httpGet(server, '/.referee-state-room-alpha.json');
    assert(resDotfileBlocked.status === 403, 'GET /.referee-state-room-alpha.json rejected with 403 (dotfile protected)');

    // =========================================================================
    // 7. Frontend ui.js room integration & architectural invariant
    // =========================================================================
    console.log('\n[7] Frontend ui.js Room Integration & Invariants');

    const uiSource = fs.readFileSync(path.join(DIR, '..', 'src', 'ui.js'), 'utf8');

    // Architectural invariant verification
    assert(!uiSource.includes('makeMove('), 'ARCHITECTURAL INVARIANT: ui.js does not contain makeMove(');
    assert(!uiSource.includes('createInitialBoard('), 'ARCHITECTURAL INVARIANT: ui.js does not contain createInitialBoard(');

    // Verify room detection in in-memory VM context
    const mockWindow = {
      location: {
        pathname: '/game/tournament-room-42',
        search: '',
        origin: 'http://localhost:39281'
      },
      addEventListener: () => {}
    };
    const mockDocument = {
      getElementById: () => null,
      querySelectorAll: () => []
    };
    const context = {
      window: mockWindow,
      document: mockDocument,
      navigator: {},
      setTimeout: () => {},
      clearTimeout: () => {},
      setInterval: () => {},
      clearInterval: () => {},
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
      EventSource: function() { this.addEventListener = () => {}; }
    };
    vm.createContext(context);
    vm.runInContext(uiSource, context);

    assert(typeof context.window.getCurrentRoomId === 'function', 'ui.js exports getCurrentRoomId');
    assert(context.window.getCurrentRoomId() === 'tournament-room-42',
      'getCurrentRoomId extracts "tournament-room-42" from /game/tournament-room-42');

    assert(context.window.withRoomParam('/api/move') === '/api/move?room=tournament-room-42',
      'withRoomParam appends ?room=tournament-room-42 to /api/move');
    assert(context.window.withRoomParam('/api/resign?w') === '/api/resign?w&room=tournament-room-42',
      'withRoomParam appends &room=tournament-room-42 to /api/resign?w');

    // Test fallback to 'default'
    mockWindow.location.pathname = '/';
    assert(context.window.getCurrentRoomId() === 'default',
      'getCurrentRoomId returns "default" when pathname is "/"');

    // =========================================================================
    // Cleanup
    // =========================================================================
    for (const rId of testRooms) {
      referee.resetInstance(rId);
      const sf = getRoomStateFile(rId);
      const jf = referee.getRoomJournalFile(rId);
      try { fs.unlinkSync(sf); } catch (_) {}
      try { fs.unlinkSync(jf); } catch (_) {}
    }
    referee.resetInstance('default');

  } finally {
    await new Promise(r => server.close(r));
    stopStateWatcher();
  }

  console.log('\n--- Phase 3 Self-Test Summary ---');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    console.error(`\nFAILED: ${failed} tests failed.`);
    process.exit(1);
  } else {
    console.log('\nAll Phase 3 multi-room self-tests PASSED successfully!');
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Unhandled test failure:', err);
  process.exit(1);
});
