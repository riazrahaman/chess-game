(function() {
'use strict';

/**
 * ai-coach.js
 * C2: "Why?" Plain-English Move Explanations
 * C4: In-Game Coach Mode Hints & Suggestions
 */

const PIECE_NAMES = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king'
};

/**
 * Explains in plain English why a move received its classification
 * and what tactical or positional factors occurred.
 */
function explainMove(data = {}) {
  const move = data.move || '';
  const from = move.slice(0, 2);
  const to = move.slice(2, 4);
  const color = data.color || 'white';
  const oppColor = color === 'white' ? 'black' : 'white';
  const preCp = typeof data.preCp === 'number' ? data.preCp : 0;
  const postCp = typeof data.postCp === 'number' ? data.postCp : 0;
  const key = data.key || 'good';
  const bestMove = data.bestMove || '';

  const cpSwing = color === 'white' ? (postCp - preCp) : (preCp - postCp);
  const evalSwingDesc = Math.abs(cpSwing) > 50
    ? `Evaluation shifted by ${(cpSwing / 100).toFixed(1)} pawns.`
    : 'Evaluation remained relatively stable.';

  let explanation = '';

  switch (key) {
    case 'brilliant':
      explanation = `Brilliant move! This move sacrifices material or makes a sharp tactical gesture that maintains a decisive advantage for ${color}.`;
      break;
    case 'best':
      explanation = `Best move (★). Playing ${move} maximizes piece activity, controls critical squares, and keeps the optimal engine evaluation.`;
      break;
    case 'excellent':
      explanation = `Excellent choice. While the engine slightly considered ${bestMove || 'another alternative'}, ${move} keeps strong pressure without concessions.`;
      break;
    case 'good':
      explanation = `A solid, natural move. Keeps the position balanced and safe. ${evalSwingDesc}`;
      break;
    case 'inaccuracy':
      explanation = `An inaccuracy (?!). While not fatal, moving from ${from} to ${to} allows ${oppColor} slightly better counterplay. ${bestMove ? `A sharper choice was ${bestMove}.` : ''}`;
      break;
    case 'mistake':
      explanation = `Mistake (?). This move conceded significant ground. ${evalSwingDesc} ${bestMove ? `The engine recommended ${bestMove} to preserve equality or advantage.` : ''}`;
      break;
    case 'blunder':
      explanation = `Blunder (??). Playing ${move} dropped substantial material or tactical safety. ${evalSwingDesc} ${bestMove ? `Playing ${bestMove} was much stronger.` : ''}`;
      break;
    default:
      explanation = `Move played: ${move}. ${evalSwingDesc}`;
  }

  return {
    move,
    classification: key,
    explanation,
    evalSwing: cpSwing,
    recommendedMove: bestMove
  };
}

/**
 * Provides progressive hints for the current turn (Coach Mode).
 */
function getCoachHint(data = {}) {
  const turn = data.turn || 'white';
  const bestMove = data.bestMove || 'e2e4';
  const evalCp = typeof data.evalCp === 'number' ? data.evalCp : 0;
  const ply = data.ply || 1;

  const from = bestMove.slice(0, 2);
  const to = bestMove.slice(2, 4);

  let generalPrinciple = '';
  if (ply <= 10) {
    generalPrinciple = 'Opening Principle: Fight for center control, develop minor pieces (knights before bishops), and castle early for king safety.';
  } else if (ply <= 40) {
    generalPrinciple = 'Middlegame Principle: Look for checks, captures, and threats (CCT). Seek open files for rooks and active outposts for knights.';
  } else {
    generalPrinciple = 'Endgame Principle: Activate your king, push passed pawns, and cut off the enemy king.';
  }

  const pieceHint = `Focus on the piece positioned at square ${from}. It has strong tactical or positional prospects.`;
  const moveHint = `Strongest tactical continuation: Consider playing ${from} to ${to}. (Position eval: ${evalCp >= 0 ? '+' : ''}${(evalCp / 100).toFixed(1)})`;

  return {
    turn,
    generalPrinciple,
    pieceHint,
    moveHint,
    bestMove
  };
}

const AiCoachModule = {
  explainMove,
  getCoachHint
};

if (typeof window !== 'undefined') {
  window.AiCoach = AiCoachModule;
}
if (typeof module !== 'undefined') {
  module.exports = AiCoachModule;
}
})();
