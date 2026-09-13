# Chess Game — Improvement Recommendations

Captured after a deep study of the current implementation (post all-12-tickets).
**Hard invariant for every change:** board, clocks, and history are REFEREE-AUTHORITATIVE.
`ui.js` polls `.referee-state.json` every 600ms and renders from the poll only — it must
never hold or mutate a local board or clock (C1/C3). All decorative features (animations,
SVG pieces, eval, highlights) are display-layer and must read, never write.

Existing endpoints the server exposes: `/api/move`, `/api/reset`, `/api/resign?w|b`,
`/api/draw`, `/api/undo`. Engine exports: legal-move gen, makeMove, isCheck/isCheckmate/
isStalemate/getGameStatus, moveToSan/historyToSan/buildPgn, computeCaptured,
getKingStatus, getBoardRenderOrder, classifySound, serialize/deserializeRefereeState.

---

## TIER A — Look & Feel (highest visual ROI, low risk)
- **A1** SVG piece set (e.g. cburnett) instead of Unicode text glyphs. (pieces are
  currently `textContent` text at ui.js:147 from `pieceGlyphs` map.)
- **A2** Drag-and-drop moves, keeping click-to-move as fallback.
- **A3** Legal-move rendering = dots; captures = ring — not full-square yellow tint.
- **A4** Separate last-move accent from selection/legend (currently one shared
  `.highlight` covers last-move AND selected AND legal targets).
- **A5** Move animation: diff prev/next board (from poll) and animate the moved piece.
  (Requires D2 — board currently redraws all squares via innerHTML each poll.)
- **A6** Dark mode + 2–3 board themes + a colorblind-safe palette.
- **A7** Subtle depth: square gradient, piece drop-shadow, board bevel.
- **A8** Clock ticking animation (tenths under 10s, red low-time flash). Render-only
  interpolation off referee values — never write clocks locally.

## TIER B — Game features (match-grade UX)
- **B1** Draw offer → accept/decline flow; resign confirm dialog (today: instant).
- **B2** Premove — queue a move during opponent's turn; fire it when the referee
  reports our turn.
- **B3** Game replay / history scrubber (step through the game back and forth).
- **B4** Takeback request protocol (request/decline, referee-mediated).
- **B5** Persist completed games + list + reopen/replay them (builds on E5 PGN/copy).
- **B6** Right-click arrow/circle annotations on the board (analysis doodling).

## TIER C — AI-era differentiators
- **C1** In-browser Stockfish.wasm eval bar + best-move/top-line (fully offline, no GPU).
- **C2** "Why?" button — plain-English move explanation from FEN + engine analysis.
- **C3** Move-accuracy labels Brilliant/Best/Good/Inaccuracy/Mistake/Blunder from Δeval
  after each move (the chess.com "brilliant move" experience).
- **C4** Coach mode — light LLM hints on our turn.
- **C5** AI opponent personas with flavor commentary (trash-talk / praise).
- **C6** Auto post-game report — prose, accuracy %, key moments annotated onto the PGN.
- **C7** Puzzle generator from your own blunders ("re-play the move you missed").
- **C8** Natural-language / voice move commands.

## TIER D — Performance & infrastructure
- **D1** Replace 600ms polling with WebSocket/SSE push from the referee (still
  referee-authoritative; push not poll; lower latency, enables live multi-observer).
- **D2** Stop wiping `innerHTML` each render — reconcile/mutate changed squares
  (vDOM-lite). Prereq for A5 and a big perf win.
- **D3** Run Stockfish in a Web Worker (prereq for C1).
- **D4** Keyboard/ARIA accessibility + a blind mode.

---

## Prioritization
Start with **Tier A (A1–A5)** + **D2/D1** (enablers) — biggest visual impact for effort;
keeps the game instantly more legible. Then **C1 + C3** for the AI-era differentiator
(eval bar + brilliant-move labels) before the heavier LLM features.
