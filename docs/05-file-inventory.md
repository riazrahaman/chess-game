# Chess Game — File Inventory (by role)

`ls src/` lists ~70 modules; this page groups them by role so you know where a change belongs. Every module's
reachability (loaded / allowlisted / precached / called) is enforced by `test/reachability-selftest.js`.

## Server core (required from `server.js`, never shipped to the browser)
| Module | Role |
|---|---|
| `server.js` | HTTP API, SSE, static allowlist (`ALLOWED_FILES`), CSP/HSTS/CORS, gzip + ETag, rate limiting, auth routes, room router, idle-room GC, admin routes |
| `src/referee-service.js` | authoritative per-room game state: FIFO command queue, journal + snapshot, per-ply positions, claimable draws, human-vs-human undo requests (`state.undoRequest`), room inspection/deletion for GC; `applyDrawStatus()` derives the automatic + claimable draw verdicts from a single history replay (M5) |
| `src/rules-engine.js`, `src/engine.js` | chess.js adapter (legality, FEN, SAN, automatic vs claimable draws — `drawStatus()` returns both from one replay, M5) and in-house move generator/PGN builder |
| `src/seat-auth.js` | seat tokens per room; claims may carry the signed-in account |
| `src/bot-service.js`, `src/engine-server.js` | Play-vs-Computer ladder over Stockfish in a worker thread; TSV opening book for L1–L4; PST fallback |
| `src/accounts.js` | scrypt accounts, sessions, Google Identity verification |
| `src/game-archive.js` | SQLite archive: games (owner/source/external id), eval cache, puzzles + attempts, puzzle ratings/reviews, rating pools, rate limits, imports |
| `src/social-store.js`, `src/leagues-store.js` | social graph, arenas, activity days, streaks, achievements; league weeks/divisions |
| `src/study-store.js` | study chapters over `node:sqlite` (`CHESS_STUDY_DB_PATH`, default `study.db`) with the JSON fallback (`CHESS_STUDY_JSON_PATH`, `.study.json`); same adapter shape as `social-store.js` |
| `src/rating-hook.js` | game-over fan-out: rates human-vs-human games, notifies streaks/leagues/insights |

## Route modules (`handleXRoute(req, res, urlPath, ctx) → boolean`, one hook line each in `server.js`)
`routes-puzzles.js` (`/api/puzzle/*`) · `routes-social.js` (`/api/lobby|leaderboard|arena|social/*`) ·
`routes-openings.js` (`/api/openings/*`, `/api/fen/validate`) · `routes-library.js` (`/api/library`, `/api/import/*`) ·
`routes-retention.js` (`/api/streak`, `/api/activity`, `/api/achievements`) · `routes-insights.js` (`/api/insights`, `/api/league`) ·
`routes-review.js` (`/api/games/:id/missed-tactics`, `POST /api/review/missed-tactics`) ·
`routes-study.js` (`/api/study*`, Wave 4 A2.2 — PGN/FEN/game chapters, hidden-move quiz, NAG PGN export).

## Server-side feature libraries (pure logic, injected stores; each has a selftest)
`rating.js` (Glicko-2) · `ratings-pool.js` · `lobby.js` · `arena.js` · `social-graph.js` · `streaks.js` ·
`achievements.js` · `leagues.js` · `insights.js` · `puzzle-service.js` · `puzzle-rating.js` · `puzzle-storm.js` ·
`daily-puzzle.js` · `puzzle-repetition.js` · `openings-explorer.js` (TSV index) · `import-external.js` ·
`missed-tactics.js` · `time-control.js` · `fen-setup.js` · `study-tree.js` (variation tree with RAV + NAG PGN round-trip, used by `routes-study.js`).

## Client shell and views (plain `<script>` tags in `index.html`, `shell.js` before `ui.js`)
| Module | Role |
|---|---|
| `src/shell.js` | hash router, nav, view registry (`Shell.registerView`), Home onboarding |
| `src/ui.js` | Play view orchestrator: SSE + backoff polling, diff-rendered board, drag, scrubber, premoves, seats/bot config, draw UI, Game Review |
| `ui-sound.js`, `ui-theme.js`, `ui-annotations.js`, `ui-archive.js`, `ui-auth.js`, `ui-settings.js`, `ui-retention.js` | Play/header helpers: audio, themes, arrows, archive modal + auto-save, sign-in, Settings view, streak badge + achievements panel |
| `ui-puzzles.js`, `ui-analysis.js`, `ui-library.js`, `ui-insights.js`, `ui-compete.js`, `ui-profile.js`, `ui-study.js` | feature views (`#/puzzles`, `#/analysis`, `#/library`, `#/insights`, `#/compete`, `#/me`, `#/study`); each owns its own DOM and board, never `#board` |
| `stockfish-worker.js` | analysis Web Worker: nested Stockfish 19 Worker, PST fallback, MultiPV, engine-ready reporting |
| `sw-register.js`, `service-worker.js`, `manifest.webmanifest` | PWA registration (external file so CSP has no inline scripts), precache of the shell, never `/api/*` |

## Client analysis/display libraries (also loaded by `index.html`)
`pieces.js` (cburnett SVG) · `move-review.js` (CAPS accuracy, classifications incl. Miss, mistake puzzles) ·
`ai-coach.js` · `game-report.js` · `accessibility-voice.js` · `a11y-text-entry.js` · `a11y-gestures.js` ·
`voice-intents.js` · `openings-db.js` (names/ECO only) · `masters-db.js` (book membership) · `eval-graph.js` ·
`acpl.js` · `tablebase.js` · `pov-export.js` · `embed-viewer.js`.

## Still dark (shipped or present but not yet wired — listed in `KNOWN_DARK`)
`chess960.js`, `variants.js`, `chat-upgrades.js`, `correspondence.js`, `personality-bots.js`, `i18n.js`,
`puzzle-racer.js`, `fen-setup.js`, and the browser copies of `game-archive.js` / `time-control.js`.

## Data, vendor, scripts, tests
- `data/openings.tsv`, `data/puzzles-sample.csv` (+ READMEs with provenance/licence)
- `vendor/stockfish/` — engine loader + WASM + `Copying.txt` + upgrade notes
- `scripts/smoke-test.mjs`, `scripts/test-ui-features.mjs` (Playwright), `scripts/engine-probe.js`, `scripts/import-puzzles.mjs`, `scripts/kanban-sync.mjs`
- `test/*-selftest.js` — one standalone script per area; `wave0`–`wave3` suites cover the audited work; `reachability` and `t0-deadcode` are the structural guards; `g4-undo-request-selftest.js` covers the consent-gated undo (76 assertions)

## Runtime artifacts (gitignored)
`.referee-state.json` / `.referee-journal.jsonl` (default room) and `.referee-state-<room>.json` /
`.referee-journal-<room>.jsonl` per personal room (garbage-collected when idle), `src/games.db`,
`src/accounts.db`, `social.db`, `leagues.db`, `.claude/worktrees/` (agent worktrees).
