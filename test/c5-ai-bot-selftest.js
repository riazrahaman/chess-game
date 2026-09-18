/**
 * c5-ai-bot-selftest.js
 * Comprehensive test suite for C5: Play vs Computer (Levels 1–8 AI Opponent Bot)
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
const B7_TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-c5-bot-'));
process.env.CHESS_STATE_FILE = path.join(B7_TMP_DIR, '.referee-state.json');
process.env.CHESS_JOURNAL_FILE = path.join(B7_TMP_DIR, '.referee-journal.jsonl');
process.on('exit', () => { try { fs.rmSync(B7_TMP_DIR, { recursive: true, force: true }); } catch (_) {} });
const { createServer, botService, BOT_LEVELS } = require('../server.js');
const referee = require('../src/referee-service.js');
const engineServer = require('../src/engine-server.js');

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
  console.log('=== Starting c5-ai-bot-selftest.js ===');

  // Test 1: Gate 4 Invariant: ui.js contains 0 literal makeMove( or createInitialBoard(
  const uiContent = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui.js'), 'utf8');
  assert(!uiContent.includes('makeMove('), 'Gate 4 violation: ui.js contains literal makeMove(');
  assert(!uiContent.includes('createInitialBoard('), 'Gate 4 violation: ui.js contains literal createInitialBoard(');
  console.log('✔ Passed: Gate 4 invariants verified in ui.js');

  // Test 2: HTML UI controls exist in index.html
  const htmlContent = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert(htmlContent.includes('id="vs-computer-bar"'), 'index.html must contain #vs-computer-bar');
  assert(htmlContent.includes('id="bot-toggle"'), 'index.html must contain #bot-toggle');
  assert(htmlContent.includes('id="bot-level-select"'), 'index.html must contain #bot-level-select');
  assert(htmlContent.includes('id="bot-color-select"'), 'index.html must contain #bot-color-select');
  assert(htmlContent.includes('id="bot-status-badge"'), 'index.html must contain #bot-status-badge');
  console.log('✔ Passed: All Play vs Computer UI elements verified in index.html');

  // Test 3: Bot Levels (E1b/E2: real-engine ladder, Skill Level for L1-L3,
  // UCI_Elo 1320-3190 for L4-L8, every level capped by depth or movetime).
  assert.strictEqual(Object.keys(BOT_LEVELS).length, 8, '8 distinct bot levels must exist');
  for (let lvl = 1; lvl <= 8; lvl++) {
    const profile = BOT_LEVELS[lvl];
    assert(profile.name, `Level ${lvl} has a name`);
    assert(profile.rating >= 800 && profile.rating <= 2300, `Level ${lvl} rating within the ~800-2300 engine band (E2)`);
    assert(typeof profile.greeting === 'string', `Level ${lvl} has flavor greeting`);
    const hasSkill = profile.skill !== null;
    const hasElo = profile.elo !== null;
    assert(hasSkill !== hasElo, `Level ${lvl} uses exactly one of Skill Level / UCI_Elo`);
    if (hasSkill) assert(profile.skill >= 0 && profile.skill <= 20, `Level ${lvl} Skill Level 0-20`);
    if (hasElo) assert(profile.elo >= engineServer.UCI_ELO_MIN && profile.elo <= engineServer.UCI_ELO_MAX, `Level ${lvl} UCI_Elo in Stockfish range`);
    assert(profile.depth !== null || profile.movetime !== null, `Level ${lvl} has a depth or movetime cap`);
    if (profile.movetime !== null) assert(profile.movetime <= 800, `Level ${lvl} movetime <= 800ms keeps the server responsive`);
    if (lvl >= 3) assert.strictEqual(profile.blunderRate, 0, `Level ${lvl} has no forced blunders`);
    if (lvl >= 5) assert.strictEqual(profile.useBook, false, `Level ${lvl} plays the engine move, not the illustrative book`);
    if (lvl >= 2) assert(profile.rating > BOT_LEVELS[lvl - 1].rating, `Level ${lvl} rating increases monotonically`);
  }
  assert(engineServer.isAvailable(), 'vendored Stockfish 19 lite is available to the server');
  console.log('✔ Passed: All 8 bot profiles validated against the real-engine ladder');

  // Test 4: Bot move generation across levels (async: engine runs in a worker thread)
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  for (let lvl = 1; lvl <= 8; lvl++) {
    const move = await botService.computeBotMove(startFen, lvl);
    assert(typeof move === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move), `Bot level ${lvl} produces legal UCI move: ${move}`);
  }
  console.log('✔ Passed: Bot move generation verified across all levels 1–8');

  // Start HTTP server on ephemeral port
  server = createServer();
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  const room = 'bot-test-' + Date.now();

  // Test 5: GET /api/bot initially returns disabled bot
  const getBotRes = await request(`/api/bot?room=${room}`);
  assert.strictEqual(getBotRes.status, 200);
  assert(getBotRes.json.ok);
  assert.strictEqual(getBotRes.json.bot.enabled, false);
  assert(getBotRes.json.levels, 'Levels dictionary returned');
  console.log('✔ Passed: GET /api/bot initially reports disabled bot');

  // Test 6: POST /api/bot enables bot (Black, Level 4)
  const setBotRes = await request(`/api/bot?room=${room}`, {
    method: 'POST',
    body: { enabled: true, level: 4, color: 'black' }
  });
  assert.strictEqual(setBotRes.status, 200);
  assert.strictEqual(setBotRes.json.enabled, true);
  assert.strictEqual(setBotRes.json.level, 4);
  assert.strictEqual(setBotRes.json.color, 'black');
  console.log('✔ Passed: POST /api/bot successfully enabled Level 4 Bot playing Black');

  // Test 7: Autonomous Bot response: White plays e2e4 -> Bot automatically plays as Black!
  const moveRes = await request(`/api/move?room=${room}`, {
    method: 'POST',
    body: { move: 'e2e4' }
  });
  assert.strictEqual(moveRes.status, 200);
  assert(moveRes.json.ok);

  // Wait for bot think delay (200-450ms) + Level 4 movetime (300ms) + engine queue
  await new Promise(r => setTimeout(r, 2000));

  // Verify referee state now has 2 moves in history (White's move + Bot's move)
  const stateRes = await request(`/api/state?room=${room}`);
  assert.strictEqual(stateRes.status, 200);
  assert.strictEqual(stateRes.json.history.length, 2, `History should contain White and Black bot move (got ${stateRes.json.history.length})`);
  assert.strictEqual(stateRes.json.history[0], 'e2e4');
  assert.strictEqual(stateRes.json.board.turn, 'white', 'Turn returned to White after bot move');
  console.log(`✔ Passed: Bot automatically responded as Black with move: ${stateRes.json.history[1]}`);

  // Test 8: Bot greeting chat message was dispatched
  const chatRes = await request(`/api/chat?room=${room}`);
  assert.strictEqual(chatRes.status, 200);
  assert(chatRes.json.messages.length >= 1, 'Bot sent greeting in room chat');
  console.log(`✔ Passed: Bot sent flavor chat commentary: "${chatRes.json.messages[0].text}"`);

  // Test 9: Bot playing White makes opening move upon game reset
  const roomWhiteBot = 'bot-white-' + Date.now();
  await request(`/api/bot?room=${roomWhiteBot}`, {
    method: 'POST',
    body: { enabled: true, level: 2, color: 'white' }
  });

  // Wait for White bot opening move (think delay + book/engine)
  await new Promise(r => setTimeout(r, 1500));

  const whiteBotState = await request(`/api/state?room=${roomWhiteBot}`);
  assert.strictEqual(whiteBotState.status, 200);
  assert.strictEqual(whiteBotState.json.history.length, 1, 'White bot played the first move automatically');
  assert.strictEqual(whiteBotState.json.board.turn, 'black', 'Turn shifted to Black');
  console.log(`✔ Passed: White bot made opening move automatically: ${whiteBotState.json.history[0]}`);

  // Test 10: Disabling bot
  const disableRes = await request(`/api/bot?room=${room}`, {
    method: 'POST',
    body: { enabled: false }
  });
  assert.strictEqual(disableRes.status, 200);
  assert.strictEqual(disableRes.json.enabled, false);
  console.log('✔ Passed: Bot successfully disabled');

  console.log('\nAll 10 tests passed successfully!');
  server.close();
  await engineServer.shutdown();
  process.exit(0);
}

runTests().catch(async (err) => {
  console.error('Test failure:', err);
  if (server) server.close();
  try { await engineServer.shutdown(); } catch (_) {}
  process.exit(1);
});
