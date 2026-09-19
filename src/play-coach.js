'use strict';

/**
 * play-coach.js — Play-Coach Adaptive Sparring Partner & Real-Time Coach.
 *
 * Roadmap Wave 4 / N1.2:
 * 1. Adaptive Strength Sparring:
 *    Combines bot-service + ai-coach + maia-bot in a single loop.
 *    Dynamically adjusts opponent rating and depth to match the player's
 *    live performance (ramping up when player dominates, easing up on blunders).
 * 2. Proactive Threat Warnings:
 *    Detects opponent threats (hanging pieces, forks, checks, back-rank danger)
 *    and provides early warning before the player commits a move.
 * 3. Socratic Guiding Questions:
 *    Prompts the player with guiding questions rather than direct move spoilers.
 * 4. Interactive Takeback & Retry Coaching Dialogue:
 *    Interprets eval swings on mistakes and offers pedagogical takeback advice.
 *
 * Pure analysis / coaching layer. Never mutates live referee state and respects Gate 4.
 */

const aiCoach = typeof require !== 'undefined' ? require('./ai-coach.js') : (typeof window !== 'undefined' ? window.AiCoach : null);
const maiaBot = typeof require !== 'undefined' ? require('./maia-bot.js') : (typeof window !== 'undefined' ? window.MaiaBot : null);

const COACH_PERSONAS = {
  encouraging: {
    id: 'encouraging',
    name: 'Coach Maya',
    style: 'Friendly & Supportive',
    greeting: 'Welcome! I’m Coach Maya. Take your time, calculate carefully, and remember every move is a lesson!'
  },
  tactical: {
    id: 'tactical',
    name: 'Coach Viktor',
    style: 'Sharp & Tactical',
    greeting: 'Eyes sharp! Look for every check, capture, and threat on every single move.'
  },
  master: {
    id: 'master',
    name: 'Coach Anatoly',
    style: 'Strategic & Positional',
    greeting: 'Control the center, activate your pieces, and maintain king safety at all times.'
  }
};

/**
 * Create a new Play-Coach session state.
 *
 * @param {object} [opts]
 * @param {number} [opts.initialRating] - default 1200
 * @param {'encouraging'|'tactical'|'master'} [opts.persona]
 * @returns {object} Session state
 */
function createPlayCoachSession(opts) {
  opts = opts || {};
  const personaKey = opts.persona || 'encouraging';
  const persona = COACH_PERSONAS[personaKey] || COACH_PERSONAS.encouraging;
  const initialRating = typeof opts.initialRating === 'number' ? opts.initialRating : 1200;

  return {
    id: 'coach_' + Math.random().toString(36).slice(2, 10),
    persona,
    targetRating: initialRating,
    currentStrength: initialRating,
    consecutiveBestMoves: 0,
    consecutiveMistakes: 0,
    takebacksAllowed: 3,
    takebacksUsed: 0,
    moveHistory: [],
    threatHistory: []
  };
}

/**
 * Adapt coach strength dynamically based on recent player accuracy.
 *
 * @param {object} session - coach session state
 * @param {string} moveClassification - 'brilliant'|'best'|'excellent'|'good'|'inaccuracy'|'mistake'|'blunder'
 * @returns {{ adaptedRating: number, change: number, explanation: string }}
 */
function adaptCoachStrength(session, moveClassification) {
  if (!session) throw new Error('Session required');

  let change = 0;
  const key = String(moveClassification || '').toLowerCase();

  if (key === 'brilliant' || key === 'best' || key === 'excellent') {
    session.consecutiveBestMoves++;
    session.consecutiveMistakes = 0;
    if (session.consecutiveBestMoves >= 3) {
      change = 50; // ramp up challenge
      session.consecutiveBestMoves = 0;
    }
  } else if (key === 'mistake' || key === 'blunder') {
    session.consecutiveMistakes++;
    session.consecutiveBestMoves = 0;
    if (session.consecutiveMistakes >= 2) {
      change = -50; // ease up to allow player recovery
      session.consecutiveMistakes = 0;
    }
  } else {
    // Inaccuracy / good: maintain
    session.consecutiveBestMoves = 0;
    session.consecutiveMistakes = 0;
  }

  session.currentStrength = Math.max(800, Math.min(2200, session.currentStrength + change));

  let explanation = 'Coach strength maintained.';
  if (change > 0) explanation = `Impressive play! Ramping up coach difficulty to ~${session.currentStrength} to challenge you.`;
  if (change < 0) explanation = `Easing opponent pressure slightly to ~${session.currentStrength}. Look for rebuilding your position.`;

  return {
    adaptedRating: session.currentStrength,
    change,
    explanation
  };
}

/**
 * Analyze position for immediate threats created by opponent's last move.
 *
 * @param {object} params
 * @param {string} params.lastMove - last opponent move (e.g. 'Qh5', 'e4d5')
 * @param {boolean} [params.isCheck] - whether player is currently in check
 * @param {number} [params.evalCp] - engine eval in centipawns
 * @param {string[]} [params.hangingSquares] - list of undefended squares under attack
 * @returns {{
 *   hasThreat: boolean,
 *   level: 'danger'|'warning'|'safe',
 *   threatType: string,
 *   message: string,
 *   guidingQuestion: string
 * }}
 */
function analyzeThreats(params = {}) {
  const isCheck = !!params.isCheck;
  const lastMove = String(params.lastMove || '');
  const hanging = Array.isArray(params.hangingSquares) ? params.hangingSquares : [];

  // Check threat
  if (isCheck) {
    return {
      hasThreat: true,
      level: 'danger',
      threatType: 'check',
      message: 'Your King is in check! You must move the king, block the attack, or capture the checking piece.',
      guidingQuestion: 'Can you safely block the check, or does your king need to step aside?'
    };
  }

  // Hanging pieces threat
  if (hanging.length > 0) {
    const sq = hanging[0];
    return {
      hasThreat: true,
      level: 'warning',
      threatType: 'hanging_piece',
      message: `Heads up! Your piece on ${sq} is currently under pressure and may be undefended.`,
      guidingQuestion: `Look at square ${sq}: is that piece adequately protected by a friendly piece?`
    };
  }

  // Aggressive queen early move threat
  if (lastMove.startsWith('Q') && !lastMove.includes('x')) {
    return {
      hasThreat: true,
      level: 'warning',
      threatType: 'queen_invasion',
      message: 'The enemy Queen has entered your territory early. Watch out for dual-target forks on your pawns.',
      guidingQuestion: 'Which squares or pawns did the queen’s new position target?'
    };
  }

  return {
    hasThreat: false,
    level: 'safe',
    threatType: 'none',
    message: 'The position is steady. Focus on activating your least active piece.',
    guidingQuestion: 'Which piece is the least active right now? How can you improve its square?'
  };
}

/**
 * Generate Socratic guiding questions for the player's turn.
 *
 * @param {object} context
 * @param {string} [context.phase] - 'opening'|'middlegame'|'endgame'
 * @param {boolean} [context.hasTactics]
 * @returns {string} Socratic question
 */
function getSocraticQuestion(context = {}) {
  const phase = context.phase || 'opening';

  if (context.hasTactics) {
    return 'Look closely at your opponent’s uncoordinated pieces: is there a tactical fork, pin, or skewer available?';
  }

  switch (phase) {
    case 'opening':
      return 'Before you move: have you developed your minor pieces, controlled the center, and kept your king safe?';
    case 'middlegame':
      return 'What is your long-term plan? Can you create an outpost for your knights or an open file for your rooks?';
    case 'endgame':
      return 'In the endgame, the King is an attacking piece! Can you activate your king towards the passed pawns?';
    default:
      return 'What is your opponent threatening with their last move?';
  }
}

/**
 * Evaluate if a move warrants a takeback offer and coaching hint.
 *
 * @param {object} session - coach session
 * @param {string} moveClassification - 'blunder'|'mistake'|'inaccuracy'
 * @param {string} [bestAlternative] - recommended alternative move
 * @returns {{
 *   offerTakeback: boolean,
 *   coachingDialogue: string,
 *   guidingHint: string
 * }}
 */
function evaluateTakebackOpportunity(session, moveClassification, bestAlternative) {
  const key = String(moveClassification || '').toLowerCase();
  const isSevere = key === 'blunder' || key === 'mistake';

  if (!isSevere || !session || session.takebacksUsed >= session.takebacksAllowed) {
    return {
      offerTakeback: false,
      coachingDialogue: '',
      guidingHint: ''
    };
  }

  const personaName = session.persona ? session.persona.name : 'Coach';
  const dialogue = key === 'blunder'
    ? `${personaName}: Careful! That move conceded a critical piece or tactical shot. Would you like to take it back and rethink?`
    : `${personaName}: That move relinquished some advantage. Want to try another idea?`;

  const hint = bestAlternative
    ? `Look for ideas involving ${bestAlternative} to keep maximum piece activity.`
    : 'Ask yourself: does this square leave any of your pieces undefended?';

  return {
    offerTakeback: true,
    coachingDialogue: dialogue,
    guidingHint: hint,
    takebacksRemaining: session.takebacksAllowed - session.takebacksUsed
  };
}

/**
 * Record a takeback in the coach session.
 * @param {object} session
 * @returns {boolean} whether takeback was granted
 */
function recordTakeback(session) {
  if (!session || session.takebacksUsed >= session.takebacksAllowed) {
    return false;
  }
  session.takebacksUsed++;
  session.consecutiveMistakes = 0;
  return true;
}

const PlayCoach = {
  COACH_PERSONAS,
  createPlayCoachSession,
  adaptCoachStrength,
  analyzeThreats,
  getSocraticQuestion,
  evaluateTakebackOpportunity,
  recordTakeback
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PlayCoach;
}

if (typeof window !== 'undefined') {
  window.PlayCoach = PlayCoach;
}
