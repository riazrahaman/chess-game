const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = 39281;
const DIR = __dirname;

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const MAX_BODY_BYTES = 8192;

const SERVED_ROOT = DIR;

const ALLOWED_FILES = new Set([
  'index.html',
  'engine.js',
  'ui.js',
  'pieces.js',
  'CBURNETT-LICENSE.txt'
]);

const ALLOWED_DIRS = new Set([
  'assets'
]);

function sendJsonError(res, statusCode, message) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: false, error: message }));
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

// C2/C4: move submission goes through the referee helper so the referee file
// stays the single source of truth. C4 timeout responses retain the helper's
// JSON body and receive HTTP 409. moveStr: 4-5 chars (e2e4, e7e8q).
function handleMoveEndpoint(req, res) {
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
    try {
      moveStr = String(JSON.parse(body).move || '');
    } catch (e) { /* fall through */ }
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(moveStr)) {
      sendJsonError(res, 400, 'bad move format');
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
  req.on('error', () => {
    if (!res.headersSent) sendJsonError(res, 400, 'request error');
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

function isApiRequest(urlPath) {
  return urlPath.startsWith('/api/');
}

function createServer() {
  return http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

    const urlPath = req.url.split('?')[0];

    if (req.method === 'POST' && urlPath === '/api/move') { handleMoveEndpoint(req, res); return; }
    if (req.method === 'POST' && urlPath === '/api/reset') { handleResetEndpoint(res); return; }
    if ((req.method === 'GET' || req.method === 'POST') && urlPath === '/api/resign') {
      const query = new URL(req.url, 'http://127.0.0.1').searchParams;
      const color = query.has('w') ? 'white' : query.has('b') ? 'black' : query.get('color');
      handleRefereeCommand(res, 'resign', [color || '']);
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/draw') {
      handleRefereeCommand(res, 'draw');
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/undo') {
      handleRefereeCommand(res, 'undo');
      return;
    }

    if (isApiRequest(urlPath)) {
      sendJsonError(res, 404, 'not found');
      return;
    }

    let reqPath = urlPath;
    if (reqPath === '/') reqPath = '/index.html';

    reqPath = decodeURIComponent(reqPath);

    if (isDotfile(reqPath)) {
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

module.exports = { createServer };

if (require.main === module) {
  const port = process.env.CHESS_PORT ? Number(process.env.CHESS_PORT) : PORT;
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`Chess server running at http://127.0.0.1:${port}`);
  });
}