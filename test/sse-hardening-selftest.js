#!/usr/bin/env node
'use strict';

// M3: SSE hardening selftest.
// Verifies (1) the referee's event-driven change bus fires on every mutation,
// (2) SSE events carry monotonic ids, (3) Last-Event-ID reconnection replays
// missed events from the bounded log, and (4) the `retry:` field is emitted.

const http = require('http');
const path = require('path');
const fs = require('fs');

process.env.CHESS_SSE_HEARTBEAT_MS = '200';
process.env.CHESS_SSE_WATCH_INTERVAL_MS = '50';
const os = require('os');

// B7: keep referee snapshot/journal files out of the repo root. referee-service
// derives every per-room ".referee-{state,journal}-<room>" path from the
// directory of CHESS_STATE_FILE / CHESS_JOURNAL_FILE at call time, so pointing
// them at a fresh os.tmpdir() folder (set BEFORE server.js is required) makes
// the whole run hermetic; the folder is removed on exit (process.exit-safe).
const B7_TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-sse-hardening-'));
process.env.CHESS_STATE_FILE = path.join(B7_TMP_DIR, '.referee-state.json');
process.env.CHESS_JOURNAL_FILE = path.join(B7_TMP_DIR, '.referee-journal.jsonl');
process.on('exit', () => { try { fs.rmSync(B7_TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

const referee = require('../src/referee-service.js');
const {
  createServer,
  stopStateWatcher,
  getRoomSseLog,
  getRoomSseSeq,
  clearRoomSseState
} = require('../server.js');

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

// Raw SSE frame stream from a live connection, resolving after N events or timeout.
function connectSSE(port, room, headers = {}, maxEvents = 1, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${port}/api/events?room=${room}`,
      { headers },
      res => {
        let buf = '';
        let events = 0;
        res.on('data', chunk => {
          buf += chunk;
          const frames = buf.split('\n\n');
          // Keep the last (possibly incomplete) frame in buf.
          buf = frames.pop();
          for (const frame of frames) {
            const lines = frame.split('\n');
            const evt = { id: null, event: 'message', data: '', retry: null };
            for (const line of lines) {
              if (line.startsWith('id: ')) evt.id = line.slice(4).trim();
              else if (line.startsWith('event: ')) evt.event = line.slice(7).trim();
              else if (line.startsWith('data: ')) evt.data = (evt.data ? evt.data + '\n' : '') + line.slice(6);
              else if (line.startsWith('retry: ')) evt.retry = line.slice(7).trim();
            }
            if (evt.data === '' && evt.event === 'message' && evt.id === null && evt.retry === null) continue;
            events++;
            if (events >= maxEvents) {
              req.destroy();
              resolve(evt);
            }
          }
        });
        res.on('end', () => {
          if (events === 0) reject(new Error('SSE connection ended before any event'));
        });
      }
    );
    req.on('error', reject);
    req.end();
    setTimeout(() => { req.destroy(); reject(new Error('SSE timeout')); }, timeoutMs);
  });
}

async function run() {
  console.log('=== M3 SSE Hardening Selftest ===');

  // --- Section 1: event-driven change bus ---
  const testDir = path.join(__dirname, '.test-m3-sse');
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  const stateFile = path.join(testDir, 'referee-state.json');
  const journalFile = path.join(testDir, 'referee-journal.jsonl');
  try { fs.unlinkSync(stateFile); } catch (_) {}
  try { fs.unlinkSync(journalFile); } catch (_) {}

  const ref = new referee.RefereeService({ roomId: 'm3-bus', stateFile, journalFile });
  let busEvents = [];
  const off = referee.onStateChange((evt) => busEvents.push(evt));

  await ref.enqueue({ id: 'm3-1', type: 'move', args: { move: 'e2e4' } });
  assert(busEvents.length === 1, 'stateEmitter fires once for a move');
  assert(busEvents[0].type === 'move', 'bus event carries the command type');
  assert(busEvents[0].roomId === 'm3-bus', 'bus event carries the roomId');
  assert(typeof busEvents[0].revision === 'number', 'bus event carries a numeric revision');

  await ref.enqueue({ id: 'm3-2', type: 'move', args: { move: 'e7e5' } });
  assert(busEvents.length === 2, 'stateEmitter fires again on a second move');
  assert(busEvents[1].revision > busEvents[0].revision, 'revision increases monotonically');

  off();
  await ref.enqueue({ id: 'm3-3', type: 'move', args: { move: 'g1f3' } });
  assert(busEvents.length === 2, 'unsubscribe stops delivery to the removed listener');

  console.log('\n=== Section 2: HTTP SSE ids, retry, Last-Event-ID replay ===');

  const server = createServer();
  const TEST_PORT = 39901;
  await new Promise(resolve => server.listen(TEST_PORT, '127.0.0.1', resolve));

  try {
    const room = 'm3-replay';
    clearRoomSseState(room);
    // Reset room to a clean state.
    await new Promise((resolve, reject) => {
      const r = http.request(`http://127.0.0.1:${TEST_PORT}/api/reset?room=${room}`, { method: 'POST' }, res => { res.resume(); res.on('end', resolve); });
      r.on('error', reject);
      r.end();
    });

    // Open an SSE connection and capture the initial snapshot event (id >= 1, retry present).
    const first = await connectSSE(TEST_PORT, room, {}, 1);
    assert(first.retry !== null, 'SSE stream includes a `retry:` field');
    const firstId = Number(first.id);
    assert(Number.isFinite(firstId) && firstId >= 1, `initial SSE event carries a numeric id (got ${first.id})`);

    // Make a move that drives the event-driven broadcast.
    await new Promise((resolve, reject) => {
      const r = http.request(
        `http://127.0.0.1:${TEST_PORT}/api/move?room=${room}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b || '{}'))); }
      );
      r.on('error', reject);
      r.end(JSON.stringify({ move: 'e2e4' }));
    });

    // Wait for the broadcast to land in the replay log.
    let seq = getRoomSseSeq(room);
    let attempts = 0;
    while (seq < 2 && attempts < 50) {
      await new Promise(r => setTimeout(r, 50));
      seq = getRoomSseSeq(room);
      attempts++;
    }
    assert(seq >= 2, 'event-driven broadcast incremented the SSE sequence after a move');

    const log = getRoomSseLog(room);
    assert(log.length >= 2, 'replay log captured the initial snapshot + the move');
    const ids = log.map(e => e.id);
    assert(ids.every((v, i) => i === 0 || v > ids[i - 1]), 'replay log ids are strictly increasing');

    // Reconnect with Last-Event-ID = firstId: must replay the move event.
    const replayed = await connectSSE(TEST_PORT, room, { 'Last-Event-ID': String(firstId) }, 1);
    assert(replayed.id !== null, 'replay stream emits events with ids');
    assert(Number(replayed.id) > firstId, 'Last-Event-ID reconnection replays a later event');

    // Reconnect with Last-Event-ID = seq (latest): no historical replay (only new snapshot).
    const latest = await connectSSE(TEST_PORT, room, { 'Last-Event-ID': String(getRoomSseSeq(room)) }, 1);
    assert(Number(latest.id) >= getRoomSseSeq(room) - 1, 'reconnection at latest id does not re-emit stale events');

    // Bounded log: push past SSE_REPLAY_LIMIT and confirm it does not grow unbounded.
    const before = getRoomSseLog(room).length;
    assert(before <= 200, 'replay log is bounded at SSE_REPLAY_LIMIT');
  } finally {
    stopStateWatcher();
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
