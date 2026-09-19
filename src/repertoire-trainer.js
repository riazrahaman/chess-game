'use strict';

/**
 * repertoire-trainer.js — Opening Repertoire Trainer with MoveTrainer SRS.
 *
 * Roadmap Wave 4 / N3.13 + N3.14:
 * 1. MoveTrainer-grade SRS ladder adopting Chessable's schedule:
 *    4 h -> 1 d -> 3 d -> 1 w -> 2 w -> 1 m -> 3 m -> 6 m.
 *    Correct answers advance the step; errors reset to step 0 (4 h).
 * 2. Repertoire model:
 *    Represents an opening repertoire for White or Black, structured as a move tree.
 *    Each move for the player's chosen color forms an SRS training card.
 * 3. Interactive Training Loop:
 *    - Fetches due cards according to the SRS schedule.
 *    - Verifies user move against expected repertoire move.
 *    - Replays opponent branching responses automatically.
 * 4. Post-game deviation detector:
 *    Compares played game move sequences against the repertoire tree to flag
 *    the exact ply and move where the user deviated ("You deviated at move 9").
 *
 * Pure analysis / data layer. Never mutates live game state
 * and never touches live referee state.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Chessable-style SRS intervals (in hours): 4h, 1d, 3d, 7d, 14d, 30d, 90d, 180d
const SRS_INTERVALS_HOURS = [4, 24, 72, 168, 336, 720, 2160, 4320];
const MAX_INTERVAL_HOURS = 4320; // ~6 months

/**
 * Compute the next review time and step based on review outcome.
 *
 * @param {number} currentStep - 0-based index in SRS_INTERVALS_HOURS
 * @param {boolean} wasCorrect - whether the move was played correctly
 * @param {number} now - current timestamp in ms
 * @returns {{ step: number, intervalHours: number, nextDueAt: number }}
 */
function computeNextSrs(currentStep, wasCorrect, now) {
  const ts = typeof now === 'number' ? now : Date.now();
  if (!wasCorrect) {
    const intervalHours = SRS_INTERVALS_HOURS[0];
    return {
      step: 0,
      intervalHours,
      nextDueAt: ts + intervalHours * HOUR_MS
    };
  }

  const nextStep = Math.min(currentStep + 1, SRS_INTERVALS_HOURS.length - 1);
  const intervalHours = SRS_INTERVALS_HOURS[nextStep];
  return {
    step: nextStep,
    intervalHours,
    nextDueAt: ts + intervalHours * HOUR_MS
  };
}

/**
 * Normalize move string (strips move numbers, annotations like !, ?, +, #, whitespace).
 *
 * @param {string} m
 * @returns {string}
 */
function normalizeMove(m) {
  if (!m) return '';
  return String(m)
    .replace(/^\d+\.+/, '')
    .replace(/[!?+#]/g, '')
    .trim();
}

/**
 * Create a new empty repertoire.
 *
 * @param {object} opts
 * @param {string} [opts.id]
 * @param {string} [opts.name]
 * @param {'white'|'black'} [opts.color] - which color the user trains
 * @param {string} [opts.description]
 * @returns {object} Repertoire object
 */
function createRepertoire(opts) {
  opts = opts || {};
  const id = opts.id || 'rep_' + Math.random().toString(36).slice(2, 10);
  const color = (opts.color === 'black') ? 'black' : 'white';
  return {
    id,
    name: opts.name || (color === 'white' ? 'White Repertoire' : 'Black Repertoire'),
    color,
    description: opts.description || '',
    root: {
      id: 'root',
      move: '',
      children: [],
      card: null
    },
    cards: new Map(), // cardId -> Card object
    createdAt: opts.createdAt || Date.now(),
    updatedAt: Date.now()
  };
}

/**
 * Add a line of moves to the repertoire.
 *
 * @param {object} rep - Repertoire object
 * @param {string[]|string} moves - array of SAN moves or space-separated string
 * @param {object} [lineMeta] - optional metadata (e.g. variation name)
 * @returns {number} number of new cards created
 */
function addLine(rep, moves, lineMeta) {
  if (typeof moves === 'string') {
    moves = moves.trim().split(/\s+/).filter(Boolean);
  }
  if (!Array.isArray(moves) || moves.length === 0) return 0;

  let curr = rep.root;
  let cardsAdded = 0;
  const isWhite = rep.color === 'white';

  for (let ply = 0; ply < moves.length; ply++) {
    const rawMove = moves[ply];
    const norm = normalizeMove(rawMove);
    if (!norm) continue;

    // Is this a player move? (Even ply = White, Odd ply = Black)
    const isPlayerTurn = isWhite ? (ply % 2 === 0) : (ply % 2 === 1);

    // Find or create child node
    let child = curr.children.find(c => normalizeMove(c.move) === norm);
    if (!child) {
      child = {
        id: curr.id + '_' + norm + '_' + ply,
        move: rawMove,
        ply,
        children: [],
        meta: lineMeta || null
      };
      curr.children.push(child);
    }

    // If it is the player's turn to move, this position -> move transition is an SRS card!
    if (isPlayerTurn) {
      const cardId = rep.id + ':ply' + ply + ':' + curr.id + '->' + norm;
      if (!rep.cards.has(cardId)) {
        const card = {
          id: cardId,
          repertoireId: rep.id,
          ply,
          moveNumber: Math.floor(ply / 2) + 1,
          color: rep.color,
          parentMove: curr.move,
          expectedMove: rawMove,
          normalizedExpected: norm,
          srsStep: 0,
          intervalHours: SRS_INTERVALS_HOURS[0],
          nextDueAt: 0, // due immediately on creation
          reviewCount: 0,
          correctCount: 0,
          streak: 0,
          lastReviewedAt: 0
        };
        rep.cards.set(cardId, card);
        child.cardId = cardId;
        cardsAdded++;
      }
    }

    curr = child;
  }

  rep.updatedAt = Date.now();
  return cardsAdded;
}

/**
 * Get all cards currently due for review.
 *
 * @param {object} rep - Repertoire object
 * @param {number} [now] - current epoch timestamp ms
 * @returns {object[]} array of due cards
 */
function getDueCards(rep, now) {
  const ts = typeof now === 'number' ? now : Date.now();
  const due = [];
  for (const card of rep.cards.values()) {
    if (card.nextDueAt <= ts) {
      due.push(card);
    }
  }
  // Sort cards by ply ascending (train early moves first) then nextDueAt ascending
  due.sort((a, b) => a.ply - b.ply || a.nextDueAt - b.nextDueAt);
  return due;
}

/**
 * Record a training attempt on a card.
 *
 * @param {object} rep - Repertoire object
 * @param {string} cardId - card ID
 * @param {string} playedMove - SAN or normalized move played by the user
 * @param {number} [now] - timestamp
 * @returns {{ correct: boolean, expected: string, card: object, srs: object }}
 */
function reviewCard(rep, cardId, playedMove, now) {
  const card = rep.cards.get(cardId);
  if (!card) {
    throw new Error('Card not found: ' + cardId);
  }

  const ts = typeof now === 'number' ? now : Date.now();
  const normPlayed = normalizeMove(playedMove);
  const wasCorrect = normPlayed === card.normalizedExpected;

  const srs = computeNextSrs(card.srsStep, wasCorrect, ts);

  card.reviewCount++;
  card.lastReviewedAt = ts;
  card.srsStep = srs.step;
  card.intervalHours = srs.intervalHours;
  card.nextDueAt = srs.nextDueAt;

  if (wasCorrect) {
    card.correctCount++;
    card.streak++;
  } else {
    card.streak = 0;
  }

  rep.updatedAt = ts;

  return {
    correct: wasCorrect,
    expected: card.expectedMove,
    played: playedMove,
    card,
    srs
  };
}

/**
 * Pick an opponent continuation from the repertoire tree given the current path of moves.
 *
 * @param {object} rep - Repertoire object
 * @param {string[]|string} currentPath - moves played so far
 * @param {number} [seed] - optional seed for deterministic choice among branches
 * @returns {string|null} opponent's response SAN move, or null if end of repertoire branch
 */
function getOpponentContinuation(rep, currentPath, seed) {
  if (typeof currentPath === 'string') {
    currentPath = currentPath.trim().split(/\s+/).filter(Boolean);
  }
  currentPath = currentPath || [];

  let curr = rep.root;
  for (const m of currentPath) {
    const norm = normalizeMove(m);
    const next = curr.children.find(c => normalizeMove(c.move) === norm);
    if (!next) return null; // off-repertoire
    curr = next;
  }

  if (!curr.children || curr.children.length === 0) {
    return null; // reached leaf of repertoire
  }

  // If there are multiple branches, pick deterministically
  if (curr.children.length === 1) {
    return curr.children[0].move;
  }

  const s = typeof seed === 'number' ? Math.abs(seed) : 0;
  const idx = s % curr.children.length;
  return curr.children[idx].move;
}

/**
 * Detect where a game deviated from the repertoire.
 *
 * @param {object} rep - Repertoire object
 * @param {string[]|string} gameMoves - all moves played in the game
 * @returns {{
 *   deviated: boolean,
 *   deviatedByPlayer?: boolean,
 *   ply?: number,
 *   moveNumber?: number,
 *   color?: string,
 *   expected?: string[],
 *   played?: string,
 *   message?: string
 * }}
 */
function detectDeviation(rep, gameMoves) {
  if (typeof gameMoves === 'string') {
    gameMoves = gameMoves.trim().split(/\s+/).filter(Boolean);
  }
  if (!Array.isArray(gameMoves) || gameMoves.length === 0) {
    return { deviated: false, message: 'No moves played' };
  }

  const isWhite = rep.color === 'white';
  let curr = rep.root;

  for (let ply = 0; ply < gameMoves.length; ply++) {
    const rawMove = gameMoves[ply];
    const norm = normalizeMove(rawMove);
    const isPlayerTurn = isWhite ? (ply % 2 === 0) : (ply % 2 === 1);

    const child = curr.children.find(c => normalizeMove(c.move) === norm);

    if (!child) {
      // Reached deviation point
      const expectedMoves = curr.children.map(c => c.move);
      const moveNum = Math.floor(ply / 2) + 1;
      const turnColor = (ply % 2 === 0) ? 'white' : 'black';

      if (expectedMoves.length === 0) {
        // Not a deviation, just played beyond the repertoire preparation depth
        return {
          deviated: false,
          inRepertoireToPly: ply,
          message: 'Followed repertoire through ply ' + ply + ' (end of book reached).'
        };
      }

      const msg = isPlayerTurn
        ? `You deviated from your repertoire at move ${moveNum} (${rawMove} played; expected ${expectedMoves.join(' or ')})`
        : `Opponent deviated from your repertoire at move ${moveNum} (${rawMove} played; expected ${expectedMoves.join(' or ')})`;

      return {
        deviated: true,
        deviatedByPlayer: isPlayerTurn,
        ply,
        moveNumber: moveNum,
        color: turnColor,
        expected: expectedMoves,
        played: rawMove,
        message: msg
      };
    }

    curr = child;
  }

  return {
    deviated: false,
    inRepertoireToPly: gameMoves.length,
    message: 'Game followed the repertoire completely!'
  };
}

/**
 * Get overall summary statistics of a repertoire.
 *
 * @param {object} rep - Repertoire object
 * @param {number} [now]
 * @returns {object} summary statistics
 */
function getRepertoireStats(rep, now) {
  const ts = typeof now === 'number' ? now : Date.now();
  const totalCards = rep.cards.size;
  let dueCount = 0;
  let masteredCount = 0; // step >= 5 (~1 month+)
  let totalReviews = 0;
  let totalCorrect = 0;

  for (const card of rep.cards.values()) {
    if (card.nextDueAt <= ts) dueCount++;
    if (card.srsStep >= 5) masteredCount++;
    totalReviews += card.reviewCount;
    totalCorrect += card.correctCount;
  }

  const accuracy = totalReviews > 0 ? Math.round((totalCorrect / totalReviews) * 100) : 0;

  return {
    id: rep.id,
    name: rep.name,
    color: rep.color,
    totalCards,
    dueCount,
    masteredCount,
    totalReviews,
    totalCorrect,
    accuracyPct: accuracy
  };
}

/**
 * Export repertoire to JSON serializable structure.
 */
function toJSON(rep) {
  return {
    id: rep.id,
    name: rep.name,
    color: rep.color,
    description: rep.description,
    createdAt: rep.createdAt,
    updatedAt: rep.updatedAt,
    root: rep.root,
    cards: Array.from(rep.cards.entries())
  };
}

/**
 * Restore repertoire from JSON structure.
 */
function fromJSON(data) {
  if (!data || !data.id || !data.root) {
    throw new Error('Invalid repertoire data');
  }
  const rep = {
    id: data.id,
    name: data.name,
    color: data.color || 'white',
    description: data.description || '',
    createdAt: data.createdAt || Date.now(),
    updatedAt: data.updatedAt || Date.now(),
    root: data.root,
    cards: new Map(data.cards || [])
  };
  return rep;
}

const RepertoireTrainer = {
  SRS_INTERVALS_HOURS,
  MAX_INTERVAL_HOURS,
  computeNextSrs,
  normalizeMove,
  createRepertoire,
  addLine,
  getDueCards,
  reviewCard,
  getOpponentContinuation,
  detectDeviation,
  getRepertoireStats,
  toJSON,
  fromJSON
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RepertoireTrainer;
}

if (typeof window !== 'undefined') {
  window.RepertoireTrainer = RepertoireTrainer;
}
