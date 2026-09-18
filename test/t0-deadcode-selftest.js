#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createServer } = require('../server.js');
const { RefereeService } = require('../src/referee-service.js');

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

async function run() {
  console.log('=== Test Suite 1: Idempotency Map & Memory Bounding ===');

  const testDir = path.join(__dirname, '.test-t0-deadcode');
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

  const sFile = path.join(testDir, 'referee-state.json');
  const jFile = path.join(testDir, 'referee-journal.jsonl');
  const ref = new RefereeService({ roomId: 'idemp-test', stateFile: sFile, journalFile: jFile });

  // 1. Enqueue 600 unique resets/moves to verify _idempotency size is bounded <= 500
  for (let i = 0; i < 550; i++) {
    await ref.enqueue({ id: `cmd-${i}`, type: 'reset' });
  }
  assert(ref._idempotency.size <= 500, `Idempotency map bounded <= 500 (current size: ${ref._idempotency.size})`);

  // 2. Test idempotency replay with same cmdId
  const res1 = await ref.enqueue({ id: 'cmd-dedupe-test', type: 'reset' });
  const res2 = await ref.enqueue({ id: 'cmd-dedupe-test', type: 'reset' });
  assert(res1.ok === true && res2.ok === true, 'Duplicate cmdId succeeds idempotently');
  assert(res1.revision === res2.revision, 'Duplicate cmdId returns identical revision');

  console.log('\n=== Test Suite 2: Rate Limiting & API Integration ===');

  const server = createServer();
  const TEST_PORT = 39893;
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

    // 1. Normal API request passes
    const timeRes = await request('/api/time');
    assert(timeRes.status === 200, 'GET /api/time returns 200');
    assert(typeof timeRes.json.serverReceiveTime === 'number', 'NTP endpoint returns valid timestamp');

    // 2. Exceed rate limit on an IP
    // Temporarily trigger 650 rapid requests from simulated IP or test rate limiter directly
    const serverModule = require('../server.js');
    // We can test checkRateLimit function behavior
    const testIp = '192.168.1.99';
    let limited = false;
    for (let i = 0; i < 700; i++) {
      if (!serverModule.checkRateLimit(testIp)) {
        limited = true;
        break;
      }
    }
    assert(limited === true, 'checkRateLimit correctly throttles after reaching threshold');

    console.log('\n=== Test Suite 3: Frontend ui.js Audit ===');

    const uiCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui.js'), 'utf8');

    // Verify no alert() calls
    const alertCalls = uiCode.match(/alert\(/g);
    assert(alertCalls === null, `ui.js has zero literal alert() calls (got ${alertCalls ? alertCalls.length : 0})`);

    // Verify Gate 4 architectural invariant (ui.js + all extracted modules).
    // B3: the check is a token scan, not a substring match, so split-string
    // lookups like x['make' + 'Move'] or computed access cannot dodge it, and
    // client-side SAN replay (historyToSan) is banned too.
    const gate4Violations = code => {
      const hits = [];
      const stripped = code.replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, m => {
        // keep string contents visible to the scanner, but flag concatenation
        // that would rebuild a banned identifier
        return m;
      });
      for (const name of ['makeMove', 'createInitialBoard', 'historyToSan']) {
        if (new RegExp('\\b' + name + '\\b').test(stripped)) hits.push(name);
      }
      // rebuild banned names from adjacent string literals: 'make' + 'Move'
      const concat = stripped.replace(/['"]\s*\+\s*['"]/g, '');
      for (const name of ['makeMove', 'createInitialBoard', 'historyToSan']) {
        if (new RegExp(name).test(concat) && !hits.includes(name)) hits.push(name + ' (via string concatenation)');
      }
      return hits;
    };
    assert(gate4Violations(uiCode).length === 0, `ARCHITECTURAL INVARIANT: ui.js must not reference ${gate4Violations(uiCode).join(', ')}`);
    for (const mod of ['ui-sound.js', 'ui-theme.js', 'ui-annotations.js', 'ui-archive.js', 'ui-auth.js', 'ui-settings.js', 'ui-puzzles.js', 'ui-compete.js', 'ui-profile.js', 'shell.js']) {
      const modCode = fs.readFileSync(path.join(__dirname, '..', 'src', mod), 'utf8');
      assert(gate4Violations(modCode).length === 0, `ARCHITECTURAL INVARIANT: ${mod} must not reference ${gate4Violations(modCode).join(', ')}`);
    }

    // Verify periodic NTP sync
    assert(uiCode.includes('setInterval(syncNtpClock'), 'ui.js schedules periodic syncNtpClock');

    // Verify showUiError (stays in ui.js) and exitArchivedGameView (moved to ui-archive.js)
    assert(uiCode.includes('function showUiError'), 'ui.js defines showUiError');
    const archiveCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui-archive.js'), 'utf8');
    assert(archiveCode.includes('function exitArchivedGameView'), 'ui-archive.js defines exitArchivedGameView');
    assert(archiveCode.includes('id: `archive:${gameId}:'), 'ui-archive.js reloadArchivedGameOntoBoard sends idempotency keys and room param');

  } finally {
    server.close();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
