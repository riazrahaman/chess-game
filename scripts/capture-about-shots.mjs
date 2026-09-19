// One-off: capture About-page screenshots (Play / Analysis / Puzzles) from the
// locally-running server on :39281 into assets/about/. Not wired into any npm
// script — run manually: node scripts/capture-about-shots.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:39281';
const OUT = path.resolve('assets/about');
const VIEWPORT = { width: 1280, height: 900 };

fs.mkdirSync(OUT, { recursive: true });

const shots = [
  { name: 'play.png', hash: '#/play', waitMs: 3500, full: false },
  { name: 'analysis.png', hash: '#/analysis', waitMs: 4500, full: false },
  { name: 'puzzles.png', hash: '#/puzzles', waitMs: 4000, full: false },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });

for (const s of shots) {
  const url = BASE + '/' + s.hash;
  console.log('capturing', s.name, '<-', url);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(s.waitMs);
  const file = path.join(OUT, s.name);
  await page.screenshot({ path: file, fullPage: s.full });
  const size = fs.statSync(file).size;
  console.log('  wrote', file, size, 'bytes');
}

await browser.close();
console.log('done');
