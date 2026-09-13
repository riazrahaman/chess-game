# Chess Game — File Inventory

## Server files
engine.js           -- Core chess engine & display helpers (createInitialBoard, getLegalMoves, makeMove, isCheck, getGameStatus, historyToSan, buildPgn)
rules-engine.js     -- Adapter wrapping chess.js for FEN state, move validation, and draw rule evaluation
server.js           -- Static file server + HTTP API (/api/move, /api/reset, /api/resign, /api/draw, /api/undo) + SSE push endpoint (/api/events) + security & rate limiting
referee-service.js  -- In-process serialized command queue, revision control, mtime sync, atomic snapshots, and journal recovery
referee-helper.cjs  -- CLI wrapper (move/parse validate against engine; status/history/render)

## Client files (served by server.js as static assets)
index.html          -- HTML shell + CSS themes, responsive grid, evaluation bar container, SVG analysis arrows, accessibility ARIA landmarks & modals
ui.js               -- Client UI controller: SSE push + poll fallback, diff-based reconcile render, drag-and-drop & touch handling, pre-moves queue, accessibility roving focus, evaluation bar & analysis arrows
pieces.js           -- Inline SVG piece renderer using cburnett vector assets
stockfish-worker.js -- Web Worker position analysis engine (FEN evaluation, centipawn score, and best-move analysis)

## Config / Test Files
package.json            -- npm workspace manifest, scripts (`lint`, `test:unit`, `check`), dependencies (`chess.js`)
engine-selftest.js      -- 159 engine & referee unit/integration tests
pieces-selftest.js      -- 32 SVG piece rendering tests
security-selftest.js    -- 58 path traversal, CORS, body limit, and HTTP header security tests
draw-selftest.js        -- 30 draw policy & claim tests
gate3-selftest.js       -- 114 referee queue, revision, and elapsed clock tests
gate4-selftest.js       -- 43 keyboard, ARIA, modal focus trap, pre-move, and UX tests
gate5-selftest.js       -- 9 Stockfish evaluation worker & API rate-limiting tests
differential-selftest.js -- 200 random game perft differential engine verification suite

## Generated Artifacts at Runtime
.worktrees/             -- Per-task git worktree directories (gitignored)
.referee-state.json     -- Atomic JSON state snapshot file
.referee-journal.jsonl  -- Append-only event journal for crash recovery
