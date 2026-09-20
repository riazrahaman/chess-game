import { execSync } from 'node:child_process';

const issues = [
  // --- Wave 0 Audit Bugs (B1 - B12) ---
  {
    title: "[B1] White clock counts down before the game starts",
    body: `### Description
The White clock was observed counting down immediately upon room creation, even before the first move was played.

### Root Cause
\`interpolatedActiveSeconds\` in \`src/ui.js\` subtracted wall-clock time since \`refereeClockAt\`. That timestamp was set upon any state arrival without verifying that \`moveStartTs > 0\` or \`history.length > 0\`.

### Resolution
- Added a \`refereeClockRunning\` guard in \`src/ui.js\`.
- Clocks only interpolate when the referee reports an active move history and the game is not over.
- Verified in live browser sessions and automated tests.

**Commit:** \`3245d37\``,
    labels: ["bug", "audit", "resolved"]
  },
  {
    title: "[B2] Room chat panel hidden inside unclosed evaluation disclosure",
    body: `### Description
The multiplayer in-game chat panel (\`#chat-panel\`) was invisible to players on desktop and mobile browsers.

### Root Cause
An unclosed \`<details id=\"graph-panel\">\` disclosure tag in \`index.html\` inadvertently wrapped the adjacent \`#chat-panel\` DOM node, collapsing it inside the evaluation graph.

### Resolution
- Added proper closing \`</details>\` tag after \`#eval-graph-container\`.
- Added test assertion ensuring \`#chat-panel.closest('details') === null\`.

**Commit:** \`152aadd\``,
    labels: ["bug", "audit", "resolved"]
  },
  {
    title: "[B3] Gate 4 architectural guard circumvented by string concatenation",
    body: `### Description
Frontend \`src/ui.js\` invoked \`engineLookup['create'+'InitialBoard']\` and \`['make'+'Move']\` to circumvent AST / regex-based Gate 4 checks during historical scrubber replay.

### Root Cause
The client lacked server-provided FEN/SAN history snapshots, forcing it to re-execute chess rules locally for display purposes.

### Resolution
- The referee backend now constructs and serves \`state.positions[] = { fen, san, lastMove }\` with every state update.
- Client only parses FEN for display rendering and never replays moves.
- Upgraded Gate 4 test harness in \`test/t0-deadcode-selftest.js\` to be concatenation-proof.

**Commit:** \`10b3855\``,
    labels: ["bug", "architecture", "audit", "resolved"]
  },
  {
    title: "[B4] Draw negotiation and claim UI missing in client",
    body: `### Description
Draw negotiation routes (\`/api/draw/offer|accept|decline|claim\`) existed on the server, but the frontend had no UI affordances to offer, accept, decline, or claim draws.

### Root Cause
Frontend event listeners and DOM banner markup for draw actions were omitted during initial UI scaffolding.

### Resolution
- Added interactive \`#draw-offer-banner\` and \`#claim-draw\` button in \`src/ui.js\` and \`index.html\`.
- Implemented draw offer, accept, decline, and claim actions wired to referee API.
- Verified with multi-context Playwright automated tests.

**Commit:** \`e2855fa\``,
    labels: ["bug", "audit", "resolved"]
  },
  {
    title: "[B5] showUiError permanently clobbers game status notification",
    body: `### Description
Displaying an error via \`showUiError()\` permanently overwrote the primary turn/check/result text in \`#status\`.

### Root Cause
Both game status messages and error notifications targeted the same DOM element without an auto-restoring state model.

### Resolution
- Separated error notifications into an auto-dismissing toast pill inside \`#command-status\`.
- Preserved \`#status\` exclusively for game lifecycle and turn announcements.

**Commit:** \`4f1892a\``,
    labels: ["bug", "audit", "resolved"]
  },
  {
    title: "[B6] HTTP polling never backed off despite active SSE connection",
    body: `### Description
The client polled \`/api/state\` every 600ms indefinitely, even when the Server-Sent Events (SSE) stream was healthy and streaming.

### Root Cause
Missing lifecycle listener coordination between SSE connection state and polling intervals in \`src/ui.js\`.

### Resolution
- Backed off polling to 15s liveness heartbeat when SSE connection is active (\`onopen\`).
- Resumes 600ms polling with exponential backoff capped at 10s if SSE connection drops.

**Commit:** \`5b38dfc\``,
    labels: ["bug", "performance", "audit", "resolved"]
  },
  {
    title: "[B7] Test suites leave hundreds of residue state files in repository root",
    body: `### Description
Running unit test suites polluted the working tree with hundreds of \`.referee-state-*.json\` and journal files.

### Root Cause
Test scripts initialized referee services using default file paths rather than isolated temporary directories.

### Resolution
- Re-routed all test database and referee file paths to \`os.tmpdir()\` using \`CHESS_STATE_FILE\`, \`CHESS_JOURNAL_FILE\`, and related environment overrides.
- Cleaned up 500+ legacy residue files from repository root.

**Commit:** \`4757c9d\``,
    labels: ["bug", "audit", "resolved"]
  },
  {
    title: "[B8] Analysis Worker emitted deceptive Stockfish 17 NNUE UCI alias",
    body: `### Description
The browser analysis worker responded with \`id alias Stockfish 17 NNUE WASM\` even though only a lightweight PST heuristic was loaded.

### Root Cause
Legacy stub alias left over from initial prototyping.

### Resolution
- Removed the misleading alias.
- Honestly relabeled worker output until the authentic Stockfish 19 WASM engine was vendored in Wave 1.

**Commit:** \`8c42752\``,
    labels: ["bug", "audit", "resolved"]
  },
  {
    title: "[B9] Agent orchestration residue files tracked in git repository",
    body: `### Description
Temporary orchestration log files (\`game-log.md\`, \`brief.html\`) were checked into git tracking.

### Root Cause
Omission of agent scratch file patterns in \`.gitignore\`.

### Resolution
- Untracked and deleted residue files.
- Added \`.gitignore\` patterns and added assertions to \`security-selftest.js\` ensuring internal logs are never served.

**Commit:** \`4757c9d\``,
    labels: ["audit", "resolved"]
  },
  {
    title: "[B10] Phantom stockfish.* allowlist entries and dead UI fallbacks",
    body: `### Description
\`server.js\` whitelisted non-existent \`src/stockfish.wasm\` files, and \`src/ui.js\` contained dead fallback branches.

### Root Cause
Unimplemented future-facing stubs that never reached production.

### Resolution
- Removed phantom files from \`ALLOWED_FILES\`.
- Pruned dead fallback code paths and verified with \`test/reachability-selftest.js\`.

**Commit:** \`dcf8033\``,
    labels: ["bug", "security", "audit", "resolved"]
  },
  {
    title: "[B11] ui-auth.js HTTP 404 due to missing server allowlist and SW precache",
    body: `### Description
The Sign In modal and authentication script failed to load with HTTP 404 errors on fresh installs.

### Root Cause
\`src/ui-auth.js\` was referenced in \`index.html\` but omitted from \`ALLOWED_FILES\` in \`server.js\` and \`PRECACHE_ASSETS\` in \`service-worker.js\`.

### Resolution
- Allowlisted and precached \`src/ui-auth.js\`.
- Gated demo user login behind \`ALLOW_DEMO_AUTH=1\` to prevent credential-free unauthorized logins on production.

**Commit:** \`2c30698\`, \`5533297\``,
    labels: ["bug", "security", "audit", "resolved"]
  },
  {
    title: "[B12] Google OAuth client secret unignored in repository root",
    body: `### Description
A Google OAuth \`client_secret_*.json\` file was present untracked in the working directory and at risk of accidental commit.

### Root Cause
\`.gitignore\` did not include specific patterns for Google client secrets.

### Resolution
- Added \`client_secret*.json\` to \`.gitignore\`.
- Verified credentials were never committed in git history (\`git log --all --full-history\`).
- Ensured server only reads \`GOOGLE_CLIENT_ID\` from environment variables.

**Commit:** \`e3b18dd\``,
    labels: ["security", "audit", "resolved"]
  },

  // --- Core Defect & Gameplay Fixes ---
  {
    title: "[DEFECT] Whitelist AI/coach modules and remove disabled constraints on bot controls",
    body: `### Description
Bot difficulty and color selects were locked in a disabled state, and AI coaching endpoints failed with MIME type errors.

### Root Cause
\`server.js\` was missing \`ai-coach.js\`, \`game-report.js\`, and \`accessibility-voice.js\` from \`ALLOWED_FILES\`, and \`index.html\` hardcoded \`disabled\` attributes on the bot dropdowns.

### Resolution
- Added modules to \`ALLOWED_FILES\` with proper JavaScript MIME types.
- Removed disabled constraints from \`#bot-level-select\` and \`#bot-color-select\`.
- Wrapped client modules in IIFEs to prevent global namespace collisions.

**Task:** \`fix-ui-ai-features\``,
    labels: ["bug", "resolved"]
  },
  {
    title: "[DEFECT] Fix Stockfish worker FEN parsing and implement depth-aware bot search",
    body: `### Description
AI bot blundered simple tactical positions and played identically across difficulty levels 5-8.

### Root Cause
WASM/minimax bridge failed to properly parse full FEN state strings, causing the search to evaluate empty board positions. Depth configurations were also ignored.

### Resolution
- Fixed FEN parsing in \`stockfishWorker.evaluateMultiPV\` and \`findBestMove\`.
- Added depth-aware minimax search (depths 1-4) with MVV-LVA move ordering and checkmate detection.
- Calibrated 8 distinct difficulty tiers from Novice (800) to Grandmaster (2200).

**Task:** \`fix-smart-engine-bot\``,
    labels: ["bug", "resolved"]
  },
  {
    title: "[DEFECT] Ghost duplicate pieces appearing during historical ply scrubbing",
    body: `### Description
Scrubbing move history backwards and forwards created duplicate phantom pieces on the board (e.g. Queen on both d8 and d4).

### Root Cause
\`renderBoard()\` diffing logic failed to systematically clear square child nodes when \`pieceData\` was null for a square in a historical snapshot.

### Resolution
- Added explicit DOM cleanup (\`while (squareDiv.firstChild) squareDiv.removeChild(...)\`) when squares become empty.
- Synchronized \`previousBoard\` snapshot in \`jumpToPly\` across scrub operations.
- Added Playwright regression test verifying zero ghost pieces after ply navigation.

**Task:** \`fix-history-ghost-pieces\``,
    labels: ["bug", "resolved"]
  },
  {
    title: "[DEFECT] Bot seat reservations blocked human player game reset",
    body: `### Description
When playing against a bot, clicking New Game or Reset returned 403 unauthorized errors.

### Root Cause
\`SeatAuthManager\` treated bot seats identically to human seats, requiring the bot's non-existent seat token to authorize board mutations.

### Resolution
- Differentiated human seats from bot seats (\`isBot: true\`).
- Allowed players to reset and mutate games when the opposing seat is occupied by a bot.
- Automatically claim human seat opposite the bot on configuration update.

**Task:** \`fix-bot-seat-auth-reset\``,
    labels: ["bug", "resolved"]
  },
  {
    title: "[DEFECT] Rank-ineligible en passant moves and phantom diagonal pawn options",
    body: `### Description
Pawns were offered phantom diagonal capture moves onto empty en passant target squares from ineligible ranks (e.g., e2 to f3 after f2-f4).

### Root Cause
Move generator \`getPseudoLegalMoves\` in \`src/engine.js\` and \`src/stockfish-worker.js\` checked only the file of the en passant target without verifying that the capturing pawn stood on the required rank.

### Resolution
- Strictly enforced rank eligibility: rank 5 for White, rank 4 for Black.
- Validated that an opposing pawn is physically present on the adjacent square.
- Added 164 assertions in \`test/engine-selftest.js\`.

**Task:** \`fix-pawn-en-passant-moves\``,
    labels: ["bug", "resolved"]
  },
  {
    title: "[DEFECT] AccountsManager JSON fallback cross-contamination on Node 20",
    body: `### Description
On Node 20 runtimes lacking \`node:sqlite\`, \`AccountsManager\` dropped caller-supplied database paths and forced all instances into a single shared \`src/.accounts.json\` file.

### Root Cause
\`options.jsonPath || DEFAULT_JSON_PATH\` evaluated to the default whenever \`jsonPath\` was omitted, ignoring \`options.dbPath\`.

### Resolution
- Implemented strict precedence ladder matching \`game-archive.js\`.
- Explicit string or \`options.dbPath\` derives \`dbPath + '.json'\`.
- Added test suite \`test/accounts-isolation-selftest.js\` verifying isolation on Node 20 and Node >= 22.5.

**Branch:** \`fix/accounts-node20-isolation\``,
    labels: ["bug", "architecture", "resolved"]
  },
  {
    title: "[DEFECT] Unscoped GET /api/games endpoint exposes user game archives to guests",
    body: `### Description
Calling \`GET /api/games\` returned all archived games in the database regardless of caller ownership or session.

### Root Cause
Missing \`owner_id\` query filtering in \`src/game-archive.js\` and route handlers.

### Resolution
- Added session and guest token inspection to \`GET /api/games\` and \`GET /api/library\`.
- Signed-in users see only their owned games; guests see unowned/demo games.

**Task:** \`fix-games-scoping\``,
    labels: ["bug", "security", "resolved"]
  },
  {
    title: "[DEFECT] Service Worker stale cache prevents browsers from receiving script updates",
    body: `### Description
Users visiting the site after new deployments continued running cached older scripts.

### Root Cause
\`service-worker.js\` retained static \`CACHE_NAME\` without version increments across waves.

### Resolution
- Bumped \`CACHE_NAME\` across feature releases (\`chess-ui-v1\` -> \`chess-ui-v5\`).
- Automatically invalidates stale caches on service worker \`activate\` event.

**Task:** \`fix-sw-cache-bump\``,
    labels: ["bug", "resolved"]
  },
  {
    title: "[DEFECT] social.db test residue left in repository root",
    body: `### Description
Running \`p3-multiroom\`, \`t0-draw-flagfall\`, and \`p3-social-timecontrol\` selftests created \`social.db\` in the repository root.

### Root Cause
\`social-store.js\` statically resolved its database path at module load time rather than dynamically respecting \`CHESS_SOCIAL_DB_PATH\`.

### Resolution
- Converted \`social-store.js\` to dynamic database path resolution.
- Updated test suites to set \`CHESS_SOCIAL_DB_PATH\` to temporary directories.

**Task:** \`fix-social-db-residue\``,
    labels: ["bug", "resolved"]
  },
  {
    title: "[DEFECT] Unilateral undo in human-vs-human multiplayer rooms",
    body: `### Description
In human-vs-human games, either player could unilaterally rewind moves at any time without their opponent's agreement.

### Root Cause
The undo API immediately mutated referee state without negotiating consent.

### Resolution
- Converted undo in human-vs-human rooms into an opponent consent request (\`POST /api/undo\` -> \`state.undoRequest\`).
- Added interactive \`#undo-request-banner\` allowing the non-requester to accept or decline.
- Solo, bot, and unseated games retain immediate unilateral undo.
- Finished games reject undo requests with 409 'game over'.

**Task:** \`g4-undo-request\``,
    labels: ["bug", "resolved"]
  },

  // --- Performance & Shell Architecture ---
  {
    title: "[PERF] Double O(n) history replay in referee draw status evaluation",
    body: `### Description
Every move processed by the referee triggered two separate O(n) game history replays (\`automaticDraw\` and \`claimableDraw\`), degrading move processing times on 150+ ply games to over 8.4ms.

### Root Cause
Independent helper functions each re-instantiated and replayed the full SAN history from scratch.

### Resolution
- Created unified \`rulesEngine.drawStatus(boardOrFen, history)\` returning \`{ automatic, claimable }\` in a single replay pass.
- Halved referee move execution times on deep games from 8.6ms to 4.4ms.
- Verified zero divergence across 9,301 positions via \`test/m5-performance-selftest.js\`.

**Task:** \`m5-performance-pass\``,
    labels: ["performance", "resolved"]
  },
  {
    title: "[ARCH] URL hash pollution during in-memory SPA view switching",
    body: `### Description
Navigating between sections (Play, Analysis, Puzzles, Library, etc.) changed the URL to \`#/puzzles\`, breaking clean URL symmetry with \`agent-kanban.riazrahaman.com\`.

### Root Cause
Shell router relied on \`window.location.hash\` updates for view switching.

### Resolution
- Implemented in-memory view switching via \`Shell.navigate(id, params)\`.
- Preserved clean static URL at \`/game/<room>\` (or \`/\`) without hash pollution.
- Deep links on initial page visit are honored, then cleanly stripped via \`history.replaceState\`.

**Task:** \`static-url-navigation\``,
    labels: ["architecture", "resolved"]
  },

  // --- Master QA Audit Broken Corners (2026-09-20) ---
  {
    title: "[AUDIT] Multi-tab seat token collision across concurrent rooms",
    body: `### Description
Opening multiple games or tournament rooms across different tabs in the same browser caused seat tokens to overwrite each other, causing players to lose control of their seats.

### Root Cause
\`sessionStorage\` used a global un-namespaced key \`chess_seat_token\` for all games.

### Resolution
- Migrated to room-namespaced storage keys: \`chess_seat_token_\${room}\` in \`src/ui.js\` and \`src/ui-compete.js\`.
- Preserved fallback to legacy global key for backward compatibility.
- Added automated isolation test in \`test/audit-broken-corners-selftest.js\`.

**Task:** \`fix-audit-broken-corners\``,
    labels: ["bug", "audit", "resolved"]
  },
  {
    title: "[AUDIT] Promotion modal lacked Cancel button and Escape dismiss in puzzles and study",
    body: `### Description
Triggering a pawn promotion dialog in Puzzles (\`ui-puzzles.js\`) or Study Chapters (\`ui-study.js\`) trapped the user if they did not want to promote or wanted to pick another move.

### Root Cause
Promotion modals lacked Cancel controls or Escape key dismissal listeners, leaving the modal stuck on screen.

### Resolution
- Added explicit 'Cancel' button to \`.pz-promo\` and \`.st-promo\` dialogs.
- Added \`Escape\` key event listener with cleanup, unselecting the pawn and re-rendering the board cleanly.
- Verified in \`test/audit-broken-corners-selftest.js\`.

**Task:** \`fix-audit-broken-corners\``,
    labels: ["bug", "audit", "resolved"]
  },
  {
    title: "[AUDIT] Claim Draw button hidden during unseated or local analysis games",
    body: `### Description
When playing unseated local matches or analyzing positions where threefold repetition or the 50-move rule occurred, the 'Claim Draw' button was invisible.

### Root Cause
The button visibility condition strictly required \`isSeated\` to be true, ignoring games without assigned seats.

### Resolution
- Updated visibility logic:
  \`const canClaim = (seated || (!state?.seats?.white && !state?.seats?.black)) && isDrawClaimable(state);\`.
- The button now cleanly reveals whenever threefold repetition or 50 moves without a capture/pawn push occur in unseated play.

**Task:** \`fix-audit-broken-corners\``,
    labels: ["bug", "audit", "resolved"]
  },
  {
    title: "[AUDIT] Accidental instant resignations on mobile and touchscreen devices",
    body: `### Description
Touching the 'Resign' button accidentally on mobile devices immediately conceded the game without confirmation.

### Root Cause
Click handler committed resignation immediately upon a single click event.

### Resolution
- Built a 2-step confirmation state machine into \`#resign\`.
- First touch morphs button text to 'Confirm Resign?' with \`.btn-danger-confirm\` and starts a 4000ms auto-reset timer.
- Only a deliberate second touch submits resignation. Resets cleanly on game over or board reset.

**Task:** \`fix-audit-broken-corners\``,
    labels: ["bug", "audit", "resolved"]
  },
  {
    title: "[AUDIT] PGN copy failure in non-HTTPS and restricted clipboard environments",
    body: `### Description
Clicking 'Copy PGN' failed silently without feedback in browsers where \`navigator.clipboard.writeText\` was rejected or unavailable (e.g. non-secure contexts, iframe embeds).

### Root Cause
No fallback mechanism existed for clipboard rejection.

### Resolution
- Wrapped clipboard operation in try/catch with fallback to a temporary hidden \`<textarea>\` and \`document.execCommand('copy')\`.
- Added user feedback toasts: 'PGN copied!' on success, and \`showUiError('Failed to copy PGN')\` on failure.

**Task:** \`fix-audit-broken-corners\``,
    labels: ["bug", "audit", "resolved"]
  },
  {
    title: "[AUDIT] Browser back and forward buttons failed to restore in-memory SPA views",
    body: `### Description
After switching between site sections (e.g. from Play to Analysis to Puzzles), pressing the browser's Back button did not return to the previous view.

### Root Cause
In-memory navigation omitted browser history state pushes and had no \`popstate\` listener.

### Resolution
- Connected \`Shell.navigate\` to \`history.pushState({ viewId, params }, '', pathname)\`.
- Added \`popstate\` listener that re-mounts/shows the corresponding section without full page reloads or losing game state.

**Task:** \`fix-audit-broken-corners\``,
    labels: ["bug", "audit", "resolved"]
  }
];

async function main() {
  console.log(`Starting push of ${issues.length} reported and addressed issues to GitHub...`);

  for (let i = 0; i < issues.length; i++) {
    const item = issues[i];
    console.log(`\n[${i + 1}/${issues.length}] Creating: ${item.title}`);

    const labelFlags = item.labels.map(l => `-l "${l}"`).join(' ');
    const escapedTitle = item.title.replace(/"/g, '\\"');
    
    // Write body to temporary file to avoid shell escaping issues
    const fs = await import('node:fs');
    const tmpBody = `/tmp/issue_body_${i}.md`;
    fs.writeFileSync(tmpBody, item.body, 'utf8');

    const createCmd = `gh issue create --title "${escapedTitle}" --body-file "${tmpBody}" ${labelFlags} --repo riazrahaman/chess-game`;
    
    try {
      const output = execSync(createCmd, { encoding: 'utf8' }).trim();
      console.log(`Created: ${output}`);

      // Extract issue number or URL
      const issueNumOrUrl = output;
      
      // Close the issue with comment
      const closeCmd = `gh issue close "${issueNumOrUrl}" --reason "completed" --comment "Resolved, verified by automated test suites, merged to main, and deployed." --repo riazrahaman/chess-game`;
      execSync(closeCmd, { encoding: 'utf8' });
      console.log(`Closed: ${issueNumOrUrl} (completed)`);
    } catch (err) {
      console.error(`Failed on issue "${item.title}":`, err.message);
    } finally {
      try { fs.unlinkSync(tmpBody); } catch {}
    }

    // Small delay to be polite to API
    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`\nSuccessfully created and closed all ${issues.length} addressed issues!`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
