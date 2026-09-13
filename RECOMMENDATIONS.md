# Chess Game — Improvement Recommendations

*Updated 2026-09-14 with complete implementation and verification across all tiers (Lichess / Chess.com parity benchmark).*

**Hard invariant for every change:** board, clocks, and history are REFEREE-AUTHORITATIVE.
`ui.js` renders from server-reported state only — it must never hold or mutate a local board
or clock (C1/C3). All decorative features (animations, SVG pieces, eval, highlights) are
display-layer and must read, never write.

---

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
- ~~**C5 AI opponent personas with flavor commentary.**~~ — **Done.** Play vs Computer Levels 1–8 with adjustable search depth, blunder rates, human think delays, and flavor chat commentary (`bot-service.js`). Verified in `c5-ai-bot-selftest.js`.
- ~~**C6 Auto post-game report.**~~ — **Done.** Prose storytelling, accuracy breakdown, opening evaluation, turning point swing analysis, endgame performance, and annotated PGN with NAG glyphs and eval comments (`game-report.js`). Verified in `c6-ai-report-selftest.js`.
- ~~**C7 Puzzle generator from your own blunders.**~~ — **Done.** "Retry your mistakes" interactive puzzle mode allowing players to replay positions and find the best move (`#retry-mistakes-section`, `move-review.js`). Verified in `c7-ai-puzzles-selftest.js`.
- ~~**C8 Natural-language / voice move commands.**~~ — **Done.** Spoken move recognition via Web Speech API (`#mic-move-btn`), natural language move parser, and spoken SAN move audio announcements (`accessibility-voice.js`). Verified in `c8-d4-voice-selftest.js`.

## TIER D — Performance & infrastructure *(✅ ALL SHIPPED & VERIFIED ON MAIN)*

- ~~**D1 SSE push**~~ — **Done** (with polling fallback).
- ~~**D2 Diff-based rendering**~~ — **Done**.
- ~~**D3 Engine in Web Worker**~~ — **Done**.
- ~~**D4 Keyboard/ARIA accessibility.**~~ — **Done.** Dedicated Blind Accessibility Mode (`#blind-mode-toggle`, shortcut 'B'), ARIA live region (`#accessibility-announcer`), full 8x8 keyboard grid navigation (Arrows, Enter, Space, Esc), spoken piece & square feedback. Verified in `c8-d4-voice-selftest.js`.
- ~~**D5 Touch/mobile input.**~~ — **Done.** Unified pointer events (`pointerdown`, `pointermove`, `pointerup`, `pointercancel`) for phone/tablet drag-and-drop. Verified in `t1-mobile-visuals-selftest.js`.

---

## Final Status
**100% Complete.** All items across Tier 0, Tier A, Tier B, Tier C, and Tier D have been built, rigorously unit/integration tested, verified for Gate 4 architectural invariants, merged to `main`, and pushed to remote.
