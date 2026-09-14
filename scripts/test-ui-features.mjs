import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:39281/';

async function testUiFeatures() {
  console.log('Launching browser to test UI & AI features...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    consoleErrors.push(err.message);
  });
  page.on('response', (res) => {
    if (res.status() >= 400) {
      console.log('HTTP status', res.status(), res.request().method(), res.url());
    }
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
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
  // Toggle bot off after verifying configuration
  await botToggle.click();
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

  // 6. Check console errors
  if (consoleErrors.length > 0) {
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

  console.log('ALL UI & AI FEATURE TESTS PASSED SUCCESSFULLY with ZERO ERRORS!');
}

testUiFeatures().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
