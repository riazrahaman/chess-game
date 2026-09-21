# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A vanilla-JS chess site with an authoritative Node.js referee backend. No build step, no framework, no
bundler — `server.js` serves plain `<script>` files from an allowlist. A vendored Stockfish 19 (lite,
single-threaded WASM, GPL-3.0, `vendor/stockfish/`) runs both in a browser Web Worker (analysis) and
server-side (bots). Deployed on Render at https://chess-game-0zax.onrender.com from `main`.

## Commands

```bash
npm install
node server.js                        # http://127.0.0.1:39281  (CHESS_PORT=… or PORT=… to override)

npm run check                         # lint + all 79 unit suites (~7 min; the differential suite replays 200 games)
npm run lint                          # node --check over server, client, and test files
npm run test:unit                     # every wired *-selftest.js, serially
npm run test:browser                  # Playwright: scripts/smoke-test.mjs + scripts/test-ui-features.mjs
npm run lint:eslint                   # ESLint flat config, warnings only

node test/<name>-selftest.js          # run ONE suite (there is no test runner; each file is a standalone script)
node scripts/engine-probe.js          # prove the vendored engine runs under Node
```

Rules of the test harness:
- Each `test/*-selftest.js` is standalone, prints `PASS:`/`FAIL:` lines, exits non-zero on failure. Match the
  harness pattern of a neighbouring suite (`let passed=0; function test(name, fn) {…}`).
- A new suite must be appended to **both** `test:unit` and `lint` in `package.json` or it is silently orphaned
  (edit `package.json` via `python3 json.load/json.dump(indent=2)` then `printf '\n' >> package.json`).
- Suites that start the server must put state in `os.tmpdir()` via env vars: `CHESS_STATE_FILE`,
  `CHESS_JOURNAL_FILE`, `CHESS_DB_FILE` / `CHESS_JSON_ARCHIVE_FILE`, `CHESS_ACCOUNTS_DB_FILE`,
  `CHESS_SOCIAL_DB_PATH`, `CHESS_LEAGUES_DB_PATH`. Otherwise `.referee-*` files and `*.db` land in the repo root.
- Do not run two server-starting suites concurrently in the same checkout; they share those files.
- The browser scripts hard-code port 39281, open `#/play`, and use the page's own auto-room. Start
  `CHESS_PORT=39281 node server.js` first (they don't spawn one reliably). Restart the server after editing
  `server.js` — the allowlist is read at boot.
- Runtime data files (`src/games.db`, `src/accounts.db`, `social.db`, `.referee-*`) are gitignored. The live
  archive is `src/games.db` (paths resolve next to the module), not the stale `games.db` in the repo root.

## The invariant everything hangs on

**The referee is the single source of truth.** `src/referee-service.js` owns board, clocks, history, per-ply
positions, draw offers and claims, behind a serialized FIFO command queue with an append-only JSONL journal and
an atomic JSON snapshot (crash recovery replays the journal). Everything the browser shows is re-rendered from
`GET /api/state` or the SSE stream; every mutation goes through `POST /api/move|resign|draw/*|undo|reset|setup|
time-control` and `seat-auth.js` seat tokens.

- **Gate 4:** no client module (`src/ui*.js`, `src/shell.js`) may reference `makeMove`, `createInitialBoard`, or
  `historyToSan` — not even split across string literals. `test/t0-deadcode-selftest.js` token-scans for it.
  The referee ships `state.positions[] = {fen, san, lastMove}` per ply precisely so the client never replays moves;
  the Analysis and Puzzles views render from those (or from `/api/games/:id` positions) with a display-only FEN parser.
- Draw policy is FIDE/lichess: fivefold, 75-move and insufficient material are automatic
  (`rulesEngine.automaticDraw`); threefold and 50-move are exposed as `state.claimableDraw` and claimed via
  `POST /api/draw/claim`.
- Clocks are interpolated client-side for rendering only, and only once the first move has been made.

## Architecture in one pass

```
server.js  ── HTTP + SSE + static allowlist (ALLOWED_FILES) + CSP/headers + gzip/ETag
  ├─ referee-service.js (per-room)  ← rules-engine.js (chess.js adapter) + engine.js (in-house movegen/SAN)
  ├─ seat-auth.js       seat tokens; claims can carry the signed-in account (used for rating)
  ├─ bot-service.js     bots via engine-server.js (Stockfish in a worker_thread; Skill Level L1–3, UCI_Elo L4–8),
  │                     PST heuristic in stockfish-worker.js only as fallback; L1–4 book = data/openings.tsv
  ├─ accounts.js        scrypt accounts + sessions (accounts.db), Google Identity via GOOGLE_CLIENT_ID;
  │                     POST /api/auth/google {demoUser} is a credential-free login ONLY when ALLOW_DEMO_AUTH=1
  ├─ game-archive.js    SQLite (node:sqlite) with JSON fallback: games, eval cache, puzzles, puzzle attempts/
  │                     ratings/reviews, rating pools, rate limits
  ├─ routes-puzzles.js  /api/puzzle/*  (server verifies every move against the solution)
  ├─ routes-social.js   /api/lobby/*, /api/leaderboard/:tc, /api/arena/*, /api/social/*  (+ social-store.js)
  ├─ routes-openings.js /api/openings/lookup|personal, /api/fen/validate
  ├─ routes-library.js  /api/library, /api/import/lichess|chesscom (games carry owner_id/source/external_id)
  ├─ routes-retention.js /api/streak, /api/activity, /api/achievements (streaks.js, achievements.js; social-store.js)
  ├─ routes-insights.js /api/insights, /api/league (insights.js, leagues.js + leagues.db)
  ├─ routes-review.js   /api/games/:id/missed-tactics, POST /api/review/missed-tactics (missed-tactics.js)
  ├─ rating-hook.js     rates a game on gameOver iff both seats are signed-in humans, no bot, ≥2 plies;
  │                     also the game-over fan-out (streaks, leagues, insights subscribe to it)
  └─ room GC           idle personal rooms are archived + deleted (CHESS_ROOM_* env; /api/admin/rooms needs CHESS_ADMIN_TOKEN)
```

Route modules export `handleXRoute(req, res, urlPath, ctx) → boolean` and are called from one hook line each
in `server.js` just before the `/api/` 404 fallthrough. Add new API families the same way.

Client (`index.html` loads ~43 plain scripts, `shell.js` before `ui.js`):
- `shell.js` — hash router. Views register with
  `Shell.registerView({id, title, order, nav, mount(el, params), show(el, params), hide(el)})`; sections are
  `<section data-view="…">` (the Play view is the existing `<main id="workspace" data-view="play">`). Routes:
  `#/`, `#/play?bot=1|invite=1`, `#/analysis?game=<id>|fen=…`, `#/puzzles?theme=…`, `#/library`, `#/insights?metric=&dimension=`, `#/compete`, `#/me`, `#/settings`.
  `index.html` has `<base href="/">` (so assets resolve under `/game/<room>`), which makes `href="#/x"` a full
  navigation — the shell delegates hash-link clicks; use `Shell.navigate()` from code.
- `ui.js` — the Play orchestrator: SSE + backoff polling, diff-rendered board, pointer drag, scrubber, premoves,
  seats/bot config, draw negotiation. Siblings: `ui-sound/theme/annotations/archive/auth/settings.js`.
- Feature views: `ui-puzzles.js`, `ui-analysis.js` (own board + its own engine Worker), `ui-library.js`,
  `ui-insights.js`, `ui-compete.js`, `ui-profile.js`; `ui-retention.js` decorates header/Home/Profile. Each keeps its own DOM inside its section and never touches `#board`.
- `stockfish-worker.js` — the analysis Worker. Loads `/vendor/stockfish/…` as a nested Worker, falls back to the
  PST engine, and reports which is active (`{type:'engine-ready', engine:'stockfish19-lite'|'pst'}`); evals are
  white-perspective and carry `depth`, `engine`, `mate`, `multipv`.
- `service-worker.js` — precaches the shell; **never** serves `/api/*` from cache.

Auto-rooms: a plain visit keeps the root URL but a private room id is minted into
`localStorage.chess_personal_room` (`ui.js`) and resolved by `getCurrentRoomId()` (path `/game/<room>` →
`?room=` → stored → `default`), so the address bar never shows `/game/<personal-room>`. Each room has its own
referee, seats, bot, and state files. Anything that talks to the API from a page must pass `?room=` /
`getCurrentRoomId()`; the default room is not the page's room.

## Definition of Done (enforced)

A feature is done only when all four hold — this repo previously accumulated ~30 "done" modules nobody could reach:
1. module + selftest green, wired into `test:unit` and `lint`;
2. reachable: `<script>` in `index.html` **and** listed in `server.js` `ALLOWED_FILES` **and**
   `service-worker.js` `PRECACHE_ASSETS`, with a real call site — or, for server modules, a mounted route;
3. real data behind it (no invented statistics; the opening win-rates and "master game counts" were removed
   for exactly this reason);
4. exercised by `scripts/test-ui-features.mjs` where it has UI.

`test/reachability-selftest.js` enforces (2): every loaded script must be servable, precached and called; every
`src/*.js` must be loaded, required, or listed in its `KNOWN_DARK` map with the roadmap item that will wire it.
That list may only shrink. Datasets shipped in-repo must be small and openly licensed (`data/README*.md`
records provenance): `data/openings.tsv` (lichess chess-openings, CC0) and `data/puzzles-sample.csv` (8,861
lichess puzzles, CC0; `scripts/import-puzzles.mjs` streams the full dump).

## Known gaps (as of Wave 3)

`GET /api/games` is unscoped (owned/imported games visible to any visitor); `service-worker.js` `CACHE_NAME` is
still `chess-ui-v1`; brilliant/tablebase achievement events can only be owner-verified once archived games carry
real player names; `scripts/test-ui-features.mjs` lacks Puzzles/Library/Insights/Missed-tactics steps; still-dark
modules are listed in `KNOWN_DARK`. Full list: `HANDOVER.md` §8.

## Where the plan lives

- `docs/06-world-class-roadmap.md` — audited state vs. claims, bug table with status, phased roadmap and
  sourced feature deltas. Update its status markers when you land an item.
- `HANDOVER.md` — per-wave status tables (§5 Wave 0, §6 Wave 1, §7 Wave 2 incl. the shell view contract, §8 Wave 3)
  and open follow-ups. `docs/kanban-tasks.json` + `scripts/kanban-sync.mjs` mirror the plan to the kanban board. Work is done on feature branches, merged to `main` only after `npm run check` and both
  browser scripts pass, then pushed (Render deploys `main`).
- `RECOMMENDATIONS.md` is the historical roadmap; its "Done" marks predate the audit and are not reliable.
