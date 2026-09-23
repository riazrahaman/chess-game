#!/usr/bin/env node
'use strict';

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const serverModule = require('../server.js');

let passed = 0;
function test(name, fn) {
  return fn().then(() => {
    passed++;
    console.log(`PASS: ${name}`);
  });
}

function request(server, options, bodyData) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: options.path,
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
      });
    });
    req.on('error', reject);
    if (bodyData) {
      req.write(typeof bodyData === 'string' ? bodyData : JSON.stringify(bodyData));
    }
    req.end();
  });
}

async function run() {
  console.log('=== Auth Routes & Sessions Self-Test ===\n');
  const server = serverModule.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  try {
    await test('GET /api/auth/config returns config status', async () => {
      const res = await request(server, { path: '/api/auth/config' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.ok, true);
      assert('googleClientId' in res.body);
    });

    await test('POST /api/auth/register creates user and returns session cookie', async () => {
      const username = 'testuser_' + Date.now();
      const res = await request(server, {
        path: '/api/auth/register',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, { username, password: 'password123' });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.ok, true);
      assert.strictEqual(res.body.user.username, username);
      assert(res.body.token);

      const setCookie = res.headers['set-cookie'];
      assert(setCookie && setCookie.some(c => c.includes('chess_session=')));
    });

    await test('POST /api/auth/login verifies credentials and returns session', async () => {
      const username = 'loginuser_' + Date.now();
      await request(server, {
        path: '/api/auth/register',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, { username, password: 'password123' });

      const wrong = await request(server, {
        path: '/api/auth/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, { username, password: 'wrongpassword' });
      assert.strictEqual(wrong.status, 401);

      const right = await request(server, {
        path: '/api/auth/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, { username, password: 'password123' });
      assert.strictEqual(right.status, 200);
      assert.strictEqual(right.body.ok, true);
      assert.strictEqual(right.body.user.username, username);
      assert(right.body.token);
    });

    await test('GET /api/auth/me identifies session from header and cookie', async () => {
      const username = 'meuser_' + Date.now();
      const reg = await request(server, {
        path: '/api/auth/register',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, { username, password: 'password123' });
      const token = reg.body.token;

      // With Bearer token
      const meBearer = await request(server, {
        path: '/api/auth/me',
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.strictEqual(meBearer.status, 200);
      assert.strictEqual(meBearer.body.authenticated, true);
      assert.strictEqual(meBearer.body.user.username, username);

      // With cookie
      const meCookie = await request(server, {
        path: '/api/auth/me',
        headers: { Cookie: `chess_session=${token}` }
      });
      assert.strictEqual(meCookie.status, 200);
      assert.strictEqual(meCookie.body.authenticated, true);
      assert.strictEqual(meCookie.body.user.username, username);

      // Unauthenticated
      const meGuest = await request(server, { path: '/api/auth/me' });
      assert.strictEqual(meGuest.status, 200);
      assert.strictEqual(meGuest.body.authenticated, false);
      assert.strictEqual(meGuest.body.user, null);
    });

    await test('POST /api/auth/logout invalidates session', async () => {
      const username = 'logoutuser_' + Date.now();
      const reg = await request(server, {
        path: '/api/auth/register',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, { username, password: 'password123' });
      const token = reg.body.token;

      const logout = await request(server, {
        path: '/api/auth/logout',
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.strictEqual(logout.status, 200);
      assert.strictEqual(logout.body.ok, true);

      const meAfter = await request(server, {
        path: '/api/auth/me',
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.strictEqual(meAfter.body.authenticated, false);
    });

    await test('POST /api/auth/google REJECTS an unsigned/forged JWT credential', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({
        sub: 'forged-sub',
        email: 'forged@evil.com',
        name: 'Forged',
        exp: Math.floor(Date.now() / 1000) + 3600
      })).toString('base64url');
      const signature = Buffer.from('mock-sig').toString('base64url');
      const credential = `${header}.${payload}.${signature}`;

      const res = await request(server, {
        path: '/api/auth/google',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, { credential });

      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.ok, false);
    });

    await test('POST /api/auth/google accepts a valid RS256 token signed by a trusted JWKS key', async () => {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const jwk = publicKey.export({ format: 'jwk' });
      jwk.kid = 'test-key-1';
      jwk.alg = 'RS256';
      jwk.use = 'sig';
      serverModule.setGoogleJwksForTest([jwk]);

      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key-1' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({
        sub: 'google-verified-sub-1',
        email: 'verified@example.com',
        name: 'Verified User',
        iss: 'https://accounts.google.com',
        aud: process.env.GOOGLE_CLIENT_ID || 'test-client-id',
        exp: Math.floor(Date.now() / 1000) + 3600
      })).toString('base64url');
      const signingInput = `${header}.${payload}`;
      const signature = crypto.sign('sha256', Buffer.from(signingInput), privateKey).toString('base64url');
      const credential = `${signingInput}.${signature}`;

      const res = await request(server, {
        path: '/api/auth/google',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, { credential });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.ok, true);
      assert.strictEqual(res.body.user.email, 'verified@example.com');
      assert.strictEqual(res.body.user.authProvider, 'google');
      assert(res.body.token);
    });

    await test('POST /api/auth/google rejects a valid signature from an untrusted key', async () => {
      const trusted = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const trustedJwk = trusted.publicKey.export({ format: 'jwk' });
      trustedJwk.kid = 'trusted-kid';
      serverModule.setGoogleJwksForTest([trustedJwk]);

      const attacker = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'trusted-kid' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({
        sub: 'attacker-sub',
        email: 'attacker@evil.com',
        iss: 'https://accounts.google.com',
        exp: Math.floor(Date.now() / 1000) + 3600
      })).toString('base64url');
      const signingInput = `${header}.${payload}`;
      const signature = crypto.sign('sha256', Buffer.from(signingInput), attacker.privateKey).toString('base64url');

      const res = await request(server, {
        path: '/api/auth/google',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, { credential: `${signingInput}.${signature}` });

      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.ok, false);
    });

    await test('POST /api/auth/google rejects a correctly signed token with a non-Google issuer', async () => {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const jwk = publicKey.export({ format: 'jwk' });
      jwk.kid = 'issuer-test-kid';
      serverModule.setGoogleJwksForTest([jwk]);

      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'issuer-test-kid' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({
        sub: 'issuer-sub',
        email: 'issuer@evil.com',
        iss: 'https://evil.example.com',
        exp: Math.floor(Date.now() / 1000) + 3600
      })).toString('base64url');
      const signingInput = `${header}.${payload}`;
      const signature = crypto.sign('sha256', Buffer.from(signingInput), privateKey).toString('base64url');

      const res = await request(server, {
        path: '/api/auth/google',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, { credential: `${signingInput}.${signature}` });

      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.ok, false);
    });

    await test('POST /api/auth/google with demoUser establishes Google session when ALLOW_DEMO_AUTH=1', async () => {
      const prev = process.env.ALLOW_DEMO_AUTH;
      process.env.ALLOW_DEMO_AUTH = '1';
      try {
        // Config reflects the opt-in flag
        const cfg = await request(server, { path: '/api/auth/config' });
        assert.strictEqual(cfg.body.demoAuthEnabled, true);

        const res = await request(server, {
          path: '/api/auth/google',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }, {
          demoUser: {
            name: 'Riaz Rahaman',
            email: 'rahaman.riaz@gmail.com'
          }
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.ok, true);
        assert.strictEqual(res.body.user.email, 'rahaman.riaz@gmail.com');
        assert.strictEqual(res.body.user.username, 'Riaz Rahaman');
        assert.strictEqual(res.body.user.authProvider, 'google');
        assert(res.body.token);
      } finally {
        if (prev === undefined) delete process.env.ALLOW_DEMO_AUTH;
        else process.env.ALLOW_DEMO_AUTH = prev;
      }
    });

    await test('POST /api/auth/google demoUser is DISABLED when ALLOW_DEMO_AUTH is unset', async () => {
      const prev = process.env.ALLOW_DEMO_AUTH;
      delete process.env.ALLOW_DEMO_AUTH;
      try {
        const cfg = await request(server, { path: '/api/auth/config' });
        assert.strictEqual(cfg.body.demoAuthEnabled, false);

        const res = await request(server, {
          path: '/api/auth/google',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }, { demoUser: { name: 'Backdoor', email: 'backdoor@evil.com' } });

        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.ok, false);
      } finally {
        if (prev !== undefined) process.env.ALLOW_DEMO_AUTH = prev;
      }
    });

    await test('GET /api/profile returns profile stats', async () => {
      const res = await request(server, { path: '/api/profile?username=Magnus%20Player' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.ok, true);
      assert.strictEqual(res.body.profile.username, 'Magnus Player');
      assert(Array.isArray(res.body.profile.games));
    });

    await test('CORS allows riazrahaman.com domain and localhost on any port', async () => {
      const resDomain = await request(server, {
        path: '/api/time',
        method: 'GET',
        headers: { Origin: 'https://chess.riazrahaman.com' }
      });
      assert.strictEqual(resDomain.status, 200);
      assert.strictEqual(resDomain.headers['access-control-allow-origin'], 'https://chess.riazrahaman.com');

      const resLocal = await request(server, {
        path: '/api/time',
        method: 'GET',
        headers: { Origin: 'http://localhost:3000' }
      });
      assert.strictEqual(resLocal.status, 200);
      assert.strictEqual(resLocal.headers['access-control-allow-origin'], 'http://localhost:3000');
    });

    console.log(`\nAll ${passed} tests passed successfully!`);
  } finally {
    await new Promise(r => server.close(r));
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
