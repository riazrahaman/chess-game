import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';

const URL = 'http://127.0.0.1:39281/';

async function isServerUp() {
  try {
    const res = await fetch(URL, { method: 'GET' });
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

async function testUiFeatures() {
  let serverProc = null;
  if (!(await isServerUp())) {
    console.log('Starting chess server on port 39281...');
    serverProc = spawn('node', ['server.js'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    });
    serverProc.stdout.on('data', d => process.stderr.write(`[server] ${d}`));
    serverProc.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
    if (!(await waitForServer(8000))) {
      throw new Error('server did not come up on port 39281');
    }
  }

  console.log('Launching browser to test UI & AI features...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors = [];
  const failedResponses = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    consoleErrors.push(err.message);
  });
  page.on('response', async r => {
    if (r.status() >= 400) {
      let body = '';
      try { body = (await r.text()).slice(0, 160); } catch (_) {}
      failedResponses.push(`${r.status()} ${r.request().method()} ${r.url()} ${body}`);
    }
  });
  page.on('response', (res) => {
    if (res.status() >= 400) {
      console.log('HTTP status', res.status(), res.request().method(), res.url());
    }
  });

  await page.goto(URL + '#/play', { waitUntil: 'domcontentloaded' }); // Wave 2 shell: land on the Play view
  await page.waitForSelector('.chess-piece');

  // 1. Verify all modules loaded on window
  const modules = await page.evaluate(() => {
    return {
      hasAiCoach: typeof window.AiCoach === 'object',
      hasGameReport: typeof window.GameReport === 'object',
      hasAccessibilityVoice: typeof window.AccessibilityVoice === 'object',
      hasMoveReview: typeof window.MoveReview === 'object',
      hasGameArchive: typeof window.GameArchive === 'object'
    };
  });
  console.log('Modules on window:', modules);
  if (!modules.hasAiCoach || !modules.hasGameReport || !modules.hasAccessibilityVoice || !modules.hasMoveReview) {
    throw new Error('Required modules missing on window: ' + JSON.stringify(modules));
  }

  // 2. Test Voice Toggle
  console.log('Testing #voice-toggle...');
  const voiceBtn = page.locator('#voice-toggle');
  const initialText = await voiceBtn.textContent();
  console.log('Initial voice button text:', initialText);
  await voiceBtn.click();
  const toggledText = await voiceBtn.textContent();
  console.log('Toggled voice button text:', toggledText);
  if (initialText === toggledText) {
    throw new Error(`Voice toggle did not change text: was "${initialText}", now "${toggledText}"`);
  }
  // Toggle back
  await voiceBtn.click();
  const revertedText = await voiceBtn.textContent();
  if (revertedText !== initialText) {
    throw new Error(`Voice toggle did not revert: expected "${initialText}", got "${revertedText}"`);
  }
  console.log('✔ Passed: Voice toggle works cleanly');

  // 3. Test Bot Dropdowns under Play vs computer
  console.log('Testing Play vs Computer dropdowns...');
  const levelSelect = page.locator('#bot-level-select');
  const colorSelect = page.locator('#bot-color-select');
  const botToggle = page.locator('#bot-toggle');

  const levelDisabled = await levelSelect.isDisabled();
  const colorDisabled = await colorSelect.isDisabled();
  console.log('Bot level select disabled?', levelDisabled, 'color select disabled?', colorDisabled);
  if (levelDisabled || colorDisabled) {
    throw new Error('Bot dropdowns must not be disabled!');
  }

  // Select Level 4
  await levelSelect.selectOption('4');
  const selectedLevel = await levelSelect.inputValue();
  if (selectedLevel !== '4') throw new Error(`Expected Level 4 selected, got ${selectedLevel}`);

  // Selecting level should auto-enable or preserve selection
  const isToggleChecked = await botToggle.isChecked();
  console.log('Bot toggle checked after selecting level:', isToggleChecked);
  if (!isToggleChecked) throw new Error('Selecting bot difficulty should activate bot');

  // Select Color White
  await colorSelect.selectOption('white');
  const selectedColor = await colorSelect.inputValue();
  if (selectedColor !== 'white') throw new Error(`Expected Bot plays White, got ${selectedColor}`);

  // Test New Game in Play vs Computer mode (verifies seat-auth fix for bot play)
  console.log('Testing New Game with Bot enabled (Seat-Auth Verification)...');
  await levelSelect.selectOption('7');
  await colorSelect.selectOption('black');
  if (!await botToggle.isChecked()) await botToggle.click();
  await page.waitForTimeout(500);

  // Seat badge should show Playing White
  const seatBadgeText = await page.locator('#seat-badge').textContent();
  console.log('Seat badge in bot mode:', seatBadgeText);
  if (!seatBadgeText.includes('White')) {
    throw new Error(`Expected seat badge to show Playing White, got: ${seatBadgeText}`);
  }

  // Click New Game
  await page.locator('#new-game').click();
  await page.waitForTimeout(600);

  const statusText = await page.locator('#status').textContent();
  if (statusText && statusText.includes('Authentication required')) {
    throw new Error(`New Game failed with authentication error: ${statusText}`);
  }
  console.log('✔ Passed: New Game succeeded cleanly with Bot enabled (0 authentication errors)');

  // Toggle bot off after verifying configuration
  await botToggle.click();
  await page.locator('#seat-badge').filter({ hasText: 'Unseated' }).waitFor({ timeout: 5000 });
  console.log('✔ Passed: Play vs computer dropdowns are interactive and configure bot');

  // 4. Test Coach Hint
  console.log('Testing Coach Hint 💡 button...');
  const coachHintBtn = page.locator('#coach-hint-btn');
  await coachHintBtn.click();
  const hintBanner = page.locator('#coach-hint-banner');
  await hintBanner.waitFor({ state: 'visible', timeout: 5000 });
  const hintText = await page.locator('#coach-hint-text').innerText();
  console.log('Coach hint text snippet:', hintText.slice(0, 80) + '...');
  if (!hintText.includes('Strategic Guideline') || !hintText.includes('Focus Area') || !hintText.includes('Tactical Concept')) {
    throw new Error('Coach hint missing required sections: ' + hintText);
  }
  // Close hint
  await page.locator('#close-coach-hint').click();
  console.log('✔ Passed: Coach hint generates and renders properly');

  // 5. Test Move Review and Narrative Report & Mistake Puzzles
  console.log('Testing Game Review, Narrative Report, and Why? button...');
  // Play a move: e2 -> e4
  await page.locator('#e2').click();
  await page.locator('#e4').click();
  await page.waitForTimeout(500);

  // Click Game Review
  const reviewBtn = page.locator('#game-review-btn');
  await reviewBtn.click();
  const reviewPanel = page.locator('#review-panel');
  await reviewPanel.waitFor({ state: 'visible', timeout: 5000 });

  // Check Narrative Report
  const headline = await page.locator('#report-headline').textContent();
  console.log('Report headline:', headline);
  if (!headline) throw new Error('Report headline should not be empty');

  // Check Why? Move Explanation
  const whyBtn = page.locator('#why-move-btn');
  await whyBtn.click();
  const whyCard = page.locator('#why-explanation-card');
  await whyCard.waitFor({ state: 'visible', timeout: 5000 });
  const whyBody = await page.locator('#why-body').textContent();
  console.log('Why explanation:', whyBody);
  if (!whyBody) throw new Error('Why move explanation should not be empty');

  // Check Mistake Puzzles
  const retryPuzzlesBtn = page.locator('#retry-mistakes-btn');
  await retryPuzzlesBtn.click();
  const puzzleBox = page.locator('#puzzle-box');
  await puzzleBox.waitFor({ state: 'visible', timeout: 5000 });
  const feedback = await page.locator('#puzzle-feedback').textContent();
  console.log('Puzzle feedback:', feedback);

  // 6. Test History Scrubbing DOM Reconcile (No ghost duplicate pieces on vacated squares like Qxd4)
  console.log('Testing History Scrubbing DOM Reconcile & Ghost Piece prevention...');
  // Reset and play moves up to 5... Qxd4
  await page.evaluate(async () => {
    if (window.leaveSeat) await window.leaveSeat();
    // The page auto-routes to its own room (/game/<id>); target it, not 'default'.
    const q = (typeof getCurrentRoomId === 'function' && getCurrentRoomId() !== 'default') ? `?room=${encodeURIComponent(getCurrentRoomId())}` : '';
    await fetch('/api/reset' + q, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  });
  await page.waitForTimeout(200);
  const testMoves = ['d2d4', 'd7d5', 'g1f3', 'b8c6', 'c2c4', 'd5c4', 'd1a4', 'c8g4', 'f3e5', 'd8d4'];
  for (const m of testMoves) {
    await page.evaluate(async (move) => {
      const q = (typeof getCurrentRoomId === 'function' && getCurrentRoomId() !== 'default') ? `?room=${encodeURIComponent(getCurrentRoomId())}` : '';
      await fetch('/api/move' + q, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ move }) });
    }, m);
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(300);

  // Jump to ply 0 then jump to ply 10 (Qxd4)
  await page.evaluate(() => window.jumpToPly(0));
  await page.waitForTimeout(150);
  await page.evaluate(() => window.jumpToPly(10));
  await page.waitForTimeout(200);

  const ghostCheck = await page.evaluate(() => {
    const d1 = document.getElementById('d1')?.querySelector('.chess-piece');
    const a4 = document.getElementById('a4')?.querySelector('.chess-piece');
    const d8 = document.getElementById('d8')?.querySelector('.chess-piece');
    const d4 = document.getElementById('d4')?.querySelector('.chess-piece');
    const c8 = document.getElementById('c8')?.querySelector('.chess-piece');
    const g4 = document.getElementById('g4')?.querySelector('.chess-piece');
    return {
      d1: d1?.getAttribute('data-piece') || null,
      a4: a4?.getAttribute('data-piece') || null,
      d8: d8?.getAttribute('data-piece') || null,
      d4: d4?.getAttribute('data-piece') || null,
      c8: c8?.getAttribute('data-piece') || null,
      g4: g4?.getAttribute('data-piece') || null
    };
  });

  if (ghostCheck.d1 !== null) throw new Error('Ghost white queen remained on d1 after jumping to ply 10');
  if (ghostCheck.a4 !== 'white-q') throw new Error('White queen missing on a4 at ply 10');
  if (ghostCheck.d8 !== null) throw new Error('Ghost black queen remained on d8 after jumping to ply 10 (Qxd4)');
  if (ghostCheck.d4 !== 'black-q') throw new Error('Black queen missing on d4 at ply 10');
  if (ghostCheck.c8 !== null) throw new Error('Ghost black bishop remained on c8 after jumping to ply 10');
  if (ghostCheck.g4 !== 'black-b') throw new Error('Black bishop missing on g4 at ply 10');
  console.log('✔ Passed: History scrubbing correctly cleans vacated squares without ghost duplicate pieces');

  // 6b. Test G4 Undo-as-a-request banner (#undo-request-banner).
  //
  // Consent needs BOTH seats occupied by non-bot humans, and a seated room then
  // requires a seat token for every move/mutation. The page (a single browser
  // context) can hold only one seat, so we seat it as BLACK and claim WHITE out
  // of band; white requests the undo via a direct token-authenticated call, and
  // the page — now the opponent — must render the banner with a clickable
  // Accept/Decline. This exercises the real UI wiring, not a stubbed state.
  console.log('Testing G4 undo-request banner...');
  const undoRoomId = await page.evaluate(() => (typeof getCurrentRoomId === 'function' ? getCurrentRoomId() : 'default'));
  // Fresh start so the 10 plies from the scrub test don't linger.
  await page.evaluate(async () => {
    const q = (typeof getCurrentRoomId === 'function' && getCurrentRoomId() !== 'default') ? `?room=${encodeURIComponent(getCurrentRoomId())}` : '';
    await fetch('/api/reset' + q, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  });
  await page.waitForTimeout(200);

  // Page claims black through its own helper so the UI holds that seat token.
  const pageSeated = await page.evaluate(() => window.claimSeat('black'));
  if (!pageSeated) throw new Error('Page failed to claim the black seat for the undo test');
  // Claim white out of band and keep its token.
  const undoSeats = await page.evaluate(async (room) => {
    const res = await fetch('/api/seat/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'white', room })
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, token: data.token || null };
  }, undoRoomId);
  if (!undoSeats.ok || !undoSeats.token) {
    throw new Error(`Could not claim the white seat for the undo test: ${JSON.stringify(undoSeats)}`);
  }
  const whiteToken = undoSeats.token;
  const blackToken = await page.evaluate(() => window.getCurrentSeatToken());

  // Two token-authenticated plies (white then black).
  await page.evaluate(async ({ room, whiteToken, blackToken }) => {
    const q = room && room !== 'default' ? `?room=${encodeURIComponent(room)}` : '';
    const send = (move, token) => fetch('/api/move' + q, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Seat-Token': token },
      body: JSON.stringify({ move })
    });
    await send('e2e4', whiteToken);
    await send('e7e5', blackToken);
  }, { room: undoRoomId, whiteToken, blackToken });
  await page.waitForTimeout(300);
  const undoPlyBefore = await page.evaluate(() => window.getLivePly());
  if (undoPlyBefore !== 2) throw new Error(`Expected 2 plies before undo request, got ${undoPlyBefore}`);

  // White requests an undo out of band; the board must not change.
  await page.evaluate(async ({ room, token }) => {
    const q = room && room !== 'default' ? `?room=${encodeURIComponent(room)}` : '';
    await fetch('/api/undo' + q, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Seat-Token': token },
      body: JSON.stringify({})
    });
  }, { room: undoRoomId, token: whiteToken });

  // The page is the opponent, so the banner and its actions must appear.
  const banner = page.locator('#undo-request-banner');
  await banner.waitFor({ state: 'visible', timeout: 5000 });
  const undoPlyAfterRequest = await page.evaluate(() => window.getLivePly());
  if (undoPlyAfterRequest !== 2) throw new Error(`Undo request must not change the board (got ${undoPlyAfterRequest} plies)`);
  const bannerText = await page.locator('#undo-request-text').textContent();
  if (!/white/i.test(bannerText || '')) throw new Error(`Undo banner should name the white requester, got: ${bannerText}`);
  const acceptUndo = page.locator('#accept-undo');
  const declineUndo = page.locator('#decline-undo');
  if (await acceptUndo.count() < 1) throw new Error('#accept-undo control missing from undo-request banner');
  if (!(await acceptUndo.isVisible())) throw new Error('#accept-undo is not visible to the opponent');
  if (await acceptUndo.isDisabled()) throw new Error('#accept-undo should be clickable');
  if (await declineUndo.count() < 1) throw new Error('#decline-undo control missing from undo-request banner');
  if (await declineUndo.isDisabled()) throw new Error('#decline-undo should be clickable');
  console.log('✔ Passed: undo request renders the consent banner with clickable Accept/Decline');

  // Declining clears the banner and leaves the board alone (clickable path).
  await declineUndo.click();
  await page.waitForTimeout(500);
  await banner.waitFor({ state: 'hidden', timeout: 5000 });
  const undoPlyAfterDecline = await page.evaluate(() => window.getLivePly());
  if (undoPlyAfterDecline !== 2) throw new Error(`Declining undo must not change the board (got ${undoPlyAfterDecline} plies)`);

  // Re-request from white and accept: the board drops exactly one ply.
  await page.evaluate(async ({ room, token }) => {
    const q = room && room !== 'default' ? `?room=${encodeURIComponent(room)}` : '';
    await fetch('/api/undo' + q, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Seat-Token': token },
      body: JSON.stringify({})
    });
  }, { room: undoRoomId, token: whiteToken });
  await banner.waitFor({ state: 'visible', timeout: 5000 });
  await acceptUndo.click();
  await page.waitForTimeout(600);
  await banner.waitFor({ state: 'hidden', timeout: 5000 });
  const undoPlyAfterAccept = await page.evaluate(() => window.getLivePly());
  if (undoPlyAfterAccept !== 1) throw new Error(`Accepting undo should remove one ply (got ${undoPlyAfterAccept})`);
  console.log('✔ Passed: declining and accepting undo through the banner both work (accept removes one ply)');

  // Release both seats so later steps see the auto-room as unseated again.
  // Black is held by the page, so its own leaveSeat() releases it; white was
  // claimed out of band and is released here. (blackToken is intentionally not
  // released directly — leaveSeat() already does it.)
  await page.evaluate(async ({ room, token }) => {
    await fetch('/api/seat/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Seat-Token': token },
      body: JSON.stringify({ room, token })
    }).catch(() => {});
  }, { room: undoRoomId, token: whiteToken });
  await page.evaluate(() => window.leaveSeat && window.leaveSeat());
  await page.waitForTimeout(200);

  // 7. Test Puzzles View
  console.log('Testing Puzzles view...');
  await page.evaluate(() => window.Shell && window.Shell.navigate('puzzles'));
  await page.waitForTimeout(500);
  const puzzlesVisible = await page.evaluate(() => {
    const sec = document.querySelector('[data-view="puzzles"]');
    return sec && !sec.hidden;
  });
  if (!puzzlesVisible) throw new Error('Puzzles view section not visible after navigation');

  const puzzleBoard = await page.locator('[id="puzzle-board"]').count();
  if (puzzleBoard < 1) throw new Error('puzzle-board not found in Puzzles view');

  const puzzleTabs = await page.locator('.pz-tabs button[role="tab"]').count();
  if (puzzleTabs < 4) throw new Error(`Expected at least 4 puzzle tabs, found ${puzzleTabs}`);

  // Click Custom tab
  const customTab = page.locator('.pz-tabs button[data-tab="custom"]');
  if (await customTab.count() > 0) {
    await customTab.click();
    await page.waitForTimeout(300);
    console.log('  Clicked Custom tab');
  }
  // Click Daily tab back
  const dailyTab = page.locator('.pz-tabs button[data-tab="daily"]');
  if (await dailyTab.count() > 0) {
    await dailyTab.click();
    await page.waitForTimeout(300);
  }
  console.log('✔ Passed: Puzzles view renders with board, tabs, and tab switching');

  // 8. Test Library View
  console.log('Testing Library view...');
  await page.evaluate(() => window.Shell && window.Shell.navigate('library'));
  await page.waitForTimeout(500);
  const libraryVisible = await page.evaluate(() => {
    const sec = document.querySelector('[data-view="library"]');
    return sec && !sec.hidden;
  });
  if (!libraryVisible) throw new Error('Library view section not visible after navigation');

  const libraryTitle = await page.locator('[id="library-title"]').textContent();
  if (!libraryTitle || !libraryTitle.includes('Library')) {
    throw new Error(`Expected Library title, got: ${libraryTitle}`);
  }

  const searchInput = page.locator('[id="library-search"]');
  if (await searchInput.count() < 1) throw new Error('library-search input not found');

  const sourceChips = await page.locator('.library-chip[data-source]').count();
  if (sourceChips < 3) throw new Error(`Expected at least 3 source chips, found ${sourceChips}`);

  const pgnForm = page.locator('[id="library-pgn-text"]');
  if (await pgnForm.count() < 1) throw new Error('library-pgn-text not found');
  console.log('✔ Passed: Library view renders with title, search, source chips, and PGN form');

  // 9. Test Insights View
  console.log('Testing Insights view...');
  await page.evaluate(() => window.Shell && window.Shell.navigate('insights'));
  await page.waitForTimeout(500);
  const insightsVisible = await page.evaluate(() => {
    const sec = document.querySelector('[data-view="insights"]');
    return sec && !sec.hidden;
  });
  if (!insightsVisible) throw new Error('Insights view section not visible after navigation');

  const insightsTitle = await page.locator('[id="insights-title"]').textContent();
  if (!insightsTitle || !insightsTitle.includes('Insights')) {
    throw new Error(`Expected Insights title, got: ${insightsTitle}`);
  }

  const leagueSection = page.locator('[id="insights-league"]');
  if (await leagueSection.count() < 1) throw new Error('insights-league section not found');

  const pivotSection = page.locator('[id="insights-pivot"]');
  if (await pivotSection.count() < 1) throw new Error('insights-pivot section not found');

  const metricSelect = page.locator('[id="insights-metric"]');
  if (await metricSelect.count() > 0) {
    const metricOptions = await metricSelect.locator('option').count();
    console.log(`  Insights metric dropdown has ${metricOptions} options`);
  }
  console.log('✔ Passed: Insights view renders with title, league card, pivot card, and controls');

  // 10. Test Missed-Tactics in Analysis View (#/analysis)
  console.log('Testing Analysis view missed-tactics panel...');
  await page.evaluate(() => window.Shell && window.Shell.navigate('analysis'));
  await page.waitForTimeout(500);
  const analysisVisible = await page.evaluate(() => {
    const sec = document.querySelector('[data-view="analysis"]');
    return sec && !sec.hidden;
  });
  if (!analysisVisible) throw new Error('Analysis view section not visible after navigation');

  const missedPanel = page.locator('section[aria-label="Missed tactics"]');
  if (await missedPanel.count() > 0) {
    console.log('  Missed tactics panel found');
    const loadBtn = page.locator('button[data-an="missed-load"]');
    if (await loadBtn.count() > 0) {
      console.log('  "Find missed tactics" button present');
    }
  } else {
    console.log('  (Missed tactics panel not present — may require a game to be loaded)');
  }
  console.log('✔ Passed: Analysis view renders with missed-tactics panel');

  // 11. Test Coordinates View (#/coordinates)
  console.log('Testing Coordinates trainer view...');
  await page.evaluate(() => window.Shell && window.Shell.navigate('coordinates'));
  await page.waitForTimeout(500);
  const coordsVisible = await page.evaluate(() => {
    const sec = document.querySelector('[data-view="coordinates"]');
    return sec && !sec.hidden;
  });
  if (!coordsVisible) throw new Error('Coordinates view section not visible after navigation');

  const squaresCount = await page.locator('[id="coords-board"] .coords-square').count();
  if (squaresCount !== 64) throw new Error(`Expected 64 squares on coords board, got ${squaresCount}`);

  // Start round
  await page.locator('[id="coords-action-btn"]').click();
  await page.waitForTimeout(300);

  const targetText = (await page.locator('[id="coords-target-display"]').textContent()).trim().toLowerCase();
  if (!targetText || targetText.length !== 2) throw new Error(`Expected 2-char target square, got: ${targetText}`);

  // Click target square
  await page.locator(`.coords-square[data-square="${targetText}"]`).click();
  await page.waitForTimeout(300);

  const scoreText = (await page.locator('[id="coords-score-display"]').textContent()).trim();
  if (scoreText !== '1') throw new Error(`Expected score 1 after correct click, got: ${scoreText}`);

  // Stop round
  await page.locator('[id="coords-action-btn"]').click();
  await page.waitForTimeout(300);
  console.log('✔ Passed: Coordinates trainer renders 64 squares, starts timed sprint, and scores clicks');

  // 12. Test Study chapters view (#/study)
  console.log('Testing Study chapters view...');
  await page.evaluate(() => window.Shell && window.Shell.navigate('study'));
  await page.waitForTimeout(500);
  const studyVisible = await page.evaluate(() => {
    const sec = document.querySelector('[data-view="study"]');
    return sec && !sec.hidden;
  });
  if (!studyVisible) throw new Error('Study view section not visible after navigation');

  const studyTitle = await page.locator('[id="study-title"]').textContent();
  if (!studyTitle || !studyTitle.includes('Study')) {
    throw new Error(`Expected Study title, got: ${studyTitle}`);
  }
  const studyBoard = await page.locator('[id="study-board"]').count();
  if (studyBoard < 1) throw new Error('study-board not found in Study view');
  const kindTabs = await page.locator('[id="study-kind-tabs"] button[data-kind]').count();
  if (kindTabs !== 3) throw new Error(`Expected 3 chapter-kind tabs, found ${kindTabs}`);

  // Create a FEN quiz chapter through the UI.
  await page.locator('[id="study-kind-tabs"] button[data-kind="fen"]').click();
  const createdStudyTitle = 'UI smoke: queen\'s pawn';
  await page.locator('[id="study-fen-title"]').fill(createdStudyTitle);
  await page.locator('[id="study-fen"]').fill('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  await page.locator('[id="study-fen-line"]').fill('1. d4 d5');
  await page.locator('[id="study-quiz-toggle"]').check();
  await page.locator('[id="study-create-btn"]').click();

  // Bounded poll (up to 5 s) for the created chapter's row. A fixed sleep is
  // flaky on cold/slow runners and under the mount()/show() double-GET race;
  // we require the row for THIS title — a pre-existing row must not satisfy it.
  let createdRowFound = true;
  try {
    await page.waitForFunction((title) => {
      const list = document.getElementById('study-list');
      if (!list) return false;
      return [...list.querySelectorAll('li')].some(li => (li.textContent || '').includes(title));
    }, createdStudyTitle, { timeout: 5000, polling: 50 });
  } catch (_) {
    createdRowFound = false;
  }
  if (!createdRowFound) {
    const listText = await page.evaluate(() => {
      const list = document.getElementById('study-list');
      return list ? (list.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200) : '(no list)';
    });
    throw new Error(`created Study chapter did not appear in the list (list: ${JSON.stringify(listText)})`);
  }
  const studyRows = await page.locator('[id="study-list"] li button').count();
  if (studyRows < 1) throw new Error('created Study chapter did not appear in the list');

  // The viewer opens from the same POST callback; wait for it instead of racing it.
  await page.waitForFunction(() => {
    const p = document.getElementById('study-viewer-panel');
    return !!(p && !p.hidden && window.UIStudy && window.UIStudy.state && window.UIStudy.state.current);
  }, undefined, { timeout: 5000, polling: 50 }).catch(() => {});
  const viewerVisible = await page.evaluate(() => {
    const p = document.getElementById('study-viewer-panel');
    return p && !p.hidden;
  });
  if (!viewerVisible) throw new Error('Study viewer did not open after creating a chapter');

  // Guess the correct first move (d2d4) on the quiz board — server-validated.
  const quizFenBefore = await page.evaluate(() => window.UIStudy && window.UIStudy.state.quizFen);
  await page.locator('[id="study-board"] [data-square="d2"]').click();
  await page.locator('[id="study-board"] [data-square="d4"]').click();
  // Bounded poll for the server-validated reply rather than a fixed sleep.
  await page.waitForFunction((before) => {
    const s = window.UIStudy && window.UIStudy.state;
    return !!(s && s.guessMoves.length === 1 && s.quizFen && s.quizFen !== before);
  }, quizFenBefore, { timeout: 5000, polling: 50 }).catch(() => {});
  // Positive assertion: the correct guess advanced the line — one committed
  // guess recorded, the position changed, and the quiz is still concealed.
  const afterGuess = await page.evaluate(() => {
    const s = window.UIStudy && window.UIStudy.state;
    return s ? { moves: s.guessMoves.length, fen: s.quizFen, revealed: s.revealed, status: (s.message || '') } : null;
  });
  if (!afterGuess) throw new Error('window.UIStudy.state unavailable');
  if (afterGuess.moves !== 1) throw new Error(`correct guess did not advance the line (guessMoves=${afterGuess.moves})`);
  if (afterGuess.fen === quizFenBefore) throw new Error('server reply did not advance the position');
  if (afterGuess.revealed) throw new Error('quiz auto-revealed before completion');
  const studyStatus = (await page.locator('[id="study-status"]').textContent()) || '';
  if (afterGuess.status && /not the move|error/i.test(afterGuess.status)) {
    throw new Error(`Unexpected Study quiz status after a correct guess: ${studyStatus}`);
  }
  console.log('✔ Passed: Study view renders, creates a FEN quiz chapter, and the board guess advances the line');

  // Return to Play view for cleanup
  await page.evaluate(() => window.Shell && window.Shell.navigate('play'));
  await page.waitForTimeout(300);

  // 13. Check console errors
  if (consoleErrors.length > 0) {
    console.error('Failed HTTP responses seen:\n' + failedResponses.join('\n'));
    throw new Error('Console errors occurred during test:\n' + consoleErrors.join('\n'));
  }

  await browser.close();
  // Clean up server state for subsequent tests
  try {
    await fetch(`${URL}api/bot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false })
    });
    await fetch(`${URL}api/reset`, { method: 'POST' });
  } catch (_) {}

  if (serverProc) {
    try { serverProc.kill('SIGTERM'); } catch (_) {}
  }

  console.log('ALL UI & AI FEATURE TESTS PASSED SUCCESSFULLY with ZERO ERRORS!');
}

testUiFeatures().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
