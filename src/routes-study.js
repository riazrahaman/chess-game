'use strict';

/**
 * routes-study.js — Study chapters API (roadmap A2.2, RECOMMENDATIONS.md:117).
 *
 * Mounted from server.js with one line before the /api/ 404:
 *   if (require('./src/routes-study.js').handleStudyRoute(req, res, urlPath, ctx)) return;
 *
 * A chapter is a stored study line. Three kinds:
 *   'pgn'  — a pasted/imported PGN parsed by study-tree.fromPGN: full RAV
 *            variation tree + NAG annotations preserved and re-exported.
 *   'fen'  — a server-validated start FEN plus a recorded line (SAN or UCI).
 *   'game' — an archived game imported by id (game-archive.getGame).
 *
 * Hidden-move quiz mode mirrors routes-puzzles.js exactly: the client never
 * validates a move and the solution line is NEVER in the public payload until
 * the viewer completes the chapter or explicitly reveals it. The server is
 * stateless per request — it replays from the stored move list each time.
 *
 * Route table (all JSON unless noted):
 *   GET    /api/study                 list the viewer's chapters (solution-free)
 *   POST   /api/study                 create a chapter {kind,title?,pgn?,fen?,line?|moves?,gameId?,quiz?}
 *   GET    /api/study/:id             one chapter (quiz = solution-free)
 *   POST   /api/study/:id/guess       {move, moves?} validate one quiz guess
 *   POST   /api/study/:id/reveal      {moves?} return the solution line
 *   POST   /api/study/:id/quiz        {quiz:boolean} toggle quiz mode (owner)
 *   GET    /api/study/:id/pgn         export PGN with $1–$9 NAG glyphs (?format=raw for text)
 *   DELETE /api/study/:id             delete a chapter (owner only)
 *
 * Ownership: every chapter is owned by a per-visitor identity, mirroring
 * routes-puzzles.playerIdFor — `user:<accountId>` when signed in, else
 * `anon:<study_player cookie>` (minted on first contact). Read and mutation
 * both require strict `ch.owner === viewer.owner`, so one guest can never see
 * or mutate another guest's chapter (a non-owner gets 404, preserving privacy).
 *
 * Gate 4: pure API/display layer. Nothing here touches referee state, and the
 * client never replays a move — positions[] are built server-side.
 */

const crypto = require('crypto');

const StudyTree = require('./study-tree.js');
const RulesEngine = require('./rules-engine.js');
const GameArchive = require('./game-archive.js');
const StudyStore = require('./study-store.js');

const MAX_TITLE = 120;
const MAX_PGN_CHARS = 100000;
const MAX_LINE_TOKENS = 500;
const MAX_STUDY_BODY_BYTES = 200000; // PGNs are far larger than the 8 KB default
const CHAPTER_KINDS = new Set(['pgn', 'fen', 'game']);
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// ---------------------------------------------------------------------------
// store access
// ---------------------------------------------------------------------------
function storeOf(ctx) {
  if (ctx && ctx.studyStore) return ctx.studyStore;
  return StudyStore.getDefaultStudyStore();
}

function archiveOf(ctx) {
  return (ctx && ctx.gameArchive) || GameArchive;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function newId() {
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'study_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
}

/**
 * Per-visitor identity, mirroring routes-puzzles.playerIdFor. Signed-in viewers
 * key on the account; guests get a persistent `study_player` cookie (minted on
 * first contact). The key scopes both ownership and per-viewer reveal state, so
 * two anonymous browsers can never read or mutate each other's chapters.
 */
function viewerOf(req, res, ctx) {
  const session = ctx && typeof ctx.getAuthUser === 'function' ? ctx.getAuthUser(req) : null;
  if (session && session.userId) {
    return { key: 'user:' + String(session.userId), owner: 'user:' + String(session.userId), authenticated: true };
  }
  const cookies = ctx && typeof ctx.parseCookies === 'function' ? ctx.parseCookies(req) : {};
  let anon = cookies.study_player;
  if (!anon || !/^[A-Za-z0-9_-]{8,64}$/.test(anon)) {
    anon = crypto.randomBytes(12).toString('base64url');
    if (res && !res.headersSent) {
      res.setHeader('Set-Cookie', `study_player=${anon}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 24 * 3600}`);
    }
  }
  return { key: 'anon:' + anon, owner: 'anon:' + anon, authenticated: false };
}

function isAccountOwner(owner) {
  return owner != null && String(owner).startsWith('user:');
}

function trimTitle(title, fallback) {
  const t = String(title == null ? '' : title).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  return t || fallback;
}

function canonicalFen(fen) {
  const board = RulesEngine.fenToBoard(String(fen).trim());
  return RulesEngine.boardToFen(board);
}

/** Validate a FEN the way routes-openings.validateFen does, then let chess.js
 * be the final authority (it throws on an illegal placement). */
function validateFen(fen) {
  if (typeof fen !== 'string' || !fen.trim()) return { ok: true, valid: false, error: 'fen is required' };
  const trimmed = fen.trim();
  if (trimmed.length > 120) return { ok: true, valid: false, error: 'fen too long' };
  try {
    const canonical = canonicalFen(trimmed);
    RulesEngine.create(canonical); // chess.js constructor rejects an illegal FEN
    return { ok: true, valid: true, fen: canonical, turn: RulesEngine.turn(canonical) };
  } catch (err) {
    return { ok: true, valid: false, error: (err && err.message) || 'invalid fen' };
  }
}

/** Split movetext into individual move tokens, discarding move numbers,
 * results, comments, NAGs and nested RAV parentheses. */
function tokenizeLine(input) {
  let text;
  if (Array.isArray(input)) text = input.join(' ');
  else text = String(input == null ? '' : input);
  text = text
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/;[^\r\n]*/g, ' ')
    .replace(/\$[0-9]+/g, ' ')
    .replace(/\((?:[^()]|\([^()]*\))*\)/g, ' ');
  const tokens = [];
  for (const raw of text.split(/\s+/)) {
    let tok = raw;
    while (/^\d+\.+/.test(tok)) tok = tok.replace(/^\d+\.+/, '');
    if (!tok) continue;
    if (['1-0', '0-1', '1/2-1/2', '*'].includes(tok)) continue;
    tokens.push(tok);
    if (tokens.length > MAX_LINE_TOKENS) break;
  }
  return tokens;
}

/**
 * Replay a SAN/UCI token list from a start FEN. Returns the UCI + SAN arrays
 * or { error }. Never throws.
 */
function lineToSolution(startFen, input) {
  const tokens = tokenizeLine(input);
  const chess = RulesEngine.create(startFen);
  const solution = [];
  const solutionSan = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    let mv = null;
    if (/^[a-h][1-8][a-h][1-8][qrbnQRBN]?$/.test(tok)) {
      const obj = { from: tok.slice(0, 2).toLowerCase(), to: tok.slice(2, 4).toLowerCase() };
      if (tok[4]) obj.promotion = tok[4].toLowerCase();
      try { mv = chess.move(obj); } catch (_) { mv = null; }
    }
    if (!mv) {
      const clean = tok.replace(/[+#?!]+$/g, '');
      try { mv = chess.move(clean); } catch (_) { mv = null; }
    }
    if (!mv) return { error: `illegal move "${tok}" at ply ${i + 1}` };
    solution.push(mv.from + mv.to + (mv.promotion || ''));
    solutionSan.push(mv.san);
  }
  if (solution.length === 0) return { error: 'the line is empty' };
  return { solution, solutionSan };
}

/** Build the display-only per-ply positions[] a view renders (Gate 4). */
function buildPositions(startFen, solution) {
  const chess = RulesEngine.create(startFen);
  const positions = [{ fen: startFen, san: null, lastMove: null }];
  for (const uci of solution) {
    const moveObj = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
    if (uci[4]) moveObj.promotion = uci[4];
    let mv = null;
    try { mv = chess.move(moveObj); } catch (_) { mv = null; }
    if (!mv) break;
    positions.push({ fen: chess.fen(), san: mv.san, lastMove: { from: mv.from, to: mv.to } });
  }
  return positions;
}

/** Strip parent links so a study-tree tree is JSON-serializable. */
function serializeTree(node) {
  if (!node) return null;
  return {
    id: node.id,
    move: node.move,
    comment: node.comment || null,
    nags: Array.isArray(node.nags) ? node.nags.slice() : [],
    variationName: node.variationName || null,
    children: (node.children || []).map(serializeTree)
  };
}

/** Rebuild a live tree (with parent links) from a stored serialization. */
function rehydrateTree(data) {
  if (!data) return null;
  const node = StudyTree.createNode(data.move || '', {
    id: data.id,
    comment: data.comment,
    nags: data.nags,
    variationName: data.variationName
  });
  for (const child of data.children || []) {
    const c = rehydrateTree(child);
    c.parent = node;
    node.children.push(c);
  }
  return node;
}

function linearTree(solutionSan) {
  const root = StudyTree.createTree();
  let parent = root;
  for (const san of solutionSan || []) parent = StudyTree.addChild(parent, san);
  return root;
}

function extractFenHeader(pgn) {
  const m = String(pgn || '').match(/\[FEN\s+"([^"]+)"\]/);
  return m ? m[1] : null;
}

function extractTag(pgn, name) {
  const m = String(pgn || '').match(new RegExp('\\[' + name + '\\s+"([^"]*)"\\]'));
  return m ? m[1] : '';
}

// ---------------------------------------------------------------------------
// public views — solution-free until reveal/complete
// ---------------------------------------------------------------------------
function chapterSummary(ch) {
  return {
    id: ch.id,
    kind: ch.kind,
    title: ch.title,
    quiz: !!ch.quiz,
    startFen: ch.startFen,
    turn: (String(ch.startFen).split(' ')[1] === 'b') ? 'black' : 'white',
    totalMoves: (ch.solution || []).length,
    owned: isAccountOwner(ch.owner),
    createdAt: ch.createdAt,
    updatedAt: ch.updatedAt
  };
}

function presentChapter(ch, opts = {}) {
  const base = chapterSummary(ch);
  base.revealed = !!opts.reveal;
  if (ch.quiz && !opts.reveal) return base;
  base.positions = buildPositions(ch.startFen, ch.solution || []);
  base.solution = (ch.solution || []).slice();
  base.solutionSan = (ch.solutionSan || []).slice();
  base.tree = ch.tree || null;
  return base;
}

/** Rehydrated tree for PGN export (from the stored tree, else the mainline). */
function treeFor(ch) {
  if (ch.tree) {
    const live = rehydrateTree(ch.tree);
    if (live) return live;
  }
  return linearTree(ch.solutionSan);
}

function chapterPgn(ch) {
  const root = treeFor(ch);
  const movetext = StudyTree.toPGN(root);
  const lines = [
    '[Event "Study chapter"]',
    `[StudyName "${String(ch.title || 'Study').replace(/"/g, "'")}"]`,
    `[Kind "${ch.kind}"]`,
    ch.startFen && ch.startFen !== START_FEN ? `[FEN "${ch.startFen}"]` : null,
    '[Result "*"]',
    ''
  ].filter(Boolean);
  const prefix = lines.join('\n');
  return `${prefix}${movetext} *`;
}

// ---------------------------------------------------------------------------
// quiz replay (stateless; mirrors routes-puzzles.replayPrefix)
// ---------------------------------------------------------------------------
function normalizeMoveInput(chess, input) {
  if (!input) return null;
  if (typeof input === 'object') {
    if (!input.from || !input.to) return null;
    return `${input.from}${input.to}${input.promotion ? String(input.promotion).toLowerCase() : ''}`;
  }
  const text = String(input).trim();
  if (/^[a-h][1-8][a-h][1-8][qrbnQRBN]?$/.test(text)) return text.toLowerCase();
  const legal = chess.moves({ verbose: true });
  const clean = text.replace(/[+#?!]+$/g, '');
  const hit = legal.find(m => m.san.replace(/[+#]+$/g, '') === clean);
  return hit ? hit.from + hit.to + (hit.promotion || '') : null;
}

function applyUci(chess, uci) {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;
  const mv = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
  if (uci.length === 5) mv.promotion = uci[4];
  try { return chess.move(mv); } catch (_) { return null; }
}

/**
 * Replays the quiz to the solver's committed moves and returns the next
 * expected solution move. The solver controls the side to move at startFen;
 * the opponent's scripted moves (odd solution indices) are auto-played.
 */
function replayQuiz(chapter, prefix) {
  const chess = RulesEngine.create(chapter.startFen);
  const solution = chapter.solution || [];
  const committed = Array.isArray(prefix) ? prefix.map(String) : [];
  for (let i = 0; i < committed.length; i++) {
    const solutionIndex = 2 * i;
    const expected = solution[solutionIndex];
    if (!expected) return { error: 'too many moves for this chapter' };
    const candidate = normalizeMoveInput(chess, committed[i]);
    if (!candidate) return { error: `move ${i + 1} is not legal` };
    const applied = applyUci(chess, candidate);
    if (!applied) return { error: `move ${i + 1} is not legal` };
    if (candidate !== expected && !chess.isCheckmate()) return { error: `move ${i + 1} is not the solution` };
    if (chess.isCheckmate()) return { chess, expected: null, index: solutionIndex, complete: true, committed: committed.slice(0, i + 1) };
    const reply = solution[solutionIndex + 1];
    if (reply && !applyUci(chess, reply)) return { error: 'chapter data is corrupt' };
  }
  const nextIndex = 2 * committed.length;
  return { chess, expected: solution[nextIndex] || null, index: nextIndex, complete: !solution[nextIndex], committed };
}

function solutionOf(ch) {
  return { uci: (ch.solution || []).slice(), san: (ch.solutionSan || []).slice() };
}

// ---------------------------------------------------------------------------
// chapter construction
// ---------------------------------------------------------------------------
function buildPgnChapter(body) {
  const pgn = String(body.pgn || '').slice(0, MAX_PGN_CHARS);
  if (!pgn.trim()) return { error: 'pgn is required' };
  const startFenRaw = extractFenHeader(pgn);
  let startFen = START_FEN;
  if (startFenRaw) {
    const v = validateFen(startFenRaw);
    if (!v.valid) return { error: `invalid FEN header: ${v.error}` };
    startFen = v.fen;
  }
  const root = StudyTree.fromPGN(pgn);
  const mainline = StudyTree.getMainline(root);
  const sanMoves = mainline.map(n => StudyTree.getNodeMove(n));
  const solved = lineToSolution(startFen, sanMoves);
  if (solved.error) return { error: `could not replay the PGN: ${solved.error}` };
  const white = extractTag(pgn, 'White');
  const black = extractTag(pgn, 'Black');
  const fallback = white && black ? `${white} – ${black}` : 'PGN chapter';
  return {
    kind: 'pgn',
    title: trimTitle(body.title, fallback),
    startFen,
    solution: solved.solution,
    solutionSan: solved.solutionSan,
    tree: serializeTree(root)
  };
}

function buildFenChapter(body) {
  const v = validateFen(body.fen);
  if (!v.valid) return { error: `invalid fen: ${v.error}` };
  const input = body.line != null ? body.line : body.moves;
  const solved = lineToSolution(v.fen, input);
  if (solved.error) return { error: solved.error };
  return {
    kind: 'fen',
    title: trimTitle(body.title, 'FEN chapter'),
    startFen: v.fen,
    solution: solved.solution,
    solutionSan: solved.solutionSan,
    tree: serializeTree(linearTree(solved.solutionSan))
  };
}

function buildGameChapter(body, ctx) {
  const gameId = String(body.gameId || '').trim().slice(0, 120);
  if (!gameId) return { error: 'gameId is required' };
  const game = archiveOf(ctx).getGame(gameId);
  if (!game) return { error: 'game not found' };
  const startFenRaw = game.fen || extractFenHeader(game.pgn);
  let startFen = START_FEN;
  if (startFenRaw) {
    const v = validateFen(startFenRaw);
    if (v.valid) startFen = v.fen;
  }
  const movesStr = typeof game.moves === 'string' ? game.moves.trim() : Array.isArray(game.moves) ? game.moves.join(' ') : '';
  const uciTokens = movesStr ? movesStr.split(/\s+/).filter(Boolean) : [];
  const allUci = uciTokens.length > 0 && uciTokens.every(t => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(t));
  let solution;
  let solutionSan = [];
  let tree = null;
  if (allUci) {
    solution = uciTokens;
    solutionSan = buildPositions(startFen, solution).slice(1).map(p => p.san);
  } else {
    const pgn = game.pgn || '';
    let sanitized = startFen === START_FEN ? pgn : pgn.replace(/\[FEN\s+"[^"]+"\]\s*/g, '');
    const root = StudyTree.fromPGN(sanitized);
    const mainline = StudyTree.getMainline(root);
    const sanMoves = mainline.map(n => StudyTree.getNodeMove(n));
    const solved = lineToSolution(startFen, sanMoves);
    if (solved.error) return { error: `could not replay the game: ${solved.error}` };
    solution = solved.solution;
    solutionSan = solved.solutionSan;
    tree = serializeTree(root);
  }
  if (!solution || solution.length === 0) return { error: 'game has no moves' };
  if (!tree) tree = serializeTree(linearTree(solutionSan));
  const fallback = game.white && game.black ? `${game.white} – ${game.black}` : 'Game chapter';
  return {
    kind: 'game',
    title: trimTitle(body.title, fallback),
    startFen,
    solution,
    solutionSan,
    tree
  };
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------
function readJson(req, ctx) {
  return new Promise((resolve, reject) => {
    if (typeof ctx.readBody === 'function') {
      ctx.readBody(req, MAX_STUDY_BODY_BYTES).then(raw => {
        if (!raw || !String(raw).trim()) return resolve({});
        try { resolve(JSON.parse(raw)); } catch (_) { resolve(null); }
      }).catch(reject);
      return;
    }
    if (typeof ctx.readJsonBody === 'function') { ctx.readJsonBody(req, MAX_STUDY_BODY_BYTES).then(resolve).catch(reject); return; }
    reject(new Error('body reader unavailable'));
  });
}

/**
 * @returns {boolean} true when the request was handled.
 */
function handleStudyRoute(req, res, urlPath, ctx) {
  if (urlPath !== '/api/study' && !urlPath.startsWith('/api/study/')) return false;
  ctx = ctx || {};
  const sendJson = ctx.sendJson;
  const sendJsonError = ctx.sendJsonError;
  if (typeof sendJson !== 'function' || typeof sendJsonError !== 'function') return false;

  const rest = urlPath.slice('/api/study'.length).replace(/^\/+/, '').replace(/\/+$/, '');
  const segments = rest ? rest.split('/').map(s => { try { return decodeURIComponent(s); } catch (_) { return s; } }) : [];
  const store = storeOf(ctx);
  const viewer = viewerOf(req, res, ctx);
  // Ownership is a strict per-viewer identity match (account id or anon cookie):
  // one guest can never read or mutate another guest's chapter.
  const canRead = ch => !!ch && ch.owner === viewer.owner;
  const canMutate = ch => !!ch && ch.owner === viewer.owner;
  // A quiz stays concealed until THIS viewer has revealed or completed it. The
  // state lives server-side, keyed by viewer, so it cannot be spoofed by a
  // query param or a forged client flag.
  const revealedFor = ch => !ch.quiz || store.isRevealed(ch.id, viewer.key);

  // ---- GET /api/study ----
  if (req.method === 'GET' && segments.length === 0) {
    const chapters = store.listChapters({ owner: viewer.owner }).map(chapterSummary);
    sendJson(res, 200, { ok: true, owner: viewer.authenticated ? 'me' : 'guest', authenticated: viewer.authenticated, chapters });
    return true;
  }

  // ---- POST /api/study ----
  if (req.method === 'POST' && segments.length === 0) {
    readJson(req, ctx).then(body => {
      if (!body || typeof body !== 'object') { sendJsonError(res, 400, 'invalid request body'); return; }
      const kind = String(body.kind || '').toLowerCase();
      if (!CHAPTER_KINDS.has(kind)) { sendJsonError(res, 400, "kind must be 'pgn', 'fen' or 'game'"); return; }
      let built;
      if (kind === 'pgn') built = buildPgnChapter(body);
      else if (kind === 'fen') built = buildFenChapter(body);
      else built = buildGameChapter(body, ctx);
      if (built.error) { sendJsonError(res, 400, built.error); return; }
      const chapter = store.saveChapter({
        id: newId(),
        owner: viewer.owner,
        kind: built.kind,
        title: built.title,
        startFen: built.startFen,
        solution: built.solution,
        solutionSan: built.solutionSan,
        tree: built.tree,
        quiz: body.quiz === true || body.quiz === 1 || body.quiz === 'true'
      });
      // A quiz chapter is concealed from its creator too until they reveal or
      // complete it (same public view as GET).
      sendJson(res, 201, { ok: true, chapter: presentChapter(chapter, { reveal: !chapter.quiz }) });
    }).catch(err => { if (!res.headersSent) sendJsonError(res, err && err.message === 'request body too large' ? 413 : 400, err && err.message ? err.message : 'invalid request body'); });
    return true;
  }

  if (segments.length >= 1 && segments.length <= 2) {
    const id = segments[0];
    const action = segments[1] || null;
    if (!id || id.length > 128) { sendJsonError(res, 404, 'not found'); return true; }
    const chapter = store.getChapter(id);
    if (!chapter || !canRead(chapter)) { sendJsonError(res, 404, 'chapter not found'); return true; }

    // ---- GET /api/study/:id ----
    if (req.method === 'GET' && action === null) {
      sendJson(res, 200, { ok: true, chapter: presentChapter(chapter, { reveal: revealedFor(chapter) }) });
      return true;
    }

    // ---- GET /api/study/:id/pgn ----
    if (req.method === 'GET' && action === 'pgn') {
      // A concealed quiz must never leak its solution through the export. The
      // reveal state is per-viewer and server-side (never a query param).
      if (chapter.quiz && !revealedFor(chapter)) {
        sendJsonError(res, 403, 'solution is hidden until the quiz is completed or revealed');
        return true;
      }
      const pgn = chapterPgn(chapter);
      const wantRaw = (() => {
        const qi = req.url.indexOf('?');
        if (qi < 0) return false;
        return new URLSearchParams(req.url.slice(qi + 1)).get('format') === 'raw';
      })();
      if (wantRaw) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/x-chess-pgn; charset=utf-8');
        res.end(pgn);
        return true;
      }
      sendJson(res, 200, { ok: true, id: chapter.id, pgn });
      return true;
    }

    // ---- POST /api/study/:id/quiz ----
    if (req.method === 'POST' && action === 'quiz') {
      if (!canMutate(chapter)) { sendJsonError(res, 403, 'not your chapter'); return true; }
      readJson(req, ctx).then(body => {
        if (!body || typeof body !== 'object') { sendJsonError(res, 400, 'invalid request body'); return; }
        chapter.quiz = body.quiz === true || body.quiz === 1 || body.quiz === 'true';
        store.saveChapter(chapter);
        const fresh = store.getChapter(id);
        sendJson(res, 200, { ok: true, chapter: presentChapter(fresh, { reveal: revealedFor(fresh) }) });
      }).catch(() => { if (!res.headersSent) sendJsonError(res, 413, 'request body too large'); });
      return true;
    }

    // ---- POST /api/study/:id/reveal ----
    if (req.method === 'POST' && action === 'reveal') {
      store.markRevealed(chapter.id, viewer.key);
      sendJson(res, 200, { ok: true, chapter: presentChapter(chapter, { reveal: true }) });
      return true;
    }

    // ---- POST /api/study/:id/guess ----
    if (req.method === 'POST' && action === 'guess') {
      if (!chapter.quiz) { sendJsonError(res, 400, 'chapter is not in quiz mode'); return true; }
      readJson(req, ctx).then(body => {
        if (!body || typeof body !== 'object') { sendJsonError(res, 400, 'invalid request body'); return; }
        const replay = replayQuiz(chapter, Array.isArray(body.moves) ? body.moves : []);
        if (replay.error) { sendJsonError(res, 400, replay.error); return; }
        if (replay.complete) {
          store.markRevealed(chapter.id, viewer.key);
          sendJson(res, 200, { ok: true, correct: true, complete: true, alreadyComplete: true, fen: replay.chess.fen(), solution: solutionOf(chapter) });
          return;
        }
        const chess = replay.chess;
        const fenBefore = chess.fen();
        const candidate = normalizeMoveInput(chess, body.move);
        if (!candidate) { sendJson(res, 200, { ok: true, legal: false, correct: false, complete: false, fen: fenBefore }); return; }
        const applied = applyUci(chess, candidate);
        if (!applied) { sendJson(res, 200, { ok: true, legal: false, correct: false, complete: false, fen: fenBefore }); return; }
        const isExpected = candidate === replay.expected;
        const isAlternateMate = !isExpected && chess.isCheckmate();
        if (!isExpected && !isAlternateMate) {
          sendJson(res, 200, { ok: true, legal: true, correct: false, complete: false, move: { uci: candidate, san: applied.san }, fen: fenBefore });
          return;
        }
        const moves = replay.committed.concat([candidate]);
        let reply = null;
        let complete = true;
        if (!isAlternateMate) {
          const replyUci = (chapter.solution || [])[replay.index + 1];
          if (replyUci) {
            const r = applyUci(chess, replyUci);
            reply = r ? { uci: replyUci, san: r.san } : null;
            complete = false;
          }
        }
        if (complete) store.markRevealed(chapter.id, viewer.key);
        sendJson(res, 200, {
          ok: true, legal: true, correct: true, complete, alternateMate: isAlternateMate,
          move: { uci: candidate, san: applied.san }, reply, fen: chess.fen(), moves,
          solution: complete ? solutionOf(chapter) : undefined
        });
      }).catch(() => { if (!res.headersSent) sendJsonError(res, 413, 'request body too large'); });
      return true;
    }

    // ---- DELETE /api/study/:id ----
    if (req.method === 'DELETE' && action === null) {
      if (!canMutate(chapter)) { sendJsonError(res, 403, 'not your chapter'); return true; }
      const removed = store.deleteChapter(id);
      sendJson(res, 200, { ok: true, removed: !!removed });
      return true;
    }

    sendJsonError(res, 404, 'not found');
    return true;
  }

  sendJsonError(res, 404, 'not found');
  return true;
}

module.exports = {
  handleStudyRoute,
  validateFen,
  lineToSolution,
  buildPositions,
  presentChapter,
  replayQuiz,
  chapterPgn,
  serializeTree,
  rehydrateTree,
  normalizeMoveInput
};
