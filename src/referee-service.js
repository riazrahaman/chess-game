const engine = require('./engine.js');
const rulesEngine = require('./rules-engine.js');
const timeControlMod = require('./time-control.js');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// M3: event-driven state-change bus. Emitted synchronously whenever the referee
// mutates state (move/undo/resign/draw/time-control/rematch/reset/timeout). This
// replaces the server's old 250ms fs-watch/hash poll: the referee is the single
// authoritative writer, so it can tell the SSE layer exactly when state changes.
const stateEmitter = new EventEmitter();
stateEmitter.setMaxListeners(0);

function onStateChange(listener) {
  stateEmitter.on('change', listener);
  return () => stateEmitter.removeListener('change', listener);
}

const DIR = path.join(__dirname, '..');
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

function defaultElapsed() {
  return { white: 0, black: 0 };
}

function ensureClocks(s) {
  if (!s.clocks || typeof s.clocks.white !== 'number' || typeof s.clocks.black !== 'number') {
    s.clocks = defaultClocks();
  }
  if (!s.elapsed || typeof s.elapsed.white !== 'number' || typeof s.elapsed.black !== 'number') {
    s.elapsed = defaultElapsed();
  }
  if (typeof s.moveStartTs !== 'number') s.moveStartTs = 0;
  if (!Array.isArray(s.moveTimestamps)) s.moveTimestamps = [];
  if (typeof s.gameOver !== 'boolean') s.gameOver = false;
  if (!s.status) s.status = 'ongoing';
  if (!Object.prototype.hasOwnProperty.call(s, 'result')) s.result = null;
  if (!Object.prototype.hasOwnProperty.call(s, 'flagged')) s.flagged = null;
  if (!Object.prototype.hasOwnProperty.call(s, 'resigned')) s.resigned = null;
  if (!Object.prototype.hasOwnProperty.call(s, 'draw')) s.draw = false;
  if (!Object.prototype.hasOwnProperty.call(s, 'drawReason')) s.drawReason = null;
  if (!Object.prototype.hasOwnProperty.call(s, 'drawOffer')) s.drawOffer = null;
  if (!Object.prototype.hasOwnProperty.call(s, 'rematchOffer')) s.rematchOffer = null;
  if (!s.timeControl) {
    s.timeControl = { preset: 'rapid_10_15', baseSeconds: CLOCK_START_SECONDS, incrementSeconds: CLOCK_INCREMENT_SECONDS, name: 'Rapid 10+15' };
  }
  if (typeof s.fen !== 'string' || !s.fen) {
    try { s.fen = rulesEngine.boardToFen(s.board); } catch (_) { s.fen = null; }
  }
  return s;
}

// B3: per-ply positions are referee-authoritative. Each entry is
// { fen, san, lastMove } for ply 0..n so the client never replays moves.
function positionEntry(board, moveStr, san) {
  let fen = null;
  try { fen = rulesEngine.boardToFen(board); } catch (_) {}
  return {
    fen,
    san: san || null,
    lastMove: moveStr ? { from: moveStr.slice(0, 2), to: moveStr.slice(2, 4) } : null
  };
}

function safeSan(board, moveStr) {
  try { return engine.moveToSan(board, moveStr); } catch (_) { return null; }
}

function refreshClaimableDraw(s) {
  if (s.gameOver) { s.claimableDraw = null; return; }
  try { s.claimableDraw = rulesEngine.claimableDraw(s.board, s.history); }
  catch (_) { s.claimableDraw = null; }
}

// Legacy snapshots (pre-B3) have no positions; rebuild from the standard start
// position when the replay lands on the snapshot's own FEN, otherwise expose
// only the current position so the scrubber degrades instead of lying.
function ensurePositions(s) {
  const want = (s.history ? s.history.length : 0) + 1;
  if (Array.isArray(s.positions) && s.positions.length === want) return s;
  const positions = [];
  try {
    let b = engine.createInitialBoard();
    positions.push(positionEntry(b, null, null));
    for (const moveStr of (s.history || [])) {
      const san = safeSan(b, moveStr);
      b = engine.makeMove(b, moveStr.slice(0, 2), moveStr.slice(2, 4), moveStr[4]);
      positions.push(positionEntry(b, moveStr, san));
    }
    const finalFen = positions[positions.length - 1].fen;
    if (s.fen && finalFen && finalFen.split(' ')[0] !== s.fen.split(' ')[0]) throw new Error('mismatch');
    s.positions = positions;
  } catch (_) {
    s.positions = [positionEntry(s.board, null, null)];
  }
  if (!Object.prototype.hasOwnProperty.call(s, 'claimableDraw')) refreshClaimableDraw(s);
  return s;
}

// Pure helper for non-live histories (archive view): positions from the
// standard start position. Returns null if any move is illegal.
function buildPositions(history) {
  try {
    let b = engine.createInitialBoard();
    const positions = [positionEntry(b, null, null)];
    for (const moveStr of (history || [])) {
      // chess.js validates legality here (engine.makeMove does not).
      const san = rulesEngine.san(b, moveStr.slice(0, 2), moveStr.slice(2, 4), moveStr[4]);
      if (!san) return null;
      b = engine.makeMove(b, moveStr.slice(0, 2), moveStr.slice(2, 4), moveStr[4]);
      positions.push(positionEntry(b, moveStr, san));
    }
    return positions;
  } catch (_) {
    return null;
  }
}

function newGame(timeControl) {
  const board = engine.createInitialBoard();
  const tc = timeControl || { preset: 'rapid_10_15', baseSeconds: CLOCK_START_SECONDS, incrementSeconds: CLOCK_INCREMENT_SECONDS, name: 'Rapid 10+15' };
  const baseSec = typeof tc.baseSeconds === 'number' ? tc.baseSeconds : CLOCK_START_SECONDS;
  const s = {
    board,
    history: [],
    clocks: { white: baseSec, black: baseSec },
    elapsed: defaultElapsed(),
    moveStartTs: 0,
    moveTimestamps: [],
    gameOver: false,
    status: 'ongoing',
    result: null,
    flagged: null,
    resigned: null,
    draw: false,
    drawReason: null,
    drawOffer: null,
    rematchOffer: null,
    timeControl: tc,
    fen: rulesEngine.boardToFen(board),
    positions: [positionEntry(board, null, null)],
    claimableDraw: { claimable: false, reason: null }
  };
   return s;
}

// G3: per-color / delay / bronstein / odds time-control helpers. Pure derivations
// from the time-control.js module; they never touch board state directly.
function replayClocks(tc, normalized) {
  if (normalized && normalized.perColor) {
    return { white: normalized.perColor.white, black: normalized.perColor.black };
  }
  var base = normalized && typeof normalized.baseSeconds === 'number' ? normalized.baseSeconds : CLOCK_START_SECONDS;
  return { white: base, black: base };
}

function normalizeReplayTc(tc) {
  if (timeControlMod && typeof timeControlMod.normalize === 'function') {
    return timeControlMod.normalize(tc);
   }
  return {
    preset: tc.preset || 'custom',
    baseSeconds: tc.baseSeconds,
    incrementSeconds: tc.incrementSeconds || 0,
    name: tc.name || `${Math.floor(tc.baseSeconds / 60)}+${tc.incrementSeconds || 0}`
   };
}

function applyTimeControl(self, args) {
  var tc = (timeControlMod && typeof timeControlMod.normalize === 'function')
     ? timeControlMod.normalize(args)
     : {
        preset: args.preset || 'custom',
        baseSeconds: (typeof args.baseSeconds === 'number') ? Math.max(10, Math.min(7200, args.baseSeconds)) : CLOCK_START_SECONDS,
        incrementSeconds: Math.max(0, Math.min(60, args.incrementSeconds || 0)),
        name: args.name || 'Custom',
        perColor: { white: CLOCK_START_SECONDS, black: CLOCK_START_SECONDS },
        delay: 0,
        bronstein: args.bronstein === true,
        odds: null
        };
  self.timeControl = tc;
  self.state.timeControl = tc;
  if (self.state.history.length === 0) {
    self.state.clocks = replayClocks(tc, tc);
   }
  self._journalAndSnapshot('time-control', tc);
  return { ok: true, timeControl: tc, clocks: self.state.clocks };
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

function rebuildState(history, moveTimestamps) {
  const s = newGame();
  s.history = [];
  s.moveTimestamps = [];
  s.positions = [positionEntry(s.board, null, null)];
  let prevTs = 0;
  for (let i = 0; i < history.length; i++) {
    const moveStr = history[i];
    const from = moveStr.slice(0, 2);
    const to = moveStr.slice(2, 4);
    const promo = moveStr[4];
    const mover = s.board.turn;
    const moveTs = (moveTimestamps && typeof moveTimestamps[i] === 'number') ? moveTimestamps[i] : 0;
    if (moveTs && prevTs) {
      const delta = Math.max(0, (moveTs - prevTs) / 1000);
      s.elapsed[mover] = s.elapsed[mover] + delta;
    }
    s.clocks[mover] = Math.max(0, s.clocks[mover] - MOVE_TIME_COST_SECONDS);
    const san = safeSan(s.board, moveStr);
    s.board = engine.makeMove(s.board, from, to, promo);
    s.history.push(moveStr);
    s.moveTimestamps.push(moveTs);
    s.positions.push(positionEntry(s.board, moveStr, san));
    s.clocks[mover] = Math.min(CLOCK_START_SECONDS, s.clocks[mover] + CLOCK_INCREMENT_SECONDS);
    prevTs = moveTs;
  }
  s.moveStartTs = prevTs;
  const status = engine.getGameStatus(s.board, s.board.turn);
  s.status = status;
  s.gameOver = status === 'checkmate' || status === 'stalemate';
  if (status === 'checkmate') s.result = s.board.turn === 'white' ? '0-1' : '1-0';
  if (status === 'stalemate') s.result = '½-½';
  if (!s.gameOver) {
    const draw = rulesEngine.evaluateDraw(s.board, s.history);
    if (draw.draw) {
      s.gameOver = true;
      s.status = 'draw';
      s.draw = true;
      s.drawReason = draw.reason;
      s.result = '½-½';
    }
  }
  s.fen = rulesEngine.boardToFen(s.board);
  refreshClaimableDraw(s);
  return s;
}

function getRoomStateFile(roomId = 'default') {
  if (!roomId || roomId === 'default') {
    return process.env.CHESS_STATE_FILE || path.join(DIR, '.referee-state.json');
  }
  const baseDir = process.env.CHESS_STATE_FILE ? path.dirname(process.env.CHESS_STATE_FILE) : DIR;
  return path.join(baseDir, `.referee-state-${roomId}.json`);
}

function getRoomJournalFile(roomId = 'default') {
  if (!roomId || roomId === 'default') {
    return process.env.CHESS_JOURNAL_FILE || path.join(DIR, '.referee-journal.jsonl');
  }
  const baseDir = process.env.CHESS_JOURNAL_FILE ? path.dirname(process.env.CHESS_JOURNAL_FILE) : DIR;
  return path.join(baseDir, `.referee-journal-${roomId}.jsonl`);
}

function atomicSaveSnapshot(s, targetFile = STATE_FILE) {
  const tmp = targetFile + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2);
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, targetFile);
}

function appendJournal(entry, targetFile = JOURNAL_FILE) {
  fs.appendFileSync(targetFile, JSON.stringify(entry) + '\n');
}

function readJournal(targetFile = JOURNAL_FILE) {
  try {
    const raw = fs.readFileSync(targetFile, 'utf8');
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

function applyMove(s, moveStr, moveTs, lagCompMs = 0) {
  const turn = s.board.turn;
  if (typeof moveTs === 'number' && moveTs > 0 && s.moveStartTs > 0) {
    const lagDiscount = Math.max(0, Math.min(1000, Number(lagCompMs) || 0)) / 1000;
    const delta = Math.max(0, (moveTs - s.moveStartTs) / 1000 - lagDiscount);
    s.elapsed[turn] = s.elapsed[turn] + delta;
  }
  s.clocks[turn] = Math.max(0, s.clocks[turn] - MOVE_TIME_COST_SECONDS);
  if (s.clocks[turn] <= 0) {
    s.gameOver = true;
    s.status = 'timeout';
    s.flagged = turn;
    s.result = turn === 'white' ? '0-1 on time' : '1-0 on time';
    s.moveStartTs = 0;
    return { flagged: true };
  }
  const from = moveStr.slice(0, 2);
  const to = moveStr.slice(2, 4);
  const promo = moveStr.length > 4 ? moveStr[4] : undefined;
  const san = safeSan(s.board, moveStr);
  s.board = engine.makeMove(s.board, from, to, promo);
  s.history.push(moveStr);
  s.moveTimestamps.push(typeof moveTs === 'number' ? moveTs : 0);
  if (!Array.isArray(s.positions)) ensurePositions(s);
  s.positions.push(positionEntry(s.board, moveStr, san));
  const baseSec = (s.timeControl && typeof s.timeControl.baseSeconds === 'number') ? s.timeControl.baseSeconds : CLOCK_START_SECONDS;
  const incSec = (s.timeControl && typeof s.timeControl.incrementSeconds === 'number') ? s.timeControl.incrementSeconds : CLOCK_INCREMENT_SECONDS;
  s.clocks[turn] = Math.min(baseSec + 3600, s.clocks[turn] + incSec);
  s.moveStartTs = typeof moveTs === 'number' ? moveTs : 0;
  const nextTurn = s.board.turn;
  const status = engine.getGameStatus(s.board, nextTurn);
  s.status = status;
  s.gameOver = status === 'checkmate' || status === 'stalemate';
  if (status === 'checkmate') s.result = nextTurn === 'white' ? '0-1' : '1-0';
  if (status === 'stalemate') s.result = '½-½';
  if (!s.gameOver) {
    const draw = rulesEngine.evaluateDraw(s.board, s.history);
    if (draw.draw) {
      s.gameOver = true;
      s.status = 'draw';
      s.draw = true;
      s.drawReason = draw.reason;
      s.result = '½-½';
    }
  }
  s.fen = rulesEngine.boardToFen(s.board);
  refreshClaimableDraw(s);
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
    drawReason: s.drawReason || null,
    drawOffer: s.drawOffer || null,
    rematchOffer: s.rematchOffer || null,
    timeControl: s.timeControl || null,
    clocks: s.clocks,
    elapsed: s.elapsed,
    board: renderAscii(s.board),
    history: historyStr(s.history),
    plyCount: s.history.length,
    positions: s.positions || null,
    claimableDraw: s.claimableDraw || null
  };
}

class RefereeService {
  constructor(options = {}) {
    if (typeof options === 'string') {
      options = { roomId: options };
    }
    const roomId = (options && options.roomId) ? options.roomId : 'default';
    this.roomId = roomId;
    this.stateFile = (options && options.stateFile) || getRoomStateFile(roomId);
    this.journalFile = (options && options.journalFile) || getRoomJournalFile(roomId);
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
      const raw = fs.readFileSync(this.stateFile, 'utf8');
      snapshot = ensurePositions(ensureClocks(JSON.parse(raw)));
      snapMtime = fs.statSync(this.stateFile).mtimeMs;
    } catch (_) { /* no snapshot */ }

    const journal = readJournal(this.journalFile);

    if (snapshot) {
      this.state = snapshot;
    } else {
      this.state = newGame();
      atomicSaveSnapshot(this.state, this.stateFile);
      try {
        snapMtime = fs.statSync(this.stateFile).mtimeMs;
      } catch (_) {}
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
      const mtime = fs.statSync(this.stateFile).mtimeMs;
      if (mtime !== this._lastSnapshotMtime) {
        this._rebootFromSnapshotOnly();
      }
    } catch (_) { /* file gone — keep current state */ }
  }

  _rebootFromSnapshotOnly() {
    let snapshot = null;
    let snapMtime = 0;
    try {
      const raw = fs.readFileSync(this.stateFile, 'utf8');
      snapshot = ensurePositions(ensureClocks(JSON.parse(raw)));
      snapMtime = fs.statSync(this.stateFile).mtimeMs;
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
        applyMove(this.state, normalized, entry.ts);
      }
    } else if (entry.type === 'undo') {
      if (this.state.history.length > 0) {
        this.state = rebuildState(this.state.history.slice(0, -1), this.state.moveTimestamps.slice(0, -1));
      }
    } else if (entry.type === 'timeout') {
      const color = entry.args && entry.args.color;
      if (['white', 'black'].includes(color) && !this.state.gameOver) {
        this.state.gameOver = true;
        this.state.status = 'timeout';
        this.state.flagged = color;
        this.state.result = color === 'white' ? '0-1 on time' : '1-0 on time';
        this.state.clocks[color] = 0;
        this.state.moveStartTs = 0;
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
      const args = entry.args || {};
      if (args.action === 'claim') {
        this.state.gameOver = true;
        this.state.status = 'draw';
        this.state.draw = true;
        this.state.drawReason = args.reason || 'claim';
        this.state.result = '½-½';
        this.state.drawOffer = null;
      } else if (args.action === 'offer') {
        this.state.drawOffer = args.color;
      } else if (args.action === 'decline') {
        this.state.drawOffer = null;
      } else {
        if (!this.state.gameOver) {
          this.state.gameOver = true;
          this.state.status = 'draw';
          this.state.draw = true;
          this.state.drawReason = args.reason || 'agreement';
          this.state.result = '½-½';
          this.state.drawOffer = null;
        }
      }
      } else if (entry.type === 'time-control') {
        const tc = entry.args || {};
        if (typeof tc.baseSeconds === 'number') {
          this.timeControl = normalizeReplayTc(tc);
          this.state.timeControl = this.timeControl;
          if (this.state.history.length === 0) {
            this.state.clocks = replayClocks(tc, this.timeControl);
            }
           }
        } else if (entry.type === 'rematch') {
      const args = entry.args || {};
      if (args.action === 'offer') {
        this.state.rematchOffer = args.color;
      } else if (args.action === 'decline') {
        this.state.rematchOffer = null;
      } else if (args.action === 'accept') {
        this.state.rematchOffer = null;
        this.state = newGame(this.timeControl);
      }
    } else if (entry.type === 'setup') {
      const fen = entry.args && entry.args.fen;
      if (typeof fen === 'string') {
        try {
          const board = rulesEngine.fenToBoard(fen);
          rulesEngine.create(fen);
          const tc = this.timeControl || (this.state && this.state.timeControl);
          const baseSec = (tc && typeof tc.baseSeconds === 'number') ? tc.baseSeconds : CLOCK_START_SECONDS;
          this.state = {
            board,
            history: [],
            clocks: { white: baseSec, black: baseSec },
            elapsed: defaultElapsed(),
            moveStartTs: 0,
            moveTimestamps: [],
            gameOver: false,
            status: 'ongoing',
            result: null,
            flagged: null,
            resigned: null,
            draw: false,
            drawReason: null,
            drawOffer: null,
            rematchOffer: null,
            timeControl: tc,
            fen: rulesEngine.boardToFen(board)
          };
        } catch (_) { /* ignore invalid setup on replay */ }
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
        this._setIdempotency(id, conflict);
        return conflict;
      }
      let result;
      try {
        result = this._dispatch(command);
      } catch (e) {
        result = { ok: false, error: String(e && e.message || e), httpStatus: 500 };
      }
      result = Object.assign({ revision: this.revision }, result);
      this._setIdempotency(id, result);
      return result;
    }).catch(err => {
      const result = { ok: false, error: String(err && err.message || err), httpStatus: 500, revision: this.revision };
      this._setIdempotency(id, result);
      return result;
    });
    return this._tail;
  }

  _setIdempotency(id, result) {
    if (this._idempotency.size >= 500) {
      const oldestKey = this._idempotency.keys().next().value;
      if (oldestKey !== undefined) this._idempotency.delete(oldestKey);
    }
    this._idempotency.set(id, result);
  }

  _dispatch(command) {
    switch (command.type) {
      case 'move': return this._cmdMove(command.args || {});
      case 'undo': return this._cmdUndo();
      case 'resign': return this._cmdResign((command.args || {}).color);
      case 'draw': return this._cmdDraw(command.args || {});
      case 'time-control': return this._cmdSetTimeControl(command.args || {});
      case 'rematch': return this._cmdRematch(command.args || {});
      case 'reset': return this._cmdReset();
      case 'setup': return this._cmdSetup(command.args || {});
      default: return { ok: false, error: 'unknown command type: ' + command.type, httpStatus: 400 };
    }
  }

  _journalAndSnapshot(type, args, moveTs) {
    if (this.state && this.state.gameOver) this.state.claimableDraw = null;
    this._journalSeq++;
    const entry = { seq: this._journalSeq, id: this._journalSeq, type, args, ts: (typeof moveTs === 'number' ? moveTs : Date.now()) };
    appendJournal(entry, this.journalFile);
    atomicSaveSnapshot(this.state, this.stateFile);
    try { this._lastSnapshotMtime = fs.statSync(this.stateFile).mtimeMs; } catch (_) {}
    this.revision = this._computeRevision();
    stateEmitter.emit('change', { roomId: this.roomId, type, revision: this.revision });
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
    const moveTs = Date.now();
    const lagCompMs = args.transitDelayMs || (args.clientSentAt ? Math.max(0, Math.min(1000, moveTs - args.clientSentAt)) : 0);
    const r = applyMove(s, normalized, moveTs, lagCompMs);
    s.drawOffer = null;
    this._journalAndSnapshot('move', { move: normalized }, moveTs);
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
    this.state = rebuildState(s.history.slice(0, -1), s.moveTimestamps.slice(0, -1));
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

  _cmdDraw(args = {}) {
    const s = this.state;
    if (s.gameOver) {
      return Object.assign({ ok: false, error: 'game over', httpStatus: 409 }, stateView(s));
    }

    const action = args.action || null;
    const color = args.color || null;

    if (action === 'claim') {
      const claim = rulesEngine.claimableDraw(s.board, s.history);
      if (!claim.claimable) {
        return { ok: false, error: 'No claimable draw condition (threefold repetition or 50-move rule)', httpStatus: 400 };
      }
      s.gameOver = true;
      s.status = 'draw';
      s.draw = true;
      s.drawReason = claim.reason;
      s.result = '½-½';
      s.drawOffer = null;
      this._journalAndSnapshot('draw', { action: 'claim', reason: claim.reason });
      return Object.assign({ ok: true, draw: true, drawReason: claim.reason }, stateView(s));
    }

    if (action === 'decline') {
      s.drawOffer = null;
      this._journalAndSnapshot('draw', { action: 'decline' });
      return Object.assign({ ok: true, declined: true }, stateView(s));
    }

    if (action === 'offer') {
      s.drawOffer = color || s.board.turn;
      this._journalAndSnapshot('draw', { action: 'offer', color: s.drawOffer });
      return Object.assign({ ok: true, offer: s.drawOffer }, stateView(s));
    }

    if (action === 'accept') {
      s.gameOver = true;
      s.status = 'draw';
      s.draw = true;
      s.drawReason = 'agreement';
      s.result = '½-½';
      s.drawOffer = null;
      this._journalAndSnapshot('draw', { action: 'accept' });
      return Object.assign({ ok: true, draw: true, drawReason: 'agreement' }, stateView(s));
    }

    // Default / legacy draw:
    if (s.drawOffer && color && s.drawOffer !== color) {
      s.gameOver = true;
      s.status = 'draw';
      s.draw = true;
      s.drawReason = 'agreement';
      s.result = '½-½';
      s.drawOffer = null;
      this._journalAndSnapshot('draw', { action: 'accept' });
      return Object.assign({ ok: true, draw: true, drawReason: 'agreement' }, stateView(s));
    }

    if (args.isSeated && color && !s.drawOffer) {
      s.drawOffer = color;
      this._journalAndSnapshot('draw', { action: 'offer', color });
      return Object.assign({ ok: true, offer: color }, stateView(s));
    }

    s.gameOver = true;
    s.status = 'draw';
    s.draw = true;
    s.drawReason = 'agreement';
    s.result = '½-½';
    s.drawOffer = null;
    this._journalAndSnapshot('draw', {});
    return Object.assign({ ok: true, draw: true, drawReason: 'agreement' }, stateView(s));
  }

  _cmdReset() {
    const tc = this.timeControl || (this.state && this.state.timeControl);
    this.state = newGame(tc);
    this._journalAndSnapshot('reset', {});
    return { ok: true, reset: true };
  }

  _cmdSetup(args = {}) {
    const fen = (typeof args.fen === 'string' && args.fen.trim()) ? args.fen.trim() : null;
    if (!fen) {
      return { ok: false, error: 'missing FEN', httpStatus: 400 };
    }
    let board;
    try {
      board = rulesEngine.fenToBoard(fen);
    } catch (e) {
      return { ok: false, error: 'invalid FEN', httpStatus: 400 };
    }
    // Validate the FEN through chess.js (rejects illegal/ambiguous positions).
    let instance;
    try {
      instance = rulesEngine.create(fen);
    } catch (e) {
      return { ok: false, error: 'invalid FEN', httpStatus: 400 };
    }
    if (!instance) {
      return { ok: false, error: 'invalid FEN', httpStatus: 400 };
    }
    const tc = this.timeControl || (this.state && this.state.timeControl);
    const baseSec = (tc && typeof tc.baseSeconds === 'number') ? tc.baseSeconds : CLOCK_START_SECONDS;
    this.state = {
      board,
      history: [],
      clocks: { white: baseSec, black: baseSec },
      elapsed: defaultElapsed(),
      moveStartTs: 0,
      moveTimestamps: [],
      gameOver: false,
      status: 'ongoing',
      result: null,
      flagged: null,
      resigned: null,
      draw: false,
      drawReason: null,
      drawOffer: null,
      rematchOffer: null,
      timeControl: tc,
      fen: rulesEngine.boardToFen(board),
      positions: [positionEntry(board, null, null)],
      claimableDraw: { claimable: false, reason: null }
    };
    this._journalAndSnapshot('setup', { fen });
    return Object.assign({ ok: true, setup: true, fen: this.state.fen }, stateView(this.state));
  }

   _cmdSetTimeControl(args = {}) {
    return applyTimeControl(this, args);
   }

  _cmdRematch(args = {}) {
    const action = args.action;
    if (!['offer', 'accept', 'decline'].includes(action)) {
      return { ok: false, error: 'invalid rematch action', httpStatus: 400 };
    }
    if (action === 'offer') {
      this.state.rematchOffer = args.color || 'player';
      this._journalAndSnapshot('rematch', { action, color: args.color });
      return { ok: true, action, rematchOffer: this.state.rematchOffer };
    }
    if (action === 'decline') {
      this.state.rematchOffer = null;
      this._journalAndSnapshot('rematch', { action });
      return { ok: true, action, rematchOffer: null };
    }
    if (action === 'accept') {
      this.state.rematchOffer = null;
      const tc = this.timeControl || (this.state && this.state.timeControl);
      this.state = newGame(tc);
      this._journalAndSnapshot('rematch', { action });
      return { ok: true, action, reset: true };
    }
    return { ok: false, error: 'unhandled rematch action', httpStatus: 400 };
  }

  addChatMessage(sender, text) {
    if (!this.chat) this.chat = [];
    const msg = {
      id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      sender: String(sender || 'Player').slice(0, 32),
      text: String(text || '').slice(0, 500),
      timestamp: Date.now()
    };
    this.chat.push(msg);
    if (this.chat.length > 100) this.chat.shift();
    return msg;
  }

  getChatMessages() {
    return this.chat || [];
  }

  checkFlagFall(now = Date.now()) {
    const s = this.state;
    if (!s || s.gameOver || !s.moveStartTs || s.moveStartTs <= 0) {
      return { flagged: false };
    }
    const turn = s.board.turn;
    const elapsedSinceStart = Math.max(0, (now - s.moveStartTs) / 1000);
    const remainingClock = s.clocks[turn] - elapsedSinceStart;

    if (remainingClock <= 0) {
      s.gameOver = true;
      s.status = 'timeout';
      s.flagged = turn;
      s.result = turn === 'white' ? '0-1 on time' : '1-0 on time';
      s.clocks[turn] = 0;
      s.elapsed[turn] = s.elapsed[turn] + elapsedSinceStart;
      s.moveStartTs = 0;
      this._journalAndSnapshot('timeout', { color: turn });
      return { flagged: true, color: turn };
    }
    return { flagged: false, remainingClock };
  }

  getState() {
    this.checkFlagFall();
    return this.state;
  }

  getRevision() {
    return this.revision;
  }
}

const _instances = new Map();

function getReferee(roomId = 'default') {
  const id = (typeof roomId === 'string' && roomId.trim()) ? roomId.trim() : 'default';
  if (!_instances.has(id)) {
    _instances.set(id, new RefereeService({ roomId: id }));
  }
  return _instances.get(id);
}

function resetInstance(roomId) {
  if (roomId) {
    _instances.delete(roomId);
  } else {
    _instances.clear();
  }
}

module.exports = {
  RefereeService,
  buildPositions,
  getReferee,
  resetInstance,
  getRoomStateFile,
  getRoomJournalFile,
  atomicSaveSnapshot,
  appendJournal,
  readJournal,
  newGame,
  ensureClocks,
  allLegalMoves,
  renderAscii,
  historyStr,
  rebuildState,
  stateEmitter,
  onStateChange,
  CLOCK_START_SECONDS,
  CLOCK_INCREMENT_SECONDS,
  MOVE_TIME_COST_SECONDS,
  STATE_FILE,
  JOURNAL_FILE
};