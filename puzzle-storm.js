'use strict';

let PuzzleRating = null;
if (typeof require === 'function') {
  try { PuzzleRating = require('./puzzle-rating.js'); } catch (_) {}
}
if (!PuzzleRating && typeof window !== 'undefined') PuzzleRating = window.PuzzleRating;

const DEFAULT_DURATION_SEC = 180;
const DEFAULT_SOLVER_ID = 'default';
const DEFAULT_DIFFICULTY_STEP = 50;
// Sessions without an explicit seed intentionally share a reproducible order.
const DEFAULT_SEED = 'chess-puzzle-storm-v1';
let sessionSequence = 0;

function requirePuzzleRating() {
  if (!PuzzleRating || typeof PuzzleRating.selectNextPuzzle !== 'function') {
    throw new Error('puzzle-storm.js: puzzle-rating.js is required');
  }
}

function hashSeed(seed) {
  const text = String(seed == null ? '' : seed);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Creates a reproducible Mulberry32 random-number generator. */
function createSeededRng(seed) {
  let state = hashSeed(seed);
  return function seededRandom() {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function timestamp(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function shuffledCopy(values, rng) {
  const result = values.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const random = Math.min(0.999999999999, Math.max(0, Number(rng()) || 0));
    const index = Math.floor(random * (i + 1));
    [result[i], result[index]] = [result[index], result[i]];
  }
  return result;
}

class StormSession {
  constructor(options = {}) {
    requirePuzzleRating();
    const duration = Number(options.durationSec);
    this.durationSec = Number.isFinite(duration) && duration >= 0 ? duration : DEFAULT_DURATION_SEC;
    this.solverId = options.solverId == null ? DEFAULT_SOLVER_ID : String(options.solverId);
    this.puzzles = Array.isArray(options.puzzles) ? options.puzzles.slice() : [];
    this.rng = typeof options.rng === 'function'
      ? options.rng
      : createSeededRng(Object.prototype.hasOwnProperty.call(options, 'seed') ? options.seed : DEFAULT_SEED);
    this.ratingStore = options.ratingStore || new PuzzleRating.PuzzleRatingStore(
      Object.prototype.hasOwnProperty.call(options, 'archive') ? { archive: options.archive } : {}
    );
    this.difficultyStep = Number.isFinite(options.difficultyStep) && options.difficultyStep >= 0
      ? options.difficultyStep
      : DEFAULT_DIFFICULTY_STEP;
    this.startAt = timestamp(options.now);
    this.deadline = this.startAt + this.durationSec * 1000;
    this.id = `storm-${this.startAt}-${++sessionSequence}`;
    this.streak = 0;
    this.solved = 0;
    this.failed = 0;
    this.bestStreak = 0;
    this.solver = this.ratingStore.getSolver(this.solverId);
    this.baseRating = this.solver.rating;
    this.difficulty = this.baseRating;
    this.status = this.puzzles.length === 0 ? 'empty' : (this.durationSec === 0 ? 'complete' : 'active');
    this.activePuzzle = this.status === 'active' ? this._selectPuzzle(null) : null;
  }

  _selectPuzzle(previousPuzzle) {
    let candidates = this.puzzles;
    if (previousPuzzle && candidates.length > 1) {
      const withoutPrevious = candidates.filter(puzzle => String(puzzle.id) !== String(previousPuzzle.id));
      if (withoutPrevious.length > 0) candidates = withoutPrevious;
    }

    const ordered = shuffledCopy(candidates, this.rng).map(puzzle => ({
      ...puzzle,
      puzzleRating: this.ratingStore.getPuzzle(puzzle)
    }));
    const target = PuzzleRating.createSolverRating({
      id: this.solverId,
      rating: this.difficulty,
      rd: this.solver.rd,
      vol: this.solver.vol
    });
    return PuzzleRating.selectNextPuzzle(target, ordered);
  }

  _expire(now) {
    if (this.status === 'active' && timestamp(now) >= this.deadline) {
      this.status = 'complete';
      this.activePuzzle = null;
    }
    return this.status === 'complete';
  }

  timeRemaining(now) {
    if (this.status !== 'active') return 0;
    const current = timestamp(now);
    this._expire(current);
    return Math.max(0, (this.deadline - current) / 1000);
  }

  isComplete(now) {
    this._expire(now);
    return this.status !== 'active';
  }

  submit(attempt = {}) {
    return this.recordResult(attempt.result, attempt.timeSec, attempt.now);
  }

  recordResult(result, timeSec, now) {
    const timeUpBeforeAttempt = this._expire(now);
    if (this.status !== 'active' || !this.activePuzzle) {
      return { session: this, timeUp: timeUpBeforeAttempt, ratingUpdate: null };
    }
    if (result !== 'solved' && result !== 'failed') {
      throw new TypeError("Puzzle Storm result must be 'solved' or 'failed'");
    }

    const previousPuzzle = this.activePuzzle;
    const ratingUpdate = this.ratingStore.recordSolve(previousPuzzle, result, timeSec, this.solverId);
    this.solver = ratingUpdate.solver;

    if (result === 'solved') {
      this.solved++;
      this.streak++;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
    } else {
      this.failed++;
      this.streak = 0;
    }

    this.difficulty = Math.min(
      PuzzleRating.MAX_RATING,
      this.baseRating + this.streak * this.difficultyStep
    );

    const timeUp = this._expire(now);
    this.activePuzzle = timeUp ? null : this._selectPuzzle(previousPuzzle);
    return { session: this, timeUp, ratingUpdate };
  }

  finalize(now) {
    if (this.status === 'active') {
      this._expire(now);
      if (this.status === 'active') {
        this.status = 'complete';
        this.activePuzzle = null;
      }
    }
    return {
      streak: this.streak,
      solved: this.solved,
      failed: this.failed,
      bestStreak: this.bestStreak
    };
  }
}

function startSession(options) {
  return new StormSession(options);
}

function recordResult(session, result, timeSec, now) {
  return session.recordResult(result, timeSec, now);
}

function timeRemaining(session, now) {
  return session.timeRemaining(now);
}

function isComplete(session, now) {
  return session.isComplete(now);
}

function finalize(session, now) {
  return session.finalize(now);
}

const PuzzleStorm = {
  DEFAULT_DURATION_SEC,
  DEFAULT_DIFFICULTY_STEP,
  DEFAULT_SEED,
  StormSession,
  createSeededRng,
  startSession,
  recordResult,
  timeRemaining,
  isComplete,
  finalize
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PuzzleStorm;
}
if (typeof window !== 'undefined') {
  window.PuzzleStorm = PuzzleStorm;
}
