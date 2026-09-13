const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = 39281;
const DIR = __dirname;
const STATE_FILE = process.env.CHESS_STATE_FILE || path.join(DIR, '.referee-state.json');
const SSE_HEARTBEAT_MS = Number(process.env.CHESS_SSE_HEARTBEAT_MS) || 15000;
const SSE_WATCH_INTERVAL_MS = Number(process.env.CHESS_SSE_WATCH_INTERVAL_MS) || 250;

// D1: SSE client registry. Each connected client holds its res object and a
// per-connection heartbeat timer. A shared watcher (fs.watchFile) pushes state
// JSON to every client whenever the referee-state file content hash changes.
const sseClients = new Set();
let lastStateHash = '';
let watcherStarted = false;
let watcherRef = null;

function computeStateHash() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return crypto.createHash('sha256').update(raw).digest('hex');
  } catch (e) {
    return '';
  }
}

function readStateJson() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

function broadcastStateToSSEClients() {
  const hash = computeStateHash();
  if (hash === lastStateHash) return;
  lastStateHash = hash;
  const state = readStateJson();
  if (!state) return;
  const data = JSON.stringify(state);
  for (const client of sseClients) {
    try {
      client.res.write(`event: state\ndata: ${data}\n\n`);
    } catch (e) {
      removeSSEClient(client);
    }
  }
}

function startStateWatcher() {
  if (watcherStarted) return;
  watcherStarted = true;
  lastStateHash = computeStateHash();
  try {
    fs.watchFile(STATE_FILE, { interval: SSE_WATCH_INTERVAL_MS }, () => {
      broadcastStateToSSEClients();
    });
    watcherRef = () => fs.unwatchFile(STATE_FILE);
  } catch (e) {
    // fs.watchFile may not be available on all platforms; fall back to interval.
    const intervalId = setInterval(broadcastStateToSSEClients, SSE_WATCH_INTERVAL_MS);
    watcherRef = () => clearInterval(intervalId);
  }
}

function stopStateWatcher() {
  if (watcherRef) { watcherRef(); watcherRef = null; }
  watcherStarted = false;
}

function removeSSEClient(client) {
  sseClients.delete(client);
  if (client.heartbeatTimer) clearInterval(client.heartbeatTimer);
  try { client.res.end(); } catch (e) { /* already closed */ }
}

function handleSSEEndpoint(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write('\n');

  const client = { res, heartbeatTimer: null };
  sseClients.add(client);

  // Heartbeat: SSE comment lines keep the connection alive through proxies.
  client.heartbeatTimer = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (e) {
      removeSSEClient(client);
    }
  }, SSE_HEARTBEAT_MS);

  // Immediately push the current state so the client doesn't wait for a change.
  const state = readStateJson();
  if (state) {
    try {
      res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
    } catch (e) { /* ignore */ }
  }

  req.on('close', () => removeSSEClient(client));
  req.on('error', () => removeSSEClient(client));
}

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.css': 'text/css'
};

// C2/C4: move submission goes through the referee helper so the referee file
// stays the single source of truth. C4 timeout responses retain the helper's
// JSON body and receive HTTP 409. moveStr: 4-5 chars (e2e4, e7e8q).
function handleMoveEndpoint(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let moveStr = '';
    try {
      moveStr = String(JSON.parse(body).move || '');
     } catch (e) { /* fall through */ }
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(moveStr)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'bad move format' }));
      return;
      }
    execFile('node', [path.join(DIR, 'referee-helper.cjs'), 'move', moveStr], {
      cwd: DIR, env: process.env
    }, (err, stdout) => {
      res.setHeader('Content-Type', 'application/json');
      const payload = stdout ? stdout.toString() : JSON.stringify({ ok: false, error: 'referee produced no output' });
      res.statusCode = err ? 409 : 200;
      res.end(payload);
      });
    });
 }

function handleResetEndpoint(res) {
  execFile('node', [path.join(DIR, 'referee-helper.cjs'), 'reset'], { cwd: DIR }, (err, stdout) => {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = err ? 500 : 200;
    res.end(stdout ? stdout.toString() : JSON.stringify({ ok: false, error: 'referee produced no output' }));
    });
 }

function handleRefereeCommand(res, command, args = []) {
  execFile('node', [path.join(DIR, 'referee-helper.cjs'), command, ...args], {
    cwd: DIR, env: process.env
  }, (err, stdout) => {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = err ? 409 : 200;
    res.end(stdout ? stdout.toString() : JSON.stringify({ ok: false, error: 'referee produced no output' }));
    });
 }

function createServer() {
  return http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    if (req.method === 'GET' && req.url.split('?')[0] === '/api/events') { startStateWatcher(); handleSSEEndpoint(req, res); return; }
    if (req.method === 'POST' && req.url.split('?')[0] === '/api/move') { handleMoveEndpoint(req, res); return; }
    if (req.method === 'POST' && req.url.split('?')[0] === '/api/reset') { handleResetEndpoint(res); return; }
    if ((req.method === 'GET' || req.method === 'POST') && req.url.split('?')[0] === '/api/resign') {
      const query = new URL(req.url, 'http://127.0.0.1').searchParams;
      const color = query.has('w') ? 'white' : query.has('b') ? 'black' : query.get('color');
      handleRefereeCommand(res, 'resign', [color || '']);
      return;
     }
    if (req.method === 'POST' && req.url.split('?')[0] === '/api/draw') {
      handleRefereeCommand(res, 'draw');
      return;
     }
    if (req.method === 'POST' && req.url.split('?')[0] === '/api/undo') {
      handleRefereeCommand(res, 'undo');
      return;
     }

    let reqPath = req.url.split('?')[0];
    if (reqPath === '/') reqPath = '/index.html';

    const filePath = path.join(DIR, reqPath);
    if (!fs.existsSync(filePath)) {
      res.statusCode = 404;
      res.end('Not found');
      return;
     }

    const ext = path.extname(filePath);
    res.setHeader('Content-Type', MIME[ext] || 'text/plain');
    fs.createReadStream(filePath).pipe(res);
    });
 }

module.exports = { createServer, stopStateWatcher };

if (require.main === module) {
  const port = process.env.CHESS_PORT ? Number(process.env.CHESS_PORT) : PORT;
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`Chess server running at http://127.0.0.1:${port}`);
    });
}
