#!/usr/bin/env node
'use strict';

/**
 * bot-service-cancel-selftest.js
 *
 * Regression for B23: a move scheduled by `triggerBotMoveIfNeeded` on a
 * 200-450 ms `setTimeout` must be cancelled when the bot is disabled or
 * reconfigured. Before the fix `setBotConfig({ enabled: false })` only deleted
 * the room entry, so the timer still fired, re-read the referee and played a
 * move onto a board the user had already disabled/reset/recoloured — a real
 * user-facing bug, not a test artifact.
 *
 * Standalone: stubs seatAuth + referee and overrides `computeBotMove`, so no
 * engine search and no server are involved. The real `thinkDelay` range is
 * 200-450 ms, so a settle window of THINK_DELAY_MAX_MS + 350 ms is used.
 */

const assert = require('assert');
const { BotService } = require('../src/bot-service.js');
const engineServer = require('../src/engine-server.js');

const THINK_DELAY_MAX_MS = 450;
const SETTLE_MS = THINK_DELAY_MAX_MS + 350;

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeSeatAuth() {
  let n = 0;
  return {
    claimSeat: () => ({ ok: true, token: 'bot-seat-' + (++n) }),
    releaseSeat: () => {},
    _getRoom: () => ({}),
    _isExpired: () => false
  };
}

function makeReferee() {
  const enqueued = [];
  const state = {
    board: { turn: 'white' },
    history: [],
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    gameOver: false,
    result: null
  };
  const ref = {
    state,
    enqueue(cmd) { enqueued.push(cmd); return Promise.resolve({ ok: true }); },
    addChatMessage(author, text) { return { author, text }; }
  };
  return { referee: { getReferee: () => ref }, enqueued, state };
}

function makeBot() {
  const bot = new BotService(makeSeatAuth());
  bot.computeBotMove = async () => 'e2e4';
  return bot;
}

const ROOM = 'cancel-selftest';

test('an enabled bot on its turn still plays after the think delay (behaviour preserved)', async () => {
  const bot = makeBot();
  const { referee, enqueued } = makeReferee();
  bot.setBotConfig(ROOM, { enabled: true, color: 'white', level: 3 });
  const scheduled = bot.triggerBotMoveIfNeeded(ROOM, referee, () => {});
  assert.strictEqual(scheduled, true, 'bot move should have been scheduled');
  await delay(SETTLE_MS);
  assert.strictEqual(enqueued.length, 1, 'the enabled bot should enqueue exactly one move');
  assert.strictEqual(enqueued[0].args.move, 'e2e4', 'the bot should enqueue the computed move');
});

test('disabling the bot cancels an already-scheduled move', async () => {
  const bot = makeBot();
  const { referee, enqueued } = makeReferee();
  bot.setBotConfig(ROOM, { enabled: true, color: 'white', level: 3 });
  assert.strictEqual(bot.triggerBotMoveIfNeeded(ROOM, referee, () => {}), true);
  bot.setBotConfig(ROOM, { enabled: false });
  await delay(SETTLE_MS);
  assert.strictEqual(enqueued.length, 0, 'a disabled bot must not enqueue a straggler move');
});

test("recolouring the bot cancels the old colour's already-scheduled move", async () => {
  const bot = makeBot();
  const { referee, enqueued } = makeReferee();
  bot.setBotConfig(ROOM, { enabled: true, color: 'white', level: 3 });
  assert.strictEqual(bot.triggerBotMoveIfNeeded(ROOM, referee, () => {}), true);
  bot.setBotConfig(ROOM, { enabled: true, color: 'black', level: 3 });
  await delay(SETTLE_MS);
  assert.strictEqual(enqueued.length, 0, 'the stale white timer must not move after a recolour to black');
});

test('disable then re-enable leaves the bot schedulable (thinking not stuck)', async () => {
  const bot = makeBot();
  const { referee, enqueued } = makeReferee();
  bot.setBotConfig(ROOM, { enabled: true, color: 'white', level: 3 });
  bot.triggerBotMoveIfNeeded(ROOM, referee, () => {});
  bot.setBotConfig(ROOM, { enabled: false });
  bot.setBotConfig(ROOM, { enabled: true, color: 'white', level: 3 });
  assert.strictEqual(bot.getBotConfig(ROOM).enabled, true, 'bot should be enabled again');
  assert.strictEqual(bot.triggerBotMoveIfNeeded(ROOM, referee, () => {}), true, 'a fresh generation must be schedulable');
  await delay(SETTLE_MS);
  assert.strictEqual(enqueued.length, 1, 'exactly one move from the new generation');
});

test('reconfiguring the bot while computeBotMove is in flight drops the stale move (post-await guard)', async () => {
  const bot = makeBot();
  const { referee, enqueued } = makeReferee();
  // A controllable search so we can disable the bot *while* it is "thinking".
  let resolveMove;
  let searchStarted = false;
  bot.computeBotMove = () => {
    searchStarted = true;
    return new Promise((resolve) => { resolveMove = resolve; });
  };
  bot.setBotConfig(ROOM, { enabled: true, color: 'white', level: 3 });
  assert.strictEqual(bot.triggerBotMoveIfNeeded(ROOM, referee, () => {}), true);
  // Wait for the think delay to elapse and the search to begin.
  await delay(SETTLE_MS);
  assert.strictEqual(searchStarted, true, 'the scheduled move should have started its search');
  // Disable the bot mid-search, then let the search resolve with a legal move.
  bot.setBotConfig(ROOM, { enabled: false });
  resolveMove('e2e4');
  await delay(50);
  assert.strictEqual(enqueued.length, 0, 'a move whose search outlived a disable must not be enqueued');
});

(async () => {
  console.log('=== Running Bot Service Cancellation Self-Tests ===\n');
  for (const t of tests) {
    try {
      await t.fn();
      console.log('PASS: ' + t.name);
      passed++;
    } catch (err) {
      console.error('FAIL: ' + t.name, err);
      failed++;
    }
  }
  console.log(`\n--- Summary: ${passed} passed, ${failed} failed ---`);
  try { await engineServer.shutdown(); } catch (_) {}
  process.exit(failed > 0 ? 1 : 0);
})();
