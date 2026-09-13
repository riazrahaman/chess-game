# Chess Game — Code Flow & Diagrams

## Command flow (move accepted)
```
User clicks square → Client generates move string e2e4
  Post {gameId, expectedRevision, requestId, cmd: "Move", data: {from:"e2",to:"e4"}}
→ Referee serial queue per game (one producer per game + idempotency check by requestId)
→ Referee applies to Rules → validateLegal(from, to) → makeMove(board, from, to)
  Check clock: decrement mover; award increment capped at CLOCK_START_SECONDS; test flag < 0 ? gameOver=true: flag=color
→ Journal write event {seq, ts, cmd:"MoveApplied", gameId, seqNum, data:{from,to,promo,color}, stateHash(54)}
→ SSE push authoritative snapshot → all browsers converge on same board/clocks/history/terminalState
```

## Render flow (diff-based reconciliation)
```
applyRefereeState(prevBoard, nextBoard): for each square in files 0..7 rows 0..8
  if prevPiece !== nextPiece: updateSquare(pieceGlyphs, pieceSvgPath, pieceColor, squareId, classes);
  else keep old DOM node (no touch = preserves CSS transition for A5 move animation later)
```

## Journal format
JSONL append-only. One object per line. Fields: seqNumber, gameID, tsISO8601UTC, cmdString, payloadObject, stateHashSHA256_abbrev(8). Atomic snapshot on `GameCreated` + every accepted `MoveApplied`. Crash recovery replays journal or restores snapshot at last seqNumber.

## Diagram key (ASCII)
```
Browser (tab1) ───POST───> Referee ──SSE-push───> Browser(tab2); tab2+tab1 converge same ref state
Referee: rules(engine) → validateMove() → journal.append() → stateSnapshot()
```

## State machine (terminal detection)
GameCreated → Ongoing → Checkmate/Stalemate/Draw/Resigned/Flag (terminal). Terminal states are write-once; subsequent commands accepted by /api/move return ok=false error:"game over".
