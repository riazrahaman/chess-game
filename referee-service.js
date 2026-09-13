const engine = require('./engine.js');
const rulesEngine = require('./rules-engine.js');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const STATE_FILE = process.env.CHESS_STATE_FILE || path.join(DIR, '.referee-state.json');
const JOURNAL_FILE = process.env.CHESS_JOURNAL_FILE || path.join(DIR, '.referee-journal.jsonl');

const CLOCK_START_SECONDS = 600;
const CLOCK_INCREMENT_SECONDS = 15;
const configuredMoveCost = Number(process.env.CHESS_MOVE_TIME_COST);
const MOVE_TIME_COST_SECONDS = Number.isFinite(configuredMoveCost) && configuredMoveCost >= 0
  ? configuredMoveCost : 1.0;

function defaultClocks() {
  return { white: CLOCK_START_SECONDS, black: CLOCK_START_SECONDS };
}

function ensureClocks(s) {
  if (!s.clocks || typeof s.clocks.white !== 'number' || typeof s.clocks.black !== 'number') {
    s.clocks = defaultClocks();
  }
  if (typeof s.gameOver !== 'boolean') s.gameOver = false;
  if (!s.status) s.status = 'ongoing';
  if (!Object.prototype.hasOwnProperty.call(s, 'result')) s.result = null;
  if (!Object.prototype.hasOwnProperty.call(s, 'flagged')) s.flagged = null;
  if (!Object.prototype.hasOwnProperty.call(s, 'resigned')) s.resigned = null;
  if (!Object.prototype.hasOwnProperty.call(s, 'draw')) s.draw = false;
  if (typeof s.fen !== 'string' || !s.fen) {
    try { s.fen = rulesEngine.boardToFen(s.board); } catch (_) { s.fen = null; }
  }
  return s;
}

function newGame() {
  const board = engine.createInitialBoard();
  const s = {
    board,
    history: [],
    clocks: defaultClocks(),
    gameOver: false,
    status: 'ongoing',
    result: null,
    flagged: null,
    resigned: null,
    draw: false,
    fen: rulesEngine.boardToFen(board)
  };
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
  s.fen = rulesEngine.boardToFen(s.board);
  return s;
}

function atomicSaveSnapshot(s) {
  const tmp = STATE_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function appendJournal(entry) {
  fs.appendFileSync(JOURNAL_FILE, JSON.stringify(entry) + '\n');
}

function readJournal() {
  try {
    const raw = fs.readFileSync(JOURNAL_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const entries = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch (_) { /* skip malformed */ }
    }
    return entries;
  } catch (e) {
    return [];
  }
}

function normalizeMove(moveStr, s) {
  let normalized = String(moveStr);
  const turn = s.board.turn;
  const moves = allLegalMoves(s.board, turn);
  if (normalized.length === 4 && !moves.includes(normalized)) {
    const fromSq = normalized.slice(0, 2);
    const toSq = normalized.slice(2, 4);
    const pc = s.board.pieces[fromSq];
    if (pc && pc.type === 'p') {
      const lastRank = pc.color === 'white' ? '8' : '1';
      if (toSq[1] === lastRank && moves.includes(normalized + 'q')) {
        normalized = normalized + 'q';
      }
    }
  }
  return { normalized, moves };
}

function applyMove(s, moveStr) {
  const turn = s.board.turn;
  s.clocks[turn] = Math.max(0, s.clocks[turn] - MOVE_TIME_COST_SECONDS);
  if (s.clocks[turn] <= 0) {
    s.gameOver = true;
    s.status = 'timeout';
    s.flagged = turn;
    s.result = turn === 'white' ? '0-1 on time' : '1-0 on time';
    return { flagged: true };
  }
  const from = moveStr.slice(0, 2);
  const to = moveStr.slice(2, 4);
  const promo = moveStr.length > 4 ? moveStr[4] : undefined;
  s.board = engine.makeMove(s.board, from, to, promo);
  s.history.push(moveStr);
  s.clocks[turn] = Math.min(CLOCK_START_SECONDS, s.clocks[turn] + CLOCK_INCREMENT_SECONDS);
  const nextTurn = s.board.turn;
  const status = engine.getGameStatus(s.board, nextTurn);
  s.status = status;
  s.gameOver = status === 'checkmate' || status === 'stalemate';
  if (status === 'checkmate') s.result = nextTurn === 'white' ? '0-1' : '1-0';
  if (status === 'stalemate') s.result = '½-½';
  s.fen = rulesEngine.boardToFen(s.board);
  return { flagged: false };
}

function stateView(s) {
  return {
    gameOver: s.gameOver,
    status: s.status,
    result: s.result,
    flagged: s.flagged,
    resigned: s.resigned,
    draw: s.draw,
    clocks: s.clocks,
    board: renderAscii(s.board),
    history: historyStr(s.history),
    plyCount: s.history.length
  };
}

class RefereeService {
  constructor() {
    this.state = null;
    this.revision = 0;
    this._tail = Promise.resolve();
    this._idempotency = new Map();
    this._journalSeq = 0;
    this._lastSnapshotMtime = 0;
    this._boot();
  }

  _boot() {
    let snapshot = null;
    let snapMtime = 0;
    try {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      snapshot = ensureClocks(JSON.parse(raw));
      snapMtime = fs.statSync(STATE_FILE).mtimeMs;
    } catch (_) { /* no snapshot */ }

    const journal = readJournal();

    if (snapshot) {
      this.state = snapshot;
    } else {
      this.state = newGame();
      atomicSaveSnapshot(this.state);
      snapMtime = fs.statSync(STATE_FILE).mtimeMs;
    }
    this._lastSnapshotMtime = snapMtime;
    this.revision = 0;
    this._journalSeq = 0;

    for (const entry of journal) {
      if (entry.seq > this._journalSeq) this._journalSeq = entry.seq;
      this._applyJournalEntry(entry);
    }
    this._journalSeq = journal.length;
    this.revision = this._computeRevision();
  }

  _checkExternalChange() {
    try {
      const mtime = fs.statSync(STATE_FILE).mtimeMs;
      if (mtime !== this._lastSnapshotMtime) {
        this._rebootFromSnapshotOnly();
      }
    } catch (_) { /* file gone — keep current state */ }
  }

  _rebootFromSnapshotOnly() {
    let snapshot = null;
    let snapMtime = 0;
    try {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      snapshot = ensureClocks(JSON.parse(raw));
      snapMtime = fs.statSync(STATE_FILE).mtimeMs;
    } catch (_) { /* no snapshot */ }
    if (snapshot) {
      this.state = snapshot;
      this._lastSnapshotMtime = snapMtime;
      this.revision = this._computeRevision();
      this._idempotency = new Map();
    }
  }

  _computeRevision() {
    let rev = this.state.history.length;
    if (this.state.gameOver) rev++;
    if (this.state.draw) rev++;
    return rev;
  }

  _applyJournalEntry(entry) {
    if (entry.type === 'reset') {
      this.state = newGame();
    } else if (entry.type === 'move') {
      const { normalized } = normalizeMove(entry.args.move, this.state);
      const moves = allLegalMoves(this.state.board, this.state.board.turn);
      if (moves.includes(normalized) && !this.state.gameOver) {
        applyMove(this.state, normalized);
      }
    } else if (entry.type === 'undo') {
      if (this.state.history.length > 0) {
        this.state = rebuildState(this.state.history.slice(0, -1));
      }
    } else if (entry.type === 'resign') {
      const color = entry.args.color;
      if (['white', 'black'].includes(color) && !this.state.gameOver) {
        this.state.gameOver = true;
        this.state.status = 'resigned';
        this.state.resigned = color;
        this.state.result = color === 'white' ? '0-1' : '1-0';
      }
    } else if (entry.type === 'draw') {
      if (!this.state.gameOver) {
        this.state.gameOver = true;
        this.state.status = 'draw';
        this.state.draw = true;
        this.state.result = '½-½';
      }
    }
  }

  enqueue(command) {
    if (!command || (typeof command.id !== 'string' && typeof command.id !== 'number')) {
      return Promise.resolve({ ok: false, error: 'command missing id', httpStatus: 400 });
    }
    const id = String(command.id);
    if (this._idempotency.has(id)) {
      return Promise.resolve(this._idempotency.get(id));
    }
    const expectedRevision = command.expectedRevision;
    this._tail = this._tail.then(() => {
      if (this._idempotency.has(id)) {
        return this._idempotency.get(id);
      }
      this._checkExternalChange();
      if (this._idempotency.has(id)) {
        return this._idempotency.get(id);
      }
      if (typeof expectedRevision === 'number' && expectedRevision !== this.revision) {
        const conflict = {
          ok: false,
          error: 'revision conflict',
          httpStatus: 409,
          expectedRevision,
          actualRevision: this.revision
        };
        this._idempotency.set(id, conflict);
        return conflict;
      }
      let result;
      try {
        result = this._dispatch(command);
      } catch (e) {
        result = { ok: false, error: String(e && e.message || e), httpStatus: 500 };
      }
      result = Object.assign({ revision: this.revision }, result);
      this._idempotency.set(id, result);
      return result;
    }).catch(err => {
      const result = { ok: false, error: String(err && err.message || err), httpStatus: 500, revision: this.revision };
      this._idempotency.set(id, result);
      return result;
    });
    return this._tail;
  }

  _dispatch(command) {
    switch (command.type) {
      case 'move': return this._cmdMove(command.args || {});
      case 'undo': return this._cmdUndo();
      case 'resign': return this._cmdResign((command.args || {}).color);
      case 'draw': return this._cmdDraw();
      case 'reset': return this._cmdReset();
      default: return { ok: false, error: 'unknown command type: ' + command.type, httpStatus: 400 };
    }
  }

  _journalAndSnapshot(type, args) {
    this._journalSeq++;
    appendJournal({ seq: this._journalSeq, id: this._journalSeq, type, args, ts: Date.now() });
    atomicSaveSnapshot(this.state);
    try { this._lastSnapshotMtime = fs.statSync(STATE_FILE).mtimeMs; } catch (_) {}
    this.revision = this._computeRevision();
  }

  _cmdMove(args) {
    const s = this.state;
    if (s.gameOver) {
      return Object.assign({ ok: false, error: 'game over', httpStatus: 409 }, stateView(s));
    }
    const { normalized, moves } = normalizeMove(String(args.move || ''), s);
    if (!moves.includes(normalized)) {
      return { ok: false, error: 'illegal move', moveStr: String(args.move || ''), legalMoves: moves, httpStatus: 400 };
    }
    const r = applyMove(s, normalized);
    this._journalAndSnapshot('move', { move: normalized });
    if (r.flagged) {
      return Object.assign({ ok: false, error: 'flagged', httpStatus: 409 }, stateView(s));
    }
    return Object.assign({ ok: true, applied: normalized, nextTurn: s.board.turn }, stateView(s));
  }

  _cmdUndo() {
    const s = this.state;
    if (s.history.length === 0) {
      return Object.assign({ ok: true, undone: false, noOp: true }, stateView(s));
    }
    this.state = rebuildState(s.history.slice(0, -1));
    this._journalAndSnapshot('undo', {});
    return Object.assign({ ok: true, undone: true }, stateView(this.state));
  }

  _cmdResign(color) {
    const s = this.state;
    if (!['white', 'black'].includes(color)) {
      return { ok: false, error: 'invalid resigning color', httpStatus: 400 };
    }
    if (s.gameOver) {
      return Object.assign({ ok: false, error: 'game over', httpStatus: 409 }, stateView(s));
    }
    s.gameOver = true;
    s.status = 'resigned';
    s.resigned = color;
    s.result = color === 'white' ? '0-1' : '1-0';
    this._journalAndSnapshot('resign', { color });
    return Object.assign({ ok: true, resigned: color }, stateView(s));
  }

  _cmdDraw() {
    const s = this.state;
    if (s.gameOver) {
      return Object.assign({ ok: false, error: 'game over', httpStatus: 409 }, stateView(s));
    }
    s.gameOver = true;
    s.status = 'draw';
    s.draw = true;
    s.result = '½-½';
    this._journalAndSnapshot('draw', {});
    return Object.assign({ ok: true, draw: true }, stateView(s));
  }

  _cmdReset() {
    this.state = newGame();
    this._journalAndSnapshot('reset', {});
    return { ok: true, reset: true };
  }

  getState() {
    return this.state;
  }

  getRevision() {
    return this.revision;
  }
}

let _instance = null;
function getReferee() {
  if (!_instance) _instance = new RefereeService();
  return _instance;
}

function resetInstance() {
  _instance = null;
}

module.exports = {
  RefereeService,
  getReferee,
  resetInstance,
  atomicSaveSnapshot,
  newGame,
  ensureClocks,
  allLegalMoves,
  renderAscii,
  historyStr,
  rebuildState,
  CLOCK_START_SECONDS,
  CLOCK_INCREMENT_SECONDS,
  MOVE_TIME_COST_SECONDS,
  STATE_FILE,
  JOURNAL_FILE
};