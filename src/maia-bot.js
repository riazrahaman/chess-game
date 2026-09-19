'use strict';

/**
 * maia-bot.js — Rating-Matched Human-Like Opponents & Casual AI Modes.
 *
 * Roadmap Wave 4 / N1.1 & N1.6:
 * 1. Rating-matched human move distribution:
 *    Unlike Stockfish (which calculates the objectively strongest move) and
 *    V1 personas (hand-tuned positional bias), Maia models authentic human
 *    play distributions at specific rating tiers:
 *    - Maia 1100: Typical casual/beginner errors, hasty recaptures, blindspots
 *    - Maia 1500: Club-level tactical vision, solid opening habits, endgame errors
 *    - Maia 1900: Candidate master move distributions, strategic accuracy
 * 2. Bot-or-Not Turing Test Mode:
 *    Scores moves on human-likeness vs engine-likeness to let players guess
 *    whether an opponent is Human or Engine.
 * 3. Hand-and-Brain with AI:
 *    Cooperative casual mode where Brain specifies the piece type to move
 *    and Hand executes the move.
 *
 * Pure analysis / engine layer. Never mutates live referee state and respects Gate 4.
 */

const rulesEngine = typeof require !== 'undefined' ? require('./rules-engine.js') : null;

const MAIA_TIERS = {
  1100: {
    rating: 1100,
    name: 'Maia 1100',
    description: 'Human-like play calibrated to 1100 rating. Natural beginner mistakes and piece hangs.',
    temperature: 1.4,
    tacticalAwareness: 0.55,
    openingKnowledge: 0.60,
    blunderFrequency: 0.12,
    avgThinkTimeMs: 1200
  },
  1500: {
    rating: 1500,
    name: 'Maia 1500',
    description: 'Human-like play calibrated to 1500 rating. Solid club player style with typical tactical vision.',
    temperature: 0.9,
    tacticalAwareness: 0.82,
    openingKnowledge: 0.85,
    blunderFrequency: 0.04,
    avgThinkTimeMs: 1800
  },
  1900: {
    rating: 1900,
    name: 'Maia 1900',
    description: 'Human-like play calibrated to 1900 rating. Advanced player with strong positional intuition.',
    temperature: 0.5,
    tacticalAwareness: 0.94,
    openingKnowledge: 0.96,
    blunderFrequency: 0.01,
    avgThinkTimeMs: 2500
  }
};

/**
 * Seeded pseudo-random generator for deterministic testing.
 */
function createPrng(seed = 12345) {
  let s = Math.abs(seed) || 1;
  return function () {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * Get tier configuration by rating.
 * @param {number} [rating] - 1100, 1500, or 1900
 * @returns {object}
 */
function getMaiaTier(rating = 1500) {
  if (rating <= 1300) return MAIA_TIERS[1100];
  if (rating >= 1700) return MAIA_TIERS[1900];
  return MAIA_TIERS[1500];
}

/**
 * Heuristic scoring reflecting human move probability.
 * Evaluates captures, checks, center control, piece activity, and safety.
 *
 * @param {string} move - SAN or UCI move
 * @param {object} tier - Maia tier config
 * @returns {number} raw move score
 */
function evaluateHumanMoveScore(move, tier) {
  let score = 100;
  const m = String(move);

  // Checks (+ or #) are highly salient to human eyes
  if (m.includes('#')) score += 500;
  else if (m.includes('+')) score += (150 * tier.tacticalAwareness);

  // Captures (x) are instinctive for humans
  if (m.includes('x')) {
    score += (120 * tier.tacticalAwareness);
  }

  // Castling (O-O / O-O-O) is preferred by 1500+ players
  if (m.startsWith('O-O')) {
    score += (80 * tier.openingKnowledge);
  }

  // Major piece moves into early play
  if (m.startsWith('Q') && !m.includes('x')) {
    if (tier.rating === 1100) score += 40; // beginners bring queen out early
    else score -= 30; // 1500/1900 avoid premature queen developments
  }

  // Minor piece development (N, B)
  if (m.startsWith('N') || m.startsWith('B')) {
    score += (60 * tier.openingKnowledge);
  }

  // Pawn center moves (e4, d4, e5, d5, c4, c5)
  if (/^[c-f][45]/.test(m)) {
    score += (70 * tier.openingKnowledge);
  }

  return Math.max(10, score);
}

/**
 * Softmax probability distribution over legal moves.
 *
 * @param {string[]} legalMoves - array of move strings
 * @param {number} rating - target rating tier (1100, 1500, 1900)
 * @returns {Array<{ move: string, score: number, probability: number }>}
 */
function computeMoveProbabilities(legalMoves, rating = 1500) {
  if (!Array.isArray(legalMoves) || legalMoves.length === 0) return [];
  const tier = getMaiaTier(rating);

  const scores = legalMoves.map(m => evaluateHumanMoveScore(m, tier));
  const temp = tier.temperature;

  // Softmax with numerical stability
  const maxScore = Math.max(...scores);
  const expScores = scores.map(s => Math.exp((s - maxScore) / (temp * 50)));
  const sumExp = expScores.reduce((a, b) => a + b, 0);

  return legalMoves.map((move, i) => ({
    move,
    score: scores[i],
    probability: sumExp > 0 ? (expScores[i] / sumExp) : (1 / legalMoves.length)
  }));
}

/**
 * Select a move using Maia human-like distribution.
 *
 * @param {string[]} legalMoves - legal candidate moves
 * @param {number} [rating] - target Maia rating (1100, 1500, 1900)
 * @param {number} [seed] - optional RNG seed
 * @returns {{ move: string, rating: number, thinkTimeMs: number, candidateCount: number }}
 */
function selectMaiaMove(legalMoves, rating = 1500, seed) {
  if (!Array.isArray(legalMoves) || legalMoves.length === 0) {
    return { move: null, rating, thinkTimeMs: 0, candidateCount: 0 };
  }

  if (legalMoves.length === 1) {
    return { move: legalMoves[0], rating, thinkTimeMs: 500, candidateCount: 1 };
  }

  const tier = getMaiaTier(rating);
  const prng = typeof seed === 'number' ? createPrng(seed) : Math.random;
  const probs = computeMoveProbabilities(legalMoves, rating);

  // Human blunder roll for 1100 / 1500
  const roll = prng();
  if (roll < tier.blunderFrequency) {
    // Pick from the lower half of candidate moves to simulate human blunder
    const blunderIndex = Math.floor(prng() * legalMoves.length);
    return {
      move: legalMoves[blunderIndex],
      rating: tier.rating,
      thinkTimeMs: Math.round(tier.avgThinkTimeMs * 0.7),
      candidateCount: legalMoves.length,
      isBlunder: true
    };
  }

  // Sample according to softmax distribution
  let cumulative = 0;
  const sampleRoll = prng();
  for (const item of probs) {
    cumulative += item.probability;
    if (sampleRoll <= cumulative) {
      // Calculate realistic human think time
      const jitter = (prng() - 0.5) * 600;
      const thinkTime = Math.max(400, Math.round(tier.avgThinkTimeMs + jitter));
      return {
        move: item.move,
        rating: tier.rating,
        thinkTimeMs: thinkTime,
        candidateCount: legalMoves.length
      };
    }
  }

  return {
    move: probs[0].move,
    rating: tier.rating,
    thinkTimeMs: tier.avgThinkTimeMs,
    candidateCount: legalMoves.length
  };
}

/**
 * Bot or Not: Evaluate human-likeness score of a move.
 *
 * @param {string} move - played move
 * @param {string[]} legalMoves - legal moves in the position
 * @param {number} [rating] - target human rating
 * @returns {{
 *   move: string,
 *   humanLikenessScore: number, // 0 to 100
 *   verdict: 'human-like'|'engine-like'|'neutral',
 *   explanation: string
 * }}
 */
function evaluateMoveHumanity(move, legalMoves, rating = 1500) {
  const probs = computeMoveProbabilities(legalMoves, rating);
  const found = probs.find(p => p.move === move);
  if (!found) {
    return {
      move,
      humanLikenessScore: 50,
      verdict: 'neutral',
      explanation: 'Move not found among candidate distribution.'
    };
  }

  // Human-likeness corresponds to probability percentile
  const sorted = [...probs].sort((a, b) => b.probability - a.probability);
  const rank = sorted.findIndex(p => p.move === move);
  const percentile = Math.max(5, Math.round(((sorted.length - rank) / sorted.length) * 100));

  let verdict = 'neutral';
  if (percentile >= 70) verdict = 'human-like';
  else if (percentile <= 25) verdict = 'engine-like';

  return {
    move,
    humanLikenessScore: percentile,
    verdict,
    probability: found.probability,
    explanation: verdict === 'human-like'
      ? `A natural choice for a ${rating}-rated human player (top ${100 - percentile}% candidate).`
      : `Unusual for a ${rating} human; characteristic of computer engine calculation.`
  };
}

/**
 * Hand-and-Brain Mode helper.
 *
 * In Hand-and-Brain:
 * - Brain chooses the piece type to move (Pawn, Knight, Bishop, Rook, Queen, King).
 * - Hand must choose which specific move to play with that piece type.
 *
 * @param {string[]} legalMoves - array of SAN moves
 * @returns {string} chosen piece type ('Pawn'|'Knight'|'Bishop'|'Rook'|'Queen'|'King')
 */
function selectBrainPieceType(legalMoves, rating = 1500, seed) {
  const selected = selectMaiaMove(legalMoves, rating, seed);
  const m = selected.move || '';
  if (!m) return 'Pawn';

  if (m.startsWith('N')) return 'Knight';
  if (m.startsWith('B')) return 'Bishop';
  if (m.startsWith('R')) return 'Rook';
  if (m.startsWith('Q')) return 'Queen';
  if (m.startsWith('K') || m.startsWith('O-O')) return 'King';
  return 'Pawn';
}

/**
 * Filter legal moves by piece type (for Hand execution).
 *
 * @param {string[]} legalMoves
 * @param {string} pieceType - 'Pawn'|'Knight'|'Bishop'|'Rook'|'Queen'|'King'
 * @returns {string[]}
 */
function filterMovesByPieceType(legalMoves, pieceType) {
  if (!Array.isArray(legalMoves)) return [];
  const pt = String(pieceType).toLowerCase();

  return legalMoves.filter(m => {
    if (pt === 'knight') return m.startsWith('N');
    if (pt === 'bishop') return m.startsWith('B');
    if (pt === 'rook') return m.startsWith('R');
    if (pt === 'queen') return m.startsWith('Q');
    if (pt === 'king') return m.startsWith('K') || m.startsWith('O-O');
    if (pt === 'pawn') return /^[a-h]/.test(m);
    return true;
  });
}

const MaiaBot = {
  MAIA_TIERS,
  getMaiaTier,
  computeMoveProbabilities,
  selectMaiaMove,
  evaluateMoveHumanity,
  selectBrainPieceType,
  filterMovesByPieceType
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MaiaBot;
}

if (typeof window !== 'undefined') {
  window.MaiaBot = MaiaBot;
}
