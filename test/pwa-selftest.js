#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = __dirname;

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS: ${name}`);
}

const manifestPath = path.join(ROOT, '..', 'manifest.webmanifest');
const swPath = path.join(ROOT, '..', 'service-worker.js');
const indexPath = path.join(ROOT, '..', 'index.html');

console.log('=== PWA (M1) Self-Test ===\n');

test('manifest parses as valid JSON with required fields', () => {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  assert.strictEqual(typeof manifest.name, 'string');
  assert.strictEqual(typeof manifest.short_name, 'string');
  assert.strictEqual(typeof manifest.start_url, 'string');
  assert.strictEqual(typeof manifest.display, 'string');
  assert.ok(Array.isArray(manifest.icons));
});

test('manifest start_url is the app root', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.strictEqual(manifest.start_url, '/');
});

test('manifest icon file exists on disk', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const icon of manifest.icons) {
    const iconPath = path.join(ROOT, '..', icon.src.replace(/^\//, ''));
    assert.ok(fs.existsSync(iconPath), `icon missing: ${icon.src}`);
  }
});

test('service worker precache list covers every script in index.html', () => {
  const swSource = fs.readFileSync(swPath, 'utf8');
  const html = fs.readFileSync(indexPath, 'utf8');
  const htmlScripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  const htmlCss = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => m[1]);
  for (const asset of [...htmlScripts, ...htmlCss]) {
    assert.ok(swSource.includes(asset), `precache missing asset: ${asset}`);
  }
});

test('service worker precaches the manifest and root', () => {
  const swSource = fs.readFileSync(swPath, 'utf8');
  assert.ok(swSource.includes('/manifest.webmanifest'));
  assert.ok(swSource.includes("'/index.html'"));
  assert.ok(swSource.includes("'/'"));
});

test('service worker has install/activate/fetch handlers', () => {
  const swSource = fs.readFileSync(swPath, 'utf8');
  assert.ok(swSource.includes("addEventListener('install'"));
  assert.ok(swSource.includes("addEventListener('activate'"));
  assert.ok(swSource.includes("addEventListener('fetch'"));
  assert.ok(swSource.includes('cache.addAll'));
});

test('index.html links the manifest and registers the service worker (via src/sw-register.js)', () => {
  const html = fs.readFileSync(indexPath, 'utf8');
  assert.ok(html.includes('rel="manifest"'), 'missing <link rel="manifest">');
  // Wave 3 (D4): the registration block is no longer inline — CSP script-src has
  // no 'unsafe-inline' — it lives in src/sw-register.js, loaded as <script src>.
  assert.ok(/<script\s+src="src\/sw-register\.js"><\/script>/.test(html), 'index.html must load src/sw-register.js');
  const reg = fs.readFileSync(path.join(ROOT, '..', 'src', 'sw-register.js'), 'utf8');
  assert.ok(reg.includes("navigator.serviceWorker.register('/service-worker.js')"), 'missing SW registration in sw-register.js');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'index.html must not contain inline <script> blocks');
});

test('manifest and service worker are allowlisted in server.js', () => {
  const server = fs.readFileSync(path.join(ROOT, '..', 'server.js'), 'utf8');
  assert.ok(server.includes("'manifest.webmanifest'"), 'manifest not in ALLOWED_FILES');
  assert.ok(server.includes("'service-worker.js'"), 'service worker not in ALLOWED_FILES');
  assert.ok(server.includes("'.webmanifest'") || server.includes("'application/manifest+json'"), 'no webmanifest MIME mapping');
});

test('service worker never mutates referee game state', () => {
  const swSource = fs.readFileSync(swPath, 'utf8');
  assert.ok(!/makeMove\s*\(|createInitialBoard\s*\(/.test(swSource), 'Gate-4 violation in service worker');
});

console.log(`\nAll ${passed} tests passed successfully!`);
