'use strict';

/**
 * achievements.js — Wave 3 (roadmap §6 Tier N2 item 9): achievements tied to
 * skill events, not volume grinding.
 *
 * Server-only module. `CATALOGUE` is the fixed list (id/title/description/icon
 * + the event types that can unlock it); `evaluate(event, context)` is pure and
 * returns the ids newly earned by this event given the player's context.
 * `AchievementService` wraps it with the social-store persistence and makes the
 * award idempotent (the store's saveAchievement is INSERT OR IGNORE).
 *
 * Event shapes (all `type` strings; anything else evaluates to []):
 *   { type: 'game_over', rated, won, result }            from rating-hook game-over events
 *   { type: 'brilliant', verified: true, gameId, ply }   client-posted, verified server-side
 *   { type: 'tablebase_perfect', verified: true, ... }   client-posted, verified server-side
 *   { type: 'puzzle', solved, themes[] }                 from routes-puzzles activity
 *   { type: 'activity', kind }                           any streak activity
 *   { type: 'league_promotion', from, to }               hook for Weekly Leagues (Worker B)
 *
 * Context (all optional; missing values never unlock anything):
 *   awarded: Set|Array of already-held ids
 *   streak: { current }                    from streaks.js getStreak()
 *   puzzleDayStreak: number                consecutive puzzle days (streaks.js)
 *   puzzleRating: number|null              game-archive puzzle_ratings ('solver', 'user:<id>'), read-only
 *   ratedGames, ratedWins: number          retention_counters maintained by routes-retention
 */

const CATALOGUE = Object.freeze([
  { id: 'first_rated_win', title: 'First blood', description: 'Win your first rated game against another signed-in player.', icon: '🏅', events: ['game_over'] },
  { id: 'rated_games_10', title: 'Regular', description: 'Finish ten rated games — enough for your rating to mean something.', icon: '♟', events: ['game_over'] },
  { id: 'first_brilliant_move', title: 'Brilliant!', description: 'Play a move that Game Review classifies as brilliant.', icon: '✨', events: ['brilliant'] },
  { id: 'tablebase_perfect_endgame', title: 'Perfect technique', description: 'Convert a tablebase endgame (7 pieces or fewer) without a single tablebase mistake.', icon: '📐', events: ['tablebase_perfect'] },
  { id: 'first_mate_in_one_solved', title: 'Checkmate!', description: 'Solve your first mate-in-one puzzle.', icon: '♚', events: ['puzzle'] },
  { id: 'puzzle_streak_7', title: 'Puzzle habit', description: 'Attempt or review a puzzle on seven consecutive days.', icon: '🧩', events: ['puzzle', 'activity'] },
  { id: 'puzzle_rating_1500', title: 'Sharp eye', description: 'Reach a puzzle rating of 1500.', icon: '🎯', events: ['puzzle'] },
  { id: 'puzzle_rating_1800', title: 'Tactician', description: 'Reach a puzzle rating of 1800.', icon: '🔭', events: ['puzzle'] },
  { id: 'puzzle_rating_2100', title: 'Grandmaster vision', description: 'Reach a puzzle rating of 2100.', icon: '🧠', events: ['puzzle'] },
  { id: 'streak_7', title: 'One week strong', description: 'Keep a seven-day activity streak.', icon: '🔥', events: ['activity', 'game_over', 'puzzle'] },
  { id: 'streak_30', title: 'Thirty days', description: 'Keep a thirty-day activity streak.', icon: '🌋', events: ['activity', 'game_over', 'puzzle'] },
  { id: 'first_league_promotion', title: 'Moving up', description: 'Get promoted out of your first Weekly League division.', icon: '🏆', events: ['league_promotion'] }
]);

const BY_ID = new Map(CATALOGUE.map(a => [a.id, a]));

function getAchievement(id) {
  return BY_ID.get(String(id)) || null;
}

function toSet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.map(v => (v && typeof v === 'object' ? v.id : v)));
  return new Set();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pure: which catalogue ids does `event` unlock for a player in `context`?
 * Never returns ids already in context.awarded. Order follows CATALOGUE.
 */
function evaluate(event, context = {}) {
  if (!event || typeof event.type !== 'string') return [];
  const type = event.type;
  const awarded = toSet(context.awarded);
  const streak = context.streak && num(context.streak.current) != null ? num(context.streak.current) : 0;
  const puzzleDays = num(context.puzzleDayStreak) || 0;
  const puzzleRating = num(context.puzzleRating);
  const ratedGames = num(context.ratedGames) || 0;
  const ratedWins = num(context.ratedWins) || 0;
  const themes = Array.isArray(event.themes) ? event.themes.map(String) : [];

  const checks = {
    first_rated_win: () => type === 'game_over' && ratedWins >= 1,
    rated_games_10: () => type === 'game_over' && ratedGames >= 10,
    first_brilliant_move: () => type === 'brilliant' && event.verified === true,
    tablebase_perfect_endgame: () => type === 'tablebase_perfect' && event.verified === true,
    first_mate_in_one_solved: () => type === 'puzzle' && event.solved === true && themes.includes('mateIn1'),
    puzzle_streak_7: () => (type === 'puzzle' || type === 'activity') && puzzleDays >= 7,
    puzzle_rating_1500: () => type === 'puzzle' && puzzleRating != null && puzzleRating >= 1500,
    puzzle_rating_1800: () => type === 'puzzle' && puzzleRating != null && puzzleRating >= 1800,
    puzzle_rating_2100: () => type === 'puzzle' && puzzleRating != null && puzzleRating >= 2100,
    streak_7: () => streak >= 7,
    streak_30: () => streak >= 30,
    first_league_promotion: () => type === 'league_promotion'
  };

  const out = [];
  for (const entry of CATALOGUE) {
    if (awarded.has(entry.id)) continue;
    if (!entry.events.includes(type)) continue;
    const check = checks[entry.id];
    if (check && check()) out.push(entry.id);
  }
  return out;
}

class AchievementService {
  constructor(options = {}) {
    if (!options.store || typeof options.store.saveAchievement !== 'function') {
      throw new TypeError('AchievementService: a store with saveAchievement/listAchievements is required');
    }
    this.store = options.store;
  }

  listAwarded(playerId) {
    return this.store.listAchievements(String(playerId)).filter(a => BY_ID.has(a.id));
  }

  /**
   * Evaluate `event` for `playerId` and persist anything newly earned.
   * Returns the array of newly awarded { id, awardedAt, evidence }.
   */
  award(playerId, event, context = {}, now) {
    const pid = String(playerId);
    const held = this.listAwarded(pid);
    const ctx = Object.assign({}, context, { awarded: held.map(a => a.id) });
    const ids = evaluate(event, ctx);
    const at = now == null ? Date.now() : Number(now);
    const fresh = [];
    for (const id of ids) {
      const evidence = buildEvidence(id, event, ctx);
      if (this.store.saveAchievement(pid, id, at, evidence)) fresh.push({ id, awardedAt: at, evidence });
    }
    return fresh;
  }
}

function buildEvidence(id, event, ctx) {
  const evidence = { event: event.type };
  if (event.gameId != null) evidence.gameId = String(event.gameId);
  if (event.ply != null) evidence.ply = Number(event.ply);
  if (event.san != null) evidence.san = String(event.san);
  if (event.puzzleId != null) evidence.puzzleId = String(event.puzzleId);
  if (id.startsWith('streak_')) evidence.streak = ctx.streak ? ctx.streak.current : null;
  if (id === 'puzzle_streak_7') evidence.puzzleDayStreak = ctx.puzzleDayStreak;
  if (id.startsWith('puzzle_rating_')) evidence.puzzleRating = ctx.puzzleRating;
  if (id === 'rated_games_10') evidence.ratedGames = ctx.ratedGames;
  if (id === 'first_rated_win') evidence.ratedWins = ctx.ratedWins;
  if (event.type === 'league_promotion') { evidence.from = event.from; evidence.to = event.to; }
  return evidence;
}

/** Catalogue merged with a player's awarded rows (for the API / UI). */
function presentCatalogue(awarded) {
  const map = new Map((awarded || []).map(a => [a.id, a]));
  return CATALOGUE.map(a => {
    const got = map.get(a.id);
    return { id: a.id, title: a.title, description: a.description, icon: a.icon, awarded: !!got, awardedAt: got ? got.awardedAt : null };
  });
}

let defaultService = null;
function getDefaultService() {
  if (!defaultService) {
    defaultService = new AchievementService({ store: require('./social-store.js').getDefaultStore() });
  }
  return defaultService;
}
function resetDefaultService() { defaultService = null; }

module.exports = {
  CATALOGUE,
  getAchievement,
  evaluate,
  presentCatalogue,
  AchievementService,
  getDefaultService,
  resetDefaultService
};
