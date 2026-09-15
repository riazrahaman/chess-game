'use strict';
// ui-theme.js — CSS-only theming system extracted from ui.js.
// Loaded as a classic <script> before ui.js. Shares global scope.
// Depends on: isValidBoardTheme, getDefaultBoardTheme (from engine.js),
//             loadSoundPreference, setSoundEnabled, soundEnabled (from ui-sound.js).

const THEME_BOARD_KEY = 'chess.theme.board';
const THEME_MODE_KEY = 'chess.theme.mode';
const themeBoardSelect = document.getElementById('theme-board-select');
const themeModeToggle = document.getElementById('theme-mode-toggle');

function applyBoardTheme(themeId) {
  if (!themeId || !isValidBoardTheme(themeId)) return;
  try {
    document.documentElement.setAttribute('data-theme', themeId);
  } catch (e) {}
}

function applyDarkMode(isDark) {
  try {
    if (isDark) {
      document.documentElement.setAttribute('data-mode', 'dark');
    } else {
      document.documentElement.removeAttribute('data-mode');
    }
  } catch (e) {}
}

function persistTheme(key, value) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
    }
  } catch (e) {}
}

function loadThemePreference(key, fallback) {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const val = localStorage.getItem(key);
    return val !== null ? val : fallback;
  } catch (e) {
    return fallback;
  }
}

function updateModeToggleLabel(isDark) {
  if (themeModeToggle) themeModeToggle.textContent = isDark ? 'Light mode' : 'Dark mode';
}

function initThemeBar() {
  if (themeBoardSelect) {
    const savedBoard = loadThemePreference(THEME_BOARD_KEY, getDefaultBoardTheme());
    if (isValidBoardTheme(savedBoard)) {
      themeBoardSelect.value = savedBoard;
      applyBoardTheme(savedBoard);
    } else {
      applyBoardTheme(getDefaultBoardTheme());
    }
    themeBoardSelect.onchange = () => {
      const val = themeBoardSelect.value;
      applyBoardTheme(val);
      persistTheme(THEME_BOARD_KEY, val);
    };
  }
  if (themeModeToggle) {
    const savedMode = loadThemePreference(THEME_MODE_KEY, 'light');
    const isDark = savedMode === 'dark';
    applyDarkMode(isDark);
    updateModeToggleLabel(isDark);
    themeModeToggle.onclick = () => {
      const currentlyDark = document.documentElement.getAttribute('data-mode') === 'dark';
      const nextDark = !currentlyDark;
      applyDarkMode(nextDark);
      updateModeToggleLabel(nextDark);
      persistTheme(THEME_MODE_KEY, nextDark ? 'dark' : 'light');
    };
  }
  const soundToggleButton = document.getElementById('sound-toggle');
  if (soundToggleButton) {
    loadSoundPreference();
    soundToggleButton.textContent = soundEnabled ? 'Sound: On' : 'Sound: Off';
    soundToggleButton.onclick = () => {
      setSoundEnabled(!soundEnabled);
    };
  }
}

initThemeBar();