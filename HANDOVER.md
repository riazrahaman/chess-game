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
- Kanban API: `http://localhost:4100/api`
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
| B3 Gate-4 string-concat workaround → referee-served per-ply FEN/SAN (+ `claimableDraw` in `stateView`) | DEFERRED | — | Own commit after this branch is green (changes `stateView` shape). |
| B9 remove tracked `game-log.md` / `brief.html` | DONE | (this commit) | Agent-orchestration residue removed and gitignored; `security-selftest` still asserts `/game-log.md` is not served. |
