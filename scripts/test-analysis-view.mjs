// Browser verification for the Analysis view (Wave 2 Worker D). Run with a server on 39286:
//   CHESS_PORT=39286 node server.js &   then   node scripts/test-analysis-view.mjs
import { chromium } from 'playwright';
import { setTimeout as sleep } from 'timers/promises';

const BASE = 'http://127.0.0.1:39286';
const room = 'w2d-' + Date.now().toString(36);
const failures = [];
const ok = (cond, msg) => { console.log((cond ? 'PASS: ' : 'FAIL: ') + msg); if (!cond) failures.push(msg); };

async function api(path, opts) {
  const r = await fetch(BASE + path, opts);
  return { status: r.status, body: await r.json().catch(() => null) };
}

// 1. seat + 5 moves in a room via /api/move?room=
const seat = await api('/api/seat/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'white', room }) });
console.log('seat', seat.status, JSON.stringify(seat.body).slice(0, 200));
const whiteTok = seat.body && seat.body.token;
const seatB = await api('/api/seat/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'black', room }) });
const blackTok = seatB.body && seatB.body.token;
const moves = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'];
for (let i = 0; i < moves.length; i++) {
  const tok = i % 2 === 0 ? whiteTok : blackTok;
  const r = await api(`/api/move?room=${room}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Seat-Token': tok || '' }, body: JSON.stringify({ move: moves[i], id: 'w2d-' + i }) });
  if (r.status !== 200) console.log('move', moves[i], r.status, JSON.stringify(r.body).slice(0, 200));
}
const st = await api(`/api/state?room=${room}`);
ok(st.body && st.body.positions && st.body.positions.length === 6, `room has 5 plies (positions ${st.body && st.body.positions && st.body.positions.length})`);

// 2. browser
const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
await page.goto(`${BASE}/game/${room}#/analysis`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-view="analysis"]:not([hidden]) [data-an="board"]', { timeout: 15000 });

// SAN list
await page.waitForFunction(() => document.querySelectorAll('[data-view="analysis"] [data-an="moves"] button[data-an-ply]').length >= 6, null, { timeout: 15000 });
const sans = await page.$$eval('[data-view="analysis"] [data-an="moves"] button[data-an-ply]', els => els.map(e => e.textContent));
ok(sans.join(' ') === 'start e4 e5 Nf3 Nc6 Bb5', `SAN list: ${sans.join(' ')}`);
const pieces = await page.$$eval('[data-view="analysis"] [data-an="board"] .square > .chess-piece', els => els.length);
ok(pieces === 32, `analysis board renders 32 pieces (got ${pieces})`);
const liveBoardUntouched = await page.$eval('#board', el => el.querySelectorAll('.an-last').length === 0);
ok(liveBoardUntouched, 'live #board not reused');

// Opening
await page.waitForFunction(() => /Ruy Lopez/.test((document.querySelector('[data-an="opening-name"]') || {}).textContent || ''), null, { timeout: 15000 });
const eco = await page.$eval('[data-an="opening-eco"]', e => e.textContent);
const name = await page.$eval('[data-an="opening-name"]', e => e.textContent);
ok(eco === 'C60' && /^Ruy Lopez$/.test(name), `opening ${eco} ${name}`);
const badge = await page.$eval('[data-an="book-badge"]', e => e.textContent);
ok(badge === 'book line', `book badge: ${badge}`);
const personal = await page.$eval('[data-an="personal"]', e => e.textContent);
ok(/Your games/.test(personal), `personal panel: ${personal}`);

// Engine MultiPV depth >= 12
await page.waitForFunction(() => {
  const lis = [...document.querySelectorAll('[data-view="analysis"] [data-an="lines"] li[data-an-line]')];
  return lis.length >= 2 && lis.every(li => Number(li.getAttribute('data-depth')) >= 12);
}, null, { timeout: 90000 });
const lines = await page.$$eval('[data-view="analysis"] [data-an="lines"] li[data-an-line]', els => els.map(e => ({ d: e.getAttribute('data-depth'), t: e.textContent.trim().slice(0, 60) })));
ok(lines.length >= 2, `MultiPV lines at depth>=12: ${JSON.stringify(lines)}`);
const engineLabel = await page.$eval('[data-an="engine-label"]', e => e.textContent);
console.log('engine label:', engineLabel);

// Scrub back and forward
await page.click('[data-an="prev"]');
const plyLabel = await page.$eval('[data-an="ply-label"]', e => e.textContent);
ok(/Ply 4/.test(plyLabel), `scrub prev → ${plyLabel}`);
await page.click('[data-an="last"]');

// Export PGN
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 10000 }),
  page.click('[data-an="export-pgn-white"]')
]);
ok(/\.pgn$/.test(download.suggestedFilename()), `download ${download.suggestedFilename()}`);
const pgnText = await page.$eval('[data-an="export-out"]', e => e.value);
ok(/1\. e4 e5 2\. Nf3 Nc6 3\. Bb5/.test(pgnText), `PGN text: ${pgnText.replace(/\n/g, ' | ').slice(0, 160)}`);

// FEN deep link
const fen = '8/8/8/8/8/4k3/8/4K2R w K - 0 1';
await page.goto(`${BASE}/#/analysis?fen=${encodeURIComponent(fen)}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(f => (document.querySelector('[data-an="fen-out"]') || {}).textContent === f, fen, { timeout: 15000 });
ok(true, 'FEN deep link loads position');
await sleep(4000);
const tb = await page.$eval('[data-an="tablebase"]', e => e.textContent);
console.log('tablebase panel:', tb.slice(0, 160));
ok(/win|draw|loss|offline|Probing/i.test(tb), 'tablebase panel rendered (online result or offline fallback)');

// Bad FEN rejected
await page.fill('[data-an="fen"]', 'not a fen');
await page.click('[data-an="load-fen"]');
await page.waitForFunction(() => /FEN rejected/.test((document.querySelector('[data-an="status"]') || {}).textContent || ''), null, { timeout: 5000 });
ok(true, 'invalid FEN rejected via /api/fen/validate');

// navigator.vibrate interventions come from ui-sound.js haptics reacting to the
// pre-played moves without a user gesture (Play view, not this view) — reported
// separately so they are visible but do not mask errors from the Analysis view.
const vibrate = consoleErrors.filter(e => /navigator\.vibrate/.test(e));
const real = consoleErrors.filter(e => !/navigator\.vibrate/.test(e));
if (vibrate.length) console.log(`note: ${vibrate.length} pre-existing navigator.vibrate intervention message(s) from ui-sound.js haptics`);
ok(real.length === 0, `0 console errors from the page (got ${real.length}) ${real.slice(0, 3).join(' || ')}`);
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL BROWSER CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
