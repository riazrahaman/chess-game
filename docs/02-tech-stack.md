# Chess Game — Technology Stack & Justification

## Decision log
### Rules substrate: chess.js (MIT license, BSD-2 compatible core)
Chess.js provides authoritative rules: legal move generation, check/checkmate/stalemate detection, FEN encoding/decode, SAN/PGN notation, perft for verification, and standard terminal-state detection. Replaces the handwritten engine with a battle-tested library while retaining our own referee transport layer. License is MIT which is fully compatible with BSD-2-Clause projects.

### Board rendering: custom SVG over cm-chessboard
Custom SVG avoids any TypeScript/React dependencies and keeps runtime dependency-free. Each square is a native `<svg>` element containing cburnett-style paths. Handles responsive sizing, keyboard focus management, ARIA gridcell roles. cm-chessboard provides a good reference implementation but adds a React peer-dep which our local-first model does not need.

### Communication: SSE (server-sent events) + POST command queue
SSE is unidirectional from server → client: the long-living referee service projects authoritative state snapshots over one persistent connection, guaranteeing all connected browsers converge on the same board and clocks. Commands travel POST only with game ID, expected revision, and request ID for idempotency.

### Persistence: Append-only event journal + atomic snapshot
Each accepted command appends to an immutable journal (e.g., `GameCreated`, `MoveApplied`, `DrawOffered`). The latest journal state is atomically snapshotted at every move. Recovery after crash replays the journal or restores the last snapshot; duplicates and stale commands are detected via expected revision numbers.

## Dependency summary
```
chess.js              0.x     Rules engine (FEN, SAN, perft, moves) - MIT
cm-chessboard         3.x     Reference SVG piece rendering (MIT; ref only not imported at runtime)
sqlite (future)       ^5.x    Multi-game persistence layer (BSD-2-Clause)
```

## Runtime characteristics
- Zero third-party packages consumed by the browser client.
- Server depends only on `chess.js` and Node stdlib.
- WebSocket is excluded until Gate 3 online-play extension to keep initial scope minimal.
