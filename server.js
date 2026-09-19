const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const referee = require('./src/referee-service.js');
const { seatAuthManager } = require('./src/seat-auth.js');
const gameArchive = require('./src/game-archive.js');
const { BotService, BOT_LEVELS } = require('./src/bot-service.js');
const Accounts = require('./src/accounts.js');
const { Chess } = require('chess.js');
const accountsManager = Accounts.getDefaultManager();
const botService = new BotService(seatAuthManager);
const ratingHook = require('./src/rating-hook.js').installRatingHook({ referee, seatAuth: seatAuthManager, archive: gameArchive, isBotRoom: roomId => botService.getBotConfig(roomId).enabled, onRated: event => { SocialRoutes.onRatedGame(event); require('./src/routes-insights.js').onRatedGame(event); }, logger: console }); // Wave 2 R2: rate human-vs-human games on game end
const SocialRoutes = require('./src/routes-social.js');
const RetentionRoutes = require('./src/routes-retention.js'); // Wave 3 N2: loaded at boot so its rating-hook onGameOver listener sees every finished game

const PORT = process.env.PORT ? Number(process.env.PORT) : (process.env.CHESS_PORT ? Number(process.env.CHESS_PORT) : 39281);
const DIR = __dirname;
const STATE_FILE = process.env.CHESS_STATE_FILE || path.join(DIR, '.referee-state.json');
const SSE_HEARTBEAT_MS = Number(process.env.CHESS_SSE_HEARTBEAT_MS) || 15000;
const SSE_WATCH_INTERVAL_MS = Number(process.env.CHESS_SSE_WATCH_INTERVAL_MS) || 250;

const DEFAULT_ALLOWED_ORIGINS = [
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  `http://0.0.0.0:${PORT}`
];

function getAllowedOrigins() {
  if (process.env.CHESS_ALLOWED_ORIGIN) {
    return process.env.CHESS_ALLOWED_ORIGIN.split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }
  return DEFAULT_ALLOWED_ORIGINS;
}

// D1 & P3: Multi-tenant SSE client registry and file watchers per room.
// Each connected client holds its res object and heartbeat timer.
// State broadcast queues are isolated per room so room A events never leak to room B.
const roomSseClients = new Map();
const roomWatchers = new Map();

// M3: per-room monotonic SSE event id + bounded replay log so clients can
// reconnect with Last-Event-ID and recover events they missed while offline.
const SSE_REPLAY_LIMIT = 200;
const roomSseSeq = new Map();          // roomId -> next id to assign
const roomSseLog = new Map();          // roomId -> [{id, event, data}]

function nextSseId(roomId) {
  const cur = roomSseSeq.get(roomId) || 0;
  const next = cur + 1;
  roomSseSeq.set(roomId, next);
  return next;
}

function appendSseEvent(roomId, id, eventName, data) {
  let log = roomSseLog.get(roomId);
  if (!log) {
    log = [];
    roomSseLog.set(roomId, log);
  }
  log.push({ id, event: eventName, data });
  if (log.length > SSE_REPLAY_LIMIT) log.splice(0, log.length - SSE_REPLAY_LIMIT);
}

function extractRoomId(req) {
  let roomId = null;
  try {
    const urlObj = new URL(req.url, 'http://127.0.0.1');
    const param = urlObj.searchParams.get('room');
    if (param) roomId = param;
  } catch (_) {}
  if (!roomId) {
    const header = req.headers['x-room-id'] || req.headers['room'] || req.headers['x-chess-room'];
    if (typeof header === 'string' && header.trim()) {
      roomId = header.trim();
    }
  }
  return roomId || 'default';
}

function isValidRoomId(roomId) {
  return typeof roomId === 'string' && /^[a-zA-Z0-9_-]+$/.test(roomId);
}

function getRoomStateFile(roomId = 'default') {
  return referee.getRoomStateFile(roomId);
}

function computeRoomStateHash(roomId = 'default') {
  try {
    const file = getRoomStateFile(roomId);
    const raw = fs.readFileSync(file, 'utf8');
    return crypto.createHash('sha256').update(raw).digest('hex');
  } catch (e) {
    return '';
  }
}

function readRoomStateJson(roomId = 'default') {
  try {
    const ref = referee.getReferee(roomId);
    if (ref) {
      const flagResult = ref.checkFlagFall();
      if (flagResult && flagResult.flagged) {
        broadcastRoomStateToSSEClients(roomId);
      }
      return ref.getState();
    }
  } catch (_) {}
  const file = getRoomStateFile(roomId);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

// Backward compatibility helpers
function computeStateHash() {
  return computeRoomStateHash('default');
}

function readStateJson() {
  return readRoomStateJson('default');
}

function getClientsForRoom(roomId) {
  if (!roomSseClients.has(roomId)) {
    roomSseClients.set(roomId, new Set());
  }
  return roomSseClients.get(roomId);
}

function broadcastRoomStateToSSEClients(roomId = 'default') {
  const hash = computeRoomStateHash(roomId);
  const watcher = roomWatchers.get(roomId);
  if (watcher && hash && hash === watcher.lastHash) return;
  if (watcher && hash) watcher.lastHash = hash;

  const state = readRoomStateJson(roomId);
  if (!state) return;
  const data = JSON.stringify(state);
  const id = nextSseId(roomId);
  appendSseEvent(roomId, id, 'state', data);
  const clients = roomSseClients.get(roomId);
  if (!clients) return;
  for (const client of Array.from(clients)) {
    try {
      client.res.write(`id: ${id}\nevent: state\ndata: ${data}\n\n`);
    } catch (e) {
      removeRoomSSEClient(roomId, client);
    }
  }
}

function broadcastRoomEventToSSEClients(roomId = 'default', eventName = 'message', payload = {}) {
  const clients = roomSseClients.get(roomId);
  if (!clients) return;
  const data = JSON.stringify(payload);
  const id = nextSseId(roomId);
  appendSseEvent(roomId, id, eventName, data);
  for (const client of Array.from(clients)) {
    try {
      client.res.write(`id: ${id}\nevent: ${eventName}\ndata: ${data}\n\n`);
    } catch (e) {
      removeRoomSSEClient(roomId, client);
    }
  }
}

function broadcastStateToSSEClients() {
  broadcastRoomStateToSSEClients('default');
}

function startStateWatcher(roomId = 'default') {
  if (roomWatchers.has(roomId)) return;
  const file = getRoomStateFile(roomId);
  const lastHash = computeRoomStateHash(roomId);
  // M3: primary path is the referee's event-driven change bus — the referee is
  // the only writer, so it pushes exactly when state changes (no 250ms poll).
  // The fs.watchFile fallback remains only for out-of-process edits to the
  // snapshot file (e.g. an external tool or another server instance).
  const unsubscribe = referee.onStateChange(({ roomId: changedRoom }) => {
    if (changedRoom === roomId || changedRoom === 'default' || !changedRoom) {
      broadcastRoomStateToSSEClients(roomId);
    }
  });
  let unwatch;
  try {
    fs.watchFile(file, { interval: SSE_WATCH_INTERVAL_MS }, () => {
      broadcastRoomStateToSSEClients(roomId);
    });
    unwatch = () => { unsubscribe(); fs.unwatchFile(file); };
  } catch (e) {
    const intervalId = setInterval(() => broadcastRoomStateToSSEClients(roomId), SSE_WATCH_INTERVAL_MS);
    unwatch = () => { unsubscribe(); clearInterval(intervalId); };
  }
  roomWatchers.set(roomId, { unwatch, lastHash });
}

function stopStateWatcher(roomId) {
  if (roomId) {
    const watcher = roomWatchers.get(roomId);
    if (watcher) {
      try { watcher.unwatch(); } catch (_) {}
      roomWatchers.delete(roomId);
    }
  } else {
    for (const watcher of roomWatchers.values()) {
      try { watcher.unwatch(); } catch (_) {}
    }
    roomWatchers.clear();
  }
}

function removeRoomSSEClient(roomId, client) {
  const clients = roomSseClients.get(roomId);
  if (clients) {
    clients.delete(client);
    if (clients.size === 0) {
      roomSseClients.delete(roomId);
    }
  }
  if (client.heartbeatTimer) clearInterval(client.heartbeatTimer);
  try { client.res.end(); } catch (e) { /* already closed */ }
}

function handleSSEEndpoint(req, res, roomId = 'default') {
  const origin = req.headers.origin;
  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Connection': 'keep-alive'
  };
  if (origin && isOriginAllowed(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  res.writeHead(200, headers);
  res.write(`retry: ${Math.max(1000, SSE_HEARTBEAT_MS)}\n`);

  // M3: Last-Event-ID reconnection — replay events the client missed while
  // disconnected. `0`/absent means "send current snapshot only". Bounded by the
  // replay log (SSE_REPLAY_LIMIT entries); anything older is unrecoverable.
  let lastEventId = 0;
  const rawLastId = req.headers['last-event-id'];
  if (rawLastId !== undefined) {
    const n = Number(rawLastId);
    if (Number.isFinite(n) && n >= 0) lastEventId = n;
  }
  const log = roomSseLog.get(roomId) || [];
  for (const entry of log) {
    if (entry.id <= lastEventId) continue;
    try {
      res.write(`id: ${entry.id}\nevent: ${entry.event}\ndata: ${entry.data}\n\n`);
    } catch (e) { /* ignore */ }
  }

  const client = { res, heartbeatTimer: null };
  const clients = getClientsForRoom(roomId);
  clients.add(client);

  // Heartbeat: SSE comment lines keep the connection alive through proxies.
  client.heartbeatTimer = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (e) {
      removeRoomSSEClient(roomId, client);
    }
  }, SSE_HEARTBEAT_MS);

  // Immediately push the current state so the client doesn't wait for a change.
  // Only if the client did not already receive a fresher snapshot via replay.
  const state = readRoomStateJson(roomId);
  if (state) {
    const data = JSON.stringify(state);
    try {
      const id = nextSseId(roomId);
      appendSseEvent(roomId, id, 'state', data);
      res.write(`id: ${id}\nevent: state\ndata: ${data}\n\n`);
    } catch (e) { /* ignore */ }
  }

  req.on('close', () => removeRoomSSEClient(roomId, client));
  req.on('error', () => removeRoomSSEClient(roomId, client));
}

// ---------------------------------------------------------------------------
// Wave 3 (w3-room-file-gc): auto-room retention / GC.
//
// Every `/game/<room>` visitor gets a personal room = two files in the state
// dir + an in-memory RefereeService. Without a collector they accumulate
// forever. A room is collectable when ALL of:
//   * it is not the default room;
//   * it has been idle (no API request for that room, no referee command, no
//     snapshot write) for >= CHESS_ROOM_IDLE_MS (default 24 h);
//   * it has no connected SSE client;
//   * it has no live human seat lease (seat-auth; bot seats never expire and
//     are in-memory only, so they do not pin a room) and no recent spectator;
//   * its referee has no in-flight command;
//   * the game is unstarted (0 plies) or finished (gameOver).
// Finished games are archived first (unless a game with the same UCI move
// string is already in the archive — the client auto-saves on game end), with
// the same field set ui-archive.js POSTs to /api/games.
// Cap: if more than CHESS_ROOM_MAX rooms exist (default 2000), the oldest
// otherwise-collectable rooms are collected even below the idle threshold
// (never below CHESS_ROOM_MIN_IDLE_MS, default 60 s) until the cap holds.
// Runs at boot and every CHESS_ROOM_GC_INTERVAL_MS (default 1 h) — only when
// server.js is the entrypoint; CHESS_ROOM_GC=0 disables the scheduler.
// Operators: GET /api/admin/rooms and POST /api/admin/rooms/gc (X-Admin-Token
// must equal CHESS_ADMIN_TOKEN; both routes are 404 when it is unset).
// ---------------------------------------------------------------------------
function envInt(name, dflt, min) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n) || n < min) return dflt;
  return Math.floor(n);
}

const ROOM_GC_CONFIG = {
  idleMs: envInt('CHESS_ROOM_IDLE_MS', 24 * 60 * 60 * 1000, 1000),
  intervalMs: envInt('CHESS_ROOM_GC_INTERVAL_MS', 60 * 60 * 1000, 1000),
  maxRooms: envInt('CHESS_ROOM_MAX', 2000, 1),
  minIdleMs: envInt('CHESS_ROOM_MIN_IDLE_MS', 60 * 1000, 0),
  enabled: process.env.CHESS_ROOM_GC !== '0'
};

// roomId -> last time any API request named this room (polling counts).
const roomLastSeen = new Map();
function touchRoom(roomId) {
  if (roomId && roomId !== 'default') roomLastSeen.set(roomId, Date.now());
}

function roomSeatSummary(roomId) {
  const seats = seatAuthManager.rooms.get(roomId);
  if (!seats) return { white: null, black: null, spectators: 0, liveHuman: false, liveSpectator: false };
  const now = Date.now();
  const view = seat => (seat ? { isBot: !!seat.isBot, expired: seatAuthManager._isExpired(seat), username: seat.username || null } : null);
  const w = view(seats.white);
  const b = view(seats.black);
  const liveHuman = !!((w && !w.isBot && !w.expired) || (b && !b.isBot && !b.expired));
  let liveSpectator = false;
  const spectatorTimeout = Number(process.env.CHESS_SEAT_TIMEOUT_MS) || 300000;
  for (const lastSeen of seats.spectators.values()) {
    if (now - lastSeen <= spectatorTimeout) { liveSpectator = true; break; }
  }
  return { white: w, black: b, spectators: seats.spectators.size, liveHuman, liveSpectator };
}

function describeRoom(roomId, now = Date.now()) {
  const info = referee.inspectRoom(roomId);
  const sseClients = roomSseClients.get(roomId) ? roomSseClients.get(roomId).size : 0;
  const seats = roomSeatSummary(roomId);
  const lastActivityMs = Math.max(info.lastActivityMs || 0, roomLastSeen.get(roomId) || 0);
  const idleMs = lastActivityMs ? Math.max(0, now - lastActivityMs) : Infinity;
  const bot = botService.getBotConfig(roomId);
  const reasons = [];
  if (roomId === 'default') reasons.push('default room');
  if (sseClients > 0) reasons.push('sse clients');
  if (seats.liveHuman) reasons.push('live seat');
  if (seats.liveSpectator) reasons.push('live spectator');
  if (info.pendingCommands > 0) reasons.push('command in flight');
  if (info.plies > 0 && !info.gameOver) reasons.push('game in progress');
  const eligible = reasons.length === 0;
  return {
    roomId,
    exists: info.exists,
    inMemory: info.inMemory,
    plies: info.plies,
    gameOver: info.gameOver,
    status: info.status,
    result: info.result,
    lastActivityAt: lastActivityMs ? new Date(lastActivityMs).toISOString() : null,
    idleMs: Number.isFinite(idleMs) ? idleMs : null,
    sseClients,
    seats: { white: seats.white, black: seats.black, spectators: seats.spectators },
    bot: bot && bot.enabled ? { level: bot.level, color: bot.color } : null,
    eligible,
    collectable: eligible && Number.isFinite(idleMs) && idleMs >= ROOM_GC_CONFIG.idleMs,
    blockedBy: reasons,
    _info: info
  };
}

function listRooms(now = Date.now()) {
  return referee.listRoomIds().map(id => describeRoom(id, now));
}

function publicRoom(r) {
  const out = Object.assign({}, r);
  delete out._info;
  return out;
}

function archiveRoomIfMissing(desc) {
  const info = desc._info;
  if (!info.gameOver || info.plies === 0) return { archived: false, reason: info.gameOver ? 'no moves' : 'not finished' };
  const movesStr = info.history.join(' ');
  try {
    const hits = gameArchive.searchGames(movesStr, { limit: 20 });
    if (Array.isArray(hits) && hits.some(g => g && String(g.moves || '').trim() === movesStr)) {
      return { archived: false, reason: 'already archived' };
    }
  } catch (_) { /* archive lookup failed — fall through and save */ }
  const record = referee.archiveRecordForRoom(info);
  const saved = gameArchive.saveGame(record);
  return { archived: true, id: saved && saved.id };
}

function collectRoom(desc) {
  const roomId = desc.roomId;
  const archive = archiveRoomIfMissing(desc);
  stopStateWatcher(roomId);
  roomSseLog.delete(roomId);
  roomSseSeq.delete(roomId);
  roomLastSeen.delete(roomId);
  try { botService.setBotConfig(roomId, { enabled: false }); } catch (_) {}
  try { botService.rooms.delete(roomId); } catch (_) {}
  seatAuthManager.resetSeats(roomId);
  const del = referee.deleteRoomFiles(roomId);
  return { roomId, plies: desc.plies, gameOver: desc.gameOver, archived: archive.archived, archiveId: archive.id || null, archiveReason: archive.reason || null, removed: del.removed.length };
}

/**
 * One GC sweep. Safe to call from the scheduler, the admin route, and tests.
 * Never touches the default room.
 * @param {{now?:number, idleMs?:number, maxRooms?:number, minIdleMs?:number, log?:boolean}} opts
 */
function gcRooms(opts = {}) {
  const startedAt = Date.now();
  const now = typeof opts.now === 'number' ? opts.now : startedAt;
  const idleMs = typeof opts.idleMs === 'number' ? opts.idleMs : ROOM_GC_CONFIG.idleMs;
  const maxRooms = typeof opts.maxRooms === 'number' ? opts.maxRooms : ROOM_GC_CONFIG.maxRooms;
  const minIdleMs = typeof opts.minIdleMs === 'number' ? opts.minIdleMs : ROOM_GC_CONFIG.minIdleMs;
  const rooms = listRooms(now).filter(r => r.roomId !== 'default');
  const collected = [];
  const errors = [];
  const eligible = rooms.filter(r => r.eligible && r.idleMs !== null);
  const pick = new Map();
  for (const r of eligible) if (r.idleMs >= idleMs) pick.set(r.roomId, r);
  // Cap: oldest eligible rooms first until the total fits under maxRooms.
  let remaining = rooms.length - pick.size;
  if (remaining > maxRooms) {
    const extra = eligible.filter(r => !pick.has(r.roomId) && r.idleMs >= minIdleMs).sort((a, b) => b.idleMs - a.idleMs);
    for (const r of extra) {
      if (remaining <= maxRooms) break;
      pick.set(r.roomId, r);
      remaining--;
    }
  }
  let archived = 0;
  for (const r of pick.values()) {
    try {
      const c = collectRoom(r);
      if (c.archived) archived++;
      collected.push(c);
    } catch (err) {
      errors.push({ roomId: r.roomId, error: String(err && err.message || err) });
    }
  }
  const summary = {
    ok: true,
    scanned: rooms.length,
    collected: collected.length,
    archived,
    kept: rooms.length - collected.length,
    keptBusy: rooms.filter(r => !r.eligible).length,
    keptRecent: eligible.length - pick.size,
    overCap: Math.max(0, rooms.length - collected.length - maxRooms),
    errors,
    rooms: collected,
    durationMs: Date.now() - startedAt,
    config: { idleMs, maxRooms, minIdleMs }
  };
  if (opts.log !== false) {
    console.log(`[room-gc] scanned=${summary.scanned} collected=${summary.collected} archived=${summary.archived} kept=${summary.kept} (busy=${summary.keptBusy} recent=${summary.keptRecent}) overCap=${summary.overCap} errors=${errors.length} in ${summary.durationMs}ms`);
  }
  return summary;
}

let roomGcTimer = null;
function startRoomGc() {
  if (!ROOM_GC_CONFIG.enabled) {
    console.log('[room-gc] disabled (CHESS_ROOM_GC=0)');
    return null;
  }
  try { gcRooms(); } catch (err) { console.error('[room-gc] boot sweep failed:', err && err.message); }
  roomGcTimer = setInterval(() => {
    try { gcRooms(); } catch (err) { console.error('[room-gc] sweep failed:', err && err.message); }
  }, ROOM_GC_CONFIG.intervalMs);
  if (typeof roomGcTimer.unref === 'function') roomGcTimer.unref();
  return roomGcTimer;
}

function stopRoomGc() {
  if (roomGcTimer) { clearInterval(roomGcTimer); roomGcTimer = null; }
}

function checkAdminToken(req, res) {
  const expected = process.env.CHESS_ADMIN_TOKEN;
  if (!expected) { sendJsonError(res, 404, 'not found'); return false; }
  const given = req.headers['x-admin-token'];
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected));
  if (typeof given !== 'string' || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    sendJsonError(res, 401, 'invalid admin token');
    return false;
  }
  return true;
}

function handleAdminRoomsRoute(req, res, urlPath) {
  if (urlPath === '/api/admin/rooms' && req.method === 'GET') {
    if (!checkAdminToken(req, res)) return true;
    const rooms = listRooms().map(publicRoom);
    sendJson(res, 200, { ok: true, count: rooms.length, config: Object.assign({}, ROOM_GC_CONFIG), rooms });
    return true;
  }
  if (urlPath === '/api/admin/rooms/gc' && req.method === 'POST') {
    if (!checkAdminToken(req, res)) return true;
    sendJson(res, 200, gcRooms());
    return true;
  }
  return false;
}

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  // E1 (Wave 1): vendor/stockfish/stockfish-19-lite-single.wasm must be served
  // as application/wasm so WebAssembly.instantiateStreaming accepts it.
  '.wasm': 'application/wasm'
};

const MAX_BODY_BYTES = 8192;

const SERVED_ROOT = DIR;

const ALLOWED_FILES = new Set([
  'index.html',
  'src/engine.js',
  'src/ui.js',
  'src/ui-sound.js',
  'src/ui-theme.js',
  'src/ui-annotations.js',
  'src/ui-archive.js',
  'src/pieces.js',
  'src/stockfish-worker.js',
  'vendor/stockfish/stockfish-19-lite-single.js',
  'vendor/stockfish/stockfish-19-lite-single.wasm',
  'src/move-review.js',
  'src/openings-db.js',
  'src/game-archive.js',
  'src/ai-coach.js',
  'src/game-report.js',
  'src/accessibility-voice.js',
  'src/rating.js',
  'src/ratings-pool.js',
  'src/lobby.js',
  'src/puzzle-service.js',
  'src/puzzle-rating.js',
  'src/puzzle-storm.js',
  'src/daily-puzzle.js',
  'src/study-tree.js',
  'src/openings-explorer.js',
  'src/puzzle-repetition.js',
  'src/eval-graph.js',
  'src/masters-db.js',
  'src/acpl.js',
  'src/puzzle-racer.js',
  'src/a11y-text-entry.js',
  'src/a11y-gestures.js',
  'src/voice-intents.js',
  'src/chess960.js',
  'src/time-control.js',
  'src/tablebase.js',
  'src/arena.js',
  'src/social-graph.js',
  'src/chat-upgrades.js',
  'src/correspondence.js',
  'src/personality-bots.js',
  'src/pov-export.js',
  'src/embed-viewer.js',
  'src/variants.js',
  'src/i18n.js',
  'src/ui-auth.js',
  'src/shell.js',
  'src/ui-puzzles.js',
  'src/ui-settings.js',
  'src/ui-compete.js',
  'src/ui-profile.js',
  'src/ui-analysis.js',
  'src/ui-library.js',
  'src/ui-retention.js',
  'src/ui-insights.js',
  'src/sw-register.js',
  'manifest.webmanifest',
  'service-worker.js',
  'CBURNETT-LICENSE.txt'
]);

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.CHESS_RATE_LIMIT) || 600;

// M4: persistent (SQLite-backed) rate limiting. Counts are written through the
// archive so they survive process restarts. An in-memory Map stays as the fast
// read cache; the archive is the durable source of truth on write.
function rateLimitKey(ip) {
  return 'rl:' + (typeof ip === 'string' ? ip : '127.0.0.1');
}

function loadRateLimit(ip) {
  const key = rateLimitKey(ip);
  try {
    const stored = gameArchive.getRateLimit(key);
    if (stored && typeof stored.count === 'number' && typeof stored.windowStart === 'number') {
      return { count: stored.count, resetAt: stored.windowStart + RATE_LIMIT_WINDOW_MS };
    }
  } catch (_) { /* archive unavailable */ }
  return null;
}

function persistRateLimit(ip, count, windowStart) {
  try {
    gameArchive.saveRateLimit(rateLimitKey(ip), { count, windowStart, updatedAt: Date.now() });
  } catch (_) { /* non-fatal */ }
}

function checkRateLimit(ip) {
  const now = Date.now();
  if (rateLimitMap.size > 2000) {
    for (const [k, v] of rateLimitMap.entries()) {
      if (now > v.resetAt) rateLimitMap.delete(k);
    }
  }
  let entry = rateLimitMap.get(ip);
  if (!entry) {
    const restored = loadRateLimit(ip);
    entry = restored && restored.resetAt > now ? restored : { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  }
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  entry.count++;
  rateLimitMap.set(ip, entry);
  persistRateLimit(ip, entry.count, entry.resetAt - RATE_LIMIT_WINDOW_MS);
  return entry.count <= RATE_LIMIT_MAX_REQUESTS;
}

const ALLOWED_DIRS = new Set([
  'assets'
]);

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function sendJsonError(res, statusCode, message) {
  sendJson(res, statusCode, { ok: false, error: message });
}

function isOriginAllowed(origin) {
  if (!origin) return true;
  const allowed = getAllowedOrigins();
  if (allowed.includes('*') || allowed.includes(origin)) return true;
  if (!process.env.CHESS_ALLOWED_ORIGIN) {
    try {
      const url = new URL(origin);
      if (url.hostname.endsWith('.onrender.com') || url.hostname === 'onrender.com') {
        return true;
      }
    } catch (e) {}
  }
  return false;
}

function checkCors(req, res) {
  const origin = req.headers.origin;
  if (origin && !isOriginAllowed(origin)) {
    sendJsonError(res, 403, 'origin not allowed');
    return false;
  }
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  return true;
}

// M4: helmet-style security headers. HSTS is only emitted when the connection is
// actually behind TLS (socket.encrypted) or explicitly enabled via CHESS_HSTS=1,
// so the local plain-HTTP dev server never advertises HSTS incorrectly.
function isBehindTls(req) {
  return !!(req && req.socket && req.socket.encrypted) ||
    !!(req && req.headers && req.headers['x-forwarded-proto'] === 'https') ||
    process.env.CHESS_HSTS === '1';
}

function buildCsp() {
  if (process.env.CHESS_CSP) return process.env.CHESS_CSP;
  // The app is a no-build-step vanilla JS SPA: every script is a <script src>
  // (no inline scripts, no on*= handlers), one inline <style> block plus many
  // style="" attributes, WebAssembly (vendored Stockfish 19 lite, see
  // vendor/stockfish/), and Google Identity Services.
  //
  // D4 (Wave 1): 'wasm-unsafe-eval' replaces 'unsafe-eval'. The engine loader
  // (vendor/stockfish/stockfish-19-lite-single.js) uses WebAssembly.instantiate
  // only — no eval()/new Function — so plain JS eval stays blocked. Dedicated
  // Workers take their CSP from their own script response, and this header is
  // sent on every response, so the Worker gets the same policy.
  // D4 (Wave 3): script-src no longer carries 'unsafe-inline'. The last inline
  // block (service-worker registration) moved to src/sw-register.js. The GSI
  // client is loaded by ui-auth.js as an external <script src> from the
  // allowlisted origin and needs no inline allowance.
  // style-src keeps 'unsafe-inline' on purpose: index.html has an inline
  // <style>, ui-analysis.js injects one, and hundreds of style="" attributes
  // remain (ui.js/ui-archive.js set element.style too). Hashing every block is
  // not worth it while those exist; an inline-style-free UI is a follow-up.
  // D5: tablebase.js probes https://tablebase.lichess.ovh (7-piece Syzygy).
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com/gsi/client",
    "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
    "img-src 'self' data: https://*.googleusercontent.com",
    "font-src 'self' data:",
    "connect-src 'self' https://accounts.google.com/gsi/ https://tablebase.lichess.ovh",
    "frame-src 'self' https://accounts.google.com/gsi/",
    "worker-src 'self' blob:",
    "media-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ].join('; ');
}

function parseCookies(req) {
  const list = {};
  const rc = req && req.headers && req.headers.cookie;
  if (!rc) return list;
  rc.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    if (parts.length >= 2) {
      list[parts[0].trim()] = decodeURIComponent(parts.slice(1).join('=').trim());
    }
  });
  return list;
}

function extractSessionToken(req) {
  const cookies = parseCookies(req);
  if (cookies.chess_session) return cookies.chess_session;
  const authHeader = req && req.headers && req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const xSession = req && req.headers && req.headers['x-session-token'];
  if (typeof xSession === 'string' && xSession.trim()) {
    return xSession.trim();
  }
  return null;
}

function getAuthUser(req) {
  const token = extractSessionToken(req);
  if (!token) return null;
  return accountsManager.getSession(token);
}

function setSessionCookie(res, token, maxAgeSeconds = 7 * 24 * 3600) {
  const isProd = process.env.NODE_ENV === 'production' || !!process.env.PORT;
  const secureFlag = isProd ? '; Secure' : '';
  res.setHeader('Set-Cookie', `chess_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureFlag}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'chess_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
}

function decodeJwtPayload(jwtString) {
  if (typeof jwtString !== 'string') return null;
  const parts = jwtString.split('.');
  if (parts.length !== 3) return null;
  try {
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payloadJson);
  } catch (_) {
    return null;
  }
}

function applySecurityHeaders(req, res) {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('X-Download-Options', 'noopen');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Content-Security-Policy', buildCsp());
  if (isBehindTls(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function isPathAllowed(reqPath) {
  let clean = reqPath.replace(/\\/g, '/');
  if (clean.startsWith('/')) clean = clean.slice(1);
  const resolved = path.resolve(SERVED_ROOT, clean);
  const rel = path.relative(SERVED_ROOT, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  const base = rel.split(path.sep)[0];
  if (ALLOWED_FILES.has(rel)) {
    return resolved;
  }
  if (ALLOWED_DIRS.has(base)) {
    return resolved;
  }
  return null;
}

function isDotfile(relPath) {
  return relPath.split('/').some(seg => seg.startsWith('.'));
}

// D1: MIME types worth compressing. Images (png/ico) and wasm are already
// compact or binary; SSE (/api/events) never reaches the static branch.
const COMPRESSIBLE_MIME = new Set([
  'text/html',
  'application/javascript',
  'application/json',
  'text/css',
  'image/svg+xml',
  'application/manifest+json',
  'text/plain'
]);
const BROTLI_AVAILABLE = typeof zlib.createBrotliCompress === 'function';

function pickContentEncoding(req, mime) {
  if (!COMPRESSIBLE_MIME.has(mime)) return null;
  const accept = String(req.headers['accept-encoding'] || '').toLowerCase();
  if (!accept) return null;
  const tokens = accept.split(',').map(t => t.trim().split(';')[0]);
  if (BROTLI_AVAILABLE && tokens.includes('br')) return 'br';
  if (tokens.includes('gzip')) return 'gzip';
  return null;
}

function appendVary(res, value) {
  const existing = res.getHeader('Vary');
  if (!existing) {
    res.setHeader('Vary', value);
    return;
  }
  const parts = String(existing).split(',').map(v => v.trim().toLowerCase());
  if (!parts.includes(value.toLowerCase())) {
    res.setHeader('Vary', existing + ', ' + value);
  }
}

// D2: static files under src/ and assets/ are safe to revalidate via ETag /
// Last-Modified. Everything else (index.html, service-worker.js, manifest,
// licence) keeps the global no-store policy.
function isRevalidatableStatic(rel) {
  return rel.startsWith('src/') || rel.startsWith('assets/') || rel.startsWith('vendor/');
}

function weakEtag(stats) {
  return 'W/"' + stats.size.toString(16) + '-' + Math.floor(stats.mtimeMs).toString(16) + '"';
}

function etagMatches(headerValue, etag) {
  const strip = v => v.trim().replace(/^W\//, '');
  const want = strip(etag);
  return String(headerValue).split(',').some(v => {
    const t = v.trim();
    return t === '*' || strip(t) === want;
  });
}

function isFreshRequest(req, etag, mtime) {
  const inm = req.headers['if-none-match'];
  if (inm) return etagMatches(inm, etag);
  const ims = req.headers['if-modified-since'];
  if (ims) {
    const since = Date.parse(ims);
    if (!Number.isNaN(since)) {
      // HTTP dates have 1s resolution; compare on whole seconds.
      return Math.floor(mtime.getTime() / 1000) <= Math.floor(since / 1000);
    }
  }
  return false;
}

function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let data = '';
    let oversized = false;
    req.on('data', chunk => {
      if (oversized) return;
      data += chunk;
      if (Buffer.byteLength(data) > maxBytes) {
        oversized = true;
        reject(new Error('Payload Too Large'));
      }
    });
    req.on('end', () => {
      if (oversized) return;
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        resolve(null);
      }
    });
    req.on('error', reject);
  });
}

// C2/C4: move submission goes through the in-process referee service
// (long-lived, serialized command queue). moveStr: 4-5 chars (e2e4, e7e8q).
// The body-cap + CORS/origin checks happen BEFORE queue entry (gate1 + d1).
function handleMoveEndpoint(req, res, roomId = 'default') {
  let body = '';
  let oversized = false;
  req.on('data', chunk => {
    if (oversized) return;
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      oversized = true;
      sendJsonError(res, 413, 'request body too large');
    }
  });
  req.on('end', () => {
    if (oversized) return;
    let moveStr = '';
    let cmdId = null;
    let expectedRevision = undefined;
    let clientSentAt = undefined;
    try {
      const parsed = JSON.parse(body);
      moveStr = String(parsed.move || '');
      if (parsed.id !== undefined) cmdId = parsed.id;
      if (parsed.expectedRevision !== undefined) expectedRevision = Number(parsed.expectedRevision);
      if (typeof parsed.clientSentAt === 'number') clientSentAt = parsed.clientSentAt;
    } catch (e) { /* fall through */ }
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(moveStr)) {
      sendJsonError(res, 400, 'bad move format');
      return;
    }

    const seatToken = req.headers['x-seat-token'] || (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
    const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
    const queryParams = new URLSearchParams(queryString);
    const targetRoom = roomId || queryParams.get('room') || 'default';

    const currentState = readRoomStateJson(targetRoom);
    const currentTurn = (currentState && currentState.board && currentState.board.turn) || 'white';

    const authCheck = seatAuthManager.validateMove(targetRoom, seatToken, currentTurn);
    if (!authCheck.ok) {
      sendJsonError(res, authCheck.status || 403, authCheck.error);
      return;
    }

    const command = {
      id: cmdId !== null ? cmdId : 'move:' + moveStr + ':' + Date.now() + ':' + Math.random().toString(36).slice(2),
      type: 'move',
      args: { move: moveStr, clientSentAt },
      expectedRevision
    };
    referee.getReferee(targetRoom).enqueue(command).then(result => {
      sendJson(res, result.httpStatus || (result.ok ? 200 : 409), result);
      if (result.ok) {
        broadcastRoomStateToSSEClients(targetRoom);
        botService.triggerBotMoveIfNeeded(targetRoom, referee, (eventType, payload) => {
          if (eventType === 'chat') {
            broadcastRoomEventToSSEClients(targetRoom, 'chat', payload);
          } else {
            broadcastRoomStateToSSEClients(targetRoom);
          }
        });
      }
    });
  });
  req.on('error', () => {
    if (!res.headersSent) sendJsonError(res, 400, 'request error');
  });
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = '';
    let oversized = false;
    req.on('data', chunk => {
      if (oversized) return;
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
        oversized = true;
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => {
      if (oversized) return;
      resolve(body);
    });
    req.on('error', reject);
  });
}

function handleQueueCommand(req, res, commandType, argsExtractor, roomId = 'default', requiredRoleExtractor = null) {
  readBody(req, MAX_BODY_BYTES).then(body => {
    let parsed = {};
    try { parsed = body ? JSON.parse(body) : {}; } catch (e) { parsed = {}; }

    const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
    const queryParams = new URLSearchParams(queryString);
    const targetRoom = roomId || queryParams.get('room') || parsed.room || 'default';

    const seatToken = req.headers['x-seat-token'] ||
      (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null) ||
      parsed.token || parsed.seatToken || null;

    const requiredRole = requiredRoleExtractor ? requiredRoleExtractor(parsed, req, queryParams) : null;
    const authCheck = seatAuthManager.validateMutation(targetRoom, seatToken, requiredRole);
    if (!authCheck.ok) {
      sendJsonError(res, authCheck.status || 403, authCheck.error);
      return;
    }

    const { args, cmdId, expectedRevision } = argsExtractor(parsed, req, authCheck);
    const command = {
      id: cmdId !== null ? cmdId : commandType + ':' + Date.now() + ':' + Math.random().toString(36).slice(2),
      type: commandType,
      args,
      expectedRevision
    };
    referee.getReferee(targetRoom).enqueue(command).then(result => {
      sendJson(res, result.httpStatus || (result.ok ? 200 : 409), result);
      if (result.ok) {
        broadcastRoomStateToSSEClients(targetRoom);
        botService.triggerBotMoveIfNeeded(targetRoom, referee, (eventType, payload) => {
          if (eventType === 'chat') {
            broadcastRoomEventToSSEClients(targetRoom, 'chat', payload);
          } else {
            broadcastRoomStateToSSEClients(targetRoom);
          }
        });
      }
    });
  }).catch(() => {
    if (!res.headersSent) sendJsonError(res, 413, 'request body too large');
  });
}

function handleResetEndpoint(req, res, roomId = 'default') {
  handleQueueCommand(req, res, 'reset', (parsed) => ({
    args: {},
    cmdId: parsed.id !== undefined ? parsed.id : null,
    expectedRevision: parsed.expectedRevision !== undefined ? Number(parsed.expectedRevision) : undefined
  }), roomId);
}

function handleSetupEndpoint(req, res, roomId = 'default') {
  handleQueueCommand(req, res, 'setup', (parsed) => ({
    args: { fen: parsed.fen },
    cmdId: parsed.id !== undefined ? parsed.id : null,
    expectedRevision: parsed.expectedRevision !== undefined ? Number(parsed.expectedRevision) : undefined
  }), roomId);
}

function handleResignEndpoint(req, res, roomId = 'default') {
  const query = new URL(req.url, 'http://127.0.0.1').searchParams;
  const color = query.has('w') ? 'white' : query.has('b') ? 'black' : (query.get('color') || null);
  handleQueueCommand(req, res, 'resign', (parsed, req, authCheck) => {
    const finalColor = color || parsed.color || (authCheck && authCheck.role && authCheck.role !== 'unseated' ? authCheck.role : '');
    return {
      args: { color: finalColor },
      cmdId: parsed.id !== undefined ? parsed.id : null,
      expectedRevision: parsed.expectedRevision !== undefined ? Number(parsed.expectedRevision) : undefined
    };
  }, roomId, (parsed, req, queryParams) => {
    return color || parsed.color || null;
  });
}

function handleDrawEndpoint(req, res, roomId = 'default', explicitAction = null) {
  handleQueueCommand(req, res, 'draw', (parsed, req, authCheck) => {
    const action = explicitAction || parsed.action || null;
    const color = parsed.color || (authCheck && authCheck.role && authCheck.role !== 'unseated' ? authCheck.role : null);
    const isSeated = !!(authCheck && authCheck.role && authCheck.role !== 'unseated');
    return {
      args: { action, color, isSeated },
      cmdId: parsed.id !== undefined ? parsed.id : null,
      expectedRevision: parsed.expectedRevision !== undefined ? Number(parsed.expectedRevision) : undefined
    };
  }, roomId);
}

function handleFlagEndpoint(req, res, roomId = 'default') {
  const query = new URL(req.url, 'http://127.0.0.1').searchParams;
  const targetRoom = query.get('room') || roomId || 'default';
  const ref = referee.getReferee(targetRoom);
  const result = ref.checkFlagFall();
  if (result.flagged) {
    broadcastRoomStateToSSEClients(targetRoom);
    sendJson(res, 200, { ok: true, flagged: true, color: result.color, result: ref.state.result });
  } else {
    sendJson(res, 200, { ok: false, error: 'Clock has not expired', remainingClock: result.remainingClock });
  }
}

function handleUndoEndpoint(req, res, roomId = 'default') {
  handleQueueCommand(req, res, 'undo', (parsed) => ({
    args: {},
    cmdId: parsed.id !== undefined ? parsed.id : null,
    expectedRevision: parsed.expectedRevision !== undefined ? Number(parsed.expectedRevision) : undefined
  }), roomId);
}

const MAX_GAME_BODY_BYTES = 1024 * 1024;

function handleGetGamesEndpoint(req, res) {
  const parsedUrl = new URL(req.url, 'http://127.0.0.1');
  const params = parsedUrl.searchParams;
  const limit = params.has('limit') ? parseInt(params.get('limit'), 10) : 50;
  const offset = params.has('offset') ? parseInt(params.get('offset'), 10) : 0;
  const q = params.get('q');
  const white = params.get('white');
  const black = params.get('black');
  const eco = params.get('eco');
  const result = params.get('result');

  let games = [];
  if (q) {
    games = gameArchive.searchGames(q, { limit, offset });
  } else if (white || black || eco || result) {
    games = gameArchive.searchGames({ white, black, eco, result }, { limit, offset });
  } else {
    games = gameArchive.listGames({ limit, offset });
  }

  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  sendJson(res, 200, { ok: true, games });
}

function handlePostGameEndpoint(req, res) {
  readBody(req, MAX_GAME_BODY_BYTES).then(body => {
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      sendJsonError(res, 400, 'invalid json');
      return;
    }
    if (!parsed || typeof parsed !== 'object') {
      sendJsonError(res, 400, 'payload must be a json object');
      return;
    }
    try {
      // Wave 3: ownership is server-attached from the session, never trusted
      // from the client body (a guest could otherwise claim/poison rows).
      delete parsed.owner_id; delete parsed.source; delete parsed.external_id; delete parsed.room_id;
      const session = getAuthUser(req);
      parsed.owner_id = session && session.userId ? String(session.userId) : null;
      // auto-save posts the referee's UCI `moves` array; the Library/archive PGN paste posts only `pgn`.
      parsed.source = Array.isArray(parsed.moves) && parsed.moves.length > 0 ? 'local' : 'pgn';
      const room = extractRoomId(req);
      parsed.room_id = room && room !== 'default' && isValidRoomId(room) ? room : null;
      const saved = gameArchive.saveGame(parsed);
      const origin = req.headers.origin;
      if (origin && isOriginAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      sendJson(res, 201, { ok: true, id: saved.id, game: saved });
    } catch (err) {
      sendJsonError(res, 400, err.message || 'failed to save game');
    }
  }).catch(() => {
    if (!res.headersSent) sendJsonError(res, 413, 'request body too large');
  });
}

// B3: archived games ship referee-computed per-ply positions so the client
// never replays moves itself (Gate 4). UCI move lists are used directly; PGN-only
// records are converted through chess.js first.
function archivedGamePositions(game) {
  try {
    let uci = [];
    const movesStr = typeof game.moves === 'string' ? game.moves.trim() : '';
    const split = movesStr ? movesStr.split(/\s+/) : [];
    if (split.length > 0 && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(split[0])) {
      uci = split;
    } else if (game.pgn) {
      const c = new Chess();
      c.loadPgn(game.pgn);
      uci = c.history({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''));
    }
    return referee.buildPositions(uci);
  } catch (_) {
    return null;
  }
}

function handleGetGameEndpoint(req, res, id) {
  const game = gameArchive.getGame(id);
  if (!game) {
    sendJsonError(res, 404, 'game not found');
    return;
  }
  const positions = archivedGamePositions(game);
  const payload = positions ? Object.assign({}, game, { positions }) : game;
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  sendJson(res, 200, { ok: true, game: payload });
}

function handleGetGamePgnEndpoint(req, res, id) {
  const game = gameArchive.getGame(id);
  if (!game) {
    sendJsonError(res, 404, 'game not found');
    return;
  }
  const pgn = game.pgn || gameArchive.exportPgn(game);
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-chess-pgn; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${id}.pgn"`);
  res.end(pgn);
}

function isApiRequest(urlPath) {
  return urlPath.startsWith('/api/');
}

function createServer() {
  return http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    applySecurityHeaders(req, res);

    if (req.method === 'OPTIONS') {
      const origin = req.headers.origin;
      if (origin && !isOriginAllowed(origin)) {
        sendJsonError(res, 403, 'origin not allowed');
        return;
      }
      if (origin && isOriginAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      res.statusCode = 204;
      res.end();
      return;
    }

    const urlPath = req.url.split('?')[0];

    if (!checkCors(req, res)) return;

    if (isApiRequest(urlPath)) {
      const forwarded = req.headers && req.headers['x-forwarded-for'];
      const clientIp = (forwarded ? forwarded.split(',')[0].trim() : (req.socket && req.socket.remoteAddress)) || '127.0.0.1';
      if (!checkRateLimit(clientIp)) {
        sendJsonError(res, 429, 'rate limit exceeded');
        return;
      }
      if (req.method === 'GET' && urlPath === '/api/time') {
        const t0 = req.url.includes('?') ? new URLSearchParams(req.url.split('?')[1]).get('t0') : null;
        const now = Date.now();
        sendJson(res, 200, {
          t0: t0 ? Number(t0) : undefined,
          serverReceiveTime: now,
          serverTransmitTime: now
        });
        return;
      }

      if (req.method === 'GET' && urlPath === '/api/auth/config') {
        sendJson(res, 200, {
          ok: true,
          googleClientId: process.env.GOOGLE_CLIENT_ID || null,
          demoAuthEnabled: process.env.ALLOW_DEMO_AUTH === '1'
        });
        return;
      }

      if (req.method === 'POST' && urlPath === '/api/auth/google') {
        readJsonBody(req).then(body => {
          if (!body) {
            sendJsonError(res, 400, 'invalid request body');
            return;
          }
          // Demo sign-in creates a session for ANY email with no credential
          // check. It is an auth bypass unless explicitly enabled for a
          // dev/demo deployment via ALLOW_DEMO_AUTH=1.
          if (body.demoUser && process.env.ALLOW_DEMO_AUTH === '1') {
            const email = String(body.demoUser.email || 'player@gmail.com');
            const name = String(body.demoUser.name || 'Google Player');
            const user = accountsManager.createOrFindGoogleUser({
              googleId: 'demo-google-' + Buffer.from(email).toString('hex').slice(0, 16),
              email,
              name,
              picture: body.demoUser.picture || null
            });
            const session = accountsManager.createSession(user);
            setSessionCookie(res, session.token);
            sendJson(res, 200, { ok: true, user, token: session.token });
            return;
          }
          if (!body.credential) {
            sendJsonError(res, 400, 'credential is required');
            return;
          }
          const payload = decodeJwtPayload(body.credential);
          if (!payload || !payload.sub) {
            sendJsonError(res, 400, 'invalid google credential token');
            return;
          }
          if (payload.exp && payload.exp * 1000 < Date.now() - 60000) {
            sendJsonError(res, 401, 'google credential token expired');
            return;
          }
          if (process.env.GOOGLE_CLIENT_ID && payload.aud !== process.env.GOOGLE_CLIENT_ID) {
            sendJsonError(res, 401, 'invalid token audience');
            return;
          }
          const user = accountsManager.createOrFindGoogleUser({
            googleId: payload.sub,
            email: payload.email,
            name: payload.name,
            picture: payload.picture
          });
          const session = accountsManager.createSession(user);
          setSessionCookie(res, session.token);
          sendJson(res, 200, { ok: true, user, token: session.token });
        }).catch(err => sendJsonError(res, 400, err.message));
        return;
      }

      if (req.method === 'POST' && urlPath === '/api/auth/register') {
        readJsonBody(req).then(body => {
          if (!body || !body.username || !body.password) {
            sendJsonError(res, 400, 'username and password are required');
            return;
          }
          try {
            const user = accountsManager.createAccount({
              username: String(body.username),
              password: String(body.password)
            });
            const session = accountsManager.createSession(user);
            setSessionCookie(res, session.token);
            sendJson(res, 200, { ok: true, user, token: session.token });
          } catch (err) {
            const status = err && err.code === 'ACCOUNT_EXISTS' ? 409 : 400;
            sendJsonError(res, status, err.message);
          }
        }).catch(err => sendJsonError(res, 400, err.message));
        return;
      }

      if (req.method === 'POST' && urlPath === '/api/auth/login') {
        readJsonBody(req).then(body => {
          if (!body || !body.username || !body.password) {
            sendJsonError(res, 400, 'username and password are required');
            return;
          }
          const user = accountsManager.verifyAccount({
            username: String(body.username),
            password: String(body.password)
          });
          if (!user) {
            sendJsonError(res, 401, 'invalid username or password');
            return;
          }
          const session = accountsManager.createSession(user);
          setSessionCookie(res, session.token);
          sendJson(res, 200, { ok: true, user, token: session.token });
        }).catch(err => sendJsonError(res, 400, err.message));
        return;
      }

      if (req.method === 'GET' && urlPath === '/api/auth/me') {
        const session = getAuthUser(req);
        if (session) {
          sendJson(res, 200, {
            ok: true,
            authenticated: true,
            user: {
              id: session.userId,
              username: session.username,
              email: session.email,
              picture: session.picture,
              authProvider: session.authProvider
            }
          });
        } else {
          sendJson(res, 200, { ok: true, authenticated: false, user: null });
        }
        return;
      }

      if (req.method === 'POST' && urlPath === '/api/auth/logout') {
        const token = extractSessionToken(req);
        if (token) {
          accountsManager.revokeSession(token);
        }
        clearSessionCookie(res);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && urlPath === '/api/profile') {
        const session = getAuthUser(req);
        const query = new URLSearchParams(req.url.split('?')[1] || '');
        const targetUsername = query.get('username') || (session && session.username);
        if (!targetUsername) {
          sendJsonError(res, 400, 'username parameter or authenticated session required');
          return;
        }
        const profile = Accounts.playerProfile(gameArchive, targetUsername);
        sendJson(res, 200, { ok: true, profile });
        return;
      }

      if (urlPath.startsWith('/api/admin/rooms') && handleAdminRoomsRoute(req, res, urlPath)) return; // Wave 3: room GC operator routes

      const roomId = extractRoomId(req);
      if (!isValidRoomId(roomId)) {
        sendJsonError(res, 400, 'invalid room id');
        return;
      }
      touchRoom(roomId); // Wave 3 GC: any request naming a room counts as activity

      if (req.method === 'GET' && urlPath === '/api/state') {
        const state = readRoomStateJson(roomId);
        if (!state) { sendJsonError(res, 404, 'no state'); return; }
        const origin = req.headers.origin;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        if (origin && isOriginAllowed(origin)) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
        }
        res.end(JSON.stringify(state));
        return;
      }
      if (req.method === 'GET' && urlPath === '/api/events') {
        startStateWatcher(roomId);
        handleSSEEndpoint(req, res, roomId);
        return;
      }
      if (req.method === 'POST' && urlPath === '/api/move') {
        handleMoveEndpoint(req, res, roomId);
        return;
      }
      if (req.method === 'POST' && urlPath === '/api/reset') {
        handleResetEndpoint(req, res, roomId);
        return;
      }
      if (req.method === 'POST' && urlPath === '/api/setup') {
        handleSetupEndpoint(req, res, roomId);
        return;
      }
      if ((req.method === 'GET' || req.method === 'POST') && urlPath === '/api/resign') {
        handleResignEndpoint(req, res, roomId);
        return;
      }
      if (req.method === 'POST' && urlPath === '/api/draw') {
        handleDrawEndpoint(req, res, roomId);
        return;
      }
      if (req.method === 'POST' && urlPath === '/api/draw/offer') {
        handleDrawEndpoint(req, res, roomId, 'offer');
        return;
      }
      if (req.method === 'POST' && urlPath === '/api/draw/accept') {
        handleDrawEndpoint(req, res, roomId, 'accept');
        return;
      }
      if (req.method === 'POST' && urlPath === '/api/draw/decline') {
        handleDrawEndpoint(req, res, roomId, 'decline');
        return;
      }
      if (req.method === 'POST' && (urlPath === '/api/draw-claim' || urlPath === '/api/draw/claim')) {
        handleDrawEndpoint(req, res, roomId, 'claim');
        return;
      }
      if ((req.method === 'POST' || req.method === 'GET') && urlPath === '/api/flag') {
        handleFlagEndpoint(req, res, roomId);
        return;
      }
      if (req.method === 'POST' && urlPath === '/api/undo') {
        handleUndoEndpoint(req, res, roomId);
        return;
      }
      if (req.method === 'POST' && urlPath === '/api/seat/claim') {
        readBody(req, MAX_BODY_BYTES).then(body => {
          let parsed = {};
          try { parsed = body ? JSON.parse(body) : {}; } catch (e) { parsed = {}; }
          const role = parsed.role;
          const targetRoom = parsed.room || roomId;
          const result = seatAuthManager.claimSeat(targetRoom, role, { account: getAuthUser(req) }); // Wave 2: seat -> account link for rating-hook.js
          if (result.ok) {
            sendJson(res, 200, result);
          } else {
            sendJsonError(res, result.status || 400, result.error);
          }
        }).catch(() => sendJsonError(res, 413, 'request body too large'));
        return;
      }
      if (req.method === 'POST' && urlPath === '/api/seat/release') {
        readBody(req, MAX_BODY_BYTES).then(body => {
          let parsed = {};
          try { parsed = body ? JSON.parse(body) : {}; } catch (e) { parsed = {}; }
          const token = parsed.token || req.headers['x-seat-token'] || (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
          const targetRoom = parsed.room || roomId;
          const result = seatAuthManager.releaseSeat(targetRoom, token);
          if (result.ok) {
            sendJson(res, 200, result);
          } else {
            sendJsonError(res, result.status || 404, result.error);
          }
        }).catch(() => sendJsonError(res, 413, 'request body too large'));
        return;
      }
      if (req.method === 'POST' && urlPath === '/api/seat/heartbeat') {
        readBody(req, MAX_BODY_BYTES).then(body => {
          let parsed = {};
          try { parsed = body ? JSON.parse(body) : {}; } catch (e) { parsed = {}; }
          const token = parsed.token || req.headers['x-seat-token'] || (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
          const targetRoom = parsed.room || roomId;
          const result = seatAuthManager.heartbeat(targetRoom, token);
          if (result.ok) {
            sendJson(res, 200, result);
          } else {
            sendJsonError(res, result.status || 404, result.error);
          }
        }).catch(() => sendJsonError(res, 413, 'request body too large'));
        return;
      }
      if (req.method === 'GET' && urlPath === '/api/seat/status') {
        const targetRoom = new URLSearchParams(req.url.split('?')[1] || '').get('room') || roomId;
        const status = seatAuthManager.getStatus(targetRoom);
        const sseCount = roomSseClients.get(targetRoom) ? roomSseClients.get(targetRoom).size : 0;
        const spectators = Math.max(status.spectatorsCount, Math.max(0, sseCount - (status.whiteOccupied ? 1 : 0) - (status.blackOccupied ? 1 : 0)));
        sendJson(res, 200, { ...status, spectatorsCount: spectators });
        return;
      }
      if (req.method === 'GET' && urlPath === '/api/time-control') {
        const targetRoom = new URLSearchParams(req.url.split('?')[1] || '').get('room') || roomId;
        const ref = referee.getReferee(targetRoom);
        sendJson(res, 200, { ok: true, timeControl: (ref && (ref.timeControl || ref.state.timeControl)) || null });
        return;
      }
      if (req.method === 'POST' && urlPath === '/api/time-control') {
        const targetRoom = new URLSearchParams(req.url.split('?')[1] || '').get('room') || roomId;
        const authHeader = req.headers['authorization'];
        const token = req.headers['x-seat-token'] || ((authHeader && authHeader.startsWith('Bearer ')) ? authHeader.slice(7).trim() : null);
        const validation = seatAuthManager.validateMutation(targetRoom, token);
        if (!validation.ok) {
          sendJson(res, validation.status || 403, { ok: false, error: validation.error });
          return;
        }
        readJsonBody(req).then(body => {
          if (!body) {
            sendJsonError(res, 400, 'Invalid JSON body');
            return;
          }
          const PRESETS = {
            'bullet_1_0': { preset: 'bullet_1_0', baseSeconds: 60, incrementSeconds: 0, name: 'Bullet 1+0' },
            'blitz_3_2': { preset: 'blitz_3_2', baseSeconds: 180, incrementSeconds: 2, name: 'Blitz 3+2' },
            'blitz_5_3': { preset: 'blitz_5_3', baseSeconds: 300, incrementSeconds: 3, name: 'Blitz 5+3' },
            'rapid_10_0': { preset: 'rapid_10_0', baseSeconds: 600, incrementSeconds: 0, name: 'Rapid 10+0' },
            'rapid_10_15': { preset: 'rapid_10_15', baseSeconds: 600, incrementSeconds: 15, name: 'Rapid 10+15' },
            'classical_15_10': { preset: 'classical_15_10', baseSeconds: 900, incrementSeconds: 10, name: 'Classical 15+10' }
          };
          let tc = PRESETS[body.preset];
          if (!tc && typeof body.baseSeconds === 'number') {
            tc = {
              preset: 'custom',
              baseSeconds: Math.max(10, Math.min(7200, body.baseSeconds)),
              incrementSeconds: Math.max(0, Math.min(60, body.incrementSeconds || 0)),
              name: `Custom ${Math.floor(body.baseSeconds / 60)}+${body.incrementSeconds || 0}`
            };
          }
          if (!tc) {
            sendJsonError(res, 400, 'Invalid preset or baseSeconds');
            return;
          }
          const ref = referee.getReferee(targetRoom);
          if (!ref) {
            sendJsonError(res, 500, 'Referee unavailable');
            return;
          }
          ref.enqueue({ id: 'tc-' + Date.now() + '-' + Math.random().toString(36).slice(2), type: 'time-control', args: tc }).then(r => {
            broadcastRoomStateToSSEClients(targetRoom);
            sendJson(res, 200, r);
          }).catch(err => sendJsonError(res, 500, err.message));
        }).catch(() => sendJsonError(res, 413, 'request body too large'));
        return;
      }
      if (req.method === 'GET' && urlPath === '/api/chat') {
        const targetRoom = new URLSearchParams(req.url.split('?')[1] || '').get('room') || roomId;
        const ref = referee.getReferee(targetRoom);
        sendJson(res, 200, { ok: true, messages: ref ? ref.getChatMessages() : [] });
        return;
      }
      if (req.method === 'POST' && urlPath === '/api/chat') {
        const targetRoom = new URLSearchParams(req.url.split('?')[1] || '').get('room') || roomId;
        readJsonBody(req).then(body => {
          if (!body || !body.text || typeof body.text !== 'string' || !body.text.trim()) {
            sendJsonError(res, 400, 'Message text is required');
            return;
          }
          const ref = referee.getReferee(targetRoom);
          if (!ref) {
            sendJsonError(res, 500, 'Referee unavailable');
            return;
          }
          const msg = ref.addChatMessage(body.sender || 'Player', body.text.trim());
          broadcastRoomEventToSSEClients(targetRoom, 'chat', msg);
          sendJson(res, 201, { ok: true, message: msg });
        }).catch(() => sendJsonError(res, 413, 'request body too large'));
        return;
      }
      if (req.method === 'POST' && urlPath.startsWith('/api/rematch/')) {
        const action = urlPath.replace('/api/rematch/', '');
        if (!['offer', 'accept', 'decline'].includes(action)) {
          sendJsonError(res, 404, 'Unknown rematch action');
          return;
        }
        const targetRoom = new URLSearchParams(req.url.split('?')[1] || '').get('room') || roomId;
        const authHeader = req.headers['authorization'];
        const token = req.headers['x-seat-token'] || ((authHeader && authHeader.startsWith('Bearer ')) ? authHeader.slice(7).trim() : null);
        const validation = seatAuthManager.validateMutation(targetRoom, token);
        if (!validation.ok) {
          sendJson(res, validation.status || 403, { ok: false, error: validation.error });
          return;
        }
        const role = seatAuthManager.getRole(targetRoom, token) || 'white';
        const ref = referee.getReferee(targetRoom);
        if (!ref) {
          sendJsonError(res, 500, 'Referee unavailable');
          return;
        }
        ref.enqueue({ id: 'rematch-' + Date.now() + '-' + Math.random().toString(36).slice(2), type: 'rematch', args: { action, color: role } }).then(r => {
          broadcastRoomStateToSSEClients(targetRoom);
          botService.triggerBotMoveIfNeeded(targetRoom, referee, (eventType, payload) => {
            if (eventType === 'chat') {
              broadcastRoomEventToSSEClients(targetRoom, 'chat', payload);
            } else {
              broadcastRoomStateToSSEClients(targetRoom);
            }
          });
          sendJson(res, 200, r);
        }).catch(err => sendJsonError(res, 500, err.message));
        return;
      }
      if (req.method === 'GET' && urlPath === '/api/bot') {
        const targetRoom = new URLSearchParams(req.url.split('?')[1] || '').get('room') || roomId;
        sendJson(res, 200, { ok: true, bot: botService.getBotConfig(targetRoom), levels: BOT_LEVELS });
        return;
      }
      if (req.method === 'POST' && urlPath === '/api/bot') {
        const targetRoom = new URLSearchParams(req.url.split('?')[1] || '').get('room') || roomId;
        readJsonBody(req).then(body => {
          if (!body) {
            sendJsonError(res, 400, 'Invalid JSON body');
            return;
          }
          const result = botService.setBotConfig(targetRoom, body);
          botService.triggerBotMoveIfNeeded(targetRoom, referee, (eventType, payload) => {
            if (eventType === 'chat') {
              broadcastRoomEventToSSEClients(targetRoom, 'chat', payload);
            } else {
              broadcastRoomStateToSSEClients(targetRoom);
            }
          });
          sendJson(res, 200, result);
        }).catch(() => sendJsonError(res, 413, 'request body too large'));
        return;
      }
      if (req.method === 'GET' && urlPath === '/api/games') {
        handleGetGamesEndpoint(req, res);
        return;
      }
      if (req.method === 'POST' && urlPath === '/api/games') {
        handlePostGameEndpoint(req, res);
        return;
      }
      const gamePgnMatch = urlPath.match(/^\/api\/games\/([^/?#]+)\/pgn$/);
      if (req.method === 'GET' && gamePgnMatch) {
        handleGetGamePgnEndpoint(req, res, decodeURIComponent(gamePgnMatch[1]));
        return;
      }
      const gameIdMatch = urlPath.match(/^\/api\/games\/([^/?#]+)$/);
      if (req.method === 'GET' && gameIdMatch) {
        handleGetGameEndpoint(req, res, decodeURIComponent(gameIdMatch[1]));
        return;
      }
      if (require('./src/routes-review.js').handleReviewRoute(req, res, urlPath, { sendJson, sendJsonError, readJsonBody, gameArchive, referee })) return; // Wave 3 N1.3: /api/games/:id/missed-tactics, /api/review/missed-tactics

      if (require('./src/routes-openings.js').handleOpeningsRoute(req, res, urlPath, { sendJson, sendJsonError, readJsonBody })) return; // Wave 2 E3: /api/openings/*, /api/fen/validate

      if (require('./src/routes-puzzles.js').handlePuzzleRoute(req, res, urlPath, { sendJson, sendJsonError, readJsonBody, getAuthUser, parseCookies, gameArchive })) return; // Wave 2 E4: /api/puzzle/*
      if (SocialRoutes.handleSocialRoute(req, res, urlPath, { getAuthUser, sendJson, sendJsonError, readBody, maxBodyBytes: MAX_BODY_BYTES, referee, seatAuth: seatAuthManager, isValidRoomId, accountsManager, gameArchive, ratingsStore: ratingHook.store, botService })) return; // Wave 2 R2: lobby/leaderboard/arena/social routes
      if (require('./src/routes-library.js').handleLibraryRoute(req, res, urlPath, { getAuthUser, sendJson, sendJsonError, readBody, maxBodyBytes: MAX_BODY_BYTES, gameArchive })) return; // Wave 3: /api/library, /api/library/claim, /api/import/*
      if (RetentionRoutes.handleRetentionRoute(req, res, urlPath, { getAuthUser, sendJson, sendJsonError, readJsonBody, gameArchive, referee, accountsManager })) return; // Wave 3 N2: /api/streak, /api/activity, /api/achievements
      if (require('./src/routes-insights.js').handleInsightsRoute(req, res, urlPath, { getAuthUser, sendJson, sendJsonError, readBody, maxBodyBytes: MAX_BODY_BYTES, gameArchive })) return; // Wave 3 N2.8/N3.15: /api/insights*, /api/league*

      sendJsonError(res, 404, 'not found');
      return;
    }

    let decodedPath = '';
    try {
      decodedPath = decodeURIComponent(urlPath);
    } catch (_) {
      sendJsonError(res, 400, 'bad request');
      return;
    }

    let reqPath = decodedPath;
    const gameMatch = reqPath.match(/^\/game\/([a-zA-Z0-9_-]+)(?:\/(.*))?$/);
    if (gameMatch) {
      const subPath = gameMatch[2];
      if (!subPath || subPath === '') {
        reqPath = '/index.html';
      } else {
        reqPath = '/' + subPath;
      }
    } else if (reqPath === '/') {
      reqPath = '/index.html';
    }

    if (isDotfile(reqPath) || isDotfile(decodedPath)) {
      sendJsonError(res, 403, 'forbidden');
      return;
    }

    const filePath = isPathAllowed(reqPath);
    if (!filePath) {
      sendJsonError(res, 404, 'not found');
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        sendJsonError(res, 404, 'not found');
        return;
      }
      const ext = path.extname(filePath);
      const mime = MIME[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', mime);

      // D2: conditional caching for immutable-by-path static assets under
      // src/ and assets/. index.html, service-worker.js, the manifest and
      // the licence keep the global no-store/no-cache policy so the SW is
      // always revalidated and new deploys are picked up immediately.
      const rel = path.relative(SERVED_ROOT, filePath).split(path.sep).join('/');
      // D1: Vary must be declared on 304s too, so set it before the
      // freshness check; Content-Encoding is only set on a full response.
      const encoding = pickContentEncoding(req, mime);
      if (COMPRESSIBLE_MIME.has(mime)) appendVary(res, 'Accept-Encoding');
      if (isRevalidatableStatic(rel)) {
        const etag = weakEtag(stats);
        const lastModified = stats.mtime.toUTCString();
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
        res.setHeader('ETag', etag);
        res.setHeader('Last-Modified', lastModified);
        if (isFreshRequest(req, etag, stats.mtime)) {
          res.statusCode = 304;
          res.end();
          return;
        }
      }

      // D1: negotiated compression for text-like static responses.
      if (encoding) res.setHeader('Content-Encoding', encoding);

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      const stream = fs.createReadStream(filePath);
      if (encoding) {
        const compressor = encoding === 'br'
          ? zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
          : zlib.createGzip({ level: 6 });
        stream.on('error', () => { try { res.destroy(); } catch (_) { /* ignore */ } });
        stream.pipe(compressor).pipe(res);
        return;
      }
      stream.pipe(res);
    });
  });
}

module.exports = {
  createServer,
  stopStateWatcher,
  readRoomStateJson,
  readStateJson,
  getRoomStateFile,
  extractRoomId,
  isValidRoomId,
  seatAuthManager,
  gameArchive,
  checkRateLimit,
  botService,
  BOT_LEVELS,
  applySecurityHeaders,
  buildCsp,
  isBehindTls,
  loadRateLimit,
  persistRateLimit,
  rateLimitKey,
  getRoomSseLog: (roomId) => roomSseLog.get(roomId) || [],
  getRoomSseSeq: (roomId) => roomSseSeq.get(roomId) || 0,
  clearRoomSseState: (roomId) => {
    roomSseLog.delete(roomId);
    roomSseSeq.delete(roomId);
  },
  accountsManager,
  Accounts,
  ratingHook,
  SocialRoutes,
  // Wave 3 room GC
  gcRooms,
  listRooms: () => listRooms().map(publicRoom),
  startRoomGc,
  stopRoomGc,
  touchRoom,
  ROOM_GC_CONFIG
};

if (require.main === module) {
  const port = process.env.PORT ? Number(process.env.PORT) : (process.env.CHESS_PORT ? Number(process.env.CHESS_PORT) : PORT);
  const host = process.env.HOST || '0.0.0.0';
  createServer().listen(port, host, () => {
    console.log(`Chess server running at http://${host}:${port}`);
    startRoomGc(); // Wave 3: boot sweep + periodic auto-room GC (CHESS_ROOM_GC=0 disables)
  });
}
