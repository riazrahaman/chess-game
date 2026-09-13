const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const stateFile = path.join(DIR, '.referee-state.json');
const lockFile = path.join(DIR, '.referee-state.json.lock');
const originalStateFile = fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null;
const originalLockFile = fs.existsSync(lockFile) ? fs.readFileSync(lockFile) : null;
process.env.CHESS_STATE_FILE = stateFile;

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

function httpGet(server, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'GET',
      path: urlPath,
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpPost(server, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'POST',
      path: urlPath,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
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

function httpPostRaw(server, urlPath, data, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'POST',
      path: urlPath,
      headers: headers || { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
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

async function runSecurityTests() {
  const { createServer } = require('./server.js');
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  try {
    // Ensure referee state exists for move tests
    execFileSync('node', [path.join(DIR, 'referee-helper.cjs'), 'reset'], { cwd: DIR, env: process.env });

    // --- Path traversal tests ---
    const traversalAttempts = [
      '/../../engine.js',
      '/../engine.js',
      '/assets/../engine.js',
      '/assets/../../server.js',
      '/%2e%2e/engine.js',
      '/%2e%2e%2fengine.js',
      '/..%2fengine.js',
      '/%2e%2e%2f%2e%2e%2fserver.js',
      '/engine.js/../../../package.json',
    ];

    for (const attempt of traversalAttempts) {
      const r = await httpGet(server, attempt);
      const isBlocked = r.status === 403 || r.status === 404;
      assert(isBlocked,
        `traversal: ${attempt} rejected with ${r.status}`);
    }

    // Absolute path attempts
    const absoluteAttempts = [
      '/etc/passwd',
      '//etc/passwd',
      '/C:/Windows/win.ini',
    ];
    for (const attempt of absoluteAttempts) {
      const r = await httpGet(server, attempt);
      assert(r.status === 404 || r.status === 403,
        `absolute path: ${attempt} rejected with ${r.status}`);
    }

    // --- Dotfile / state-file rejection ---
    const dotfileRequests = [
      '/.referee-state.json',
      '/.referee-state.json.lock',
      '/.gitignore',
      '/.git/HEAD',
      '/.env',
    ];
    for (const attempt of dotfileRequests) {
      const r = await httpGet(server, attempt);
      assert(r.status === 403,
        `dotfile: ${attempt} rejected with ${r.status}`);
    }

    // Encoded dotfile
    const r1 = await httpGet(server, '/%2ereferee-state.json');
    assert(r1.status === 403,
      'encoded dotfile: %2ereferee-state.json rejected with ' + r1.status);

    // --- Allowed files still serve correctly ---
    const allowedFiles = [
      { path: '/', expectedStatus: 200, expectedMime: 'text/html' },
      { path: '/index.html', expectedStatus: 200, expectedMime: 'text/html' },
      { path: '/engine.js', expectedStatus: 200, expectedMime: 'application/javascript' },
      { path: '/ui.js', expectedStatus: 200, expectedMime: 'application/javascript' },
      { path: '/pieces.js', expectedStatus: 200, expectedMime: 'application/javascript' },
    ];
    for (const f of allowedFiles) {
      const r = await httpGet(server, f.path);
      assert(r.status === f.expectedStatus && r.headers['content-type'] === f.expectedMime,
        `allowed: ${f.path} serves with ${r.status} (${r.headers['content-type']})`);
    }

    // --- Non-allowed files are 404 ---
    const disallowedFiles = [
      '/server.js',
      '/referee-helper.cjs',
      '/package.json',
      '/engine-selftest.js',
      '/pieces-selftest.js',
      '/game-log.md',
    ];
    for (const f of disallowedFiles) {
      const r = await httpGet(server, f);
      assert(r.status === 404,
        `disallowed: ${f} rejected with ${r.status}`);
    }

    // --- Security headers ---
    const headerResp = await httpGet(server, '/index.html');
    assert(headerResp.headers['x-content-type-options'] === 'nosniff',
      'security: X-Content-Type-Options: nosniff header present');

    // API responses should have Cache-Control: no-store
    const apiResetResp = await httpPost(server, '/api/reset', {});
    assert(apiResetResp.headers['cache-control'] === 'no-store, no-cache, must-revalidate',
      'security: Cache-Control no-store on API response');

    // --- Oversized POST body rejected ---
    const bigPayload = JSON.stringify({ move: 'e2e4', junk: 'x'.repeat(9000) });
    let bigStatus = 0;
    try {
      const bigResp = await httpPostRaw(server, '/api/move', bigPayload, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bigPayload)
      });
      bigStatus = bigResp.status;
    } catch (e) {
      // Socket reset / hang-up is also acceptable — the server may close the connection
      bigStatus = 413;
    }
    assert(bigStatus === 413,
      'oversized: POST body > 8KB rejected with 413 (got ' + bigStatus + ')');

    // --- Normal-sized POST body still works ---
    const normalResp = await httpPost(server, '/api/move', { move: 'e2e4' });
    let normalJson = {};
    try { normalJson = JSON.parse(normalResp.body); } catch (e) {}
    assert(normalResp.status === 200 && normalJson.ok === true,
      'normal: valid move POST within size limit succeeds (status ' + normalResp.status + ')');

    // --- Structured error JSON (no stack traces) ---
    const badMoveResp = await httpPost(server, '/api/move', { move: 'zzzz' });
    let badMoveJson = {};
    try { badMoveJson = JSON.parse(badMoveResp.body); } catch (e) {}
    assert(badMoveResp.status === 400 && badMoveJson.ok === false && badMoveJson.error &&
      !badMoveResp.body.includes('at ') && !badMoveResp.body.includes('stack'),
      'error: bad move returns structured JSON error without stack traces');

    const notFoundResp = await httpGet(server, '/nonexistent.js');
    let notFoundJson = {};
    try { notFoundJson = JSON.parse(notFoundResp.body); } catch (e) {}
    assert(notFoundResp.status === 404 && notFoundJson.ok === false && notFoundJson.error,
      'error: 404 returns structured JSON error');

    // --- Unknown API endpoint ---
    const unknownApiResp = await httpGet(server, '/api/unknown');
    assert(unknownApiResp.status === 404,
      'api: unknown /api/ endpoint returns 404 (got ' + unknownApiResp.status + ')');

    // --- URL-encoded traversal with mixed encoding ---
    const mixedEncodings = [
      '/%2e%2e%2f%2e%2e%2fengine.js',
      '/assets/%2e%2e%2fengine.js',
      '/%2e./engine.js',
      '/..%2f..%2fserver.js',
    ];
    for (const attempt of mixedEncodings) {
      const r = await httpGet(server, attempt);
      assert(r.status === 403 || r.status === 404,
        `encoded traversal: ${attempt} rejected with ${r.status}`);
    }

    // --- Null byte injection ---
    const nullResp = await httpGet(server, '/index.html%00.js');
    assert(nullResp.status === 404 || nullResp.status === 403,
      'null byte: /index.html%00.js rejected with ' + nullResp.status);

  } finally {
    await new Promise(r => server.close(r));
  }
}

async function main() {
  await runSecurityTests();

  console.log('\n--- Security Self-Test Summary ---');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    console.error(`\nSecurity self-test FAILED with ${failed} failure(s).`);
    process.exit(1);
  } else {
    console.log('\nAll security self-tests PASSED successfully!');
  }
}

main().catch((err) => {
  console.error('Security self-test error:', err);
  process.exit(1);
});

process.on('exit', () => {
  if (originalStateFile !== null) {
    fs.writeFileSync(stateFile, originalStateFile);
  } else {
    try { fs.unlinkSync(stateFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  if (originalLockFile !== null) {
    fs.writeFileSync(lockFile, originalLockFile);
  } else {
    try { fs.unlinkSync(lockFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
});