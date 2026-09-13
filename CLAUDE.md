# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local-first, vanilla-JS chess app with an authoritative Node.js referee backend, a Lightweight Local Heuristic Engine analysis worker (with Stockfish 17 UCI protocol compatibility), and multi-room multiplayer over SSE. No build step, no framework, no bundler — plain `<script>` files served directly by `server.js`.

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
node engine-selftest.js          # core engine + referee (159 tests)
node pieces-selftest.js          # SVG piece rendering (32 tests)
node security-selftest.js        # CORS, path traversal, body limits (58 tests)
node draw-selftest.js            # draw/repetition rules (30 tests)
node differential-selftest.js    # 200 random games vs chess.js
node p3-multiroom-selftest.js    # multi-room isolation & routing
node p3-sqlite-selftest.js       # SQLite archive CRUD + PGN import/export (74 tests)
node p3-seat-selftest.js         # seat tokens, heartbeats & mutation security (41 tests)
node t0-draw-flagfall-selftest.js # draw claims & flag fall timeouts (51 tests)
node t0-deadcode-selftest.js     # rate limiting, NTP sync & idempotency (13 tests)
node p2-stockfish-selftest.js    # local heuristic engine & UCI protocol (23 tests)
```

Other `p1-*`, `p2-*`, `p3-*`, `gate3-*`, `gate4-*`, `gate5-*` selftests exist per feature phase (audio, premoves, annotations, scrubber, Stockfish, multi-PV, move review, opening explorer, seat tokens, latency compensation) but are **not** wired into `npm test` — run them individually when touching that area (see README.md for the full list).

Selftests write real artifacts (`.referee-state.json`, `.referee-journal.jsonl`, `games.db`) in the repo root and restore them on exit. If a suite is flaky, check for a leftover `.lock` file or a stale state file from a killed process before assuming a real bug.

`npm run test:browser` runs `scripts/smoke-test.mjs` via Playwright against a live server it spawns; it self-skips if that file is missing.

## Architecture

**Everything is referee-authoritative.** The referee (`referee-service.js`) is the single source of truth for board state, clocks, and move history. This is the load-bearing invariant of the whole codebase:

- The board, clocks, and history live **only** in the referee. The browser never computes or mutates them locally — `ui.js` polls `/api/state` (and/or subscribes to SSE `/api/events`) and re-renders from what the server reports, every time.
- All decorative/analysis features (piece animation, SVG board, Stockfish eval bar, annotations, sound, move classification) are pure display layer: they read referee/analysis output and never write back into game state.
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
  └─ game-archive.js     node:sqlite-backed game archive (games.db) with JSON-file fallback
                          (.games-archive.json) when node:sqlite isn't available; Seven Tag
                          Roster PGN parsing/export, search, pagination
```

- Rooms are multi-tenant: `/game/:roomId` gives each room its own referee instance, state file, journal, and SSE channel — rooms never share state.
- Latency compensation: `/api/time` implements NTP-style ping-pong RTT so clock deductions account for network transit, not just server-side elapsed time.
- Security boundary in `server.js`: strict CORS allowlist (`CHESS_ALLOWED_ORIGIN`, defaults to localhost/127.0.0.1 on the server's own port), 8KB request body cap, path-traversal and dotfile denial on static serving, `nosniff`/`no-store` headers.
- Config is via env vars, not files: `CHESS_PORT`, `CHESS_ALLOWED_ORIGIN`, `CHESS_STATE_FILE`, `CHESS_JOURNAL_FILE`, `CHESS_DB_FILE`, `CHESS_JSON_ARCHIVE_FILE`, `CHESS_ARCHIVE_FORCE_JSON=1` (force JSON archive over SQLite), `CHESS_SSE_HEARTBEAT_MS`, `CHESS_SSE_WATCH_INTERVAL_MS`.

### Client-side (all plain scripts loaded by `index.html`, no bundler)

- `ui.js` — the orchestrator: SSE/poll receiver and diff-based board reconciliation, drag-and-drop, move tree scrubber, multi-premove queueing (up to 5 plies), right-click annotation canvas, audio/haptics, seat management, clock-tick interpolation (render-only — never mutates authoritative time), theme switching (`[data-theme]` / `[data-mode=dark]`).
- `pieces.js` — inline SVG chess pieces (Colin M.L. Burnett cburnett artwork, `CBURNETT-LICENSE.txt`).
- `stockfish-worker.js` — Web Worker running Lightweight Local Heuristic Engine (PST + material evaluation) over UCI (`uci`, `isready`, `position fen`, `go depth`), multi-PV candidate lines, with Stockfish 17 UCI alias for protocol compatibility.
- `move-review.js` — CAPS-style win-probability accuracy scoring and move classification (Brilliant/Great/Best/Excellent/Good/Inaccuracy/Mistake/Blunder), consuming Stockfish output.
- `openings-db.js` — ECO opening database (prefix matching, master win rates) and the SVG evaluation-graph math.

### Adding or changing a feature

1. If it touches game state (moves, clocks, draws, resignation), the change belongs in `referee-service.js` / `rules-engine.js` / `engine.js`, exposed through a new/existing `server.js` route — never implemented as a client-side shortcut.
2. If it's visual/analytical only, it belongs in `ui.js` or a sibling client script and must derive entirely from server-reported state.
3. Add a matching `*-selftest.js` for the feature area (follow the existing phase-based naming: `p1-`, `p2-`, `p3-`, `gate3-`..`gate5-`) and, if it's core/security/critical-path, wire it into `test:unit` in `package.json`.
4. Run `npm run lint` (syntax-checks every server/test file) before considering a change done — there's no linter beyond `node --check`.
