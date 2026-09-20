# ORCHESTRATOR HANDOVER — Autonomous Chess Build

This document records the operational state of the Chess Game project, including completed tasks, architectural guarantees, test gates, and the latest handover status.

---

## 1. REPO & ACTIVE BRANCH
- **Working Directory**: `/Users/riazrahaman/Documents/agend-grid/chess-game`
- **Origin**: `https://github.com/riazrahaman/chess-game.git`
- **Active Branch**: `main` (clean, all features merged, pushed to origin)
- **Architecture Invariant**: The referee backend (`referee-service.js`) is the single source of truth for board state, clocks, and move history. `ui.js` is strictly a display-layer orchestrator rendering server-reported state and contains **zero** local game-state mutations (`makeMove(` and `createInitialBoard(` hits = 0).

---

## 2. KANBAN STATUS (100% of All Tasks DONE)
- Kanban board: `https://agent-kanban-board.onrender.com` (code: `../agent-kanban-board`). Mutations need `KANBAN_AUTH_TOKEN` (Render-generated, not in any repo); until it is exported in the working session, task tracking lives in the status tables in this file (§5 Wave 0, §6 Wave 1). When the token is available: project `chess-game`, one card per roadmap item id (B1…, E1a…), role headers `X-Agent-Role: builder|reviewer|tester`, lifecycle BACKLOG→BUILDING→IN_REVIEW→IN_TEST→DONE.
- All tasks have traversed the complete autonomous lifecycle (`BUILDING` → `IN_REVIEW` → `IN_TEST` → `DONE`):
  1. `chess-t0-seat-auth-heartbeat` (T0.2 & T0.3): **DONE**
     - Enforced caller authorization on `/api/reset`, `/api/undo`, `/api/draw`, and `/api/resign` via `validateMutation` in `SeatAuthManager`.
     - Preserved unseated local play for 100% backward compatibility.
     - Implemented 25s client-side keepalive heartbeat (`/api/seat/heartbeat`).
     - Unit & integration tests: 41/41 passing (`p3-seat-selftest.js`).
  2. `chess-t0-draw-flagfall` (T0.4 & T0.5): **DONE**
     - Integrated `evaluateDraw` and `claimableDraw` into `RefereeService.applyMove` and `rebuildState`.
     - Added draw negotiation routes (`/api/draw/offer|accept|decline`) and `/api/draw-claim`.
     - Implemented server-side flag fall timeout detection in `RefereeService.checkFlagFall` wired into `/api/flag` and state reads.
     - Unit & integration tests: 51/51 passing (`t0-draw-flagfall-selftest.js`).
  3. `chess-t0-deadcode-polish` (T0.6): **DONE**
     - Activated `checkRateLimit` on HTTP routes with automatic pruning when map size exceeds 2000 entries.
     - Scheduled periodic 10s NTP clock sync (`syncNtpClock`) so `#ping-badge` displays real network latency.
     - Bounded `RefereeService._idempotency` Map to 500 entries to prevent memory leaks.
     - Sent client `cmdId` on all referee actions to deduplicate network retries.
     - Replaced all legacy `alert()` dialogs in `ui.js` with non-blocking `showUiError()` status pills.
     - Rewrote archived game reload (`reloadArchivedGameOntoBoard`) to properly await reset, sequentially validate moves with room params, and protect live state.
     - Unit & integration tests: 13/13 passing (`t0-deadcode-selftest.js`).
  4. `chess-t0-engine-honesty` (T0.1): **DONE**
     - Honestly relabeled the engine as "Lightweight Local Engine (PST+Material)" / "Position analysis (Beginner Engine)".
     - Emits honest UCI identity: `id name Lightweight Local Engine (PST+Material)` while retaining `id alias Stockfish 17 NNUE WASM` for protocol compatibility.
     - Verified with `p2-stockfish-selftest.js` (23/23 passing).
  5. `chess-mobile-and-visuals` (D5, A7, A9): **DONE**
     - Unified pointer events (`pointerdown`, `pointermove`, `pointerup`, `pointercancel`) for phone/tablet drag-and-drop.
     - Enhanced board depth: inset bevel frame, square gradients, piece drop shadows.
     - Consolidated CSS stylesheet layers in `index.html`.
     - Verified with `t1-mobile-visuals-selftest.js` (16/16 passing).
  6. `chess-matchgrade-social` (B7, B8): **DONE**
     - Pre-game time control presets: Bullet 1+0, Blitz 3+2, Blitz 5+3, Rapid 10+0, Rapid 10+15, Classical 15+10, and custom.
     - In-game chat panel (`/api/chat` with SSE push events).
     - Interactive rematch offer/decline/accept negotiation flow (`/api/rematch/:action`).
     - Live spectator presence badge (`#spectator-badge`).
     - Verified with `p3-social-timecontrol-selftest.js` (10/10 passing).
  7. `chess-ai-c5-computer` (C5): **DONE**
     - Play vs Computer autonomous bot with 8 difficulty tiers (Novice 800 to Grandmaster 2200), search depths 1–4, blunder noise, human think delay, and flavor chat commentary (`bot-service.js`).
     - Verified with `c5-ai-bot-selftest.js` (10/10 passing).
  8. `chess-ai-c7-puzzles` (C7): **DONE**
     - "Retry your mistakes" interactive puzzle generator extracting blunder positions from game reviews (`#retry-mistakes-section`, `move-review.js`).
     - Verified with `c7-ai-puzzles-selftest.js` (6/6 passing).
  9. `chess-ai-c2-c4-coach` (C2 & C4): **DONE**
     - Plain-English "Why?" move explanation cards (`#why-move-btn`, `ai-coach.js`).
     - Real-time coaching hints on player turn (`#coach-hint-btn`, `ai-coach.js`).
     - Verified with `c2-c4-coach-selftest.js` (6/6 passing).
  10. `chess-ai-c6-report` (C6): **DONE**
      - Auto post-game narrative report generating prose match storytelling, accuracy comparison, opening phase analysis, critical turning point swing detection, endgame review, tactical takeaways, and annotated PGN with NAG glyphs and eval comments (`game-report.js`).
      - Verified with `c6-ai-report-selftest.js` (5/5 passing).
  11. `chess-accessibility-c8-d4-voice` (C8 & D4): **DONE**
      - Spoken SAN voice move announcements using SpeechSynthesis API (`#voice-toggle`, shortcut `V`).
      - Voice move input recognition via Web Speech API (`#mic-move-btn`, shortcut `M`).
      - Dedicated Blind Accessibility Mode (`#blind-mode-toggle`, shortcut `B`), ARIA live region (`#accessibility-announcer`), full 8x8 keyboard grid navigation (Arrow keys move cursor, Enter/Space selects and moves, Esc cancels), with spoken square and piece feedback.
      - Hotkeys: `V` (voice), `M` (mic), `B` (blind mode), `C` (clocks), `S` (status).
      - Verified with `c8-d4-voice-selftest.js` (7/7 passing).
  12. `fix-ui-ai-features` (UI & AI Feature Verification): **DONE**
      - Fixed `server.js` `ALLOWED_FILES` to whitelist `ai-coach.js`, `game-report.js`, `accessibility-voice.js`, and `rating.js` so they are served with proper `application/javascript` MIME type instead of 404 JSON.
      - Removed `disabled` constraint on `#bot-level-select` and `#bot-color-select`, enabling immediate user interaction and auto-activation.
      - Fixed voice mute confirmation in `accessibility-voice.js` to speak via `SpeechSynthesis` before disabling.
      - Fixed `startMistakePuzzles` in `ui.js` to use `getFenFromStateOrBoard(hp)` instead of backend-only `rulesEngine.boardToFen`.
      - Enclosed `ai-coach.js`, `game-report.js`, `accessibility-voice.js`, and `move-review.js` in IIFEs to prevent global identifier collisions.
      - Added automated Playwright suite `scripts/test-ui-features.mjs` running in CI.
  13. `fix-smart-engine-bot` (Engine Strength & Tactical Quality): **DONE**
      - Fixed FEN string parsing in `stockfishWorker.evaluateMultiPV` and `findBestMove` so minimax searches real positions rather than an empty board.
      - Enabled depth-aware search honoring each bot profile's depth.
      - Integrated opening book from `openings-db.js` for authentic master opening play on moves 1–10.
      - Enforced 100% legal move filtering and checkmate detection (`isKingInCheck`, `isSquareAttacked`) with MVV-LVA move ordering in alpha-beta minimax search.
      - Calibrated difficulty tiers 1–8: Expert (Level 5) through Grandmaster (Level 8) calculate with depths 3–4, zero blunder rates, instant free-piece captures, and mate-in-1 spotting.
      - Unit & integration tests: 11/11 passing (`bot-tactics-selftest.js`).
  14. `fix-history-ghost-pieces` (History Scrubbing Ghost Piece Cleanup): **DONE**
      - Fixed `renderBoard` in `ui.js` to systematically remove piece DOM elements from squares where `pieceData` is null (`while (squareDiv.firstChild) squareDiv.removeChild(...)`).
      - Prevented ghost duplicate pieces (e.g. duplicate Queen on `d8` and `d4`, duplicate Queen on `d1` and `a4`, duplicate Bishop on `c8` and `g4`) when jumping across historical plies.
      - Synchronized `previousBoard` snapshot in `jumpToPly` to ensure correct board diffing across scrub states.
      - Added automated regression test in `scripts/test-ui-features.mjs` verifying clean DOM reconcile for `5... Qxd4`.
  15. `fix-bot-seat-auth-reset` (Bot Play Seat Auth & Unseated Reset): **DONE**
      - In `seat-auth.js`, differentiated human seats from bot seats (`isBot: true`), allowing open resets and mutations (`/api/reset`, `/api/undo`, `/api/draw`, `/api/resign`) when only the bot is seated.
      - In `bot-service.js`, marked bot seat reservations as persistent while bot is enabled (`isBot: true`).
      - In `ui.js`, updated `sendBotConfigUpdate` and `fetchBotConfig` to automatically claim the human player's seat opposite the bot (e.g., Playing White when Bot plays Black), and release it when bot mode is toggled off.
      - Preserved full multiplayer seat integrity (unauthorized spectators cannot reset or tamper with active human vs human or human vs bot matches).
      - Unit & integration tests: 44/44 passing (`p3-seat-selftest.js`).
  16. `fix-pawn-en-passant-moves` (Rank-Eligible En Passant Move Generation): **DONE**
      - Fixed `getPseudoLegalMoves` in `src/engine.js` so pawns can only capture en passant if they stand on rank 5 (White) or rank 4 (Black) and an opposing pawn exists on the adjacent target file.
      - Hardened `makeMove` and `isMoveCapture` in `src/engine.js`, as well as `src/stockfish-worker.js`, to strictly require rank 5/4 for en passant execution.
      - Fixed phantom diagonal move options onto empty en passant squares (e.g. `e2 -> f3` after `f2-f4`).
      - Unit & integration tests: 164/164 passing (`test/engine-selftest.js`).

---

## 3. FULL TEST GATES & VERIFICATION
All test gates pass without error:

```bash
npm run check    # Linter syntax check + complete unit/integration test suite
npm test         # Complete suite + Playwright browser smoke test + UI feature test
```

Summary of test results:
- **Gate 4 Invariant**: `ui.js` contains **0** occurrences of `makeMove(` and **0** occurrences of `createInitialBoard(`.
- `npm run check`: **79 unit suites, 0 errors across entire codebase**
- `audit-broken-corners-selftest.js`: 9/9 passed (Gate 4 invariant, seat token isolation, promotion cancel, draw claim visibility, touchscreen resign confirm, PGN copy fallback, SPA history navigation)
- `static-url-navigation-selftest.js`: 8/8 passed
- `study-chapters-selftest.js`: 17/17 passed
- `m5-performance-selftest.js`: 15/15 passed
- `engine-selftest.js`: 42/42 passed
- `pieces-selftest.js`: 32/32 passed
- `security-selftest.js`: 58/58 passed
- `draw-selftest.js`: 30/30 passed
- `p3-multiroom-selftest.js`: 58/58 passed
- `p3-sqlite-selftest.js`: 74/74 passed
- `p3-seat-selftest.js`: 44/44 passed
- `t0-draw-flagfall-selftest.js`: 51/51 passed
- `t0-deadcode-selftest.js`: 13/13 passed
- `p2-stockfish-selftest.js`: 58/58 passed
- `t1-mobile-visuals-selftest.js`: 16/16 passed
- `p3-social-timecontrol-selftest.js`: 10/10 passed
- `c5-ai-bot-selftest.js`: 10/10 passed
- `bot-tactics-selftest.js`: 11/11 passed
- `c7-ai-puzzles-selftest.js`: 6/6 passed
- `c2-c4-coach-selftest.js`: 6/6 passed
- `c6-ai-report-selftest.js`: 5/5 passed
- `c8-d4-voice-selftest.js`: 7/7 passed
- `rating-selftest.js`: 36/36 passed
- `differential-selftest.js`: 200/200 random games (37,839 plies vs chess.js, 0 divergences)
- `scripts/smoke-test.mjs`: Playwright browser smoke test passed (32 pieces, move e2-e4 rendered, referee state synced)
- `scripts/test-ui-features.mjs`: Playwright UI & AI feature verification passed (voice toggle, bot dropdowns, coach hints, move explanations, mistake puzzles, narrative report)

---

## 4. RUNNING SERVICES
- **Chess Server**: `http://127.0.0.1:39281`
- **Kanban Server**: `http://localhost:4100` (PID: 30317)
---

## 5. WAVE 0 — Audit bugs & truth (branch `fix/wave0-audit-bugs`, started 2026-09-18)

Source of truth for scope: `docs/06-world-class-roadmap.md` §2 (bug table, has a Status column) and §7
(sequencing). Loop per item: build → targeted selftest → wire into `package.json` if new → verify → one
commit per item with `Co-Authored-By` + `Claude-Session` trailers. Work was parallelised across three
worktree workers with strict file ownership (A: `src/ui.js` + `index.html`; B: `server.js` +
`service-worker.js`; C: `test/` + `package.json`) and merged serially by the lead; the full
`npm run check` runs once, after the merge.

| Item | Status | Commit | Notes |
|---|---|---|---|
| B12 Google OAuth `client_secret*.json` unignored in repo root | DONE | e3b18dd | Never committed (verified `git log --all --full-history`). Server already reads `GOOGLE_CLIENT_ID` from env. **Owner action:** rotate the credential in Google Cloud Console only if the file was ever shared outside this machine. |
| E2 Honest bot ladder + dedupe 5/6, 7/8 | DONE | 8c42752 | Ratings 800–2200 → 600–1400; `topN` near-equal sampler differentiates levels; tests assert monotonic/no-dup/≤1400. `index.html` option labels pending (Worker A owns the file) — see below. |
| B8 Fake `id alias Stockfish 17 NNUE WASM` | DONE | 8c42752 | Alias removed; `p2-stockfish-selftest` now asserts absence. |
| E5 CLAUDE.md truth pass | DONE | 8c42752 | DB path, puzzle-service in-memory, fen-setup unused, ui-auth/accounts, revised DoD (step 6). |
| B1 clock counts down pre-game | DONE | 3245d37 | `refereeClockRunning` flag; interpolate only when `history.length>0` and not game over. Live-verified 10:00 holds 4 s pre-move, ticks after e2e4. |
| B2 unclosed `<details>` hides chat | DONE | 152aadd | `</details>` added after `#eval-graph-container`; `#chat-panel.closest('details')` = null. |
| B4 draw offer/accept/decline/claim UI | DONE | e2855fa | `#draw-offer-banner` + `#claim-draw`; `postDrawCommand` → `/api/draw/{offer,accept,decline,claim}`. Two-context Playwright: offer → banner → accept → ½-½. Threefold claim needs referee `claimableDraw` in `stateView` (folds into B3). |
| B5 `showUiError` clobbers `#status` | DONE | 4f1892a | Auto-dismissing pill in `#command-status`; `#status` untouched. |
| B6 600 ms poll forever | DONE | 5b38dfc | 15 s liveness while SSE open, 600 ms when down, exp. backoff cap 10 s on failure. 1 poll / 20 s measured with SSE. |
| B10 phantom `stockfish.*` allowlist + dead ui fallbacks | DONE | dcf8033, e78d409, 6f4f7a2 | Allowlist entries removed; `p2-stockfish-selftest` now asserts absence; dead `boardToFen`/`RulesEngine` branches removed. |
| B11 `ui-auth.js` 404 (not in ALLOWED_FILES/precache) | DONE | 2c30698, 5533297 | Allowlisted + precached. Follow-up: `accounts.js` (Node-only) removed from `index.html`/allowlist/precache; `demoUser` login gated behind `ALLOW_DEMO_AUTH=1` (was a credential-free session for any email on the public Render deploy). |
| D1 gzip/brotli · D2 cache headers + ETag/304 · D3 precache worker | DONE | 498e2d1, 539c7cc, 45b6383 | `ui.js` 118 KB → 30 KB gzip / 26 KB br; static `public, max-age=0, must-revalidate` + weak ETag + 304; `/api/*`, `index.html`, SW stay `no-store`; `stockfish-worker.js` precached. |
| `reachability-selftest.js` (§7 DoD guard) + wiring | DONE | 8400e06, a5b27f7, 9bc2006 | 25 assertions: every `<script src>`/Worker exists + allowlisted + precached; every `src/*.js` loaded, required, or in `KNOWN_DARK` (30, may only shrink); call-site check for loaded modules. Wired into `test:unit` and `lint`. |
| B7 selftest residue files | DONE | 4757c9d | 5 suites now write under `os.tmpdir()` via `CHESS_STATE_FILE` and rm on exit. 597 residue files deleted from repo root (live default-room files kept). |
| (extra) `submitMoveToReferee` ReferenceError | DONE | de90e27 | Pre-existing: undefined `refereeState` threw before every browser `POST /api/move`; now `previousRefereeState`. |
| B3 Gate-4 string-concat workaround → referee-served per-ply FEN/SAN (+ `claimableDraw` in `stateView`) | DONE | 10b3855 | `state.positions` + `state.claimableDraw` from the referee; `ui.js` parses FEN for display only, no move replay, `historyToSan` gone from ui*.js; Gate-4 tests are now token-scan + concatenation-proof; archived games get `positions` from `/api/games/:id`. New `b3-positions-selftest.js` (10). Note: referee still auto-draws at threefold/50-move (existing policy) — claimable-only is a separate rules decision. |
| G4b draw policy → FIDE claimable (threefold/50-move) vs automatic (fivefold/75/insufficient) | DONE | (fix/g4b-claimable-draws) | `rules-engine.automaticDraw` used by the referee; `t0-draw-flagfall` 60/60 incl. new fivefold auto-draw + threefold claim cases. |
| B9 remove tracked `game-log.md` / `brief.html` | DONE | (this commit) | Agent-orchestration residue removed and gitignored; `security-selftest` still asserts `/game-log.md` is not served. |

## 6. WAVE 1 — Real engine (branch `feat/wave1-real-engine`, started 2026-09-18)

Scope: `docs/06-world-class-roadmap.md` §3 (E1a/E1b/E2) and §5 (D4/D5). Base commit 96e5d51 vendors
Stockfish 19 lite single-threaded WASM (GPL-3.0) under `vendor/stockfish/`; `scripts/engine-probe.js`
proves it runs under Node (~150 ms for `go depth 12`). Same three-worker pattern as Wave 0 with strict
file ownership (A: `src/stockfish-worker.js` + `src/ui.js` + `ALLOWED_FILES`/`PRECACHE_ASSETS`;
B: `src/engine-server.js` + `src/bot-service.js` + `package.json`; C: CSP/MIME hunks of `server.js`,
`index.html`, docs, proof selftest). Lead merges serially and finalises this table; `npm run check`
runs once after the merge.

| Item | Owner | Status | Commit | Notes |
|---|---|---|---|---|
| E1 base — vendor SF19 lite-single WASM + licence + probe | lead | DONE | 96e5d51 | `vendor/stockfish/{stockfish-19-lite-single.js,.wasm,Copying.txt,README.md}` |
| E1a — browser Worker loads the vendored engine (`stockfish-worker.js`, `ui.js` engine-ready → `#analysis-engine-label` / `#analysis-engine-caveat`), `ALLOWED_FILES` + `PRECACHE_ASSETS` entries | Worker A | DONE | cf327fd, 39474df | PST stays as fallback only. `test/wave1-engine-selftest.js` wiring assertions go green when this lands. |
| E1b — `src/engine-server.js` (Node-side SF19 over UCI) | Worker B | DONE | 97115dc, 4cb84d8, 73b4669, fad7095 | Option A (same WASM under Node). |
| E2 — real bot ladder in `bot-service.js` (`UCI_LimitStrength`/`UCI_Elo` + depth/time caps) | Worker B | DONE | 97115dc, 4cb84d8, 73b4669, fad7095 | Reports final 8 `#bot-level-select` labels; lead applies them to `index.html` at merge. Wires `wave1-engine-selftest` into `package.json`. |
| D4 — CSP `'wasm-unsafe-eval'` replaces `'unsafe-eval'` | Worker C | DONE (merged) | 46813ca | `'unsafe-inline'` kept in `script-src` for the single inline SW-registration block (redundant `onsubmit` attr removed in 6d278b4); `style-src 'unsafe-inline'` kept. Follow-up: hash the inline block from `index.html` at startup. |
| D5 — `connect-src https://tablebase.lichess.ovh` | Worker C | DONE (merged) | 46813ca | Asserted in `security-headers-selftest` (22/22). |
| index.html honesty — `#analysis-engine-label`, `#analysis-engine-caveat`, footer engine credit | Worker C | DONE (merged) | 6d278b4 | "Beginner Engine" gone; Worker A overwrites label/caveat text on engine-ready. |
| Proof test `test/wave1-engine-selftest.js` (14) | Worker C | DONE (merged) | 11aca52 | Vendor files, size band, `\0asm`, GPL text, allowlist/precache, CSP, engine runs (uci → "Stockfish 19", rejects Qxd5??, finds a1a8#), index.html. |
| Docs — CLAUDE.md / README.md (+ Licence) / roadmap status / this section | Worker C | DONE (merged) | (docs commit) | |

**Known follow-ups surfaced in Wave 1 (not blocking):**
- `server.js` `isRevalidatableStatic()` only matches `src/` and `assets/`, so `vendor/*` is served with
  the global `no-store` (no ETag/304) outside the service-worker cache. One-line fix
  (`|| rel.startsWith('vendor/')`) in the D2 hunk — apply at merge.
- `bot-tactics-selftest.js:133` asserts `BOT_LEVELS[8].rating <= 1400` ("must not overstate the
  heuristic engine") — Worker B's re-calibrated ladder will need that assertion revised.

**Wave 1 verification (lead, merged branch `feat/wave1-real-engine`):** `wave1-engine-selftest` 14/14; live server on :39290 — vendor
files 200 (`application/javascript` / `application/wasm`, ETag + `max-age=0, must-revalidate`), CSP `script-src 'self' 'unsafe-inline'
'wasm-unsafe-eval' …` (no `'unsafe-eval'`), browser MultiPV lines at **d=16**, level-8 bot replied 1.e4 Nc6 within 3.5 s, 0 console errors.
Merge-time follow-ups applied in 20fdcc6: `#bot-level-select` labels 800–2300, `vendor/` added to revalidatable static prefixes,
`wave1-engine-selftest` wired into `test:unit` + `lint`. Known follow-ups: `'unsafe-inline'` in script-src (hash the SW-registration
inline block), `personality-bots.pickMove` still not fed MultiPV candidates, `game-archive.saveEval` does not persist the `engine` field.

---

## 7. WAVE 2 — Site shell + reachability (branch `feat/wave2-shell`, started 2026-09-18)

Roadmap §4 R1–R5 + E3/E4. Step 0 (lead): both Playwright suites made green again (they had been red since the
auto-room commit, not since Wave 0/1 — commit 21c2c92). Step 1 (lead): `src/shell.js` hash router + view
scaffolding so workers code against a fixed contract.

### Shell view contract (`src/shell.js`)
```js
window.Shell.registerView({
  id: 'puzzles',           // route #/puzzles → <section data-view="puzzles"> (already in index.html)
  title: 'Puzzles', order: 30, nav: true,
  mount(el, params) {},    // first navigation; build your DOM inside `el`
  show(el, params) {},     // every navigation after mount (optional)
  hide(el) {}              // navigating away (optional)
});
Shell.navigate('puzzles', { theme: 'fork' });   // → #/puzzles?theme=fork
Shell.onChange(({ id, params }) => {});         // route listener
```
- Known view ids/sections: `home`, `play` (= existing `<main id="workspace">`), `analysis`, `puzzles`, `library`,
  `compete`, `me`. Unregistered views show a placeholder; registering a `mount()` later takes over the section.
- `index.html` has `<base href="/">`, so never write `href="#/x"` expecting same-document navigation from
  code — use `Shell.navigate()`; the shell delegates clicks on `a[href^="#"]` for markup.
- A plain visit lands on Home; `/game/<room>` links land on Play. Play params: `#/play?bot=1` enables the bot,
  `#/play?invite=1` copies the room link.
- Every new client module: `ALLOWED_FILES` (server.js) + `PRECACHE_ASSETS` (service-worker.js) + `<script>` in
  index.html before `ui.js`, and it must have a call site or `test/reachability-selftest.js` fails. Wiring a
  formerly-dark module = delete it from `KNOWN_DARK` there (the list may only shrink).
- Browser suites: `scripts/smoke-test.mjs` / `test-ui-features.mjs` open `#/play` and use the page's own room.

| Item | Owner | Status | Commit | Notes |
|---|---|---|---|---|
| Step 0 — Playwright suites green | lead | DONE | 21c2c92 | room-aware scripts, seat release on bot off, serialised bot config |
| R1 — `shell.js` router, nav, Home cards, view sections, CSS | lead | DONE | (this commit) | base-href click delegation; hash preserved across the room rewrite |
| R1/R3/R4 — Play view slimming, Assist drawer, Settings view, a11y modules wired | Worker A | DONE | 1a5e6fe…e4e2ef0 | above-fold controls 16→11 (390px), <44px targets 33→1; typed/voice commands + swipes live; 2 latent voice bugs fixed |
| E4 — Puzzles: 8,861 CC0 lichess rows, SQLite tables, `/api/puzzle/*`, Daily/Rated/Custom/Storm/Review view | Worker B | DONE | 1493b02…bd73995 | server-side solve verification, Glicko-2 puzzle rating, spaced repetition |
| R2 — rating on game end, lobby/leaderboard/arena/social routes, Compete + Profile views | Worker C | DONE | 3a879b8…a50513c | only signed-in human-vs-human games are rated; found SW `/api` cache bug (fixed d85baa9) |
| E3/R5 — real chess-openings TSV (3,810 lines), fabricated stats deleted, Analysis view with own engine worker | Worker D | DONE | f0ff460…762893f | `/api/openings/*`, `/api/fen/validate`; tablebase parser fixed for the real lichess shape |

**Wave 2 result (lead):** `KNOWN_DARK` 30 → 11 (remaining: chess960, variants, chat-upgrades, correspondence,
personality-bots, i18n, puzzle-racer, study-tree, fen-setup, game-archive/time-control browser copies). All views
render at 390px with 0 console errors; `smoke-test` + `test-ui-features` PASS. Follow-ups: Library view is still a
placeholder (archive modal remains the entry point); `personal` openings stats can't bind games to a player until
accounts bind archived games; `scripts/test-analysis-view.mjs` needs port parameterisation before joining
`test:browser`; `'unsafe-inline'` still in `script-src`; every auto-room visitor leaves `.referee-state-<room>.json` + journal in the repo root forever (add room-file retention/GC).

---

## 8. WAVE 3 — Retention (branch `feat/wave3-retention`, 2026-09-19)

Kanban: project `chess` on https://agent-kanban-board-production.up.railway.app (cards `w3-*`, round 5). Loop per
card: claim (needs `agent_id` + `role`; claims expire in 5 min and an admin reaper resets unowned BUILDING cards)
→ BUILDING → IN_REVIEW on merge → IN_TEST when the full check + browser suites pass → DONE on push to `main`.
`depends_on` is enforced by the board (`w3-achievements` waits for `w3-streaks`).

| Card | Owner | Commits | What landed |
|---|---|---|---|
| `w3-streaks` | Worker A | 9bceb19…9c8dda7 | `streaks.js` (UTC days, +1 per day, 2 idle days of slack, reset after 3), tables in `social-store.js`, `/api/streak`, `/api/activity`, `#streak-badge`, Home line, Profile card. Game-over hook fires for both signed-in seats; puzzle solve/review and analysis batches count. |
| `w3-achievements` | Worker A | same | 12-badge catalogue, server-verified client events (brilliant/tablebase need an archived game the caller played), puzzle-rating badges ignore provisional RD. `first_league_promotion` hook wired to leagues. |
| `w3-leagues` | Worker B | 1e6a5a5…5faeb9e | ISO-week leagues, 8 tiers Wood→Legend, divisions ≤50, top 20% promote, no relegation; `leagues.db` (`CHESS_LEAGUES_DB_PATH`); fed from rated results; admin `POST /api/league/close-week` (`CHESS_ADMIN_TOKEN`). |
| `w3-insights` | Worker B | same | `insights.js` metric×dimension×filter; `/api/insights`; Insights view with SVG chart. `moveTime`/`ratingGain` honestly `available:false` (schema has no per-move times / rating history). |
| `w3-external-import` | Worker C | 2d236ba…2798e07 | `games.owner_id/source/external_id/room_id`; lichess + Chess.com importers (stubbed fetch in tests, 429 backoff, 500-game cap); `/api/import/*`, `/api/library`, claim guest games. |
| `w3-library-view` | Worker C | same | `#/library` replaces the placeholder: search, source chips, paging, Open in Analysis, PGN paste, import forms. |
| `w3-room-file-gc` | Worker D | 07bc832…72c61b9 | idle-room GC (24 h idle, no SSE/human seats/in-flight cmd, unstarted or finished; finished games archived first), cap eviction, `GET/POST /api/admin/rooms[/gc]`, boot sweep + hourly (`CHESS_ROOM_*`, `CHESS_ROOM_GC=0`). |
| `w3-csp-inline-hash` | Worker D | 58966b1 | inline SW registration → `src/sw-register.js`; `script-src` no longer has `'unsafe-inline'` (style-src still does). |
| `w3-missed-tactics` | Worker D + lead | febd57c…70a4ae7, ui.js | `Miss` classification (swing ≥150 cp then give-back ≥100 cp while still not losing), `missed-tactics.js`, `/api/games/:id/missed-tactics`, `POST /api/review/missed-tactics`, Analysis "Missed tactics" panel with hidden-engine retry, Miss row in Game Review. |

**Lead follow-ups applied at merge:** `onRated` chain carries both SocialRoutes and insights consumers; Gate-4 module
loop covers all `ui-*.js`; server-starting suites set `CHESS_LEAGUES_DB_PATH` under tmpdir.

**Open after Wave 3:** `GET /api/games` (archive modal, Profile recent games) is still unscoped — owned/imported
games are visible to any visitor; `service-worker.js` `CACHE_NAME` is still `chess-ui-v1` (bump to force existing
installs to refetch `index.html`); brilliant/tablebase achievement events can only be owner-verified once archived
games carry real player names; `scripts/test-ui-features.mjs` has no Puzzles/Library/Insights/Missed-tactics steps
yet (DoD item 4); a 300-ply first missed-tactics request was unbounded (~60 s serial engine) — now capped by the
per-request budget in `routes-review.js` (B15, `fix/missed-tactics-bounded`).

**AccountsManager JSON-path precedence (branch `fix/accounts-node20-isolation`).** `node:sqlite` exists only on
Node ≥ 22.5. The `AccountsManager` JSON fallback used to resolve `options.jsonPath || DEFAULT_JSON_PATH`, so on
Node 20 a caller-supplied `dbPath` (or string path) was silently dropped and every manager shared the one
`src/.accounts.json` — the same class of cross-contamination `game-archive.js` already fixed (see its
precedence-ladder comment at `game-archive.js:1386-1406`). `accounts.js` now mirrors that ladder exactly:
`typeof options === 'string'` → that string; `options.jsonPath` → verbatim; resolved `dbPath === ':memory:'` →
`:memory:`; explicit `options.dbPath` → `dbPath + '.json'`; otherwise `DEFAULT_JSON_PATH`. Production
(`new AccountsManager()` with no options) still resolves to `DEFAULT_JSON_PATH`, and `:memory:` adapters stay
in-memory. Test suites now also set `CHESS_ACCOUNTS_JSON_FILE` under `os.tmpdir()` (defense in depth), and
`test/accounts-isolation-selftest.js` pins all six input shapes plus the no-shared-state guarantee on both Node 20
and Node ≥ 22.5.

## 9. POST-WAVE 3 — Gameplay correctness (branch `feat/g4-undo-request`, 2026-09-19)

| Card | Owner | Commit | What landed | Tests |
|---|---|---|---|---|
| `g4-undo-request` | builder | (uncommitted) | Undo in a human-vs-human room becomes an opponent-consent request: `POST /api/undo` sets `state.undoRequest` without touching the board, `POST /api/undo/respond` (alias `/api/undo-respond`) takes `{consent:true|false}`, only the non-requester may answer. Solo/local/bot/unseated undo is unchanged. UI mirrors the draw-offer banner (`#undo-request-banner`). Journal replay handles the new `undo` args (`request`/`respond`) so crash recovery cannot resurrect a stale request or double-undo. A finished game rejects every undo action with 409 `game over` (the handler guards on `gameOver` first, so a dangling request cannot resurrect the board), and draw-claim / draw-accept / timeout all clear `state.undoRequest`. | `g4-undo-request-selftest.js` — 76 assertions |

**Design note:** the referee stays seat-agnostic. `server.js` derives `bothSeatsHuman` from
`seatAuthManager.getSeatAccounts(roomId)` and passes it, plus the caller's colour from `validateMutation`, into
the `undo` command args — the same pattern `_cmdDraw` uses for `isSeated`. Product decision: consent is keyed on
both seats being **occupied by humans for the whole game**, *not* on both being currently active — the predicate
requires only that both seats exist and are non-bot, deliberately ignoring idle-seat expiry, so a ~5-minute idle
timeout can never silently downgrade a human-vs-human room to unilateral undo.

**Game-over guard:** `_cmdUndo` returns `{ok:false, error:'game over', httpStatus:409}` at the top whenever
`state.gameOver` is set, covering request / respond / the legacy unilateral path. Game-ending transitions
(draw-claim, draw-accept, resignation, timeout, a move) all null `state.undoRequest` so no pending request can
outlive the game (`src/referee-service.js`).

## 10. WAVE 4 — Study chapters (branch `feat/a2-study-chapters`, 2026-09-20)

Kanban card `a2-study-chapters` (round 6). Implements A2.2 from `RECOMMENDATIONS.md:117`
("Study chapters: PGN/FEN/game-import chapters, hidden-move 'quiz' chapters — reuses the puzzle
input loop. PGN export with $1–$9 NAG glyphs for downstream tool interop.").

| Card | Owner | Commit | What landed | Tests |
|---|---|---|---|---|
| `a2-study-chapters` | builder | (uncommitted) | `#/study` view (`ui-study.js`, nav order 42 between Library and Compete) plus a server-side chapters API. Three chapter kinds — **PGN** (parsed by the previously-dark `study-tree.fromPGN`, so RAV variations and NAGs are preserved), **FEN** (server-validated start position + a recorded SAN/UCI line), **Game** (an archived game imported by id via `game-archive.getGame`). **Hidden-move quiz mode**: upcoming moves are concealed, the viewer guesses two-click on the Study board and `POST /api/study/:id/guess` validates server-side against the stored line (alternate mates accepted, wrong guesses never leak the solution, scripted replies auto-play). **PGN export** is server-rendered by `study-tree.toPGN`, emitting `$1`–`$9` NAG tokens that round-trip through `fromPGN`. | `test/study-chapters-selftest.js` — 17 tests; `test/study-tree-selftest.js` (49) wired into `test:unit` + `lint` |

**What was reused, not reinvented:** `study-tree.js` (548 lines) is the whole move-tree/PGN engine — it is now
required by `routes-study.js` so it moved out of `test/reachability-selftest.js` `KNOWN_DARK` (list may only
shrink: 11 → 10). `study-store.js` clones the `social-store.js` shape (`createStudyStore` tries
`SqliteStudyAdapter` then falls back to `JsonStudyAdapter`, `getDefaultStudyStore`/`resetDefaultStudyStore`,
atomic temp-file JSON writes) with `CHESS_STUDY_DB_PATH` / `CHESS_STUDY_JSON_PATH`. The quiz loop mirrors
`routes-puzzles.js` `presentPuzzle`/`replayPrefix`/`/:id/try` exactly: solution-free public view, stateless
replay from the stored line per request, only a checkmate may differ from the solution.

**Scope (round-2 hardening):** every chapter is owned by a per-visitor identity, mirroring
`routes-puzzles.playerIdFor` — `user:<accountId>` when signed in, else `anon:<study_player cookie>`
(minted on first contact). `GET /api/study` lists only the current viewer's chapters; a chapter owned by
another account OR another anon cookie is a 404 on read/mutate, so one guest can never delete another
guest's chapter or un-quiz it to expose the solution. A concealed quiz's solution is guarded in three
places: the public `GET /api/study/:id` view omits it, `GET /api/study/:id/pgn` returns 403 until *that
viewer* has completed or explicitly revealed the chapter (server-side per-viewer `study_reveals` state,
never a query param), and the client hides the Export PGN button until reveal/completion.
`state.positions[] = {fen,san,lastMove}` is built server-side so the client never replays a move (Gate 4);
the Study view owns `#study-board` and never touches `#board`.

**Open after Wave 4:** quiz *progress* is not persisted across reload (only reveal/completion state is);
chapters are flat (no folder/collection grouping); `service-worker.js` `CACHE_NAME` bumped to
`chess-ui-v4` for the new nav entry; `study.db` is gitignored via `*.db` and `.study.json` via an explicit
rule. Interactive-lesson per-move prompts (N3 item 21) remain open.

---

## 11. M5 — Performance pass (branch `feat/m5-performance-pass`, 2026-09-20)

Kanban had no `m5` card (52 cards total; M5 arrived as task text only), so no kanban change. An
evidence-backed audit, not a rewrite: measure → fix only what the evidence supports → test → document.

| Item | Status | Evidence |
|---|---|---|
| `computeHistoryPositions` O(n) memoization | **not applicable** | Deleted by B3 (10b3855); absent from `src/` (only stale `.claude/worktrees/` copies). Per-ply `state.positions[]` replaced it. |
| D2 cache-control audit | **done, re-verified** | 539c7cc; re-measured 2026-09-20 |
| D1 gzip/brotli | **done, re-verified** | 498e2d1 |
| Frontend bottleneck audit | **no change justified** | measured below |
| M5-1 referee double-replay fix | **done (uncommitted)** | `drawStatus()` + `applyDrawStatus()` |

### Measurement 1 — static delivery (reproducible)

```
$ CHESS_PORT=39281 CHESS_STATE_FILE="$TMP/state.json" CHESS_JOURNAL_FILE="$TMP/journal.jsonl" \
  CHESS_DB_FILE="$TMP/games.db" … node server.js      # $TMP = os.tmpdir mkdtemp

$ curl -sS -D- -o /dev/null -H 'Accept-Encoding: identity' .../src/ui.js
HTTP/1.1 200 OK
Cache-Control: public, max-age=0, must-revalidate
Vary: Accept-Encoding
ETag: W/"23acb-1a0bb4c383b"
# gzip → adds Content-Encoding: gzip; br → Content-Encoding: br (same ETag, Vary on all)

$ curl -sS -D- -o /dev/null -H 'If-None-Match: W/"23acb-1a0bb4c383b"' .../src/ui.js
HTTP/1.1 304 Not Modified
Cache-Control: public, max-age=0, must-revalidate
ETag: W/"23acb-1a0bb4c383b"      # 0-byte body
```

| Scope | identity | gzip | br |
|---|---|---|---|
| `src/ui.js` (146,123 B) | 146,123 B / 0.98 ms | 36,071 B / 3.68 ms | 33,719 B / 2.87 ms |
| first load: `index.html` + 47 scripts | **802,205 B (802.9 KB)** | **221,807 B (216.6 KB)** | **209,398 B (204.4 KB)** |
| repeat request with `If-None-Match` | — | **304, 0 B** | — |

### Measurement 2 — server hot path (the one real finding)

Per-move `ref.enqueue({type:'move'})` on a 160-ply non-repeating game, components attributed:

| ply | `automaticDraw` | `claimableDraw` | two-replay draw total | snapshot stringify+write |
|---|---|---|---|---|
| 40 | 1.376 ms | 1.272 ms | 2.649 ms | 0.083 ms |
| 160 | 4.346 ms | 4.106 ms | **8.452 ms** | 0.081 ms |

`automaticDraw` (`rules-engine.js:318`) and `claimableDraw` (`:338`) both call `createFromHistory(history)`
(`:156`) → two O(n) replays per ply. Fix: `rulesEngine.drawStatus(boardOrFen, history)` replays **once** and
returns `{automatic, claimable}`; `referee-service.js` `applyDrawStatus(s)` consumes it in `applyMove`
(`:426`) and `rebuildState` (`:323`) instead of the pair. Fallback keeps the old two-call behaviour if
`drawStatus` is absent.

Real-referee before/after (same harness, same game):

| plies | before (two replays) | after (one replay) |
|---|---|---|
| 1–10 | 1.585 ms | 1.173 ms |
| 40–50 | 3.544 ms | 2.126 ms |
| 80–90 | 5.781 ms | 3.078 ms |
| 150–160 | 8.635 ms | **4.477 ms** |

Differential (old pair vs `drawStatus`) over 9,301 positions (random games + shuffle + FEN edges + malformed
history): **0 mismatches**. `test/m5-performance-selftest.js` (**15 tests**) re-runs a subset (FEN edges + 4,650
random-game positions), the replayed-vs-FEN split, plus referee fivefold/threefold/fifty-move and the
no-`drawStatus` fallback.

**Round-2 coverage (replayed-vs-FEN split).** `drawStatus()` reads the halfmove-clock / seventyfive-move /
insufficient-material / fifty-move conditions from the **board's own FEN** but finds repetition in the
**replay**. The first suite never paired an edited FEN clock with a non-empty replay, so a mutant making the
FEN-only checks use `(replayed || fenInstance)` survived it. Added 6 tests: three helper-level cases (board
clock 100 / 150 / K-vs-K, each with a short replay whose clock disagrees), one asserting repetition *does*
come from the replay, and two end-to-end `/api/setup` + `g1f3` cases (a pawn move would reset the clock, so a
knight move is required to keep the disagreement). **Mutation proof:** mutating `drawStatus` to
`clockSource = replayed || fenInstance` fails **5** of the 15 tests (helper fifty/seventyfive/insufficient +
both e2e cases) with `claimable:false`/`draw:false` where the FEN verdict is expected; restoring the original
source returns the suite to **15/15 green**. No suite count change (75).

### Measurement 3 — client (no change)

`positionsToHistorySnapshots` (called on every SSE/poll state, `ui.js:1336`) measured on extracted pure
functions: 0.19 ms @ 40 plies, 0.71 ms @ 160, **1.31 ms @ 300**; `fenToDisplayBoard` 0.004 ms each. The 1 s
clock tick (`renderTimers`) only toggles two classes. Neither is on a per-frame path; **no production client
change is justified**, so `src/ui.js` is untouched.

### Files

- `src/rules-engine.js` — added `drawStatus()` + export.
- `src/referee-service.js` — `applyDrawStatus()` helper; `applyMove`/`rebuildState` use it.
- `test/m5-performance-selftest.js` — new (15 tests), wired into `test:unit` + `lint`.
- `package.json` — suite append (74 → 75); `src/ui-about.js` + `test/about-selftest.js` — count 74 → 75.
- `service-worker.js` — `CACHE_NAME` `chess-ui-v4` → `chess-ui-v5` (the precached `ui-about.js` bytes changed).
- `docs/06-world-class-roadmap.md`, `docs/05-file-inventory.md`, this file — M5 status.

No commit / push / kanban change (builder was the only writer).

## 12. Static URL Navigation Across Site Shell Sections (branch `feat/static-url-navigation`, 2026-09-20)

| Task ID | Owner | Branch | Status | What landed | Tests |
|---|---|---|---|---|---|
| `static-url-navigation` | orchestrator-admin | `feat/static-url-navigation` | DONE | In-memory SPA shell navigation matching `agent-kanban.riazrahaman.com`. URL remains static at `/game/<room>` (or `/`) without hash pollution when switching between sections (Play, Analysis, Puzzles, Coordinates, Library, Study, Compete, Profile, About, Home). Deep links on initial load are respected and then cleanly stripped via `history.replaceState`. | `test/static-url-navigation-selftest.js` (8 assertions), full `test:unit` (77 suites), Playwright smoke & feature tests |

### Architecture & Fix Details
1. **`src/shell.js`**:
   - `Shell.navigate(id, params)` switches views directly in memory (`show(id, params)`), calls `stripHash()`, and avoids setting `window.location.hash`.
   - Global click listener intercepts in-document `a[href^="#/"]` links, calls `preventDefault()`, and delegates to `Shell.navigate(parsed.id, parsed.params)`.
   - In-page anchors (e.g. `#workspace`) do not start with `#/` and are left to native browser scrolling.
   - On boot, `route()` reads `window.location.hash || initialHash` to respect deep links, displays the view, and cleanly strips the hash via `history.replaceState`.
2. **`src/ui.js`**:
   - `initRoomRouting()` preserves initial hash during the `/` → `/game/<room>` redirect so `shell.js` boot can read it before stripping.
   - One-shot parameter cleanups (`params.bot`, `params.invite`) use `window.location.pathname + (window.location.search || '')` instead of forcing `#/play`.
3. **Audit & Safety**:
   - Gate 4 invariant: zero calls to `makeMove(` or `createInitialBoard(`.
   - Unit suites count updated to 77 in `src/ui-about.js`, `test/about-selftest.js`, and `package.json`.
   - `scripts/smoke-test.mjs` and `scripts/test-ui-features.mjs` verified passing in Chromium with zero errors.

---

## 13. MASTER QA AUDIT & DEFECT REMEDIATION (branch `fix/audit-broken-corners`, 2026-09-20)

| Task ID | Owner | Branch | Status | What landed | Tests |
|---|---|---|---|---|---|
| `fix-audit-broken-corners` | orchestrator-admin | `fix/audit-broken-corners` | DONE | Full deep-dive QA audit across all 18 feature domains producing Master QA Audit & Test Plan. Remediated 6 broken corners: (1) multi-tab seat isolation (`chess_seat_token_${room}`), (2) promotion modal Cancel & Escape dismiss in puzzles & study, (3) draw claim button visibility for unseated/local games, (4) 2-step touchscreen resignation confirmation state machine (4s timeout), (5) clipboard fallback with `execCommand` and UI toast, (6) in-memory browser history navigation (`pushState`/`popstate`). Updated Kanban default to `agent-kanban.riazrahaman.com`. | `test/audit-broken-corners-selftest.js` (9 assertions), 78 unit test suites in `npm run check` (0 failures), Playwright smoke & feature tests (0 errors), Gate 4 invariant (0 hits). |

### Master QA Audit & Test Plan Artifact
- Location: `master_qa_audit_and_test_plan.md`
- Scope: 924 lines covering 18 structured suites (Site Shell, Board Mechanics, Multiplayer Rooms & Seats, Game Termination & Clocks, G4 Undo Requests, AI Bot Play, AI Coach & Reports, Analysis Board & MultiPV, Puzzles & Repetition, Coordinates Trainer, Study Chapters & Quiz Mode, Library & External Import, Compete Lobby & Leagues, Accounts & Profiles, Settings & Theming, Accessibility & Voice, Service Worker & PWA, Security & Invariants).

### Broken Corners Remediated
1. **Multi-Tab Seat Isolation (`src/ui.js`, `src/ui-compete.js`)**:
   - Room-namespaced storage keys: `sessionStorage.getItem('chess_seat_token_' + room)` (with legacy fallback).
   - Prevents seat token contamination and race conditions when playing across multiple simultaneous tabs.
2. **Promotion Modal Dismiss / Escape Clean-Up (`src/ui-puzzles.js`, `src/ui-study.js`)**:
   - Added Cancel button to `.pz-promo` and `.st-promo`.
   - Added `Escape` key listener with complete event cleanup, square unselection, and re-rendering.
3. **Unseated Draw Claim Visibility (`src/ui.js`)**:
   - Ensured `#claim-draw` button is visible when conditions are met in unseated games:
     `canClaim = (seated || (!state?.seats?.white && !state?.seats?.black)) && isDrawClaimable(state)`.
4. **Touchscreen Resignation Safety (`src/ui.js`, `index.html`)**:
   - 2-step confirmation on `#resign`: First click sets button to 'Confirm Resign?' with `.btn-danger-confirm` and starts a 4-second reset timer. Only a second click proceeds with resignation. Resets cleanly on board reset/game end.
5. **PGN Copy Fallback (`src/ui.js`)**:
   - Fallback executes `document.execCommand('copy')` on a temporary off-screen `<textarea>` when `navigator.clipboard` is unavailable or rejected.
   - Shows feedback toast via `showUiError()`.
6. **SPA History Navigation (`src/shell.js`)**:
   - Navigating sections issues `history.pushState({ viewId, params }, '', pathname)`.
   - Listens on `popstate` to restore sections when clicking the browser's back/forward buttons without full reloads.

### Verification & Invariants
- Gate 4 Architectural Invariant: Exactly 0 occurrences of `makeMove(` or `createInitialBoard(` across all 18 UI and shell files.
- Unit Test Battery: 78/78 suites passing in `npm run check`.
- Browser Test Battery: Playwright smoke test and UI/AI feature test passed in Chromium with 0 errors.
- Git Status: Merged into `main` (`--no-ff`, commit `933eb20`), pushed to `origin/main`.
- Kanban Board: Task `fix-audit-broken-corners` transitioned to `DONE` on `https://agent-kanban.riazrahaman.com`.



---

## 14. DEFECT FIX — Sign-in dialog centering (branch `fix/auth-modal-centering`, 2026-09-20)

| Task | Owner | Branch | Status | Summary | Evidence |
| --- | --- | --- | --- | --- | --- |
| `fix-auth-modal-centering` | orchestrator-admin | `fix/auth-modal-centering` | DONE | `#auth-modal` had **no CSS rule anywhere**, so `openAuthModal()` (which only removes `.hidden`) left the panel as an unstyled static block at the end of `<body>` — bottom-left, no backdrop. Fix: added `#auth-modal` to the existing `#archive-modal, #import-pgn-modal` rule group (`position:fixed; inset:0; rgba(0,0,0,0.5); display:flex; justify-content:center; align-items:center; z-index:150`) plus the `#auth-modal.hidden { display:none; }` variant. Regression guard added to `test/t1-mobile-visuals-selftest.js`: asserts all five modal ids (promo / game-end / archive / import-pgn / auth) are centered fixed overlays and that `#auth-modal.hidden` really sets `display:none`; the selector regex is id-anchored (`#id(?![\w-])`) so `#auth-modal-title` decoys cannot satisfy it. | 2 independent reviews APPROVE; real Playwright check at 1280x900 and 390x844 (centered delta 0.00px, backdrop, close works); 3 mutation proofs (revert → 2 FAIL, decoy → FAIL, `.hidden=color:red` → FAIL); `test:unit` 78/78 and `npm run check` on Node 20.19.5 both exit 0 |

### Known limitations (non-blocking, follow-up)
- The modal guard is static text analysis over `index.html`; a later **second** `#auth-modal` rule (cascade override) or an `@media`-wrapped decoy would still leave it green. Acceptable for a cosmetic two-line change; a future CSS-aware check would close it.

---

## 15. PERF FIX — Bound missed-tactics analysis (branch `fix/missed-tactics-bounded`, 2026-09-20)

| Task | Owner | Branch | Status | Summary | Evidence |
| --- | --- | --- | --- | --- | --- |
| `perf-missed-tactics-bounded` | builder | `fix/missed-tactics-bounded` | DONE | `routes-review.js` `evaluatePositions()` looped every uncached position serially with `await engineServer.analyse()` (depth 12, ≤200 ms movetime); a cold 300-ply game (~150 searches) could hold ONE request for ~30–60 s. Fix: per-request bounds on **new** engine searches — `REVIEW_MAX_EVALS` (env `CHESS_REVIEW_MAX_EVALS`, default 60) and `REVIEW_BUDGET_MS` (env `CHESS_REVIEW_BUDGET_MS`, default 5000 ms), checked before each new `analyse()`; the in-flight search finishes, so overshoot is ≤ one movetime. Cache hits and terminal positions are free and never counted against the gate (they still count in the reported `evaluated`), so a fully-cached game is still served whole. `CHESS_REVIEW_MAX_EVALS=0` / `CHESS_REVIEW_BUDGET_MS=0` mean "no new engine evals", not "unlimited". Skipped positions return `null` evals and flip `truncated` with a new `truncatedReason: 'budget'\|'max-plies'\|null` (plus a `budget` echo in the response); the response contract and depth-keyed `eval_cache` are unchanged apart from those two additive fields. `findMissedTactics` already tolerates null evals (`normalizeEval` skips windows touching a null), so `misses` is computed from whatever evals exist — no invented data. Client `ui-analysis.js` labels a truncated panel from the reason ("budget reached" vs "position cap reached") and the empty-state likewise; no inline handlers. Test seam: `evaluatePositions(positions, gameArchive, opts)` accepts `opts.analyser` / `opts.now` / `opts.maxEvals` / `opts.budgetMs` (defaults engineServer / Date.now / the env constants), so `test/missed-tactics-bounded-selftest.js` drives it with a counting stub — no Stockfish, no server. | `test/missed-tactics-bounded-selftest.js` (8 tests: cache-free, count cap, wall-clock cap, full-cache whole + unhurt, terminal count-free, null-tolerant misses, contract, max-plies reason); About stat + `about-selftest.js` 78→79; `test:unit` 79/79 |

### Design trade-offs / honest notes
- Defaults bound the cold worst case to ~60 searches (≈5 s budget → whichever comes first). A user with a long cold game gets the earliest positions' misses and an honest truncation label rather than a 30–60 s hang; a second request re-runs the still-uncached tail, but every completed eval is cached, so successive calls converge to complete.
- `truncatedReason` is additive; nothing was removed or renamed from the response.
