import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';

const BASE_URL = 'http://127.0.0.1:39281/';
const PORT = 39281;
const POLL_TIMEOUT_MS = 15000;
const RESET_TIMEOUT_MS = 5000;

function fail(message) {
  console.error(`SMOKE TEST FAILED: ${message}`);
  process.exitCode = 1;
}

async function isServerUp() {
  try {
    const res = await fetch(BASE_URL, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerUp()) return true;
    await sleep(250);
  }
  return false;
}

// ui.js renders each piece as an outer <svg class="chess-piece"> that is a
// direct child of the .square div; updatePieceElement nests an identical SVG
// inside it, so the bare `.chess-piece` selector matches 2x per square. The
// direct-child selector `#board .square > .chess-piece` counts exactly one per
// piece = 32 for the starting position.
async function countBoardPieces(page) {
  return page.locator('#board .square > .chess-piece').count();
}

async function waitForPieces(page, expectedCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await countBoardPieces(page);
    if (count === expectedCount) return true;
    await sleep(200);
  }
  return false;
}

async function waitForSquareData(page, squareId, expectPiece, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const svg = await page.locator(`#${squareId} > .chess-piece`).count();
    const hasPiece = svg > 0;
    if (hasPiece === expectPiece) return true;
    await sleep(200);
  }
  return false;
}

async function readRefereeState() {
  const res = await fetch(`${BASE_URL}api/state?t=${Date.now()}`);
  if (!res.ok) throw new Error(`referee state fetch failed: ${res.status}`);
  return res.json();
}

async function postMove(moveStr) {
  const res = await fetch(`${BASE_URL}api/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ move: moveStr })
  });
  return res.json();
}

async function postReset() {
  const deadline = Date.now() + RESET_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}api/reset`, { method: 'POST' });
      const body = await res.json();
      if (res.ok && body.ok && body.reset) return true;
    } catch {
      // retry
    }
    await sleep(200);
  }
  return false;
}

async function main() {
  let browser = null;
  let serverProc = null;

  try {
    // 0. Ensure a clean referee state before the run (server may or may not be up yet).
    // We start the server first if needed, then reset.

    // Start the server if not already running.
    let serverStartedByUs = false;
    if (!(await isServerUp())) {
      console.log('Starting chess server (node server.js)...');
      serverProc = spawn('node', ['server.js'], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env }
      });
      serverProc.stdout.on('data', d => process.stderr.write(`[server] ${d}`));
      serverProc.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
      serverStartedByUs = true;
      if (!(await waitForServer(8000))) {
        throw new Error('server did not come up on port ' + PORT);
      }
      console.log('Server is up.');
    } else {
      console.log('Server already running.');
    }

    // Reset referee state first for a deterministic run.
    console.log('Resetting referee state...');
    if (!(await postReset())) {
      throw new Error('POST /api/reset did not confirm a reset');
    }

    // 1. Launch Chromium.
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on('console', msg => {
      const t = msg.type();
      if (t === 'error' || t === 'warning') {
        process.stderr.write(`[browser ${t}] ${msg.text()}\n`);
      }
    });
    page.on('pageerror', err => process.stderr.write(`[browser pageerror] ${err.message}\n`));

    console.log('Opening', BASE_URL);
    await page.goto(BASE_URL, { waitUntil: 'load' });

    // 2. Assert 32 .chess-piece SVG elements render on the 8x8 board.
    console.log('Waiting for 32 .chess-piece elements...');
    if (!(await waitForPieces(page, 32, POLL_TIMEOUT_MS))) {
      const found = await countBoardPieces(page);
      throw new Error(`expected 32 .chess-piece SVGs, found ${found}`);
    }
    const squareCount = await page.locator('#board .square').count();
    if (squareCount !== 64) {
      throw new Error(`expected 64 .square divs in #board, found ${squareCount}`);
    }
    console.log(`OK: 32 pieces on 64 squares.`);

    // Sanity: e2 should contain a white pawn before the move, e4 empty.
    if (!(await waitForSquareData(page, 'e2', true, 2000))) {
      throw new Error('precondition: e2 does not contain a piece');
    }
    if (!(await waitForSquareData(page, 'e4', false, 2000))) {
      throw new Error('precondition: e4 is not empty before move');
    }
    const e2PieceBefore = await page.locator('#e2 > .chess-piece').getAttribute('data-piece');
    if (e2PieceBefore !== 'white-p') {
      throw new Error(`precondition: e2 holds ${e2PieceBefore}, expected white-p`);
    }
    console.log(`OK: pre-move e2=${e2PieceBefore}, e4 empty.`);

    // 3. Click e2 then e4 (UI drives moves through the referee via /api/move).
    console.log('Clicking e2 then e4...');
    await page.locator('#e2').click();
    // Give the UI a moment to compute legal moves and apply the highlight.
    await sleep(150);
    await page.locator('#e4').click();

    // 4. Assert the move landed: e4 contains a white pawn, e2 empty.
    console.log('Waiting for move to render...');
    if (!(await waitForSquareData(page, 'e4', true, POLL_TIMEOUT_MS))) {
      throw new Error('post-move: e4 is empty (move did not land)');
    }
    if (!(await waitForSquareData(page, 'e2', false, POLL_TIMEOUT_MS))) {
      throw new Error('post-move: e2 is not empty (move did not clear source)');
    }
    const e4Piece = await page.locator('#e4 > .chess-piece').getAttribute('data-piece');
    if (e4Piece !== 'white-p') {
      throw new Error(`post-move: e4 holds ${e4Piece}, expected white-p`);
    }
    console.log(`OK: post-move e4=${e4Piece}, e2 empty.`);

    // 5. Assert the referee state reflects the move (history includes e2e4, turn black).
    let refereeState = null;
    const refereeDeadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < refereeDeadline) {
      refereeState = await readRefereeState();
      const last = refereeState.history && refereeState.history[refereeState.history.length - 1];
      if (last === 'e2e4' && refereeState.board && refereeState.board.turn === 'black') break;
      await sleep(200);
    }
    if (!refereeState) throw new Error('could not read referee state');
    const lastMove = refereeState.history && refereeState.history[refereeState.history.length - 1];
    const turn = refereeState.board && refereeState.board.turn;
    if (lastMove !== 'e2e4') {
      throw new Error(`referee history last move is ${lastMove}, expected e2e4`);
    }
    if (turn !== 'black') {
      throw new Error(`referee turn is ${turn}, expected black`);
    }
    console.log(`OK: referee history last=${lastMove}, turn=${turn}.`);

    console.log('\nSMOKE TEST PASSED: game boots, board renders 32 pieces, e2-e4 move lands, referee state reflects it.');
  } catch (err) {
    fail(err && err.message ? err.message : String(err));
  } finally {
    // Always close the browser.
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
      browser = null;
    }
    // Reset state after the test.
    try {
      if (await isServerUp()) {
        await postReset();
        console.log('Post-test reset done.');
      }
    } catch { /* best effort */ }
    // If we started the server, stop it.
    if (serverProc) {
      try { serverProc.kill('SIGTERM'); } catch { /* ignore */ }
      serverProc = null;
    }
  }

  if (process.exitCode === 1) {
    process.exit(1);
  }
}

main();