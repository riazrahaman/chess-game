# ORCHESTRATOR HANDOVER (m0996) — autonomous chess build

You are taking over as ORCHESTRATOR of a multi-agent build loop. Do NOT write feature code yourself — spawn workers, verify, merge.

## REPO
- /Users/riazrahaman/Documents/agend-grid/chess-game (vanilla-JS chess + node server)
- origin https://github.com/riazrahaman/chess-game.git, branch main @ cfeb1e7, pushed.
- Worktrees live under .worktrees/ and .tier-worktrees/ (gitignored). Create per-task: `git worktree add -b feature/<name> .worktrees/<name> main`.

## IN-FLIGHT (act first)
- chess-gate3-elapsed-clocks: BUILDING. Worktree .worktrees/gate3-clocks (branch feature/gate3-clocks). Builder = opencode worker pane-node-c2587410-3f5b-4751-8584-4927466cf845 (elapsed-time clocks in referee-service.js; implementation done, was debugging a leftover process on port 4321 in gate3-selftest). Steps: agentgrid_read_worker_output / wait_for_worker → verify `node gate3-selftest.js` green + all suites → PATCH kanban IN_REVIEW (builder role) → spawn opencode reviewer → IN_TEST → PATCH DONE (tester role) → commit on feature/gate3-clocks → merge --no-ff to main → full gate → push.

## KANBAN CONTRACT
- base http://localhost:4100/api; header `Authorization: Bearer chess-swarm-local`.
- EVERY mutating call needs header `X-Agent-Role: <builder|reviewer|tester>`.
- claim: POST /api/tasks/:id/claim {"agent_id":"ag-builder-<id>"} (auto BACKLOG→BUILDING).
- status: PATCH /api/tasks/:id {"status":"IN_REVIEW"} etc. Transitions walk BACKLOG→BUILDING→IN_REVIEW→IN_TEST→DONE (DONE terminal).
- 30 tasks DONE. Remaining: chess-gate4-accessible-board (dep gate3-elapsed-clocks), chess-gate4-ux-polish, chess-gate5-stockfish-worker, test-gate-debug + test-task-v2 (junk — ignore/leave).

## PER-TASK WORKFLOW (repeat for every task)
1. claim → BUILDING.
2. Spawn builder: agentgrid_spawn_worker harness=opencode model=ollama-cloud/glm-5.2, cwd=fresh worktree. Prompt must state: task spec, C1/C3 invariants (board/clocks/history ONLY from referee state; UI decorations render-only; never mutate locally), run all selftests, PATCH kanban IN_REVIEW (X-Agent-Role: builder), do NOT git commit. If worker returns empty/planning-only output, re-drive via agentgrid_send_to_worker with explicit remaining steps.
3. Verify independently: read diff stat, run selftests in the worktree.
4. Spawn opencode reviewer (same model) for the worktree; reviewer PATCHes IN_TEST (X-Agent-Role: reviewer). Re-drive if it stalls.
5. PATCH DONE with X-Agent-Role: tester (you may do this yourself).
6. Commit on the feature branch (never commit on main directly), merge `--no-ff` into main (conflicts: resolve keeping BOTH sides), delete worktree+branch.
7. Full gate on main (below), then `git push origin main`.

## TEST GATES on main (ALL must pass)
- node engine-selftest.js → 159/159
- node pieces-selftest.js → 32/32
- node security-selftest.js → 58/58
- node draw-selftest.js → 30/30
- node gate3-selftest.js → 57/57 (+ new clock tests after gate3-clocks merges)
- node differential-selftest.js → 200/200 games (37,839 plies; ~3min — bash timeout 240000ms+)
- npm run check (lint + test:unit; test:browser is SKIP-tolerant Playwright smoke)
- node --check on changed files
If a suite is missing/flaky: stale .referee-state.json/.referee-journal.jsonl/.lock files in cwd cause flakiness — tests restore them on exit; retry clean.

## HARNESS LESSONS (important)
- opencode glm-5.2 = RELIABLE workhorse (all builders/reviewers succeeded). Use it.
- antigravity: historically answered read-only prompts but returned EMPTY completions on write actions (unusable for builds). If you try it again, PROBE with a write action (e.g. write /tmp/ag-probe.txt) before trusting it with a build.
- devin: weekly quota exhausted. codex: ~6% headroom, stale — avoid.
- Workers sometimes stall with exit 0 + planning-only output → always verify worktree git status/diff; re-drive with agentgrid_send_to_worker.

## KEY ARCHITECTURE (context)
- referee-authoritative: referee-service.js (in-process; serialized FIFO command queue, monotonic revision, idempotency cache, JSONL journal .referee-journal.jsonl, atomic snapshot .referee-state.json tmp+rename, boot recovery snapshot+journal replay, external-change mtime re-sync). server.js routes all mutations through the queue; GET /api/state + SSE GET /api/events (fs.watchFile, heartbeats).
- rules-engine.js wraps chess.js@^1.4.0 (adapter: boardToFen/fenToBoard/legalMoves/makeMove/isCheck/...); FEN persisted as projection (C1/C3: board stays single source of truth). Draw policy: evaluateDraw (fivefold>75-move>insufficient>threefold>50-move), claimableDraw (threefold/50-move only), /api/draw-claim.
- engine.js: in-house engine (render/history/SAN/PGN/theme helpers/gameEndPresentation). pieces.js: cburnett SVG. ui.js: diff-based reconcile render, SSE+poll fallback, drag-drop, animation, clock-tick interpolation, themes (CSS custom props, [data-theme]/[data-mode=dark]).
- server.js security: path allowlist + traversal/dotfile 403, 8KB body cap, strict CORS via CHESS_ALLOWED_ORIGIN (default localhost:39281+127.0.0.1:39281), nosniff/no-store, structured errors.

## QUEUE AFTER gate3-elapsed-clocks
- chess-gate4-accessible-board: accessible grid + modal contracts, keyboard nav, ARIA, visible pending/reconnect/error states, reduced-motion. Then gate4-ux-polish, then chess-gate5-stockfish-worker (Stockfish WASM in Web Worker, eval bar) — optional/last.
- When ALL planned tasks DONE: report summary. Standing rule: never push kanban-project repo; chess-game pushes are pre-authorized after each merge.

## SERVICES RUNNING
- kanban API :4100 (KANBAN_DATA_FILE=server/tasks.json in agent-kanban-board repo — DO NOT restart casually), chess static :39281 (nohup pid 80755, log /tmp/chess-static.log).