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

## Site shell and views (Wave 2)
```
index.html loads shell.js → ui-*.js views → ui.js
location.hash "#/puzzles?theme=fork" → Shell.route() → hide other [data-view] sections
  → first visit: view.mount(section, params)   (view builds its own DOM/board inside the section)
  → every visit: view.show(section, params); leaving: view.hide(section)
Views read /api/* (cache:'no-store') and never touch #board or referee state.
<base href="/"> makes href="#/x" a full navigation, so the shell delegates hash-link clicks.
```

## Route modules (Wave 2–3)
```
server.js request → auth/rate-limit/room extraction → built-in game routes
  → routes-puzzles → routes-social → routes-library → routes-retention → routes-insights → routes-review → routes-openings
     (each: handleXRoute(req,res,urlPath,ctx) → true if handled) → 404
```

## Game-over fan-out (Wave 2–3)
```
referee gameOver → referee.onStateChange → rating-hook
  ├─ both seats signed-in humans, no bot, ≥2 plies → Glicko-2 pool update → onRated → { social/arenas, leagues, insights }
  └─ onGameOver (rated or not) → streaks (activity for both signed-in seats) → achievements.evaluate
Puzzle solve/review and analysis batches also record activity; league promotion → first_league_promotion.
```

## Idle-room GC (Wave 3)
```
boot + every CHESS_ROOM_GC_INTERVAL_MS: for each .referee-state-<room>.json (inspect only, never getReferee())
  collectable = idle ≥ CHESS_ROOM_IDLE_MS && no SSE clients && no human seat && no in-flight cmd && (0 plies || gameOver)
  finished + not archived → archive → stop watcher → clear SSE log → drop bot → reset seats → delete files + instance
```
