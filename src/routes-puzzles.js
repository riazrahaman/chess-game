'use strict';

/**
 * routes-puzzles.js — `/api/puzzle/*` (Wave 2, roadmap E4 + R2 Puzzles row).
 *
 * lichess-shaped puzzle API on top of the SQLite `puzzles` table
 * (game-archive.js) and the previously dark libraries puzzle-service.js,
 * puzzle-rating.js, puzzle-storm.js, daily-puzzle.js and puzzle-repetition.js.
 *
 * Nothing here touches referee state: puzzles are replayed in a private
 * chess.js instance (rules-engine.js `create`) and the ONLY writes are to the
 * puzzle tables. The client never validates a move itself — every attempt is
 * checked server-side against the stored solution; a move that differs from
 * the solution is accepted only if chess.js confirms it delivers checkmate.
 *
 * Route table (all JSON):
 *   GET  /api/puzzle/daily                      today's puzzle (UTC-date seeded, stable)
 *   GET  /api/puzzle/next?theme=&rating=        next puzzle near the player's (or given) rating
 *   GET  /api/puzzle/batch/:theme?nb=           up to 50 puzzles for a theme ('mix' = any)
 *   GET  /api/puzzle/themes                     theme list with counts
 *   GET  /api/puzzle/dashboard/:days            per-theme results over the last N days
 *   GET  /api/puzzle/review                     spaced-repetition queue (due + upcoming)
 *   GET  /api/puzzle/storm/start?seed=          start a Puzzle Storm session (deterministic per seed)
 *   POST /api/puzzle/storm/result               { sessionId, result:'solved'|'failed', timeMs }
 *   GET  /api/puzzle/:id                        one puzzle (solution hidden)
 *   POST /api/puzzle/:id/try                    { move, moves? } validate one solver move
 *   POST /api/puzzle/:id/solve                  { moves, timeMs, win, mode? } commit the attempt
 *
 * Player identity: the auth session (`getAuthUser`) when signed in, otherwise
 * an anonymous `puzzle_player` cookie minted on first contact.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PuzzleService = require('./puzzle-service.js');
const PuzzleRating = require('./puzzle-rating.js');
const PuzzleStorm = require('./puzzle-storm.js');
const DailyPuzzle = require('./daily-puzzle.js');
const PuzzleRepetition = require('./puzzle-repetition.js');
const RulesEngine = require('./rules-engine.js');

const SAMPLE_CSV = path.join(__dirname, '..', 'data', 'puzzles-sample.csv');
const STORM_TTL_MS = 15 * 60 * 1000;
const STORM_POOL_SIZE = 240;
const MAX_BATCH = 50;
const RECENT_EXCLUDE = 200;

const THEME_LABELS = {
  mix: 'Healthy mix', mate: 'Checkmate', mateIn1: 'Mate in 1', mateIn2: 'Mate in 2', mateIn3: 'Mate in 3',
  fork: 'Fork', pin: 'Pin', skewer: 'Skewer', discoveredAttack: 'Discovered attack', hangingPiece: 'Hanging piece',
  sacrifice: 'Sacrifice', deflection: 'Deflection', attraction: 'Attraction', backRankMate: 'Back-rank mate',
  trappedPiece: 'Trapped piece', promotion: 'Promotion', endgame: 'Endgame', opening: 'Opening',
  middlegame: 'Middlegame', advantage: 'Advantage', crushing: 'Crushing', short: 'Short', long: 'Long',
  oneMove: 'One move', quietMove: 'Quiet move', defensiveMove: 'Defensive move', zugzwang: 'Zugzwang',
  rookEndgame: 'Rook endgame', pawnEndgame: 'Pawn endgame', queenEndgame: 'Queen endgame',
  bishopEndgame: 'Bishop endgame', knightEndgame: 'Knight endgame', exposedKing: 'Exposed king',
  kingsideAttack: 'Kingside attack', queensideAttack: 'Queenside attack', master: 'Master game',
  masterVsMaster: 'Master vs master', superGM: 'Super GM', veryLong: 'Very long', xRayAttack: 'X-ray',
  intermezzo: 'Intermezzo', clearance: 'Clearance', interference: 'Interference', doubleCheck: 'Double check',
  smotheredMate: 'Smothered mate', arabianMate: 'Arabian mate', anastasiaMate: "Anastasia's mate",
  bodenMate: "Boden's mate", hookMate: 'Hook mate', dovetailMate: 'Dovetail mate', castling: 'Castling',
  enPassant: 'En passant', underPromotion: 'Under-promotion', capturingDefender: 'Capture the defender',
  equality: 'Equality', advancedPawn: 'Advanced pawn', attackingF2F7: 'Attacking f2/f7'
};

// ---------------------------------------------------------------------------
// Store + seeding
// ---------------------------------------------------------------------------
let seededOnce = false;
let ratingStore = null;
let stormSessions = new Map();
let dailyCache = { date: null, puzzle: null };

function ensureStore(ctx) {
  const archive = ctx && ctx.gameArchive;
  if (archive && PuzzleService.getStore() !== archive) {
    PuzzleService.setStore(archive);
    ratingStore = new PuzzleRating.PuzzleRatingStore({ archive });
    seededOnce = false;
    dailyCache = { date: null, puzzle: null };
  }
  if (!ratingStore) ratingStore = new PuzzleRating.PuzzleRatingStore({ archive: archive || null });
  if (!seededOnce) {
    seededOnce = true;
    try {
      if (PuzzleService.hasStore() && PuzzleService.puzzleCount() === 0 && fs.existsSync(SAMPLE_CSV)) {
        const started = Date.now();
        const { imported, skipped } = PuzzleService.importCsvIntoStore(SAMPLE_CSV);
        console.log(`[puzzles] imported ${imported} puzzles from data/puzzles-sample.csv (${skipped} skipped) in ${Date.now() - started} ms`);
      }
    } catch (err) {
      console.error('[puzzles] sample import failed:', err && err.message ? err.message : err);
    }
  }
}

/** Test hook: forget the seeded flag so a fresh archive gets seeded again. */
function resetForTests() {
  seededOnce = false;
  ratingStore = null;
  stormSessions = new Map();
  dailyCache = { date: null, puzzle: null };
  PuzzleService.setStore(null);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseQuery(req) {
  const idx = req.url.indexOf('?');
  return new URLSearchParams(idx >= 0 ? req.url.slice(idx + 1) : '');
}

function playerIdFor(req, res, ctx) {
  const session = ctx && typeof ctx.getAuthUser === 'function' ? ctx.getAuthUser(req) : null;
  if (session && session.userId) {
    return { id: `user:${session.userId}`, username: session.username || null, authenticated: true };
  }
  const cookies = ctx && typeof ctx.parseCookies === 'function' ? ctx.parseCookies(req) : {};
  let anon = cookies.puzzle_player;
  if (!anon || !/^[A-Za-z0-9_-]{8,64}$/.test(anon)) {
    anon = crypto.randomBytes(12).toString('base64url');
    if (res && !res.headersSent) {
      res.setHeader('Set-Cookie', `puzzle_player=${anon}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 24 * 3600}`);
    }
  }
  return { id: `anon:${anon}`, username: null, authenticated: false };
}

function uciOf(move) {
  return move.from + move.to + (move.promotion || '');
}

function applyUci(chess, uci) {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;
  const mv = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
  if (uci.length === 5) mv.promotion = uci[4];
  try { return chess.move(mv); } catch (_) { return null; }
}

/** Accepts "e2e4", "e7e8q", {from,to,promotion} or SAN; returns a UCI string or null. */
function normalizeMoveInput(chess, input) {
  if (!input) return null;
  if (typeof input === 'object') {
    if (!input.from || !input.to) return null;
    return `${input.from}${input.to}${input.promotion ? String(input.promotion).toLowerCase() : ''}`;
  }
  const text = String(input).trim();
  if (/^[a-h][1-8][a-h][1-8][qrbnQRBN]?$/.test(text)) return text.toLowerCase();
  // SAN: resolve against the current legal moves without mutating `chess`.
  const legal = chess.moves({ verbose: true });
  const clean = text.replace(/[+#?!]+$/g, '');
  const hit = legal.find(m => m.san.replace(/[+#]+$/g, '') === clean);
  return hit ? uciOf(hit) : null;
}

/** Public (solution-free) view of a puzzle. */
function presentPuzzle(p) {
  if (!p) return null;
  const chess = RulesEngine.create(p.fen);
  const opponent = applyUci(chess, p.movesUci[0]);
  return {
    id: p.id,
    rating: p.rating,
    ratingDeviation: p.ratingDeviation,
    popularity: p.popularity,
    nbPlays: p.nbPlays,
    themes: p.themes,
    gameUrl: p.gameUrl,
    openingTags: p.openingTags,
    initialFen: p.fen,
    opponentMove: opponent ? { uci: p.movesUci[0], san: opponent.san } : null,
    fen: chess.fen(),
    solverColor: chess.turn() === 'w' ? 'white' : 'black',
    solutionLength: Math.ceil((p.movesUci.length - 1) / 2)
  };
}

/**
 * Replays the puzzle up to the solver's `prefix` (their committed moves, UCI)
 * and checks each one against the solution. Returns { chess, expected, index }
 * where `expected` is the next solution move for the solver, or an {error}.
 */
function replayPrefix(p, prefix) {
  const chess = RulesEngine.create(p.fen);
  if (!applyUci(chess, p.movesUci[0])) return { error: 'puzzle data is corrupt' };
  const committed = Array.isArray(prefix) ? prefix.map(String) : [];
  for (let i = 0; i < committed.length; i++) {
    const solutionIndex = 1 + 2 * i;
    const expected = p.movesUci[solutionIndex];
    if (!expected) return { error: 'too many moves for this puzzle' };
    const candidate = normalizeMoveInput(chess, committed[i]);
    if (!candidate) return { error: `move ${i + 1} is not legal` };
    const applied = applyUci(chess, candidate);
    if (!applied) return { error: `move ${i + 1} is not legal` };
    if (candidate !== expected && !chess.isCheckmate()) return { error: `move ${i + 1} is not the solution` };
    if (chess.isCheckmate()) return { chess, expected: null, index: solutionIndex, complete: true, committed: committed.slice(0, i + 1) };
    const reply = p.movesUci[solutionIndex + 1];
    if (reply && !applyUci(chess, reply)) return { error: 'puzzle data is corrupt' };
  }
  const nextIndex = 1 + 2 * committed.length;
  return { chess, expected: p.movesUci[nextIndex] || null, index: nextIndex, complete: !p.movesUci[nextIndex], committed };
}

function solutionOf(p) {
  return { uci: p.movesUci.slice(), san: p.moves.slice() };
}

function recentPuzzleIds(playerId) {
  const store = PuzzleService.getStore();
  if (!store || typeof store.listPuzzleAttempts !== 'function') return [];
  return store.listPuzzleAttempts(playerId, { limit: RECENT_EXCLUDE }).map(a => a.puzzleId);
}

function solverView(playerId) {
  const solver = ratingStore.getSolver(playerId);
  return { rating: Math.round(solver.rating), rd: Math.round(solver.rd), provisional: solver.rd > 110 };
}

function reviewKey(playerId, puzzleId) {
  return `${playerId}/${puzzleId}`;
}

function toDailyDate(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function dailyPuzzle(now = Date.now()) {
  const date = toDailyDate(now);
  if (dailyCache.date === date && dailyCache.puzzle) return dailyCache.puzzle;
  const ids = PuzzleService.listPuzzleIds().map(id => ({ id }));
  const pick = DailyPuzzle.dailyPuzzleFor(date, ids);
  const puzzle = pick ? PuzzleService.getPuzzle(pick.id) : null;
  dailyCache = { date, puzzle };
  return puzzle;
}

function performanceOf(attempts) {
  if (attempts.length === 0) return null;
  const rated = attempts.filter(a => Number.isFinite(a.puzzleRating));
  if (rated.length === 0) return null;
  const avg = rated.reduce((s, a) => s + a.puzzleRating, 0) / rated.length;
  const winRate = rated.filter(a => a.win).length / rated.length;
  return Math.round(avg + (winRate - 0.5) * 400);
}

function summarize(attempts) {
  const wins = attempts.filter(a => a.win).length;
  return {
    nb: attempts.length,
    wins,
    losses: attempts.length - wins,
    winRate: attempts.length ? Math.round((wins / attempts.length) * 1000) / 10 : null,
    performance: performanceOf(attempts)
  };
}

// ---------------------------------------------------------------------------
// Storm
// ---------------------------------------------------------------------------
function pruneStorms(now) {
  for (const [id, s] of stormSessions) {
    if (now - s.createdAt > STORM_TTL_MS) stormSessions.delete(id);
  }
}

function stormPool(seed) {
  // Deterministic pool for a seed: pick STORM_POOL_SIZE ids from the sorted
  // id list with the storm RNG, then hydrate. Same seed → same pool → same run.
  const ids = PuzzleService.listPuzzleIds();
  if (ids.length === 0) return [];
  const rng = PuzzleStorm.createSeededRng(`pool:${seed}`);
  const chosen = new Set();
  const target = Math.min(STORM_POOL_SIZE, ids.length);
  let guard = 0;
  while (chosen.size < target && guard++ < target * 20) {
    chosen.add(ids[Math.floor(rng() * ids.length)]);
  }
  return Array.from(chosen).map(id => PuzzleService.getPuzzle(id)).filter(Boolean);
}

function stormState(entry, now) {
  const s = entry.session;
  return {
    sessionId: entry.id,
    seed: entry.seed,
    status: s.isComplete(now) ? 'complete' : 'active',
    timeRemaining: Math.round(s.timeRemaining(now) * 10) / 10,
    durationSec: s.durationSec,
    solved: s.solved,
    failed: s.failed,
    streak: s.streak,
    bestStreak: s.bestStreak,
    difficulty: Math.round(s.difficulty),
    score: s.solved,
    puzzle: s.activePuzzle && !s.isComplete(now) ? presentPuzzle(s.activePuzzle) : null
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
/**
 * @returns {boolean} true when the request was handled (response sent or pending)
 */
function handlePuzzleRoute(req, res, urlPath, ctx) {
  if (!urlPath.startsWith('/api/puzzle/') && urlPath !== '/api/puzzle') return false;
  const { sendJson, sendJsonError, readJsonBody } = ctx;
  ensureStore(ctx);
  const query = parseQuery(req);
  const now = Date.now();
  const rest = urlPath.slice('/api/puzzle/'.length).replace(/\/+$/, '');
  const segments = rest.split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch (_) { return s; } });

  const respondNoData = () => sendJsonError(res, 503, 'no puzzles loaded — run: node scripts/import-puzzles.mjs data/puzzles-sample.csv');

  // ---- GET /api/puzzle/themes ----
  if (req.method === 'GET' && segments[0] === 'themes' && segments.length === 1) {
    const counts = PuzzleService.listThemes();
    const themes = counts.map(t => ({ key: t.theme, label: THEME_LABELS[t.theme] || t.theme.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()), count: t.count }));
    sendJson(res, 200, { ok: true, total: PuzzleService.puzzleCount(), themes: [{ key: 'mix', label: THEME_LABELS.mix, count: PuzzleService.puzzleCount() }, ...themes] });
    return true;
  }

  // ---- GET /api/puzzle/daily ----
  if (req.method === 'GET' && segments[0] === 'daily' && segments.length === 1) {
    const puzzle = dailyPuzzle(now);
    if (!puzzle) { respondNoData(); return true; }
    const player = playerIdFor(req, res, ctx);
    const attempts = PuzzleService.getStore() ? PuzzleService.getStore().listPuzzleAttempts(player.id, { since: 0, limit: 1000 }) : [];
    const todays = attempts.find(a => a.puzzleId === puzzle.id && toDailyDate(a.createdAt) === toDailyDate(now));
    sendJson(res, 200, { ok: true, date: toDailyDate(now), puzzle: presentPuzzle(puzzle), player: solverView(player.id), alreadyPlayed: todays ? { win: todays.win } : null });
    return true;
  }

  // ---- GET /api/puzzle/next?theme=&rating= ----
  if (req.method === 'GET' && segments[0] === 'next' && segments.length === 1) {
    if (PuzzleService.puzzleCount() === 0) { respondNoData(); return true; }
    const player = playerIdFor(req, res, ctx);
    const theme = query.get('theme') && query.get('theme') !== 'mix' ? String(query.get('theme')).slice(0, 40) : undefined;
    const requested = Number(query.get('rating'));
    const solver = solverView(player.id);
    const rating = Number.isFinite(requested) && requested > 0 ? requested : solver.rating;
    const exclude = recentPuzzleIds(player.id);
    let puzzle = PuzzleService.pickNearRating(rating, { theme, excludeIds: exclude });
    if (!puzzle) puzzle = PuzzleService.pickNearRating(rating, { theme });
    if (!puzzle) { sendJsonError(res, 404, theme ? `no puzzles for theme "${theme}"` : 'no puzzles available'); return true; }
    sendJson(res, 200, { ok: true, puzzle: presentPuzzle(puzzle), player: solver, theme: theme || 'mix', targetRating: Math.round(rating) });
    return true;
  }

  // ---- GET /api/puzzle/batch/:theme?nb= ----
  if (req.method === 'GET' && segments[0] === 'batch' && segments.length === 2) {
    const theme = segments[1] === 'mix' ? undefined : segments[1].slice(0, 40);
    const nb = Math.min(MAX_BATCH, Math.max(1, Number(query.get('nb')) || 15));
    const requested = Number(query.get('rating'));
    const options = { theme, random: true, limit: nb };
    if (Number.isFinite(requested) && requested > 0) { options.minRating = requested - 300; options.maxRating = requested + 300; }
    let puzzles = PuzzleService.listPuzzles(options);
    if (puzzles.length === 0 && options.minRating != null) puzzles = PuzzleService.listPuzzles({ theme, random: true, limit: nb });
    sendJson(res, 200, { ok: true, theme: segments[1], puzzles: puzzles.map(presentPuzzle) });
    return true;
  }

  // ---- GET /api/puzzle/dashboard/:days ----
  if (req.method === 'GET' && segments[0] === 'dashboard' && segments.length === 2) {
    const days = Math.min(3650, Math.max(1, Number(segments[1]) || 30));
    const player = playerIdFor(req, res, ctx);
    const store = PuzzleService.getStore();
    const attempts = store ? store.listPuzzleAttempts(player.id, { since: now - days * 86400000, limit: 5000 }) : [];
    const rated = attempts.filter(a => a.mode === 'rated' || a.mode === 'daily' || a.mode === 'review' || a.mode === 'custom');
    const byTheme = new Map();
    for (const a of rated) {
      for (const t of String(a.themes || '').split(/\s+/)) {
        if (!t) continue;
        if (!byTheme.has(t)) byTheme.set(t, []);
        byTheme.get(t).push(a);
      }
    }
    const themes = Array.from(byTheme.entries())
      .map(([theme, list]) => ({ theme, label: THEME_LABELS[theme] || theme, ...summarize(list) }))
      .sort((a, b) => b.nb - a.nb || a.theme.localeCompare(b.theme));
    const eligible = themes.filter(t => t.nb >= 3);
    sendJson(res, 200, {
      ok: true,
      days,
      player: { ...solverView(player.id), authenticated: player.authenticated, username: player.username },
      global: summarize(rated),
      themes,
      strengths: eligible.slice().sort((a, b) => b.winRate - a.winRate || b.nb - a.nb).slice(0, 5),
      weaknesses: eligible.slice().sort((a, b) => a.winRate - b.winRate || b.nb - a.nb).slice(0, 5),
      recent: attempts.slice(0, 20).map(a => ({ puzzleId: a.puzzleId, win: a.win, timeMs: a.timeMs, puzzleRating: a.puzzleRating, ratingAfter: a.ratingAfter == null ? null : Math.round(a.ratingAfter), mode: a.mode, at: a.createdAt }))
    });
    return true;
  }

  // ---- GET /api/puzzle/review ----
  if (req.method === 'GET' && segments[0] === 'review' && segments.length === 1) {
    const player = playerIdFor(req, res, ctx);
    const store = PuzzleService.getStore();
    const prefix = reviewKey(player.id, '');
    const records = store ? store.listPuzzleReviews(prefix) : [];
    const hydrate = r => {
      const puzzleId = String(r.puzzleId).slice(prefix.length);
      const puzzle = PuzzleService.getPuzzle(puzzleId);
      return puzzle ? { puzzle: presentPuzzle(puzzle), schedule: { nextDueAt: r.nextDueAt, intervalDays: r.intervalDays, step: r.step, reviewCount: r.reviewCount, correctStreak: r.correctStreak, lastReviewedAt: r.lastReviewedAt } } : null;
    };
    const due = PuzzleRepetition.getDueReviews(records.map(r => ({ ...r, schedule: r })), now).map(hydrate).filter(Boolean);
    const upcoming = records.filter(r => r.nextDueAt > now).map(hydrate).filter(Boolean).slice(0, 20);
    sendJson(res, 200, { ok: true, now, due, upcoming, counts: { due: due.length, upcoming: records.length - due.length }, intervals: PuzzleRepetition.DEFAULT_INTERVALS });
    return true;
  }

  // ---- GET /api/puzzle/storm/start?seed= ----
  if (req.method === 'GET' && segments[0] === 'storm' && segments[1] === 'start' && segments.length === 2) {
    if (PuzzleService.puzzleCount() === 0) { respondNoData(); return true; }
    pruneStorms(now);
    const player = playerIdFor(req, res, ctx);
    const seed = query.get('seed') ? String(query.get('seed')).slice(0, 64) : `${player.id}:${now}`;
    const duration = Math.min(600, Math.max(10, Number(query.get('duration')) || PuzzleStorm.DEFAULT_DURATION_SEC));
    const memoryRatings = new PuzzleRating.PuzzleRatingStore({ archive: null });
    const solver = ratingStore.getSolver(player.id);
    memoryRatings._save('solver', { id: player.id, rating: solver.rating, rd: solver.rd, vol: solver.vol });
    const session = PuzzleStorm.startSession({
      seed,
      solverId: player.id,
      puzzles: stormPool(seed),
      ratingStore: memoryRatings,
      durationSec: duration,
      now
    });
    const id = crypto.randomBytes(9).toString('base64url');
    const entry = { id, seed, session, player: player.id, createdAt: now, puzzleStartedAt: now };
    stormSessions.set(id, entry);
    sendJson(res, 200, { ok: true, storm: stormState(entry, now) });
    return true;
  }

  // ---- POST /api/puzzle/storm/result ----
  if (req.method === 'POST' && segments[0] === 'storm' && segments[1] === 'result' && segments.length === 2) {
    readJsonBody(req).then(body => {
      if (!body || typeof body !== 'object') { sendJsonError(res, 400, 'invalid request body'); return; }
      const entry = stormSessions.get(String(body.sessionId || ''));
      if (!entry) { sendJsonError(res, 404, 'storm session not found or expired'); return; }
      const player = playerIdFor(req, res, ctx);
      if (entry.player !== player.id) { sendJsonError(res, 403, 'not your storm session'); return; }
      const result = body.result === 'solved' ? 'solved' : (body.result === 'failed' ? 'failed' : null);
      if (!result) { sendJsonError(res, 400, "result must be 'solved' or 'failed'"); return; }
      const active = entry.session.activePuzzle;
      if (!active) { sendJson(res, 200, { ok: true, storm: stormState(entry, Date.now()), recorded: false }); return; }
      if (body.puzzleId && String(body.puzzleId) !== String(active.id)) { sendJsonError(res, 409, 'puzzleId does not match the active storm puzzle'); return; }
      // A claimed solve must carry the full validated line; the server re-checks it.
      if (result === 'solved') {
        const replay = replayPrefix(active, Array.isArray(body.moves) ? body.moves : []);
        if (replay.error || !replay.complete) { sendJsonError(res, 400, replay.error || 'solution incomplete'); return; }
      }
      const t = Date.now();
      const timeSec = Math.max(0, Number(body.timeMs) || (t - entry.puzzleStartedAt)) / 1000;
      const outcome = entry.session.recordResult(result, timeSec, t);
      entry.puzzleStartedAt = t;
      const store = PuzzleService.getStore();
      if (store) {
        store.savePuzzleAttempt({ playerId: player.id, puzzleId: active.id, win: result === 'solved', timeMs: Math.round(timeSec * 1000), themes: active.themes.join(' '), puzzleRating: active.rating, ratingAfter: null, mode: 'storm', createdAt: t });
      }
      const state = stormState(entry, t);
      sendJson(res, 200, { ok: true, recorded: true, timeUp: !!outcome.timeUp, solution: solutionOf(active), storm: state, summary: state.status === 'complete' ? entry.session.finalize(t) : null });
    }).catch(() => sendJsonError(res, 413, 'request body too large'));
    return true;
  }

  // ---- /api/puzzle/:id[/try|/solve] ----
  const puzzleId = segments[0];
  if (!puzzleId || puzzleId.length > 64) { sendJsonError(res, 404, 'not found'); return true; }
  const puzzle = PuzzleService.getPuzzle(puzzleId);
  if (!puzzle) { sendJsonError(res, 404, 'puzzle not found'); return true; }

  if (req.method === 'GET' && segments.length === 1) {
    const player = playerIdFor(req, res, ctx);
    sendJson(res, 200, { ok: true, puzzle: presentPuzzle(puzzle), player: solverView(player.id) });
    return true;
  }

  if (req.method === 'POST' && segments[1] === 'try' && segments.length === 2) {
    readJsonBody(req).then(body => {
      if (!body || typeof body !== 'object') { sendJsonError(res, 400, 'invalid request body'); return; }
      const replay = replayPrefix(puzzle, Array.isArray(body.moves) ? body.moves : []);
      if (replay.error) { sendJsonError(res, 400, replay.error); return; }
      if (replay.complete) { sendJson(res, 200, { ok: true, correct: true, complete: true, alreadyComplete: true, fen: replay.chess.fen(), solution: solutionOf(puzzle) }); return; }
      const chess = replay.chess;
      const candidate = normalizeMoveInput(chess, body.move);
      if (!candidate) { sendJson(res, 200, { ok: true, legal: false, correct: false, complete: false, fen: chess.fen() }); return; }
      const applied = applyUci(chess, candidate);
      if (!applied) { sendJson(res, 200, { ok: true, legal: false, correct: false, complete: false, fen: chess.fen() }); return; }
      const isExpected = candidate === replay.expected;
      const isAlternateMate = !isExpected && chess.isCheckmate();
      if (!isExpected && !isAlternateMate) {
        sendJson(res, 200, { ok: true, legal: true, correct: false, complete: false, move: { uci: candidate, san: applied.san }, fen: replay.chess.fen(), remaining: puzzle.movesUci.length - replay.index });
        return;
      }
      const moves = replay.committed.concat([candidate]);
      let reply = null;
      let complete = true;
      if (!isAlternateMate) {
        const replyUci = puzzle.movesUci[replay.index + 1];
        if (replyUci) {
          const r = applyUci(chess, replyUci);
          reply = r ? { uci: replyUci, san: r.san } : null;
          complete = false;
        }
      }
      sendJson(res, 200, {
        ok: true, legal: true, correct: true, complete, alternateMate: isAlternateMate,
        move: { uci: candidate, san: applied.san }, reply, fen: chess.fen(), moves,
        solution: complete ? solutionOf(puzzle) : undefined
      });
    }).catch(() => sendJsonError(res, 413, 'request body too large'));
    return true;
  }

  if (req.method === 'POST' && segments[1] === 'solve' && segments.length === 2) {
    readJsonBody(req).then(body => {
      if (!body || typeof body !== 'object') { sendJsonError(res, 400, 'invalid request body'); return; }
      const player = playerIdFor(req, res, ctx);
      const store = PuzzleService.getStore();
      const claimedWin = body.win === true || body.win === 1 || body.win === 'true';
      const moves = Array.isArray(body.moves) ? body.moves : [];
      if (claimedWin) {
        const replay = replayPrefix(puzzle, moves);
        if (replay.error) { sendJsonError(res, 400, `solve rejected: ${replay.error}`); return; }
        if (!replay.complete) { sendJsonError(res, 400, 'solve rejected: solution incomplete'); return; }
      }
      const mode = ['rated', 'daily', 'custom', 'review', 'unrated'].includes(body.mode) ? body.mode : 'rated';
      const timeMs = Math.max(0, Math.min(3600000, Math.round(Number(body.timeMs) || 0)));
      const before = ratingStore.getSolver(player.id);
      let ratingUpdate = null;
      if (mode !== 'unrated') {
        ratingUpdate = ratingStore.recordSolve(puzzle, claimedWin ? 'solved' : 'failed', timeMs / 1000, player.id);
      }
      const after = ratingUpdate ? ratingUpdate.solver : before;

      // Spaced repetition: failures enter the queue; anything already queued is rescheduled.
      const key = reviewKey(player.id, puzzle.id);
      const existing = store ? store.getPuzzleReview(key) : null;
      let review = null;
      if (!claimedWin || existing) {
        review = PuzzleRepetition.scheduleReview(key, { now: Date.now(), wasCorrect: claimedWin, existing });
        if (store) store.savePuzzleReview(review);
      }
      if (store) {
        store.savePuzzleAttempt({ playerId: player.id, puzzleId: puzzle.id, win: claimedWin, timeMs, themes: puzzle.themes.join(' '), puzzleRating: puzzle.rating, ratingAfter: after.rating, mode, createdAt: Date.now() });
      }
      sendJson(res, 200, {
        ok: true,
        win: claimedWin,
        mode,
        rating: { before: Math.round(before.rating), after: Math.round(after.rating), delta: Math.round(after.rating) - Math.round(before.rating), rd: Math.round(after.rd), provisional: after.rd > 110 },
        puzzleRating: ratingUpdate ? Math.round(ratingUpdate.puzzle.rating) : puzzle.rating,
        solution: solutionOf(puzzle),
        review: review ? { nextDueAt: review.nextDueAt, intervalDays: review.intervalDays, step: review.step, reviewCount: review.reviewCount } : null
      });
    }).catch(() => sendJsonError(res, 413, 'request body too large'));
    return true;
  }

  sendJsonError(res, 404, 'not found');
  return true;
}

module.exports = {
  handlePuzzleRoute,
  presentPuzzle,
  replayPrefix,
  normalizeMoveInput,
  resetForTests,
  THEME_LABELS
};
