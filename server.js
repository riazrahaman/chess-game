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

module.exports = { createServer };

if (require.main === module) {
  const port = process.env.CHESS_PORT ? Number(process.env.CHESS_PORT) : PORT;
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`Chess server running at http://127.0.0.1:${port}`);
    });
}
