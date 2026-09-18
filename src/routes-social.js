'use strict';

/**
 * routes-social.js — Wave 2 (roadmap R2): the identity/competition API.
 *
 * Mounted from server.js with a single line before the /api/ 404 fallthrough:
 *   if (SocialRoutes.handleSocialRoute(req, res, urlPath, ctx)) return;
 *
 * Route table (all mutations require an auth session — cookie chess_session,
 * `Authorization: Bearer`, or `X-Session-Token`):
 *   GET  /api/leaderboard/:tc?limit=N       ranked + provisional players for a pool
 *   GET  /api/ratings/me                    (auth) the caller's rating per pool
 *   GET  /api/lobby/seeks                   open seeks
 *   POST /api/lobby/seek {tc, ratingRange}  (auth) create a seek
 *   POST /api/lobby/seek/cancel {seekId?}   (auth) cancel own seek(s)
 *   POST /api/lobby/accept/:seekId          (auth) accept -> creates room, seats both -> {roomId, color, seatToken}
 *   GET  /api/lobby/mine                    (auth) own open seeks + latest match (room + seat token)
 *   GET  /api/arena                         list arenas
 *   POST /api/arena {name, tc}              (auth) create arena
 *   POST /api/arena/:id/join                (auth) join arena
 *   GET  /api/arena/:id/standings           standings + rounds
 *   GET  /api/social/friends                (auth) mutual follows
 *   GET  /api/social/followers              (auth) followers + following + blocked
 *   GET  /api/social/lookup?username=       find a user id by name
 *   POST /api/social/follow/:userId         (auth)
 *   POST /api/social/unfollow/:userId       (auth)
 *   POST /api/social/block/:userId          (auth)
 *
 * Lobby seeks/pairings live in memory for the server process (they are
 * ephemeral by nature). Arenas and the social graph persist via social-store.js.
 * Nothing here touches board state: rooms are created through
 * referee.getReferee() and the referee's own time-control command.
 */

const crypto = require('crypto');
const Lobby = require('./lobby.js');
const RatingsPool = require('./ratings-pool.js');
const ArenaMod = require('./arena.js');
const SocialGraphMod = require('./social-graph.js');
const SocialStore = require('./social-store.js');
const TimeControl = require('./time-control.js');
const RatingHook = require('./rating-hook.js');

const POOLS = RatingHook.POOLS;
const MAX_LEADERBOARD = 200;
const MATCH_TTL_MS = 15 * 60 * 1000;
const MAX_ARENAS = 200;
const MAX_SEEKS_PER_USER = 3;

// Seek TC shorthand accepted by the lobby form, mapped to time-control presets.
const SEEK_TC_ALIASES = {
  bullet: 'bullet_1_0',
  blitz: 'blitz_3_2',
  rapid: 'rapid_10_15',
  classical: 'classical_60_0'
};

let state = null;

function getState() {
  if (state) return state;
  const store = SocialStore.getDefaultStore();
  const arenas = new Map();
  for (const snap of store.loadArenas()) {
    const rec = rehydrateArena(snap);
    if (rec) arenas.set(rec.id, rec);
  }
  state = {
    store,
    lobby: null,           // created lazily once ratingsStore is known
    seekMeta: new Map(),   // seekId -> { tc, pool }
    pairingSeats: new Map(), // pairingId -> { whiteToken, blackToken, roomId, createdAt }
    graph: new SocialGraphMod.SocialGraph({ backend: store }),
    arenas
  };
  return state;
}

/** Test hook: drop all in-memory state and the default store. */
function resetSocialState() {
  if (state && state.store) { try { state.store.close(); } catch (_) {} }
  state = null;
  SocialStore.resetDefaultStore();
}

function lobbyFor(ctx) {
  const st = getState();
  if (!st.lobby) {
    // Read-only view of the pool store: LobbyStore._ratingFor calls getPlayer,
    // which would otherwise insert a phantom 1500/350 row for every seeker.
    const store = ctx.ratingsStore;
    const readOnly = store && typeof store.peekPlayer === 'function'
      ? { getPlayer: (tc, id) => store.peekPlayer(tc, id) }
      : null;
    st.lobby = Lobby.createLobby({
      ratingsStore: readOnly,
      seed: 'chess-lobby-' + crypto.randomBytes(4).toString('hex')
    });
  }
  return st.lobby;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function parseJson(body) {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return null;
  }
}

function queryOf(req) {
  const idx = req.url.indexOf('?');
  return new URLSearchParams(idx >= 0 ? req.url.slice(idx + 1) : '');
}

function requireAuth(req, res, ctx) {
  const session = ctx.getAuthUser(req);
  if (!session || !session.userId) {
    ctx.sendJsonError(res, 401, 'sign in required');
    return null;
  }
  return { id: String(session.userId), username: String(session.username || session.userId) };
}

/** Resolve a seek `tc` (preset key, alias, or "M+S") to a normalized descriptor + pool. */
function resolveSeekTc(input) {
  let raw = input == null ? 'rapid' : String(input).trim().toLowerCase();
  if (SEEK_TC_ALIASES[raw]) raw = SEEK_TC_ALIASES[raw];
  let args = null;
  if (TimeControl.PRESETS[raw]) {
    args = { preset: raw };
  } else {
    const m = raw.match(/^(\d{1,3})(?:\+(\d{1,3}))?$/);
    if (!m) return null;
    const minutes = Number(m[1]);
    const inc = Number(m[2] || 0);
    if (minutes <= 0 || minutes > 180 || inc > 180) return null;
    args = { baseSeconds: minutes * 60, incrementSeconds: inc, name: `${minutes}+${inc}` };
  }
  const tc = TimeControl.normalize(args);
  const descriptor = {
    preset: tc.preset,
    baseSeconds: tc.baseSeconds,
    incrementSeconds: tc.incrementSeconds,
    name: tc.name
  };
  return { tc: descriptor, pool: RatingHook.poolForTimeControl(descriptor), label: tc.name };
}

function publicUser(ctx, id) {
  const acct = ctx.accountsManager && typeof ctx.accountsManager.getAccountById === 'function'
    ? ctx.accountsManager.getAccountById(id) : null;
  return acct ? { id: String(acct.id), username: acct.username, picture: acct.picture || null } : { id: String(id), username: String(id), picture: null };
}

function ratingSummary(ctx, pool, playerId) {
  const store = ctx.ratingsStore;
  if (!store || typeof store.peekPlayer !== 'function') return null;
  const player = store.peekPlayer(pool, playerId);
  return player ? { rating: Math.round(player.rating), rd: Math.round(player.rd), provisional: player.provisional } : null;
}

function seekView(ctx, seek) {
  const meta = getState().seekMeta.get(seek.id) || {};
  return {
    id: seek.id,
    playerId: seek.playerId,
    username: seek.username,
    rating: Math.round(seek.rating),
    ratingRange: seek.ratingTolerance,
    ratingBand: [Math.round(seek.rating - seek.ratingTolerance), Math.round(seek.rating + seek.ratingTolerance)],
    pool: seek.timeControl,
    tc: meta.tc || null,
    tcLabel: meta.label || seek.timeControl,
    rated: seek.rated,
    status: seek.status,
    createdAt: seek.createdAt,
    roomId: seek.roomId || null
  };
}

function matchFor(ctx, user) {
  const st = getState();
  const lobby = lobbyFor(ctx);
  const pairings = lobby.listPairings({ playerId: user.id });
  const now = Date.now();
  for (let i = pairings.length - 1; i >= 0; i--) {
    const p = pairings[i];
    if (now - p.createdAt > MATCH_TTL_MS) continue;
    const seats = st.pairingSeats.get(p.id);
    if (!seats) continue;
    const color = p.whiteId === user.id ? 'white' : 'black';
    const opponentId = color === 'white' ? p.blackId : p.whiteId;
    return {
      pairingId: p.id,
      roomId: p.roomId,
      color,
      seatToken: color === 'white' ? seats.whiteToken : seats.blackToken,
      opponent: publicUser(ctx, opponentId),
      pool: p.timeControl,
      rated: p.rated,
      createdAt: p.createdAt
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// arenas
// ---------------------------------------------------------------------------
function rehydrateArena(snap) {
  if (!snap || !snap.id) return null;
  const arena = new ArenaMod.Arena({ seed: snap.id });
  arena.players = Array.isArray(snap.players) ? snap.players.slice() : [];
  arena.results = Array.isArray(snap.results) ? snap.results.slice() : [];
  arena.round = Number(snap.round) || 0;
  return {
    id: String(snap.id),
    name: String(snap.name || 'Arena'),
    pool: POOLS.includes(snap.pool) ? snap.pool : 'rapid',
    tc: snap.tc || null,
    createdBy: snap.createdBy || null,
    createdByName: snap.createdByName || null,
    createdAt: Number(snap.createdAt) || Date.now(),
    status: snap.status === 'finished' ? 'finished' : 'open',
    arena
  };
}

function arenaSnapshot(rec) {
  return {
    id: rec.id,
    name: rec.name,
    pool: rec.pool,
    tc: rec.tc,
    createdBy: rec.createdBy,
    createdByName: rec.createdByName,
    createdAt: rec.createdAt,
    status: rec.status,
    players: rec.arena.players,
    results: rec.arena.results,
    round: rec.arena.round
  };
}

function persistArena(rec) {
  try { getState().store.saveArena(rec.id, arenaSnapshot(rec)); } catch (_) { /* best effort */ }
}

function arenaSummary(rec) {
  return {
    id: rec.id,
    name: rec.name,
    pool: rec.pool,
    tcLabel: rec.tc && rec.tc.name ? rec.tc.name : rec.pool,
    createdBy: rec.createdBy,
    createdByName: rec.createdByName,
    createdAt: rec.createdAt,
    status: rec.status,
    playerCount: rec.arena.players.length,
    gamesPlayed: rec.arena.results.length,
    round: rec.arena.round
  };
}

/**
 * Called by rating-hook (via server.js onRated) for every finished game with two
 * signed-in humans: feeds the result into every open arena both players joined.
 */
function onRatedGame(event) {
  try {
    if (!event || !event.rated || !event.white || !event.black) return;
    const score = RatingHook.scoreForWhite(event.result);
    if (score === null) return;
    const result = score === 1 ? '1-0' : score === 0 ? '0-1' : '1/2-1/2';
    const w = event.white.accountId;
    const b = event.black.accountId;
    for (const rec of getState().arenas.values()) {
      if (rec.status !== 'open') continue;
      const ids = rec.arena.players.map(p => p.id);
      if (!ids.includes(w) || !ids.includes(b)) continue;
      if (rec.pool !== event.pool) continue;
      rec.arena.recordResult(w, b, result);
      persistArena(rec);
    }
  } catch (_) { /* observers never break the referee */ }
}

// ---------------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------------
function handleLeaderboard(req, res, ctx, pool) {
  if (!POOLS.includes(pool)) { ctx.sendJsonError(res, 400, 'unknown pool; expected one of ' + POOLS.join(', ')); return; }
  const q = queryOf(req);
  let limit = Number(q.get('limit')) || 50;
  limit = Math.max(1, Math.min(MAX_LEADERBOARD, Math.floor(limit)));
  const store = ctx.ratingsStore;
  let rows = [];
  try { rows = store ? store.getLeaderboard(pool, { includeProvisional: true }) : []; } catch (_) { rows = []; }
  const ranked = rows.filter(r => !r.provisional).slice(0, limit);
  const provisional = rows.filter(r => r.provisional).slice(0, Math.max(0, limit - ranked.length));
  const view = r => ({
    rank: r.rank,
    playerId: r.playerId,
    username: r.username,
    rating: Math.round(r.rating),
    rd: Math.round(r.rd),
    provisional: r.provisional,
    confidence: r.confidence ? [Math.round(r.confidence.low ?? r.confidence[0] ?? 0), Math.round(r.confidence.high ?? r.confidence[1] ?? 0)] : null
  });
  ctx.sendJson(res, 200, { ok: true, pool, pools: POOLS, ranked: ranked.map(view), provisional: provisional.map(view) });
}

function handleRatingsMe(req, res, ctx) {
  const user = requireAuth(req, res, ctx);
  if (!user) return;
  const pools = [];
  for (const pool of POOLS) {
    const summary = ratingSummary(ctx, pool, user.id);
    if (summary) pools.push({ pool, ...summary });
  }
  ctx.sendJson(res, 200, { ok: true, user, pools, allPools: POOLS, provisionalRd: RatingsPool.PROVISIONAL_RD });
}

function handleLobbySeeks(req, res, ctx) {
  const lobby = lobbyFor(ctx);
  const q = queryOf(req);
  const pool = q.get('tc') || q.get('pool');
  const seeks = lobby.listOpenSeeks(pool && POOLS.includes(pool) ? { timeControl: pool } : {});
  ctx.sendJson(res, 200, { ok: true, seeks: seeks.map(s => seekView(ctx, s)), pools: POOLS, presets: Object.keys(TimeControl.PRESETS) });
}

function handleCreateSeek(req, res, ctx) {
  const user = requireAuth(req, res, ctx);
  if (!user) return;
  ctx.readBody(req, ctx.maxBodyBytes).then(body => {
    const parsed = parseJson(body);
    if (!parsed) { ctx.sendJsonError(res, 400, 'invalid json'); return; }
    const resolved = resolveSeekTc(parsed.tc);
    if (!resolved) { ctx.sendJsonError(res, 400, 'invalid time control; use a preset key, a category, or M+S'); return; }
    let range = Number(parsed.ratingRange);
    if (!Number.isFinite(range) || range < 0) range = Lobby.DEFAULT_TOLERANCE;
    range = Math.min(3000, Math.floor(range));
    const lobby = lobbyFor(ctx);
    if (lobby.listOpenSeeks({ playerId: user.id }).length >= MAX_SEEKS_PER_USER) {
      ctx.sendJsonError(res, 409, `at most ${MAX_SEEKS_PER_USER} open seeks per player`);
      return;
    }
    let seek;
    try {
      seek = lobby.createSeek({
        playerId: user.id,
        username: user.username,
        timeControl: resolved.pool,
        ratingTolerance: range,
        rated: parsed.rated !== false
      });
    } catch (err) {
      ctx.sendJsonError(res, err && err.code === 'SEEK_EXISTS' ? 409 : 400, err.message || 'could not create seek');
      return;
    }
    getState().seekMeta.set(seek.id, { tc: resolved.tc, pool: resolved.pool, label: resolved.label });
    ctx.sendJson(res, 201, { ok: true, seek: seekView(ctx, seek) });
  }).catch(() => ctx.sendJsonError(res, 413, 'request body too large'));
}

function handleCancelSeek(req, res, ctx) {
  const user = requireAuth(req, res, ctx);
  if (!user) return;
  ctx.readBody(req, ctx.maxBodyBytes).then(body => {
    const parsed = parseJson(body) || {};
    const lobby = lobbyFor(ctx);
    let cancelled = 0;
    if (parsed.seekId) {
      if (lobby.cancelSeek(String(parsed.seekId), user.id)) cancelled++;
    } else {
      for (const seek of lobby.listOpenSeeks({ playerId: user.id })) {
        if (lobby.cancelSeek(seek.id, user.id)) cancelled++;
      }
    }
    ctx.sendJson(res, 200, { ok: true, cancelled });
  }).catch(() => ctx.sendJsonError(res, 413, 'request body too large'));
}

function handleAcceptSeek(req, res, ctx, seekId) {
  const user = requireAuth(req, res, ctx);
  if (!user) return;
  const st = getState();
  const lobby = lobbyFor(ctx);
  const seek = lobby.getSeek(seekId);
  if (!seek || seek.status !== 'open') { ctx.sendJsonError(res, 404, 'seek not open'); return; }
  if (seek.playerId === user.id) { ctx.sendJsonError(res, 409, 'cannot accept your own seek'); return; }
  if (st.graph.isBlocked(seek.playerId, user.id) || st.graph.isBlocked(user.id, seek.playerId)) {
    ctx.sendJsonError(res, 403, 'this pairing is blocked');
    return;
  }
  const roomId = 'lobby-' + crypto.randomBytes(5).toString('hex');
  if (!ctx.isValidRoomId(roomId)) { ctx.sendJsonError(res, 500, 'room id generation failed'); return; }
  const meta = st.seekMeta.get(seek.id) || resolveSeekTc(seek.timeControl) || resolveSeekTc('rapid');

  const accepted = lobby.acceptSeek(seek.id, user.id, { roomId });
  if (!accepted) { ctx.sendJsonError(res, 409, 'seek no longer available'); return; }
  const pairing = accepted.pairing;

  const ref = ctx.referee.getReferee(roomId);
  if (!ref) { ctx.sendJsonError(res, 500, 'referee unavailable'); return; }
  const whiteAccount = publicUser(ctx, pairing.whiteId);
  const blackAccount = publicUser(ctx, pairing.blackId);
  const whiteClaim = ctx.seatAuth.claimSeat(roomId, 'white', { account: whiteAccount });
  const blackClaim = ctx.seatAuth.claimSeat(roomId, 'black', { account: blackAccount });
  if (!whiteClaim.ok || !blackClaim.ok) { ctx.sendJsonError(res, 500, 'could not seat players'); return; }
  st.pairingSeats.set(pairing.id, { whiteToken: whiteClaim.token, blackToken: blackClaim.token, roomId, createdAt: Date.now() });

  const cmd = { id: 'lobby-tc-' + roomId, type: 'time-control', args: meta.tc };
  ref.enqueue(cmd).then(() => {
    const mine = matchFor(ctx, user);
    ctx.sendJson(res, 201, { ok: true, roomId, color: mine ? mine.color : null, seatToken: mine ? mine.seatToken : null, pool: pairing.timeControl, rated: pairing.rated, opponent: mine ? mine.opponent : null, pairingId: pairing.id });
  }).catch(err => ctx.sendJsonError(res, 500, err && err.message ? err.message : 'time control failed'));
}

function handleLobbyMine(req, res, ctx) {
  const user = requireAuth(req, res, ctx);
  if (!user) return;
  const lobby = lobbyFor(ctx);
  const seeks = lobby.listOpenSeeks({ playerId: user.id }).map(s => seekView(ctx, s));
  ctx.sendJson(res, 200, { ok: true, user, seeks, match: matchFor(ctx, user) });
}

function handleListArenas(req, res, ctx) {
  const list = Array.from(getState().arenas.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(arenaSummary);
  ctx.sendJson(res, 200, { ok: true, arenas: list, pools: POOLS });
}

function handleCreateArena(req, res, ctx) {
  const user = requireAuth(req, res, ctx);
  if (!user) return;
  ctx.readBody(req, ctx.maxBodyBytes).then(body => {
    const parsed = parseJson(body);
    if (!parsed) { ctx.sendJsonError(res, 400, 'invalid json'); return; }
    const name = String(parsed.name || '').trim().slice(0, 60);
    if (!name) { ctx.sendJsonError(res, 400, 'name is required'); return; }
    const resolved = resolveSeekTc(parsed.tc);
    if (!resolved) { ctx.sendJsonError(res, 400, 'invalid time control'); return; }
    const st = getState();
    if (st.arenas.size >= MAX_ARENAS) { ctx.sendJsonError(res, 409, 'too many arenas'); return; }
    const id = 'arena-' + crypto.randomBytes(5).toString('hex');
    const rec = rehydrateArena({
      id, name, pool: resolved.pool, tc: resolved.tc,
      createdBy: user.id, createdByName: user.username, createdAt: Date.now(), status: 'open',
      players: [], results: [], round: 0
    });
    const rating = ratingSummary(ctx, rec.pool, user.id);
    rec.arena.addPlayer(user.id, user.username, rating ? rating.rating : RatingsPool.DEFAULT_RATING);
    st.arenas.set(id, rec);
    persistArena(rec);
    ctx.sendJson(res, 201, { ok: true, arena: arenaSummary(rec) });
  }).catch(() => ctx.sendJsonError(res, 413, 'request body too large'));
}

function handleJoinArena(req, res, ctx, id) {
  const user = requireAuth(req, res, ctx);
  if (!user) return;
  const rec = getState().arenas.get(id);
  if (!rec) { ctx.sendJsonError(res, 404, 'arena not found'); return; }
  if (rec.status !== 'open') { ctx.sendJsonError(res, 409, 'arena is finished'); return; }
  const rating = ratingSummary(ctx, rec.pool, user.id);
  const joined = rec.arena.addPlayer(user.id, user.username, rating ? rating.rating : RatingsPool.DEFAULT_RATING);
  if (joined) persistArena(rec);
  ctx.sendJson(res, 200, { ok: true, joined, arena: arenaSummary(rec) });
}

function handleArenaStandings(req, res, ctx, id) {
  const rec = getState().arenas.get(id);
  if (!rec) { ctx.sendJsonError(res, 404, 'arena not found'); return; }
  const standings = rec.arena.standings().map((row, index) => ({
    rank: index + 1,
    id: row.id,
    name: row.name,
    rating: row.rating,
    score: row.score,
    games: row.games,
    wins: row.wins,
    streak: row.streak,
    buchholz: row.buchholz,
    sonneborn: row.sonneborn
  }));
  ctx.sendJson(res, 200, {
    ok: true,
    arena: arenaSummary(rec),
    standings,
    players: rec.arena.players,
    results: rec.arena.results,
    round: rec.arena.round
  });
}

function handleFriends(req, res, ctx) {
  const user = requireAuth(req, res, ctx);
  if (!user) return;
  const graph = getState().graph;
  ctx.sendJson(res, 200, { ok: true, friends: graph.mutualFriends(user.id).map(id => publicUser(ctx, id)) });
}

function handleFollowers(req, res, ctx) {
  const user = requireAuth(req, res, ctx);
  if (!user) return;
  const graph = getState().graph;
  ctx.sendJson(res, 200, {
    ok: true,
    followers: graph.followersOf(user.id).map(id => publicUser(ctx, id)),
    following: graph.followingOf(user.id).map(id => publicUser(ctx, id)),
    blocked: (graph.blocks[user.id] ? Array.from(graph.blocks[user.id]) : []).map(id => publicUser(ctx, id))
  });
}

function handleLookup(req, res, ctx) {
  const username = (queryOf(req).get('username') || '').trim();
  if (!username) { ctx.sendJsonError(res, 400, 'username is required'); return; }
  const acct = ctx.accountsManager && typeof ctx.accountsManager.getAccount === 'function'
    ? ctx.accountsManager.getAccount(username) : null;
  if (!acct) { ctx.sendJsonError(res, 404, 'user not found'); return; }
  ctx.sendJson(res, 200, { ok: true, user: { id: String(acct.id), username: acct.username, picture: acct.picture || null } });
}

function handleSocialMutation(req, res, ctx, action, targetId) {
  const user = requireAuth(req, res, ctx);
  if (!user) return;
  if (!targetId || targetId === user.id) { ctx.sendJsonError(res, 400, 'invalid target user'); return; }
  const target = ctx.accountsManager && typeof ctx.accountsManager.getAccountById === 'function'
    ? ctx.accountsManager.getAccountById(targetId) : null;
  if (!target) { ctx.sendJsonError(res, 404, 'user not found'); return; }
  const graph = getState().graph;
  let changed = false;
  if (action === 'follow') {
    if (graph.isBlocked(targetId, user.id)) { ctx.sendJsonError(res, 403, 'you are blocked by this user'); return; }
    changed = graph.follow(user.id, targetId);
  } else if (action === 'unfollow') {
    changed = graph.unfollow(user.id, targetId);
  } else if (action === 'block') {
    changed = graph.block(user.id, targetId);
  }
  ctx.sendJson(res, 200, {
    ok: true,
    action,
    changed,
    target: publicUser(ctx, targetId),
    following: graph.isFollowing(user.id, targetId),
    friends: graph.areFriends(user.id, targetId),
    blocked: graph.isBlocked(user.id, targetId)
  });
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function handleSocialRoute(req, res, urlPath, ctx) {
  const method = req.method;
  let m;

  if (method === 'GET' && (m = urlPath.match(/^\/api\/leaderboard\/([a-z]+)$/))) { handleLeaderboard(req, res, ctx, m[1]); return true; }
  if (method === 'GET' && urlPath === '/api/ratings/me') { handleRatingsMe(req, res, ctx); return true; }

  if (method === 'GET' && urlPath === '/api/lobby/seeks') { handleLobbySeeks(req, res, ctx); return true; }
  if (method === 'POST' && urlPath === '/api/lobby/seek') { handleCreateSeek(req, res, ctx); return true; }
  if (method === 'POST' && urlPath === '/api/lobby/seek/cancel') { handleCancelSeek(req, res, ctx); return true; }
  if (method === 'POST' && (m = urlPath.match(/^\/api\/lobby\/accept\/([^/]+)$/))) {
    const id = decodeURIComponent(m[1]);
    if (!ID_RE.test(id)) { ctx.sendJsonError(res, 400, 'invalid seek id'); return true; }
    handleAcceptSeek(req, res, ctx, id); return true;
  }
  if (method === 'GET' && urlPath === '/api/lobby/mine') { handleLobbyMine(req, res, ctx); return true; }

  if (method === 'GET' && urlPath === '/api/arena') { handleListArenas(req, res, ctx); return true; }
  if (method === 'POST' && urlPath === '/api/arena') { handleCreateArena(req, res, ctx); return true; }
  if ((m = urlPath.match(/^\/api\/arena\/([^/]+)\/(join|standings)$/))) {
    const id = decodeURIComponent(m[1]);
    if (!ID_RE.test(id)) { ctx.sendJsonError(res, 400, 'invalid arena id'); return true; }
    if (m[2] === 'join' && method === 'POST') { handleJoinArena(req, res, ctx, id); return true; }
    if (m[2] === 'standings' && method === 'GET') { handleArenaStandings(req, res, ctx, id); return true; }
  }

  if (method === 'GET' && urlPath === '/api/social/friends') { handleFriends(req, res, ctx); return true; }
  if (method === 'GET' && urlPath === '/api/social/followers') { handleFollowers(req, res, ctx); return true; }
  if (method === 'GET' && urlPath === '/api/social/lookup') { handleLookup(req, res, ctx); return true; }
  if (method === 'POST' && (m = urlPath.match(/^\/api\/social\/(follow|unfollow|block)\/([^/]+)$/))) {
    const id = decodeURIComponent(m[2]);
    if (!ID_RE.test(id)) { ctx.sendJsonError(res, 400, 'invalid user id'); return true; }
    handleSocialMutation(req, res, ctx, m[1], id); return true;
  }

  return false;
}

module.exports = {
  handleSocialRoute,
  onRatedGame,
  resetSocialState,
  resolveSeekTc,
  POOLS,
  SEEK_TC_ALIASES
};
