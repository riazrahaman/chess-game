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

## TIER 0 — Integrity fixes [KIMI] *(must precede everything; mostly pure wiring)*

- **T0.1 Real engine credibility.** `stockfish-worker.js` is a hand-rolled PST+material
  depth-1 evaluator that identifies as "Stockfish 17 NNUE WASM" — eval bar, multi-PV arrows,
  accuracy %, Brilliant/Blunder labels, and the eval graph all rest on fabricated data, and
  README claims otherwise. Bundle real `stockfish.js`/`stockfish.wasm` (paths already in
  server.js `ALLOWED_FILES`, just missing) behind the existing UCI shim → zero UI changes.
  *Alternative: keep the light engine but relabel honestly ("Beginner engine").*
- **T0.2 Seat auth on all mutations.** Today only `/api/move` checks seat tokens; any observer
  can `/api/reset`, `/api/undo`, `/api/draw`, `/api/resign` a seated game. Add token validation
  to all four routes.
- **T0.3 Seat heartbeat from client.** Client never calls `/api/seat/heartbeat`; seats expire
  after 60s idle and open to hijack during long thinks. Add a 30s interval while seated.
- **T0.4 Wire draw rules.** `evaluateDraw`/`claimableDraw` (threefold, 50-move, insufficient
  material, fivefold, 75-move) exist and are tested (`draw-selftest.js`) but never called by
  the referee. Apply on move + add `/api/draw/offer|accept|decline`. *(Subsumes orig B1.)*
- **T0.5 Flag fall.** Timeout is only detected on move submission — a flagged player who stops
  moving never loses. Add `/api/flag` / server-side clock check on state reads.
- **T0.6 Dead-code activation + bug sweep.** Actually invoke `checkRateLimit` (never called;
  gate5 test only greps source); schedule NTP sync (ping badge stuck `--ms`); bound the
  idempotency Map (memory leak); send `cmdId` idempotency keys to dedupe SSE/poll double-apply;
  fix archive "Load onto board" to await/validate each move and respect the room param;
  replace `alert()`s with status-pill errors; stop `viewArchivedGame` from mutating client
  history directly.

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
