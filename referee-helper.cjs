const engine = require('./engine.js');
const fs = require('fs');
const path = require('path');

// Per-working-directory referee state. __dirname keeps each git worktree
// (tier-a..tier-d under .tier-worktrees/) self-contained: a fresh checkout of a
// tier branch has its OWN .referee-state.json + .lock, independent of the main
// repo. Never hard-code an absolute path here.
const STATE_FILE = process.env.CHESS_STATE_FILE || path.join(__dirname, '.referee-state.json');
const LOCK_FILE = STATE_FILE + '.lock';

// Single source of truth for clock constants (C1).
// index.html badges, ui.js rendering, and referee increments all derive from these.
const CLOCK_START_SECONDS = 600; // 10:00
const CLOCK_INCREMENT_SECONDS = 15;
const configuredMoveCost = Number(process.env.CHESS_MOVE_TIME_COST);
const MOVE_TIME_COST_SECONDS = Number.isFinite(configuredMoveCost) && configuredMoveCost >= 0
  ? configuredMoveCost : 1.0;

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  return ensureClocks(s);
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function defaultClocks() {
  return { white: CLOCK_START_SECONDS, black: CLOCK_START_SECONDS };
}
function ensureClocks(s) {
  // Backfill clocks for legacy state files that predate C1.
  if (!s.clocks || typeof s.clocks.white !== 'number' || typeof s.clocks.black !== 'number') {
    s.clocks = defaultClocks();
  }
  if (typeof s.gameOver !== 'boolean') s.gameOver = false;
  if (!s.status) s.status = 'ongoing';
  if (!Object.prototype.hasOwnProperty.call(s, 'result')) s.result = null;
  if (!Object.prototype.hasOwnProperty.call(s, 'flagged')) s.flagged = null;
  if (!Object.prototype.hasOwnProperty.call(s, 'resigned')) s.resigned = null;
  if (!Object.prototype.hasOwnProperty.call(s, 'draw')) s.draw = false;
  return s;
}
function newGame() {
  const s = {
    board: engine.createInitialBoard(),
    history: [],
    clocks: defaultClocks(),
    gameOver: false,
    status: 'ongoing',
    result: null,
    flagged: null,
    resigned: null,
    draw: false
  };
  saveState(s);
  return s;
}

function allLegalMoves(board, turn) {
  const moves = [];
  for (const sq of Object.keys(board.pieces)) {
    const p = board.pieces[sq];
    if (!p || p.color !== turn) continue;
    const dests = engine.getLegalMoves(board, sq, turn);
    for (const to of dests) {
      const lastRank = to[1];
      if (p.type === 'p' && (lastRank === '8' || lastRank === '1')) {
        for (const promo of ['q', 'r', 'b', 'n']) moves.push(sq + to + promo);
      } else {
        moves.push(sq + to);
      }
    }
  }
  return moves;
}

function renderAscii(board) {
  let out = '';
  for (let r = 8; r >= 1; r--) {
    let row = String(r) + ' ';
    for (let f = 0; f < 8; f++) {
      const sq = String.fromCharCode(97 + f) + r;
      const p = board.pieces[sq];
      if (!p) { row += '. '; continue; }
      let ch = p.type;
      if (p.color === 'white') ch = ch.toUpperCase();
      row += ch + ' ';
    }
    out += row + '\n';
  }
  out += '  a b c d e f g h\n';
  return out;
}

function historyStr(history) {
  let out = '';
  for (let i = 0; i < history.length; i += 2) {
    const num = i / 2 + 1;
    out += `${num}. ${history[i]}` + (history[i + 1] ? ` ${history[i + 1]}` : '') + ' ';
  }
  return out.trim();
}

// Cross-process advisory lock so concurrent referee-helper invocations
// (from /api/move, undo, resign, draw, reset) serialize their
// read-modify-write on STATE_FILE. Without it two near-simultaneous
// moves could both read the same board and clobber each other.
function acqLock() {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Stale lock: owner process dead or lock older than 10s.
      let ownerPid = 0, mtime = 0;
      try { ownerPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim() || '0', 10); } catch (_) {}
      try { mtime = fs.statSync(LOCK_FILE).mtimeMs; } catch (_) {}
      const ownerAlive = !Number.isNaN(ownerPid) && ownerPid > 0 && (() => {
        try { process.kill(ownerPid, 0); return true; } catch (_) { return false; }
      })();
      if (!ownerAlive || Date.now() - mtime > 10000) {
        try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error('referee lock timeout after 5000ms (owner ' + ownerPid + (ownerAlive ? ' alive' : ' dead') + ')');
      }
      const wait = 5 + Math.floor(Math.random() * 5);
      const t = Date.now() + wait;
      while (Date.now() < t) {}
    }
  }
}
function relLock() {
  try {
    const owner = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim() || '0', 10);
    if (owner === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (_) {}
}

function rebuildState(history) {
  const s = newGame();
  s.history = [];
  for (const moveStr of history) {
    const from = moveStr.slice(0, 2);
    const to = moveStr.slice(2, 4);
    const promo = moveStr[4];
    const mover = s.board.turn;
    s.clocks[mover] = Math.max(0, s.clocks[mover] - MOVE_TIME_COST_SECONDS);
    s.board = engine.makeMove(s.board, from, to, promo);
    s.history.push(moveStr);
    s.clocks[mover] = Math.min(CLOCK_START_SECONDS, s.clocks[mover] + CLOCK_INCREMENT_SECONDS);
  }
  const status = engine.getGameStatus(s.board, s.board.turn);
  s.status = status;
  s.gameOver = status === 'checkmate' || status === 'stalemate';
  s.result = status === 'checkmate' ? (s.board.turn === 'white' ? '0-1' : '1-0')
    : status === 'stalemate' ? '½-½' : null;
  return s;
}

// Every mutating command (move/undo/resign/draw/reset) takes the lock for the
// whole read-modify-write. The 'exit' handler guarantees release on any exit
// path, including the explicit process.exit(1) calls below; relLock is guarded
// by pid so a second release is a harmless no-op.
acqLock();
process.once('exit', relLock);

const cmd = process.argv[2];

if (cmd === 'status') {
  let s = loadState();
  if (!s) s = newGame();
  const turn = s.board.turn;
  const moves = s.gameOver ? [] : allLegalMoves(s.board, turn);
  const status = s.gameOver ? s.status : engine.getGameStatus(s.board, turn);
  console.log(JSON.stringify({
    turn, status, gameOver: s.gameOver, result: s.result, flagged: s.flagged,
    resigned: s.resigned, draw: s.draw,
    legalMoves: moves,
    clocks: s.clocks,
    board: renderAscii(s.board),
    history: historyStr(s.history),
    plyCount: s.history.length
  }, null, 2));
} else if (cmd === 'move') {
  let moveStr = process.argv[3];
  let s = loadState();
  if (!s) s = newGame();
  const turn = s.board.turn;
  if (s.gameOver) {
    console.log(JSON.stringify({
      ok: false, error: 'game over', gameOver: true, status: s.status,
      result: s.result, flagged: s.flagged, clocks: s.clocks,
      board: renderAscii(s.board), history: historyStr(s.history), plyCount: s.history.length
    }, null, 2));
    process.exit(1);
  }
  let moves = allLegalMoves(s.board, turn);
  // C2: backward compat — a bare coordinate that is a pawn promotion and has
  // no promo suffix defaults to queen (e.g. "h2h1" == "h2h1q").
  if (moveStr.length === 4 && !moves.includes(moveStr)) {
    const fromSq = moveStr.slice(0, 2);
    const toSq = moveStr.slice(2, 4);
    const pc = s.board.pieces[fromSq];
    if (pc && pc.type === 'p') {
      const lastRank = pc.color === 'white' ? '8' : '1';
      if (toSq[1] === lastRank && moves.includes(moveStr + 'q')) {
        moveStr = moveStr + 'q';
      }
    }
  }
  if (!moves.includes(moveStr)) {
    console.log(JSON.stringify({ ok: false, error: 'illegal move', moveStr, legalMoves: moves }));
    process.exit(1);
  }
  // The referee consumes the active player's time. A move that exhausts the
  // clock flags that player and is not applied to the board.
  s.clocks[turn] = Math.max(0, s.clocks[turn] - MOVE_TIME_COST_SECONDS);
  if (s.clocks[turn] <= 0) {
    s.gameOver = true;
    s.status = 'timeout';
    s.flagged = turn;
    s.result = turn === 'white' ? '0-1 on time' : '1-0 on time';
    saveState(s);
    console.log(JSON.stringify({
      ok: false, error: 'flagged', gameOver: true, status: s.status,
      result: s.result, flagged: s.flagged, clocks: s.clocks,
      board: renderAscii(s.board), history: historyStr(s.history), plyCount: s.history.length
    }, null, 2));
    process.exit(1);
  }
  const from = moveStr.slice(0, 2);
  const to = moveStr.slice(2, 4);
  const promo = moveStr.length > 4 ? moveStr[4] : undefined;
  s.board = engine.makeMove(s.board, from, to, promo);
  s.history.push(moveStr);
  // C1: referee owns clock state; award mover's increment, capped at start.
  s.clocks[turn] = Math.min(CLOCK_START_SECONDS, s.clocks[turn] + CLOCK_INCREMENT_SECONDS);
  s.status = 'ongoing';
  const nextTurn = s.board.turn;
  const status = engine.getGameStatus(s.board, nextTurn);
  s.status = status;
  s.gameOver = status === 'checkmate' || status === 'stalemate';
  if (status === 'checkmate') s.result = nextTurn === 'white' ? '0-1' : '1-0';
  if (status === 'stalemate') s.result = '½-½';
  saveState(s);
  console.log(JSON.stringify({
    ok: true, applied: moveStr, nextTurn, status, gameOver: s.gameOver,
    result: s.result, flagged: s.flagged,
    clocks: s.clocks,
    board: renderAscii(s.board),
    history: historyStr(s.history),
    plyCount: s.history.length
  }, null, 2));
} else if (cmd === 'resign') {
  const color = process.argv[3];
  let s = loadState();
  if (!s) s = newGame();
  if (!['white', 'black'].includes(color)) {
    console.log(JSON.stringify({ ok: false, error: 'invalid resigning color' }));
    process.exit(1);
  }
  if (s.gameOver) {
    console.log(JSON.stringify({ ok: false, error: 'game over', gameOver: true, result: s.result }));
    process.exit(1);
  }
  s.gameOver = true;
  s.status = 'resigned';
  s.resigned = color;
  s.result = color === 'white' ? '0-1' : '1-0';
  saveState(s);
  console.log(JSON.stringify({ ok: true, gameOver: true, status: s.status, result: s.result, resigned: color,
    clocks: s.clocks, board: renderAscii(s.board), history: historyStr(s.history), plyCount: s.history.length }, null, 2));
} else if (cmd === 'draw') {
  let s = loadState();
  if (!s) s = newGame();
  if (s.gameOver) {
    console.log(JSON.stringify({ ok: false, error: 'game over', gameOver: true, result: s.result }));
    process.exit(1);
  }
  s.gameOver = true;
  s.status = 'draw';
  s.draw = true;
  s.result = '½-½';
  saveState(s);
  console.log(JSON.stringify({ ok: true, gameOver: true, status: s.status, result: s.result, draw: true,
    clocks: s.clocks, board: renderAscii(s.board), history: historyStr(s.history), plyCount: s.history.length }, null, 2));
} else if (cmd === 'undo') {
  let s = loadState();
  if (!s) s = newGame();
  if (s.history.length === 0) {
    console.log(JSON.stringify({ ok: true, undone: false, noOp: true, gameOver: s.gameOver,
      status: s.status, result: s.result, clocks: s.clocks, board: renderAscii(s.board),
      history: historyStr(s.history), plyCount: s.history.length }, null, 2));
  } else {
    s = rebuildState(s.history.slice(0, -1));
    saveState(s);
    console.log(JSON.stringify({ ok: true, undone: true, gameOver: s.gameOver, status: s.status,
      result: s.result, clocks: s.clocks, board: renderAscii(s.board), history: historyStr(s.history),
      plyCount: s.history.length }, null, 2));
  }
} else if (cmd === 'reset') {
  newGame();
  console.log(JSON.stringify({ ok: true, reset: true }));
} else {
  console.log('usage: node referee-helper.cjs [status|move <coord>|resign <white|black>|draw|undo|reset]');
  process.exit(1);
}
