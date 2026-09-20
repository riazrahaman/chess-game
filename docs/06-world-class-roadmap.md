# 06 — World-Class Roadmap (deep-dive + 2026 research)

*Written 2026-09-17. Produced by four parallel audits: (1) module reachability, (2) data/asset reality,
(3) online delta research vs. lichess / Chess.com / Chessable / Maia / engine-in-browser state of the art,
(4) product/UX shell review with live screenshots. `RECOMMENDATIONS.md` remains the historical record;
this document is the delta measured against it. **Re-scanned 2026-09-18** after commit `0b25073`
(Google Auth, isolated sessions, auto-room routing) — see §1a for what changed.*

**Every recommendation is tagged with the layer it lives in** — `[referee]` (referee-service / rules-engine /
engine, needs a server route), `[server]` (server.js / archive / bot-service, no game-state change),
`[display]` (ui.js + siblings, reads state only) — so nothing here can violate the referee-authoritative /
Gate-4 invariant. Size: S (≤1 day), M (2–5 days), L (1–3 weeks).

---

## 0. Executive summary

The app has a genuinely world-class **core**: a referee-authoritative backend with FIFO command queue,
JSONL journal + atomic snapshot, crash recovery, seat-token security, draw rules, flag fall, multi-room
isolation, a differential-validated move engine, and unusually strong accessibility. Keep all of it.

But the gap between what `RECOMMENDATIONS.md` marks **Done** and what a user can **experience** is the
single biggest finding of this audit:

| Claim | Reality (verified) |
|---|---|
| "X1 Stockfish WASM in the Web Worker — Done" | **No engine binary exists anywhere.** `stockfish-worker.js:768,978` fetches `src/stockfish.wasm`, which has never existed; `ALLOWED_FILES` (`server.js:311-312`) whitelists two nonexistent files; on failure it silently falls back to a PST+material heuristic. The selftest only string-matches `server.js`. **→ fixed in Wave 1**: Stockfish 19 lite-single WASM vendored under `vendor/stockfish/` (96e5d51), loaded in the Worker and on the server; `test/wave1-engine-selftest.js` actually runs the engine. |
| Bot levels "Novice 800 … GM 2200" (`index.html:954-961`) | Same PST engine, depth 1–4, **no quiescence search**, no TT, no iterative deepening. Depth-1 probe hangs a queen to a defended pawn. Honest strength ≈ **1000–1400**. Levels 5≡6 and 7≡8 are identical configs with different labels. |
| "P1 Import lichess 6.1M puzzle CSV into SQLite — Done" | `puzzle-service.js` is **in-memory** (`replaceStore` :120-124), no CSV shipped, **no puzzles table**, **0 puzzles**, no route, not loaded by `index.html`. |
| "A2.3 Real opening explorer — Done" | `openings-explorer.js` is **never loaded**. The UI still renders the 25-entry `openings-db.js` with **fabricated win-rates** (`ui.js:1946-1990`) — now with an "illustrative" caveat — and the bot uses those fabricated frequencies as its opening book. |
| "A2.4 Masters-DB whitelist — Done" | 21 positions with uncited round-number "game counts", comment says "real-data subset". Zero production call sites. |
| Ratings / lobby / arena / social / correspondence / studies / i18n — all "Done" | **No server route, no DB table, no UI element** for any of them. Library-only modules with injected persistence that nothing injects. (Accounts moved to PARTIAL on 2026-09-18 — routes + SQLite now exist, but the client script is not servable; see B11.) |
| "M2 i18n — Done" | 14 keys × 3 locales; **0 of 14 used**. ~100% of UI text hardcoded. |

**Net: 28 of 50 `src/` modules are dark** (re-scan 2026-09-18). 18 are shipped to every browser (~100 KB, precached by the
service worker) and never called; 10 are never loaded by anything; the new `ui-auth.js` is loaded but not servable. The entire puzzle / lobby / accounts / ratings / studies product family is unreachable.

The roadmap therefore has three phases, in strict order:

1. **Credibility** — ship a real engine, make labels honest, replace fabricated data with real data.
2. **Reachability** — build a site shell and wire the ~25 already-written, already-tested modules into it. This is the highest ROI work in the codebase: the libraries exist and are green.
3. **Net-new features** — the 2026 delta (Maia opponents, streaks, leagues, teams, repertoire trainer, insights, practice curriculum, broadcasts…), each sourced.

---

## 1. Verified state — full reachability table

Legend: REACHABLE = loaded + called + visible affordance. PARTIAL = one side live. DARK = zero call sites.

**REACHABLE (13):** engine, pieces, move-review, ai-coach, game-report, accessibility-voice, openings-db,
ui-sound, ui-theme, ui-annotations, ui-archive, eval-graph, ui.js.

**SERVER-ONLY (5, working):** referee-service, rules-engine, seat-auth, bot-service, referee-helper.cjs.

**PARTIAL (5):**
- `accounts.js` — **now `require()`d by `server.js:10`** with routes `GET /api/auth/config`, `POST /api/auth/google|register|login|logout`, `GET /api/auth/me`, `GET /api/profile`, and a real SQLite `accounts.db` (`accounts` + `sessions` tables, JSON fallback). Server side is live.
- `ui-auth.js` (new, 274 lines) — loaded at `index.html:1268` but **absent from `ALLOWED_FILES` and `PRECACHE_ASSETS` → HTTP 404** (verified on a fresh server). The Sign In modal, Google button, and New Room button have no working script.
- `game-archive.js` — server side live (`/api/games*`); the ~1,100-line Node/SQLite module is *also* shipped to the browser as `window.GameArchive` and never called.
- `time-control.js` — server path live via `POST /api/time-control`; browser copy dead.
- `stockfish-worker.js` — live Worker, but **not in `PRECACHE_ASSETS`** → eval bar unavailable offline.

**DARK, shipped to browser (18):** masters-db, acpl, puzzle-racer, a11y-text-entry, a11y-gestures,
voice-intents, chess960, tablebase, arena, social-graph, chat-upgrades, correspondence, personality-bots,
pov-export, embed-viewer, variants, i18n (+ time-control browser copy).

**DARK, never loaded (9):** rating, ratings-pool, lobby, puzzle-service, puzzle-rating, puzzle-storm,
daily-puzzle, openings-explorer, puzzle-repetition. *(study-tree wired in Wave 4 — required by `routes-study.js`.)*

**Doc/code contradictions:** `fen-setup.js` is DARK — the referee's `_cmdSetup` uses `rulesEngine.fenToBoard`,
not this module (CLAUDE.md says otherwise). `game-archive.js:23` defaults the DB to `src/games.db`, so the
live archive is `src/games.db` (27 games), not the repo-root `games.db` (138 games, stale) that CLAUDE.md names.

**Dead routes (no client caller):** `POST /api/setup`; `/api/draw/offer|accept|decline|claim` (**`drawOffer`
has zero references in the UI** → an incoming draw offer is invisible to the opponent, there is no decline
button, and 50-move / threefold claims are unreachable); `GET /api/time-control`; `/api/flag` (redundant);
rematch `decline` arm. No orphan client fetches.

### 1a. What changed in commit `0b25073` (2026-09-18) and how it affects this roadmap

- **Accounts went from DARK to PARTIAL.** `server.js` now requires `accounts.js`; seven `/api/auth/*` + `/api/profile` routes exist; `accounts.js` grew to a real SQLite store (`accounts.db`, `sessions` table, atomic JSON fallback). `test/auth-routes-selftest.js` (new) is wired into both `test:unit` and `lint`. **R2's accounts item is now mostly done server-side** — what remains is B11 and a profile view in the shell.
- **New client module `src/ui-auth.js`** — sign-in modal (Google Identity Services + local username/password), guest continue, `#new-room-btn`. It is not servable (B11), so none of this works in the browser today.
- **CSP loosened for Google** (`server.js:462-467`): `script-src` adds `https://accounts.google.com/gsi/client`, `connect-src` and `frame-src` add `https://accounts.google.com/gsi/`. Still `'unsafe-inline' 'unsafe-eval'`; D4 unchanged. Note `connect-src` now has an allowlist pattern to copy for the tablebase (D5).
- **`.gitignore` now covers `*.db`, `accounts.db`, `.accounts.json`.** It does **not** cover the Google OAuth `client_secret_*.json` currently sitting untracked in the repo root (B12).
- **Roadmap line references drifted** in `ui.js` (+~11–13 lines): `showUiError` → 738, `computeHistoryPositions` concat → 786-787 *(since deleted by B3; see §5 M5)*, `refereeClockAt` stamp → 1165, `pollReferee` → 1378, `startSSE` → 1439. `index.html` still has 0 `</details>` (B2 stands). Bug table updated below.
- Nothing in the commit touches the engine, puzzles, openings, bots, caching, or the dark modules — Phases 1–3 are unaffected.

---

## 2. Bugs found during the audit (fix before any feature work)

| # | Bug | Where | Layer | Size | Status (2026-09-18) |
|---|---|---|---|---|---|
| B1 | **White clock counts down before the game starts.** `interpolatedActiveSeconds` subtracts wall-time since `refereeClockAt`, which is stamped on *any* state arrival with no "game started" guard. Screenshot shows 9:57 while `/api/state` says 600/600. The display layer is fabricating authoritative state. Guard on `moveStartTs > 0` / `history.length > 0`. | `ui.js:192-199`, `ui.js:1165` | display | S | **done** 3245d37 |
| B2 | **Room chat is hidden.** `<details id="graph-panel">` is never closed; the parser swallows `#chat-panel` into the collapsed "Evaluation history" disclosure. | `index.html:1089`, `:1095-1104` | display | S | **done** 152aadd |
| B3 | **Gate-4 guard is string-matched and this call site slips past it.** `computeHistoryPositions` calls `engineLookup['create'+'InitialBoard']` and `['make'+'Move']` (`ui.js:786-787`); the concatenated names don't match the `makeMove(` / `createInitialBoard(` string checks in `t0-deadcode-selftest.js:97-98` and `gate4-selftest.js:184`, so at runtime ui.js does invoke the engine mutators (display-only scrubber replay, but the guard no longer catches the next real violation). Fix structurally: have the referee ship per-ply FENs (`/api/positions` or in `stateView`) and delete the workaround; then make the test un-dodgeable (AST or runtime spy). | `ui.js:783-801` (call at 786-787) | referee + display | S/M | **done** 10b3855 |
| B4 | **Draw negotiation is half-wired** (see dead routes above). Render `state.drawOffer`, add Accept/Decline, add a "Claim draw" button when `claimableDraw` is truthy. | `ui.js:1802`, `server.js:917-929` | display | S | **done** e2855fa |
| B5 | **`showUiError` permanently clobbers `#status`**; command errors use a second channel (`#command-status`). Unify on one auto-dismissing toast. | `ui.js:738-745` | display | S | **done** 4f1892a |
| B6 | **Polling never stops.** `pollReferee` re-polls `/api/state` every 600 ms forever, even with SSE open; no client backoff, no `Last-Event-ID`; Playwright `networkidle` never settles. Back off to 10–15 s liveness when SSE `onopen`, resume 600 ms on `onerror`. | `ui.js:1378-1411`, `1439-1470` | display | S | **done** 5b38dfc |
| B7 | **Selftests leave 571 residue files** (`.referee-journal-*`, `.referee-state*`) in the repo root; CLAUDE.md claims they restore on exit. | test harness | server | S | **done** 4757c9d |
| B8 | **Worker still self-identifies as `id alias Stockfish 17 NNUE WASM`** over UCI (`stockfish-worker.js:600`) and the selftest requires it. Remove the alias when the real engine ships (or now). | worker | display | S | **done** 8c42752 |
| B9 | Tracked non-product files: `game-log.md` (AI-vs-AI agent log) and `brief.html` (orchestration brief). Remove from the repo. | root | — | S | awaiting confirmation |
| B10 | `ALLOWED_FILES` lists nonexistent `src/stockfish.js` / `src/stockfish.wasm`; dead client fallbacks at `ui.js:1089-1094`. | server.js:311-312 | server | S | **done** dcf8033+e78d409 |
| B11 | **New (2026-09-18): `src/ui-auth.js` is loaded by `index.html:1268` but not in `ALLOWED_FILES` or `PRECACHE_ASSETS` → 404.** The entire Sign In / Google / New Room UI shipped in `0b25073` is inert. Add to both lists (CLAUDE.md checklist step 5). Consider a `reachability-selftest.js` assertion that every `<script src>` in `index.html` is in `ALLOWED_FILES`. | `index.html:1268`, `server.js:303` | server | S | **done** 2c30698+5533297 |
| B12 | **New: Google OAuth `client_secret_*.apps.googleusercontent.com.json` is sitting untracked in the repo root** and `.gitignore` does not match it. One `git add .` away from a leaked secret. Add `client_secret*.json` to `.gitignore`, move the secret to an env var (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`), and rotate it if it was ever pushed. | repo root, `.gitignore` | server | S | **done** e3b18dd |
| B13 | **Accounts cross-contamination on Node < 22.5.** The `AccountsManager` JSON fallback used `options.jsonPath \|\| DEFAULT_JSON_PATH`, dropping a caller-supplied `dbPath`/string path so every manager shared `src/.accounts.json` (observed as `register alice: username already exists` in `test/study-chapters-selftest.js` under Node 20 with a stale shared file). Fix: mirror the `game-archive.js` precedence ladder (`string options` → `jsonPath` → `:memory:` → `dbPath + '.json'` → `DEFAULT_JSON_PATH`); suites set `CHESS_ACCOUNTS_JSON_FILE` under tmpdir; new `test/accounts-isolation-selftest.js`. | `src/accounts.js`, `test/*-selftest.js` | server | S | **done (fix/accounts-node20-isolation)** |
| B14 | **Sign-in dialog rendered bottom-left, uncentered, with no backdrop.** `#auth-modal` had no CSS rule at all — `openAuthModal()` only removes `.hidden`, so the panel was an unstyled static block at the end of `<body>`. Fix: add `#auth-modal` to the `#archive-modal, #import-pgn-modal` fixed/flex/inset group (+ `.hidden` variant). Guard: `test/t1-mobile-visuals-selftest.js` now asserts all five modal ids are centered fixed overlays and that `#auth-modal.hidden` sets `display:none`. | `index.html:432-443`, `test/t1-mobile-visuals-selftest.js` | display | S | **done (fix/auth-modal-centering)** |
| B15 | **Missed-tactics analysis was unbounded.** `routes-review.js` `evaluatePositions()` awaited `engineServer.analyse()` serially for every uncached position (`MAX_PLIES` capped plies only), so a cold 300-ply game (~150 searches × ≤200 ms) could block ONE request for ~30–60 s. Fix: cap **new** engine calls per request via `REVIEW_MAX_EVALS` (env `CHESS_REVIEW_MAX_EVALS`, default 60) and `REVIEW_BUDGET_MS` (env `CHESS_REVIEW_BUDGET_MS`, default 5000); cache hits/terminal evals are free and never counted against the gate; skipped positions are `null` and set `truncated` + `truncatedReason:'budget'|'max-plies'`. UI labels the truncated panel by reason. Guard: `test/missed-tactics-bounded-selftest.js` (8 tests, stub analyser, no server). | `src/routes-review.js`, `src/ui-analysis.js`, `test/missed-tactics-bounded-selftest.js` | server | S | **done (fix/missed-tactics-bounded)** |
| B16 | **The Playwright journeys never ran in CI.** `.github/workflows/ci.yml` only ran `npm run check` (linux node 20/22) and `npm run test:unit` (macos node 22); `npm run test:browser` (`scripts/smoke-test.mjs` + `scripts/test-ui-features.mjs`) could regress untouched. Fix: add a `browser` job (`ubuntu-latest`, node 22, `needs: [linux]`) that installs Chromium (`npx playwright install --with-deps chromium`) and runs `npm run test:browser` with all runtime state redirected to `${{ runner.temp }}` (`CHESS_*` env), plus `schedule` (nightly `17 4 * * *`) and `workflow_dispatch` triggers; an on-failure artifact-upload step is wired for `test-results/`/`playwright-report/`/`blob-report/` — a no-op today since the plain scripts enable no reporter (HANDOVER §16). | `.github/workflows/ci.yml`, `.gitignore`, `HANDOVER.md` §16 | infra | S | **done (ci/browser-gate)** |
| B17 | **The game-archive JSON fallback never ran on a sqlite-capable Node in CI.** `CHESS_ARCHIVE_FORCE_JSON=1` (`src/game-archive.js:1370`) is the only env-level switch that forces the JSON backend, but nothing set it: the `linux` node-20 leg exercised JSON only because `node:sqlite` is absent there, and the node-22 leg used sqlite — so the two backends could drift with no modern-Node guard. Fix: add an isolated `json-fallback` job (`ubuntu-latest`, node 22) that runs `npm run test:unit` with `CHESS_ARCHIVE_FORCE_JSON: 1`; the env var is asserted live by `test/p3-sqlite-selftest.js` (its `hasSqlite` helper returns false under the flag and then requires `backendType === 'json'`, so an ignored var fails the suite). Honest scope: the env var only forces the game archive — `accounts.js`/`social-store.js`/`study-store.js` take a per-constructor `forceJson` with no env hook, so their JSON adapters are still exercised only by the node-20 leg (HANDOVER §17). | `.github/workflows/ci.yml`, `HANDOVER.md` §17 | infra | S | **done (ci/json-fallback)** |
| B18 | **The new CI `browser` job flaked on Study chapter creation.** CI run 35501617040 (the first real `browser` run, B16) failed at `scripts/test-ui-features.mjs:546` — `POST /api/study` returned **201** but the created row disappeared from `#study-list`. Root cause was client-side: `ui-study.js` `mount()` **and** `show()` each call `loadChapters()`, so the first `#/study` navigation fired two concurrent **cookie-less** list GETs (the server mints a fresh `study_player` cookie per request, `routes-study.js:80`); the create handler's non-awaited, unguarded refresh could be clobbered by those slow stale empty responses resolving afterwards — `rows 1 → 0`. Fix: optimistic insert of the returned `res.chapter`, a monotonic `listSeq` guard that discards superseded responses, and a `listPromise` that de-dupes the double mount/show GET so first contact keeps one guest identity. The browser assertion now uses a bounded 5 s poll for the created title (not weakened) and bounded waits for the viewer and the quiz reply. Reproduced deterministically with a response-holding Playwright probe (old `rows=0`, fixed `rows=1`). | `src/ui-study.js`, `scripts/test-ui-features.mjs`, `HANDOVER.md` §18 | client | S | **done (fix/study-create-flake)** |
| B19 | **The `browser` job flaked on the seat badge.** CI run 35504521830 failed fast at `scripts/test-ui-features.mjs:145` — `Expected seat badge to show Playing White, got: Seated: Black`. Root cause is a fixed `waitForTimeout(500)` racing an async seat swap, **not** a seat-auth bug: switching bot colour fires `sendBotConfigUpdate()`, serialised on `botConfigChain`, which runs `POST /api/bot` → `await leaveSeat()` → `await claimSeat('white')`, and the badge (`updateSeatUI`, `src/ui.js:2472-2492`) still read the previous colour on a loaded runner. Fix: bounded `waitForFunction` polling `#seat-badge` for `White` (catch throws with the current badge text) and a bounded wait on `#command-status` settling to success/error after `#new-game`. Mutation-proven (never-appearing string → step fails with the real badge text). | `scripts/test-ui-features.mjs`, `HANDOVER.md` §19 | test | S | **done (fix/browser-seat-badge-flake)** |
| B20 | **The undo-request browser block flaked on a fixed sleep and the failure path leaked its server.** The G4 block `await`s `POST /api/reset` inside `page.evaluate` (the command IS applied), then slept a fixed `200 ms` before claiming seats and sending `e2e4`; the residual race is the **page** not yet having re-rendered the fresh position, so the room was still Black-to-move, `e2e4` was illegal, the server returned `400 … illegal move`, and the console-error gate failed the run. A second `waitForTimeout(300)` raced the page's state poll for the two moves. Separately, the top-level `testUiFeatures().catch` called `process.exit(1)` **before** `serverProc.kill()`, leaking a `node server.js` on `:39281` (next run logged `Server already running.` and cascaded). Fix: a **Node-side bounded poll** (5 s deadline, 50 ms sleeps) that `await`s `page.evaluate(() => fetch('/api/state…))` — a real Promise Node awaits — for `history.length===0 && turn==='white' && !gameOver`, throwing the last snapshot on deadline; deliberately NOT `page.waitForFunction(async …)`, which Playwright resolves on the first poll because a returned Promise is always truthy (that fail-open shape was this section's own round-1 bug). Plus a genuine synchronous `waitForFunction` for `window.getLivePly() === 2` (throw-on-timeout reports the real ply) and a shared idempotent `teardown()` (SIGTERM the server, close the browser, try/catch) run on both the success and failure paths before exit. No assertion weakened (2 plies before, 2 after decline, 1 after accept). Gate mutation-proven on a `/tmp` copy (`turn==='black'` now fails at the reset wait, exit 1; the same mutation exited 0 under the async version). | `scripts/test-ui-features.mjs`, `HANDOVER.md` §20 | test | S | **done (fix/undo-browser-flake)** |
| B21 | **The bot-config race left the human on the wrong seat under load — the §19 "fix" only masked it.** The `browser` job failed at `scripts/test-ui-features.mjs:150` (`Seat badge never showed Playing White (got: Seated: Black)`) with the badge stale for the whole 5 s wait, so it was **not** slowness. Reproduced with CDP `Emulation.setCPUThrottlingRate` rate 15 running the exact gesture (`level 4 → colour white → level 7 → colour black → toggle on`): the server ended with the bot on white and the human on black. Two compounding defects in `src/ui.js`. (1) `sendBotConfigUpdateNow()` read the live DOM (`colorSelect.value`/`levelSelect.value`/`toggle.checked`) at **execution** time, but it is queued on `botConfigChain`, so by the time an earlier queued call ran the DOM already held a newer selection; it POSTed the stale colour then claimed the wrong human seat via `humanColor = color === 'black' ? 'white' : 'black'`. (2) `updateBotUI(data)` wrote every `/api/bot` response back into the form fields, guarded only by `document.activeElement !== field`, so a slow older response clobbered the newer selection. This is a real product bug — a user changing bot colour/level quickly on a slow connection ends up on the wrong seat. Fix: `sendBotConfigUpdate()` snapshots the DOM **once, synchronously, at gesture time** and passes an immutable snapshot into the queued `sendBotConfigUpdateNow(snapshot)`, which never re-reads the DOM; `updateBotUI(botConfig, {applyControls=false})` no longer writes user-editable fields from a response by default (DOM is the source of truth for the controls; the `bot.status` badge and seat state stay server-authoritative), and `fetchBotConfig()` passes `applyControls: true` (guarded by `botControlsTouched`) so initial load still populates the controls. The `leaveSeat()` → `claimSeat(humanColor)` serialisation is unchanged. Evidence: throttled exact-gesture probe at rates 10/15/20/30, 3 runs each, all PASS after the fix; original failed 17/20. Isolation probes: a latency-injected fidelity probe proves the four `POST /api/bot` bodies now exactly match the four gestures (original sent black/black/black/black); a 600 ms route-delay guard probe proves a slow older response no longer clobbers the newer DOM selection. Because the two defects partially mask each other in the bare badge probe, each is proven load-bearing by its dedicated probe, not the badge probe alone. Gate-4 clean, no inline handlers. | `src/ui.js`, `HANDOVER.md` §21 | client | S | **done (fix/bot-config-race)** |
| B22 | **The History-Scrubbing browser block flaked on a fixed sleep racing the page's own state sync.** The step sends ten plies via **awaited** direct `fetch('/api/move')` calls (server applies them) but the page only learns of them through its SSE / `pollReferee` sync (`src/ui.js`); the old fixed `waitForTimeout(300)` could elapse first, so `jumpToPly(10)` clamped its target to `liveHistory.length`, fell back to the live board (white queen still on d1), and the ghost assertion (`ghostCheck.d1 !== null`) failed. Not a rendering or referee bug — the test was not synchronized with the page. Fix: bounded synchronous `page.waitForFunction(n => window.getLivePly() === n, testMoves.length, { timeout: 5000, polling: 50 })` (`getLivePly`, `src/ui.js:827`) whose `.catch` throws `Expected ${expectedPly} plies before history scrubbing, got ${ply}`. The predicate is synchronous because Playwright does not await an async predicate (a returned Promise is always truthy — the same fail-open shape B20 called out). No assertion weakened; unrelated fixed sleeps left untouched. Mutation-proven (wait target `999` → `Expected 999 plies before history scrubbing, got 10`, exit 1) and `npm run test:browser` green twice under the exact CI env block. | `scripts/test-ui-features.mjs`, `HANDOVER.md` §22 | test | S | **done (fix/scrub-live-ply-race)** |
| B23 | **The History-scrub browser block flaked on a stale browser-side premove, and the move-review block hid a real product bug: an uncancelled bot timer.** (1) After B22 the scrub block sent ten **token-less** `POST /api/move` calls after a fixed sleep; `/api/reset` does **not** release seats (only the GC collector `collectRoom()` calls `seatAuthManager.resetSeats`, `server.js:422`), so a seat claimed by an earlier gesture survived the reset and the moves 401'd (`validateMove`, `src/seat-auth.js:146`). The real cause was a **stale premove**: the earlier move-review `#e2`→`#e4` click left `e2e4` in `premoveQueue` (`src/ui.js:51`) because it was not White's turn; `renderBoard`'s flush (`src/ui.js:1361-1393`) fired `submitMoveToReferee('e2e4')` on the fresh post-reset state, and `submitMoveToReferee` **auto-claims the seat** (`src/ui.js:798-800`), so the page re-took White and landed a stray ply (observed `history:"e2e4"`, `turn:"black"`, `whiteOccupied:true`). Round-1 fix (test only): clear the premove through the UI's own `Escape`→`clearPremove` path (`src/ui.js:662-668`), leaveSeat + reset, bounded Node-side `/api/state` poll for `history.length===0 && turn==='white' && !gameOver`, claim BOTH seats out of band and send each half-move with its `X-Seat-Token`, throw on any `!ok`, release both before the G4 block; ghost assertions byte-identical. (2) An independent reviewer's **56-run CI-parity tally (~9% fail, 51/56)** then proved the *earlier* move-review block still flaked, and the cause was **product code**: `botService.setBotConfig({enabled:false})` (`src/bot-service.js:104-160`) deleted the room with **no `clearTimeout`**, while `triggerBotMoveIfNeeded` (`:268`) schedules a 200–450 ms `setTimeout` that re-reads the referee on wake — so the pending White move fired after the disable/reset and played a stray move onto a fresh board (a real user bug: disable the bot or hit New Game within ~450 ms of enabling it and the bot moves). **Round-2 fix (PRODUCT, `src/bot-service.js`):** store the handle as `config.timer`, `clearTimeout`+null it in `setBotConfig` on the disable and recolour paths, null it when the timer runs, and guard the wake *and* the post-search enqueue with a per-config `generation` token plus config-object identity so a slipped timer cannot mutate a newer generation (only that generation clears `thinking`). Move choice/levels/book/chat unchanged. New regression suite `test/bot-service-cancel-selftest.js` (5 tests; fails pre-fix, passes after; wired into `test:unit`+`lint`; About count 79→80). The browser drain was then simplified to disable→reset→bounded-fresh-poll→click→bounded `getLivePly()===1`. | Re-measured `npm run test:browser` under the exact CI env block on fresh `mktemp -d` dirs: **66 runs, 56 exit 0** (node 26 14/14, node 20.19.5 34/44, node 22 8/8); **move-review and history-scrub blocks failed in 0 of 66**, the scrub PASS line printed whenever reached, :39281 free after each. The 10 failures were all the **pre-existing** seat-badge section, which also failed on a HEAD worktree baseline (3/20, B19/B21 territory). Load-bearing: reverting only the product fix reproduced the original `HTTP 400 POST /api/move` during move-review once in 30 runs; the HEAD baseline failed directly in the scrub block 4/20 (`Expected 10 plies before history scrubbing, got 2`), which the post-fix test never does. `test/bot-service-cancel-selftest.js` fails pre-fix (1 passed, 4 failed, exit 1) and passes post-fix (5 passed, exit 0). Changed: `src/bot-service.js`, `scripts/test-ui-features.mjs`, `test/bot-service-cancel-selftest.js`, `package.json`, `src/ui-about.js`, `test/about-selftest.js`, docs. | `src/bot-service.js`, `scripts/test-ui-features.mjs`, `test/bot-service-cancel-selftest.js`, `package.json`, `src/ui-about.js`, `test/about-selftest.js`, `HANDOVER.md` §23 | product+test | S | **done (fix/scrub-move-seat-race)** |
| B24 | **The app version never showed beside the brand and lived in two hand-maintained literals.** The brand header (`index.html`) rendered only "Chess UI"; the version was hardcoded in `package.json` (`1.0.0`) and in the About skeleton (`src/ui-about.js`, `v1.0.0`), and the server never read `package.json` nor exposed a version endpoint, so any bump had to be made by hand in two places and could drift. Fix: bump `package.json` `1.0.0` → `1.1.0`; `server.js` reads the version once at boot (`require('./package.json').version`) and serves an unauthenticated `GET /api/version` → `{ok:true, version}` (the `/api/state` contract is untouched); the brand `<h1>` gains a subtle `<span id="app-version" class="brand-version">`, and `src/shell.js` (always loaded, self-initialising) fills it from `/api/version` using `textContent` only; the About page drops its hardcoded literal and renders `#about-version` from the same `#app-version` element (its selftest forbids `fetch()` in the module, so it reads the shared DOM source); `v—` is only the pre-fetch fallback, and shell.js also writes `#about-version` directly once `/api/version` resolves so a direct `#/about` deep link shows the real version. A 13th `test/about-selftest.js` case statically pins the single-source chain AND the `#about-version` fill. A 13th `test/about-selftest.js` case statically pins the single-source chain. | `curl -s /api/version` → `{"ok":true,"version":"1.1.0"}`; mutation: with `package.json` set to `9.9.9` the endpoint returned `9.9.9` (proving it reads the file), then restored to `1.1.0`. Gates: `reachability` 49 (KNOWN_DARK 10), `wave3-hygiene` 87, `t0-deadcode` 27/0, `about` 13, `npm run lint` 0. Changed: `package.json`, `server.js`, `index.html`, `src/shell.js`, `src/ui-about.js`, `test/about-selftest.js`, `HANDOVER.md` §24. | `package.json`, `server.js`, `index.html`, `src/shell.js`, `src/ui-about.js`, `test/about-selftest.js` | client+server | S | **done (feat/version-beside-brand)** |

---

## 3. PHASE 1 — Credibility (do first; everything compounds on this)

### E1 Ship a real engine `[display + server]` — **L, highest leverage in the codebase** — **in progress (Wave 1, branch `feat/wave1-real-engine`)**

Every AI feature — eval bar, CAPS accuracy, coach hints, mistake puzzles, ACPL, post-game report, bot
strength — reads the same PST number. Verified 2026 integration path:

**Phase E1a — client eval: `stockfish` npm v19.0.0, lite single-thread.** — **in progress (Wave 1, branch `feat/wave1-real-engine`)** — vendored at `vendor/stockfish/` (not `src/`), GPL-3.0 accepted (`Copying.txt` + README + README.md Licence section); Worker A wires `stockfish-worker.js`/`ui.js` + `ALLOWED_FILES`/`PRECACHE_ASSETS`.
- Files: `stockfish-19-lite-single.js` (21 KB) + `stockfish-19-lite-single.wasm` (**1.79 MB**, net compiled in — confirm no runtime `.nnue` fetch before precaching). Stockfish 19 released 2026-09-05 (SFNNv16 net). Sources: https://github.com/nmrugg/stockfish.js , https://stockfishchess.org/blog/2026/stockfish-19/
- Copy into `src/`, add to `ALLOWED_FILES` (replacing the two phantom entries), serve `.wasm` as `application/wasm`, add to `PRECACHE_ASSETS`.
- **No COOP/COEP needed** (single-thread). CSP: add `'wasm-unsafe-eval'` to `script-src` and then drop `'unsafe-eval'` (`server.js:454-471`).
- Load inside the existing Worker via `importScripts`; keep the PST engine as the `UnifiedEngine` fallback that already exists. Surface which engine is active in the UI ("Stockfish 19 · depth 18" vs "Local heuristic").
- License: GPLv3 (the npm package's copyright line reads "(c) 2026, Chess.com, LLC" — **verify** the exact terms before shipping). The project owner must confirm GPL distribution is acceptable. If not, use E1c only.
- Do NOT ship the 99 MB full-net build; do not precache any net > 2 MB.

**Phase E1b — server-side engine for `bot-service.js`, reports and the eval cache (X3).** — **in progress (Wave 1, branch `feat/wave1-real-engine`)** — Option A chosen: same vendored WASM under Node (`src/engine-server.js`, Worker B).
- Option A: same `stockfish` npm under Node in a `worker_thread`, one per active bot room, UCI over messages.
- Note on `@lichess-org/stockfish-web` (alternative small-WASM + separate `.nnue` route): npm says AGPL-3.0-or-later while GitHub metadata says GPL-3.0 — **unresolved; treat as AGPL** until clarified.
- Option B (strongest): native Stockfish 19 binary via `child_process.spawn` — on Render, vendor a Linux x86-64 binary or build in Docker; check `avx2/bmi2` on the dyno. Running server-side has no GPL distribution obligation.

**Phase E1c — lichess external-engine protocol** (`POST /api/external-engine`, provider long-polls `/work`,
client streams NDJSON from `/analyse`). License-avoidant: users point their own engine at your analysis
board; you ship nothing. https://github.com/lichess-org/external-engine — M.

**Phase E1d (optional) — multi-thread.** `stockfish-19-lite.wasm` (1.64 MB) needs
`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` and
`crossOriginIsolated === true`; COEP will block `tablebase.lichess.ovh` unless proxied through `server.js`.
Only after E1a is stable.

### E2 Honest bot ladder `[server]` — S (now), then re-calibrate after E1 — **relabel + dedupe done 8c42752 / 5533297**; real-engine ladder — **in progress (Wave 1, branch `feat/wave1-real-engine`)** (Worker B; `#bot-level-select` labels applied at merge)
- Relabel levels 1–8 to observed strength (≈ 600–1400 today). Remove the duplicate configs (5≡6, 7≡8).
- After E1b: implement levels via real engine with `UCI_LimitStrength` / `UCI_Elo` (Stockfish supports 1320–3190) plus depth/time caps; keep the human-delay simulation.
- Wire `personality-bots.js` — its `pickMove` is real (±40 cp bias on `.score`/`.activity`) but nothing produces those fields. Feed it MultiPV candidates from E1b.

### E3 Real opening data `[server + display]` — M — **done (Wave 2: data/openings.tsv CC0; fabricated stats deleted)**
- Ship the lichess `chess-openings` TSV (CC0, ~3,500 lines) via `openings-explorer.js:loadFromTSV`; load it in `index.html`; delete the fabricated `stats`/`frequency` fields from `openings-db.js` and the "illustrative" caveat.
- Personal stats from the archive (`personalExplorer`) — inject the real `game-archive.js` backend.
- Bot opening book: derive from the TSV + masters data, not fabricated percentages.
- Masters win-rates: either import a real sample (lichess masters DB API `explorer.lichess.ovh/masters`, proxied) or remove the numbers and the "real-data subset" comment from `masters-db.js`.

### E4 Real puzzle data `[server]` — M — **done (Wave 2: 8,861-row CC0 sample + full-dump importer, SQLite, lichess-shaped routes)**
- Actually import the lichess puzzle CSV (CC0, 6.1M rows; ship a themed 50–100k subset in-repo, full import as an admin script) into a real SQLite `puzzles` table in `game-archive.js`; add routes `/api/puzzle/daily|next|batch/:theme|dashboard/:days|activity` (lichess-shaped).
- Use lila's `puzzleTheme.xml` as the canonical theme taxonomy.

### G4 Undo as a request with opponent consent `[referee + server + display]` — S — **done (feat/g4-undo-request)**: in a room where both seats are non-bot humans, `POST /api/undo` records a pending request (`state.undoRequest`) instead of mutating the board; the opponent answers via `POST /api/undo/respond` (alias `/api/undo-respond`) with `{consent:true|false}`. "Both seats are humans" is keyed on the seats being **occupied for the whole game** (both exist, non-bot) and deliberately ignores idle-seat expiry, so a 5-minute idle timeout cannot silently make undo unilateral again. A finished game rejects every undo action (request / respond / legacy unilateral) with 409 `game over`, and every game-ending transition — draw-claim, draw-accept, resignation, timeout, a move — clears `state.undoRequest`. Solo / local / bot / unseated undo stays unilateral and byte-for-byte backward compatible. `g4-undo-request-selftest.js` (76 assertions) covers both paths, the game-over guard, and journal crash-recovery replay.

### G4b Draw-claim policy `[referee]` — S — **done (fix/g4b-claimable-draws)**: referee now uses `rulesEngine.automaticDraw` (fivefold / 75-move / insufficient); threefold + 50-move are claimable via `state.claimableDraw` + Claim button.
The referee auto-draws at threefold repetition and the 50-move rule (`referee-service.js` via `evaluateDraw`, asserted in `t0-draw-flagfall-selftest.js`). FIDE, lichess and Chess.com make those *claimable* and auto-draw only at fivefold / 75-move; `rules-engine.js` already distinguishes the two (`claimableDraw` vs `evaluateDraw`) and B3 now ships `state.claimableDraw` + a Claim button. Switching the referee to claimable-only is a one-line policy change plus a test update — but it changes game outcomes, so it is a product decision, not a bug fix.

### E5 Documentation truth pass `[docs]` — S — **CLAUDE.md done 8c42752**; RECOMMENDATIONS.md strike-through and B9 file removal still open
Update CLAUDE.md (DB path, fen-setup, puzzle-service storage), strike the false "Done" marks in
RECOMMENDATIONS.md with a pointer to this file, remove `game-log.md` / `brief.html`.

---

## 4. PHASE 2 — Reachability: a site shell that exposes what's already built

The UX audit found: one page, no nav, **56 controls in the DOM, 31 visible on load**, 8 above the fold on
a phone (all header toggles — the least important ones), and **Play White / Play vs Computer ~1,000 px below
the fold on mobile**. No onboarding, no empty state, no "what do I do now". Three engine arrows and two
self-disclaiming panels at the starting position. 30/31 visible controls are under 44 px.

### R1 Hash-routed shell `[display]` — M — **done (Wave 2 shell; Library view landed in Wave 3; Insights view added)**
A ~100-line `src/shell.js` toggling `<section data-view>` on `#/route`; no server change. Views:

| View | Contents | Modules it finally exposes |
|---|---|---|
| **Home** `#/` | Three big cards: *Play vs Computer* (level inline), *Play a Friend* (room link + QR), *Puzzles*. Daily puzzle tile. Lobby seeks below. | lobby |
| **Play** `#/play/:room` | Board, clocks, captured, move list, **chat (unhidden)**, Resign/Draw/Undo/Flip. Eval bar + MultiPV + Coach in an opt-in "Assist" drawer, off by default for rated human games. Draw-offer banner + claim button. | chat-upgrades, time-control, chess960, variants, correspondence |
| **Analysis** `#/analysis/:id` | Scrubber, eval graph, MultiPV, Game Review, "Why?", mistake puzzles, report, annotated PGN, tablebase panel in endgames, opening explorer. | acpl, masters-db, tablebase, openings-explorer, pov-export, embed-viewer, study-tree |
| **Puzzles** `#/puzzles` | Daily, Rated, Custom (theme + rating picker), Storm, Racer, Spaced-repetition review queue, theme dashboard. | puzzle-* (all 6), puzzle-racer, daily-puzzle |
| **Library** `#/library` | Archive as a page: search, import PGN, open in Analysis, import external history. | ui-archive |
| **Compete** `#/compete` | Arenas, Swiss, (later) leagues and teams. | arena |
| **Profile / Settings** `#/me` | Ratings pools, account, board theme, sound, voice, blind mode, language. Removes 6 header toggles from every screen. | accounts, ratings-pool, rating, social-graph, i18n, a11y-* , voice-intents |

Structural changes that make this cheap:
- Split the 850-line inline `<style>` into `assets/app.css`; collapse the two stacked CSS generations (`117-520` and `754+`), the five duplicate `prefers-reduced-motion` blocks, and the 720-vs-679/560 breakpoint conflict into one ladder (560/720/1024). Minimum 44 px touch targets.
- Split `ui.js` along view boundaries (`ui-play.js`, `ui-analysis.js`, `ui-transport.js`) and lazy-load per-view scripts with `document.createElement('script')` on first route entry — drops ~200 KB from first paint, no bundler.
- **Stop shipping server-only modules to the browser** (`game-archive.js`, `arena.js`, `social-graph.js`, `correspondence.js`) — these need routes, not script tags.

### R2 Server routes + tables for the dark server modules `[server]` — M each — **accounts/ratings/lobby/arena/social done (Wave 2); studies done (Wave 4); correspondence still open**
`accounts.js` → **done server-side in `0b25073`** (`/api/auth/*`, `/api/profile`, SQLite `accounts`/`sessions`); remaining: B11 + profile view; `ratings-pool.js` → rate every
human-vs-human result on game end (referee `onGameEnd` hook) + `/api/leaderboard/:tc`; `lobby.js` →
`/api/lobby/seek|challenge|accept` + SSE lobby channel; `arena.js` → `/api/arena/*`; `social-graph.js` →
`/api/social/*` + table; `correspondence.js` → referee day-clock mode; `study-tree.js` → **done (Wave 4, `a2-study-chapters`): `/api/study/*` + `#/study` view + `study-store.js`**.
Each is 1–3 days because the library and its tests already exist.

### R3 First-run onboarding `[display]` — S — **done (Home cards, Wave 2)**
Mode chooser on first visit; "You are a spectator — Play White / Play Black / vs Computer" banner when
unseated; empty-state copy that tells the user the next action; hide engine arrows at ply 0 by default.

### R4 Wire the accessibility modules already written `[display]` — S — **done (Wave 2, Worker A)**
`a11y-text-entry.js` (typed SAN/UCI + action words), `a11y-gestures.js` (swipe nav in blind mode),
`voice-intents.js` (resign/draw/hint by voice). Three green libraries, zero call sites.

### R5 Wire ACPL + masters whitelist into Game Review `[display]` — S — **done in the Analysis view (Wave 2, Worker D)**
`acpl.js` phase accuracy and `masters-db.js:whitelistMistakes` are exactly what the review panel needs
and neither is called.

---

## 5. PHASE 2b — Delivery & infrastructure `[server]`

Measured (**2026-09-20, M5 re-audit**, local server): **803 KB uncompressed first load** (index.html + 47
`<script>` files) → **217 KB gzip** / **204 KB brotli**; `src/`, `assets/` and `vendor/` carry
`public, max-age=0, must-revalidate` + a weak ETag and answer `304` to `If-None-Match`; `/api/*`, `index.html`,
the service worker and the manifest stay `no-store`. (The §2b figures below — "433 KB … nothing is
compressed … no ETag/304" — are the *original audit*, kept for history; D1+D2 landed and the 2026-09-20
re-measurement above supersedes them.)

- D1 gzip/brotli via `zlib` when `Accept-Encoding` allows — S. **Done 498e2d1** (`ui.js` 118 KB → 30 KB gzip / 26 KB br). *M5 re-measured 2026-09-20: identity 802.9 KB / gzip 216.6 KB / br 204.4 KB for the full first load; `ui.js` alone 146 KB → 36 KB gzip / 34 KB br.*
- D2 `Cache-Control: public, max-age=31536000, immutable` for `/src/*` and `/assets/*` with a content-hash query param stamped by a tiny `scripts/stamp-assets.js`; keep `no-store` for `/api/*` only; ETag from mtime+size — S. **Done 539c7cc** (chose `max-age=0, must-revalidate` + weak ETag + 304; no hashing). *M5 re-verified 2026-09-20: `If-None-Match` returns `304` with zero body; `Vary: Accept-Encoding` set on both 200 and 304.*
- D3 Precache `stockfish-worker.js` (and the engine WASM after E1a); reconcile `PRECACHE_ASSETS` with `ALLOWED_FILES`; PNG icons (192/512) for install prompts — S. **Worker + reconciliation done 45b6383**; PNG icons still open.
- D4 CSP hardening — **`'unsafe-eval'` gone (Wave 1), `'unsafe-inline'` gone from script-src (Wave 3); style-src still inline**: `'wasm-unsafe-eval'`, drop `'unsafe-eval'` and `'unsafe-inline'` (move the SW-registration inline script to a file; hash the stylesheet or externalise it). `frame-ancestors 'none'` contradicts `embed-viewer.js` — add a dedicated `/embed/:id` route with a permissive frame policy — S. — **in progress (Wave 1, branch `feat/wave1-real-engine`)**: `'wasm-unsafe-eval'` in, `'unsafe-eval'` out, `worker-src 'self' blob:` kept; the redundant `onsubmit` attribute on `#chat-form` removed. **Still open**: `'unsafe-inline'` in `script-src` (only the SW-registration inline block remains — hash it from `index.html` at startup or externalise it), `style-src 'unsafe-inline'` (inline `<style>` + `style=""` attributes), and the `/embed/:id` frame policy.
- D5 `connect-src` allowlist for `tablebase.lichess.ovh` (or proxy it) — S. — **in progress (Wave 1, branch `feat/wave1-real-engine`)**: `https://tablebase.lichess.ovh` added to `connect-src` (asserted in `security-headers-selftest`).
- D6 SSE-first transport (B6) and client `Last-Event-ID` resume — S. **Poll backoff done 5b38dfc**; `Last-Event-ID` resume still open.
- D7 `historyToSan` (`engine.js:727-736`) replays from the initial board with disambiguation on every state: 8.3 ms at 200 plies, ~0.9 s cumulative. Have the referee include SAN per ply in `stateView` so the client never recomputes it (also removes the Gate-4 workaround, B3) — S. **Done 10b3855** (`state.positions[].san`).

### M5 — Performance pass (branch `feat/m5-performance-pass`, 2026-09-20) — **evidence-backed audit**

An M5 card asked to "optimize `computeHistoryPositions` to O(n) memoized, audit cache-control headers, audit
frontend bottlenecks". Two of those three targets **no longer exist as work**:

- **`computeHistoryPositions` was deleted by B3 (10b3855)** — it is not in `src/`; the referee ships per-ply
  `state.positions[]` and the client renders from them. The `ui.js:783-801` line refs in **§1a** and the **B3**
  row are historical (they describe the pre-B3 file). `rg computeHistoryPositions` matches only stale
  `.claude/worktrees/` copies (never shipped).
- **D1 (gzip/br) and D2 (ETag/304)** are done (498e2d1, 539c7cc) and re-verified here, not re-implemented.

So M5 became a *measurement* pass. Findings, all reproduced against `CHESS_PORT=39281 node server.js` with
state under an `os.tmpdir()` mkdtemp:

| # | Finding | Evidence | Action |
|---|---|---|---|
| M5-1 | **Two full history replays per move.** `automaticDraw()` and `claimableDraw()` each call `createFromHistory()` for position counts, so the referee's post-move path replayed a long game **twice per ply** — 8.45 ms of 8.53 ms per move at 160 plies (draw detection), vs 0.08 ms for the snapshot write. | `src/rules-engine.js:318-346`; measured `node` harness | **fixed** — new `rulesEngine.drawStatus()` evaluates both verdicts from one replay; referee's `applyDrawStatus()` uses it in `applyMove`/`rebuildState`. ~2.0× on the per-move path, differential-clean over 9,301 positions. |
| M5-2 | Static delivery: compression + revalidation work. | `curl` (see below) | **no change** |
| M5-3 | Client per-ply rebuild (`positionsToHistorySnapshots` + `fenToDisplayBoard`) is 1.31 ms at 300 plies on every SSE/poll state; clock tick is a 1 Hz class toggle. | extracted pure fns, measured | **no change** — real but small, and it runs off the board-visible path. |
| M5-4 | `/api/state` `stateView()` allocates `renderAscii(board)` + `historyStr(history)` strings per request. | code read | **no change** — sub-0.1 ms; not on a per-frame path. |

Reproducible commands (full output in the M5 handover, §11): `curl -H 'Accept-Encoding: br' -D-` on
`/src/ui.js` returns `Content-Encoding: br` (146 KB → 34 KB); a repeat with `If-None-Match: W/"23acb-…"`
returns `304` with a zero-byte body. First load (index.html + 47 scripts): identity **802.9 KB** / gzip
**216.6 KB** / br **204.4 KB**.

New suite `test/m5-performance-selftest.js` (**15 tests**) pins `drawStatus()` ≡ `automaticDraw()`+`claimableDraw()`
on FEN edges, **4,650 random-game positions** (25 games × 2,325 plies × with/without history), the
replayed-vs-FEN split explicitly (FEN-clock fifty/seventyfive/insufficient paired with a *disagreeing*
short history, and repetition driven *by* the replay), the referee's fivefold/threefold/fifty-move behaviour,
and the end-to-end `/api/setup`-with-edited-clock path; wired into `test:unit` + `lint` (74 → 75 suites;
`ui-about.js` + `about-selftest.js` updated). A mutant routing the FEN-only checks through the replay is
killed by 5 of the 15 tests (mutation proof in HANDOVER §11).

---

## 6. PHASE 3 — Net-new features (2026 delta, not in RECOMMENDATIONS.md)

Each item: what it is — who ships it — why — layer — size — source. Ranked by (retention or credibility
impact) ÷ cost, and gated on Phases 1–2 where noted.

### Tier N1 — Opponent & coaching (needs E1)

1. **Maia rating-matched, human-like opponent** — predicts what a player of rating R would actually play; lichess mobile shipped an offline Maia opponent in 0.28 (Sept 2026); maiachess.com offers Maia 1100/1500/1900. Different mechanism from V1 personas (learned human move distribution vs hand-tuned bias). Path: server-side lc0 + Maia-1 `.pb.gz` weights with `go nodes 1` (GPL) behind `bot-service.js` levels; Maia-2 (MIT, rating-conditioned) or Maia-3 (AGPL, 600–2600) later. `[server]` **M** — https://github.com/CSSLab/maia-chess , https://github.com/lichess-org/mobile/releases
2. **Play-Coach-style adaptive sparring opponent** — bot + coach in one loop: adapts strength to you, warns of threats, asks guiding questions, allows hints/takebacks (Chess.com, June 2025). Combine E1b + `ai-coach.js` + Maia. `[server + display]` **M** — https://www.chess.com/news/view/announcing-play-coach
3. **done (Wave 3)** — **"Miss" classification + missed-tactic retry loop** — the other half of C7: puzzles from the *opponent's* blunders you failed to punish; "found vs missed forks/pins/mates" (Chess.com Insights, Game Review v2). `[display]` **S** — https://www.chess.com/news/view/chesscom-launches-game-review-v2
4. **Engine-grounded LLM coach ("ask about this position")** — conversational explanations grounded on engine PVs, tablebase and explorer output (never free-form, to avoid hallucinated tactics). Extends C2/C4 from templates to dialogue. `[server]` **M** — benchmark: DecodeChess https://decodechess.com/natural-language-chess-analysis/
5. **Piece-manoeuvre arrows for top lines + tactical-motif visuals** in analysis (lichess 2026 site update). `[display]` **S** — https://lichess.org/@/Lichess/blog/more-than-a-half-year-update-2026/Bu77Rba1
6. **"Bot or Not" Turing-test mode & Hand-and-Brain with AI** (maiachess.com) — novel casual modes, cheap once Maia exists. `[server + display]` **S/M** — https://www.maiachess.com/

### Tier N2 — Retention loops (evidence-backed; avoid dark patterns)

7. **done (Wave 3)** — **Activity streak with slack** — counts any game/puzzle/lesson/review; pauses after 1 idle day, resets after 3 (Chess.com). Duolingo's own blog reports 7-day-streak learners ~3.6× more likely to complete a course and that slack beats rigid rules (company-reported, not independently verified). `[server]` **S** — https://blog.duolingo.com/how-duolingo-streak-builds-habit/ , https://support.chess.com/en/articles/9714718-what-are-streaks
8. **done (Wave 3)** — **Weekly Leagues** — auto-enrol after first game each week, divisions of 50, promotion-only (no relegation), reset Sunday. `[server]` **M** — https://www.chess.com/leagues
9. **done (Wave 3)** — **Achievements tied to skill events** (first brilliant move, first tablebase-perfect endgame, 7-day puzzle habit) — not volume grinding. `[server]` **S** — https://www.chess.com/article/view/chesscom-features
10. **Teams + Team Battles** — team entity (join/leaders/kick), team-scoped arenas/Swiss, battles where top-N per team score and teammates are never paired. Strongest non-dark retention lever on both platforms; `social-graph.js` has no team entity. `[server]` **L** — https://lichess.org/page/team-battle-faq
11. **Daily content cadence** — themed monthly bots (Chess.com ships new bot collections monthly), Game of the Month. Content, not code. **S**
12. **Streamer program + Discord challenge bot** — auto-detect live streams whose title contains the site name; Discord bot posting challenge links and result embeds. `[server]` **S/M** — https://lichess.org/streamer

**Explicitly avoid** (Zagal et al. 2013; FTC 2022): hard-reset streaks, XP-for-volume grinding, fake
countdown timers, randomised/loot-box cosmetics, paid streak revives. Cosmetics only with direct,
transparent pricing.

### Tier N3 — Training depth (Chessable / Aimchess / lichess parity)

13. **Opening repertoire trainer** — upload PGN / pick a study as repertoire; app plays the opponent side; each *move* is an SRS card; post-game "you deviated from your repertoire at move 9". The #1 Chessable/Listudy/ChessTempo loop; A2.1 tree + P4 SRS are the substrate. `[server + display]` **M** — https://listudy.org/en , https://support.chessable.com/en/articles/9043598-how-does-the-spaced-repetition-scheduling-work
14. **MoveTrainer-grade SRS schedule** — adopt Chessable's 4 h → 1 d → 3 d → 1 w → 2 w → 1 m → 3 m → 6 m ladder with per-move cards and error-resets-to-level-1 (P4 currently 1→2→4→…→365 d with no 4 h step). `[server]` **S**
15. **done (Wave 3; moveTime/ratingGain await schema)** — **Insights dashboard** — metric × dimension × filter (ACPL, move time, result, rating gain, opportunism, luck × phase, colour, opening, opponent strength, piece, castling side, material imbalance). `acpl.js` has the metrics; there is no pivot surface. `[display]` **M** — https://lichess.org/@/lichess/blog/chess-insights/VmZbaigA
16. **Weakness scores + daily plan** (Aimchess model): blunder rate, conversion of winning positions, resourcefulness in lost positions, time management, opening performance → generated daily plan. `[server]` **M** — https://aimchess.com/
17. **done (Wave 3)** — **Import external game history** by lichess / Chess.com username (public APIs) so Insights and weakness tools are useful on day one. `[server]` **S**
18. **Puzzle dashboard by theme** (strengths / improvement areas over N days) + **Custom Puzzles** picker (theme + rating band) + **Rated vs unrated**. `[display]` **S/M** — lichess `/api/puzzle/dashboard/{days}`
19. **Practice curriculum** — Checkmates (piece checkmates, patterns I–IV) → Fundamental tactics (pin, skewer, fork, discovered, overload, zwischenzug, x-ray) → Advanced (zugzwang, deflection, attraction, Greek gift…) → Pawn & Rook endgames. The onboarding ladder that converts beginners. `[display]` **M** (content) — https://lichess.org/practice
20. **Endgames trainer** — themed drills from real 3–7-piece positions, practice vs timed challenge with leaderboard, graded by `tablebase.js` ground truth. `[server + display]` **M** — https://www.chess.com/endgames
21. **Interactive-lesson study mode** — author writes per-move prompts/hints/feedback; wrong moves branch to feedback (lichess). Extends A2.2 (the A2.2 chapter/quiz layer ships in Wave 4; this per-move prompt authoring is still open). `[display]` **M**
22. **Guess-the-Move** on master games (ChessTempo / lichess "hide next moves") — reuses puzzle input loop + masters data. `[display]` **S**
23. **Vision / speed drills** ("play the named move" under time) — extends G5. `[display]` **S**

### Tier N4 — Platform & ecosystem

24. **Lichess-shaped Board API + Bot API contracts** (`/api/board/*`, `/api/bot/*`) — third-party clients, BotLi-style engine bots populate an empty lobby, e-board bridges (Chessconnect: Chessnut/DGT/Certabo) target your server with a base-URL change. `[server]` **M** — https://raw.githubusercontent.com/lichess-org/api/master/doc/specs/lichess-api.yaml
25. **Broadcast / PGN relay** — tournament → rounds, polled PGN URL or push API, embeds. Lets clubs/streamers follow OTB events on your app. `[server + display]` **L** — https://lichess.org/broadcast/help
26. **Simuls** — one host vs N boards; mostly orchestration over existing multi-room + seats. `[server]` **M**
27. **Bulk pairings** — organiser creates many games at once (club nights). `[server]` **S**
28. **Teacher-managed accounts (Lichess Class)** — schools/coaches distribution channel. `[server]` **M** — https://lichess.org/page/class
29. **Bughouse / Duck / Fog-of-War variants** — what Chess.com has that V4 lacks; Bughouse = two linked rooms + piece transfer (fits the referee model). `[referee]` **M–L**
30. **Material-odds games** (G3 has time odds only). `[referee]` **S**
31. **OTB e-board bridge** via Web Bluetooth in-page, on top of the Board API. `[display]` **L**
32. **Board-from-photo OCR** → FEN setup (Chessvision-style). `[server]` **M**
33. **Broadcast/follow notifications** (push when a followed player or event goes live). `[server]` **S**
34. **AI-assisted chat moderation** (both platforms, 2026) — only once there is a user base. `[server]` **M**

---

## 7. Sequencing

**Wave 0 — Bugs & truth (1 week).** B11 and B12 first (both are one-liners and one is a secret-leak risk), then B1–B10, E2 (honest labels), E5 (docs), D1–D3.

**Wave 1 — Real engine (2–3 weeks).** E1a client Stockfish 19 lite → recalibrate CAPS/coach/report
thresholds → E1b server engine for bots → E2 real bot ladder. Add D4/D5 headers. This is the single change
that makes every existing AI feature credible.

**Wave 2 — Shell + reachability (3–4 weeks).** R1 shell, R3 onboarding, R2 routes for accounts / ratings /
lobby / arena, R4/R5 wiring, E3/E4 real opening + puzzle data. At the end of this wave ~25 already-tested
modules become user-visible features — the largest visible product jump available.

**Wave 3 — Retention (2 weeks).** Streaks, achievements, leagues, daily cadence, Insights dashboard,
puzzle dashboard + custom picker, external-history import.

**Wave 4 — Training depth (3–4 weeks).** Repertoire trainer + MoveTrainer SRS, Maia opponents, Play-Coach
sparring, Miss/missed-tactic loop, practice curriculum, endgames trainer.

**Wave 5 — Ecosystem (ongoing).** Teams/battles, Board+Bot API, broadcasts, simuls, streamer/Discord,
variants, e-board, OCR.

**Definition of Done, revised.** A feature is Done only when all four hold: (1) module + selftest green,
(2) reachable — script loaded *and* called *or* route mounted, with a visible affordance, (3) real data
behind it (no fabricated statistics; caveat labels are not a substitute), (4) an entry in
`scripts/test-ui-features.mjs` exercises it in the browser. **Shipped 8400e06 (25 assertions, `KNOWN_DARK`=30, wired into `test:unit`+`lint`).** Add a `reachability-selftest.js` that fails
when a module in `index.html` has zero call sites or a `src/` module is neither loaded nor required — and wire it
into both `test:unit` and `lint` in `package.json`, otherwise it joins the orphaned `gate3/4/5-selftest.js` suites.

---

## 8. Explicitly not recommended (unchanged from RECOMMENDATIONS.md, plus)

- WebSockets/WebRTC for move sync; self-hosted 8-piece tablebases (lichess's API now serves partial
  8-piece — just consume it); ML anti-cheat before a rated pool exists; native mobile apps; a bundler.
- Shipping the 99 MB full-net Stockfish build or precaching any net > 2 MB.
- Enabling COEP before proxying tablebase.
- Seasons/battle-pass, referral loops, quest grinds — no evidence on either chess platform; conflict with
  the dark-pattern guidance above.
- Any new "Done" mark without the four-part definition in §7.
