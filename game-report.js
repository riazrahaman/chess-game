'use strict';

/**
 * game-report.js
 * C6: Auto Post-Game Narrative Report & Prose Summary
 * Generates dynamic prose storytelling of the match, phase breakdowns (Opening,
 * Middlegame turning points, Endgame conversion), personalized tactical takeaways,
 * and PGN with NAG glyphs and eval comments.
 */

const NAG_MAP = {
  brilliant: '$3', // !!
  best: '$1',      // !
  excellent: '',
  good: '',
  inaccuracy: '$6', // ?!
  mistake: '$2',    // ?
  blunder: '$4'     // ??
};

function formatCp(cp) {
  if (typeof cp !== 'number' || isNaN(cp)) return '0.00';
  const val = (cp / 100).toFixed(2);
  return cp >= 0 ? `+${val}` : `${val}`;
}

function generatePostGameReport(options = {}) {
  const moveHistory = options.moveHistory || [];
  const sanHistory = options.sanHistory || moveHistory;
  const evalHistory = options.evalHistory || [];
  const review = options.review || { whiteAccuracy: 85, blackAccuracy: 80, counts: {} };
  const result = options.result || '*';
  const reason = options.reason || 'normal';

  const totalPlies = moveHistory.length;
  const totalMoves = Math.ceil(totalPlies / 2);

  // 1. Result summary
  let winner = 'draw';
  if (result === '1-0' || (result && result.startsWith('1-0'))) winner = 'White';
  else if (result === '0-1' || (result && result.startsWith('0-1'))) winner = 'Black';

  let headline = '';
  if (winner === 'draw') {
    headline = `Hard-fought draw concluded in ${totalMoves} moves (${reason}).`;
  } else {
    headline = `Decisive victory for ${winner} in ${totalMoves} moves (${result}, ${reason}).`;
  }

  // 2. Accuracy Comparison
  const accSummary = `White played with ${review.whiteAccuracy}% accuracy, while Black achieved ${review.blackAccuracy}%.`;

  // 3. Opening Phase Analysis (moves 1-10 / plies 1-20)
  const openingPlies = Math.min(20, totalPlies);
  let openingCp = 0;
  if (evalHistory.length > openingPlies) {
    openingCp = evalHistory[openingPlies];
  }
  let openingNarrative = '';
  if (Math.abs(openingCp) <= 40) {
    openingNarrative = 'The opening phase developed evenly with both sides staking solid claims in the center and developing harmoniously.';
  } else if (openingCp > 40) {
    openingNarrative = `White emerged with a notable opening initiative (+${(openingCp / 100).toFixed(1)} pawns), putting immediate pressure on Black’s setup.`;
  } else {
    openingNarrative = `Black neutralized White’s first-move initiative early, securing comfortable counterplay (-${Math.abs(openingCp / 100).toFixed(1)} pawns).`;
  }

  // 4. Turning Point & Critical Moment
  let maxSwing = 0;
  let criticalPly = null;
  let criticalMove = null;
  let criticalColor = null;

  if (review.moves && Array.isArray(review.moves)) {
    for (const m of review.moves) {
      if (m.key === 'blunder' || m.key === 'mistake') {
        const swing = Math.abs(m.postCp - m.preCp);
        if (swing > maxSwing) {
          maxSwing = swing;
          criticalPly = m.ply;
          criticalMove = m.move;
          criticalColor = m.color;
        }
      }
    }
  }

  let turningPointNarrative = '';
  if (criticalPly !== null) {
    const moveNum = Math.ceil(criticalPly / 2);
    const turnStr = criticalColor === 'white' ? `${moveNum}.` : `${moveNum}...`;
    turningPointNarrative = `The decisive turning point occurred at move ${turnStr} (${criticalMove}), where a critical tactical inaccuracy swung the evaluation by ${(maxSwing / 100).toFixed(1)} pawns, providing the winning momentum.`;
  } else {
    turningPointNarrative = 'No dramatic singular blunders occurred; the game was characterized by strategic maneuvering and incremental positional pressure.';
  }

  // 5. Endgame / Conversion
  let endgameNarrative = '';
  if (totalMoves < 25) {
    endgameNarrative = 'The battle was decided before a true endgame emerged, wrapping up sharply in the middlegame.';
  } else {
    endgameNarrative = 'In the late game, technique proved paramount as king activity and passed pawn structures dictated the final verdict.';
  }

  // 6. Tactical Takeaways
  const whiteBlunders = (review.counts && review.counts.white && review.counts.white.blunder) || 0;
  const blackBlunders = (review.counts && review.counts.black && review.counts.black.blunder) || 0;

  const whiteAdvice = whiteBlunders > 0
    ? `White had ${whiteBlunders} major blunder(s). Focus on calculating candidate responses before initiating tactical exchanges.`
    : 'White showed solid tactical discipline throughout the match.';

  const blackAdvice = blackBlunders > 0
    ? `Black conceded ${blackBlunders} major blunder(s). Keep king safety prioritized and watch for undefended pieces.`
    : 'Black navigated tactical complications with precision.';

  // 7. Annotated PGN Generation
  let annotatedPgn = '';
  for (let i = 0; i < sanHistory.length; i++) {
    const moveNum = Math.floor(i / 2) + 1;
    const isWhite = i % 2 === 0;
    const san = sanHistory[i];
    const reviewed = review.moves && review.moves[i];
    const nag = (reviewed && NAG_MAP[reviewed.key]) ? ` ${NAG_MAP[reviewed.key]}` : '';
    const cp = (evalHistory && evalHistory[i + 1] !== undefined) ? evalHistory[i + 1] : 0;
    const comment = ` { [%eval ${formatCp(cp)}] }`;

    if (isWhite) {
      annotatedPgn += `${moveNum}. ${san}${nag}${comment} `;
    } else {
      annotatedPgn += `${san}${nag}${comment} `;
    }
  }
  annotatedPgn = annotatedPgn.trim() + ` ${result}`;

  return {
    headline,
    accSummary,
    openingNarrative,
    turningPointNarrative,
    endgameNarrative,
    whiteAdvice,
    blackAdvice,
    annotatedPgn
  };
}

const GameReportModule = {
  generatePostGameReport
};

if (typeof window !== 'undefined') {
  window.GameReport = GameReportModule;
}
if (typeof module !== 'undefined') {
  module.exports = GameReportModule;
}
