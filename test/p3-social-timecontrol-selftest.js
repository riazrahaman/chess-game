/**
 * p3-social-timecontrol-selftest.js
 * Verification suite for Batch 2: Matchgrade Social, Custom Time Controls, Rematch Flow & Chat.
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// B7: keep referee snapshot/journal files out of the repo root. referee-service
// derives every per-room ".referee-{state,journal}-<room>" path from the
// directory of CHESS_STATE_FILE / CHESS_JOURNAL_FILE at call time, so pointing
// them at a fresh os.tmpdir() folder (set BEFORE server.js is required) makes
// the whole run hermetic; the folder is removed on exit (process.exit-safe).
const B7_TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-p3-social-'));
process.env.CHESS_STATE_FILE = path.join(B7_TMP_DIR, '.referee-state.json');
process.env.CHESS_JOURNAL_FILE = path.join(B7_TMP_DIR, '.referee-journal.jsonl');
process.on('exit', () => { try { fs.rmSync(B7_TMP_DIR, { recursive: true, force: true }); } catch (_) {} });
const { createServer } = require('../server.js');
const { seatAuthManager } = require('../src/seat-auth.js');
const referee = require('../src/referee-service.js');

let server;
let baseUrl;
let port;

function request(endpoint, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, baseUrl);
    const headers = options.headers || {};
    const method = options.method || 'GET';
    const postData = options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : null;

    if (postData && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    if (postData && !headers['Content-Length']) {
      headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function runTests() {
  console.log('=== Starting p3-social-timecontrol-selftest.js ===');

  // Test 1: Gate 4 Invariant: ui.js contains 0 literal makeMove( or createInitialBoard(
  const uiContent = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui.js'), 'utf8');
  assert(!uiContent.includes('makeMove('), 'Gate 4 violation: ui.js contains literal makeMove(');
  assert(!uiContent.includes('createInitialBoard('), 'Gate 4 violation: ui.js contains literal createInitialBoard(');
  console.log('✔ Passed: Gate 4 invariants verified in ui.js');

  // Test 2: UI elements existence in index.html
  const htmlContent = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert(htmlContent.includes('id="time-control-select"'), 'index.html must contain #time-control-select');
  assert(htmlContent.includes('id="spectator-badge"'), 'index.html must contain #spectator-badge');
  assert(htmlContent.includes('id="rematch-btn"'), 'index.html must contain #rematch-btn');
  assert(htmlContent.includes('id="chat-panel"'), 'index.html must contain #chat-panel');
  assert(htmlContent.includes('id="chat-messages"'), 'index.html must contain #chat-messages');
  assert(htmlContent.includes('id="chat-input"'), 'index.html must contain #chat-input');
  assert(htmlContent.includes('id="chat-send-btn"'), 'index.html must contain #chat-send-btn');
  console.log('✔ Passed: All required social and time-control UI elements found in index.html');

  // Start server on ephemeral port
  server = createServer();
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  const room = 'social-test-' + Date.now();

  // Test 3: GET /api/time-control returns default time control
  const getTcRes = await request(`/api/time-control?room=${room}`);
  assert.strictEqual(getTcRes.status, 200);
  assert(getTcRes.json.ok, 'GET /api/time-control ok');
  assert(getTcRes.json.timeControl, 'Default time control returned');
  console.log('✔ Passed: GET /api/time-control returned default time control');

  // Test 4: POST /api/time-control unseated changes time control and clocks
  const setTcRes = await request(`/api/time-control?room=${room}`, {
    method: 'POST',
    body: { preset: 'blitz_3_2' }
  });
  assert.strictEqual(setTcRes.status, 200);
  assert(setTcRes.json.ok, 'Set time control returned ok');
  assert.strictEqual(setTcRes.json.timeControl.preset, 'blitz_3_2');
  assert.strictEqual(setTcRes.json.timeControl.baseSeconds, 180);
  assert.strictEqual(setTcRes.json.timeControl.incrementSeconds, 2);
  assert.strictEqual(setTcRes.json.clocks.white, 180);
  assert.strictEqual(setTcRes.json.clocks.black, 180);
  console.log('✔ Passed: POST /api/time-control set blitz_3_2 preset and reset clocks');

  // Test 5: Seat authorization on POST /api/time-control
  const claimW = await request('/api/seat/claim', {
    method: 'POST',
    body: { room, role: 'white' }
  });
  assert.strictEqual(claimW.status, 200);
  const whiteToken = claimW.json.token;

  // Unauthenticated user should be rejected (401)
  const unauthTcRes = await request(`/api/time-control?room=${room}`, {
    method: 'POST',
    body: { preset: 'bullet_1_0' }
  });
  assert.strictEqual(unauthTcRes.status, 401, 'Unauthenticated time-control update rejected in seated room');

  // Seated player with token succeeds
  const authTcRes = await request(`/api/time-control?room=${room}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${whiteToken}` },
    body: { preset: 'bullet_1_0' }
  });
  assert.strictEqual(authTcRes.status, 200);
  assert.strictEqual(authTcRes.json.timeControl.preset, 'bullet_1_0');
  assert.strictEqual(authTcRes.json.clocks.white, 60);
  console.log('✔ Passed: Seat authorization enforced on POST /api/time-control');

  // Test 6: Custom time control
  const customTcRes = await request(`/api/time-control?room=${room}`, {
    method: 'POST',
    headers: { 'X-Seat-Token': whiteToken },
    body: { baseSeconds: 420, incrementSeconds: 7 }
  });
  assert.strictEqual(customTcRes.status, 200);
  assert.strictEqual(customTcRes.json.timeControl.preset, 'custom');
  assert.strictEqual(customTcRes.json.timeControl.baseSeconds, 420);
  assert.strictEqual(customTcRes.json.timeControl.incrementSeconds, 7);
  console.log('✔ Passed: Custom time control configured successfully');

  // Test 7: Chat API (POST and GET)
  const chatPostRes = await request(`/api/chat?room=${room}`, {
    method: 'POST',
    body: { sender: 'White', text: 'Good luck, have fun!' }
  });
  assert.strictEqual(chatPostRes.status, 201);
  assert(chatPostRes.json.ok);
  assert.strictEqual(chatPostRes.json.message.sender, 'White');
  assert.strictEqual(chatPostRes.json.message.text, 'Good luck, have fun!');

  const chatGetRes = await request(`/api/chat?room=${room}`);
  assert.strictEqual(chatGetRes.status, 200);
  assert.strictEqual(chatGetRes.json.messages.length, 1);
  assert.strictEqual(chatGetRes.json.messages[0].text, 'Good luck, have fun!');
  console.log('✔ Passed: Chat API POST and GET work as expected');

  // Test 8: Empty / invalid chat rejection
  const badChatRes = await request(`/api/chat?room=${room}`, {
    method: 'POST',
    body: { sender: 'White', text: '   ' }
  });
  assert.strictEqual(badChatRes.status, 400);
  console.log('✔ Passed: Empty chat messages rejected with 400');

  // Test 9: Rematch Flow (Offer -> Decline -> Offer -> Accept)
  // Claim black seat
  const claimB = await request('/api/seat/claim', {
    method: 'POST',
    body: { room, role: 'black' }
  });
  assert.strictEqual(claimB.status, 200);
  const blackToken = claimB.json.token;

  // Resign to end the game so rematch makes sense
  const resignRes = await request(`/api/resign?room=${room}&color=white`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${whiteToken}` }
  });
  assert.strictEqual(resignRes.status, 200);

  // White offers rematch
  const offerRes = await request(`/api/rematch/offer?room=${room}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${whiteToken}` }
  });
  assert.strictEqual(offerRes.status, 200);
  assert.strictEqual(offerRes.json.action, 'offer');
  assert.strictEqual(offerRes.json.rematchOffer, 'white');

  // Black declines
  const declineRes = await request(`/api/rematch/decline?room=${room}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${blackToken}` }
  });
  assert.strictEqual(declineRes.status, 200);
  assert.strictEqual(declineRes.json.rematchOffer, null);

  // Black offers rematch
  const offerRes2 = await request(`/api/rematch/offer?room=${room}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${blackToken}` }
  });
  assert.strictEqual(offerRes2.status, 200);
  assert.strictEqual(offerRes2.json.rematchOffer, 'black');

  // White accepts rematch
  const acceptRes = await request(`/api/rematch/accept?room=${room}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${whiteToken}` }
  });
  assert.strictEqual(acceptRes.status, 200);
  assert(acceptRes.json.reset, 'Rematch reset board to new game');

  // Verify referee state is reset
  const stateRes = await request(`/api/state?room=${room}`);
  assert.strictEqual(stateRes.status, 200);
  assert.strictEqual(stateRes.json.gameOver, false);
  assert.strictEqual(stateRes.json.history.length, 0);
  console.log('✔ Passed: Full rematch lifecycle (offer, decline, offer, accept) verified');

  // Test 10: Spectator badge status check
  const spectatorClaim = await request('/api/seat/claim', {
    method: 'POST',
    body: { room, role: 'spectator' }
  });
  assert.strictEqual(spectatorClaim.status, 200);

  const seatStatus = await request(`/api/seat/status?room=${room}`);
  assert.strictEqual(seatStatus.status, 200);
  assert.strictEqual(seatStatus.json.spectatorsCount, 1);
  console.log('✔ Passed: Spectator badge reflects active spectator count');

  console.log('\nAll 10 tests passed successfully!');
  server.close();
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test failure:', err);
  if (server) server.close();
  process.exit(1);
});
