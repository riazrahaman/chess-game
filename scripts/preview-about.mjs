// Preview the #/about route in a clean context (no stale service worker),
// capture full-page screenshots for the canvas draft review.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:39281';
const OUT = path.resolve('.agent-grid/screenshots');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();

async function shot(theme, file) {
  const ctx = await browser.newContext({
    viewport: { width: 1180, height: 900 },
    deviceScaleFactor: 2,
    bypassCSP: false,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.addInitScript(t => {
    try { localStorage.setItem('chess.theme.mode', t); } catch (_) {}
  }, theme);

  await page.goto(BASE + '/#/about', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);

  const info = await page.evaluate(() => ({
    bodyView: document.body.getAttribute('data-shell-view'),
    hasSection: !!document.querySelector('[data-view="about"]'),
    navText: document.getElementById('shell-nav') ? document.getElementById('shell-nav').textContent.replace(/\s+/g, ' ').trim() : null,
    imgCount: document.querySelectorAll('[data-view="about"] img').length,
    heading: document.querySelector('[data-view="about"] h1') ? document.querySelector('[data-view="about"] h1').textContent : null,
  }));

  await page.screenshot({ path: file, fullPage: true });
  await ctx.close();
  return { info, errors };
}

const dark = await shot('dark', path.join(OUT, 'about-draft-dark.png'));
console.log('dark:', JSON.stringify(dark.info));
if (dark.errors.length) console.log('dark errors:', dark.errors.slice(0, 10));

const light = await shot('light', path.join(OUT, 'about-draft-light.png'));
console.log('light:', JSON.stringify(light.info));
if (light.errors.length) console.log('light errors:', light.errors.slice(0, 10));

await browser.close();
console.log('wrote', path.join(OUT, 'about-draft-dark.png'), path.join(OUT, 'about-draft-light.png'));
