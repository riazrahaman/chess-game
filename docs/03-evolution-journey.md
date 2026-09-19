# 03 — Evolution Journey (chess-game)

## Phase 0 — Current Baseline (done ✅)
- Click-to-move board rendered with Unicode glyphs → replaced by SVG cburnett pieces (ticket a1).
- Full-screen innerHTML wipe per render → diff-based reconcile that mutates only changed squares (ticket d2).
- Board, timers, captured-trays, status panel all referee-authoritative: `pollReferee()` reads `.referee-state.json` every 600 ms; the renderer never builds a local board.
- Game rules implemented in-house (`engine.js`): legal moves, castling, en-passant, promotion, check/checkmate/stalemate detection, clock with 15 s increment, flagging on timeout.
- AI-vs-AI referee loop supports underpromotion (Q/R/B/N), resign/draw/san/PGN, undo, localStorage bootstrap.

## Phase 1 — Security & Test Baseline (Gate 0+1)
**Why now:** The current `server.js` serves static files and exposes the raw `.referee-state.json` to every origin (`Access-Control-Allow-Origin: *`). A hostile page can read the game state, send crafted `/api/move` requests, and even hit `resign/draw/undo`. Gate 1 closes these attack surfaces.

**Deliverables:**
- Serve all assets from a single public directory (e.g. `public/`).
- Remove wildcard CORS; lock to trusted origins via X-Origin header validation.
- Strip direct `.referee-state.json` exposure; all board data must go through `/api/state`.
- Add CSRF token + rate limits on write endpoints.
- Body-size caps, structured error JSON (no traceback leaks), security headers (`X-Content-Type-Options`, `Cache-Control: no-store`).

**Tests:** Directory traversal regression, cross-origin mutation regression — both must fail.

## Phase 2 — Rules Authority & Draws (Gate 2)
**Why now:** Our rules engine works for the most common paths but lacks edge cases (50-move, 75-move, threefold repetition, dead-position draw). A public game needs deterministic results.

**Deliverables:**
- Integrate [chess.js](https://github.com/jhlywa/chess.js) as canonical rules substrate.
- Maintain our lightweight engine only for render-only computations that don't affect legality or state mutations.
- Persist FEN at every accepted move; store draw claims in the referee state file.
- Run randomized game differentials (≥500 games per CI run) — chess.js and ours must produce identical SAN/PGN + terminal states.

**Tests:** Perft 1-6 fixtures, 50-move/75-move/threefold/dead-position fixtures, all prior ticket selftests still green.

## Phase 3 — Long-Lived Referee & SSE Clocks (Gate 3)
**Why now:** Each HTTP call re-loads `.referee-state.json` from disk. For concurrent play (e.g. two players in separate tabs, or AI-vs-AI with a clock), we need event-sourced state + live clock updates over SSE.

**Deliverables:**
- Long-lived `referee-service` process managing a serialized command queue per game-ID.
- Every mutation is appended to an append-only journal (JSONL) with revision numbers.
- Atomic snapshot writes (`writeFileSync` → rename — no torn state).
- SSE endpoint publishes clock ticks + move events every 1 s; browsers subscribe instead of polling.
- Duplicate/stale commands detected via revision comparison (idempotent).

**Tests:** Two-browser-concurrent-move, duplicate-command-safety, crash-recovery-from-journal, clock-tick-over-SSE.

## Phase 4 — Playing Experience (Gate 4+5)
**Why now:** The engine and transport are solid; the experience layer is basic but playable. This phase upgrades the board interaction model: drag-and-drop, click-to-select, animations, responsive layouts, keyboard nav, colorblind sets, pre-moves, analysis arrows.

**Deliverables (Tier A+):**
- Drag-and-drop moves with legal-move dots → ring highlights for captures.
- Separate last-move accent vs selected square highlight.
- Move animation (piece slides from A → B using reconciled-DOM node identity).
- Dark mode + board themes (Lightwood, Classic, Slate) + colorblind-safe set.
- Touch gestures for mobile, keyboard nav (arrow keys to move cursor between squares).
- Draw-offer protocol, resign confirmation modal, pre-moves during opponent's turn.

**Tests:** Keyboard-only flow, touch device simulation, narrow-viewport layout, promotion-modal accessibility, reconnect-after-page-refresh.

## Phase 5 — Opponent & Analysis (Gate 5+)
**Why now:** After the game loop is production-decent, we add AI depth so players can train against an engine in-browser without network dependency.

**Deliverables:**
- Engine in a Web Worker. (Phases 5–8 shipped a PST heuristic labelled as Stockfish; the real, vendored Stockfish 19 arrived in Wave 1 — see below.)
- Move accuracy labels: brilliant / best / good / inaccuracy / mistake / blunder mapped to Δeval threshold from Stockfish.
- LLM move explainer (GPT-based or distilled) triggered on selected moves.
- Auto post-game report (prose summary + key moments + PGN annotations).

**Tests:** Engine depth 15+ consistent, accuracy labels match chess.com-style engine output, latency <200 ms for first best-move.

## Evolution Summary

| Phase | Gate(s)      | Key deliverable                          | Status |
|-------|--------------|------------------------------------------|--------|
| 0     | Baseline     | SVG pieces + reconciled DOM render       | Completed ✅ |
| 1     | Gate 0+1     | Security boundary, test baseline         | Completed ✅ |
| 2     | Gate 2       | chess.js rules integration               | Completed ✅ |
| 3     | Gate 3       | Long-lived referee + SSE push            | Completed ✅ |
| 4     | Gate 4       | Playing experience (accessibility, UX)   | Completed ✅ |
| 5     | Gate 5       | Stockfish worker + analysis arrows       | Completed ✅ |
| 6     | Phase 1      | Web Audio soundpack, multi-premoves (1-5 plies), right-click doodling canvas, move tree scrubber | Completed ✅ |
| 7     | Phase 2      | PST heuristic engine (mislabelled Stockfish 17 at the time), Multi-PV arrows, CAPS accuracy review, ECO explorer & SVG graph | Completed ✅ (superseded) |
| 8     | Phase 3      | Cryptographic seat auth (anti-hijack), NTP latency lag compensation, multi-tenant room router (/game/:id), SQLite game archive & PGN library | Completed ✅ |

All gates and roadmap phases pass their exit criteria across 12+ automated test suites with 0 regressions.

## 2026-09 — Audit and Waves 0–3

An independent audit (`docs/06-world-class-roadmap.md`) found that "Done" in the earlier roadmap often meant
"module + selftest exist": 29 of 49 modules were unreachable, no engine binary shipped, zero puzzles were
loaded, and the opening explorer rendered invented win-rates. The work since is organised in waves, each a
feature branch merged to `main` only after the full check and both browser suites pass; per-wave status lives
in `HANDOVER.md` §5–§8 and on the kanban board (`docs/kanban-tasks.json`).

| Wave | Theme | Key deliverables |
|---|---|---|
| 0 | Bugs & truth | audit report; honest bot ratings; pre-game clock, hidden chat, draw-offer UI, poll backoff; `ui-auth.js` 404; gzip/ETag; referee-served per-ply positions (Gate 4 made concatenation-proof); FIDE claimable-draw policy; `reachability-selftest.js` |
| 1 | Real engine | vendored Stockfish 19 lite WASM in the analysis Worker (d16 MultiPV) and in Node for bots (Skill/UCI_Elo ~800–2300); CSP `wasm-unsafe-eval`; engine proof test |
| 2 | Site shell | hash-routed shell + Home onboarding; Play view slimmed + Settings; 8,861 CC0 puzzles with server-verified solving; rating on game end, lobby, leaderboards, arenas, social; Analysis view; lichess chess-openings TSV, fabricated stats deleted; SW no longer caches `/api` |
| 3 | Retention | streaks with slack, achievements, weekly leagues, Insights, Library + lichess/Chess.com import, idle-room GC, `script-src` without `unsafe-inline`, Miss classification + retry loop |

`KNOWN_DARK` went 30 → 11 across Waves 2–3. Next: Wave 4 (training depth — repertoire trainer, Maia-style
human-like opponents, practice curriculum, endgames trainer).
