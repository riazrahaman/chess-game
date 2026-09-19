/**
 * coordinates-trainer.js
 * Core engine-less domain model for the Coordinates Trainer mini-game (G5).
 * 
 * Features:
 * - Pure coordinate recognition logic (files a-h, ranks 1-8).
 * - Perspectives: 'white', 'black', 'random'.
 * - Modes: 'find' (click square for given coordinate), 'name' (name square highlighted).
 * - Timed challenge (30s / 60s) or untimed practice.
 * - Score, streak, accuracy, and latency tracking.
 * - High score persistence per mode & perspective.
 * 
 * Gate 4 Invariant: Zero occurrences of referee mutators (pure domain model).
 */

(function () {
  'use strict';

  const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const RANKS = ['1', '2', '3', '4', '5', '6', '7', '8'];

const ALL_SQUARES = [];
for (const file of FILES) {
  for (const rank of RANKS) {
    ALL_SQUARES.push(file + rank);
  }
}

/**
 * Returns square color ('light' | 'dark').
 * @param {string} square e.g. 'e4'
 * @returns {'light'|'dark'}
 */
function getSquareColor(square) {
  if (!square || square.length < 2) return 'light';
  const fileIdx = square.charCodeAt(0) - 97; // 'a' -> 0
  const rankIdx = parseInt(square[1], 10) - 1; // '1' -> 0
  return (fileIdx + rankIdx) % 2 === 0 ? 'dark' : 'light';
}

/**
 * Validates whether string is a legal chess square ('a1'..'h8').
 * @param {string} square
 * @returns {boolean}
 */
function isValidSquare(square) {
  return typeof square === 'string' && /^[a-h][1-8]$/.test(square.toLowerCase());
}

/**
 * Returns a random square from a1 to h8, avoiding immediate repeat of excludeSquare.
 * @param {string} [excludeSquare]
 * @param {Function} [randomFn] Seedable or default Math.random
 * @returns {string}
 */
function getRandomSquare(excludeSquare, randomFn = Math.random) {
  let pick = excludeSquare;
  let attempts = 0;
  while ((pick === excludeSquare || !pick) && attempts < 20) {
    const idx = Math.floor(randomFn() * ALL_SQUARES.length);
    pick = ALL_SQUARES[idx];
    attempts++;
  }
  return pick || 'e4';
}

/**
 * Creates a new Coordinates training session.
 * @param {Object} [options]
 * @param {'white'|'black'|'random'} [options.perspective='white']
 * @param {'find'|'name'} [options.mode='find']
 * @param {number} [options.durationSeconds=30] 0 for unlimited practice
 * @param {boolean} [options.showCoordinates=false]
 * @param {Function} [options.randomFn=Math.random]
 * @returns {Object}
 */
function createSession(options = {}) {
  const perspectiveChoice = options.perspective || 'white';
  const effectivePerspective = perspectiveChoice === 'random'
    ? ((options.randomFn || Math.random)() > 0.5 ? 'white' : 'black')
    : perspectiveChoice;

  return {
    id: 'coords_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    perspectiveSetting: perspectiveChoice,
    perspective: effectivePerspective,
    mode: options.mode || 'find',
    durationSeconds: typeof options.durationSeconds === 'number' ? options.durationSeconds : 30,
    showCoordinates: Boolean(options.showCoordinates),
    randomFn: options.randomFn || Math.random,
    active: false,
    completed: false,
    startedAt: 0,
    endedAt: 0,
    timeRemainingMs: (typeof options.durationSeconds === 'number' ? options.durationSeconds : 30) * 1000,
    score: 0,
    correctCount: 0,
    errorCount: 0,
    currentStreak: 0,
    bestStreak: 0,
    currentTarget: null,
    targetIssuedAt: 0,
    history: []
  };
}

/**
 * Starts an existing session and generates first target square.
 * @param {Object} session
 * @param {number} [now=Date.now()]
 * @returns {Object}
 */
function startSession(session, now = Date.now()) {
  session.active = true;
  session.completed = false;
  session.startedAt = now;
  session.timeRemainingMs = session.durationSeconds > 0 ? session.durationSeconds * 1000 : 0;
  session.score = 0;
  session.correctCount = 0;
  session.errorCount = 0;
  session.currentStreak = 0;
  session.bestStreak = 0;
  session.history = [];
  session.currentTarget = getRandomSquare(null, session.randomFn);
  session.targetIssuedAt = now;
  return session;
}

/**
 * Submits an answer attempt for the current session.
 * @param {Object} session
 * @param {string} inputSquare e.g. 'e4'
 * @param {number} [now=Date.now()]
 * @returns {Object} Result of the attempt
 */
function submitAttempt(session, inputSquare, now = Date.now()) {
  if (!session || !session.active || session.completed) {
    return {
      accepted: false,
      reason: 'session_inactive',
      score: session ? session.score : 0
    };
  }

  const cleanedInput = typeof inputSquare === 'string' ? inputSquare.trim().toLowerCase() : '';
  const expected = session.currentTarget;
  const isCorrect = cleanedInput === expected;
  const latencyMs = Math.max(0, now - session.targetIssuedAt);

  session.history.push({
    target: expected,
    input: cleanedInput,
    correct: isCorrect,
    latencyMs,
    timestamp: now
  });

  if (isCorrect) {
    session.score += 1;
    session.correctCount += 1;
    session.currentStreak += 1;
    if (session.currentStreak > session.bestStreak) {
      session.bestStreak = session.currentStreak;
    }

    // Switch perspective per move if in 'random' perspective mode
    if (session.perspectiveSetting === 'random') {
      session.perspective = session.randomFn() > 0.5 ? 'white' : 'black';
    }

    const nextTarget = getRandomSquare(expected, session.randomFn);
    session.currentTarget = nextTarget;
    session.targetIssuedAt = now;

    return {
      accepted: true,
      correct: true,
      score: session.score,
      streak: session.currentStreak,
      nextTarget,
      latencyMs,
      completed: false
    };
  } else {
    session.errorCount += 1;
    session.currentStreak = 0;

    return {
      accepted: true,
      correct: false,
      score: session.score,
      streak: 0,
      expectedTarget: expected,
      latencyMs,
      completed: false
    };
  }
}

/**
 * Updates timer countdown. Returns true if session reached time limit and completed.
 * @param {Object} session
 * @param {number} [now=Date.now()]
 * @returns {boolean} true if session timed out
 */
function tickSession(session, now = Date.now()) {
  if (!session || !session.active || session.completed) return false;
  if (session.durationSeconds <= 0) return false; // Untimed practice mode

  const elapsedMs = now - session.startedAt;
  const totalMs = session.durationSeconds * 1000;
  session.timeRemainingMs = Math.max(0, totalMs - elapsedMs);

  if (session.timeRemainingMs <= 0) {
    endSession(session, now);
    return true;
  }
  return false;
}

/**
 * Ends a session and compiles performance metrics.
 * @param {Object} session
 * @param {number} [now=Date.now()]
 * @returns {Object} Final statistics summary
 */
function endSession(session, now = Date.now()) {
  if (!session) return null;
  session.active = false;
  session.completed = true;
  session.endedAt = now;
  session.timeRemainingMs = 0;

  const totalAttempts = session.correctCount + session.errorCount;
  const accuracy = totalAttempts > 0
    ? Math.round((session.correctCount / totalAttempts) * 100)
    : 0;

  const totalLatencyMs = session.history.reduce((acc, h) => acc + h.latencyMs, 0);
  const avgLatencyMs = session.correctCount > 0
    ? Math.round(totalLatencyMs / totalAttempts)
    : 0;

  const stats = {
    sessionId: session.id,
    mode: session.mode,
    perspective: session.perspectiveSetting,
    durationSeconds: session.durationSeconds,
    score: session.score,
    correctCount: session.correctCount,
    errorCount: session.errorCount,
    totalAttempts,
    accuracy,
    bestStreak: session.bestStreak,
    avgLatencyMs,
    history: session.history.slice()
  };

  const isNewHighScore = updateHighScore(
    session.mode,
    session.perspectiveSetting,
    session.durationSeconds,
    session.score
  );
  stats.isNewHighScore = isNewHighScore;
  stats.highScore = getHighScore(session.mode, session.perspectiveSetting, session.durationSeconds);

  return stats;
}

/**
 * Key format for persistent high scores in localStorage.
 */
function getStorageKey(mode, perspective, duration) {
  return `chess_coords_high_${mode}_${perspective}_${duration}s`;
}

/**
 * Retrieves high score for given mode/perspective/duration.
 */
function getHighScore(mode = 'find', perspective = 'white', duration = 30) {
  if (typeof localStorage === 'undefined') return 0;
  try {
    const val = localStorage.getItem(getStorageKey(mode, perspective, duration));
    return val ? parseInt(val, 10) || 0 : 0;
  } catch (_) {
    return 0;
  }
}

/**
 * Updates high score if new score exceeds existing.
 * Returns true if a new high score was set.
 */
function updateHighScore(mode = 'find', perspective = 'white', duration = 30, score = 0) {
  if (typeof localStorage === 'undefined' || duration <= 0) return false;
  try {
    const current = getHighScore(mode, perspective, duration);
    if (score > current) {
      localStorage.setItem(getStorageKey(mode, perspective, duration), String(score));
      return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

/**
 * Generates square grid order according to perspective.
 * From top to bottom row, left to right column.
 * White perspective: row 8 to 1, col a to h.
 * Black perspective: row 1 to 8, col h to a.
 * @param {'white'|'black'} perspective
 * @returns {Array<{square: string, file: string, rank: string, color: 'light'|'dark'}>}
 */
function getBoardSquareOrder(perspective = 'white') {
  const isWhite = perspective !== 'black';
  const ranks = isWhite ? ['8', '7', '6', '5', '4', '3', '2', '1'] : ['1', '2', '3', '4', '5', '6', '7', '8'];
  const files = isWhite ? ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] : ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a'];

  const list = [];
  for (const rank of ranks) {
    for (const file of files) {
      const square = file + rank;
      list.push({
        square,
        file,
        rank,
        color: getSquareColor(square)
      });
    }
  }
  return list;
}

const CoordinatesTrainer = {
  FILES,
  RANKS,
  ALL_SQUARES,
  getSquareColor,
  isValidSquare,
  getRandomSquare,
  createSession,
  startSession,
  submitAttempt,
  tickSession,
  endSession,
  getHighScore,
  updateHighScore,
  getBoardSquareOrder
};

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CoordinatesTrainer;
  }
  if (typeof window !== 'undefined') {
    window.CoordinatesTrainer = CoordinatesTrainer;
  }
})();
