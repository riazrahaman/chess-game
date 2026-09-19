/**
 * ui-coordinates.js
 * Coordinates Trainer view for the site shell (G5).
 * 
 * Provides an interactive click-the-named-square mini-game (similar to lichess coordinates trainer):
 * - 30s / 60s timed sprints and untimed practice.
 * - White and Black perspectives (or Random alternating).
 * - Immediate visual and audio feedback on clicks.
 * - Score, accuracy, and streak tracking with persistent local high scores.
 * - Full keyboard typing input ("e4" + Enter or direct key press).
 * - ARIA live region for accessibility.
 * 
 * Gate 4 Invariant: Zero occurrences of referee mutators (pure UI view).
 */

(function () {
  'use strict';

  function getTrainer() {
    if (typeof window !== 'undefined' && window.CoordinatesTrainer) return window.CoordinatesTrainer;
    if (typeof require !== 'undefined') {
      try { return require('./coordinates-trainer.js'); } catch (_) {}
    }
    return null;
  }

  const state = {
    el: null,
    session: null,
    timerInterval: null,
    perspective: 'white',
    duration: 30,
    showCoords: false,
    inputBuffer: '',
    mounted: false
  };

  function injectStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('coords-view-styles')) return;

    const style = document.createElement('style');
    style.id = 'coords-view-styles';
    style.textContent = `
      .coords-container {
        max-width: 720px;
        margin: 0 auto;
        padding: 16px;
        box-sizing: border-box;
        font-family: inherit;
        color: var(--text-color, #1e293b);
      }
      .coords-header {
        text-align: center;
        margin-bottom: 16px;
      }
      .coords-header h2 {
        margin: 0 0 6px 0;
        font-size: 1.6rem;
      }
      .coords-header p {
        margin: 0;
        color: var(--muted, #64748b);
        font-size: 0.95rem;
      }
      .coords-controls-bar {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        justify-content: space-between;
        align-items: center;
        background: var(--panel-bg, #f8fafc);
        border: 1px solid var(--panel-border, #e2e8f0);
        padding: 10px 14px;
        border-radius: 8px;
        margin-bottom: 16px;
      }
      .coords-button-group {
        display: inline-flex;
        border-radius: 6px;
        overflow: hidden;
        border: 1px solid var(--panel-border, #cbd5e1);
      }
      .coords-button-group button {
        background: #fff;
        border: none;
        padding: 6px 12px;
        font-size: 0.82rem;
        font-weight: 500;
        cursor: pointer;
        color: var(--text-color, #334155);
        border-right: 1px solid var(--panel-border, #cbd5e1);
        transition: background 0.15s, color 0.15s;
      }
      .coords-button-group button:last-child {
        border-right: none;
      }
      .coords-button-group button.active {
        background: #2563eb;
        color: #fff;
        font-weight: 600;
      }
      .coords-toggle-label {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.85rem;
        cursor: pointer;
        user-select: none;
      }
      .coords-best-badge {
        font-size: 0.85rem;
        font-weight: 600;
        color: #0284c7;
        background: #e0f2fe;
        padding: 4px 8px;
        border-radius: 4px;
      }
      .coords-hud {
        display: flex;
        justify-content: space-between;
        align-items: center;
        background: #0f172a;
        color: #fff;
        padding: 12px 18px;
        border-radius: 8px;
        margin-bottom: 16px;
      }
      .coords-target-box {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .coords-target-box span {
        font-size: 0.9rem;
        color: #94a3b8;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .coords-target-square {
        font-size: 2.2rem;
        font-weight: 800;
        font-family: monospace;
        color: #38bdf8;
        background: rgba(56, 189, 248, 0.15);
        padding: 2px 14px;
        border-radius: 6px;
        min-width: 54px;
        text-align: center;
      }
      .coords-stats-box {
        display: flex;
        gap: 16px;
        align-items: center;
      }
      .coords-stat {
        text-align: right;
      }
      .coords-stat-val {
        font-size: 1.4rem;
        font-weight: 700;
      }
      .coords-stat-lbl {
        font-size: 0.72rem;
        color: #94a3b8;
        text-transform: uppercase;
      }
      .coords-action-btn {
        background: #22c55e;
        color: #fff;
        border: none;
        padding: 8px 16px;
        font-size: 0.95rem;
        font-weight: 600;
        border-radius: 6px;
        cursor: pointer;
        transition: background 0.15s;
      }
      .coords-action-btn:hover {
        background: #16a34a;
      }
      .coords-action-btn.running {
        background: #ef4444;
      }
      .coords-board-wrapper {
        position: relative;
        width: 100%;
        max-width: 520px;
        margin: 0 auto;
        aspect-ratio: 1 / 1;
        box-shadow: 0 4px 12px rgba(0,0,0,0.12);
        border-radius: 6px;
        overflow: hidden;
        border: 2px solid #334155;
      }
      .coords-grid {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        grid-template-rows: repeat(8, 1fr);
        width: 100%;
        height: 100%;
      }
      .coords-square {
        position: relative;
        cursor: pointer;
        user-select: none;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: filter 0.1s ease;
      }
      .coords-square.light {
        background: #f0d9b5;
      }
      .coords-square.dark {
        background: #b58863;
      }
      .coords-square:hover {
        filter: brightness(1.08);
      }
      .coords-square.flash-correct {
        background-color: #22c55e !important;
        transition: none;
      }
      .coords-square.flash-error {
        background-color: #ef4444 !important;
        transition: none;
      }
      .coords-label-rank, .coords-label-file {
        position: absolute;
        font-size: 11px;
        font-weight: 700;
        pointer-events: none;
        opacity: 0.85;
      }
      .coords-square.light .coords-label-rank,
      .coords-square.light .coords-label-file {
        color: #b58863;
      }
      .coords-square.dark .coords-label-rank,
      .coords-square.dark .coords-label-file {
        color: #f0d9b5;
      }
      .coords-label-rank {
        top: 2px;
        left: 3px;
      }
      .coords-label-file {
        bottom: 2px;
        right: 3px;
      }
      .coords-overlay {
        position: absolute;
        inset: 0;
        background: rgba(15, 23, 42, 0.88);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        color: #fff;
        padding: 24px;
        text-align: center;
        z-index: 10;
      }
      .coords-overlay h3 {
        margin: 0 0 10px 0;
        font-size: 1.8rem;
      }
      .coords-overlay p {
        margin: 0 0 16px 0;
        color: #cbd5e1;
        font-size: 1rem;
      }
      .coords-summary-stats {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 16px;
        margin-bottom: 20px;
        width: 100%;
        max-width: 360px;
      }
      .coords-summary-card {
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 6px;
        padding: 8px;
      }
      .coords-summary-val {
        font-size: 1.5rem;
        font-weight: 700;
        color: #38bdf8;
      }
      .coords-summary-lbl {
        font-size: 0.72rem;
        color: #94a3b8;
        text-transform: uppercase;
      }
    `;
    document.head.appendChild(style);
  }

  function playTone(type) {
    if (typeof window !== 'undefined' && typeof window.playSound === 'function') {
      if (type === 'correct') window.playSound('move');
      else window.playSound('illegal');
      return;
    }
    const AudioCtor = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
    if (!AudioCtor) return;
    try {
      const ctx = new AudioCtor();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      const now = ctx.currentTime;
      if (type === 'correct') {
        osc.frequency.setValueAtTime(587.33, now); // D5
        osc.frequency.setValueAtTime(880, now + 0.08); // A5
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        osc.start(now);
        osc.stop(now + 0.22);
      } else {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(180, now);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
        osc.start(now);
        osc.stop(now + 0.26);
      }
    } catch (_) {}
  }

  function renderSkeleton(container) {
    container.innerHTML = `
      <div class="coords-container">
        <header class="coords-header">
          <h2>Coordinates Trainer</h2>
          <p>Sharpen your board vision. Click the named square as fast as you can!</p>
        </header>

        <div class="coords-controls-bar">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 0.82rem; font-weight: 600;">Side:</span>
            <div class="coords-button-group" id="coords-perspective-group">
              <button type="button" data-val="white" class="active">White</button>
              <button type="button" data-val="black">Black</button>
              <button type="button" data-val="random">Random</button>
            </div>
          </div>

          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 0.82rem; font-weight: 600;">Time:</span>
            <div class="coords-button-group" id="coords-duration-group">
              <button type="button" data-val="30" class="active">30s</button>
              <button type="button" data-val="60">60s</button>
              <button type="button" data-val="0">Practice</button>
            </div>
          </div>

          <label class="coords-toggle-label">
            <input type="checkbox" id="coords-show-labels-chk">
            <span>Coordinates</span>
          </label>

          <div class="coords-best-badge" id="coords-high-score-display">
            Best: 0
          </div>
        </div>

        <div class="coords-hud">
          <div class="coords-target-box">
            <span>Find</span>
            <div class="coords-target-square" id="coords-target-display">—</div>
          </div>

          <div class="coords-stats-box">
            <div class="coords-stat">
              <div class="coords-stat-val" id="coords-time-display">30s</div>
              <div class="coords-stat-lbl">Time</div>
            </div>
            <div class="coords-stat">
              <div class="coords-stat-val" id="coords-score-display">0</div>
              <div class="coords-stat-lbl">Score</div>
            </div>
          </div>

          <button type="button" class="coords-action-btn" id="coords-action-btn">
            Start
          </button>
        </div>

        <div class="coords-board-wrapper">
          <div class="coords-grid" id="coords-board" role="grid" aria-label="Coordinates training chessboard">
          </div>
          <div class="coords-overlay" id="coords-overlay">
            <h3 id="coords-overlay-title">Ready to train?</h3>
            <p id="coords-overlay-msg">Click start to begin finding squares as they appear.</p>
            <div class="coords-summary-stats" id="coords-summary-stats" style="display: none;">
              <div class="coords-summary-card">
                <div class="coords-summary-val" id="coords-final-score">0</div>
                <div class="coords-summary-lbl">Score</div>
              </div>
              <div class="coords-summary-card">
                <div class="coords-summary-val" id="coords-final-accuracy">0%</div>
                <div class="coords-summary-lbl">Accuracy</div>
              </div>
              <div class="coords-summary-card">
                <div class="coords-summary-val" id="coords-final-streak">0</div>
                <div class="coords-summary-lbl">Best Streak</div>
              </div>
            </div>
            <button type="button" class="coords-action-btn" id="coords-overlay-start-btn">
              Start (30s)
            </button>
          </div>
        </div>

        <div id="coords-a11y-announcer" class="sr-only" role="status" aria-live="polite" style="position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0;"></div>
      </div>
    `;
  }

  function announce(text) {
    if (typeof document === 'undefined') return;
    const announcer = document.getElementById('coords-a11y-announcer');
    if (announcer) announcer.textContent = text;
  }

  function updateHighScoreDisplay() {
    const trainer = getTrainer();
    if (!state.el || !trainer) return;
    const badge = state.el.querySelector('#coords-high-score-display');
    if (!badge) return;
    const best = trainer.getHighScore('find', state.perspective, state.duration);
    badge.textContent = `Best: ${best}`;
  }

  function renderBoard() {
    const trainer = getTrainer();
    if (!state.el || !trainer) return;
    const boardEl = state.el.querySelector('#coords-board');
    if (!boardEl) return;

    const squares = trainer.getBoardSquareOrder(state.session ? state.session.perspective : state.perspective);
    boardEl.innerHTML = '';

    const isWhite = (state.session ? state.session.perspective : state.perspective) !== 'black';
    const bottomRank = isWhite ? '1' : '8';
    const leftFile = isWhite ? 'a' : 'h';

    for (const sq of squares) {
      const squareDiv = document.createElement('div');
      squareDiv.className = `coords-square ${sq.color}`;
      squareDiv.setAttribute('data-square', sq.square);
      squareDiv.setAttribute('data-file', sq.file);
      squareDiv.setAttribute('data-rank', sq.rank);
      squareDiv.setAttribute('role', 'gridcell');
      squareDiv.setAttribute('aria-label', `Square ${sq.square}`);

      if (state.showCoords) {
        if (sq.file === leftFile) {
          const rankLbl = document.createElement('span');
          rankLbl.className = 'coords-label-rank';
          rankLbl.textContent = sq.rank;
          squareDiv.appendChild(rankLbl);
        }
        if (sq.rank === bottomRank) {
          const fileLbl = document.createElement('span');
          fileLbl.className = 'coords-label-file';
          fileLbl.textContent = sq.file;
          squareDiv.appendChild(fileLbl);
        }
      }

      boardEl.appendChild(squareDiv);
    }
  }

  function startRound() {
    const trainer = getTrainer();
    if (!trainer) return;
    stopTimer();

    state.session = trainer.createSession({
      perspective: state.perspective,
      durationSeconds: state.duration,
      showCoordinates: state.showCoords
    });
    trainer.startSession(state.session);

    renderBoard();

    // UI changes
    const targetDisplay = state.el.querySelector('#coords-target-display');
    const scoreDisplay = state.el.querySelector('#coords-score-display');
    const timeDisplay = state.el.querySelector('#coords-time-display');
    const actionBtn = state.el.querySelector('#coords-action-btn');
    const overlay = state.el.querySelector('#coords-overlay');

    if (targetDisplay) targetDisplay.textContent = state.session.currentTarget.toUpperCase();
    if (scoreDisplay) scoreDisplay.textContent = '0';
    if (timeDisplay) timeDisplay.textContent = state.duration > 0 ? `${state.duration}s` : '∞';
    if (actionBtn) {
      actionBtn.textContent = 'Stop';
      actionBtn.classList.add('running');
    }
    if (overlay) overlay.style.display = 'none';

    announce(`Round started. Find square ${state.session.currentTarget}`);

    if (state.duration > 0) {
      state.timerInterval = setInterval(tick, 200);
    }
  }

  function tick() {
    const trainer = getTrainer();
    if (!state.session || !state.session.active || !trainer) return;
    const completed = trainer.tickSession(state.session, Date.now());
    const timeDisplay = state.el ? state.el.querySelector('#coords-time-display') : null;

    if (timeDisplay && state.session.durationSeconds > 0) {
      const remainingSeconds = Math.ceil(state.session.timeRemainingMs / 1000);
      timeDisplay.textContent = `${remainingSeconds}s`;
    }

    if (completed) {
      finishRound();
    }
  }

  function finishRound() {
    stopTimer();
    if (!state.session) return;
    const trainer = getTrainer();
    const stats = trainer ? trainer.endSession(state.session, Date.now()) : null;
    if (!stats) return;

    const actionBtn = state.el.querySelector('#coords-action-btn');
    const overlay = state.el.querySelector('#coords-overlay');
    const overlayTitle = state.el.querySelector('#coords-overlay-title');
    const overlayMsg = state.el.querySelector('#coords-overlay-msg');
    const overlayStartBtn = state.el.querySelector('#coords-overlay-start-btn');
    const summaryStats = state.el.querySelector('#coords-summary-stats');
    const finalScore = state.el.querySelector('#coords-final-score');
    const finalAcc = state.el.querySelector('#coords-final-accuracy');
    const finalStreak = state.el.querySelector('#coords-final-streak');

    if (actionBtn) {
      actionBtn.textContent = 'Start';
      actionBtn.classList.remove('running');
    }

    if (stats.isNewHighScore) {
      if (overlayTitle) overlayTitle.textContent = '🎉 New Personal Best!';
      if (overlayMsg) overlayMsg.textContent = `You scored ${stats.score} with ${stats.accuracy}% accuracy!`;
    } else {
      if (overlayTitle) overlayTitle.textContent = 'Time Up!';
      if (overlayMsg) overlayMsg.textContent = `Round complete! Score: ${stats.score}`;
    }

    if (finalScore) finalScore.textContent = String(stats.score);
    if (finalAcc) finalAcc.textContent = `${stats.accuracy}%`;
    if (finalStreak) finalStreak.textContent = String(stats.bestStreak);
    if (summaryStats) summaryStats.style.display = 'grid';
    if (overlayStartBtn) overlayStartBtn.textContent = 'Play Again';
    if (overlay) overlay.style.display = 'flex';

    updateHighScoreDisplay();
    announce(`Time up! Final score: ${stats.score}. Accuracy: ${stats.accuracy}%.`);
  }

  function stopTimer() {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
  }

  function handleSquareClick(square) {
    const trainer = getTrainer();
    if (!state.session || !state.session.active || !trainer) return;
    const squareEl = state.el.querySelector(`.coords-square[data-square="${square}"]`);

    const res = trainer.submitAttempt(state.session, square, Date.now());
    if (!res.accepted) return;

    if (res.correct) {
      playTone('correct');
      if (squareEl) {
        squareEl.classList.add('flash-correct');
        setTimeout(() => squareEl.classList.remove('flash-correct'), 200);
      }

      // If random perspective mode, re-render board if perspective switched
      if (state.session.perspectiveSetting === 'random') {
        renderBoard();
      }

      const targetDisplay = state.el.querySelector('#coords-target-display');
      const scoreDisplay = state.el.querySelector('#coords-score-display');
      if (targetDisplay) targetDisplay.textContent = res.nextTarget.toUpperCase();
      if (scoreDisplay) scoreDisplay.textContent = String(res.score);

      announce(`Correct! Target: ${res.nextTarget}`);
    } else {
      playTone('error');
      if (squareEl) {
        squareEl.classList.add('flash-error');
        setTimeout(() => squareEl.classList.remove('flash-error'), 300);
      }
      announce(`Wrong square. Target is ${res.expectedTarget}`);
    }
  }

  function handleKeydown(e) {
    if (!state.el || !state.el.offsetParent) return; // view hidden
    if (e.target.tagName === 'INPUT' && e.target.type === 'text') return;

    if (e.key === ' ' && (!state.session || !state.session.active)) {
      e.preventDefault();
      startRound();
      return;
    }
    if (e.key === 'Escape' && state.session && state.session.active) {
      e.preventDefault();
      finishRound();
      return;
    }

    if (state.session && state.session.active && typeof e.key === 'string') {
      const char = e.key.toLowerCase();
      if (/^[a-h]$/.test(char)) {
        state.inputBuffer = char;
      } else if (/^[1-8]$/.test(char) && state.inputBuffer.length === 1) {
        const sq = state.inputBuffer + char;
        state.inputBuffer = '';
        handleSquareClick(sq);
      }
    }
  }

  function bindEvents() {
    if (!state.el) return;

    // Perspective buttons
    const perspGroup = state.el.querySelector('#coords-perspective-group');
    if (perspGroup) {
      perspGroup.onclick = (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        perspGroup.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.perspective = btn.getAttribute('data-val');
        updateHighScoreDisplay();
        if (!state.session || !state.session.active) {
          renderBoard();
        }
      };
    }

    // Duration buttons
    const durGroup = state.el.querySelector('#coords-duration-group');
    if (durGroup) {
      durGroup.onclick = (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        durGroup.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.duration = parseInt(btn.getAttribute('data-val'), 10) || 0;
        updateHighScoreDisplay();
        const timeDisplay = state.el.querySelector('#coords-time-display');
        if (timeDisplay && (!state.session || !state.session.active)) {
          timeDisplay.textContent = state.duration > 0 ? `${state.duration}s` : '∞';
        }
        const overlayStartBtn = state.el.querySelector('#coords-overlay-start-btn');
        if (overlayStartBtn) {
          overlayStartBtn.textContent = `Start (${state.duration > 0 ? state.duration + 's' : 'Practice'})`;
        }
      };
    }

    // Coordinates toggle
    const chk = state.el.querySelector('#coords-show-labels-chk');
    if (chk) {
      chk.onchange = () => {
        state.showCoords = chk.checked;
        renderBoard();
      };
    }

    // Board square clicks
    const boardEl = state.el.querySelector('#coords-board');
    if (boardEl) {
      boardEl.onclick = (e) => {
        const sqEl = e.target.closest('.coords-square');
        if (!sqEl) return;
        const square = sqEl.getAttribute('data-square');
        if (square) handleSquareClick(square);
      };
    }

    // Action button
    const actionBtn = state.el.querySelector('#coords-action-btn');
    if (actionBtn) {
      actionBtn.onclick = () => {
        if (state.session && state.session.active) {
          finishRound();
        } else {
          startRound();
        }
      };
    }

    // Overlay start button
    const overlayStartBtn = state.el.querySelector('#coords-overlay-start-btn');
    if (overlayStartBtn) {
      overlayStartBtn.onclick = startRound;
    }

    // Global keyboard listener
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', handleKeydown);
    }
  }

  function mount(el) {
    state.el = el;
    injectStyles();
    renderSkeleton(el);
    bindEvents();
    renderBoard();
    updateHighScoreDisplay();
    state.mounted = true;
  }

  function show(el) {
    if (!state.mounted) mount(el);
    updateHighScoreDisplay();
  }

  function hide() {
    if (state.session && state.session.active) {
      finishRound();
    }
    stopTimer();
  }

  function init() {
    if (typeof window === 'undefined' || !window.Shell || typeof window.Shell.registerView !== 'function') return;
    window.Shell.registerView({
      id: 'coordinates',
      title: 'Coordinates',
      order: 35,
      nav: true,
      mount,
      show,
      hide
    });
  }

  const UICoordinates = {
    init,
    mount,
    show,
    hide,
    startRound,
    finishRound,
    handleSquareClick,
    getState: () => state
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = UICoordinates;
  }
  if (typeof window !== 'undefined') {
    window.UICoordinates = UICoordinates;
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})();
