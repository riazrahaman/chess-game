# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local-first, vanilla-JS chess app with an authoritative Node.js referee backend, a Lightweight Local Heuristic Engine analysis worker (with Stockfish 17 UCI protocol compatibility), AI bot opponents, AI coach & move explanations, mistake puzzle generator, post-game prose reports, voice move recognition, blind accessibility mode, and multi-room multiplayer over SSE. No build step, no framework, no bundler — plain `<script>` files served directly by `server.js`.

## Repository layout

- `src/` — all source modules (referee-service, rules-engine, engine, game-archive, bot-service, seat-auth, stockfish-worker, ui.js + its sibling modules, and every feature module). `referee-helper.cjs` also lives here.
- `test/` — all `*-selftest.js` suites (run with `node test/<name>-selftest.js`).
- Repo root — `server.js` (entrypoint), `index.html`, `manifest.webmanifest`, `service-worker.js` (must stay at root for scope `/`), `CBURNETT-LICENSE.txt`, `package.json`, `eslint.config.js`, plus `docs/`, `scripts/`, `assets/`.

Internal `require()` calls are relative (e.g. `require('./rules-engine.js')` inside `src/`), so they remain correct because all modules live together in `src/`. `server.js` requires via `./src/<name>.js`; selftests require via `../src/<name>.js`. Browser-side static serving resolves against `src/` (script `src="src/<name>.js"`), and `server.js`'s `ALLOWED_FILES` lists `src/<name>.js` entries.

## Commands

```bash
npm install
node server.js               # start server on port 39281 (http://127.0.0.1:39281)
CHESS_PORT=1234 node server.js   # override port

npm test                     # full suite: unit tests + Playwright browser smoke test
npm run test:unit            # all unit & integration selftests
npm run lint                 # node --check across all server, client worker, and test files
npm run lint:eslint          # ESLint (flat config) over UI modules + server + engine (warnings only)
npm run check                # lint + test:unit
```

There is no test framework/runner — each `*-selftest.js` file is a standalone Node script with its own assertions that exits non-zero on failure. Run any single suite directly:

```bash
node test/engine-selftest.js              # core engine + referee (159 tests)
node test/pieces-selftest.js              # SVG piece rendering (32 tests)
node test/security-selftest.js            # CORS, path traversal, body limits (58 tests)
node test/differential-selftest.js        # 200 random games vs chess.js (37,800+ plies)
node test/p3-multiroom-selftest.js        # multi-room isolation & routing
node test/p3-sqlite-selftest.js           # SQLite archive CRUD + PGN import/export + eval cache (101 tests)
node test/p3-seat-selftest.js             # seat tokens, heartbeats & mutation security (41 tests)
node test/t0-draw-flagfall-selftest.js     # draw claims & flag fall timeouts (51 tests)
node test/t0-deadcode-selftest.js         # rate limiting, NTP sync, idempotency & Gate-4 module checks (21 tests)
node test/p2-stockfish-selftest.js        # local heuristic engine, WASM bridge & UCI protocol (58 tests)
node test/p2-review-selftest.js           # win-probability logistic curve & move classification (51 tests)
node test/rating-selftest.js              # Glicko-2 rating engine (36 tests)
node test/t1-mobile-visuals-selftest.js   # pointer events, bevel framing & piece shadows (16 tests)
node test/p3-social-timecontrol-selftest.js # time controls, chat, rematch & spectator presence (10 tests)
node test/c5-ai-bot-selftest.js           # Play vs Computer levels 1-8 bot opponent (10 tests)
node test/bot-tactics-selftest.js         # bot tactical strength & opening book
node test/c7-ai-puzzles-selftest.js       # blunder puzzle generator & retry mode (6 tests)
node test/c2-c4-coach-selftest.js         # why move explanations & coach mode hints (6 tests)
node test/c6-ai-report-selftest.js        # auto post-game report & annotated PGN (5 tests)
node test/c8-d4-voice-selftest.js         # voice move recognition, audio announcements & blind mode (7 tests)
node test/puzzle-service-selftest.js      # lichess puzzle CSV import + UCI->SAN (11 tests)
node test/puzzle-rating-selftest.js       # puzzle Glicko-2 rating loop (9 tests)
node test/puzzle-storm-selftest.js        # puzzle storm + seeded RNG (9 tests)
node test/daily-puzzle-selftest.js        # daily puzzle date-seeded pick (6 tests)
node test/puzzle-repetition-selftest.js   # spaced-repetition mistake review (24 tests)
node test/study-tree-selftest.js          # studies variation tree + PGN/RAV round-trip (49 tests)
node test/openings-explorer-selftest.js   # real opening explorer (TSV + personal stats) (35 tests)
node test/eval-graph-selftest.js          # interactive eval graph click-to-jump (51 tests)
node test/accounts-selftest.js            # accounts & profiles (scrypt auth) (8 tests)
node test/ratings-pool-selftest.js        # per-time-control Glicko-2 pools & leaderboards (10 tests)
node test/lobby-selftest.js               # lobby seeks/challenges/matchmaking (9 tests)
node test/pwa-selftest.js                 # manifest + service worker structural validation (9 tests)
node test/sse-hardening-selftest.js       # event-driven emits + Last-Event-ID replay (16 tests)
node test/security-headers-selftest.js    # CSP/HSTS/helmet headers + persistent rate limiting (17 tests)
node test/masters-db-selftest.js          # masters-DB mistake whitelist (book-theory reclassification) (10 tests)
node test/acpl-selftest.js                # ACPL + move-time stats + phase-segmented accuracy (10 tests)
node test/puzzle-racer-selftest.js        # multiplayer puzzle race (streak multipliers, seeded) (10 tests)
node test/a11y-intents-selftest.js        # text entry + touch gestures + voice intents (14 tests)
node test/chess960-selftest.js            # Fischer Random position gen + castling rules (14 tests)
node test/fen-setup-selftest.js           # FEN validation + referee setup command (10 tests)
node test/time-control-selftest.js        # per-color clocks, delay/Bronstein, odds, TC labels (20 tests)
node test/tablebase-selftest.js           # lichess Syzygy tablebase probe + offline fallback (12 tests)
node test/arena-selftest.js               # arena tournaments (Swiss pairing, tie-breaks, berserk) (13 tests)
node test/social-graph-selftest.js        # social graph (follow/block/friends) (12 tests)
node test/chat-upgrades-selftest.js       # chat upgrades (reactions, moderation, move refs) (9 tests)
node test/correspondence-selftest.js      # correspondence mode (day clocks, conditional premoves) (10 tests)
node test/personality-bots-selftest.js    # personality bots (5 personas, play styles) (9 tests)
node test/pov-export-selftest.js          # annotated-POV PGN export + summary card (8 tests)
node test/embed-viewer-selftest.js        # embeddable viewer (FEN→SVG + iframe snippet) (9 tests)
node test/variants-selftest.js            # variants (Crazyhouse/Atomic/KOTH/Three-Check) (10 tests)
node test/i18n-selftest.js                # i18n layer (en/es/fr catalog + interpolation) (10 tests)
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
server.js            HTTP API, static file serving, SSE stream (event-driven emits + Last-Event-ID
                     replay), CORS/security boundary (CSP/HSTS/helmet headers), persistent
                     SQLite-backed rate limiting, room routing
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
                           Roster PGN parsing/export, search, pagination; also the persistence
                           backend for eval cache, puzzle ratings/reviews, rating pools, and
                           persistent rate-limit counts
```

### Client-side (all plain scripts loaded by `index.html`, no bundler)

- `ui.js` — the orchestrator: SSE/poll receiver and diff-based board reconciliation, pointer events touch/mouse drag-and-drop, move tree scrubber, multi-premove queueing (up to 5 plies), right-click annotation canvas, audio/haptics, seat management, clock-tick interpolation (render-only — never mutates authoritative time), theme switching (`[data-theme]` / `[data-mode=dark]`). Split into sibling modules loaded before it: `ui-sound.js` (audio/haptics), `ui-theme.js` (theme switching), `ui-annotations.js` (annotation canvas), `ui-archive.js` (archived-game view).
- `rating.js` — Glicko-2 rating engine (createPlayer / updateRating / rateMatches / expectedScore / confidenceInterval).
- `pieces.js` — inline SVG chess pieces (Colin M.L. Burnett cburnett artwork, `CBURNETT-LICENSE.txt`).
- `stockfish-worker.js` — Web Worker running Lightweight Local Heuristic Engine (PST + material evaluation) over UCI (`uci`, `isready`, `position fen`, `go depth`), multi-PV candidate lines, with Stockfish 17 UCI alias for protocol compatibility and an optional WASM bridge (`WasmEngine`) that falls back to the PST engine on failure.
- `move-review.js` — CAPS-style win-probability accuracy scoring, move classification (Brilliant/Great/Best/Excellent/Good/Inaccuracy/Mistake/Blunder), and blunder puzzle generation (`generateMistakePuzzles`).
- `ai-coach.js` — plain-English move explanations (`explainMove`) and real-time coaching suggestions on active turn (`getCoachHint`).
- `game-report.js` — auto post-game narrative report generation (`generatePostGameReport`), accuracy summary, turning point swing analysis, endgame performance, and annotated PGN with NAG glyphs and eval comments.
- `accessibility-voice.js` — natural spoken English move announcements via SpeechSynthesis API, voice move input recognition via Web Speech API, and blind accessibility mode controller with keyboard grid navigation.
- `openings-db.js` — ECO opening database (prefix matching, master win rates) and the SVG evaluation-graph math.
- `puzzle-service.js` — lichess puzzle CSV import (UCI→SAN conversion via chess.js) into SQLite; filterable themed subsets.
- `puzzle-rating.js` — puzzle-vs-player Glicko-2 rating loop (each solve scored as a game, time bonus).
- `puzzle-storm.js` — timed Puzzle Storm sessions (deterministic seeded RNG, escalating difficulty) + `daily-puzzle.js` date-seeded daily pick.
- `puzzle-repetition.js` — Chessable-style spaced-repetition mistake review (expanding intervals, persisted per player).
- `study-tree.js` — pure-data variation tree with `toPGN`/`fromPGN` RAV round-trip (Studies substrate).
- `openings-explorer.js` — real opening explorer: lichess TSV import + personal archive stats (no fabricated win-rates).
- `eval-graph.js` — interactive click-to-jump eval graph with per-ply tooltips (SAN/eval/ACPL delta).
- `accounts.js` — accounts & profiles (Node `crypto.scrypt` hashing with per-user salt, `timingSafeEqual` verification, `publicAccount()` strips hash/salt, archive-based `playerProfile` aggregation).
- `ratings-pool.js` — per-time-control Glicko-2 rating pools (provisional `RD>110` handling, bot games explicitly unrated) + leaderboards, persisted via `game-archive.js`.
- `lobby.js` — lobby seeks/challenges/matchmaking (rating brackets with mutual tolerance, seeded-RNG tie-break, room-id validation).
- `service-worker.js` — PWA service worker (precache + cache-first GET + navigate fallback) + `manifest.webmanifest`.
- `masters-db.js` — compact frequency-sorted master opening book; `whitelistMistakes` reclassifies book-theory moves (≥2 master games) from blunder/mistake to best.
- `acpl.js` — ACPL (average centipawn loss), move-time stats, phase-segmented accuracy (opening/middlegame/endgame).
- `puzzle-racer.js` — multiplayer puzzle race (seeded sequence, streak multipliers ×2 capped ×8).
- `a11y-text-entry.js` / `a11y-gestures.js` / `voice-intents.js` — typed command entry, touch swipe gestures, and voice intent routing for accessibility.
- `chess960.js` — Fischer Random (Chess960) start-position generation (SP 0–959) + castling rules.
- `fen-setup.js` — FEN parse/validate/canonicalize for the referee `setup` command.
- `time-control.js` — per-color clocks, delay/Bronstein, odds, lichess TC label formula.
- `tablebase.js` — lichess Syzygy tablebase probe (7-piece WDL/DTZ) with offline engine-eval fallback.
- `arena.js` — arena tournaments (Swiss pairing, Buchholz + Sonneborn-Berger tie-breaks, berserk).
- `social-graph.js` — follow/block/friend relationships with injected persistence backend.
- `chat-upgrades.js` — chat move refs, draw offers, reactions, moderation, history cap.
- `correspondence.js` — multi-day clocks, conditional premoves (if-then chains), flag detection.
- `personality-bots.js` — 5 persona bots (Tal/Karpov/Capablanca/Morphy/Nimzowitsch) with play-style profiles + chat commentary.
- `pov-export.js` — annotated per-POV PGN export + summary-card SVG.
- `embed-viewer.js` — FEN→SVG board renderer + iframe embed snippet.
- `variants.js` — Crazyhouse / Atomic / King-of-the-Hill / Three-Check rules.
- `i18n.js` — strings catalog (en/es/fr) with interpolation + locale→en→raw fallback.

### Adding or changing a feature

1. If it touches game state (moves, clocks, draws, resignation), the change belongs in `referee-service.js` / `rules-engine.js` / `engine.js`, exposed through a new/existing `server.js` route — never implemented as a client-side shortcut.
2. If it's visual/analytical only, it belongs in `ui.js` or a sibling client script and must derive entirely from server-reported state.
3. Preserving Gate 4 invariant: `ui.js` must NEVER call `makeMove(` or `createInitialBoard(`.
4. Add a matching `*-selftest.js` for the feature area and wire it into `test:unit` and `lint` in `package.json`.
5. Run `npm run check` before considering a change done.
