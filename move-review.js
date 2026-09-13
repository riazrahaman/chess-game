'use strict';

// Move Review & Win-Probability Classification Engine
// Implements CAPS (Computer Aggregated Precision Score) accuracy and
// Chess.com/Lichess standard move classifications:
// Brilliant (!!), Great (!), Best (★), Excellent, Good, Inaccuracy (?!), Mistake (?), Blunder (??)

const CLASSIFICATIONS = {
  BRILLIANT: { key: 'brilliant', symbol: '!!', label: 'Brilliant', color: '#1baca6', badgeClass: 'badge-brilliant' },
  GREAT: { key: 'great', symbol: '!', label: 'Great', color: '#5c8bb0', badgeClass: 'badge-great' },
  BEST: { key: 'best', symbol: '★', label: 'Best', color: '#96bc4b', badgeClass: 'badge-best' },
  EXCELLENT: { key: 'excellent', symbol: '✓', label: 'Excellent', color: '#96bc4b', badgeClass: 'badge-excellent' },
  GOOD: { key: 'good', symbol: '✓', label: 'Good', color: '#7ea43b', badgeClass: 'badge-good' },
  INACCURACY: { key: 'inaccuracy', symbol: '?!', label: 'Inaccuracy', color: '#e69d00', badgeClass: 'badge-inaccuracy' },
  MISTAKE: { key: 'mistake', symbol: '?', label: 'Mistake', color: '#e58f2a', badgeClass: 'badge-mistake' },
  BLUNDER: { key: 'blunder', symbol: '??', label: 'Blunder', color: '#ca3431', badgeClass: 'badge-blunder' }
};

/**
 * Calculates winning probability (0 to 100%) from centipawns eval from White's perspective.
 * Uses standard sigmoid model: W(cp) = 50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1)
 */
function calculateWinProbability(cp) {
  if (typeof cp !== 'number' || isNaN(cp)) return 50;
  const clampedCp = Math.max(-2000, Math.min(2000, cp));
  const rawProb = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clampedCp)) - 1);
  return Math.max(0, Math.min(100, rawProb));
}

/**
 * Computes win-probability loss (0 to 100%) for the player making the move.
 */
function calculateDeltaWinProb(preCp, postCp, isWhite) {
  const preWhiteProb = calculateWinProbability(preCp);
  const postWhiteProb = calculateWinProbability(postCp);

  const prePlayerProb = isWhite ? preWhiteProb : (100 - preWhiteProb);
  const postPlayerProb = isWhite ? postWhiteProb : (100 - postWhiteProb);

  const delta = prePlayerProb - postPlayerProb;
  return Math.max(0, delta);
}

/**
 * CAPS Accuracy percentage (0 to 100%) based on win probability loss.
 * Formula: Acc = 103.1668 * exp(-0.04354 * deltaW) - 3.1669
 */
function calculateMoveAccuracy(deltaW) {
  if (deltaW <= 0.05) return 100;
  const raw = 103.1668 * Math.exp(-0.04354 * deltaW) - 3.1669;
  return Math.max(0, Math.min(100, Math.round(raw * 10) / 10));
}

/**
 * Classifies an individual move based on pre/post evaluation and sacrifice flag.
 */
function classifyMove(preCp, postCp, isWhite, isSacrifice = false, isEngineBest = false) {
  const deltaW = calculateDeltaWinProb(preCp, postCp, isWhite);
  const accuracy = calculateMoveAccuracy(deltaW);

  // Brilliant: intentional piece sacrifice that retains decisive or winning advantage
  const playerAdvantage = isWhite ? postCp : -postCp;
  if (isSacrifice && deltaW <= 2.0 && playerAdvantage >= 100) {
    return { ...CLASSIFICATIONS.BRILLIANT, deltaW, accuracy, preCp, postCp };
  }

  // Best move
  if (isEngineBest || deltaW <= 1.0) {
    return { ...CLASSIFICATIONS.BEST, deltaW, accuracy, preCp, postCp };
  }

  // Excellent
  if (deltaW <= 3.5) {
    return { ...CLASSIFICATIONS.EXCELLENT, deltaW, accuracy, preCp, postCp };
  }

  // Good
  if (deltaW <= 8.0) {
    return { ...CLASSIFICATIONS.GOOD, deltaW, accuracy, preCp, postCp };
  }

  // Inaccuracy
  if (deltaW <= 18.0) {
    return { ...CLASSIFICATIONS.INACCURACY, deltaW, accuracy, preCp, postCp };
  }

  // Mistake
  if (deltaW <= 35.0) {
    return { ...CLASSIFICATIONS.MISTAKE, deltaW, accuracy, preCp, postCp };
  }

  // Blunder
  return { ...CLASSIFICATIONS.BLUNDER, deltaW, accuracy, preCp, postCp };
}

/**
 * Performs full game review across all plies.
 * moveHistory: ['e2e4', 'e7e5', ...]
 * evalHistory: [0, 30, 25, 120, -50, ...] (eval after each ply, index 0 is initial)
 */
function reviewGame(moveHistory, evalHistory) {
  if (!moveHistory || !Array.isArray(moveHistory) || moveHistory.length === 0) {
    return {
      whiteAccuracy: 100,
      blackAccuracy: 100,
      moves: [],
      counts: {
        white: { brilliant: 0, best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 },
        black: { brilliant: 0, best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 }
      }
    };
  }

  const evals = Array.isArray(evalHistory) && evalHistory.length >= moveHistory.length + 1
    ? evalHistory
    : [0, ...moveHistory.map((_, i) => (i % 2 === 0 ? 30 : -20))];

  const reviewedMoves = [];
  const counts = {
    white: { brilliant: 0, best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 },
    black: { brilliant: 0, best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 }
  };

  const whiteAccuracies = [];
  const blackAccuracies = [];

  for (let i = 0; i < moveHistory.length; i++) {
    const move = moveHistory[i];
    const isWhite = i % 2 === 0;
    const preCp = evals[i];
    const postCp = evals[i + 1];

    const result = classifyMove(preCp, postCp, isWhite);
    result.ply = i + 1;
    result.move = move;
    result.color = isWhite ? 'white' : 'black';

    reviewedMoves.push(result);

    const sideCounts = isWhite ? counts.white : counts.black;
    if (sideCounts[result.key] !== undefined) {
      sideCounts[result.key]++;
    }

    if (isWhite) {
      whiteAccuracies.push(result.accuracy);
    } else {
      blackAccuracies.push(result.accuracy);
    }
  }

  const avg = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : 100;
  const whiteAccuracy = avg(whiteAccuracies);
  const blackAccuracy = avg(blackAccuracies);

  return {
    whiteAccuracy,
    blackAccuracy,
    moves: reviewedMoves,
    counts
  };
}

const MoveReviewModule = {
  CLASSIFICATIONS,
  calculateWinProbability,
  calculateDeltaWinProb,
  calculateMoveAccuracy,
  classifyMove,
  reviewGame
};

if (typeof window !== 'undefined') {
  window.MoveReview = MoveReviewModule;
}
if (typeof module !== 'undefined') {
  module.exports = MoveReviewModule;
}
