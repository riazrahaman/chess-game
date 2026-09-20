#!/usr/bin/env node
'use strict';

/**
 * accounts-isolation-selftest.js — AccountsManager JSON-path precedence ladder.
 *
 * Bug: on Node < 22.5 (no node:sqlite) the AccountsManager JSON fallback used
 * `options.jsonPath || DEFAULT_JSON_PATH`, which DROPPED a caller-supplied
 * dbPath intent and silently pointed every manager at the one shared
 * src/.accounts.json. Two managers built with different dbPaths therefore
 * cross-contaminated accounts.
 *
 * This suite pins the fixed precedence ladder
 *   string options → options.jsonPath → ':memory:' → dbPath + '.json' → default
 * and proves the leak is closed. It never starts a server and writes only under
 * os.tmpdir().
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-accounts-isolation-'));
process.env.CHESS_ACCOUNTS_JSON_FILE = path.join(TMP, 'default-accounts.json');

const Accounts = require('../src/accounts.js');

const DEFAULT_JSON = process.env.CHESS_ACCOUNTS_JSON_FILE;

const hasSqlite = (() => {
  try {
    const { DatabaseSync } = require('node:sqlite');
    return typeof DatabaseSync === 'function';
  } catch (_) {
    return false;
  }
})();

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL: ${name} — ${err && err.stack ? err.stack : err}`);
  }
}

// Force the AccountsManager's SqliteAccountsAdapter construction to fail for the
// duration of fn(), so the JSON precedence ladder runs deterministically on both
// Node 20 (node:sqlite absent) and Node 26 (node:sqlite present).
const realModuleRequire = Module.prototype.require;
function withoutSqlite(fn) {
  Module.prototype.require = function patchedRequire(id) {
    if (id === 'node:sqlite') {
      throw new Error('node:sqlite disabled for isolation test');
    }
    return realModuleRequire.apply(this, arguments);
  };
  try {
    return fn();
  } finally {
    Module.prototype.require = realModuleRequire;
  }
}

function jsonPathOf(manager) {
  const storage = manager.storage;
  if (!storage || typeof storage.filePath !== 'string') return null;
  return storage.filePath;
}

const managers = [];
function track(manager) { managers.push(manager); return manager; }

console.log('=== AccountsManager isolation self-test ===\n');
console.log(`node:sqlite ${hasSqlite ? 'available' : 'unavailable (JSON fallback path)'}\n`);

// (a) precedence ladder — every shape is exercised through the JSON adapter so
// the assertion holds identically with or without node:sqlite.
test("(a) no explicit path → DEFAULT_JSON_PATH", () => {
  const manager = track(withoutSqlite(() => new Accounts.AccountsManager()));
  assert.strictEqual(jsonPathOf(manager), DEFAULT_JSON);
});

test("(a) string ':memory:' → ':memory:'", () => {
  const manager = track(withoutSqlite(() => new Accounts.AccountsManager(':memory:')));
  assert.strictEqual(jsonPathOf(manager), ':memory:');
});

test("(a) { jsonPath } → jsonPath verbatim", () => {
  const target = path.join(TMP, 'j.json');
  const manager = track(withoutSqlite(() => new Accounts.AccountsManager({ jsonPath: target })));
  assert.strictEqual(jsonPathOf(manager), target);
});

test("(a) { dbPath: ':memory:' } → ':memory:'", () => {
  const manager = track(withoutSqlite(() => new Accounts.AccountsManager({ dbPath: ':memory:' })));
  assert.strictEqual(jsonPathOf(manager), ':memory:');
});

test("(a) { dbPath } → '<dbPath>.json'", () => {
  const target = path.join(TMP, 'z.db');
  const manager = track(withoutSqlite(() => new Accounts.AccountsManager({ dbPath: target })));
  assert.strictEqual(jsonPathOf(manager), target + '.json');
});

test("(a) { forceJson, dbPath } → '<dbPath>.json'", () => {
  const target = path.join(TMP, 'q.db');
  const manager = track(new Accounts.AccountsManager({ forceJson: true, dbPath: target }));
  assert.strictEqual(jsonPathOf(manager), target + '.json');
});

if (hasSqlite) {
  test('(a) node:sqlite present → { dbPath } selects the Sqlite adapter', () => {
    const target = path.join(TMP, 'real.db');
    const manager = track(new Accounts.AccountsManager({ dbPath: target }));
    assert.strictEqual(manager.storage.constructor.name, 'SqliteAccountsAdapter');
  });
} else {
  console.log('SKIP: node:sqlite present → { dbPath } selects the Sqlite adapter (node:sqlite unavailable on Node < 22.5)');
}

// (b) the leak is closed: distinct dbPaths never share a store, and neither
// touches the shared default path.
test('(b) two managers with different dbPaths do not share accounts', () => {
  const a = track(new Accounts.AccountsManager({ dbPath: path.join(TMP, 'a.db') }));
  const b = track(new Accounts.AccountsManager({ dbPath: path.join(TMP, 'b.db') }));

  a.createAccount({ username: 'isolated-a', password: 'secret-a-1' });
  assert(a.getAccount('isolated-a'), 'manager A lost its own account');

  b.createAccount({ username: 'isolated-b', password: 'secret-b-1' });
  assert(b.getAccount('isolated-b'), 'manager B lost its own account');

  assert.strictEqual(b.getAccount('isolated-a'), null, 'manager B sees manager A\'s account — stores are shared');
  assert.strictEqual(a.getAccount('isolated-b'), null, 'manager A sees manager B\'s account — stores are shared');

  // Same username may be registered independently in each isolated store.
  a.createAccount({ username: 'dupe', password: 'pw-a-12345' });
  b.createAccount({ username: 'dupe', password: 'pw-b-12345' });
  assert(a.getAccount('dupe') && b.getAccount('dupe'), 'isolated stores could not each hold the same username');
});

test('(b) a dbPath manager never creates or modifies the shared default path', () => {
  const shared = DEFAULT_JSON;
  const before = fs.existsSync(shared) ? fs.statSync(shared).mtimeMs + ':' + fs.readFileSync(shared, 'utf8') : null;

  const manager = track(new Accounts.AccountsManager({ dbPath: path.join(TMP, 'c.db') }));
  manager.createAccount({ username: 'not-shared', password: 'secret-c-1' });

  const after = fs.existsSync(shared) ? fs.statSync(shared).mtimeMs + ':' + fs.readFileSync(shared, 'utf8') : null;
  assert.strictEqual(after, before, 'a dbPath-scoped manager wrote to the shared default accounts path');
});

for (const manager of managers) {
  try { manager.close(); } catch (_) {}
}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

console.log(`\n${failed > 0 ? 'Failed: ' + failed + ', ' : ''}Passed: ${passed}`);
process.exit(failed > 0 ? 1 : 0);
