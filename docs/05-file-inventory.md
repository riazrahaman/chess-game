# Chess Game — Comprehensive File Inventory

## Server Files
- `engine.js` — Core chess engine, board representation, legal move generator, checkmate/stalemate detection, SAN/PGN builders, game-end presentation.
- `rules-engine.js` — Adapter wrapping chess.js for FEN state projections, move validation, and draw rule evaluations.
- `server.js` — HTTP API + static file server + SSE event stream (`/api/events`), security boundary, rate limiting, and player seat routing.
- `referee-service.js` — Long-lived referee with serialized FIFO queue, monotonic revision tracking, event journaling, atomic snapshots, and crash recovery.
- `seat-auth.js` — Cryptographic player seat manager (White, Black, Spectator session tokens) preventing move hijacking.
- `referee-helper.cjs` — CLI referee wrapper for manual state inspection and move parsing.

## Client Files (Served by server.js)
- `index.html` — Semantic HTML5 grid layout, board container, evaluation bar, SVG annotation overlay, move history, opening explorer, evaluation graph, and game review accuracy panel.
- `ui.js` — Main client UI orchestrator: SSE push receiver, move tree scrubber, multi-premove chaining, board doodling, audio playback, haptics, and seat management.
- `pieces.js` — Vector inline SVG chess pieces based on Colin M.L. Burnett's standard chess artwork.
- `stockfish-worker.js` — Web Worker position evaluation engine with UCI protocol support, centipawn scoring, and Multi-PV candidate lines.
- `move-review.js` — CAPS accuracy scoring engine and win-probability move classification (Brilliant, Great, Best, Excellent, Good, Inaccuracy, Mistake, Blunder).
- `openings-db.js` — ECO chess openings database with win/draw rates, popular move recommendations, and interactive SVG advantage graph mathematics.

## Self-Test & Quality Assurance Suites
- `engine-selftest.js` — 159 engine & referee unit/integration verification tests.
- `pieces-selftest.js` — 32 SVG vector piece rendering and color/type validation tests.
- `security-selftest.js` — 58 path traversal, strict CORS, body limits, and header security tests.
- `draw-selftest.js` — 30 draw claim and repetition rule policy tests.
- `gate3-selftest.js` — 114 referee command queue, revision, and elapsed clock tests.
- `gate4-selftest.js` — 43 ARIA grid, keyboard navigation, modal focus traps, and UX tests.
- `gate5-selftest.js` — 9 Stockfish evaluation worker and API rate limiting tests.
- `differential-selftest.js` — 200 random game differential perft test against chess.js (37,800+ plies).
- `p1-audio-selftest.js` — Web Audio API soundpack and mobile haptics tests.
- `p1-premove-selftest.js` — Multi-premove chaining queue and turn execution tests.
- `p1-annotations-selftest.js` — Right-click annotation canvas (colored arrows & circles) tests.
- `p1-scrubber-selftest.js` — Move tree scrubber, keyboard arrow navigation, and history jump tests.
- `p2-stockfish-selftest.js` — Stockfish WASM Web Worker UCI protocol and Multi-PV tests.
- `p2-multipv-selftest.js` — Multi-PV candidate evaluation arrows and breakdown panel tests.
- `p2-review-selftest.js` — Win probability, CAPS accuracy, move classification, and review panel DOM tests.
- `p2-opening-selftest.js` — ECO opening database lookups and SVG evaluation graph tests.
- `p3-seat-selftest.js` — Cryptographic player seat tokens, 409 conflict, and 403 move rejection tests.
- `p3-lag-selftest.js` — NTP-style latency tracking and move transit clock lag compensation tests.

## Runtime Artifacts
- `.referee-state.json` — Atomic referee game state snapshot.
- `.referee-journal.jsonl` — Append-only journal of game events for crash recovery.
- `.worktrees/` — Isolated git worktrees for concurrent feature development.
