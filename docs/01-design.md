# Chess Game — Design Principles & Target Architecture

## Vision
A polished local-first chess room. One machine hosts multiple saved games and browser tabs without accounts or cloud dependency; state is durable, inspectable, and portable.

## Core principles
- **Single authority.** The referee owns board, clocks, history, terminal state. View code is pure projection — no local mutation of authoritative data.
- **Immutable move transitions.** `makeMove` clones the board before applying a transition, then `getLegalMoves` filters pseudo-legal moves by king safety; the boundary stays explicit.
- **Append-only event journal.** Every accepted command writes one immutable event (e.g. `GameCreated`, `MoveApplied`, `DrawOffered`). Recovery and replay derive from it.
- **Local-first, zero external dependencies at runtime.** Analysis, telemetry, accounts, online play remain optional modules only.
- **Permissive licensing.** BSD-2-Clause chess.js rules substrate + MIT (cm-chessboard if adopted). Avoid GPL sources like Chessground.

## Recommended stack
| Layer | Option | Why |
|-------|--------|-----|
| Rules/notation | `chess.js` (BSD-2) | Mature: FEN, 50/75-move, threefold repetition, dead position, SAN, PGN verbose history |
| Board rendering | Custom SVG or cm-chessboard (MIT) | Permissive; responsive grid + aria roles |
| Transport | SSE push (minimal local), WebSocket only for online play later | One-way authoritative snapshots to browser |
| Persistence | Append-only journal on disk; SQLite at scale (multi-game library) | Atomic snapshot fallback, migration safe |

## Target architecture diagram
```
Browser shell
  ├─ role="grid" accessible board (64 gridcell)
  ├─ clock projection + status rail
  ├─ move list / dialogs / preferences
  └─ Client controller
       ├─ POST versioned commands (gameId, expectedRevision, requestId)
       └─ Subscribe to authoritative snapshots via SSE push channel

Long-lived referee service
  ├─ Per-game serialized command queue (one per game)
  ├─ RulesEngine adapter → chess.js FEN/SAN/terminal detection
  ├─ FIDE/casual policy layer (claims vs auto-draw, dead position)
  ├─ Authoritative clock service (monotonic real elapsed time)
  ├─ Versioned public-state projector + event journaler
  └─ Atomic snapshot + previous-snapshot fallback

Optional workers
  ├─ Stockfish analysis / bot (Web Worker, UCI adapter)
  └─ PGN import/export validation worker
```

## UI design direction
- Warm neutral field, high-contrast board, tabular numerals for clocks, one status accent.
- Wide screen: two-column composition (board + game rail). Narrow screen: active player/clock nearest the board.
- Minimum 24×24px touch target; preserve focus across reconciliation and orientation changes.

# Sources & references
[FIDE Laws of Chess 2023](https://handbook.fide.com/chapter/e012023); [chess.js API docs](https://github.com/jhlywa/chess.js/blob/master/website/docs/index.md); [cm-chessboard (MIT)](https://github.com/shaack/cm-chessboard)
