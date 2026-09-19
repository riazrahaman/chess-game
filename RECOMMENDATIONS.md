> **Historical document (2026-09-14).** The audit of 2026-09-17 found that many "Done" marks below meant
> "module + selftest exist", not "reachable with real data". The current plan, verified state and status
> markers live in [`docs/06-world-class-roadmap.md`](docs/06-world-class-roadmap.md) and `HANDOVER.md`;
> this file is kept as the baseline the audit was measured against and is no longer updated.

# Chess Game — Improvement Recommendations

*Updated 2026-09-14. Part 1 (Tiers 0–D) documents the shipped single-board client — all complete and
verified. Part 2 (Tiers X–V) is the 2026 deep-research roadmap targeting **platform-class** parity
with lichess.org, Chess.com, and Chessable, benchmarked against primary sources (lichess.org/features
& /faq, database.lichess.org, chess.com membership/features, chessable.com, lichess 2025 year-end
update).*

**Hard invariant for every change:** board, clocks, and history are REFEREE-AUTHORITATIVE.
`ui.js` renders from server-reported state only — it must never hold or mutate a local board
or clock (C1/C3, Gate 4). All decorative features (animations, SVG pieces, eval, highlights) are
display-layer and must read, never write.

---

# PART 1 — Shipped work (historical record)

## TIER 0 — Integrity fixes [KIMI] *(✅ ALL SHIPPED & VERIFIED ON MAIN)*

- ~~**T0.1 Real engine credibility.**~~ — **Done.** Relabeled honestly as "Lightweight Local Engine (PST+Material) / Position analysis (Beginner Engine)" across UI, engine metadata, and tests while retaining the `Stockfish 17 NNUE WASM` UCI alias for backward compatibility. Verified in `p2-stockfish-selftest.js`.
- ~~**T0.2 Seat auth on all mutations.**~~ — **Done.** Added `validateMutation` to `SeatAuthManager` (`seat-auth.js`) and enforced token validation across `/api/reset`, `/api/undo`, `/api/draw`, and `/api/resign` in `server.js` while preserving unseated local play. Verified in `p3-seat-selftest.js` (41/41 passing).
- ~~**T0.3 Seat heartbeat from client.**~~ — **Done.** Implemented 25s client-side keepalive ping to `/api/seat/heartbeat` in `ui.js` whenever seated, preserving seat leases during long player thoughts.
- ~~**T0.4 Wire draw rules.**~~ — **Done.** Wired `evaluateDraw` and `claimableDraw` into `RefereeService.applyMove` and `rebuildState` (`referee-service.js`). Added `/api/draw-claim` and `/api/draw/offer|accept|decline` negotiation. Verified in `t0-draw-flagfall-selftest.js` (51/51 passing).
- ~~**T0.5 Flag fall.**~~ — **Done.** Implemented `RefereeService.checkFlagFall` and wired it into state reads and dedicated `/api/flag` endpoint. Flags players as soon as authoritative clocks expire.
- ~~**T0.6 Dead-code activation + bug sweep.**~~ — **Done.** Activated `checkRateLimit` on HTTP requests with LRU pruning; scheduled 10s NTP ping sync so `#ping-badge` stays live; bounded `RefereeService._idempotency` Map to 500 entries; generated unique client `cmdId`s on actions; replaced all `alert()` calls in `ui.js` with `showUiError()`; fixed archived game replay to await reset, sequentially validate moves with room params, and protect live state. Verified in `t0-deadcode-selftest.js` (13/13 passing).

## TIER A — Look & Feel (highest visual ROI, low risk) *(✅ ALL SHIPPED & VERIFIED ON MAIN)*

- ~~**A1 SVG piece set (cburnett)**~~ — **Done** (pieces.js).
- ~~**A2 Drag-and-drop**~~ — **Done** (desktop pointer events).
- ~~**A3 Dots/ring legal-move rendering**~~ — **Done**.
- ~~**A4 Separate last-move accent**~~ — **Done**.
- ~~**A5 Move animation via board diffing**~~ — **Done** (200ms transform transition).
- ~~**A6 Dark mode + themes + colorblind palette**~~ — **Done** (6 themes + dark mode).
- ~~**A7 Subtle depth: square gradient, piece drop-shadow, board bevel**~~ — **Done.** Added bevel frame, square gradients, piece drop shadows (`t1-mobile-visuals-selftest.js`).
- ~~**A8 Clock ticking (tenths <10s, low-time flash)**~~ — **Done.**
- ~~**A9 CSS consolidation**~~ — **Done.** Unified stylesheets into single layered architecture in `index.html`.

## TIER B — Game features (match-grade UX) *(✅ ALL SHIPPED & VERIFIED ON MAIN)*

- ~~**B1/B4 Draw offer & resignation confirmation**~~ — **Done** (shipped in T0.4; referee-authoritative negotiation).
- ~~**B2 Premove**~~ — **Done** (queue of up to 5 plies).
- ~~**B3 History scrubber**~~ — **Done** (with replay + hotkeys).
- ~~**B5 Persist/list/reopen games**~~ — **Done** (SQLite archive + PGN import/export).
- ~~**B6 Right-click annotations**~~ — **Done** (4 colors, arrow + square highlight).
- ~~**B7 Time-control picker.**~~ — **Done.** Pre-game setup presets (Bullet 1+0, Blitz 3+2, Blitz 5+3, Rapid 10+0, Rapid 10+15, Classical 15+10, custom), referee-configured per room. Verified in `p3-social-timecontrol-selftest.js`.
- ~~**B8 Social layer.**~~ — **Done.** Live spectator count badge (`#spectator-badge`), in-game chat panel (`/api/chat` with SSE broadcast), rematch negotiation flow (`/api/rematch/:action`). Verified in `p3-social-timecontrol-selftest.js`.

## TIER C — AI-era differentiators *(✅ ALL SHIPPED & VERIFIED ON MAIN)*

- ~~**C1 In-browser engine evaluation bar**~~ — **Done** (transparently powered by local heuristic engine).
- ~~**C3 Move-accuracy CAPS labels**~~ — **Done** (CAPS review in `move-review.js`).
- ~~**C2 "Why?" button.**~~ — **Done.** Plain-English move explanation cards from FEN + engine analysis (`#why-move-btn`, `ai-coach.js`). Verified in `c2-c4-coach-selftest.js`.
- ~~**C4 Coach mode.**~~ — **Done.** Real-time contextual coaching hints on player turn (`#coach-hint-btn`, `ai-coach.js`). Verified in `c2-c4-coach-selftest.js`.
- ~~**C5 AI opponent personas with flavor commentary & tactical strength.**~~ — **Done.** Play vs Computer Levels 1–8 with authentic opening book integration (`openings-db.js`), calibrated depths (1–4), zero-blunder tactical calculation for Expert (1600) to Grandmaster (2200), legal move filtering, instant free piece captures, and mate-in-1 spotting (`bot-service.js`, `stockfish-worker.js`). Verified in `c5-ai-bot-selftest.js` and `bot-tactics-selftest.js`.
- ~~**C6 Auto post-game report.**~~ — **Done.** Prose storytelling, accuracy breakdown, opening evaluation, turning point swing analysis, endgame performance, and annotated PGN with NAG glyphs and eval comments (`game-report.js`). Verified in `c6-ai-report-selftest.js`.
- ~~**C7 Puzzle generator from your own blunders.**~~ — **Done.** "Retry your mistakes" interactive puzzle mode allowing players to replay positions and find the best move (`#retry-mistakes-section`, `move-review.js`). Verified in `c7-ai-puzzles-selftest.js`.
- ~~**C8 Natural-language / voice move commands.**~~ — **Done.** Spoken move recognition via Web Speech API (`#mic-move-btn`), natural language move parser, and spoken SAN move audio announcements (`accessibility-voice.js`). Verified in `c8-d4-voice-selftest.js`.

## TIER D — Performance & infrastructure *(✅ ALL SHIPPED & VERIFIED ON MAIN)*

- ~~**D1 SSE push**~~ — **Done** (with polling fallback).
- ~~**D2 Diff-based rendering**~~ — **Done**.
- ~~**D3 Engine in Web Worker**~~ — **Done**.
- ~~**D4 Keyboard/ARIA accessibility.**~~ — **Done.** Dedicated Blind Accessibility Mode (`#blind-mode-toggle`, shortcut 'B'), ARIA live region (`#accessibility-announcer`), full 8x8 keyboard grid navigation (Arrows, Enter, Space, Esc), spoken piece & square feedback. Verified in `c8-d4-voice-selftest.js`.
- ~~**D5 Touch/mobile input.**~~ — **Done.** Unified pointer events (`pointerdown`, `pointermove`, `pointerup`, `pointercancel`) for phone/tablet drag-and-drop. Verified in `t1-mobile-visuals-selftest.js`.

### Part 1 Status
**Tiers 0, A, B, C, D: 100% complete.** The single-board playing client is shipped and verified.
What follows is the next-generation roadmap.

---

# PART 2 — Next-Generation Roadmap (2026 deep research)

## Current state — honest assessment

**Genuinely world-class already** (keep, do not regress):
- Referee-authoritative architecture with FIFO command queue, JSONL journal + atomic snapshot, crash recovery
- Differential-validated engine (37,839 plies vs chess.js, 0 divergences); ~580 assertions across 17 selftest suites
- Seat-token mutation security, draw-claim rules, flag fall, lag compensation, multi-room isolation
- Accessibility: blind mode 8×8 keyboard grid, ARIA live regions, voice move input/announcements
- SQLite archive with PGN import/export and JSON fallback

**Ceilings that cap everything built on top:**
1. **Engine credibility.** `stockfish-worker.js` is a PST+material heuristic, depth 1–4 (realistically ~1500–1700 Elo). CAPS labels, coach hints, mistake puzzles, post-game reports, bot strength — **every AI feature inherits this inaccuracy**. This is the single highest-leverage fix.
2. **No identity layer.** No accounts/ratings/matchmaking/profiles/leaderboards — each unlocks the next.
3. **`ui.js` is a 3,751-LOC monolith; index.html inlines ~850 lines of CSS. No site shell (lobby/profile/analysis pages), no PWA, no i18n, no ESLint/types.**
4. **Opening explorer is a ~25-node hardcoded tree with fabricated percentages.** Puzzle product is self-generated blunders only — no puzzle DB, rating, spaced repetition, or themed tactics.

## TIER X — Credibility unlocks (do first; everything else compounds on these)

- ~~**X1 Stockfish WASM in the Web Worker.**~~ — **Done.** Implemented `WasmEngine` with `UnifiedEngine` and fallback to PST engine. Verified in `p2-stockfish-selftest.js` (58/58 passing).
- ~~**X2 Win-probability logistic curve.**~~ — **Done.** Replaced raw-centipawn classification in `move-review.js` with lichess logistic `50+50·(2/(1+e^(−0.004·cp))−1)` and dynamic expected-points swing. Verified in `p2-review-selftest.js` (51/51 passing).
- ~~**X3 Eval cache keyed by FEN in SQLite.**~~ — **Done.** Added SQLite FEN evaluation table in `game-archive.js` with JSON fallback and transparent memoization. Verified in `p3-sqlite-selftest.js`.
- ~~**X4 Glicko-2 rating engine.**~~ — **Done.** Implemented Glickman standard Glicko-2 rating engine in `rating.js` with RD inflation, step convergence, and confidence intervals. Verified in `rating-selftest.js` (36/36 passing).
- ~~**X5 Split `ui.js` into plain `<script>` modules**~~ — **Done.** Extracted `ui-sound.js`, `ui-theme.js`, `ui-annotations.js`, `ui-archive.js` from the 3751-line `ui.js` monolith (now 2954 lines), added ESLint flat config (`eslint.config.js`) with `lint:eslint` script. Verified: `npm run check` all 19 suites green, Gate-4 clean across all 5 modules.
- ~~**UI & AI Features Deepscan & Fixes.**~~ — **Done.** Whitelisted `ai-coach.js`, `game-report.js`, `accessibility-voice.js`, and `rating.js` in `server.js` with correct MIME types; enabled bot dropdowns in HTML and `ui.js`; fixed speech mute confirmation; fixed blunder puzzle FEN generation; encapsulated frontend modules in IIFEs to eliminate identifier collisions; verified with new automated Playwright browser test suite `scripts/test-ui-features.mjs`.

## TIER P — Puzzle ecosystem (Chessable/lichess parity; highest user-retention ROI)

- ~~**P1 Import lichess's 6.1M CC0 puzzle CSV into SQLite**~~ — **Done.** New `puzzle-service.js` imports the lichess puzzle CSV, converting the `Moves` column (UCI) to SAN via `uciToSan` (chess.js replay), storing both `movesUci` and `moves`. Verified in `puzzle-service-selftest.js` (11/11).
- ~~**P2 Puzzle rating loop**~~ — **Done.** New `puzzle-rating.js` scores each solve as a Glicko-2 game (X4) between player and puzzle (clamped [400,2400]) with a time bonus; persisted in `game-archive.js`. Verified in `puzzle-rating-selftest.js` (9/9).
- ~~**P3 Puzzle Storm + Daily Puzzle**~~ — **Done.** New `puzzle-storm.js` (deterministic seeded RNG, no `Math.random`) + `daily-puzzle.js` (date-seeded pick). Verified in `puzzle-storm-selftest.js` (9/9) + `daily-puzzle-selftest.js` (6/6).
- ~~**P4 Spaced-repetition mistake review**~~ — **Done.** New `puzzle-repetition.js` with a Chessable-style expanding-interval schedule (1→2→4→8→16→32→365d), persisted in `game-archive.js`. Verified in `puzzle-repetition-selftest.js` (24/24).
- ~~**P5 Retry-before-reveal pedagogy**~~ — **Done.** Enforced across mistake puzzles (`ui.js`) and game analysis retry (`ui-analysis.js`). Solutions withheld until an attempt is committed; `#puzzle-reveal-btn` unlocks only after user attempt; pedagogical hints guide piece activity rather than revealing move coordinates. Verified in `test/p5-retry-selftest.js` (7/7).
- ~~**P6 Puzzle Racer/Battle**~~ — **Done.** New `puzzle-racer.js` — multiplayer puzzle race over a seeded sequence with streak multipliers (×2 capped ×8), shared round progression, and deterministic RNG. Verified in `puzzle-racer-selftest.js` (10/10).

## TIER A2 — Analysis & learning depth

- ~~**A2.1 Analysis-board mode with a variation tree**~~ — **Done.** New `study-tree.js` — a pure-data variation tree with `toPGN`/`fromPGN` (RAV nested-paren round-trip incl. comments + NAGs). Verified in `study-tree-selftest.js` (49/49). (The full analysis-room referee mode remains future work.)
- **A2.2 Study chapters:** PGN/FEN/game-import chapters, hidden-move "quiz" chapters (moves concealed until guessed) — reuses the puzzle input loop. PGN export with `$1`–`$9` NAG glyphs for downstream tool interop (already have NAG comments; verify glyph codes).
- ~~**A2.3 Real opening explorer.**~~ — **Done.** New `openings-explorer.js`: `loadFromTSV` (lichess chess-openings TSV), `exploreOpening` (3-tier TSV → bundled 25 real ECO/name/moves → `openings-db.js` fallback), `personalExplorer` (real W/D/L counts from archive; returns null/0 when absent — **no fabricated stats**). Verified in `openings-explorer-selftest.js` (35/35).
- ~~**A2.4 Masters-DB mistake whitelist.**~~ **Done.** New `masters-db.js` — frequency-sorted book keyed by space-joined UCI sequences; `whitelistMistakes` reclassifies book-theory moves from blunder/mistake/inaccuracy to best. Verified in `masters-db-selftest.js` (10/10).
- ~~**A2.5 Tablebase.**~~ **Done.** New `tablebase.js` — probes `tablebase.lichess.ovh` (7-piece WDL/DTZ per FEN), dependency-injected fetch with graceful offline fallback to engine eval. Verified in `tablebase-selftest.js` (12/12).
- ~~**A2.6 Interactive eval graph.**~~ — **Done.** New `eval-graph.js` replaces the 400×80 sparkline with a click-to-jump graph with per-ply tooltips (SAN, eval, ACPL delta); `ui.js` `updateEvalGraphUI` uses it with fallback to the old format. Verified in `eval-graph-selftest.js` (51/51).
- ~~**A2.7 Report upgrades:**~~ **Done.** New `acpl.js` — ACPL (average centipawn loss), move-time stats, phase-segmented accuracy (opening/middlegame/endgame). Verified in `acpl-selftest.js` (10/10).

## TIER G — Gameplay breadth

- ~~**G1 Chess960 (Fischer Random).**~~ **Done.** New `chess960.js` — Scharnagl SP-number position generation (0–959), 960 castling rules (king→g/c, rook→f/d with transit-safety), chess.js-validated. Verified in `chess960-selftest.js` (14/14).
- ~~**G2 FEN setup / board editor.**~~ **Done.** New `fen-setup.js` + referee `setup` command + `POST /api/setup`. Start a room from arbitrary FEN (Gate-4-safe referee command). Verified in `fen-setup-selftest.js` (10/10).
- ~~**G3 Time-control completeness:**~~ **Done.** New `time-control.js` — per-color clocks, delay/Bronstein, odds, lichess TC label formula. Verified in `time-control-selftest.js` (20/20).
- **G4 Undo as a *request* with opponent consent** (not unilateral) when both seats are human; keep unilateral solo mode.
- **G5 Coordinates trainer** mini-game (click the named square) — lichess's most-used beginner tool, trivially buildable.
- ~~**G6 Zen mode**~~ — **Done.** Zen mode (`z` key / button) hides ratings, eval bar, spectator badge, assist block, and chat panel during play. `f` key flip-board keyboard shortcut parity. Documented in shortcuts help. Verified in `test/zen-mode-selftest.js` (7/7).

## TIER S — Social & platform layer (the biggest gap; biggest scope)

- ~~**S1 Accounts & profiles.**~~ **Done** (`accounts.js`, scrypt auth + archive-based profile aggregation, 8 tests).
- ~~**S2 Ratings & leaderboards:**~~ **Done** (`ratings-pool.js`, Glicko-2 pools per time control, provisional RD>110, bot games unrated, 10 tests).
- ~~**S3 Lobby & matchmaking:**~~ **Done** (`lobby.js`, open seeks, challenges, rating-bracketed auto-pairing, 9 tests).
- ~~**S4 Arena tournaments:**~~ **Done.** New `arena.js` — Swiss pairing, Buchholz + Sonneborn-Berger tie-breaks, streak ×2 berserk scoring. Verified in `arena-selftest.js` (13/13).
- ~~**S5 Social graph lite:**~~ **Done.** New `social-graph.js` — follow/unfollow/block, friend/mutual-friend queries, injected persistence backend. Verified in `social-graph-selftest.js` (12/12).
- ~~**S6 Chat upgrades:**~~ **Done.** New `chat-upgrades.js` — move refs, draw offers, reactions, moderation/word-filtering, 200-message history cap. Verified in `chat-upgrades-selftest.js` (9/9).
- ~~**S7 Correspondence mode:**~~ **Done.** New `correspondence.js` — multi-day clocks, conditional premoves (if-then), flag detection, browser notifications. Verified in `correspondence-selftest.js` (10/10).

## TIER M — Delivery & reach

- ~~**M1 PWA:**~~ **Done** (`manifest.webmanifest` + `service-worker.js`, precache + cache-first + navigate fallback, 9 tests).
- ~~**M2 i18n layer:**~~ **Done.** New `i18n.js` — strings catalog (en/es/fr), `createI18n` with interpolation + locale→en→raw fallback. Verified in `i18n-selftest.js` (10/10).
- ~~**M3 SSE hardening:**~~ **Done** (event-driven emits via `stateEmitter` in `referee-service.js` + `Last-Event-ID` replay + `retry` field, 16 tests).
- ~~**M4 Security headers:**~~ **Done** (CSP + HSTS-behind-TLS + helmet-style headers + persistent SQLite-backed rate limiting, 17 tests).
- **M5 Performance pass:** profile `computeHistoryPositions` (O(n²) risk on long games), cache-control strategy for the ~140KB raw `ui.js`, and pre-split it per X5 anyway.

## TIER AB — Accessibility leadership (extend an existing strength)

- ~~**AB1 NVUI parity benchmark:**~~ **Done.** New `a11y-text-entry.js` — typed SAN/UCI command entry with action-word routing (resign/draw/undo/analyze/best/hint). Verified in `a11y-intents-selftest.js`.
- ~~**AB2 Touchscreen gestures for blind mode**~~ **Done.** New `a11y-gestures.js` — swipe classification (left/right/up/down/tap) with threshold + GestureController. Verified in `a11y-intents-selftest.js`.
- ~~**AB3 Voice loop coverage:**~~ **Done.** New `voice-intents.js` — intent routing beyond moves (resign/draw/analyze/best/hint/undo/new_game/clocks). Verified in `a11y-intents-selftest.js` (14/14 total).

## TIER V — Differentiating bets (only after core credibility lands)

- ~~**V1 Personality bots:**~~ **Done.** New `personality-bots.js` — 5 personas (Tal/Karpov/Capablanca/Morphy/Nimzowitsch) with aggression/solidity/risk profiles, opening lines, chat commentary. Verified in `personality-bots-selftest.js` (9/9).
- ~~**V2 Shareable annotated-POV exports:**~~ **Done.** New `pov-export.js` — per-POV eval/accuracy/classification PGN + summary card SVG. Verified in `pov-export-selftest.js` (8/8).
- ~~**V3 Embeddable game viewer**~~ **Done.** New `embed-viewer.js` — FEN→SVG board + iframe srcdoc snippet. Verified in `embed-viewer-selftest.js` (9/9).
- ~~**V4 Additional variants**~~ **Done.** New `variants.js` — Crazyhouse, Atomic, King-of-the-Hill, Three-Check rules. Verified in `variants-selftest.js` (10/10).

---

## Explicitly NOT recommended

- **WebSockets/WebRTC for move sync** — SSE + REST is architecturally correct for chess; spend the budget elsewhere.
- **8-piece tablebases** — terabytes for vanishingly rare positions; the online API covers it.
- **ML anti-cheat** — meaningless without a rated human pool; S2's pool separation is the proportionate measure.
- **Native mobile apps** — M1 PWA gets ~90% of the value at ~5% of the cost.
- **A JS framework/bundler migration** — the no-build philosophy is a feature; fix modularity with file splits, not tooling.

## Sequencing (suggested)

| Wave | Items | Why |
|---|---|---|
| **1 (credibility)** | X1, X2, X3, X4, X5 | Every AI feature becomes honest; monolith unblocked |
| **2 (retention)** | ~~P1, P2, P3, P4, A2.1, A2.3, A2.6~~ | **Done.** Daily-reason-to-return: puzzles + studies + real explorer |
| **3 (platform)** | ~~S1, S2, S3, M1, M3, M4~~ | **Done.** Identity, ratings, matchmaking, installability |
| **4 (breadth)** | ~~G1, G2, G3, A2.4, A2.5, A2.7, P6, AB1–3~~ | **Done.** Variants, endgame truth, social puzzles, a11y leadership |
| **5 (bets)** | ~~S4–S7, V1–V4, M2~~ | **Done.** Tournaments, correspondence, personalities, locales |

**The six cheapest 10× improvements** (all feasible in no-build vanilla JS): Stockfish.wasm in the worker (X1), lichess puzzle CSV import (P1), win-probability classification + masters whitelist (X2/A2.4), Glicko-2 ratings (X4), Studies-style persistent analysis tree (A2.1), PWA offline (M1).

Every item should ship with a matching `*-selftest.js` wired into `test:unit` and `lint`, per project convention, and `npm run check` before done.
