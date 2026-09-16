const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const referee = require('./referee-service.js');
const { seatAuthManager } = require('./seat-auth.js');
const gameArchive = require('./game-archive.js');
const { BotService, BOT_LEVELS } = require('./bot-service.js');
const botService = new BotService(seatAuthManager);

const PORT = 39281;
const DIR = __dirname;
const STATE_FILE = process.env.CHESS_STATE_FILE || path.join(DIR, '.referee-state.json');
const SSE_HEARTBEAT_MS = Number(process.env.CHESS_SSE_HEARTBEAT_MS) || 15000;
const SSE_WATCH_INTERVAL_MS = Number(process.env.CHESS_SSE_WATCH_INTERVAL_MS) || 250;

const DEFAULT_ALLOWED_ORIGINS = [
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`
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

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm'
};

const MAX_BODY_BYTES = 8192;

const SERVED_ROOT = DIR;

const ALLOWED_FILES = new Set([
  'index.html',
  'engine.js',
  'ui.js',
  'ui-sound.js',
  'ui-theme.js',
  'ui-annotations.js',
  'ui-archive.js',
  'pieces.js',
  'stockfish-worker.js',
  'stockfish.js',
  'stockfish.wasm',
  'move-review.js',
  'openings-db.js',
  'game-archive.js',
  'ai-coach.js',
  'game-report.js',
  'accessibility-voice.js',
  'rating.js',
  'ratings-pool.js',
  'lobby.js',
  'puzzle-service.js',
  'puzzle-rating.js',
  'puzzle-storm.js',
  'daily-puzzle.js',
  'study-tree.js',
  'openings-explorer.js',
  'puzzle-repetition.js',
  'eval-graph.js',
  'masters-db.js',
  'acpl.js',
  'puzzle-racer.js',
  'a11y-text-entry.js',
  'a11y-gestures.js',
  'voice-intents.js',
    'chess960.js',
    'time-control.js',
    'tablebase.js',
    'arena.js',
    'social-graph.js',
    'chat-upgrades.js',
    'correspondence.js',
    'personality-bots.js',
    'pov-export.js',
    'embed-viewer.js',
    'variants.js',
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
  return getAllowedOrigins().includes(origin);
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
  return !!(req.socket && req.socket.encrypted) || process.env.CHESS_HSTS === '1';
}

function buildCsp() {
  if (process.env.CHESS_CSP) return process.env.CHESS_CSP;
  // The app is a no-build-step vanilla JS SPA with one inline <script> (SW reg)
  // and an inline <style> block, and an optional WebAssembly engine path.
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "media-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ].join('; ');
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

function handleGetGameEndpoint(req, res, id) {
  const game = gameArchive.getGame(id);
  if (!game) {
    sendJsonError(res, 404, 'game not found');
    return;
  }
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  sendJson(res, 200, { ok: true, game });
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
      const clientIp = req.socket.remoteAddress || '127.0.0.1';
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

      const roomId = extractRoomId(req);
      if (!isValidRoomId(roomId)) {
        sendJsonError(res, 400, 'invalid room id');
        return;
      }

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
          const result = seatAuthManager.claimSeat(targetRoom, role);
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
      res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
      fs.createReadStream(filePath).pipe(res);
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
  }
};

if (require.main === module) {
  const port = process.env.CHESS_PORT ? Number(process.env.CHESS_PORT) : PORT;
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`Chess server running at http://127.0.0.1:${port}`);
  });
}
