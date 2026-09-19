'use strict';

/**
 * endgames-trainer.js — Themed Endgames Trainer & Timed Challenge.
 *
 * Roadmap Wave 4 / N3.20:
 * 1. Themed drills from real 3–7-piece positions across canonical categories:
 *    - Pawn endgames (opposition, key squares, trebuchet, outside passer)
 *    - Rook endgames (Lucena position, Philidor defense, Vancura defense, bridge)
 *    - Queen endgames (Queen vs Pawn on 7th, Queen vs Rook)
 *    - Minor piece endgames (wrong-color bishop, knight vs bishop, K+B+N mate)
 * 2. Tablebase-ground-truth grading:
 *    Evaluates whether a played move preserves the theoretical endgame outcome
 *    (Win or Draw) using tablebase data.
 * 3. Timed Challenge & Leaderboard Mode:
 *    Sprint mode where players solve consecutive endgame drills against the clock,
 *    earning points for speed and accuracy.
 *
 * Pure analysis / data layer. Never mutates live game state and never touches live referee state.
 */

const tablebase = typeof require !== 'undefined' ? require('./tablebase.js') : (typeof window !== 'undefined' ? window.Tablebase : null);

/**
 * Canonical curated endgame drills.
 */
const ENDGAME_DRILLS = [
  // --- ROOK ENDGAMES ---
  {
    id: 'rook-lucena',
    title: 'The Lucena Position',
    category: 'rook',
    fen: '1K1k4/1P1r4/8/8/8/8/4R3/8 w - - 0 1',
    goal: 'win',
    targetPlies: 8,
    orientation: 'white',
    solutionMoves: ['Re4', 'Rd4', 'Re4+'],
    keyConcept: 'Building a bridge (Re4 -> Rd4) to shield the king from vertical checks.',
    explanation: 'White must cut off the black king, advance the rook to the 4th rank, and bridge on d4.'
  },
  {
    id: 'rook-philidor',
    title: 'The Philidor Defense',
    category: 'rook',
    fen: '8/4k3/8/4P3/8/8/4R3/r3K3 b - - 0 1',
    goal: 'draw',
    targetPlies: 6,
    orientation: 'black',
    solutionMoves: ['Ra6', 'Ra1'],
    keyConcept: 'Keep rook on 6th rank until the pawn advances, then check relentlessly from the rear.',
    explanation: 'Passive defense fails; active rear checking prevents the winning king infiltration.'
  },
  {
    id: 'rook-vancura',
    title: 'Vancura Position',
    category: 'rook',
    fen: '8/8/8/R7/1P6/8/r7/2K1k3 b - - 0 1',
    goal: 'draw',
    targetPlies: 6,
    orientation: 'black',
    solutionMoves: ['Ra6', 'Ra5', 'Rh6'],
    keyConcept: 'Side-checking from the long side while preventing pawn advancement.',
    explanation: 'Black checks the white king from the flanks so the king cannot shield the pawn.'
  },

  // --- PAWN ENDGAMES ---
  {
    id: 'pawn-opposition',
    title: 'Direct Opposition',
    category: 'pawn',
    fen: '8/8/4k3/8/4K3/8/4P3/8 w - - 0 1',
    goal: 'win',
    targetPlies: 6,
    orientation: 'white',
    solutionMoves: ['Kd4', 'Ke4', 'e3'],
    keyConcept: 'Seize the opposition before pushing the pawn.',
    explanation: 'Advancing the king ahead of the pawn claims the key breakthrough squares.'
  },
  {
    id: 'pawn-trebuchet',
    title: 'The Trebuchet (Mutual Zugzwang)',
    category: 'pawn',
    fen: '8/8/8/4k3/4p3/4P3/4K3/8 w - - 0 1',
    goal: 'win',
    targetPlies: 4,
    orientation: 'white',
    solutionMoves: ['Kf2', 'Kg3', 'Kxe4'],
    keyConcept: 'Zugzwang: whoever moves their king to the pawn first loses.',
    explanation: 'White outflanks Black to capture the backward e4 pawn.'
  },
  {
    id: 'pawn-outside-passer',
    title: 'Outside Passed Pawn Decoy',
    category: 'pawn',
    fen: '8/8/5k2/P7/8/4K3/8/8 w - - 0 1',
    goal: 'win',
    targetPlies: 4,
    orientation: 'white',
    solutionMoves: ['a6', 'a7', 'a8=Q'],
    keyConcept: 'The outside passed pawn decoys the defending king, allowing invasion.',
    explanation: 'The pawn on the a-file is unstoppable without the black king abandoning the center.'
  },

  // --- QUEEN ENDGAMES ---
  {
    id: 'queen-vs-pawn-7th-c',
    title: 'Queen vs Bishop Pawn on 7th',
    category: 'queen',
    fen: '8/8/8/8/8/4K3/2p5/Q3k3 w - - 0 1',
    goal: 'win',
    targetPlies: 4,
    orientation: 'white',
    solutionMoves: ['Qc3+', 'Kd3', 'Qxc2'],
    keyConcept: 'Pin the pawn and bring the king into the mating net.',
    explanation: 'Unlike rook or bishop pawns on the 7th rank, the c-pawn can be stopped by king approach.'
  },
  {
    id: 'queen-vs-rook',
    title: 'Queen vs Rook Pin & Skewer',
    category: 'queen',
    fen: '8/8/8/8/8/2k5/1r6/Q2K4 w - - 0 1',
    goal: 'win',
    targetPlies: 4,
    orientation: 'white',
    solutionMoves: ['Qa3+', 'Qa4+', 'Qxb2'],
    keyConcept: 'Exploit the absolute pin on the rook with checks that force king separation.',
    explanation: 'Black cannot unpin the rook without walking into a direct skewer or mate.'
  },

  // --- MINOR PIECE ENDGAMES ---
  {
    id: 'minor-wrong-color-bishop',
    title: 'Wrong-Colored Bishop & Rook Pawn',
    category: 'minor',
    fen: 'k7/8/K7/8/8/8/7P/5B2 w - - 0 1',
    goal: 'draw',
    targetPlies: 4,
    orientation: 'black',
    solutionMoves: ['Kb8', 'Ka8'],
    keyConcept: 'If the bishop cannot control the promotion square (h8), the defender draws in the corner.',
    explanation: 'Black rushes the king to the corner (a8/h8) and cannot be dislodged without stalemate.'
  },
  {
    id: 'minor-opposite-bishops',
    title: 'Opposite-Colored Bishops Fortress',
    category: 'minor',
    fen: '8/8/4b3/8/3B4/4P3/4K3/5k2 b - - 0 1',
    goal: 'draw',
    targetPlies: 4,
    orientation: 'black',
    solutionMoves: ['Bc4+', 'Bd5', 'Bc6'],
    keyConcept: 'Blockade the passed pawn on the color opposite the attacking bishop.',
    explanation: 'White cannot contest the dark squares, establishing an unbreakable blockade.'
  }
];

/**
 * List all available endgame drill categories.
 * @returns {string[]}
 */
function getCategories() {
  return ['all', 'pawn', 'rook', 'queen', 'minor'];
}

/**
 * Get drills filtered by category.
 * @param {string} [category]
 * @returns {object[]}
 */
function getDrills(category) {
  if (!category || category === 'all') {
    return ENDGAME_DRILLS.slice();
  }
  return ENDGAME_DRILLS.filter(d => d.category === category);
}

/**
 * Find a specific drill by ID.
 * @param {string} id
 * @returns {object|null}
 */
function getDrillById(id) {
  return ENDGAME_DRILLS.find(d => d.id === id) || null;
}

/**
 * Grade a move in an endgame position against theoretical goal.
 *
 * @param {object} drill - drill specification
 * @param {string} playedMove - SAN move played
 * @param {object} [tablebaseResult] - optional tablebase probe result
 * @returns {{
 *   correct: boolean,
 *   grade: 'best'|'acceptable'|'inaccuracy'|'blunder',
 *   expectedOutcome: string,
 *   message: string
 * }}
 */
function gradeEndgameMove(drill, playedMove, tablebaseResult) {
  if (!drill) {
    throw new Error('Drill object required');
  }

  const normPlayed = String(playedMove || '').replace(/[!?+#]/g, '').trim();

  // 1. If tablebase data is provided, evaluate exact theoretical preservation
  if (tablebaseResult && tablebaseResult.category) {
    const cat = tablebaseResult.category; // outcome from opponent viewpoint after player move
    if (drill.goal === 'win') {
      // If our goal is to win, opponent must be in 'loss' or 'blessed-loss'
      if (cat === 'loss' || cat === 'blessed-loss') {
        return {
          correct: true,
          grade: 'best',
          expectedOutcome: 'win',
          message: 'Excellent! This move maintains the theoretical win.'
        };
      } else if (cat === 'draw') {
        return {
          correct: false,
          grade: 'blunder',
          expectedOutcome: 'win',
          message: 'Mistake! The position dropped from a theoretical win to a draw.'
        };
      } else {
        return {
          correct: false,
          grade: 'blunder',
          expectedOutcome: 'win',
          message: 'Critical error! This move loses the game.'
        };
      }
    } else {
      // Goal is draw: opponent must not have a win
      if (cat === 'draw' || cat === 'blessed-loss' || cat === 'loss') {
        return {
          correct: true,
          grade: 'best',
          expectedOutcome: 'draw',
          message: 'Well defended! The theoretical draw is preserved.'
        };
      } else {
        return {
          correct: false,
          grade: 'blunder',
          expectedOutcome: 'draw',
          message: 'Error! This move allows the opponent to win.'
        };
      }
    }
  }

  // 2. Fallback to curated solution moves
  const isMatch = drill.solutionMoves && drill.solutionMoves.some(sol => {
    return sol.replace(/[!?+#]/g, '').trim() === normPlayed;
  });

  if (isMatch) {
    return {
      correct: true,
      grade: 'best',
      expectedOutcome: drill.goal,
      message: 'Correct move! ' + drill.keyConcept
    };
  }

  return {
    correct: false,
    grade: 'inaccuracy',
    expectedOutcome: drill.goal,
    message: 'Not the optimal move. ' + drill.explanation
  };
}

/**
 * Start a new timed endgame challenge.
 *
 * @param {object} [opts]
 * @param {string} [opts.category]
 * @param {number} [opts.timeLimitSeconds] - default 120s
 * @param {number} [opts.now] - timestamp
 * @returns {object} Challenge state
 */
function createChallenge(opts) {
  opts = opts || {};
  const category = opts.category || 'all';
  const drills = getDrills(category);
  const timeLimitSeconds = typeof opts.timeLimitSeconds === 'number' ? opts.timeLimitSeconds : 120;
  const startTime = typeof opts.now === 'number' ? opts.now : Date.now();

  return {
    id: 'ch_' + Math.random().toString(36).slice(2, 10),
    category,
    timeLimitSeconds,
    startTime,
    expiresAt: startTime + timeLimitSeconds * 1000,
    currentIndex: 0,
    drills: drills.map(d => ({ id: d.id, title: d.title, goal: d.goal, fen: d.fen })),
    score: 0,
    completedDrills: 0,
    history: [],
    isFinished: false
  };
}

/**
 * Submit an attempt in a timed challenge.
 *
 * @param {object} challenge - challenge state
 * @param {string} drillId - drill ID
 * @param {string} playedMove - SAN move
 * @param {number} timeSpentMs - time spent on this drill in ms
 * @param {number} [now] - current timestamp
 * @returns {object} updated challenge step
 */
function submitChallengeStep(challenge, drillId, playedMove, timeSpentMs, now) {
  const ts = typeof now === 'number' ? now : Date.now();
  if (challenge.isFinished || ts > challenge.expiresAt) {
    challenge.isFinished = true;
    return { isFinished: true, score: challenge.score, message: 'Challenge time expired!' };
  }

  const drill = getDrillById(drillId);
  if (!drill) {
    throw new Error('Drill not found: ' + drillId);
  }

  const grade = gradeEndgameMove(drill, playedMove);

  let pointsAwarded = 0;
  if (grade.correct) {
    // 100 base points + speed bonus (up to 50 pts for solving under 10s)
    const speedBonus = Math.max(0, Math.round((10000 - timeSpentMs) / 200));
    pointsAwarded = 100 + speedBonus;
    challenge.score += pointsAwarded;
    challenge.completedDrills++;
  } else {
    // 10 second penalty
    challenge.score = Math.max(0, challenge.score - 25);
  }

  challenge.history.push({
    drillId,
    playedMove,
    correct: grade.correct,
    pointsAwarded,
    timeSpentMs
  });

  challenge.currentIndex++;
  if (challenge.currentIndex >= challenge.drills.length) {
    challenge.isFinished = true;
  }

  return {
    correct: grade.correct,
    pointsAwarded,
    totalScore: challenge.score,
    grade,
    isFinished: challenge.isFinished,
    nextDrill: challenge.isFinished ? null : challenge.drills[challenge.currentIndex]
  };
}

/**
 * Local in-memory leaderboard store for endgame challenges.
 */
const challengeLeaderboard = [];

/**
 * Record a challenge score on the leaderboard.
 * @param {object} entry - { playerName, score, category, completedDrills, date }
 * @returns {object[]} top 10 leaderboard entries
 */
function recordLeaderboardEntry(entry) {
  const item = {
    playerName: String(entry.playerName || 'Anonymous').slice(0, 30),
    score: Number(entry.score) || 0,
    category: String(entry.category || 'all'),
    completedDrills: Number(entry.completedDrills) || 0,
    date: entry.date || new Date().toISOString().slice(0, 10)
  };
  challengeLeaderboard.push(item);
  challengeLeaderboard.sort((a, b) => b.score - a.score);
  if (challengeLeaderboard.length > 50) {
    challengeLeaderboard.pop();
  }
  return challengeLeaderboard.slice(0, 10);
}

/**
 * Get top leaderboard scores.
 * @param {string} [category]
 * @returns {object[]}
 */
function getLeaderboard(category) {
  if (!category || category === 'all') {
    return challengeLeaderboard.slice(0, 10);
  }
  return challengeLeaderboard.filter(e => e.category === category).slice(0, 10);
}

const EndgamesTrainer = {
  ENDGAME_DRILLS,
  getCategories,
  getDrills,
  getDrillById,
  gradeEndgameMove,
  createChallenge,
  submitChallengeStep,
  recordLeaderboardEntry,
  getLeaderboard
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = EndgamesTrainer;
}

if (typeof window !== 'undefined') {
  window.EndgamesTrainer = EndgamesTrainer;
}
