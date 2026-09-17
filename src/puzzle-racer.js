'use strict';

/**
 * puzzle-racer.js — P6: Puzzle Racer / Battle (multiplayer puzzle race).
 *
 * A pure-data race controller that runs over the existing SSE room + seat-auth
 * infrastructure. Players in a room race through the SAME seeded puzzle sequence;
 * the first correct answer per puzzle scores the most (speed-based, streak ×2),
 * mirroring the lichess arena scoring model applied to puzzles.
 *
 * Gate 4: this module never calls makeMove or createInitialBoard and never
 * mutates referee state. It only reads puzzle + rating stores and produces
 * race state for the presentation layer.
 *
 * Public API:
 *   createRace(options)                  — new RacerRoom
 *   RacerRoom: join/leave/answerPuzzle/advance/leaderboard/isActive/currentPuzzle
 *   constants: DEFAULT_SEED, DEFAULT_DURATION_SEC, SCORE_BASE, STREAK_MULTIPLIER
 */

const DEFAULT_SEED = 'chess-puzzle-racer-v1';
const DEFAULT_DURATION_SEC = 180;
const SCORE_BASE = 2;           // points for a correct solve
const STREAK_MULTIPLIER = 2;    // arena-style streak doubling
const MAX_STREAK_MULTIPLIER = 8; // capped ×8

function hashSeed(seed) {
  const text = String(seed == null ? '' : seed);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Reproducible Mulberry32 RNG. */
function createSeededRng(seed) {
  let state = hashSeed(seed);
  return function seededRandom() {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function timestamp(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function shuffledCopy(values, rng) {
  const result = values.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const random = Math.min(0.999999999999, Math.max(0, Number(rng()) || 0));
    const index = Math.floor(random * (i + 1));
    [result[i], result[index]] = [result[index], result[i]];
  }
  return result;
}

class RacerRoom {
  constructor(options = {}) {
    const duration = Number(options.durationSec);
    this.durationSec = Number.isFinite(duration) && duration >= 0 ? duration : DEFAULT_DURATION_SEC;
    this.roomId = options.roomId == null ? 'default' : String(options.roomId);
    this.puzzles = Array.isArray(options.puzzles) ? options.puzzles.slice() : [];
    this.rng = typeof options.rng === 'function'
      ? options.rng
      : createSeededRng(Object.prototype.hasOwnProperty.call(options, 'seed') ? options.seed : DEFAULT_SEED);
    this.startAt = timestamp(options.now);
    this.deadline = this.startAt + this.durationSec * 1000;
    this.sequence = shuffledCopy(this.puzzles, this.rng);
    this.players = new Map(); // id -> { id, score, streak, solved, wrong }
    this.round = 0;
    this.finished = false;
  }

  join(playerId, now) {
    const id = String(playerId);
    if (!this.players.has(id)) {
      this.players.set(id, { id, score: 0, streak: 0, solved: 0, wrong: 0, lastSolveAt: null });
    }
    return this.players.get(id);
  }

  leave(playerId) {
    this.players.delete(String(playerId));
  }

  _expire(now) {
    if (!this.finished && timestamp(now) >= this.deadline) {
      this.finished = true;
    }
    return this.finished;
  }

  isActive(now) {
    this._expire(now);
    return !this.finished;
  }

  /** The puzzle everyone is currently racing on (deterministic sequence). */
  currentPuzzle() {
    if (this.sequence.length === 0) return null;
    return this.sequence[Math.min(this.round, this.sequence.length - 1)];
  }

  /**
   * Record a player's answer. Correct answers advance the shared round and
   * award points: SCORE_BASE × streak multiplier, capped.
   */
  answerPuzzle(playerId, isCorrect, now) {
    const id = String(playerId);
    const player = this.players.get(id);
    if (!player) return { error: 'not-joined' };
    if (this._expire(now)) return { error: 'finished', player };

    if (isCorrect) {
      player.streak += 1;
      player.solved += 1;
      const multiplier = Math.min(MAX_STREAK_MULTIPLIER, Math.pow(STREAK_MULTIPLIER, player.streak - 1));
      const gained = SCORE_BASE * multiplier;
      player.score += gained;
      player.lastSolveAt = timestamp(now);
      const advanced = this.round < this.sequence.length - 1;
      if (advanced) this.round += 1;
      return { player, gained, round: this.round, advanced };
    }
    player.streak = 0;
    player.wrong += 1;
    return { player, gained: 0, round: this.round, advanced: false };
  }

  leaderboard(now) {
    this._expire(now);
    const entries = Array.from(this.players.values()).map(p => ({ ...p }));
    entries.sort((a, b) => b.score - a.score || (a.lastSolveAt || 0) - (b.lastSolveAt || 0));
    return entries.map((p, i) => ({ ...p, rank: i + 1 }));
  }

  state(now) {
    this._expire(now);
    return {
      roomId: this.roomId,
      finished: this.finished,
      round: this.round,
      totalRounds: this.sequence.length,
      currentPuzzle: this.currentPuzzle(),
      leaderboard: this.leaderboard(now)
    };
  }
}

function createRace(options) {
  return new RacerRoom(options);
}

const PuzzleRacer = {
  DEFAULT_SEED,
  DEFAULT_DURATION_SEC,
  SCORE_BASE,
  STREAK_MULTIPLIER,
  MAX_STREAK_MULTIPLIER,
  RacerRoom,
  createRace,
  createSeededRng
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PuzzleRacer;
}
if (typeof window !== 'undefined') {
  window.PuzzleRacer = PuzzleRacer;
}
