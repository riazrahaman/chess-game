'use strict';

/**
 * eval-graph.js — Interactive evaluation graph builder.
 *
 * Replaces the static 400x80 sparkline with a click-to-jump graph that has
 * per-ply tooltips (SAN, eval, ACPL delta) and maps clicks to scrubber
 * ply indices.
 *
 * Gate 4: This module is a pure display/analysis layer.  It never calls
 * makeMove or createInitialBoard and never touches referee state.
 *
 * Public API:
 *   buildEvalGraph(evals, moves, opts)
 *     — returns { pathData, points, zeroY, width, height, plyCount,
 *         tooltips[], clickHandlers[] }
 *   buildTooltip(ply, cp, san, prevCp, opts)
 *     — returns { ply, evalText, san, acplDelta, acplText, classification }
 *   computeAcplDelta(cp, prevCp)
 *     — returns the centipawn loss for a move
 *   classifyMoveByDelta(delta)
 *     — returns a classification label from ACPL delta
 *   plyFromX(x, plyCount, width, paddingX)
 *     — maps an SVG x-coordinate to a ply index (for click-to-jump)
 */

/* ------------------------------------------------------------------ *
 * Constants                                                          *
 * ------------------------------------------------------------------ */

const DEFAULT_WIDTH = 400;
const DEFAULT_HEIGHT = 80;
const DEFAULT_PADDING_X = 10;
const DEFAULT_PADDING_Y = 8;
const EVAL_CLAMP = 800; // centipawns clamp range
const MATE_SENTINEL = 100000; // values >= this represent mate scores

/* ------------------------------------------------------------------ *
 * ACPL (Average Centipawn Loss) delta computation                    *
 * ------------------------------------------------------------------ */

/**
 * Compute the centipawn loss (ACPL delta) for a move.
 *
 * The delta is the evaluation drop from the player's perspective:
 *   - For White (even ply): positive delta = bad for White (loss)
 *   - For Black (odd ply): we negate so positive = bad for Black
 *
 * @param {number} cp      — centipawn eval AFTER the move
 * @param {number} prevCp  — centipawn eval BEFORE the move
 * @returns {number} centipawn loss (always >= 0 from mover's perspective,
 *                   negative means the move improved the position)
 */
function computeAcplDelta(cp, prevCp) {
  if (typeof cp !== 'number' || typeof prevCp !== 'number') return 0;
  // Handle mate sentinels
  if (Math.abs(cp) >= MATE_SENTINEL || Math.abs(prevCp) >= MATE_SENTINEL) {
    return 0; // mate positions — no meaningful ACPL
  }
  // Delta from the mover's perspective: if previous eval was +100 (good for White)
  // and after White's move it's +80, White lost 20 cp.
  // For Black's move: if eval was +100 (good for White) and after Black's move
  // it's +50, Black improved their position by 50 cp (delta = 50 for Black).
  // We return the absolute loss from the mover's perspective.
  return Math.max(0, prevCp - cp);
}

/**
 * Classify a move by its ACPL delta.
 *
 * @param {number} delta  — centipawn loss
 * @returns {string} classification label
 */
function classifyMoveByDelta(delta) {
  if (typeof delta !== 'number' || !isFinite(delta)) return 'unknown';
  if (delta <= 10) return 'best';
  if (delta <= 25) return 'excellent';
  if (delta <= 50) return 'good';
  if (delta <= 100) return 'inaccuracy';
  if (delta <= 300) return 'mistake';
  return 'blunder';
}

/* ------------------------------------------------------------------ *
 * Tooltip builder                                                    *
 * ------------------------------------------------------------------ */

/**
 * Build a tooltip object for a single ply.
 *
 * @param {number} ply     — ply index (0-based)
 * @param {number} cp      — centipawn eval at this ply
 * @param {string} [san]   — SAN move string for this ply
 * @param {number} [prevCp]— centipawn eval at previous ply
 * @param {object} [opts]  — { showClassification?: boolean }
 * @returns {object} { ply, evalText, san, acplDelta, acplText, classification }
 */
function buildTooltip(ply, cp, san, prevCp, opts) {
  opts = opts || {};
  const evalText = formatEval(cp);
  const delta = computeAcplDelta(cp, prevCp);
  const acplText = formatAcplDelta(delta, cp, prevCp);
  const classification = opts.showClassification !== false
    ? classifyMoveByDelta(delta)
    : null;

  return {
    ply: typeof ply === 'number' ? ply : 0,
    evalText,
    san: san || null,
    acplDelta: delta,
    acplText,
    classification
  };
}

/**
 * Format a centipawn eval as a human-readable string.
 * @param {number} cp
 * @returns {string} e.g. "+1.25", "-0.80", "Mate", "0.00"
 */
function formatEval(cp) {
  if (typeof cp !== 'number' || !isFinite(cp)) return '—';
  if (Math.abs(cp) >= MATE_SENTINEL) {
    return cp > 0 ? 'Mate for White' : 'Mate for Black';
  }
  const sign = cp > 0 ? '+' : '';
  return sign + (cp / 100).toFixed(2);
}

/**
 * Format the ACPL delta as a human-readable string.
 * @param {number} delta
 * @param {number} cp
 * @param {number} prevCp
 * @returns {string} e.g. "Δ -0.20", "Best", "—"
 */
function formatAcplDelta(delta, cp, prevCp) {
  if (typeof cp !== 'number' || !isFinite(cp)) return '—';
  // First ply (no previous) — no ACPL to report
  if (typeof prevCp !== 'number' || !isFinite(prevCp)) return 'Best';
  if (Math.abs(cp) >= MATE_SENTINEL || Math.abs(prevCp) >= MATE_SENTINEL) return '—';
  if (delta === 0) return 'Best';
  const sign = delta > 0 ? '-' : '+';
  return 'Δ ' + sign + (Math.abs(delta) / 100).toFixed(2);
}

/* ------------------------------------------------------------------ *
 * Graph builder                                                      *
 * ------------------------------------------------------------------ */

/**
 * Build an interactive eval graph data structure.
 *
 * @param {number[]} evals     — centipawn evals per ply
 * @param {string[]} [moves]   — SAN move strings per ply (optional)
 * @param {object} [opts]      — { width, height, paddingX, paddingY, showClassification }
 * @returns {object} { pathData, points, zeroY, width, height, plyCount,
 *                     tooltips[], clickTargets[] }
 */
function buildEvalGraph(evals, moves, opts) {
  opts = opts || {};
  const width = opts.width || DEFAULT_WIDTH;
  const height = opts.height || DEFAULT_HEIGHT;
  const paddingX = opts.paddingX != null ? opts.paddingX : DEFAULT_PADDING_X;
  const paddingY = opts.paddingY != null ? opts.paddingY : DEFAULT_PADDING_Y;

  if (!Array.isArray(evals) || evals.length === 0) {
    evals = [0];
  }

  const zeroY = height / 2;
  const usableWidth = Math.max(1, width - paddingX * 2);
  const usableHeight = Math.max(1, height - paddingY * 2);
  const stepX = evals.length > 1 ? usableWidth / (evals.length - 1) : usableWidth;

  const points = evals.map((cp, idx) => {
    const x = paddingX + (evals.length > 1 ? idx * stepX : usableWidth / 2);
    const clamped = Math.max(-EVAL_CLAMP, Math.min(EVAL_CLAMP, typeof cp === 'number' ? cp : 0));
    const normalized = -clamped / EVAL_CLAMP;
    const y = zeroY + (normalized * (usableHeight / 2));
    return { x, y, cp, ply: idx };
  });

  const pathData = points.map((pt, i) =>
    `${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`
  ).join(' ');

  // Build tooltips with ACPL delta
  const tooltips = points.map((pt, idx) => {
    const prevCp = idx > 0 ? evals[idx - 1] : null;
    const san = (Array.isArray(moves) && moves[idx]) ? moves[idx] : null;
    return buildTooltip(pt.ply, pt.cp, san, prevCp, opts);
  });

  // Build click targets (ply index + x-coordinate for hit areas)
  const clickTargets = points.map(pt => ({
    ply: pt.ply,
    x: pt.x,
    y: pt.y,
    radius: 6 // hit area radius in SVG units
  }));

  return {
    pathData,
    points,
    zeroY,
    width,
    height,
    plyCount: points.length,
    tooltips,
    clickTargets
  };
}

/* ------------------------------------------------------------------ *
 * Click-to-ply mapping                                               *
 * ------------------------------------------------------------------ */

/**
 * Map an SVG x-coordinate to a ply index.
 * Useful for click-to-jump: given the mouse x position on the graph,
 * determine which ply to jump to.
 *
 * @param {number} x         — SVG x-coordinate
 * @param {number} plyCount  — total number of plies
 * @param {number} width     — graph width
 * @param {number} paddingX  — horizontal padding
 * @returns {number} ply index (0-based), clamped to [0, plyCount-1]
 */
function plyFromX(x, plyCount, width, paddingX) {
  if (typeof x !== 'number' || typeof plyCount !== 'number' || plyCount <= 0) return 0;
  width = width || DEFAULT_WIDTH;
  paddingX = paddingX != null ? paddingX : DEFAULT_PADDING_X;
  const usableWidth = Math.max(1, width - paddingX * 2);
  const stepX = plyCount > 1 ? usableWidth / (plyCount - 1) : usableWidth;
  const relX = x - paddingX;
  const ply = Math.round(relX / stepX);
  return Math.max(0, Math.min(plyCount - 1, ply));
}

/* ------------------------------------------------------------------ *
 * Module exports                                                     *
 * ------------------------------------------------------------------ */

const EvalGraphAPI = {
  buildEvalGraph,
  buildTooltip,
  computeAcplDelta,
  classifyMoveByDelta,
  formatEval,
  formatAcplDelta,
  plyFromX,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  EVAL_CLAMP,
  MATE_SENTINEL
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = EvalGraphAPI;
}

if (typeof window !== 'undefined') {
  window.EvalGraph = EvalGraphAPI;
}