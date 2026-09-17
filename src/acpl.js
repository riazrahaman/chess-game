(function() {
'use strict';

/**
 * acpl.js — A2.7 Report upgrades: ACPL + phase-segmented accuracy + move-time stats.
 *
 * Pure computation layer over an eval history (centipawns from White's perspective)
 * and a move history. Gate 4: never calls makeMove or createInitialBoard, never
 * touches referee state.
 *
 * Public API:
 *   computeAcpl(evalHistory, moveHistory)      — overall + per-side ACPL
 *   phaseAcpl(evalHistory, moveHistory)        — opening/middlegame/endgame ACPL
 *   moveTimeStats(moveTimes)                    — aggregate + per-side time stats
 *   phaseSegmentedAccuracy(review)              — accuracy split by phase
 *   enrichReport(report, options)               — attach all A2.7 fields to a report
 */

function clampCp(cp) {
  if (typeof cp !== 'number' || isNaN(cp)) return 0;
  return Math.max(-1000, Math.min(1000, cp));
}

/**
 * Average Centipawn Loss per move. For each ply i, the player's loss is the
 * swing in win probability (cp) against them: |evalAfter - evalBefore| but only
 * counted as a loss when the eval moved against the mover.
 * We use a simpler, robust proxy: centipawn loss = max(0, before - after) from
 * the mover's perspective (i.e. the position got worse for them).
 */
function computeAcpl(evalHistory, moveHistory) {
  const evals = Array.isArray(evalHistory) ? evalHistory : [];
  const moves = Array.isArray(moveHistory) ? moveHistory : [];
  if (evals.length < 2 || moves.length === 0) {
    return { white: 0, black: 0, overall: 0, plies: 0 };
  }

  let whiteLoss = 0, blackLoss = 0, whiteN = 0, blackN = 0;
  for (let i = 0; i < moves.length; i++) {
    const before = evals[i];
    const after = evals[i + 1];
    if (typeof before !== 'number' || typeof after !== 'number') continue;
    const isWhite = i % 2 === 0;
    // White's eval: positive = good for white. For a white move, loss = before - after.
    // For a black move, loss = after - before (black wants eval low).
    const loss = isWhite ? (before - after) : (after - before);
    const capped = Math.max(0, clampCp(loss));
    if (isWhite) { whiteLoss += capped; whiteN++; }
    else { blackLoss += capped; blackN++; }
  }

  const white = whiteN ? Math.round((whiteLoss / whiteN) * 10) / 10 : 0;
  const black = blackN ? Math.round((blackLoss / blackN) * 10) / 10 : 0;
  const overall = (whiteN + blackN) ? Math.round(((whiteLoss + blackLoss) / (whiteN + blackN)) * 10) / 10 : 0;
  return { white, black, overall, plies: whiteN + blackN };
}

const PHASE_BOUNDARY_MOVES = { opening: 10, middlegame: 40 };

/**
 * Split ACPL by game phase using the standard lichess heuristic:
 * opening = first 10 full moves, middlegame = through move 40, endgame = rest.
 */
function phaseAcpl(evalHistory, moveHistory) {
  const evals = Array.isArray(evalHistory) ? evalHistory : [];
  const moves = Array.isArray(moveHistory) ? moveHistory : [];

  function slice(plyStart, plyEnd) {
    const subMoves = moves.slice(plyStart, plyEnd);
    const subEvals = evals.slice(plyStart, plyEnd + 1);
    return { subMoves, subEvals };
  }

  const opening = computeAcpl(slice(0, PHASE_BOUNDARY_MOVES.opening * 2).subEvals, slice(0, PHASE_BOUNDARY_MOVES.opening * 2).subMoves);
  const midStart = PHASE_BOUNDARY_MOVES.opening * 2;
  const midEnd = PHASE_BOUNDARY_MOVES.middlegame * 2;
  const mid = computeAcpl(slice(midStart, midEnd).subEvals, slice(midStart, midEnd).subMoves);
  const end = computeAcpl(slice(midEnd, moves.length).subEvals, slice(midEnd, moves.length).subMoves);

  return { opening, middlegame: mid, endgame: end };
}

/**
 * Move-time statistics. `moveTimes` is an array of per-ply seconds.
 */
function moveTimeStats(moveTimes) {
  const times = Array.isArray(moveTimes) ? moveTimes.map(Number).filter(n => Number.isFinite(n) && n >= 0) : [];
  if (times.length === 0) return { count: 0, average: 0, max: 0, min: 0, white: 0, black: 0, whiteCount: 0, blackCount: 0 };

  const sum = times.reduce((a, b) => a + b, 0);
  let white = 0, black = 0, whiteCount = 0, blackCount = 0;
  times.forEach((t, i) => {
    if (i % 2 === 0) { white += t; whiteCount++; }
    else { black += t; blackCount++; }
  });

  return {
    count: times.length,
    average: Math.round((sum / times.length) * 10) / 10,
    max: Math.max.apply(null, times),
    min: Math.min.apply(null, times),
    white: whiteCount ? Math.round((white / whiteCount) * 10) / 10 : 0,
    black: blackCount ? Math.round((black / blackCount) * 10) / 10 : 0,
    whiteCount,
    blackCount
  };
}

/**
 * Accuracy split by phase from a review's moves (each has ply + accuracy).
 */
function phaseSegmentedAccuracy(review) {
  const moves = (review && Array.isArray(review.moves)) ? review.moves : [];
  const buckets = { opening: [], middlegame: [], endgame: [] };

  for (const m of moves) {
    const ply = m.ply || 0;
    const acc = typeof m.accuracy === 'number' ? m.accuracy : null;
    if (acc === null) continue;
    const moveNum = Math.ceil(ply / 2);
    if (moveNum <= PHASE_BOUNDARY_MOVES.opening) buckets.opening.push(acc);
    else if (moveNum <= PHASE_BOUNDARY_MOVES.middlegame) buckets.middlegame.push(acc);
    else buckets.endgame.push(acc);
  }

  const avg = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;
  return {
    opening: avg(buckets.opening),
    middlegame: avg(buckets.middlegame),
    endgame: avg(buckets.endgame)
  };
}

/**
 * Attach A2.7 fields to an existing report object (or build a minimal one).
 */
function enrichReport(report, options = {}) {
  const base = report || {};
  const evalHistory = options.evalHistory || [];
  const moveHistory = options.moveHistory || [];
  const moveTimes = options.moveTimes || [];
  const review = options.review || base.review || { moves: [] };

  return {
    ...base,
    acpl: computeAcpl(evalHistory, moveHistory),
    phaseAcpl: phaseAcpl(evalHistory, moveHistory),
    moveTime: moveTimeStats(moveTimes),
    phaseAccuracy: phaseSegmentedAccuracy(review)
  };
}

const AcplModule = {
  computeAcpl,
  phaseAcpl,
  moveTimeStats,
  phaseSegmentedAccuracy,
  enrichReport,
  PHASE_BOUNDARY_MOVES
};

if (typeof window !== 'undefined') {
  window.Acpl = AcplModule;
}
if (typeof module !== 'undefined') {
  module.exports = AcplModule;
}
})();
