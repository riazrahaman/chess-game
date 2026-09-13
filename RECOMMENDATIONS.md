# Chess Game — Improvement Recommendations

*Updated 2026-09-13 with a deep code review + competitive benchmark (Lichess / Chess.com).
Each item is attributed: **[orig]** = original roadmap, **[KIMI]** = added by KIMI's deep review.*

**Hard invariant for every change:** board, clocks, and history are REFEREE-AUTHORITATIVE.
`ui.js` renders from server-reported state only — it must never hold or mutate a local board
or clock (C1/C3). All decorative features (animations, SVG pieces, eval, highlights) are
display-layer and must read, never write.

Existing endpoints the server exposes: `/api/move`, `/api/reset`, `/api/resign?w|b`,
`/api/draw`, `/api/undo`. Engine exports: legal-move gen, makeMove, isCheck/isCheckmate/
isStalemate/getGameStatus, moveToSan/historyToSan/buildPgn, computeCaptured,
getKingStatus, getBoardRenderOrder, classifySound, serialize/deserializeRefereeState.

---

## TIER 0 — Integrity fixes [KIMI] *(✅ ALL SHIPPED & VERIFIED ON MAIN)*

- ~~**T0.1 Real engine credibility.**~~ — **Done.** Relabeled honestly as "Lightweight Local Engine (PST+Material) / Position analysis (Beginner Engine)" across UI, engine metadata, and tests while retaining the `Stockfish 17 NNUE WASM` UCI alias for backward compatibility. Verified in `p2-stockfish-selftest.js`.
- ~~**T0.2 Seat auth on all mutations.**~~ — **Done.** Added `validateMutation` to `SeatAuthManager` (`seat-auth.js`) and enforced token validation across `/api/reset`, `/api/undo`, `/api/draw`, and `/api/resign` in `server.js` while preserving unseated local play. Verified in `p3-seat-selftest.js` (41/41 passing).
- ~~**T0.3 Seat heartbeat from client.**~~ — **Done.** Implemented 25s client-side keepalive ping to `/api/seat/heartbeat` in `ui.js` whenever seated, preserving seat leases during long player thoughts.
- ~~**T0.4 Wire draw rules.**~~ — **Done.** Wired `evaluateDraw` and `claimableDraw` into `RefereeService.applyMove` and `rebuildState` (`referee-service.js`). Added `/api/draw-claim` and `/api/draw/offer|accept|decline` negotiation. Verified in `t0-draw-flagfall-selftest.js` (51/51 passing).
- ~~**T0.5 Flag fall.**~~ — **Done.** Implemented `RefereeService.checkFlagFall` and wired it into state reads and dedicated `/api/flag` endpoint. Flags players as soon as authoritative clocks expire.
- ~~**T0.6 Dead-code activation + bug sweep.**~~ — **Done.** Activated `checkRateLimit` on HTTP requests with LRU pruning; scheduled 10s NTP ping sync so `#ping-badge` stays live; bounded `RefereeService._idempotency` Map to 500 entries; generated unique client `cmdId`s on actions; replaced all `alert()` calls in `ui.js` with `showUiError()`; fixed archived game replay to await reset, sequentially validate moves with room params, and protect live state. Verified in `t0-deadcode-selftest.js` (13/13 passing).

## TIER A — Look & Feel (highest visual ROI, low risk) [orig — ✅ all shipped]

- ~~A1 SVG piece set (cburnett)~~ — done (pieces.js).
- ~~A2 Drag-and-drop~~ — done (desktop; see D5 for touch).
- ~~A3 Dots/ring legal-move rendering~~ — done.
- ~~A4 Separate last-move accent~~ — done.
- ~~A5 Move animation via board diffing~~ — done (200ms transform).
- ~~A6 Dark mode + themes + colorblind palette~~ — done (6 themes).
- **A7 [orig, partially done]** Subtle depth: square gradient, piece drop-shadow, board bevel.
- ~~A8 Clock ticking (tenths <10s, low-time flash)~~ — done.
- **A9 [KIMI]** CSS consolidation: `index.html` carries two stacked stylesheet generations with
  duplicated selectors (`.stats-bar`, eval-bar, multipv rules) — merge into one layer to kill
  specificity surprises.

## TIER B — Game features (match-grade UX)

- ~~B2 Premove~~ — done (queue of 5).
- ~~B3 History scrubber~~ — done (with replay + hotkeys).
- ~~B5 Persist/list/reopen games~~ — done (SQLite archive + PGN import/export).
- ~~B6 Right-click annotations~~ — done (4 colors).
- **B1/B4 [orig → moved to T0]** Draw offer + resign confirm / takeback protocol — integrity
  items now; see T0.4.
- **B7 [KIMI] Time-control picker.** Clocks are hard-coded 10+15. Add pre-game setup
  (Bullet 1+0 / Blitz 3+2 / Rapid 10+0 / custom), referee-configured per room.
- **B8 [KIMI] Social layer.** Spectator seat button + presence list (server endpoints exist,
  client unused), in-game chat panel, rematch negotiation flow.

## TIER C — AI-era differentiators

- ~~C1 In-browser Stockfish eval bar~~ — shipped but fake; **see T0.1** to make it real.
- ~~C3 Move-accuracy labels~~ — shipped but fabricated; becomes truthful after T0.1.
- **C2 [orig]** "Why?" button — plain-English move explanation from FEN + engine analysis.
- **C4 [orig]** Coach mode — light LLM hints on our turn.
- **C5 [orig]** AI opponent personas with flavor commentary. → engine strength presets from
  T0.1 enable **Play vs Computer** levels 1–8 as the baseline (Lichess parity).
- **C6 [orig]** Auto post-game report — prose, accuracy %, key moments annotated onto the PGN.
- **C7 [orig, upgraded KIMI]** Puzzle generator from your own blunders — "retry your mistakes"
  mode: replay from the blundered position until the best move is found (Chess.com's most-loved
  review feature; Lichess "Learn from your mistakes"). Requires real evals (T0.1).
- **C8 [orig]** Natural-language / voice move commands.

## TIER D — Performance & infrastructure

- ~~D1 SSE push~~ — done (with polling fallback).
- ~~D2 Diff-based rendering~~ — done.
- ~~D3 Engine in Web Worker~~ — done (upgrade to real WASM in T0.1).
- **D4 [orig, partially done]** Keyboard/ARIA accessibility — strong already; add a dedicated
  blind/SAN-announcement mode (Lichess pioneered this).
- **D5 [KIMI] Touch/mobile input.** `touchDragState` is dead; no pointer-event handlers — the
  board is unplayable on phones/tablets despite responsive CSS. Add unified pointer events.

---

## Prioritization [KIMI, revised]

1. **Tier 0** — integrity: the app currently overclaims (fake Stockfish, unsafe multiplayer,
   incomplete rules). Small diffs, most code/tests already exist.
2. **T0.1 → C5 baseline** — real engine + strength presets = Play-vs-Computer + truthful
   analysis for free.
3. **B7/B8 + D5** — match-grade play (time controls, chat, mobile input).
4. **C7 (retry-your-mistakes), C6, C2** — the AI-era differentiators, in that order.

*Orig note retained: Tier A + D1/D2 were the right first bets and are shipped; remaining A7/A9
are polish.*
