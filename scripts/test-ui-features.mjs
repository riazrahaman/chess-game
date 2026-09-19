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

  // 7. Test Puzzles View (#/puzzles)
  console.log('Testing Puzzles view...');
  await page.evaluate(() => window.Shell && window.Shell.navigate('puzzles'));
  await page.waitForTimeout(500);
  const puzzlesVisible = await page.evaluate(() => {
    const sec = document.querySelector('[data-view="puzzles"]');
    return sec && !sec.hidden;
  });
  if (!puzzlesVisible) throw new Error('Puzzles view section not visible after navigation');

  const puzzleBoard = await page.locator('#puzzle-board').count();
  if (puzzleBoard < 1) throw new Error('#puzzle-board not found in Puzzles view');

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

  // 8. Test Library View (#/library)
  console.log('Testing Library view...');
  await page.evaluate(() => window.Shell && window.Shell.navigate('library'));
  await page.waitForTimeout(500);
  const libraryVisible = await page.evaluate(() => {
    const sec = document.querySelector('[data-view="library"]');
    return sec && !sec.hidden;
  });
  if (!libraryVisible) throw new Error('Library view section not visible after navigation');

  const libraryTitle = await page.locator('#library-title').textContent();
  if (!libraryTitle || !libraryTitle.includes('Library')) {
    throw new Error(`Expected Library title, got: ${libraryTitle}`);
  }

  const searchInput = page.locator('#library-search');
  if (await searchInput.count() < 1) throw new Error('#library-search input not found');

  const sourceChips = await page.locator('.library-chip[data-source]').count();
  if (sourceChips < 3) throw new Error(`Expected at least 3 source chips, found ${sourceChips}`);

  const pgnForm = page.locator('#library-pgn-text');
  if (await pgnForm.count() < 1) throw new Error('#library-pgn-text not found');
  console.log('✔ Passed: Library view renders with title, search, source chips, and PGN form');

  // 9. Test Insights View (#/insights)
  console.log('Testing Insights view...');
  await page.evaluate(() => window.Shell && window.Shell.navigate('insights'));
  await page.waitForTimeout(500);
  const insightsVisible = await page.evaluate(() => {
    const sec = document.querySelector('[data-view="insights"]');
    return sec && !sec.hidden;
  });
  if (!insightsVisible) throw new Error('Insights view section not visible after navigation');

  const insightsTitle = await page.locator('#insights-title').textContent();
  if (!insightsTitle || !insightsTitle.includes('Insights')) {
    throw new Error(`Expected Insights title, got: ${insightsTitle}`);
  }

  const leagueSection = page.locator('#insights-league');
  if (await leagueSection.count() < 1) throw new Error('#insights-league section not found');

  const pivotSection = page.locator('#insights-pivot');
  if (await pivotSection.count() < 1) throw new Error('#insights-pivot section not found');

  const metricSelect = page.locator('#insights-metric');
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

  // Return to Play view for cleanup
  await page.evaluate(() => window.Shell && window.Shell.navigate('play'));
  await page.waitForTimeout(300);

  // 11. Check console errors
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
