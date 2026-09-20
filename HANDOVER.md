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

**Open after Wave 3:** `GET /api/games` (archive modal, Profile recent games) is now scoped —
`handleGetGamesEndpoint` (`server.js:1235-1252`) sets `owner = session.userId` when signed in and
`owner = null` for guests (same pattern as `src/routes-library.js`); `service-worker.js` `CACHE_NAME` is
`chess-ui-v5`; brilliant/tablebase achievement events can only be owner-verified once archived games carry
real player names; `scripts/test-ui-features.mjs` now has Puzzles (~line 476), Library (~line 507), Insights
(~line 532), Analysis/missed-tactics (~line 560), and Study (~line 614) steps; the ~60 s serial-engine missed-tactics
request is now bounded by the per-request budget in `routes-review.js` (§15, `fix/missed-tactics-bounded`,
`CHESS_REVIEW_MAX_EVALS`/`CHESS_REVIEW_BUDGET_MS`).

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

---

## 16. CI GATE — Run the Playwright journeys in CI (branch `ci/browser-gate`, 2026-09-20)

| Task | Owner | Branch | Status | Summary | Evidence |
| --- | --- | --- | --- | --- | --- |
| `ci-browser-gate` | builder | `ci/browser-gate` | DONE | `npm run test:browser` (`scripts/smoke-test.mjs && scripts/test-ui-features.mjs`) never ran in CI, so Play/Analysis/Puzzles/Library/Insights/Coordinates/Study/undo-request/auth-modal regressions could land while the unit suites stayed green. New `browser` job in `.github/workflows/ci.yml` (`Browser (ubuntu-latest, node 22)`) runs on `ubuntu-latest`/node 22, `needs: [linux]` so it waits on the unit gate, installs Chromium with `npx playwright install --with-deps chromium`, and runs `npm run test:browser` with **all** runtime state redirected into `${{ runner.temp }}` via the `CHESS_*` env vars (state/journal/games/accounts/social/leagues/study/rate-limit) plus `CHESS_PORT=39281` and `CHESS_RATE_LIMIT=100000`, so the scripts' self-spawned `node server.js` writes nothing into the repo. On failure it uploads `test-results/`, `playwright-report/`, `blob-report/` (`if-no-files-found: ignore`); `.gitignore` now covers those paths. Triggers: `push`/`pull_request` to `main` (as before), plus nightly `schedule` (`17 4 * * *`) and `workflow_dispatch`. | `npm run test:browser` locally with the same tmpdir env → exit 0, both scripts PASS, runner-tmpdir contains the state, repo-root `.referee-*` mtimes unchanged; workflow parses (`yaml.safe_load`); `npm run lint` exit 0; `about-selftest`/`reachability-selftest` exit 0 |

### Why these triggers
- **push/PR to `main`:** the task's goal is to *catch* regressions, not only report them nightly. The `browser` job is `needs: [linux]`, so it never runs when the core gate is already red — the marginal cost is ~2–4 min of an already-running workflow, and it runs once (not per matrix leg). A regression that unit tests miss is fixed on the PR rather than discovered a day later.
- **nightly `schedule` + `workflow_dispatch`:** guards against external drift (e.g. a Playwright/Chromium or CDN change) and lets the gate be re-run on demand without an empty commit.

### Reproduce locally
```bash
# from the repo root, with Playwright's Chromium installed (`npx playwright install chromium`)
CB_TMP=$(mktemp -d)
CHESS_PORT=39281 \
CHESS_STATE_FILE="$CB_TMP/.referee-state.json" CHESS_JOURNAL_FILE="$CB_TMP/.referee-journal.jsonl" \
CHESS_DB_FILE="$CB_TMP/games.db" CHESS_JSON_ARCHIVE_FILE="$CB_TMP/.games-archive.json" \
CHESS_ACCOUNTS_DB_FILE="$CB_TMP/accounts.db" CHESS_ACCOUNTS_JSON_FILE="$CB_TMP/.accounts.json" \
CHESS_SOCIAL_DB_PATH="$CB_TMP/social.db" CHESS_SOCIAL_JSON_PATH="$CB_TMP/.social.json" \
CHESS_LEAGUES_DB_PATH="$CB_TMP/leagues.db" CHESS_LEAGUES_JSON_PATH="$CB_TMP/.leagues.json" \
CHESS_STUDY_DB_PATH="$CB_TMP/study.db" CHESS_STUDY_JSON_PATH="$CB_TMP/.study.json" \
CHESS_RATE_LIMIT_FILE="$CB_TMP/rate-limit.json" CHESS_RATE_LIMIT=100000 \
npm run test:browser
```
The scripts spawn (and kill) their own server on 39281; run them sequentially — `test:browser` already chains them with `&&`. Do not run a second server-starting suite at the same time in the same checkout.

### Honest notes
- The artifacts directories (`test-results/`, `playwright-report/`) are only produced by Playwright's HTML/trace reporters, which these plain `chromium.launch()` scripts do **not** enable; the upload step is therefore a no-op today (`if-no-files-found: ignore`) and becomes useful the moment a reporter/trace is added. It is wired now to avoid another CI change later.
- `CHESS_BOT` does **not** exist in the server or scripts; it was intentionally omitted (the scripts drive bot enable/disable through the UI and `/api/bot`).
- CI itself was not executed locally (no GitHub runner); the job was validated by parsing the YAML and by running the exact `npm run test:browser` command with the exact env block against the real server on macOS. The Linux-specific pieces (`--with-deps`, headless Chromium without a display) are standard and the scripts launch `chromium.launch({ headless: true })` (smoke-test.mjs:142, test-ui-features.mjs:42).

---

## 17. CI GATE — Exercise the JSON persistence fallback on a sqlite-capable Node (branch `ci/json-fallback`, 2026-09-20)

| Task | Owner | Branch | Status | Summary | Evidence |
| --- | --- | --- | --- | --- | --- |
| `ci-json-fallback-on-sqlite-node` | builder | `ci/json-fallback` | DONE | The game-archive JSON adapter (`src/game-archive.js`, forced by `CHESS_ARCHIVE_FORCE_JSON=1` at `src/game-archive.js:1370`) only ran in CI on the `linux` **node-20** leg — where `node:sqlite` is absent, so JSON is the *only* option. On node 22 (the modern supported Node) `node:sqlite` is present and every leg selected sqlite, leaving the JSON backend unexercised on a sqlite-capable Node and free to drift. New isolated job `json-fallback` (`Test (ubuntu-latest, node 22, JSON fallback)`) in `.github/workflows/ci.yml` mirrors the `macos` shape (checkout@v4 / setup-node@v4 node 22 / `npm install`) and runs `npm run test:unit` with `CHESS_ARCHIVE_FORCE_JSON: 1`. `npm run test:unit` (not `check`) is deliberate: `lint` is already covered by the node-22 `linux` matrix leg, and this leg's only purpose is the unit suites against the forced backend. No `needs:` — independent of `linux`/`browser` (the `browser` job's `needs: [linux]` is untouched). | `CHESS_ARCHIVE_FORCE_JSON=1 npm run test:unit` → exit 0, zero `^FAIL:` lines; the env var is proven live by `test/p3-sqlite-selftest.js`: without it, `PASS: createGameArchive(":memory:") uses SQLite backend`; with it, `PASS: createGameArchive(":memory:") gracefully falls back to JSON when node:sqlite is unavailable` (an ignored var would fail that assertion); workflow parses via `yaml.safe_load`; `npm run lint` exit 0; `about-selftest` 12/12, `reachability-selftest` 49/49, `wave3-hygiene-selftest` 87/87 |

### Honest caveat — what this leg does *not* cover
- `CHESS_ARCHIVE_FORCE_JSON` forces **only the game archive** (`game-archive.js`). `src/accounts.js`, `src/social-store.js` and `src/study-store.js` accept a per-constructor `options.forceJson` but expose **no env-level force switch**, so on node 22 they keep using sqlite and their JSON adapters are **still exercised only on the node-20 leg**. This job therefore closes the *game-archive* JSON-on-modern-Node gap, not a universal one. Wiring env hooks into the other three stores would be the follow-up to give this leg full coverage.

### Reproduce locally
```bash
# Node must HAVE node:sqlite for this to be the meaningful case (22+ / v26 here).
CHESS_ARCHIVE_FORCE_JSON=1 npm run test:unit   # expect exit 0, zero ^FAIL:

# Prove the flag actually flips the backend (without the flag → sqlite; with it → JSON):
node test/p3-sqlite-selftest.js
CHESS_ARCHIVE_FORCE_JSON=1 node test/p3-sqlite-selftest.js
```
The suite computes `hasSqlite` itself (`test/p3-sqlite-selftest.js:31-46`) and asserts `backendType === 'json'` under the flag — so a silently ignored env var turns the suite red rather than passing a rubber stamp.

---

## 18. FIX — Study create→list flake in the new browser job (branch `fix/study-create-flake`, 2026-09-20)

| Task | Owner | Branch | Status | Summary | Evidence |
| --- | --- | --- | --- | --- | --- |
| `fix-study-create-flake` | builder | `fix/study-create-flake` | DONE | CI run **35501617040** — the **first** real run of the `browser` job landed by §16 — failed on `ubuntu-latest`/node 22 at `scripts/test-ui-features.mjs:546` (`created Study chapter did not appear in the list`). Root cause is a **client stale-response race**, not a server bug. `src/ui-study.js` `mount()` calls `loadChapters()` **and** `show()` calls `loadChapters()` again, so the first `#/study` navigation fires **two concurrent list GETs with no `study_player` cookie**; the server's `viewerOf` (`src/routes-study.js:80`) mints a fresh anon id and `Set-Cookie` on each. `createChapter()` fired the `POST` and a non-awaited, unguarded `loadChapters()`; the two slow, **cookie-less/empty** GET responses could resolve **after** the POST's fresh cookie-bearing refresh and clobber the list back to zero (`rows 1 → 0`). The fixed `700 ms` sleep only widened the window on a cold runner (the run also cold-imported 8,861 puzzles). Fix: (1) an optimistic insert of the returned `res.chapter` into `state.chapters` + re-render, (2) a monotonic `listSeq` sequence guard that discards any superseded (stale) response, and (3) `listPromise` de-dupes the `mount()`/`show()` double GET so first contact mints **one** guest identity. The browser assertion now uses a bounded 5 s / 50 ms `waitForFunction` for the created title (still requires the real row — not weakened), a bounded wait for the viewer, and a bounded wait for the server-validated quiz reply. | Reproduced deterministically with a Playwright `route.fulfill` probe holding the two first-contact list-GET responses 2.5 s: old code `t+2400 ms rows=0 text="No chapters yet."` after `POST 201` + fresh `GET 200`; fixed code `rows=1` throughout. POST/GET/cookie evidence verbatim below. Full `npm run test:browser` **3×** under the exact CI env block → all exit 0. `t0-deadcode` 27/0, `wave3-hygiene` 87, `reachability` 49/49, `about` 12, `study-chapters` 17/17, `npm run lint` exit 0 |
| `study-create-list-regression-guard` | builder | `fix/study-create-flake` | DONE | Coverage is the **browser step** (`scripts/test-ui-features.mjs` Study block): it polls for the row for the exact created title and for the viewer/quiz reply, so a regression that loses the row after create fails the journey. The assertion is title-authoritative — a missing created title **throws** regardless of any pre-existing rows (proven by mutation: pre-seeded `PREEXISTING ROW` + a no-op `createChapter()` → step exits 1 with `created Study chapter did not appear in the list (list: "PREEXISTING ROW…")`). The server-side identity scoping already has deterministic Node coverage in `test/study-chapters-selftest.js` (`M1: a different anon cookie cannot read, delete or un-quiz another guest’s chapter; the same cookie can`, and `ownership: signed-in chapters are scoped…`), which is why the defect was provably **client-side** — both GETs in the failing pair carried no cookie and were served the same empty guest view by a correct server. | Mutation proof (title never appears → step FAILS); `test/study-chapters-selftest.js` → 17 passed, 0 failed; `about-selftest` still 12/12 (no About/unit-suite count change: this branch adds **no** new `test/*-selftest.js`) |

### Root cause, with captured evidence

A Playwright probe (in `/tmp`, deleted after) intercepted `**/api/study*`, let the request reach the server, then held the **response** of the first two (cookie-less) list GETs. The server correctly minted a cookie and an empty guest list for each; holding those responses until after the create flow's fresh refresh reproduced the exact CI symptom — the new row was rendered, then **vanished**:

```
[hold #1] server minted 1gpKZrhrXID0IgFT; Path=/; H; body has 0 chapters; holding 2500ms
[hold #2] server minted iNLbpIw0rmbPxNc-; Path=/; H; body has 0 chapters; holding 2500ms
REQ  GET /api/study cookie=NONE
REQ  GET /api/study cookie=NONE
REQ  POST /api/study cookie=study_player=1gpKZrhrXID0IgFT     ← POST got the cookie from held-GET#1
RESP POST 201
REQ  GET /api/study cookie=study_player=1gpKZrhrXID0IgFT       ← fresh refresh, returns the chapter
RESP GET 200
t+150ms … rows=1
[hold #1] releasing now
[hold #2] releasing now
t+2400ms rows=0 text="No chapters yet. Create one on the left."   ← stale empty GET clobbered it
```

`POST /api/study` returned **201** with the chapter and the fresh `GET` returned it; the failure is therefore **not** server-side ownership, and **not** merely "the 700 ms sleep was too short" — a longer sleep alone would still lose the race. Class: **(a)/(b) combined — a client timing race over an identity/ordering race** (the stale requests were cookie-less because two concurrent first-contact GETs raced the cookie). With the fix applied the same probe stays `rows=1` at every sample across the release (verified `t+150 ms … t+5400 ms`), and reverting only `src/ui-study.js` with `git stash` restores `rows=0`.

### Exact edits
- `src/ui-study.js` — extracted `renderChapterList()`; added `listSeq`/`listPromise`; `loadChapters({force})` now de-dupes concurrent calls, force-refreshes after create, and **discards any response whose `seq !== listSeq`**; `createChapter()` optimistically inserts `res.chapter` before the guarded refresh. A 15 s wedge timer releases `listPromise` if a fetch never settles, so the dedupe guard cannot permanently disable later (Refresh) loads. No inline handlers added (Gate 4 / CSP unchanged; the `#board`-vs-`#study-board` split is untouched).
- `scripts/test-ui-features.mjs` — replaced the `waitForTimeout(700)` + one-shot count with a bounded `waitForFunction` (5 s, 50 ms) keyed on the created title. The authoritative check is "a row whose text includes the created title": the success path may still count rows, but on timeout the step **throws** `created Study chapter did not appear in the list` (with the current list text for diagnosis) and does **not** fall back to counting arbitrary rows — so a pre-existing row plus a no-op create cannot satisfy it. Bounded waits for the viewer panel and for the quiz reply (`guessMoves===1 && quizFen!==quizFenBefore`) were added; both still fail if the viewer/reply never arrives.
- `HANDOVER.md` §18, `docs/06-world-class-roadmap.md` B18, `docs/kanban-tasks.json` card `fix-study-create-flake`.

### Reproduce locally
```bash
# CI-shaped env block (all runtime state under a mktemp -d), then:
CHESS_PORT=39281 CHESS_RATE_LIMIT=100000 npm run test:browser   # expect exit 0 + Study PASS line

# Prove the race (old code loses the row, fixed code keeps it): re-run the
# response-holding probe described above against `#/study`.
```
No Node-22-only failure was reproduced locally (see "could not verify"); the race is Node-version-independent and was reproduced deterministically on node 26.8.2.

## 19. FIX — Seat-badge flake in the browser job (branch `fix/browser-seat-badge-flake`, 2026-09-20)

| Task | Owner | Branch | Status | Summary | Evidence |
| --- | --- | --- | --- | --- | --- |
| `fix-browser-seat-badge-flake` | builder | `fix/browser-seat-badge-flake` | DONE | CI run **35504521830** (the `fix/study-create-flake` push) had every non-browser job green but the `browser` job failed fast (30 s) at `scripts/test-ui-features.mjs:145` with `Expected seat badge to show Playing White, got: Seated: Black`. Root cause is the **same class** as §18 — a fixed sleep racing an async round-trip, **not** a seat-auth bug. The step selects bot colour `white` (so the human takes black; badge `Seated: Black`), then selects `black` (so the human must take white). The `bot-select` `change` handler calls `sendBotConfigUpdate()` (`src/ui.js`), which is serialised on `botConfigChain` and runs `POST /api/bot` → `await leaveSeat()` → `await claimSeat('white')`; the badge text is written by `updateSeatUI()` (`src/ui.js:2472-2492`, values `Seated: White` / `Seated: Black` / `Unseated`). A fixed `waitForTimeout(500)` could therefore read the **stale** `Seated: Black` on a loaded runner. Fix: replace the sleep with a bounded `waitForFunction` polling `#seat-badge` for `White` (5 s, 50 ms; the catch throws with the current badge text), and replace the `waitForTimeout(600)` after the `#new-game` click with a bounded wait on `#command-status` settling to `data-state` success/error on the `Starting new game` label plus an explicit error throw. | Mutation proof: pointing the new wait at a never-appearing string fails with the real badge text (`Seat badge never showed Playing White (got: Seated: White)`, exit 1) while the repo stays untouched. Full `npm run test:browser` under the exact CI env block **9/9 isolated runs PASS** on fresh temp dirs, each printing `Seat badge in bot mode: Seated: White` plus every sentinel. Gates `t0-deadcode` 27/0, `wave3-hygiene` 87, `reachability` 49/49, `about` 12, `npm run lint` 0. Only `scripts/test-ui-features.mjs` changed. |

### Exact edits
- `scripts/test-ui-features.mjs` — the fixed `waitForTimeout(500)` before the `#seat-badge` read became a bounded `page.waitForFunction` polling the badge for `White`; the fixed `waitForTimeout(600)` after the `#new-game` click became a bounded wait on `#command-status` reaching `data-state` `success`/`error` on the `Starting new game` label, followed by an explicit `error` throw. The subsequent authoritative assertion still requires `White`, so the step cannot pass on a stale badge. No other sleeps in the file were touched.
- `HANDOVER.md` §19, `docs/06-world-class-roadmap.md` B19, `docs/kanban-tasks.json` card `fix-browser-seat-badge-flake`.

### Known follow-up (filed separately, out of scope here)
The tester stress found a **separate pre-existing** flake in the same browser script: the undo-request block does a fixed `waitForTimeout(300)` before sending `e2e4`, which can 400 `illegal move` when it is Black to move; and the script's top-level `.catch` calls `process.exit(1)` **before** `serverProc.kill()`, leaking a `node server.js` still holding `:39281` (the next run then logs `Server already running.` and cascades). Tracked by the kanban card `fix-undo-browser-flake` (branch `fix/undo-browser-flake`).

### Reproduce locally
```bash
# CI-shaped env block (all runtime state under a mktemp -d), then:
CHESS_PORT=39281 CHESS_RATE_LIMIT=100000 npm run test:browser   # expect exit 0 + "Seat badge in bot mode: Seated: White"
```
The race is Node-version-independent; the real ubuntu/node-22 runner was not reproduced locally (see "could not verify" in the review/tester reports).

## 20. FIX — Undo-request browser flake + server leak (branch `fix/undo-browser-flake`, 2026-09-20)

| Task | Owner | Branch | Status | Summary | Evidence |
| --- | --- | --- | --- | --- | --- |
| `fix-undo-browser-flake` | builder | `fix/undo-browser-flake` | DONE | Two real defects in `scripts/test-ui-features.mjs`, both surfaced by the CI `browser` job (B16). **Defect 1 — fixed sleep races the page's view of the reset:** the G4 undo-request block `await`s `POST /api/reset` inside `page.evaluate` (so the command IS applied), then waited a fixed `200 ms` before claiming seats and sending `e2e4`/`e7e5`. The residual race is the **page** learning about the fresh position via its own state poll: if it has not yet re-rendered, the room is still at the previous position with **Black** to move, so `e2e4` was illegal, the server answered `400 POST /api/move … "error":"illegal move","moveStr":"e2e4"`, and the console-error gate (`if (consoleErrors.length > 0) throw`) failed the whole run. A second fixed `300 ms` sleep then raced the same poll for the two moves. Fix: a **Node-side bounded poll** (5 s deadline, 50 ms `page.waitForTimeout` sleeps) that `await`s a real `page.evaluate(() => fetch('/api/state…))` Promise and checks `history.length===0 && board.turn==='white' && gameOver!==true`; on deadline it throws with the last `/api/state` snapshot. (It is deliberately NOT `page.waitForFunction(async …)`: Playwright does not await an async predicate — a returned Promise is always-truthy, so that shape resolves on the first poll and gates nothing; the previous round's async predicate was exactly that fail-open rubber stamp.) After the two token moves, a genuine synchronous `page.waitForFunction(() => window.getLivePly() === 2)` (throw-on-timeout reports the real ply). **Defect 2 — leaked server on failure:** the top-level `testUiFeatures().catch(err => { … process.exit(1) })` exited **before** `serverProc.kill()`, so any failure leaked a `node server.js` holding `:39281`; the next run logged `Server already running.` and cascaded. Fix: a shared idempotent `teardown()` (kills `serverProc` via SIGTERM and closes the browser, each in try/catch) hoisted to module scope, called on **both** the success and failure paths before `process.exit`. No assertion was weakened: the block still requires 2 plies before the request, 2 after decline, and exactly 1 after accept. | Gate mutation-proven on a `/tmp` copy: changing the reset predicate to an impossible `board.turn === 'black'` now makes the run FAIL at the reset wait with the descriptive error (exit 1) — with the previous round's async `waitForFunction` the identical mutation exited 0, which is the fail-open contrast. Leak mutation-proven on a `/tmp` copy with a deliberate early throw: the spawned server is reaped and `:39281` is free (exit 1), whereas the old shape left it listening. Full `npm run test:browser` under the exact CI env block passes repeatedly on fresh `mktemp -d` dirs, both sentinels plus both undo PASS lines. Gates `t0-deadcode`, `wave3-hygiene`, `reachability`, `about`, `npm run lint` all 0. Only `scripts/test-ui-features.mjs` changed. |

### Exact edits
- `scripts/test-ui-features.mjs` — after the undo-test `/api/reset` POST (which was and is `await`ed inside `page.evaluate`), the fixed `waitForTimeout(200)` became a **Node-side bounded poll**: a `for(;;)` loop with a `Date.now()+5000` deadline that `await`s `page.evaluate(() => fetch('/api/state'+q, {cache:'no-store'}).then(r => r.ok ? r.json() : null).catch(() => null))` and requires `Array.isArray(history) && history.length === 0 && board && board.turn === 'white' && gameOver !== true`, sleeping `page.waitForTimeout(50)` between polls and throwing a descriptive error (with the last snapshot) on deadline. This replaced the previous round's `page.waitForFunction(async () => …)`, which Playwright does not await (a returned Promise is always truthy) and which therefore resolved on the first poll. After the two token-authenticated plies (`e2e4`, `e7e5`), the fixed `waitForTimeout(300)` became a genuine synchronous `page.waitForFunction(() => window.getLivePly() === 2, …, {timeout:5000, polling:50})` whose `.catch` throws with the real ply; the authoritative `undoPlyBefore !== 2` assertion was kept. For the leak, `serverProc` and `browser` were hoisted to module scope and a shared idempotent `teardown()` added (SIGTERM the server if present, `await browser.close()` if open, both try/catch); the success path closes the browser and logs its sentinel, and the top-level `testUiFeatures().then(...)/.catch(...)` now `await teardown()` before `process.exit(0|1)`.
- `HANDOVER.md` §20, `docs/06-world-class-roadmap.md` B20, `docs/kanban-tasks.json` card `fix-undo-browser-flake`.

### Note
The fixed sleeps that were **not** part of the reset→moves synchronization (e.g. the `waitForTimeout(500)` after declining, `waitForTimeout(600)` after accepting, and the other unrelated sleeps in the file) were left alone per scope. The new waits synchronize on real readiness, not elapsed time; the console-error gate is unchanged, so a stray 400 would still fail the run — the fix removes the race that produced it.

### Reproduce locally
```bash
# CI-shaped env block (all runtime state under a mktemp -d), then:
CHESS_PORT=39281 CHESS_RATE_LIMIT=100000 npm run test:browser   # expect exit 0 + both undo PASS lines
# Leak demonstration (never edit the repo to force a failure): copy the script
# to /tmp, insert a deliberate early throw after the server spawns, run it, then
# confirm the spawned `node server.js` is gone and `:39281` is free.
```

## 21. FIX — Bot-config race left the human on the wrong seat (branch `fix/bot-config-race`, 2026-09-20)

| Task | Owner | Branch | Status | Summary | Evidence |
| --- | --- | --- | --- | --- | --- |
| `fix-bot-config-race` | builder | `fix/bot-config-race` | DONE | The CI `browser` job failed at `scripts/test-ui-features.mjs:150` with `Seat badge never showed Playing White (got: Seated: Black)`; the badge held `Seated: Black` for the **entire** 5 s bounded wait, so this was **not** slowness — the seat swap genuinely never completed. This is the same failure the §19 "fix" addressed, which means §19 only masked a deeper product bug. Reproduced locally with CDP `Emulation.setCPUThrottlingRate` rate 15 on a Playwright probe running the exact gesture (`levelSelect 4` → `colorSelect white` → `levelSelect 7` → `colorSelect black` → toggle on): the server ended with the bot on white and the human on black, i.e. the inverse of the test's (correct) expectation. Two compounding defects in `src/ui.js`. **Defect 1 — stale config read at execution time:** `sendBotConfigUpdateNow()` re-read the live DOM (`colorSelect.value`, `levelSelect.value`, `toggle.checked`) when it finally ran, but it is queued on `botConfigChain`; by then the DOM already held a *newer* selection, so it POSTed the stale colour and then claimed the wrong human seat (`humanColor = color === 'black' ? 'white' : 'black'`). Captured `POST /api/bot` bodies (user last selected black) included repeated `{"enabled":true,"level":7,"color":"white"}`. **Defect 2 — stale response clobbers newer input:** `updateBotUI(data)` wrote every `/api/bot` response back into the user-editable fields (`toggle.checked`, `levelSelect.value`, `colorSelect.value`), guarded only by `document.activeElement !== field`; a slow response for an older request therefore overwrote the user's newer selection. This is a REAL product bug: a user quickly changing bot colour/level on a slow connection ends up on the wrong seat. **Fix:** `sendBotConfigUpdate()` now reads the DOM **once, synchronously, at gesture time** and passes that immutable snapshot into the queued `sendBotConfigUpdateNow(snapshot)`, which never re-reads the DOM; and `updateBotUI(botConfig, {applyControls=false})` no longer writes user-editable fields from a response by default — the DOM is the source of truth for the controls, while `bot.status` (badge) and seat state remain server-authoritative. `fetchBotConfig()` passes `applyControls: true` (gated by a `botControlsTouched` flag) so initial page load still populates the controls. The `leaveSeat()` → `claimSeat(humanColor)` serialisation is unchanged. Gate-4 clean (no `makeMove`/`createInitialBoard`/`historyToSan`), no inline handlers. | CDP-throttled exact-gesture probe at rates **10/15/20/30, 3 runs each: all PASS after the fix** (`Seated: White`, botColor `black`); the original code FAILED **17 of 20** runs (`Seated: Black`, botColor white/black). Isolation probes (each defect is separately load-bearing; in the bare badge probe the two defects partially mask each other): a latency-injected 2400 ms **fidelity** probe shows the four `POST /api/bot` bodies now match the four gestures exactly (`[4/black, 4/white, 7/white, 7/black]`) whereas the original sent a stale tail (observed patterns included `[4/black, 4/black, 4/black, 4/black]`, `[…, 7/white, 7/white]`, and `[…, 7/black, 7/black]` — the exact repeat is timing-dependent); a 600 ms route-delay **guard** probe shows a slow older response no longer clobbers the newer DOM selection (original `domColor` clobbered to `white`; reverting only the guard reproduces it). `npm run test:browser` under the exact CI env block passed **twice** (exit 0, both sentinels, `Seat badge in bot mode: Seated: White`). Gates: `node --check src/ui.js` 0, `t0-deadcode` 27/0, `wave3-hygiene` 87, `reachability` 49/49 KNOWN_DARK 10, `about` 12, `npm run lint` 0, `npm run test:unit` exit 0 with `grep -c '^FAIL:'` = 0. Only `src/ui.js` changed. |

### Root cause

`sendBotConfigUpdate()` queues work on `botConfigChain` (`src/ui.js`). The old `sendBotConfigUpdateNow()` took **no arguments** and read `#bot-toggle` / `#bot-level-select` / `#bot-color-select` at *execution* time. Under load (or just fast successive gestures) an earlier queued call runs after a later `change` event has already updated the DOM, so it POSTs the newer colour while its caller intended the older one. Because the following seat swap derives the human colour from the same (now stale) value, the human is seated opposite the *wrong* bot colour. Compounding it, `updateBotUI()` echoed the server response into the controls for every response, so an in-flight older response overwrote a newer user selection in the DOM, which then poisoned *subsequent* queued requests too.

### Exact edits

- `src/ui.js` — `sendBotConfigUpdate()` now reads `toggle.checked`, `parseInt(levelSelect.value,10)` and `colorSelect.value` **synchronously, before queueing**, and passes them as a `snapshot` object into `botConfigChain.then(() => sendBotConfigUpdateNow(snapshot))`; it also sets `botControlsTouched = true`.
- `src/ui.js` — `sendBotConfigUpdateNow(snapshot)` destructures `{enabled, level, color}` from the snapshot and no longer touches the DOM; its `POST /api/bot` body and the `humanColor = color === 'black' ? 'white' : 'black'` seat swap both use the snapshot. The `leaveSeat()` → `claimSeat(humanColor)` flow is unchanged.
- `src/ui.js` — `updateBotUI(botConfig, { applyControls = false } = {})`: the three user-editable writes are now gated on `applyControls`; the `bot-status-badge` update stays unconditional (server-authoritative). Rationale for choosing the "stop writing user-editable fields" option over a sequence-tag scheme: the DOM already holds the user's latest intent, so re-asserting a response into the controls can only ever *lose* information; a sequence tag would add state and still have to decide when the DOM wins. This option is smaller and strictly safer.
- `src/ui.js` — new module-scoped `let botControlsTouched = false;` and `fetchBotConfig()` calls `updateBotUI(data.bot, { applyControls: !botControlsTouched })`, so a slow page-load `/api/bot` GET cannot clobber a selection made after it started, while a normal load still populates the controls from the server.
- `HANDOVER.md` §21, `docs/06-world-class-roadmap.md` B21, `docs/kanban-tasks.json` card `fix-bot-config-race`.

### Note

The two defects partially mask each other in the bare seat-badge probe: reverting only the snapshot capture lets `updateBotUI`'s write-back keep the DOM on the *latest* value and the run still passes; reverting only the response guard similarly passes (with the DOM clobbered). The dedicated probes (fidelity: POST bodies; guard: DOM after two rapid gestures with a slow API) isolate each defect and show both are load-bearing. The CI test assertion was **not** weakened — only `src/ui.js` changed; `scripts/test-ui-features.mjs` is untouched.

### Reproduce locally

```bash
# Start the server with all state under a fresh tmpdir, then run a CDP-throttled
# probe in the repo dir (Playwright resolves from ./node_modules):
TMP=$(mktemp -d)
CHESS_PORT=39281 CHESS_RATE_LIMIT=100000 \
  CHESS_STATE_FILE=$TMP/.referee-state.json CHESS_JOURNAL_FILE=$TMP/.referee-journal.jsonl \
  CHESS_DB_FILE=$TMP/games.db CHESS_JSON_ARCHIVE_FILE=$TMP/.games-archive.json \
  CHESS_ACCOUNTS_DB_FILE=$TMP/accounts.db CHESS_ACCOUNTS_JSON_FILE=$TMP/.accounts.json \
  CHESS_SOCIAL_DB_PATH=$TMP/social.db CHESS_SOCIAL_JSON_PATH=$TMP/.social.json \
  CHESS_LEAGUES_DB_PATH=$TMP/leagues.db CHESS_LEAGUES_JSON_PATH=$TMP/.leagues.json \
  CHESS_STUDY_DB_PATH=$TMP/study.db CHESS_STUDY_JSON_PATH=$TMP/.study.json \
  CHESS_RATE_LIMIT_FILE=$TMP/rate-limit.json node server.js &

# Probe gesture (rate >= 15 fails on the pre-fix code, <= 6 passes):
node - <<'JS'
import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const page = await (await b.newContext()).newPage();
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 15 });
await page.goto('http://127.0.0.1:39281/#/play', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.chess-piece');
const level = page.locator('#bot-level-select'), color = page.locator('#bot-color-select'), tog = page.locator('#bot-toggle');
await level.selectOption('4'); await color.selectOption('white');
await level.selectOption('7'); await color.selectOption('black');
if (!await tog.isChecked()) await tog.click();
await page.waitForFunction(() => { const b=document.getElementById('seat-badge'); return b && /White/.test(b.textContent||''); }, undefined, { timeout: 5000, polling: 50 });
console.log('badge:', await page.locator('#seat-badge').textContent()); // expect "Seated: White"
await b.close();
JS

# Full CI-shaped browser run:
CHESS_PORT=39281 CHESS_RATE_LIMIT=100000 npm run test:browser   # expect exit 0 + both sentinels
```

## 22. FIX — History-scrub browser flake: jump raced the client state sync (branch `fix/scrub-live-ply-race`, 2026-09-20)

| Task | Owner | Branch | Status | Summary | Evidence |
| --- | --- | --- | --- | --- | --- |
| `fix-scrub-live-ply-race` | builder | `fix/scrub-live-ply-race` | DONE | The History-Scrubbing block of `scripts/test-ui-features.mjs` ends an otherwise-passing run intermittently on CI: `Testing History Scrubbing DOM Reconcile & Ghost Piece prevention...` is reached, then the ghost assertion throws (`Ghost white queen remained on d1 after jumping to ply 10`). Root cause is the same class as B18/B19/B20 — a fixed sleep racing an async client round-trip, **not** a rendering or referee bug. The ten plies are sent by **awaited** direct `fetch('/api/move')` calls (so the server applies them), but the page only learns of them through its own SSE / `pollReferee` state sync (`src/ui.js`), which lags behind. The old fixed `await page.waitForTimeout(300)` could elapse before all ten plies had landed in the page's `liveHistory`; `jumpToPly(10)` then clamped the target to `liveHistory.length` and fell back to the live board, on which the white queen is still on d1 — so the very next `ghostCheck` read failed. Fix: replace the sleep with a bounded synchronous `page.waitForFunction(n => window.getLivePly() === n, expectedPly, { timeout: 5000, polling: 50 })`, where `expectedPly = testMoves.length`; its `.catch` reads the actual ply and throws `Expected ${expectedPly} plies before history scrubbing, got ${ply}`. The predicate is deliberately synchronous — Playwright does not await an async predicate (a returned Promise is always truthy), the same fail-open shape B20 called out. No assertion was weakened. | Mutation proof on a `/tmp` copy of the script (wait target forced to `999`): the scrub step fails with `Expected 999 plies before history scrubbing, got 10`, exit 1, while the repo file still reads `testMoves.length`. Full `npm run test:browser` under the exact CI env block (all `CHESS_*` state in a fresh `mktemp -d`, `CHESS_PORT=39281`, `CHESS_RATE_LIMIT=100000`) **twice**, fresh temp dir per run: both exit 0 and print `✔ Passed: History scrubbing correctly cleans vacated squares without ghost duplicate pieces`, `SMOKE TEST PASSED…`, and `ALL UI & AI FEATURE TESTS PASSED SUCCESSFULLY with ZERO ERRORS!`; `:39281` free after each. Gates `t0-deadcode` 27/0, `wave3-hygiene` 87, `reachability` 49/49 (KNOWN_DARK 10), `about` 12, `npm run lint` 0. Only `scripts/test-ui-features.mjs` changed. |

### Root cause

The move loop issues `await fetch('/api/move' + q, …)` inside `page.evaluate`, so each command is applied server-side before the loop advances. But the **page** is a separate consumer: it mirrors the referee through SSE plus the `pollReferee` state poll (`src/ui.js`), and its `liveHistory` (read by `getLivePly()`, `src/ui.js:827`, exported at `src/ui.js:3685`) is only as current as the last state it received. The fixed `waitForTimeout(300)` is a bet that ten SSE/poll updates arrive within 300 ms; on a loaded runner they do not. `jumpToPly(10)` clamps its target to `liveHistory.length`, so a short history means the scrubber never advances past the live board (queen still on d1) and the ghost assertion fires. The race is in the **test's synchronization with the page**, not in `jumpToPly` or the diff renderer.

### Exact edits

- `scripts/test-ui-features.mjs` — the fixed `await page.waitForTimeout(300)` after the ten-move loop became a bounded synchronous `page.waitForFunction(n => window.getLivePly() === n, expectedPly, { timeout: 5000, polling: 50 })` with `const expectedPly = testMoves.length;`. Its `.catch` evaluates `window.getLivePly()` and throws `Expected ${expectedPly} plies before history scrubbing, got ${ply}` (falling back to `'(unavailable)'` if the evaluate itself fails). This is the same proven shape as the B20 wait (`window.getLivePly() === 2`).
- `HANDOVER.md` §22, `docs/06-world-class-roadmap.md` B22, `docs/kanban-tasks.json` card `fix-scrub-live-ply-race`.

### Note

The other **unrelated** fixed sleeps in the file (the `waitForTimeout(50)` between moves, the `200` after the reset, the `150`/`200` around the two `jumpToPly` calls, and every sleep outside this block) were left untouched per scope — the fix synchronizes only the one readiness the ghost assertion depends on. The assertion itself (`ghostCheck.d1 !== null`, etc.) is unchanged, so the step still proves the vacated squares are cleaned; the new wait only removes the race that let it observe a not-yet-synced board.

### Reproduce locally
```bash
# CI-shaped env block (all runtime state under a mktemp -d), then:
CHESS_PORT=39281 CHESS_RATE_LIMIT=100000 npm run test:browser   # expect exit 0 + the scrub PASS line
# Mutation proof (never edit the repo): copy the script into the repo dir
# (Playwright resolves only from ./node_modules), force the wait target to 999,
# run it, observe "Expected 999 plies before history scrubbing, got 10" (exit 1),
# then delete the copy and confirm the repo still reads testMoves.length.
```
