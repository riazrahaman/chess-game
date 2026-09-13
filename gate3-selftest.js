#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

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

function httpPost(port, urlPath, payload, headers) {
  return new Promise((resolve, reject) => {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: urlPath,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {}),
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(body); } catch (e) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: urlPath,
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(body); } catch (e) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gate3-test-'));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function startServer(tmpDir, port) {
  const env = Object.assign({}, process.env, {
    CHESS_STATE_FILE: path.join(tmpDir, '.referee-state.json'),
    CHESS_JOURNAL_FILE: path.join(tmpDir, '.referee-journal.jsonl'),
    CHESS_PORT: String(port),
    CHESS_ALLOWED_ORIGIN: `http://localhost:${port},http://127.0.0.1:${port}`,
  });
  const child = spawn(process.execPath, [path.join(DIR, 'server.js')], {
    cwd: tmpDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  await waitForServer(port, 10000);
  return { child, env };
}

async function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 10000);
  while (Date.now() < deadline) {
    try {
      const r = await httpGet(port, '/api/state');
      if (r.status === 200 || r.status === 404) return;
    } catch (e) {}
    await sleep(50);
  }
  throw new Error('server did not start within timeout');
}

async function testDuplicateCommandIds() {
  console.log('\n--- Test: Concurrent duplicate command IDs → same response + single mutation ---');
  const tmpDir = makeTempDir();
  const port = 4311;
  const { child, env } = await startServer(tmpDir, port);
  try {
    await httpPost(port, '/api/reset', { id: 'r1' });
    await sleep(100);

    const dupId = 'move-dup-001';
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(httpPost(port, '/api/move', { id: dupId, move: 'e2e4' }));
    }
    const results = await Promise.all(promises);

    const allOk = results.every(r => r.status === 200 && r.json && r.json.ok === true);
    assert(allOk, 'duplicate-id: all 10 concurrent requests with same id return ok');

    const allSameRevision = results.every(r => r.json && r.json.revision === results[0].json.revision);
    assert(allSameRevision, 'duplicate-id: all responses carry the same revision');

    const allSameApplied = results.every(r => r.json && r.json.applied === 'e2e4');
    assert(allSameApplied, 'duplicate-id: all responses carry the same applied move');

    const stateResp = await httpGet(port, '/api/state');
    const state = stateResp.json;
    assert(state.history.length === 1, 'duplicate-id: only single mutation applied (history length = ' + state.history.length + ')');
    assert(state.history[0] === 'e2e4', 'duplicate-id: history contains e2e4');
    assert(state.board.turn === 'black', 'duplicate-id: turn is black after single e2e4');
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
  }
}

async function testSerializedBurstOrdering() {
  console.log('\n--- Test: Serialized queue ordering under burst (20 alternating legal moves) ---');
  const tmpDir = makeTempDir();
  const port = 4312;
  const { child, env } = await startServer(tmpDir, port);
  try {
    await httpPost(port, '/api/reset', { id: 'reset-burst' });
    await sleep(100);

    const moveSeq = [
      'e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4', 'g8f6',
      'e1g1', 'f6e4', 'f1e1', 'e4c3', 'b1c3', 'c6e7', 'a4b3', 'e7d5',
      'c3d5', 'd7d6', 'd5c3', 'c7c6'
    ];

    const promises = moveSeq.map((m, i) => httpPost(port, '/api/move', { id: 'burst-' + i, move: m }));
    const results = await Promise.all(promises);

    const allAccepted = results.every(r => r.status === 200 && r.json && r.json.ok === true);
    assert(allAccepted, 'burst: all 20 moves accepted (legal alternating sequence)');

    const stateResp = await httpGet(port, '/api/state');
    const state = stateResp.json;
    assert(state.history.length === 20, 'burst: exactly 20 moves in history (got ' + state.history.length + ')');

    for (let i = 0; i < 20; i++) {
      assert(state.history[i] === moveSeq[i],
        'burst: move ' + i + ' is ' + moveSeq[i] + ' (got ' + state.history[i] + ')');
    }

    const revisions = results.map(r => r.json.revision);
    let monotonicallyIncreasing = true;
    for (let i = 1; i < revisions.length; i++) {
      if (revisions[i] <= revisions[i - 1]) {
        monotonicallyIncreasing = false;
        break;
      }
    }
    assert(monotonicallyIncreasing, 'burst: revisions strictly monotonically increasing');
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
  }
}

async function testRevisionConflict() {
  console.log('\n--- Test: Revision conflict 409 ---');
  const tmpDir = makeTempDir();
  const port = 4313;
  const { child, env } = await startServer(tmpDir, port);
  try {
    await httpPost(port, '/api/reset', { id: 'reset-conflict' });
    await sleep(100);

    const r1 = await httpPost(port, '/api/move', { id: 'm1', move: 'e2e4', expectedRevision: 0 });
    assert(r1.status === 200 && r1.json.ok === true, 'conflict: move with correct expectedRevision=0 succeeds');
    const revAfter = r1.json.revision;

    const r2 = await httpPost(port, '/api/move', { id: 'm2', move: 'e7e5', expectedRevision: 0 });
    assert(r2.status === 409, 'conflict: stale expectedRevision=0 returns 409 (got ' + r2.status + ')');
    assert(r2.json && r2.json.ok === false, 'conflict: 409 body has ok=false');
    assert(r2.json && r2.json.error === 'revision conflict', 'conflict: 409 body has error=revision conflict');
    assert(r2.json && r2.json.actualRevision === revAfter, 'conflict: 409 body includes actualRevision');

    const r3 = await httpPost(port, '/api/move', { id: 'm3', move: 'e7e5', expectedRevision: revAfter });
    assert(r3.status === 200 && r3.json.ok === true, 'conflict: move with correct expectedRevision succeeds after 409');
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
  }
}

async function testCrashRecovery() {
  console.log('\n--- Test: Crash-recovery (kill & restart → state reconstructed) ---');
  const tmpDir = makeTempDir();
  const port1 = 4314;
  const { child: child1, env } = await startServer(tmpDir, port1);
  try {
    await httpPost(port1, '/api/reset', { id: 'reset-crash' });
    await sleep(100);

    const moves = ['e2e4', 'e7e5', 'g1f3'];
    for (let i = 0; i < moves.length; i++) {
      await httpPost(port1, '/api/move', { id: 'crash-' + i, move: moves[i] });
    }
    await sleep(200);

    const stateBefore = (await httpGet(port1, '/api/state')).json;
    assert(stateBefore.history.length === 3, 'recovery: 3 moves applied before crash');
  } finally {
    child1.kill('SIGKILL');
    await sleep(300);
  }

  const port2 = 4315;
  const env2 = Object.assign({}, env, { CHESS_PORT: String(port2) });
  const child2 = spawn(process.execPath, [path.join(DIR, 'server.js')], {
    cwd: tmpDir,
    env: env2,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child2.stdout.on('data', () => {});
  child2.stderr.on('data', () => {});
  try {
    await waitForServer(port2, 10000);

    const stateAfter = (await httpGet(port2, '/api/state')).json;
    assert(stateAfter !== null, 'recovery: state reconstructed after restart (non-null)');
    assert(stateAfter.history.length === 3, 'recovery: all 3 moves preserved after restart (got ' + (stateAfter.history ? stateAfter.history.length : 'null') + ')');
    assert(stateAfter.history[0] === 'e2e4', 'recovery: first move e2e4 preserved');
    assert(stateAfter.history[1] === 'e7e5', 'recovery: second move e7e5 preserved');
    assert(stateAfter.history[2] === 'g1f3', 'recovery: third move g1f3 preserved');
    assert(stateAfter.board.turn === 'black', 'recovery: turn is black after 3 plies (got ' + stateAfter.board.turn + ')');

    const continueResp = await httpPost(port2, '/api/move', { id: 'post-recovery-1', move: 'b8c6' });
    assert(continueResp.status === 200 && continueResp.json.ok === true,
      'recovery: server accepts new moves after restart');
    assert(continueResp.json.history && continueResp.json.history.includes('g1f3'),
      'recovery: new move response includes prior journal-replayed history');
  } finally {
    child2.kill('SIGTERM');
    await sleep(200);
  }
}

async function testIdempotencyAcrossReboot() {
  console.log('\n--- Test: Journal + snapshot integrity (atomic snapshot file readable) ---');
  const tmpDir = makeTempDir();
  const port = 4316;
  const { child, env } = await startServer(tmpDir, port);
  try {
    await httpPost(port, '/api/reset', { id: 'reset-journal' });
    await sleep(100);
    await httpPost(port, '/api/move', { id: 'j1', move: 'e2e4' });
    await httpPost(port, '/api/move', { id: 'j2', move: 'e7e5' });
    await sleep(200);

    const stateFile = path.join(tmpDir, '.referee-state.json');
    const journalFile = path.join(tmpDir, '.referee-journal.jsonl');

    assert(fs.existsSync(stateFile), 'journal: snapshot file exists');
    assert(fs.existsSync(journalFile), 'journal: journal file exists');

    const snapshot = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert(snapshot.history.length === 2, 'journal: snapshot has 2 moves');

    const journalLines = fs.readFileSync(journalFile, 'utf8').split('\n').filter(Boolean);
    assert(journalLines.length >= 3, 'journal: at least 3 journal entries (reset + 2 moves)');

    for (const line of journalLines) {
      const entry = JSON.parse(line);
      assert(typeof entry.seq === 'number', 'journal: entry has numeric seq');
      assert(typeof entry.type === 'string', 'journal: entry has type');
      assert(typeof entry.ts === 'number', 'journal: entry has ts');
    }
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
  }
}

async function testClockDecrementOnMove() {
  console.log('\n--- Test: Clock decrement on move + increment cap ---');
  const tmpDir = makeTempDir();
  const port = 4321;
  const env = Object.assign({}, process.env, {
    CHESS_STATE_FILE: path.join(tmpDir, '.referee-state.json'),
    CHESS_JOURNAL_FILE: path.join(tmpDir, '.referee-journal.jsonl'),
    CHESS_PORT: String(port),
    CHESS_ALLOWED_ORIGIN: `http://localhost:${port},http://127.0.0.1:${port}`,
    CHESS_MOVE_TIME_COST: '20',
  });
  const child = spawn(process.execPath, [path.join(DIR, 'server.js')], {
    cwd: tmpDir, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  try {
    await waitForServer(port, 10000);
    await httpPost(port, '/api/reset', { id: 'reset-clock-dec' });
    await sleep(100);

    const state0 = (await httpGet(port, '/api/state')).json;
    assert(state0.clocks.white === 600, 'clock-dec: white starts at 600 (got ' + state0.clocks.white + ')');
    assert(state0.clocks.black === 600, 'clock-dec: black starts at 600 (got ' + state0.clocks.black + ')');

    const r1 = await httpPost(port, '/api/move', { id: 'cd1', move: 'e2e4' });
    assert(r1.status === 200 && r1.json.ok === true, 'clock-dec: e2e4 accepted');
    const expectedWhiteAfter = 600 - 20 + 15;
    assert(r1.json.clocks.white === expectedWhiteAfter,
      'clock-dec: white clock = 600 - 20 + 15 = ' + expectedWhiteAfter + ' (got ' + r1.json.clocks.white + ')');
    assert(r1.json.clocks.black === 600, 'clock-dec: black clock unchanged at 600 (got ' + r1.json.clocks.black + ')');

    const r2 = await httpPost(port, '/api/move', { id: 'cd2', move: 'e7e5' });
    assert(r2.status === 200 && r2.json.ok === true, 'clock-dec: e7e5 accepted');
    const expectedBlackAfter = 600 - 20 + 15;
    assert(r2.json.clocks.black === expectedBlackAfter,
      'clock-dec: black clock = 600 - 20 + 15 = ' + expectedBlackAfter + ' (got ' + r2.json.clocks.black + ')');
    assert(r2.json.clocks.white === expectedWhiteAfter, 'clock-dec: white clock unchanged (got ' + r2.json.clocks.white + ')');
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
  }
}

async function testIncrementCap() {
  console.log('\n--- Test: Increment cap at CLOCK_START_SECONDS ---');
  const tmpDir = makeTempDir();
  const port = 4322;
  const env = Object.assign({}, process.env, {
    CHESS_STATE_FILE: path.join(tmpDir, '.referee-state.json'),
    CHESS_JOURNAL_FILE: path.join(tmpDir, '.referee-journal.jsonl'),
    CHESS_PORT: String(port),
    CHESS_ALLOWED_ORIGIN: `http://localhost:${port},http://127.0.0.1:${port}`,
    CHESS_MOVE_TIME_COST: '0',
  });
  const child = spawn(process.execPath, [path.join(DIR, 'server.js')], {
    cwd: tmpDir, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  try {
    await waitForServer(port, 10000);
    await httpPost(port, '/api/reset', { id: 'reset-cap' });
    await sleep(100);

    const r1 = await httpPost(port, '/api/move', { id: 'cap1', move: 'e2e4' });
    assert(r1.json.clocks.white === 600,
      'increment-cap: white clock capped at 600 with cost=0 (got ' + r1.json.clocks.white + ')');

    const r2 = await httpPost(port, '/api/move', { id: 'cap2', move: 'e7e5' });
    assert(r2.json.clocks.black === 600,
      'increment-cap: black clock capped at 600 with cost=0 (got ' + r2.json.clocks.black + ')');
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
  }
}

async function testFlagOnTimeout() {
  console.log('\n--- Test: Flag on timeout (clock hits 0 → flag loss) ---');
  const tmpDir = makeTempDir();
  const port = 4323;
  const env = Object.assign({}, process.env, {
    CHESS_STATE_FILE: path.join(tmpDir, '.referee-state.json'),
    CHESS_JOURNAL_FILE: path.join(tmpDir, '.referee-journal.jsonl'),
    CHESS_PORT: String(port),
    CHESS_ALLOWED_ORIGIN: `http://localhost:${port},http://127.0.0.1:${port}`,
    CHESS_MOVE_TIME_COST: '601',
  });
  const child = spawn(process.execPath, [path.join(DIR, 'server.js')], {
    cwd: tmpDir, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  try {
    await waitForServer(port, 10000);
    await httpPost(port, '/api/reset', { id: 'reset-flag' });
    await sleep(100);

    const r1 = await httpPost(port, '/api/move', { id: 'flag1', move: 'e2e4' });
    assert(r1.status === 409, 'flag: move that exhausts clock returns 409 (got ' + r1.status + ')');
    assert(r1.json.ok === false, 'flag: response ok=false');
    assert(r1.json.error === 'flagged', 'flag: response error=flagged (got ' + r1.json.error + ')');
    assert(r1.json.gameOver === true, 'flag: gameOver=true after flag');
    assert(r1.json.status === 'timeout', 'flag: status=timeout (got ' + r1.json.status + ')');
    assert(r1.json.flagged === 'white', 'flag: flagged=white (got ' + r1.json.flagged + ')');
    assert(r1.json.result === '0-1 on time', 'flag: result=0-1 on time (got ' + r1.json.result + ')');
    assert(r1.json.clocks.white === 0, 'flag: white clock at 0 (got ' + r1.json.clocks.white + ')');

    const r2 = await httpPost(port, '/api/move', { id: 'flag2', move: 'e7e5' });
    assert(r2.status === 409, 'flag: move after flag rejected with 409 (got ' + r2.status + ')');
    assert(r2.json.error === 'game over', 'flag: post-flag move error=game over');

    const stateFile = path.join(tmpDir, '.referee-state.json');
    const snap = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert(Array.isArray(snap.moveTimestamps), 'flag: moveTimestamps is an array');
    assert(snap.history.length === snap.moveTimestamps.length,
      'flag: history.length (' + snap.history.length + ') == moveTimestamps.length (' + snap.moveTimestamps.length + ') after timeout');
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
  }
}

async function testTimeoutParallelArraysAfterRestart() {
  console.log('\n--- Test: Timeout → arrays parallel after restart, timeout terminal ---');
  const tmpDir = makeTempDir();
  const port1 = 4331;
  const env = Object.assign({}, process.env, {
    CHESS_STATE_FILE: path.join(tmpDir, '.referee-state.json'),
    CHESS_JOURNAL_FILE: path.join(tmpDir, '.referee-journal.jsonl'),
    CHESS_PORT: String(port1),
    CHESS_ALLOWED_ORIGIN: `http://localhost:${port1},http://127.0.0.1:${port1}`,
    CHESS_MOVE_TIME_COST: '601',
  });
  const child1 = spawn(process.execPath, [path.join(DIR, 'server.js')], {
    cwd: tmpDir, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child1.stdout.on('data', () => {});
  child1.stderr.on('data', () => {});
  try {
    await waitForServer(port1, 10000);
    await httpPost(port1, '/api/reset', { id: 'reset-parallel' });
    await sleep(100);
    await httpPost(port1, '/api/move', { id: 'par1', move: 'e2e4' });
    await sleep(100);

    const stateBefore = (await httpGet(port1, '/api/state')).json;
    assert(stateBefore.gameOver === true, 'parallel: gameOver after timeout');
    assert(stateBefore.status === 'timeout', 'parallel: status=timeout');
    assert(stateBefore.history.length === 0, 'parallel: history empty (move not applied)');
  } finally {
    child1.kill('SIGKILL');
    await sleep(300);
  }

  const port2 = 4332;
  const env2 = Object.assign({}, env, { CHESS_PORT: String(port2) });
  const child2 = spawn(process.execPath, [path.join(DIR, 'server.js')], {
    cwd: tmpDir, env: env2, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child2.stdout.on('data', () => {});
  child2.stderr.on('data', () => {});
  try {
    await waitForServer(port2, 10000);
    const stateAfter = (await httpGet(port2, '/api/state')).json;
    assert(stateAfter.gameOver === true, 'parallel: gameOver persists after restart');
    assert(stateAfter.status === 'timeout', 'parallel: status=timeout after restart');
    assert(stateAfter.flagged === 'white', 'parallel: flagged=white after restart');
    assert(stateAfter.history.length === 0, 'parallel: history empty after restart');
    assert(Array.isArray(stateAfter.moveTimestamps), 'parallel: moveTimestamps is array after restart');
    assert(stateAfter.history.length === stateAfter.moveTimestamps.length,
      'parallel: history.length (' + stateAfter.history.length + ') == moveTimestamps.length (' + stateAfter.moveTimestamps.length + ') after restart');

    const rPost = await httpPost(port2, '/api/move', { id: 'post-par-1', move: 'e7e5' });
    assert(rPost.status === 409, 'parallel: post-restart move rejected 409 (got ' + rPost.status + ')');
    assert(rPost.json.error === 'game over', 'parallel: post-restart move error=game over');
  } finally {
    child2.kill('SIGTERM');
    await sleep(200);
  }
}

async function testCrashRecoveryClockReconstruction() {
  console.log('\n--- Test: Crash-recovery clock reconstruction from journal timestamps ---');
  const tmpDir = makeTempDir();
  const port1 = 4324;
  const env = Object.assign({}, process.env, {
    CHESS_STATE_FILE: path.join(tmpDir, '.referee-state.json'),
    CHESS_JOURNAL_FILE: path.join(tmpDir, '.referee-journal.jsonl'),
    CHESS_PORT: String(port1),
    CHESS_ALLOWED_ORIGIN: `http://localhost:${port1},http://127.0.0.1:${port1}`,
    CHESS_MOVE_TIME_COST: '20',
  });
  const child1 = spawn(process.execPath, [path.join(DIR, 'server.js')], {
    cwd: tmpDir, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child1.stdout.on('data', () => {});
  child1.stderr.on('data', () => {});
  let whiteElapsedBefore = 0;
  let blackElapsedBefore = 0;
  const expectedWhiteAfter3 = 600 - 20 + 15 - 20 + 15;
  const expectedBlackAfter2 = 600 - 20 + 15;
  try {
    await waitForServer(port1, 10000);
    await httpPost(port1, '/api/reset', { id: 'reset-recovery-clock' });
    await sleep(100);

    const moves = ['e2e4', 'e7e5', 'g1f3'];
    for (let i = 0; i < moves.length; i++) {
      await httpPost(port1, '/api/move', { id: 'rclock-' + i, move: moves[i] });
      await sleep(50);
    }
    await sleep(200);

    const stateBefore = (await httpGet(port1, '/api/state')).json;
    assert(stateBefore.history.length === 3, 'recovery-clock: 3 moves applied before crash');
    assert(typeof stateBefore.elapsed.white === 'number', 'recovery-clock: elapsed.white is numeric before crash');
    assert(typeof stateBefore.elapsed.black === 'number', 'recovery-clock: elapsed.black is numeric before crash');
    assert(stateBefore.clocks.white === expectedWhiteAfter3,
      'recovery-clock: white clock = ' + expectedWhiteAfter3 + ' before crash (got ' + stateBefore.clocks.white + ')');
    assert(stateBefore.clocks.black === expectedBlackAfter2,
      'recovery-clock: black clock = ' + expectedBlackAfter2 + ' before crash (got ' + stateBefore.clocks.black + ')');
    whiteElapsedBefore = stateBefore.elapsed.white;
    blackElapsedBefore = stateBefore.elapsed.black;
    assert(whiteElapsedBefore >= 0, 'recovery-clock: white elapsed >= 0 before crash (got ' + whiteElapsedBefore + ')');
    assert(blackElapsedBefore >= 0, 'recovery-clock: black elapsed >= 0 before crash (got ' + blackElapsedBefore + ')');
  } finally {
    child1.kill('SIGKILL');
    await sleep(300);
  }

  const port2 = 4325;
  const env2 = Object.assign({}, env, { CHESS_PORT: String(port2) });
  const child2 = spawn(process.execPath, [path.join(DIR, 'server.js')], {
    cwd: tmpDir, env: env2, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child2.stdout.on('data', () => {});
  child2.stderr.on('data', () => {});
  try {
    await waitForServer(port2, 10000);

    const stateAfter = (await httpGet(port2, '/api/state')).json;
    assert(stateAfter.history.length === 3, 'recovery-clock: 3 moves preserved after restart');
    assert(stateAfter.clocks.white === expectedWhiteAfter3,
      'recovery-clock: white clock reconstructed = ' + expectedWhiteAfter3 + ' (got ' + stateAfter.clocks.white + ')');
    assert(stateAfter.clocks.black === expectedBlackAfter2,
      'recovery-clock: black clock reconstructed = ' + expectedBlackAfter2 + ' (got ' + stateAfter.clocks.black + ')');
    assert(typeof stateAfter.elapsed.white === 'number', 'recovery-clock: elapsed.white is numeric after restart');
    assert(typeof stateAfter.elapsed.black === 'number', 'recovery-clock: elapsed.black is numeric after restart');
    assert(stateAfter.elapsed.white >= 0, 'recovery-clock: elapsed.white non-negative after restart');
    assert(stateAfter.elapsed.black >= 0, 'recovery-clock: elapsed.black non-negative after restart');
    assert(Math.abs(stateAfter.elapsed.white - whiteElapsedBefore) < 0.01,
      'recovery-clock: elapsed.white deterministically reconstructed (before=' + whiteElapsedBefore + ' after=' + stateAfter.elapsed.white + ')');
    assert(Math.abs(stateAfter.elapsed.black - blackElapsedBefore) < 0.01,
      'recovery-clock: elapsed.black deterministically reconstructed (before=' + blackElapsedBefore + ' after=' + stateAfter.elapsed.black + ')');
  } finally {
    child2.kill('SIGTERM');
    await sleep(200);
  }
}

async function testElapsedClockAccumulation() {
  console.log('\n--- Test: Elapsed clock accumulates per-move time ---');
  const tmpDir = makeTempDir();
  const port = 4326;
  const { child, env } = await startServer(tmpDir, port);
  try {
    await httpPost(port, '/api/reset', { id: 'reset-elapsed' });
    await sleep(100);

    const r1 = await httpPost(port, '/api/move', { id: 'el1', move: 'e2e4' });
    assert(r1.json.elapsed.white === 0, 'elapsed: first move has 0 elapsed (no prior moveStartTs)');
    assert(r1.json.elapsed.black === 0, 'elapsed: black elapsed 0 before black moves');

    await sleep(150);
    const r2 = await httpPost(port, '/api/move', { id: 'el2', move: 'e7e5' });
    assert(r2.json.elapsed.black > 0, 'elapsed: black first move accumulates thinking time (got ' + r2.json.elapsed.black + ')');
    assert(r2.json.elapsed.black >= 0.1, 'elapsed: black elapsed >= 0.1s (got ' + r2.json.elapsed.black + ')');
    assert(r2.json.elapsed.white === 0, 'elapsed: white elapsed still 0 after black move');

    await sleep(200);
    const r3 = await httpPost(port, '/api/move', { id: 'el3', move: 'g1f3' });
    assert(r3.json.elapsed.white > 0, 'elapsed: white elapsed > 0 after second white move (got ' + r3.json.elapsed.white + ')');
    assert(r3.json.elapsed.white >= 0.1, 'elapsed: white elapsed >= 0.1s (got ' + r3.json.elapsed.white + ')');
    assert(r3.json.elapsed.black >= 0.1, 'elapsed: black elapsed preserved from prior move (got ' + r3.json.elapsed.black + ')');
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
  }
}

async function main() {
  await testDuplicateCommandIds();
  await testSerializedBurstOrdering();
  await testRevisionConflict();
  await testCrashRecovery();
  await testIdempotencyAcrossReboot();
  await testClockDecrementOnMove();
  await testIncrementCap();
  await testFlagOnTimeout();
  await testTimeoutParallelArraysAfterRestart();
  await testCrashRecoveryClockReconstruction();
  await testElapsedClockAccumulation();

  console.log('\n--- Gate 3 Self-Test Summary ---');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    console.error(`\nGate 3 self-test FAILED with ${failed} failure(s).`);
    process.exit(1);
  } else {
    console.log('\nAll Gate 3 self-tests PASSED successfully!');
  }
}

main().catch(err => {
  console.error('Gate 3 self-test error:', err);
  process.exit(1);
});