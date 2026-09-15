'use strict';

/**
 * puzzle-repetition.js — Spaced-repetition scheduling for mistake review.
 *
 * When a player gets a puzzle wrong, it is scheduled for review on an
 * increasing interval (1d, 2d, 4d, 8d, ...).  Correct answers advance the
 * interval step; incorrect answers reset to the first interval.
 *
 * This is a pure display/analysis-layer feature — it never mutates referee
 * state and respects Gate 4 (no makeMove / createInitialBoard calls).
 *
 * Public API:
 *   scheduleReview(puzzleId, {now, wasCorrect}) -> {puzzleId, nextDueAt, intervalDays, reviewCount, ...}
 *   getDueReviews(puzzles, now) -> [puzzle, ...]  (puzzles whose nextDueAt <= now)
 *   DEFAULT_INTERVALS  — [1, 2, 4, 8, 16, 32]
 *   MAX_INTERVAL_DAYS  — 365
 */

const DEFAULT_INTERVALS = [1, 2, 4, 8, 16, 32];
const MAX_INTERVAL_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compute the next interval for a spaced-repetition review.
 *
 * @param {number} currentStep   — index into DEFAULT_INTERVALS (0-based)
 * @param {boolean} wasCorrect   — whether the last review was correct
 * @returns {number} intervalDays — days until next review
 */
function computeIntervalDays(currentStep, wasCorrect) {
  if (!wasCorrect) {
    return DEFAULT_INTERVALS[0];
  }
  const nextStep = currentStep + 1;
  if (nextStep >= DEFAULT_INTERVALS.length) {
    return MAX_INTERVAL_DAYS;
  }
  return DEFAULT_INTERVALS[nextStep];
}

/**
 * Schedule (or reschedule) a puzzle for spaced review.
 *
 * @param {string} puzzleId      — unique puzzle identifier
 * @param {object} opts
 * @param {number} [opts.now]    — epoch ms (defaults to Date.now())
 * @param {boolean} [opts.wasCorrect] — whether the player solved it correctly
 * @param {object} [opts.existing]    — existing schedule record (from loadReviewSchedule)
 * @returns {object} review record:
 *   { puzzleId, nextDueAt (ms epoch), intervalDays, reviewCount, lastReviewedAt, correctStreak }
 */
function scheduleReview(puzzleId, opts) {
  if (!puzzleId) {
    puzzleId = 'unknown';
  }
  const now = (opts && typeof opts.now === 'number') ? opts.now : Date.now();
  const wasCorrect = !!(opts && opts.wasCorrect);
  const existing = (opts && opts.existing) || null;

  const currentStep = existing && typeof existing.step === 'number' ? existing.step : 0;
  const reviewCount = existing && typeof existing.reviewCount === 'number' ? existing.reviewCount : 0;

  let newStep;
  if (!existing) {
    // First-ever scheduling — always starts at step 0
    newStep = 0;
  } else if (wasCorrect) {
    newStep = currentStep + 1;
  } else {
    newStep = 0;
  }

  let intervalDays;
  if (newStep < DEFAULT_INTERVALS.length) {
    intervalDays = DEFAULT_INTERVALS[newStep];
  } else {
    intervalDays = MAX_INTERVAL_DAYS;
  }

  // Cap step so it doesn't grow unbounded
  if (newStep > DEFAULT_INTERVALS.length - 1) {
    newStep = DEFAULT_INTERVALS.length - 1;
  }

  return {
    puzzleId: String(puzzleId),
    nextDueAt: now + intervalDays * DAY_MS,
    intervalDays: intervalDays,
    step: newStep,
    reviewCount: reviewCount + 1,
    lastReviewedAt: now,
    correctStreak: wasCorrect
      ? ((existing && typeof existing.correctStreak === 'number' ? existing.correctStreak : 0) + 1)
      : 0
  };
}

/**
 * Given an array of puzzles (each with an optional `reviewSchedule` object
 * containing `nextDueAt`), return those whose nextDueAt <= now.
 *
 * @param {Array} puzzles — array of puzzle objects
 * @param {number} [now]  — epoch ms (defaults to Date.now())
 * @returns {Array} puzzles whose review is due
 */
function getDueReviews(puzzles, now) {
  if (!Array.isArray(puzzles)) return [];
  const t = typeof now === 'number' ? now : Date.now();
  return puzzles.filter(function (p) {
    if (!p) return false;
    const schedule = p.reviewSchedule || p.schedule;
    if (!schedule) return false;
    if (typeof schedule.nextDueAt !== 'number') return false;
    return schedule.nextDueAt <= t;
  });
}

/* ------------------------------------------------------------------ *
 * Persistence layer (mirrors puzzle_ratings pattern in game-archive) *
 * ------------------------------------------------------------------ */

let _archiveBackend = null;
function _getBackend() {
  if (_archiveBackend) return _archiveBackend;
  if (typeof require === 'function') {
    try {
      _archiveBackend = require('./game-archive.js');
    } catch (_) {
      _archiveBackend = null;
    }
  }
  return _archiveBackend;
}

/**
 * Persist a review schedule record for a puzzle.
 * Delegates to game-archive.js savePuzzleReview (graceful null on failure).
 *
 * @param {object} reviewRecord — record from scheduleReview()
 * @returns {object|null} persisted record, or null on failure
 */
function saveReviewSchedule(reviewRecord) {
  const backend = _getBackend();
  if (!backend || typeof backend.savePuzzleReview !== 'function') return null;
  try {
    return backend.savePuzzleReview(reviewRecord);
  } catch (_) {
    return null;
  }
}

/**
 * Load a review schedule record for a puzzle.
 *
 * @param {string} puzzleId
 * @returns {object|null} review record, or null if not found / on failure
 */
function loadReviewSchedule(puzzleId) {
  const backend = _getBackend();
  if (!backend || typeof backend.getPuzzleReview !== 'function') return null;
  try {
    return backend.getPuzzleReview(puzzleId);
  } catch (_) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Module exports                                                     *
 * ------------------------------------------------------------------ */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    scheduleReview,
    getDueReviews,
    computeIntervalDays,
    saveReviewSchedule,
    loadReviewSchedule,
    DEFAULT_INTERVALS,
    MAX_INTERVAL_DAYS
  };
}

if (typeof window !== 'undefined') {
  window.PuzzleRepetition = {
    scheduleReview,
    getDueReviews,
    computeIntervalDays,
    saveReviewSchedule,
    loadReviewSchedule,
    DEFAULT_INTERVALS,
    MAX_INTERVAL_DAYS
  };
}