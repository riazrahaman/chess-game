# Chess Game — Technology Stack & Decisions

## Decision log

### No build step, no framework
Every client file is a plain `<script>` served from an allowlist in `server.js`. Feature modules are IIFEs
that attach one global (`window.X`) and, when useful, `module.exports` for Node tests. Views register with the
hash-routed shell (`src/shell.js`) instead of a router library. Rationale: the app stays debuggable in the
browser as written, deploys as static files + one Node process, and the reachability guard
(`test/reachability-selftest.js`) can reason about `<script>` tags, `ALLOWED_FILES` and `PRECACHE_ASSETS` directly.

### Rules substrate: chess.js (MIT) behind our own referee
`rules-engine.js` adapts chess.js for legality, FEN, SAN, and draw detection (fivefold / 75-move /
insufficient are automatic; threefold / 50-move are claimable, per FIDE). `engine.js` is an in-house move
generator kept for SAN/PGN building and validated against chess.js by a 200-game differential test. The referee
(`referee-service.js`) is the only writer of game state: serialized FIFO command queue, append-only JSONL
journal, atomic snapshot, replay on boot. It also ships per-ply `positions[] = {fen, san, lastMove}` so the
browser never replays moves (Gate 4).

### Engine: vendored Stockfish 19 lite (WASM, GPL-3.0)
`vendor/stockfish/stockfish-19-lite-single.{js,wasm}` (~1.8 MB, 1 MB NNUE compiled in) from
nmrugg/stockfish.js. Chosen over the 99 MB full-net and the multi-threaded builds because it needs no
COOP/COEP headers and precaches in one request. Runs (a) in the browser as a nested Worker under
`src/stockfish-worker.js` (analysis, MultiPV, depth 16 / 1.5 s) with the old PST heuristic as a labelled
fallback, and (b) in Node under `src/engine-server.js` in a `worker_thread` (bots via Skill Level / `UCI_Elo`,
missed-tactic and Insights evaluations, FIFO-serialised, options re-sent per search).

### Transport: SSE push + POST commands, no WebSockets
`GET /api/events` streams authoritative snapshots with monotonic ids and `Last-Event-ID` replay; the client
polls `/api/state` only as a liveness fallback (15 s while SSE is open, 600 ms when it is down). Mutations are
`POST /api/move|resign|draw/*|undo|reset|setup|time-control` carrying a seat token and an idempotency id.

### Persistence: SQLite via `node:sqlite`, JSON fallback
`game-archive.js` (games with owner/source/external id, eval cache, puzzles, puzzle attempts/ratings/reviews,
rating pools, rate limits), `accounts.js` (scrypt accounts + sessions), `social-store.js` (follow/block,
arenas, activity days, streaks, achievements), `leagues-store.js`. Every store degrades to a JSON file when
`node:sqlite` is unavailable, and every store path is overridable by env var so tests run under `os.tmpdir()`.

### Data: open datasets only
`data/openings.tsv` (lichess chess-openings, CC0, 3,810 lines) drives opening names, book continuations and
the L1–L4 bot book; `data/puzzles-sample.csv` (8,861 lichess puzzles, CC0, stratified by rating × theme) seeds
the puzzle tables. Fabricated statistics that earlier versions shipped (opening win-rates, "master game"
counts) were removed rather than replaced.

### Security posture
CSP `script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com/gsi/client` (no `unsafe-eval`, no
inline scripts; `style-src` still allows inline), `worker-src 'self' blob:`, `connect-src` allowlisting Google
Identity and `tablebase.lichess.ovh`, HSTS behind TLS, strict CORS, 8 KB body cap, persistent per-IP rate
limiting, seat tokens on every mutation, server-side verification of puzzle solutions and achievement events,
gzip/brotli + weak ETags for static files, `no-store` for `/api/*`.

## Dependency summary
```
chess.js     ^1.4.0   rules, FEN/SAN/PGN                      MIT       (runtime, server-side only)
playwright   ^1.48    browser suites                           Apache-2  (dev)
eslint       ^9       lint                                      MIT       (dev)
Stockfish 19 lite     vendored WASM, not an npm dependency     GPL-3.0
```
The browser consumes zero third-party packages; everything client-side is this repo's own code plus the
vendored engine.
