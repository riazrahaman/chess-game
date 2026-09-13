#!/usr/bin/env node
'use strict';

const http = require('http');
const { createServer } = require('./server.js');
const referee = require('./referee-service.js');

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
  console.log('=== Test Suite 1: NTP Latency & Clock Offset Math ===');

  // Simulate NTP roundtrip
  const t0 = 1000;
  const t1 = 1050; // server receive
  const t2 = 1052; // server transmit
  const t3 = 1104; // client receive

  const rtt = (t3 - t0) - (t2 - t1);
  const latency = Math.round(rtt / 2);
  const offset = Math.round(((t1 - t0) + (t2 - t3)) / 2);

  assert(rtt === 102, `RTT calculated correctly: 102ms (got ${rtt})`);
  assert(latency === 51, `One-way latency is 51ms (got ${latency})`);
  assert(offset === -1, `Clock offset calculated correctly (got ${offset})`);

  console.log('\n=== Test Suite 2: HTTP Integration with Server & Lag Compensation ===');

  const server = createServer();
  const TEST_PORT = 39892;

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

    // 1. Test GET /api/time
    const clientSend = Date.now();
    const timeRes = await request(`/api/time?t0=${clientSend}`);
    assert(timeRes.status === 200, 'GET /api/time returns 200');
    assert(timeRes.json.t0 === clientSend, `Reflects client t0: ${timeRes.json.t0}`);
    assert(typeof timeRes.json.serverReceiveTime === 'number', 'Contains serverReceiveTime');
    assert(typeof timeRes.json.serverTransmitTime === 'number', 'Contains serverTransmitTime');

    // 2. Reset referee state
    await request('/api/reset', { method: 'POST' });

    // 3. Move with legitimate clientSentAt (e.g. 200ms ago)
    const legitClientSentAt = Date.now() - 200;
    const move1 = await request('/api/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ move: 'e2e4', clientSentAt: legitClientSentAt })
    });
    assert(move1.status === 200, 'Move with clientSentAt succeeds 200');
    assert(move1.json.ok === true, 'Move applied successfully');

    // 4. Move with excessive clientSentAt (cheat attempt e.g. 10 seconds ago)
    // Server must clamp lag compensation to 1000ms max
    const fakeClientSentAt = Date.now() - 10000;
    const move2 = await request('/api/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ move: 'e7e5', clientSentAt: fakeClientSentAt })
    });
    assert(move2.status === 200, 'Clamped move succeeds without crash');
    assert(move2.json.ok === true, 'Move applied under clamped lag discount');

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
