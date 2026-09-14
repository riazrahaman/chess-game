'use strict';

// Glicko-2 Rating Engine
// Implements the full Glicko-2 algorithm from Mark Glickman's 2013 paper:
// "Example of the Glicko-2 system" (http://www.glicko.net/glicko/glicko2.pdf)
//
// Public domain. No external dependencies. CommonJS module.
//
// Constants:
//   GLICKO2_SCALE = 173.7178  — converts Glicko ratings/RD to the Glicko-2 mu/phi scale
//   EPSILON = 0.000001        — convergence threshold for the volatility iterative step
//   DEFAULT_TAU = 0.5         — system constant constraining volatility changes

const GLICKO2_SCALE = 173.7178;
const EPSILON = 0.000001;
const DEFAULT_TAU = 0.5;

/**
 * Creates a player rating object.
 * @param {number} rating   Glicko-scale rating (e.g. 1500)
 * @param {number} rd       Rating deviation (e.g. 350)
 * @param {number} vol      Volatility (e.g. 0.06)
 * @returns {{rating:number, rd:number, vol:number}}
 */
function createPlayer(rating, rd, vol) {
  return {
    rating: typeof rating === 'number' ? rating : 1500,
    rd: typeof rd === 'number' ? rd : 350,
    vol: typeof vol === 'number' ? vol : 0.06
  };
}

function _g(phi) {
  return 1 / Math.sqrt(1 + 3 * phi * phi / (Math.PI * Math.PI));
}

function _E(mu, muOpp, phiOpp) {
  return 1 / (1 + Math.exp(-_g(phiOpp) * (mu - muOpp)));
}

/**
 * Computes the new rating, RD, and volatility for a player after a series of games.
 * Follows the Glicko-2 algorithm steps 1–8 from Glickman's paper.
 *
 * @param {object} player   {rating, rd, vol} — the player being updated
 * @param {Array}  matches  Array of {opponent: {rating, rd, vol}, score: 1.0|0.5|0.0}
 * @param {number} tau      System constant (default 0.5)
 * @returns {{rating:number, rd:number, vol:number}} Updated player
 */
function updateRating(player, matches, tau) {
  if (typeof tau !== 'number' || tau <= 0) tau = DEFAULT_TAU;
  if (!player) player = createPlayer();
  if (!Array.isArray(matches) || matches.length === 0) {
    // No games played: RD inflates but rating stays
    const phi = player.rd / GLICKO2_SCALE;
    const phiStar = Math.sqrt(phi * phi + player.vol * player.vol);
    return {
      rating: player.rating,
      rd: phiStar * GLICKO2_SCALE,
      vol: player.vol
    };
  }

  // Step 1: Convert to Glicko-2 scale
  const mu = player.rating / GLICKO2_SCALE;
  const phi = player.rd / GLICKO2_SCALE;
  const sigma = player.vol;

  // Step 2: Convert opponents and compute v (Step 3) and delta (Step 4)
  let vInv = 0;
  let deltaSum = 0;

  const oppData = matches.map(m => {
    const muOpp = m.opponent.rating / GLICKO2_SCALE;
    const phiOpp = m.opponent.rd / GLICKO2_SCALE;
    const gOpp = _g(phiOpp);
    const eVal = 1 / (1 + Math.exp(-gOpp * (mu - muOpp)));
    vInv += gOpp * gOpp * eVal * (1 - eVal);
    deltaSum += gOpp * (m.score - eVal);
    return { muOpp, phiOpp, gOpp, eVal, score: m.score };
  });

  const v = 1 / vInv;
  const delta = v * deltaSum;

  // Step 5: Determine new volatility sigma' using iterative algorithm
  const a = Math.log(sigma * sigma);
  const tau2 = tau;
  let A = a;
  let B;

  function f(x) {
    const ex = Math.exp(x);
    const d2 = delta * delta;
    const phi2 = phi * phi;
    const num = ex * (d2 - phi2 - v - ex);
    const den = 2 * (phi2 + v + ex) * (phi2 + v + ex);
    return num / den - (x - a) / (tau2 * tau2);
  }

  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * tau2) < 0) {
      k++;
    }
    B = a - k * tau2;
  }

  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > EPSILON) {
    const C = A + (A - B) * fA / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
  }

  const newSigma = Math.exp(A / 2);

  // Step 6: Update phi to new pre-rating-period value
  const phiStar = Math.sqrt(phi * phi + newSigma * newSigma);

  // Step 7: Update phi and mu
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * deltaSum;

  // Step 8: Convert back to Glicko scale
  return {
    rating: newMu * GLICKO2_SCALE,
    rd: newPhi * GLICKO2_SCALE,
    vol: newSigma
  };
}

/**
 * Rates a series of matches between multiple players.
 * @param {Array}  players  Array of {rating, rd, vol}
 * @param {Array}  results  Array of {playerIdx, opponentIdx, score} (1.0=win, 0.5=draw, 0.0=loss)
 * @param {number} tau      System constant (default 0.5)
 * @returns {Array} Updated players array (same order as input)
 */
function rateMatches(players, results, tau) {
  if (!Array.isArray(players) || players.length === 0) return [];
  if (!Array.isArray(results) || results.length === 0) {
    return players.map(p => {
      const updated = updateRating(p, [], tau);
      return { ...updated };
    });
  }

  return players.map((player, idx) => {
    const matches = results
      .filter(r => r.playerIdx === idx)
      .map(r => ({ opponent: players[r.opponentIdx], score: r.score }));
    return updateRating(player, matches, tau);
  });
}

/**
 * Computes expected score (0–1) of playerA vs playerB.
 * Uses the Glicko g-function for RD uncertainty.
 * @param {object} playerA  {rating, rd}
 * @param {object} playerB  {rating, rd}
 * @returns {number}
 */
function expectedScore(playerA, playerB) {
  const phiB = playerB.rd / GLICKO2_SCALE;
  const muA = playerA.rating / GLICKO2_SCALE;
  const muB = playerB.rating / GLICKO2_SCALE;
  const g = _g(phiB);
  return 1 / (1 + Math.exp(-g * (muA - muB)));
}

/**
 * 95% confidence interval for a rating.
 * @param {object} player  {rating, rd}
 * @returns {{low:number, high:number}}
 */
function confidenceInterval(player) {
  const margin = 1.96 * player.rd;
  return { low: player.rating - margin, high: player.rating + margin };
}

const RatingModule = {
  GLICKO2_SCALE,
  EPSILON,
  DEFAULT_TAU,
  createPlayer,
  updateRating,
  rateMatches,
  expectedScore,
  confidenceInterval
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RatingModule;
}
if (typeof window !== 'undefined') {
  window.Rating = RatingModule;
}