'use strict';

let Rating = null;
let GameArchive = null;
if (typeof require === 'function') {
  try { Rating = require('./rating.js'); } catch (_) {}
  try { GameArchive = require('./game-archive.js'); } catch (_) {}
}
if (!Rating && typeof window !== 'undefined') Rating = window.Rating;
if (!GameArchive && typeof window !== 'undefined') GameArchive = window.GameArchive;

const MIN_RATING = 400;
const MAX_RATING = 2400;
const DEFAULT_SOLVER_RATING = 1500;
const DEFAULT_SOLVER_RD = 350;
const DEFAULT_PUZZLE_RD = 100;
const DEFAULT_VOLATILITY = 0.06;
const DEFAULT_TAU = 0.5;
const DEFAULT_SOLVER_ID = 'default';

function requireRatingEngine() {
  if (!Rating || typeof Rating.createPlayer !== 'function' || typeof Rating.updateRating !== 'function') {
    throw new Error('puzzle-rating.js: rating.js is required');
  }
}

function clampRating(value) {
  const rating = Number(value);
  if (!Number.isFinite(rating)) return DEFAULT_SOLVER_RATING;
  return Math.min(MAX_RATING, Math.max(MIN_RATING, rating));
}

function createSolverRating(data = {}) {
  requireRatingEngine();
  const source = typeof data === 'number' ? { rating: data } : (data || {});
  return {
    id: source.id == null ? DEFAULT_SOLVER_ID : String(source.id),
    ...Rating.createPlayer(
      clampRating(source.rating == null ? DEFAULT_SOLVER_RATING : source.rating),
      Number.isFinite(source.rd) ? source.rd : DEFAULT_SOLVER_RD,
      Number.isFinite(source.vol) ? source.vol : DEFAULT_VOLATILITY
    )
  };
}

function createPuzzleRating(puzzle = {}) {
  requireRatingEngine();
  const source = typeof puzzle === 'number' ? { rating: puzzle } : (puzzle || {});
  const importedRating = source.rating == null ? DEFAULT_SOLVER_RATING : source.rating;
  const importedRd = Number.isFinite(source.rd)
    ? source.rd
    : (Number.isFinite(source.ratingDeviation) ? source.ratingDeviation : DEFAULT_PUZZLE_RD);
  return {
    id: source.id == null ? '' : String(source.id),
    ...Rating.createPlayer(
      clampRating(importedRating),
      importedRd,
      Number.isFinite(source.vol) ? source.vol : DEFAULT_VOLATILITY
    )
  };
}

/**
 * Returns a 0..1 speed factor. Solves at or under 60 seconds receive the
 * maximum bonus; the factor falls smoothly for slower solves.
 */
function calculateTimeBonus(timeSec) {
  const seconds = Number(timeSec);
  if (!Number.isFinite(seconds) || seconds <= 0) return 1;
  return Math.min(1, 60 / seconds);
}

/**
 * A failed solve scores 0. A solved puzzle scores 0.75 plus a bounded speed
 * bonus worth at most 0.25, keeping every result within the Glicko 0..1 range.
 */
function calculateSolveScore(result, timeSec) {
  if (result === 'failed') return 0;
  if (result !== 'solved') return null;
  return Math.min(1, 0.75 + 0.25 * calculateTimeBonus(timeSec));
}

function clampPlayer(player) {
  return { ...player, rating: clampRating(player.rating) };
}

/**
 * Pure two-sided Glicko-2 update. Puzzle score is the complement of solver
 * score, and both updates use the unchanged pre-attempt opponent rating.
 */
function recordSolve(solver, puzzle, result, timeSec) {
  requireRatingEngine();
  const currentSolver = createSolverRating(solver);
  const currentPuzzle = createPuzzleRating(puzzle);

  if (result == null) {
    return { solver: currentSolver, puzzle: currentPuzzle, score: null, recorded: false };
  }
  if (result !== 'solved' && result !== 'failed') {
    throw new TypeError("recordSolve result must be 'solved' or 'failed'");
  }

  const score = calculateSolveScore(result, timeSec);
  const nextSolver = Rating.updateRating(
    currentSolver,
    [{ opponent: currentPuzzle, score }],
    DEFAULT_TAU
  );
  const nextPuzzle = Rating.updateRating(
    currentPuzzle,
    [{ opponent: currentSolver, score: 1 - score }],
    DEFAULT_TAU
  );

  return {
    solver: { id: currentSolver.id, ...clampPlayer(nextSolver) },
    puzzle: { id: currentPuzzle.id, ...clampPlayer(nextPuzzle) },
    score,
    recorded: true
  };
}

function puzzleNumericRating(puzzle) {
  if (!puzzle) return null;
  if (puzzle.puzzleRating && Number.isFinite(puzzle.puzzleRating.rating)) {
    return clampRating(puzzle.puzzleRating.rating);
  }
  return Number.isFinite(puzzle.rating) ? clampRating(puzzle.rating) : null;
}

function selectNextPuzzle(solver, puzzles) {
  if (!Array.isArray(puzzles) || puzzles.length === 0) return null;
  const solverRating = createSolverRating(solver).rating;
  let selected = null;
  let smallestDistance = Infinity;

  for (const puzzle of puzzles) {
    const rating = puzzleNumericRating(puzzle);
    if (rating == null) continue;
    const distance = Math.abs(rating - solverRating);
    if (distance < smallestDistance) {
      selected = puzzle;
      smallestDistance = distance;
    }
  }
  return selected;
}

/**
 * Stateful facade. Ratings are always retained in memory. When a compatible
 * game-archive.js surface is supplied/available, each write is persisted and
 * later store instances can restore it. Archive errors degrade to memory only.
 */
class PuzzleRatingStore {
  constructor(options = {}) {
    this.archive = Object.prototype.hasOwnProperty.call(options, 'archive')
      ? options.archive
      : GameArchive;
    this.solverRatings = new Map();
    this.puzzleRatings = new Map();
  }

  _load(kind, id) {
    const memory = kind === 'solver' ? this.solverRatings : this.puzzleRatings;
    if (memory.has(id)) return { ...memory.get(id) };
    if (!this.archive || typeof this.archive.getPuzzleRating !== 'function') return null;
    try {
      const saved = this.archive.getPuzzleRating(kind, id);
      if (!saved) return null;
      const rating = { id, rating: saved.rating, rd: saved.rd, vol: saved.vol };
      memory.set(id, rating);
      return { ...rating };
    } catch (_) {
      return null;
    }
  }

  _save(kind, value) {
    const id = String(value.id);
    const memory = kind === 'solver' ? this.solverRatings : this.puzzleRatings;
    const rating = { id, rating: value.rating, rd: value.rd, vol: value.vol };
    memory.set(id, rating);
    if (this.archive && typeof this.archive.savePuzzleRating === 'function') {
      try { this.archive.savePuzzleRating(kind, id, rating); } catch (_) {}
    }
    return { ...rating };
  }

  getSolver(solverId = DEFAULT_SOLVER_ID) {
    const id = String(solverId);
    return this._load('solver', id) || createSolverRating({ id });
  }

  getPuzzle(puzzle) {
    if (!puzzle || puzzle.id == null || String(puzzle.id) === '') {
      throw new TypeError('PuzzleRatingStore.getPuzzle requires a puzzle id');
    }
    const id = String(puzzle.id);
    return this._load('puzzle', id) || createPuzzleRating(puzzle);
  }

  recordSolve(puzzle, result, timeSec, solverId = DEFAULT_SOLVER_ID) {
    const updated = recordSolve(this.getSolver(solverId), this.getPuzzle(puzzle), result, timeSec);
    if (!updated.recorded) return updated;
    updated.solver = this._save('solver', updated.solver);
    updated.puzzle = this._save('puzzle', updated.puzzle);
    return updated;
  }
}

const PuzzleRating = {
  MIN_RATING,
  MAX_RATING,
  createSolverRating,
  createPuzzleRating,
  clampRating,
  calculateTimeBonus,
  calculateSolveScore,
  recordSolve,
  selectNextPuzzle,
  PuzzleRatingStore
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PuzzleRating;
}
if (typeof window !== 'undefined') {
  window.PuzzleRating = PuzzleRating;
}
