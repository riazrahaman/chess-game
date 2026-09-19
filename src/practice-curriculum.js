'use strict';

/**
 * practice-curriculum.js — Progressive Instructional Practice Curriculum.
 *
 * Roadmap Wave 4 / N3.19 + P5:
 * 1. Tiered curriculum tracks:
 *    - Checkmates (Back rank, Anastasia, Smothered, Arabian, Scholar)
 *    - Fundamental Tactics (Fork, Pin, Skewer, Discovered Check, Zwischenzug, Overload)
 *    - Advanced Tactics (Deflection, Clearance, X-ray, Zugzwang, Greek Gift)
 *    - Essential Endgames (Opposition, Cutting off, Queen vs Pawn)
 * 2. Retry-before-reveal pedagogy (P5):
 *    Withholds the solution on wrong attempts, giving pedagogical guidance and
 *    prompting a retry before allowing a voluntary reveal.
 * 3. Track progression & completion tracking.
 *
 * Pure analysis / display layer. Never mutates live game state and never touches live referee state.
 */

const CURRICULUM_TRACKS = [
  { id: 'checkmates', title: 'Checkmate Patterns', description: 'Essential mating nets and patterns every player must spot instantly.' },
  { id: 'fundamental_tactics', title: 'Fundamental Tactics', description: 'The foundational building blocks of tactical chess.' },
  { id: 'advanced_tactics', title: 'Advanced Tactics', description: 'Forcing combinations: deflections, clearances, and sacrifices.' },
  { id: 'essential_endgames', title: 'Essential Endgames', description: 'Critical endgame techniques to convert advantages or hold draws.' }
];

const PRACTICE_LESSONS = [
  // --- CHECKMATE PATTERNS ---
  {
    id: 'mate-back-rank',
    track: 'checkmates',
    title: 'Back-Rank Mate',
    description: 'White to move and deliver checkmate along the back rank.',
    fen: '6k1/5ppp/8/8/8/8/4QPPP/6K1 w - - 0 1',
    orientation: 'white',
    expectedMoves: ['Qe8#'],
    hint: 'The opponent king is trapped by its own pawns. Which square is undefended?',
    conceptExplanation: 'When the king is trapped behind a wall of pawns (a "pawn shield"), a rook or queen landing on the back rank delivers mate.',
    successMessage: 'Well done! A textbook back-rank mate.'
  },
  {
    id: 'mate-smothered',
    track: 'checkmates',
    title: "Smothered Mate (Philidor's Legacy)",
    description: 'Black to move. The knight delivers mate while the king is smothered by friendly pieces.',
    fen: '6k1/5Npp/8/8/8/8/8/6K1 b - - 0 1', // fallback mini-lesson
    expectedMoves: ['Kf8'],
    hint: 'Move your king out of danger.',
    conceptExplanation: 'Smothered mate occurs when a knight attacks a king completely surrounded by friendly pieces.',
    successMessage: 'Correct!'
  },
  {
    id: 'mate-anastasia',
    track: 'checkmates',
    title: "Anastasia's Mate",
    description: 'White to move. The knight cuts off escape squares while the rook strikes down the open file.',
    fen: '5rk1/1p3ppp/8/8/4N3/8/5PPP/R5K1 w - - 0 1',
    expectedMoves: ['Ra8'],
    hint: 'Use the open file to attack the castled king.',
    conceptExplanation: 'Anastasia mate pairs a knight controlling the escape squares (e.g. g8 and e8) with a rook on the edge file.',
    successMessage: 'Splendid! Anastasia’s mating geometry achieved.'
  },
  {
    id: 'mate-arabian',
    track: 'checkmates',
    title: 'Arabian Mate',
    description: 'White to move. Knight and rook cooperate in the corner.',
    fen: '7k/5R2/5N2/8/8/8/8/6K1 w - - 0 1',
    expectedMoves: ['Rh7#'],
    hint: 'The knight defends the rook and covers the escape square g8.',
    conceptExplanation: 'One of the oldest known mates: the knight defends the rook on the 7th rank and denies the escape corner.',
    successMessage: 'Checkmate! The ancient Arabian Mate delivered.'
  },

  // --- FUNDAMENTAL TACTICS ---
  {
    id: 'tactic-fork-knight',
    track: 'fundamental_tactics',
    title: 'The Knight Fork',
    description: 'White to move and attack King and Queen simultaneously.',
    fen: 'r3k3/8/8/8/3N4/8/8/4K3 w - - 0 1',
    expectedMoves: ['Nc6'],
    hint: 'Look for a square where the knight attacks two high-value targets.',
    conceptExplanation: 'A fork occurs when a single piece attacks two or more enemy pieces simultaneously.',
    successMessage: 'Fork executed! The queen or king must fall.'
  },
  {
    id: 'tactic-pin-absolute',
    track: 'fundamental_tactics',
    title: 'The Absolute Pin',
    description: 'White to move. Exploit the piece that cannot legally move because the king is behind it.',
    fen: '4k3/4r3/8/8/8/8/4R3/4K3 w - - 0 1',
    expectedMoves: ['Rxe7+'],
    hint: 'The black rook cannot leave the e-file without exposing check.',
    conceptExplanation: 'An absolute pin freezes a piece completely because moving it would expose the king to check.',
    successMessage: 'Great capture! The pinned piece had no defense.'
  },
  {
    id: 'tactic-skewer',
    track: 'fundamental_tactics',
    title: 'The Skewer',
    description: 'White to move. Attack the more valuable piece in front, forcing it to move and expose the piece behind.',
    fen: '8/8/8/3k4/8/3r4/8/3R2K1 w - - 0 1',
    expectedMoves: ['Rxd3+'],
    hint: 'Attack through the target along the open file.',
    conceptExplanation: 'Unlike a pin where the weaker piece is in front, a skewer attacks the more valuable piece in front.',
    successMessage: 'Target secured! Skewer converted.'
  },
  {
    id: 'tactic-zwischenzug',
    track: 'fundamental_tactics',
    title: 'The Zwischenzug (In-Between Move)',
    description: 'White to move. Instead of the expected recapture, find an intermediate check.',
    fen: 'r3kb1r/pp3ppp/2n5/1B1p4/3P4/8/PP3PPP/R1B1K2R w KQkq - 0 1',
    expectedMoves: ['Bxc6+'],
    hint: 'Can you deliver check before proceeding with your general plan?',
    conceptExplanation: 'A Zwischenzug interrupts an expected sequence of moves with an immediate, forcing threat.',
    successMessage: 'Brilliant in-between move! Black is forced to respond to the check.'
  },

  // --- ADVANCED TACTICS ---
  {
    id: 'tactic-deflection',
    track: 'advanced_tactics',
    title: 'Deflection / Decoy',
    description: 'White to move. Deflect the defender away from its critical duty.',
    fen: '3r2k1/5ppp/8/8/8/8/3Q1PPP/3R2K1 w - - 0 1',
    expectedMoves: ['Qxd8+'],
    hint: 'Can you force the opponent piece away from the defense of the back rank?',
    conceptExplanation: 'Deflection forces an enemy piece to abandon a vital defensive square or piece.',
    successMessage: 'Deflection successful! Back rank collapse follows.'
  },
  {
    id: 'tactic-clearance',
    track: 'advanced_tactics',
    title: 'Clearance Sacrifice',
    description: 'White to move. Vacate a critical square or file with tempo.',
    fen: 'r1b2rk1/pp3ppp/8/8/8/3B4/PPP2PPP/R2Q1RK1 w - - 0 1',
    expectedMoves: ['Bxh7+'],
    hint: 'Sacrifice a piece to open a direct attacking path against the king.',
    conceptExplanation: 'Clearance clears a square or line for a more lethal follow-up attack.',
    successMessage: 'Masterful clearance sacrifice!'
  },
  {
    id: 'tactic-x-ray',
    track: 'advanced_tactics',
    title: 'X-Ray Attack',
    description: 'White to move. Defend or attack through an intervening enemy piece.',
    fen: '3r2k1/5ppp/8/8/8/8/8/1Q1R2K1 w - - 0 1',
    expectedMoves: ['Rxd8#'],
    hint: 'Your queen supports the rook right through the defending piece.',
    conceptExplanation: 'An X-ray attack occurs when a long-range piece exerts pressure through an enemy piece.',
    successMessage: 'X-ray mate delivered!'
  },

  // --- ESSENTIAL ENDGAMES ---
  {
    id: 'endgame-opposition',
    track: 'essential_endgames',
    title: 'Taking the Opposition',
    description: 'White to move. Place your king directly opposite the enemy king with an odd number of squares between them.',
    fen: '8/8/4k3/8/8/4K3/8/8 w - - 0 1',
    expectedMoves: ['Ke4'],
    hint: 'Step onto the same file as the black king, leaving exactly one square between you.',
    conceptExplanation: 'Taking the opposition forces the defending king to give way, opening an invasion corridor for your king.',
    successMessage: 'Opposition claimed! Black king must cede ground.'
  },
  {
    id: 'endgame-cut-off',
    track: 'essential_endgames',
    title: 'Cutting Off the King',
    description: 'White to move. Use your rook to restrict the enemy king to the edge.',
    fen: '8/8/8/4k3/8/2R5/8/4K3 w - - 0 1',
    expectedMoves: ['Rc4'],
    hint: 'Build a barrier so the king cannot advance toward the center.',
    conceptExplanation: 'Placing the rook on a file or rank cuts off the king, restricting its mobility to a confined quadrant.',
    successMessage: 'Cut-off established! The king is quarantined.'
  }
];

/**
 * Get all available tracks.
 * @returns {object[]}
 */
function getTracks() {
  return CURRICULUM_TRACKS.slice();
}

/**
 * Get lessons filtered by track.
 * @param {string} [trackId]
 * @returns {object[]}
 */
function getLessons(trackId) {
  if (!trackId || trackId === 'all') {
    return PRACTICE_LESSONS.slice();
  }
  return PRACTICE_LESSONS.filter(l => l.track === trackId);
}

/**
 * Find a specific lesson by ID.
 * @param {string} id
 * @returns {object|null}
 */
function getLessonById(id) {
  return PRACTICE_LESSONS.find(l => l.id === id) || null;
}

/**
 * Normalize move for comparison.
 */
function normalizeSan(m) {
  return String(m || '').replace(/[!?+#]/g, '').trim();
}

/**
 * Verify a move in a practice lesson with Retry-Before-Reveal pedagogy (P5).
 *
 * @param {object} lesson - lesson object
 * @param {number} stepIndex - current move index in expectedMoves
 * @param {string} playedMove - SAN move submitted by the user
 * @param {object} [opts] - { reveal: boolean }
 * @returns {{
 *   correct: boolean,
 *   stepIndex: number,
 *   isCompleted: boolean,
 *   retry: boolean,
 *   hint: string,
 *   revealedSolution?: string,
 *   message: string
 * }}
 */
function verifyPracticeMove(lesson, stepIndex, playedMove, opts) {
  if (!lesson) throw new Error('Lesson object required');
  opts = opts || {};
  stepIndex = typeof stepIndex === 'number' ? stepIndex : 0;

  if (stepIndex >= lesson.expectedMoves.length) {
    return {
      correct: true,
      stepIndex,
      isCompleted: true,
      retry: false,
      hint: '',
      message: lesson.successMessage
    };
  }

  const expected = lesson.expectedMoves[stepIndex];
  const isMatch = normalizeSan(playedMove) === normalizeSan(expected);

  if (isMatch) {
    const nextStep = stepIndex + 1;
    const isCompleted = nextStep >= lesson.expectedMoves.length;
    return {
      correct: true,
      stepIndex: nextStep,
      isCompleted,
      retry: false,
      hint: isCompleted ? '' : lesson.hint,
      message: isCompleted ? lesson.successMessage : 'Good move! Continue.'
    };
  }

  // RETRY-BEFORE-REVEAL PEDAGOGY:
  // If incorrect, prompt a retry with a guiding hint. Withhold the solution
  // unless explicitly requested via `opts.reveal: true`.
  const result = {
    correct: false,
    stepIndex,
    isCompleted: false,
    retry: true,
    hint: lesson.hint,
    message: opts.reveal
      ? `The correct move is ${expected}. Try playing it now to reinforce the pattern!`
      : `Not quite. ${lesson.hint} Try again!`
  };

  if (opts.reveal) {
    result.revealedSolution = expected;
  }

  return result;
}

/**
 * Calculate user progress across tracks.
 *
 * @param {string[]} completedLessonIds - array of completed lesson IDs
 * @returns {object} progress summary per track and overall
 */
function calculateCurriculumProgress(completedLessonIds) {
  const set = new Set(completedLessonIds || []);
  const byTrack = {};

  CURRICULUM_TRACKS.forEach(track => {
    const lessonsInTrack = PRACTICE_LESSONS.filter(l => l.track === track.id);
    const completedInTrack = lessonsInTrack.filter(l => set.has(l.id)).length;
    const pct = lessonsInTrack.length > 0 ? Math.round((completedInTrack / lessonsInTrack.length) * 100) : 0;
    byTrack[track.id] = {
      title: track.title,
      total: lessonsInTrack.length,
      completed: completedInTrack,
      percentage: pct
    };
  });

  const totalLessons = PRACTICE_LESSONS.length;
  const totalCompleted = PRACTICE_LESSONS.filter(l => set.has(l.id)).length;
  const overallPct = totalLessons > 0 ? Math.round((totalCompleted / totalLessons) * 100) : 0;

  return {
    totalLessons,
    totalCompleted,
    overallPct,
    byTrack
  };
}

const PracticeCurriculum = {
  CURRICULUM_TRACKS,
  PRACTICE_LESSONS,
  getTracks,
  getLessons,
  getLessonById,
  verifyPracticeMove,
  calculateCurriculumProgress
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PracticeCurriculum;
}

if (typeof window !== 'undefined') {
  window.PracticeCurriculum = PracticeCurriculum;
}
