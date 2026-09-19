'use strict';

/**
 * missed-tactics.js — Wave 3 (roadmap §6 N1.3, kanban w3-missed-tactics).
 *
 * The other half of C7 (move-review.js generateMistakePuzzles = the player's
 * OWN blunders): positions where the OPPONENT blundered and the player failed
 * to punish. Chess.com "Miss" semantics — a missed win/tactic, distinct from a
 * Blunder (which is a move that throws away the game by itself).
 *
 * Rule (per ply i, the player's move; evals are White-perspective centipawns
 * for positions[0..N], evals[i] = engine eval of positions[i], i.e. the score
 * of the position with best play = the best move's value):
 *
 *   swingCp    = eval(i)   - eval(i-1)   from the player's point of view
 *                (how much the opponent's move just handed over)  >= 150 cp
 *   giveBackCp = eval(i)   - eval(i+1)   from the player's point of view
 *                (how much the reply gave back relative to the best move) >= 100 cp
 *   and the reply still leaves the player "fine" (otherwise it is a Blunder):
 *                eval(i+1) >= eval(i-1) - 50 cp (not worse than before the
 *                opponent's gift) AND eval(i+1) >= -200 cp (not losing), both
 *                from the player's view. A missed mate-in-1 in a level game is
 *                therefore a Miss; a reply that walks back into a lost position
 *                (e.g. allows the mate the opponent threatened) is a Blunder —
 *                Chess.com semantics.
 *
 * Centipawns are clamped to ±2000 (the bound calculateWinProbability uses)
 * before the swing / give-back arithmetic so mate scores do not leak "+109
 * pawns" into the UI. Win-probability deltas for both quantities are reported
 * alongside, computed with move-review.js's logistic, so callers can rank
 * misses by how much they mattered rather than by raw centipawns.
 *
 * Pure: no I/O, no engine, no DOM. Server-side only (routes-review.js).
 */

const MoveReview = require('./move-review.js');

const MISS_SWING_CP = 150;
const MISS_GIVEBACK_CP = 100;
const MISS_TOLERANCE_CP = 50;  // reply may end at most this much below the pre-gift eval
const MISS_LOSING_CP = -200;   // a reply that leaves the player below this is a Blunder, not a Miss
const CP_CLAMP = 2000;         // same bound as move-review.calculateWinProbability
const MATE_CP = 10000;

function clampCp(cp) { return Math.max(-CP_CLAMP, Math.min(CP_CLAMP, cp)); }
const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

function mateToCp(mate) {
  if (typeof mate !== 'number' || !Number.isFinite(mate)) return null;
  if (mate === 0) return null;
  return (mate > 0 ? 1 : -1) * (MATE_CP - Math.min(Math.abs(mate), 100) * 10);
}

/**
 * Normalises one evals[] entry to { cp, mate, bestMove }. Accepts a bare number
 * (White-perspective cp), or an object with cp / mate / bestmove|bestMove.
 * Returns null when no numeric eval is available.
 */
function normalizeEval(e) {
  if (typeof e === 'number') return Number.isFinite(e) ? { cp: e, mate: null, bestMove: null } : null;
  if (!e || typeof e !== 'object') return null;
  const mate = typeof e.mate === 'number' && Number.isFinite(e.mate) ? e.mate : null;
  let cp = typeof e.cp === 'number' && Number.isFinite(e.cp) ? e.cp : null;
  if (cp === null && mate !== null) cp = mateToCp(mate);
  if (cp === null) return null;
  const bm = e.bestMove || e.bestmove || null;
  return { cp, mate, bestMove: typeof bm === 'string' && UCI_RE.test(bm) ? bm : (typeof bm === 'string' && bm ? bm : null) };
}

function turnFromFen(fen, ply) {
  const t = String(fen || '').split(/\s+/)[1];
  if (t === 'w' || t === 'b') return t === 'w' ? 'white' : 'black';
  return ply % 2 === 0 ? 'white' : 'black'; // positions[ply] with ply even → White to move
}

function pieceAt(fen, square) {
  const placement = String(fen || '').split(/\s+/)[0];
  if (!placement || !/^[a-h][1-8]$/.test(square)) return null;
  const ranks = placement.split('/');
  if (ranks.length !== 8) return null;
  const rankIdx = 8 - Number(square[1]);
  const fileIdx = square.charCodeAt(0) - 97;
  let f = 0;
  for (const ch of ranks[rankIdx] || '') {
    if (/\d/.test(ch)) { f += Number(ch); continue; }
    if (f === fileIdx) return ch;
    f++;
  }
  return null;
}

function themeFor(fen, best, evAt, color) {
  if (evAt && typeof evAt.mate === 'number' && evAt.mate !== 0) {
    const forMover = color === 'white' ? evAt.mate : -evAt.mate;
    if (forMover > 0) return 'mate';
  }
  if (best && UCI_RE.test(best)) {
    if (pieceAt(fen, best.slice(2, 4))) return 'capture';
    if (best.length === 5) return 'promotion';
  }
  return 'tactic';
}

function playedMoveOf(pos) {
  if (!pos) return null;
  if (typeof pos.uci === 'string' && UCI_RE.test(pos.uci)) return pos.uci;
  const lm = pos.lastMove;
  if (lm && typeof lm.from === 'string' && typeof lm.to === 'string') return lm.from + lm.to + (lm.promotion || '');
  return null;
}

/**
 * @param {Array<{fen:string, san?:string, lastMove?:{from,to}}>} positions  per-ply positions (length N+1)
 * @param {Array<number|{cp?:number, mate?:number, bestmove?:string, bestMove?:string}>} evals  White-perspective, per position
 * @param {{color?: 'white'|'black'|null, swingCp?: number, giveBackCp?: number}} [opts]
 * @returns {Array<{ply, color, fen, bestMove, playedMove, playedSan, swingCp, giveBackCp,
 *                  swingWinProb, giveBackWinProb, evalBeforeCp, evalAtCp, evalAfterCp, theme}>}
 */
function findMissedTactics(positions, evals, opts = {}) {
  if (!Array.isArray(positions) || !Array.isArray(evals) || positions.length < 3) return [];
  const swingMin = typeof opts.swingCp === 'number' ? opts.swingCp : MISS_SWING_CP;
  const giveBackMin = typeof opts.giveBackCp === 'number' ? opts.giveBackCp : MISS_GIVEBACK_CP;
  const onlyColor = opts.color === 'white' || opts.color === 'black' ? opts.color : null;
  const n = Math.min(positions.length, evals.length);
  const out = [];
  for (let i = 1; i + 1 < n; i++) {
    const before = normalizeEval(evals[i - 1]);
    const at = normalizeEval(evals[i]);
    const after = normalizeEval(evals[i + 1]);
    if (!before || !at || !after) continue;
    const pos = positions[i];
    if (!pos) continue;
    const color = turnFromFen(pos.fen, i);
    if (onlyColor && color !== onlyColor) continue;
    const sign = color === 'white' ? 1 : -1;
    const pBefore = sign * clampCp(before.cp); // player's view, clamped
    const pAt = sign * clampCp(at.cp);
    const pAfter = sign * clampCp(after.cp);
    const swingCp = pAt - pBefore;
    const giveBackCp = pAt - pAfter;
    if (swingCp < swingMin || giveBackCp < giveBackMin) continue;
    if (pAfter < pBefore - MISS_TOLERANCE_CP) continue; // worse than before the gift → Blunder, not Miss
    if (pAfter < MISS_LOSING_CP) continue;              // left in a losing position → Blunder, not Miss
    const isWhite = color === 'white';
    const giveBackWinProb = MoveReview.calculateDeltaWinProb(at.cp, after.cp, isWhite);
    const swingWinProb = MoveReview.calculateDeltaWinProb(before.cp, at.cp, !isWhite); // opponent's loss = our gain
    out.push({
      ply: i + 1,
      color,
      fen: pos.fen,
      bestMove: at.bestMove || null,
      playedMove: playedMoveOf(positions[i + 1]),
      playedSan: (positions[i + 1] && positions[i + 1].san) || null,
      swingCp: Math.round(swingCp),
      giveBackCp: Math.round(giveBackCp),
      swingWinProb: Math.round(swingWinProb * 10) / 10,
      giveBackWinProb: Math.round(giveBackWinProb * 10) / 10,
      evalBeforeCp: Math.round(before.cp),
      evalAtCp: Math.round(at.cp),
      evalAfterCp: Math.round(after.cp),
      theme: themeFor(pos.fen, at.bestMove, at, color)
    });
  }
  return out;
}

module.exports = {
  findMissedTactics,
  normalizeEval,
  mateToCp,
  pieceAt,
  MISS_SWING_CP,
  MISS_GIVEBACK_CP,
  MISS_TOLERANCE_CP,
  MISS_LOSING_CP,
  CP_CLAMP,
  MATE_CP
};
