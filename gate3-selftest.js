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

async function main() {
  await testDuplicateCommandIds();
  await testSerializedBurstOrdering();
  await testRevisionConflict();
  await testCrashRecovery();
  await testIdempotencyAcrossReboot();

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