'use strict';

/**
 * insights.js — Wave 3 (roadmap N3.15): metric × dimension × filter over a
 * player's archived games. Pure computation; the archive is read-only here.
 *
 * WHAT THE ARCHIVE CAN ANSWER (games table: id, white, black, date, result,
 * eco, pgn, moves, created_at — nothing else), so every number here is real:
 *   results   W/D/L % from the player's side when it is known, else from
 *             White's side (each bucket reports `perspective`).
 *   acpl      average centipawn loss via acpl.js over an eval history. Evals
 *             are never stored per game; they come from the archive's
 *             eval_cache (FEN-keyed). Games without cached evals are skipped
 *             and reported in `coverage`. computeMissingEvals() fills the cache
 *             with engine-server.js at low depth, bounded by a ply budget.
 *   length    average plies / full moves.
 *   moveTime  UNAVAILABLE: the archive stores no per-move times. Listed in the
 *             catalogue with available:false and never synthesised.
 *   ratingGain UNAVAILABLE: ratings_pool keeps one current row per pool, no
 *             history. Same treatment.
 * Dimensions: all, colour, phase (acpl only: opening/middlegame/endgame per
 * acpl.js PHASE_BOUNDARY_MOVES), opening (stored ECO; name via
 * openings-explorer when loaded), timeControl (PGN [TimeControl] tag, else
 * unknown), method (mate | draw | other — buildPgn writes no [Termination]
 * tag, so resign vs flag is indistinguishable; imported PGNs with the tag are
 * honoured), weekday and hour (UTC, from created_at).
 * Filters: from/to (date or ms), color, tc, opponent (human/bot/unknown).
 *
 * Player binding: archived games are not yet bound to an account (Worker C is
 * adding owner_id). loadGames() honours an injected selectGames(playerId) or
 * an `owner_id` column when present (scope:'player'); otherwise it returns the
 * whole archive labelled scope:'archive'. The player's side comes from an
 * `owner_color` column, else a username match on white/black, else 'unknown'.
 */

const Acpl = require('./acpl.js');

let ChessCtor = null;
try { ChessCtor = require('chess.js').Chess; } catch (_) { ChessCtor = null; }
let Explorer = null;
try { Explorer = require('./openings-explorer.js'); } catch (_) { Explorer = null; }

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PHASES = ['opening', 'middlegame', 'endgame'];
const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const MAX_GAMES_DEFAULT = 500;

const METRICS = {
  results: { id: 'results', label: 'Results (W/D/L %)', unit: '%', available: true, dimensions: ['all', 'colour', 'opening', 'timeControl', 'method', 'weekday', 'hour'] },
  acpl: { id: 'acpl', label: 'Average centipawn loss', unit: 'cp', available: true, dimensions: ['all', 'colour', 'phase', 'opening', 'timeControl', 'method', 'weekday', 'hour'] },
  length: { id: 'length', label: 'Game length (plies)', unit: 'plies', available: true, dimensions: ['all', 'colour', 'opening', 'timeControl', 'method', 'weekday', 'hour'] },
  moveTime: { id: 'moveTime', label: 'Average move time', unit: 's', available: false, reason: 'the archive stores no per-move times', dimensions: [] },
  ratingGain: { id: 'ratingGain', label: 'Rating gain', unit: 'pts', available: false, reason: 'ratings_pool keeps only the current rating per pool, no history', dimensions: [] }
};

const DIMENSIONS = {
  all: { id: 'all', label: 'All games' },
  colour: { id: 'colour', label: 'Colour' },
  phase: { id: 'phase', label: 'Game phase', metrics: ['acpl'] },
  opening: { id: 'opening', label: 'Opening (ECO)' },
  timeControl: { id: 'timeControl', label: 'Time control' },
  method: { id: 'method', label: 'Result method' },
  weekday: { id: 'weekday', label: 'Day of week (UTC)' },
  hour: { id: 'hour', label: 'Hour of day (UTC)' }
};

const FILTERS = {
  from: { id: 'from', label: 'From date', type: 'date' },
  to: { id: 'to', label: 'To date', type: 'date' },
  color: { id: 'color', label: 'Colour', type: 'enum', values: ['white', 'black'] },
  tc: { id: 'tc', label: 'Time control', type: 'string' },
  opponent: { id: 'opponent', label: 'Opponent type', type: 'enum', values: ['human', 'bot'] }
};

function catalogue() {
  return {
    metrics: Object.values(METRICS),
    dimensions: Object.values(DIMENSIONS),
    filters: Object.values(FILTERS)
  };
}

// ---------------------------------------------------------------------------
// Normalisation of an archive row into an insight record
// ---------------------------------------------------------------------------
function parsePgnTags(pgn) {
  const tags = {};
  if (typeof pgn !== 'string') return tags;
  const re = /^\[(\w+)\s+"([^"]*)"\]/gm;
  let m;
  while ((m = re.exec(pgn))) tags[m[1]] = m[2];
  return tags;
}

function sanMovesFromPgn(pgn) {
  if (typeof pgn !== 'string') return [];
  const body = pgn.replace(/^\[.*\]\s*$/gm, '').replace(/\{[^}]*\}/g, '').replace(/;[^\n]*/g, '');
  return body.split(/\s+/)
    .filter(Boolean)
    .filter(tok => !/^\d+\.+$/.test(tok) && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok) && !/^\$\d+$/.test(tok))
    .map(tok => tok.replace(/^\d+\.+/, ''))
    .filter(Boolean);
}

function normalizeResult(result) {
  const v = String(result == null ? '' : result).trim();
  if (v.startsWith('1-0')) return '1-0';
  if (v.startsWith('0-1')) return '0-1';
  if (v.startsWith('1/2') || v.startsWith('½')) return '1/2-1/2';
  return '*';
}

function isBotName(name) {
  return /stockfish|computer|\bbot\b|engine|maia|level\s*\d/i.test(String(name || ''));
}

/**
 * Build a record from an archive row. `ctx` may carry { playerId, username,
 * playerSideFor(game, playerId) }.
 */
function normalizeGame(row, ctx = {}) {
  if (!row || typeof row !== 'object') return null;
  const tags = parsePgnTags(row.pgn);
  const movesStr = typeof row.moves === 'string' ? row.moves.trim() : Array.isArray(row.moves) ? row.moves.join(' ') : '';
  const split = movesStr ? movesStr.split(/\s+/) : [];
  const uci = split.length && UCI_RE.test(split[0]) ? split : Array.isArray(row.uci) ? row.uci : [];
  const san = split.length && !UCI_RE.test(split[0]) ? split : sanMovesFromPgn(row.pgn);
  const plies = Math.max(uci.length, san.length);
  const result = normalizeResult(row.result || tags.Result);

  // --- player's side
  let color = 'unknown';
  if (typeof ctx.playerSideFor === 'function') {
    const side = ctx.playerSideFor(row, ctx.playerId);
    if (side === 'white' || side === 'black') color = side;
  }
  if (color === 'unknown' && (row.owner_color === 'white' || row.owner_color === 'black')) color = row.owner_color;
  if (color === 'unknown' && row.ownerColor && (row.ownerColor === 'white' || row.ownerColor === 'black')) color = row.ownerColor;
  if (color === 'unknown' && ctx.username) {
    const u = String(ctx.username).toLowerCase();
    const w = String(row.white || '').toLowerCase();
    const b = String(row.black || '').toLowerCase();
    if (w === u && b !== u) color = 'white';
    else if (b === u && w !== u) color = 'black';
  }

  // --- opponent type
  let opponentType = 'unknown';
  if (row.opponent_type === 'human' || row.opponent_type === 'bot') opponentType = row.opponent_type;
  else if (row.opponentType === 'human' || row.opponentType === 'bot') opponentType = row.opponentType;
  else {
    const opp = color === 'white' ? row.black : color === 'black' ? row.white : null;
    if (opp && isBotName(opp)) opponentType = 'bot';
    else if (isBotName(row.white) || isBotName(row.black)) opponentType = 'bot';
  }

  // --- result method
  let method = 'other';
  const term = String(row.termination || tags.Termination || '').toLowerCase();
  const lastSan = san.length ? san[san.length - 1] : '';
  if (result === '1/2-1/2') method = 'draw';
  else if (/#$/.test(lastSan) || /checkmate|mate/.test(term)) method = 'mate';
  else if (/resign/.test(term)) method = 'resign';
  else if (/time|flag|forfeit/.test(term)) method = 'flag';
  else if (result === '*') method = 'unfinished';

  const timeControl = String(row.time_control || row.timeControl || tags.TimeControl || 'unknown').trim() || 'unknown';
  const createdAt = Number(row.created_at || row.createdAt) || null;
  const eco = String(row.eco || tags.ECO || '').trim() || 'unknown';

  return {
    id: row.id,
    createdAt,
    result,
    eco,
    openingName: openingNameFor(uci, eco, tags.Opening),
    plies,
    uci,
    san,
    color,
    opponentType,
    method,
    timeControl,
    evals: Array.isArray(row.evals) ? row.evals : null,
    moveTimes: Array.isArray(row.moveTimes) ? row.moveTimes : null
  };
}

function openingNameFor(uci, eco, tagName) {
  if (tagName) return String(tagName);
  if (Explorer && typeof Explorer.exploreOpening === 'function' && Array.isArray(uci) && uci.length) {
    try {
      const found = Explorer.exploreOpening(uci.slice(0, 20));
      if (found && found.name && found.matchedPlies > 0) return found.name;
    } catch (_) { /* best effort */ }
  }
  return eco && eco !== 'unknown' ? eco : 'Unknown opening';
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------
function parseDateMs(value, endOfDay) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value;
  const s = String(value).trim();
  if (/^\d{10,}$/.test(s)) return Number(s);
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + (endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z') : s);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function applyFilters(games, filters = {}) {
  const from = parseDateMs(filters.from, false);
  const to = parseDateMs(filters.to, true);
  const color = filters.color === 'white' || filters.color === 'black' ? filters.color : null;
  const tc = filters.tc ? String(filters.tc).trim().toLowerCase() : null;
  const opponent = filters.opponent === 'human' || filters.opponent === 'bot' || filters.opponent === 'unknown' ? filters.opponent : null;
  return games.filter(g => {
    if (from !== null && (g.createdAt === null || g.createdAt < from)) return false;
    if (to !== null && (g.createdAt === null || g.createdAt > to)) return false;
    if (color && g.color !== color) return false;
    if (tc && String(g.timeControl).toLowerCase() !== tc) return false;
    if (opponent && g.opponentType !== opponent) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Per-game derived values
// ---------------------------------------------------------------------------
function outcomeFor(game) {
  const side = game.color === 'black' ? 'black' : 'white';
  const perspective = game.color === 'unknown' ? 'white' : 'player';
  let outcome = null;
  if (game.result === '1/2-1/2') outcome = 'draw';
  else if (game.result === '1-0') outcome = side === 'white' ? 'win' : 'loss';
  else if (game.result === '0-1') outcome = side === 'black' ? 'win' : 'loss';
  return { outcome, perspective };
}

function acplFor(game) {
  if (!Array.isArray(game.evals) || game.evals.length < 2) return null;
  const moves = game.uci.length ? game.uci : game.san;
  const all = Acpl.computeAcpl(game.evals, moves);
  if (!all.plies) return null;
  const side = game.color === 'white' ? all.white : game.color === 'black' ? all.black : all.overall;
  return { value: side, phases: Acpl.phaseAcpl(game.evals, moves), perspective: game.color === 'unknown' ? 'both' : 'player' };
}

function bucketKeyFor(game, dimension) {
  switch (dimension) {
    case 'all': return { key: 'all', label: 'All games', order: 0 };
    case 'colour': return { key: game.color, label: game.color === 'unknown' ? 'Unknown side' : game.color[0].toUpperCase() + game.color.slice(1), order: game.color === 'white' ? 0 : game.color === 'black' ? 1 : 2 };
    case 'opening': return { key: game.eco, label: game.openingName === game.eco ? game.eco : `${game.eco} ${game.openingName}`.trim(), order: null };
    case 'timeControl': return { key: game.timeControl, label: game.timeControl, order: null };
    case 'method': return { key: game.method, label: game.method[0].toUpperCase() + game.method.slice(1), order: null };
    case 'weekday': {
      if (game.createdAt === null) return { key: 'unknown', label: 'Unknown', order: 99 };
      const d = new Date(game.createdAt).getUTCDay();
      return { key: WEEKDAYS[d], label: WEEKDAYS[d], order: d };
    }
    case 'hour': {
      if (game.createdAt === null) return { key: 'unknown', label: 'Unknown', order: 99 };
      const h = new Date(game.createdAt).getUTCHours();
      return { key: String(h).padStart(2, '0'), label: `${String(h).padStart(2, '0')}:00`, order: h };
    }
    default: return null;
  }
}

function round1(n) { return Math.round(n * 10) / 10; }
function pct(n, d) { return d ? Math.round((n / d) * 1000) / 10 : 0; }

// ---------------------------------------------------------------------------
// computeInsights(games, { metric, dimension, filters })
// ---------------------------------------------------------------------------
function computeInsights(input, options = {}) {
  const metric = options.metric || 'results';
  const dimension = options.dimension || 'all';
  const filters = options.filters || {};
  const def = METRICS[metric];
  if (!def) return { ok: false, error: `unknown metric '${metric}'`, metric, dimension };
  if (!def.available) return { ok: false, error: `metric '${metric}' is unavailable: ${def.reason}`, metric, dimension, available: false, reason: def.reason };
  if (!DIMENSIONS[dimension]) return { ok: false, error: `unknown dimension '${dimension}'`, metric, dimension };
  if (!def.dimensions.includes(dimension)) return { ok: false, error: `dimension '${dimension}' is not available for metric '${metric}'`, metric, dimension };

  const rows = Array.isArray(input) ? input : [];
  const games = applyFilters(rows.map(g => (g && g.san && g.uci && 'color' in g) ? g : normalizeGame(g, options.ctx || {})).filter(Boolean), filters);
  const unknownColour = games.filter(g => g.color === 'unknown').length;
  const buckets = new Map();
  const ensure = (info) => {
    let b = buckets.get(info.key);
    if (!b) { b = { key: info.key, label: info.label, order: info.order, count: 0, wins: 0, draws: 0, losses: 0, sum: 0, n: 0 }; buckets.set(info.key, b); }
    return b;
  };
  let withEvals = 0;

  if (dimension === 'phase') {
    for (const p of PHASES) ensure({ key: p, label: p[0].toUpperCase() + p.slice(1), order: PHASES.indexOf(p) });
    for (const g of games) {
      const a = acplFor(g);
      if (!a) continue;
      withEvals++;
      for (const p of PHASES) {
        const ph = a.phases[p];
        if (!ph || !ph.plies) continue;
        const v = g.color === 'white' ? ph.white : g.color === 'black' ? ph.black : ph.overall;
        const b = ensure({ key: p, label: p[0].toUpperCase() + p.slice(1), order: PHASES.indexOf(p) });
        b.count++; b.sum += v; b.n++;
      }
    }
  } else {
    for (const g of games) {
      const info = bucketKeyFor(g, dimension);
      if (!info) continue;
      if (metric === 'results') {
        const o = outcomeFor(g);
        if (!o.outcome) continue;
        const b = ensure(info);
        b.count++;
        if (o.outcome === 'win') b.wins++; else if (o.outcome === 'draw') b.draws++; else b.losses++;
      } else if (metric === 'acpl') {
        const a = acplFor(g);
        if (!a) continue;
        withEvals++;
        const b = ensure(info);
        b.count++; b.sum += a.value; b.n++;
      } else if (metric === 'length') {
        if (!g.plies) continue;
        const b = ensure(info);
        b.count++; b.sum += g.plies; b.n++;
      }
    }
  }

  const out = [...buckets.values()].map(b => {
    const row = { key: b.key, label: b.label, count: b.count };
    if (metric === 'results') {
      row.wins = b.wins; row.draws = b.draws; row.losses = b.losses;
      row.winPct = pct(b.wins, b.count); row.drawPct = pct(b.draws, b.count); row.lossPct = pct(b.losses, b.count);
      row.score = b.count ? round1(((b.wins + 0.5 * b.draws) / b.count) * 100) : 0;
      row.value = row.winPct;
    } else {
      row.value = b.n ? round1(b.sum / b.n) : null;
    }
    row._order = b.order;
    return row;
  });
  out.sort((a, b) => {
    if (a._order !== null && b._order !== null && a._order !== undefined && b._order !== undefined) return a._order - b._order;
    if (b.count !== a.count) return b.count - a.count;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  for (const row of out) delete row._order;

  const result = {
    ok: true,
    metric,
    metricLabel: def.label,
    unit: def.unit,
    dimension,
    dimensionLabel: DIMENSIONS[dimension].label,
    filters: { from: filters.from || null, to: filters.to || null, color: filters.color || null, tc: filters.tc || null, opponent: filters.opponent || null },
    games: games.length,
    unknownColour,
    perspective: unknownColour === 0 ? 'player' : unknownColour === games.length ? 'white' : 'mixed',
    buckets: out
  };
  if (metric === 'acpl') result.coverage = { gamesWithEvals: withEvals, gamesTotal: games.length };
  return result;
}

// ---------------------------------------------------------------------------
// Games loader (read-only over game-archive listGames) + eval-cache glue
// ---------------------------------------------------------------------------
function fensFor(game) {
  if (!ChessCtor) return null;
  try {
    const c = new ChessCtor();
    const fens = [c.fen()];
    const moves = game.uci.length ? game.uci : game.san;
    for (const mv of moves) {
      if (game.uci.length) c.move({ from: mv.slice(0, 2), to: mv.slice(2, 4), promotion: mv[4] || undefined });
      else c.move(mv);
      fens.push(c.fen());
    }
    return fens;
  } catch (_) {
    return null;
  }
}

function cpFromCacheRow(row) {
  if (!row) return null;
  if (typeof row.mate === 'number' && row.mate !== 0) return row.mate > 0 ? 1000 : -1000;
  return typeof row.cp === 'number' ? row.cp : null;
}

/**
 * Attach `evals` (White-perspective centipawns per position) from the archive's
 * eval_cache when EVERY position of the game is cached; otherwise leave null.
 */
function attachCachedEvals(game, archive) {
  if (!archive || typeof archive.getEval !== 'function' || !game || game.evals) return game;
  const fens = fensFor(game);
  if (!fens) return game;
  const evals = [];
  for (const fen of fens) {
    const cp = cpFromCacheRow(archive.getEval(fen));
    if (cp === null) return game;
    evals.push(cp);
  }
  game.evals = evals;
  return game;
}

/**
 * loadGames({ archive, playerId, username, selectGames, limit })
 *   -> { games: [normalised], scope: 'player' | 'archive', total }
 */
function loadGames(deps = {}) {
  const archive = deps.archive;
  const limit = Number(deps.limit) > 0 ? Number(deps.limit) : MAX_GAMES_DEFAULT;
  let rows = [];
  let scope = 'archive';
  if (typeof deps.selectGames === 'function') {
    rows = deps.selectGames(deps.playerId) || [];
    scope = 'player';
  } else if (archive && typeof archive.listGames === 'function') {
    rows = archive.listGames({ limit }) || [];
    if (deps.playerId && rows.some(r => r && Object.prototype.hasOwnProperty.call(r, 'owner_id') && r.owner_id != null)) {
      rows = rows.filter(r => String(r.owner_id) === String(deps.playerId));
      scope = 'player';
    }
  }
  const ctx = { playerId: deps.playerId, username: deps.username, playerSideFor: deps.playerSideFor };
  const games = rows.map(r => normalizeGame(r, ctx)).filter(Boolean);
  if (deps.withEvals !== false) for (const g of games) attachCachedEvals(g, archive);
  return { games, scope, total: games.length };
}

/**
 * computeMissingEvals(games, { archive, engine, maxGames, plyBudget, depth, movetime })
 * Fills eval_cache for the most recent games lacking evals, bounded by a total
 * ply budget so the shared engine queue (bots) is never starved. Async.
 * `engine` defaults to engine-server.js (required lazily, only here).
 */
async function computeMissingEvals(games, opts = {}) {
  const archive = opts.archive;
  if (!archive || typeof archive.saveEval !== 'function') return { analysed: 0, plies: 0, skipped: 'no archive' };
  let engine = opts.engine;
  if (!engine) {
    try { engine = require('./engine-server.js'); } catch (_) { engine = null; }
  }
  if (!engine || typeof engine.analyse !== 'function' || (typeof engine.isAvailable === 'function' && !engine.isAvailable())) {
    return { analysed: 0, plies: 0, skipped: 'engine unavailable' };
  }
  const maxGames = Math.min(Number(opts.maxGames) || 30, 30);
  const depth = Math.min(Number(opts.depth) || 10, 10);
  const movetime = Math.min(Number(opts.movetime) || 150, 150);
  let budget = Math.max(1, Number(opts.plyBudget) || 150);
  let analysed = 0;
  let plies = 0;
  const candidates = games.filter(g => !g.evals && g.plies > 0).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, maxGames);
  for (const game of candidates) {
    const fens = fensFor(game);
    if (!fens) continue;
    if (fens.length > budget) break;
    const evals = [];
    for (let i = 0; i < fens.length; i++) {
      const fen = fens[i];
      let cp = cpFromCacheRow(archive.getEval(fen));
      if (cp === null) {
        const res = await engine.analyse(fen, { depth, movetime });
        const line = res && Array.isArray(res.lines) && res.lines[0];
        if (!line) { cp = 0; } else {
          // UCI scores are from the side to move; store White's perspective.
          const whiteToMove = fen.split(' ')[1] !== 'b';
          const raw = typeof line.mate === 'number' && line.mate !== 0 ? (line.mate > 0 ? 1000 : -1000) : (Number(line.scoreCp) || 0);
          cp = whiteToMove ? raw : -raw;
          archive.saveEval(fen, { cp, depth: line.depth || depth, mate: typeof line.mate === 'number' ? (whiteToMove ? line.mate : -line.mate) : null, bestmove: res.bestMove || null });
        }
        plies++;
        budget--;
      }
      evals.push(cp);
    }
    game.evals = evals;
    analysed++;
    if (budget <= 0) break;
  }
  return { analysed, plies };
}

module.exports = {
  METRICS,
  DIMENSIONS,
  FILTERS,
  WEEKDAYS,
  PHASES,
  catalogue,
  parsePgnTags,
  sanMovesFromPgn,
  normalizeGame,
  applyFilters,
  outcomeFor,
  acplFor,
  computeInsights,
  loadGames,
  attachCachedEvals,
  computeMissingEvals,
  fensFor
};
