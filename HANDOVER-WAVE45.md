# HANDOVER — Wave 4 & 5 Continuation (from orchestrator to antigravity worker)

## Goal
Finish the remaining items in Wave 4 and all of Wave 5, per RECOMMENDATIONS.md.
Build each item directly (worker harnesses are unreliable), verify, commit on branch
`wave4`, then merge to main and push to GitHub.

## Current state
- Repo: /Users/riazrahaman/Documents/agend-grid/chess-game
- Branch: `wave4` (created from main 770e675). All Wave 4/5 work commits on wave4.
- Working tree CLEAN. Last commit fe41f85 (G2 FEN setup, DONE).
- main head = 770e675 (merge wave3). Remote = github.com/riazrahaman/chess-game.git

## COMPLETED already (do NOT redo)
- Wave 1 (X1-X5), Wave 2 (P1-P4, A2.1, A2.3, A2.6), Wave 3 (S1,S2,S3,M1,M3,M4) — all shipped/merged/pushed.
- Wave 4 DONE: A2.4 (masters-db.js), A2.7 (acpl.js), P6 (puzzle-racer.js),
  AB1/AB2/AB3 (a11y-text-entry.js, a11y-gestures.js, voice-intents.js), G1 (chess960.js),
  G2 (fen-setup.js + referee `setup` command + POST /api/setup).
  Commits: c120029 (a2.4+a2.7), a562fc9 (p6), ecba8c1 (ab1-ab2-ab3), d5615f7 (g1),
  7628898 (g2 fen-setup module), fe41f85 (g2 referee setup command + route).

## REMAINING (build in this order)

### Wave 4 (2 remaining)
1. **G3 Time-control completeness** — spec line 123: custom per-color clocks,
   increment presets >15s, simple delay (Bronstein optional), odds games, and
   lichess TC label formula `initial + 40·increment` → UltraBullet/Bullet/Blitz/
   Rapid/Classical for archive/search tagging. New module time-control.js +
   time-control-selftest.js. Extend referee _cmdSetTimeControl for per-color.

2. **A2.5 Tablebase (online probe)** — spec line 115: probe `tablebase.lichess.ovh`
   (7-piece WDL/DTZ per FEN, one fetch). Offline: graceful fallback to engine
   eval. New module tablebase.js + tablebase-selftest.js (mock/stub the fetch —
   no real network in tests; verify the URL + parse + fallback path).

### Wave 5 (9 remaining)
4. S4 Arena tournaments (arena.js) — pairing queue, streak ×2 scoring, berserk.
5. S5 Social graph lite (social-graph.js) — friends, game-share links, spectator discovery.
6. S6 Chat upgrades (chat-upgrades.js) — emoji/reactions, whisper/DM, moderation.
7. S7 Correspondence mode (correspondence.js) — multi-day TC, conditional premoves.
8. V1 Personality bots (personality-bots.js) — names/avatars/openings/play styles.
9. V2 Annotated-POV exports (pov-export.js) — post-game summary card as image/SVG.
10. V3 Embeddable game viewer (embed-viewer.js) — iframe widget rendering PGN.
11. V4 Variants (variants.js) — Crazyhouse/KOTH/Three-Check scaffolding.
12. M2 i18n layer (i18n.js) — extract hardcoded English into strings module.

## CRITICAL CONVENTIONS (follow exactly)
1. Every feature ships a matching `*-selftest.js` using the harness:
   `let passed=0; function test(name,fn){fn();passed++;console.log('PASS: '+name);}`
   + `console.log('\nAll N tests passed successfully!')`, exits non-zero on assert fail.
2. Wire into package.json: `test:unit` string append `&& node <x>-selftest.js`;
   `lint` string append `&& node --check <x>.js && node --check <x>-selftest.js`.
   VERIFY with `grep -c <x>-selftest package.json` === 2.
   package.json edits MUST use `python3 - <<'EOF' ... json.dump ... EOF` then
   `printf '\n' >> package.json` (json.dump drops trailing newline).
3. Gate-4: new modules NEVER call makeMove( or createInitialBoard( and never
   require referee-service.js/rules-engine.js/engine.js (analysis-only modules).
   The ONLY exception: G2's fen-setup validation may require chess.js directly,
   NOT the referee. `grep -c "makeMove(\|createInitialBoard(" <file>` must be 0.
4. Determinism: no Math.random (use createSeededRng/Mulberry32).
5. For every new CLIENT module: add to server.js ALLOWED_FILES (~line 300),
   index.html script tag (before ui.js ~line 1194), service-worker.js PRECACHE_ASSETS.
6. Module pattern: IIFE `(function(){'use strict'; ...})()` + `if(typeof module!=='undefined') module.exports=Mod;` + `if(typeof window!=='undefined') window.Mod=Mod;`.
7. Verify each: `node <x>-selftest.js` (all pass), `node --check <x>.js` (syntax).
   Full `npm run check` takes 4-5 min (differential 200 games slow) — run in a
   TERMINAL pane with `npm run check 2>&1 | tee /tmp/fullcheck.log` and poll for
   exit, confirm zero `Failed: [1-9]` occurrences. Do NOT use bash `nohup &`
   (bash tool kills background jobs at 120s timeout).

## Codebase reference
- rules-engine.js: chess.js adapter — boardToFen/fenToBoard/create/legalMoves/
  makeMove/isCheck/isCheckmate/isStalemate/evaluateDraw/claimableDraw/san.
- engine.js: in-house engine — createInitialBoard/cloneBoard/getLegalMoves/
  makeMove/isCheck/isCheckmate/getGameStatus/moveToSan/buildPgn.
- referee-service.js: RefereeService (single source of truth). `_dispatch` switch
  at ~line 518; command types move/undo/resign/draw/time-control/rematch/reset.
  `_journalAndSnapshot(type,args,moveTs)` is the mutation choke-point (emits SSE).
  `newGame(tc)` at line 64 builds initial state. `stateView(s)` at 282.
- server.js: routes /api/state /api/move /api/reset /api/events etc. ALLOWED_FILES
  Set ~line 300. `handleQueueCommand` ~line 600 wraps referee commands.
- game-archive.js: GameArchive (SQLite games.db + JSON fallback) — saveGame/
  getGame/listGames/searchGames/saveEval/getEval etc.
- chess.js ^1.4.0 (require('chess.js').Chess) — supports Chess960 (constructor
  takes FEN; `new Chess()` for standard). No bcrypt/passkey (use crypto.scrypt).

## Kanban board (optional, was used earlier; board may be reset/down)
- API http://localhost:4100, auth 'Authorization: Bearer chess-swarm-local'
  + X-Agent-Role + X-Agent-Id headers. If you use it, log each remaining item as
  a task and move BACKLOG→BUILDING→IN_REVIEW→IN_TEST→DONE. If down, skip it.

## Finishing
- After all items: update RECOMMENDATIONS.md (strike-through each Done item),
  update CLAUDE.md (new selftest lines + module bullets),
  `git checkout main && git merge --no-ff wave4`, verify `npm run check` exit 0,
  `git push origin main`.
- brief.html is UNTRACKED — do NOT commit it.

## Model/agent guidance
- You are the continuation worker. Build directly with bash/read/edit/write tools.
- Verify everything yourself before committing (do not trust assumptions).
- Commit per item (or small logical group) with `feat(x): ...` messages.
