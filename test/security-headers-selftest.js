#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

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

function httpGet(server, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'GET',
      path: urlPath,
      headers: headers || {}
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  const serverModule = require('../server.js');
  const server = serverModule.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  try {
    console.log('=== M4: Security Headers ===\n');

    const htmlResp = await httpGet(server, '/');
    assert(htmlResp.headers['content-security-policy'],
      'CSP header present on HTML responses');

    const csp = htmlResp.headers['content-security-policy'] || '';
    assert(csp.includes("default-src 'self'"), 'CSP sets default-src self');
    assert(csp.includes('frame-ancestors'), 'CSP sets frame-ancestors (clickjacking)');
    assert(csp.includes("object-src 'none'"), 'CSP disables object embedding');

    // D4/D5 (Wave 1): WASM engine + tablebase allowlist. Directive-scoped so
    // the 'unsafe-eval' substring of 'wasm-unsafe-eval' cannot mask a regression.
    const directive = (name) => {
      const d = csp.split(';').map(s => s.trim()).find(s => s.startsWith(name + ' '));
      return d ? d.split(/\s+/).slice(1) : [];
    };
    const scriptSrc = directive('script-src');
    assert(scriptSrc.includes("'wasm-unsafe-eval'"), "CSP script-src allows 'wasm-unsafe-eval' (D4)");
    assert(!scriptSrc.includes("'unsafe-eval'"), "CSP script-src no longer contains 'unsafe-eval' (D4)");
    assert(!scriptSrc.includes("'unsafe-inline'"), "CSP script-src no longer contains 'unsafe-inline' (D4, Wave 3: SW registration externalised)");
    assert(directive('style-src').includes("'unsafe-inline'"), "CSP style-src keeps 'unsafe-inline' (inline <style> + style= attributes remain)");
    assert(directive('worker-src').includes("'self'") && directive('worker-src').includes('blob:'),
      "CSP worker-src keeps 'self' blob:");
    assert(directive('connect-src').includes('https://tablebase.lichess.ovh'),
      'CSP connect-src allows tablebase.lichess.ovh (D5)');
    assert(directive('connect-src').includes('https://accounts.google.com/gsi/'),
      'CSP connect-src keeps Google GSI');

    assert(htmlResp.headers['x-frame-options'] === 'DENY', 'X-Frame-Options: DENY present');
    assert(htmlResp.headers['referrer-policy'] === 'no-referrer', 'Referrer-Policy: no-referrer present');
    assert(htmlResp.headers['x-content-type-options'] === 'nosniff', 'X-Content-Type-Options: nosniff present');
    assert(htmlResp.headers['x-xss-protection'] === '0', 'X-XSS-Protection set to 0 (modern CSP)');

    // HSTS must NOT be sent over plain HTTP (local dev server)
    assert(htmlResp.headers['strict-transport-security'] === undefined,
      'HSTS absent on plain-HTTP connection');

    console.log('\n=== M4: HSTS behind TLS ===\n');

    // isBehindTls should return false for a plain socket, true when CHESS_HSTS=1
    const { isBehindTls, applySecurityHeaders, buildCsp } = serverModule;
    assert(typeof isBehindTls === 'function', 'isBehindTls exported');
    assert(isBehindTls({ socket: { encrypted: false } }) === false, 'isBehindTls false for plain socket');
    assert(isBehindTls({ socket: { encrypted: true } }) === true, 'isBehindTls true for encrypted socket');

    const fakeRes = { setHeader(name, value) { this['__h_' + name] = value; } };
    const prev = process.env.CHESS_HSTS;
    process.env.CHESS_HSTS = '1';
    applySecurityHeaders({ socket: { encrypted: false } }, fakeRes);
    assert(fakeRes['__h_Strict-Transport-Security'] &&
      fakeRes['__h_Strict-Transport-Security'].startsWith('max-age='),
      'HSTS emitted when CHESS_HSTS=1');
    delete fakeRes['__h_Strict-Transport-Security'];
    if (prev === undefined) delete process.env.CHESS_HSTS; else process.env.CHESS_HSTS = prev;

    console.log('\n=== M4: Persistent Rate Limiting ===\n');

    const { checkRateLimit, loadRateLimit, persistRateLimit, rateLimitKey } = serverModule;
    const archive = serverModule.gameArchive;

    const testIp = '203.0.113.77';
    const key = rateLimitKey(testIp);

    // Reset any prior persisted entry for isolation
    try { archive.saveRateLimit(key, { count: 0, windowStart: 0, updatedAt: 0 }); } catch (_) {}

    // Direct persistence -> load round-trip proves durability across the archive
    persistRateLimit(testIp, 41, 1000);
    const loaded = loadRateLimit(testIp);
    assert(loaded && loaded.count === 41, 'persistRateLimit + loadRateLimit round-trips count');

    // A fresh key (never persisted) restores to a safe default
    const fresh = loadRateLimit('203.0.113.200');
    assert(fresh === null, 'unknown IP restores to null (no entry)');

    // checkRateLimit persists through the archive: the SQLite/JSON store must see the count
    for (let i = 0; i < 5; i++) checkRateLimit('203.0.113.88');
    const persisted = archive.getRateLimit(rateLimitKey('203.0.113.88'));
    assert(persisted && typeof persisted.count === 'number' && persisted.count >= 5,
      'checkRateLimit persists counts into the archive (survives restart)');

    console.log('\n=== M4: Rate Limit Enforcement via HTTP ===\n');

    // Exercise the throttle through the real server path with a low cap.
    const prevLimit = process.env.CHESS_RATE_LIMIT;
    process.env.CHESS_RATE_LIMIT = '10';
    // NOTE: RATE_LIMIT_MAX_REQUESTS is read at module load; re-require to pick up the env.
    delete require.cache[require.resolve('../server.js')];
    const server2Module = require('../server.js');
    const server2 = server2Module.createServer();
    await new Promise(r => server2.listen(0, '127.0.0.1', r));
    try {
      let got429 = false;
      for (let i = 0; i < 40; i++) {
        const r = await httpGet(server2, '/api/time');
        if (r.status === 429) { got429 = true; break; }
      }
      assert(got429, 'server returns 429 after exceeding CHESS_RATE_LIMIT');
    } finally {
      await new Promise(r => server2.close(r));
    }
    if (prevLimit === undefined) delete process.env.CHESS_RATE_LIMIT; else process.env.CHESS_RATE_LIMIT = prevLimit;
    delete require.cache[require.resolve('../server.js')];

  } finally {
    await new Promise(r => server.close(r));
  }
}

run().then(() => {
  console.log(`\n--- Security Headers Self-Test Summary ---`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}).catch((err) => {
  console.error('Security headers self-test error:', err);
  process.exit(1);
});
