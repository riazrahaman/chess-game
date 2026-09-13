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

function httpRequestWithOrigin(server, method, urlPath, origin) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (origin !== undefined) headers['Origin'] = origin;
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method,
      path: urlPath,
      headers,
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

    // --- CORS origin validation ---
    const allowedPort = server.address().port;
    const allowedOriginA = `http://localhost:${allowedPort}`;
    const allowedOriginB = `http://127.0.0.1:${allowedPort}`;
    const disallowedOrigin = 'http://evil.example.com';
    process.env.CHESS_ALLOWED_ORIGIN = `${allowedOriginA},${allowedOriginB}`;

    // Disallowed Origin on GET (static file) -> 403
    const corsBadGet = await httpRequestWithOrigin(server, 'GET', '/index.html', disallowedOrigin);
    assert(corsBadGet.status === 403,
      'cors: disallowed Origin on GET static -> 403 (got ' + corsBadGet.status + ')');
    let corsBadGetJson = {};
    try { corsBadGetJson = JSON.parse(corsBadGet.body); } catch (e) {}
    assert(corsBadGetJson.ok === false && corsBadGetJson.error,
      'cors: disallowed Origin GET returns structured JSON error');
    assert(corsBadGet.headers['access-control-allow-origin'] !== disallowedOrigin,
      'cors: disallowed Origin not echoed in ACAO header');

    // Disallowed Origin on POST /api/reset -> 403
    const corsBadApi = await httpRequestWithOrigin(server, 'POST', '/api/reset', disallowedOrigin);
    assert(corsBadApi.status === 403,
      'cors: disallowed Origin on POST /api/reset -> 403 (got ' + corsBadApi.status + ')');

    // Disallowed Origin on GET /api/events (SSE) -> 403
    const corsBadSse = await httpRequestWithOrigin(server, 'GET', '/api/events', disallowedOrigin);
    assert(corsBadSse.status === 403,
      'cors: disallowed Origin on GET /api/events -> 403 (got ' + corsBadSse.status + ')');

    // Allowed Origin (localhost variant) on GET -> passes, ACAO echoed
    const corsGoodGet = await httpRequestWithOrigin(server, 'GET', '/index.html', allowedOriginA);
    assert(corsGoodGet.status === 200,
      'cors: allowed Origin (localhost) GET -> 200 (got ' + corsGoodGet.status + ')');
    assert(corsGoodGet.headers['access-control-allow-origin'] === allowedOriginA,
      'cors: allowed Origin (localhost) echoed in ACAO header');

    // Allowed Origin (127.0.0.1 variant) on GET -> passes, ACAO echoed
    const corsGoodGetB = await httpRequestWithOrigin(server, 'GET', '/index.html', allowedOriginB);
    assert(corsGoodGetB.status === 200,
      'cors: allowed Origin (127.0.0.1) GET -> 200 (got ' + corsGoodGetB.status + ')');
    assert(corsGoodGetB.headers['access-control-allow-origin'] === allowedOriginB,
      'cors: allowed Origin (127.0.0.1) echoed in ACAO header');

    // Allowed Origin on POST /api/reset -> passes
    const corsGoodApi = await httpRequestWithOrigin(server, 'POST', '/api/reset', allowedOriginA);
    assert(corsGoodApi.status === 200,
      'cors: allowed Origin POST /api/reset -> 200 (got ' + corsGoodApi.status + ')');

    // No Origin header on GET -> passes (same-origin browser flow)
    const corsNoOrigin = await httpGet(server, '/index.html');
    assert(corsNoOrigin.status === 200,
      'cors: no Origin header GET -> 200 (got ' + corsNoOrigin.status + ')');
    assert(corsNoOrigin.headers['access-control-allow-origin'] === undefined,
      'cors: no Origin header -> no ACAO header set');

    // No Origin header on POST /api/reset -> passes
    const corsNoOriginApi = await httpPost(server, '/api/reset', {});
    assert(corsNoOriginApi.status === 200,
      'cors: no Origin header POST /api/reset -> 200 (got ' + corsNoOriginApi.status + ')');

    // OPTIONS preflight with disallowed Origin -> 403
    const corsBadOpts = await httpRequestWithOrigin(server, 'OPTIONS', '/api/move', disallowedOrigin);
    assert(corsBadOpts.status === 403,
      'cors: disallowed Origin OPTIONS preflight -> 403 (got ' + corsBadOpts.status + ')');

    // OPTIONS preflight with allowed Origin -> 204
    const corsGoodOpts = await httpRequestWithOrigin(server, 'OPTIONS', '/api/move', allowedOriginA);
    assert(corsGoodOpts.status === 204,
      'cors: allowed Origin OPTIONS preflight -> 204 (got ' + corsGoodOpts.status + ')');
    assert(corsGoodOpts.headers['access-control-allow-origin'] === allowedOriginA,
      'cors: allowed Origin OPTIONS echoes ACAO header');

    // No wildcard ACAO on any response
    const corsWildcardCheck = await httpGet(server, '/index.html');
    assert(corsWildcardCheck.headers['access-control-allow-origin'] !== '*',
      'cors: no wildcard Access-Control-Allow-Origin on responses');

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