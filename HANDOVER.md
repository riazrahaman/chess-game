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
- `npm run check`: **0 errors across entire codebase**
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
yet (DoD item 4); a 300-ply first missed-tactics request can take ~60 s (serial engine).
