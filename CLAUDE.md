# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local-first, vanilla-JS chess app with an authoritative Node.js referee backend, a Lightweight Local Heuristic Engine analysis worker (with Stockfish 17 UCI protocol compatibility), AI bot opponents, AI coach & move explanations, mistake puzzle generator, post-game prose reports, voice move recognition, blind accessibility mode, and multi-room multiplayer over SSE. No build step, no framework, no bundler — plain `<script>` files served directly by `server.js`.

## Commands

```bash
npm install
node server.js               # start server on port 39281 (http://127.0.0.1:39281)
CHESS_PORT=1234 node server.js   # override port

npm test                     # full suite: unit tests + Playwright browser smoke test
npm run test:unit            # all unit & integration selftests
npm run lint                 # node --check across all server, client worker, and test files
npm run check                # lint + test:unit
```

There is no test framework/runner — each `*-selftest.js` file is a standalone Node script with its own assertions that exits non-zero on failure. Run any single suite directly:

```bash
node engine-selftest.js              # core engine + referee (159 tests)
node pieces-selftest.js              # SVG piece rendering (32 tests)
node security-selftest.js            # CORS, path traversal, body limits (58 tests)
node differential-selftest.js        # 200 random games vs chess.js (37,800+ plies)
node p3-multiroom-selftest.js        # multi-room isolation & routing
node p3-sqlite-selftest.js           # SQLite archive CRUD + PGN import/export (74 tests)
node p3-seat-selftest.js             # seat tokens, heartbeats & mutation security (41 tests)
node t0-draw-flagfall-selftest.js     # draw claims & flag fall timeouts (51 tests)
node t0-deadcode-selftest.js         # rate limiting, NTP sync & idempotency (13 tests)
node p2-stockfish-selftest.js        # local heuristic engine & UCI protocol (23 tests)
node p2-review-selftest.js           # CAPS move-review scoring & classification
node t1-mobile-visuals-selftest.js   # pointer events, bevel framing & piece shadows (16 tests)
node p3-social-timecontrol-selftest.js # time controls, chat, rematch & spectator presence (10 tests)
node c5-ai-bot-selftest.js           # Play vs Computer levels 1-8 bot opponent (10 tests)
node bot-tactics-selftest.js         # bot tactical strength & opening book
node c7-ai-puzzles-selftest.js       # blunder puzzle generator & retry mode (6 tests)
node c2-c4-coach-selftest.js         # why move explanations & coach mode hints (6 tests)
node c6-ai-report-selftest.js        # auto post-game report & annotated PGN (5 tests)
node c8-d4-voice-selftest.js         # voice move recognition, audio announcements & blind mode (7 tests)
node rating-selftest.js              # Glicko-2 rating engine (36 tests)
```

Suites not wired into `npm run check`/`npm test` (still runnable standalone, useful for targeted debugging): `draw-selftest.js`, `p1-annotations-selftest.js`, `p1-audio-selftest.js`, `p1-premove-selftest.js`, `p1-scrubber-selftest.js`, `p2-multipv-selftest.js`, `p2-opening-selftest.js`, `p3-lag-selftest.js`, `gate3-selftest.js`, `gate4-selftest.js`, `gate5-selftest.js`. If you add a new feature area's selftest, wire it into both `test:unit` and `lint` in `package.json` (per the checklist below) so it isn't silently orphaned like these.

Selftests write real artifacts (`.referee-state.json`, `.referee-journal.jsonl`, `games.db`) in the repo root and restore them on exit.

`npm run test:browser` runs `scripts/smoke-test.mjs` and `scripts/test-ui-features.mjs` via Playwright against a live server to verify live piece interactions, bot toggles, coach hints, game review, and voice accessibility with zero console errors.

## Architecture

**Everything is referee-authoritative.** The referee (`referee-service.js`) is the single source of truth for board state, clocks, and move history. This is the load-bearing invariant of the whole codebase:

- The board, clocks, and history live **only** in the referee. The browser never computes or mutates them locally — `ui.js` polls `/api/state` (and/or subscribes to SSE `/api/events`) and re-renders from what the server reports, every time.
- **Gate 4 Invariant**: `ui.js` must NEVER call `makeMove(` or `createInitialBoard(`. All mutations go through `/api/move` or referee command endpoints.
- All decorative/analysis features (piece animation, SVG board, Stockfish eval bar, annotations, sound, move classification, AI coach, voice) are pure display layer: they read referee/analysis output and never write back into game state.
- Any move, resign, draw, or undo must go through the referee's command queue (`POST /api/move`, `/api/resign`, `/api/draw`, `/api/undo`) — never applied client-side first.

### Server-side pipeline

```
server.js            HTTP API, static file serving, SSE stream, CORS/security boundary, room routing
  └─ referee-service.js   long-lived per-room referee: serialized FIFO command queue,
                          monotonic revision counter, append-only JSONL event journal
                          (.referee-journal.jsonl), atomic JSON snapshot (.referee-state.json,
                          write-tmp-then-rename), crash recovery via snapshot + journal replay
       └─ rules-engine.js     adapter over chess.js (^1.4.0): FEN projection, legal move
                              validation, draw-rule evaluation (evaluateDraw / claimableDraw)
       └─ engine.js           in-house board/move engine: legal move generation, check/mate/
                              stalemate detection, SAN/PGN builders, game-end presentation
  └─ seat-auth.js        cryptographic per-seat (White/Black/Spectator) session tokens;
                          prevents move hijacking and enforces seat ownership on mutations
  └─ bot-service.js      autonomous Play vs Computer bot levels 1-8, search depths 1-4,
                          blunder rates, human delay simulation, and chat commentary
  └─ game-archive.js     node:sqlite-backed game archive (games.db) with JSON-file fallback
                          (.games-archive.json) when node:sqlite isn't available; Seven Tag
                          Roster PGN parsing/export, search, pagination
```

### Client-side (all plain scripts loaded by `index.html`, no bundler)

- `ui.js` — the orchestrator: SSE/poll receiver and diff-based board reconciliation, pointer events touch/mouse drag-and-drop, move tree scrubber, multi-premove queueing (up to 5 plies), right-click annotation canvas, audio/haptics, seat management, clock-tick interpolation (render-only — never mutates authoritative time), theme switching (`[data-theme]` / `[data-mode=dark]`).
- `pieces.js` — inline SVG chess pieces (Colin M.L. Burnett cburnett artwork, `CBURNETT-LICENSE.txt`).
- `stockfish-worker.js` — Web Worker running Lightweight Local Heuristic Engine (PST + material evaluation) over UCI (`uci`, `isready`, `position fen`, `go depth`), multi-PV candidate lines, with Stockfish 17 UCI alias for protocol compatibility.
- `move-review.js` — CAPS-style win-probability accuracy scoring, move classification (Brilliant/Great/Best/Excellent/Good/Inaccuracy/Mistake/Blunder), and blunder puzzle generation (`generateMistakePuzzles`).
- `ai-coach.js` — plain-English move explanations (`explainMove`) and real-time coaching suggestions on active turn (`getCoachHint`).
- `game-report.js` — auto post-game narrative report generation (`generatePostGameReport`), accuracy summary, turning point swing analysis, endgame performance, and annotated PGN with NAG glyphs and eval comments.
- `accessibility-voice.js` — natural spoken English move announcements via SpeechSynthesis API, voice move input recognition via Web Speech API, and blind accessibility mode controller with keyboard grid navigation.
- `openings-db.js` — ECO opening database (prefix matching, master win rates) and the SVG evaluation-graph math.

### Adding or changing a feature

1. If it touches game state (moves, clocks, draws, resignation), the change belongs in `referee-service.js` / `rules-engine.js` / `engine.js`, exposed through a new/existing `server.js` route — never implemented as a client-side shortcut.
2. If it's visual/analytical only, it belongs in `ui.js` or a sibling client script and must derive entirely from server-reported state.
3. Preserving Gate 4 invariant: `ui.js` must NEVER call `makeMove(` or `createInitialBoard(`.
4. Add a matching `*-selftest.js` for the feature area and wire it into `test:unit` and `lint` in `package.json`.
5. Run `npm run check` before considering a change done.
