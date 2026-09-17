# Chess Game — Grandmaster Edition

A high-performance, accessible, full-featured web chess implementation built with vanilla JavaScript, authoritative Node.js referee architecture, local heuristic engine & UCI worker, and real-time multiplayer capabilities.

---

## Key Highlights & Capabilities

### 1. Board & Playing Experience
- **Vector Artwork**: Crisp, scale-independent vector chess pieces based on Colin M.L. Burnett's standard designs (`pieces.js`).
- **Unified Mobile & Touch Controls (D5, A7, A9)**: Pointer events (`pointerdown`, `pointermove`, `pointerup`) powering seamless mobile and tablet drag-and-drop, subtle bevel framing, square gradients, and piece drop shadows.
- **Web Audio & Haptics**: Realistic soundpack (moves, captures, checks, castling, terminal states, low-time clock pulse) with acoustic volume falloff and mobile vibration feedback.
- **Multi-Premove Queueing**: Queue up to 5 plies in advance with dashed visual indicators, automatic turn-by-turn execution, and invalidation safety.
- **Interactive Annotation Canvas**: Right-click board doodling—draw colored arrows (Green, Red, Blue, Yellow via Shift/Alt/Ctrl keys) and square highlights, with instant left-click clear.
- **Move Tree Scrubber**: Full keyboard navigation (`ArrowLeft`, `ArrowRight`, `Home`, `End`), jump to any historical ply, and review previous board states while clocks run live.
- **Time Controls & Clocks**: Per-color clocks with delay, Bronstein, and odds support; lichess-style time-control categorization (UltraBullet → Classical) (`time-control.js`).
- **FEN Setup / Board Editor**: Start a room from any valid FEN via the referee `setup` command with strict validation (`fen-setup.js`).
- **Chess960 / Fischer Random**: All 960 legal start positions (Scharnagl scheme) with FIDE 960 castling rules (`chess960.js`).
- **Variants**: Crazyhouse, Atomic, King-of-the-Hill, and Three-Check rule helpers (`variants.js`).

### 2. Time Controls & Social Layer (B7, B8)
- **Time Control Presets (B7)**: Bullet 1+0, Blitz 3+2, Blitz 5+3, Rapid 10+0, Rapid 10+15, Classical 15+10, and custom time controls configurable pre-game per room.
- **In-Game Chat & Spectator Presence (B8)**: Real-time room chat (`/api/chat` with SSE broadcast), live spectator count badge (`#spectator-badge`), and interactive rematch negotiation flow (`/api/rematch/:action`).
- **Chat Upgrades**: Move references, draw offers, emoji reactions, moderation (banned-word filtering), and a bounded 200-message history (`chat-upgrades.js`).
- **Social Graph**: Follow, block, and mutual-friend relationships with an injectable persistence backend (`social-graph.js`).
- **Correspondence Mode**: Multi-day clocks with flag detection and if-then conditional premoves (`correspondence.js`).

### 3. AI-Era Capabilities (C2, C4, C5, C6, C7, C8)
- **Play vs Computer (C5)**: Autonomous bot opponents with 8 difficulty tiers (Novice 800 to Grandmaster 2200), search depths 1–4, blunder rates, human think delay, and persona flavor commentary (`bot-service.js`).
- **Personality Bots**: Five historical personas (Tal, Karpov, Capablanca, Morphy, Nimzowitsch) with distinct play-style profiles and chat commentary (`personality-bots.js`).
- **Retry Your Mistakes / Blunder Puzzles (C7)**: Automatic mistake puzzle generator turning game review blunders into interactive puzzles to discover optimal moves (`#retry-mistakes-section`, `move-review.js`).
- **"Why?" Move Explanations & Coach Mode (C2, C4)**: Contextual plain-English move breakdown cards explaining tactical reasons (`#why-move-btn`) and real-time coaching suggestions on your turn (`#coach-hint-btn`, `ai-coach.js`).
- **Post-Game Narrative Report (C6)**: Prose storytelling of match narrative, opening evaluation, critical turning point swing analysis, endgame performance, tactical takeaways, and exportable annotated PGN with NAG glyphs and eval comments (`game-report.js`).
- **Report Upgrades**: ACPL (average centipawn loss), move-time statistics, and phase-segmented accuracy (opening/middlegame/endgame) (`acpl.js`).
- **Voice Move Commands & Spoken Announcements (C8)**: Natural spoken English audio announcements of moves via SpeechSynthesis API, voice move input recognition via Web Speech API (`#mic-move-btn`), and spoken chess parser (`accessibility-voice.js`).
- **Voice Intents**: Spoken command routing for resign, draw, analyze, hint, undo, and more (`voice-intents.js`).

### 4. Blind & Screen-Reader Accessibility (D4)
- **Blind Accessibility Mode**: Dedicated toggle (`#blind-mode-toggle` or shortcut `B`), ARIA live regions (`#accessibility-announcer`), full 8x8 keyboard grid navigation (Arrow keys move cursor, Enter/Space selects and moves, Esc cancels), with spoken square and piece descriptions.
- **Accessible Hotkeys**:
  - `V`: Toggle Voice Announcements
  - `M`: Trigger Microphone Voice Move Input
  - `B`: Toggle Blind Accessibility Mode
  - `C`: Read Clock Times
  - `S`: Read Game / Position Status
- **Text Command Entry**: Type UCI/SAN moves or actions (resign, draw, undo, analyze) with confidence scoring (`a11y-text-entry.js`).
- **Touch Gestures**: Swipe-based navigation and tap detection for blind-mode board control (`a11y-gestures.js`).

### 5. Engine Analysis & Game Review
- **Lightweight Local Heuristic Engine & UCI Worker**: In-browser evaluator (PST + material evaluation, candidate move search) running UCI protocol (`uci`, `isready`, `ucinewgame`, `position fen`, `go depth`) with Stockfish 17 UCI alias and an optional WASM bridge for protocol compatibility (`stockfish-worker.js`).
- **Multi-PV Candidate Arrows**: Visualizes top 3 candidate engine evaluation lines with color-coded directional SVG arrows and real-time breakdown panel.
- **CAPS Win-Probability Move Review**: Computer Aggregated Precision Score (0–100%) using the lichess win-probability logistic curve, and move classifications:
  - **Brilliant (!!)**: Winning piece sacrifices.
  - **Great (!)** / **Best (★)** / **Excellent** / **Good**: Engine-optimal play.
  - **Inaccuracy (?!)** / **Mistake (?)** / **Blunder (??)**: Suboptimal play with quantified win probability loss.
- **Masters-DB Mistake Whitelist**: Reclassifies book-theory moves (played in ≥2 master games) from blunder/mistake to best, using a frequency-sorted opening book (`masters-db.js`).
- **ECO Opening Explorer**: Deepest prefix matching against comprehensive ECO opening database with master win rates (White / Draw / Black %) and popular continuation suggestions (`openings-db.js`).
- **Real Opening Explorer**: lichess chess-openings TSV import plus personal archive statistics (no fabricated win-rates) (`openings-explorer.js`).
- **Interactive Advantage Graph**: Click-to-jump evaluation graph with per-ply tooltips (SAN, eval, ACPL delta) linked to the scrubber (`eval-graph.js`).
- **Tablebase Probe**: lichess Syzygy 7-piece WDL/DTZ lookups with offline engine-eval fallback (`tablebase.js`).

### 6. Puzzles & Training
- **lichess Puzzle CSV Import**: Ingest themed puzzle subsets with UCI→SAN move conversion (`puzzle-service.js`).
- **Puzzle Rating Loop**: Puzzle-vs-player Glicko-2 rating with time bonuses (`puzzle-rating.js`).
- **Puzzle Storm & Daily Puzzle**: Timed Puzzle Storm sessions with deterministic seeded selection and a date-seeded daily puzzle (`puzzle-storm.js`, `daily-puzzle.js`).
- **Spaced-Repetition Mistake Review**: Chessable-style expanding-interval review of past mistakes, persisted per player (`puzzle-repetition.js`).
- **Puzzle Racer**: Multiplayer puzzle race with streak multipliers (×2, capped ×8) over a seeded sequence (`puzzle-racer.js`).
- **Studies Variation Tree**: Pure-data variation tree with PGN/RAV round-trip for studies (`study-tree.js`).

### 7. Accounts, Ratings & Matchmaking
- **Accounts & Profiles**: scrypt-hashed credentials with per-user salt and timing-safe verification; archive-based profile aggregation (win-rate by opening, accuracy trend) (`accounts.js`).
- **Ratings & Leaderboards**: Per-time-control Glicko-2 pools with provisional (RD > 110) handling; bot games explicitly excluded from the human pool; leaderboards (`ratings-pool.js`, `rating.js`).
- **Lobby & Matchmaking**: Seeks, challenges, and rating-bracket matchmaking with mutual tolerance and seeded tie-breaks (`lobby.js`).
- **Arena Tournaments**: Swiss-style pairing with Buchholz + Sonneborn-Berger tie-breaks and berserk double-points (`arena.js`).

### 8. Server Architecture, Security & Multiplayer
- **Authoritative Long-Lived Referee**: In-process FIFO command queue, monotonic revision counter, append-only event journal (`.referee-journal.jsonl`), and atomic JSON state snapshots with crash recovery.
- **Strict Seat Authorization on All Mutations**: Cryptographic session tokens enforce player identity not just on moves, but across `/api/reset`, `/api/undo`, `/api/draw`, and `/api/resign`, preventing observer tampering while maintaining unseated compatibility (`seat-auth.js`).
- **Client Seat Keepalive Heartbeat**: Periodic 25s client heartbeat (`/api/seat/heartbeat`) maintains player leases during deep thoughts.
- **Authoritative Draw Rules & Claims**: Referee evaluates automatic draws (threefold/fivefold repetition, 75-move, insufficient material) and handles draw offers/acceptance and 50-move claims (`/api/draw-claim`).
- **Server-Side Flag Fall**: Clocks actively check for timeout expiry via `/api/flag` and on state reads, flagging players even if they stop moving.
- **NTP-Style Latency Compensation & Live Ping**: Ping-pong RTT tracking (`/api/time`) with periodic client clock synchronization to credit network transit lag back to active player clocks.
- **SSE Hardening**: Event-driven state broadcasts (replacing the 250ms poll) with monotonic event IDs, `Last-Event-ID` reconnection replay, and a bounded replay log.
- **Multi-Tenant Room Router**: Isolated game rooms at `/game/:roomId` with isolated referee queues, state files, and SSE channels.
- **SQLite Game Archive & PGN Library**: Native Node.js `node:sqlite` resilient database with search, pagination, Seven Tag Roster PGN parsing, PGN export, and persistent eval/rating/review storage.
- **Security Boundary & Rate Limiting**: Strict CORS origin verification, 8KB request payload cap, persistent (SQLite-backed) IP rate limiting surviving restarts, path traversal protection, dotfile denial, and nosniff/no-store HTTP headers.
- **Security Headers**: CSP, X-Frame-Options, Referrer-Policy, and HSTS (when behind TLS) helmet-style hardening.
- **PWA**: Installable manifest (`manifest.webmanifest`) with a precache + cache-first service worker for offline play (`service-worker.js`).
- **Annotated-POV Exports**: Per-perspective annotated PGN export with a summary-card SVG (`pov-export.js`).
- **Embeddable Viewer**: FEN→SVG board renderer with a copy-paste iframe snippet (`embed-viewer.js`).

### 9. Internationalization
- **i18n Layer**: English, Spanish, and French message catalogs with interpolation and locale→English→raw-key fallback (`i18n.js`).

---

## Quick Start

### Prerequisites
- Node.js (v18+)
- npm

### Installation & Launch
```bash
# Install dependencies
npm install

# Start the game server (default port 39281)
node server.js
```
Open `http://127.0.0.1:39281` in your browser to play.

---

## Repository Layout

- `src/` — all source modules (referee, rules engine, game archive, bot, engine worker, UI, and every feature module).
- `test/` — all `*-selftest.js` suites (run with `node test/<name>-selftest.js`).
- Repo root — `server.js` (entrypoint), `index.html`, `manifest.webmanifest`, `service-worker.js` (kept at root for scope `/`), plus `docs/`, `scripts/`, `assets/`.

## Test Suites & Quality Verification

Run the complete test suite:
```bash
npm test
```

Or run individual verification suites:
```bash
# Core engine, pieces & security
node test/engine-selftest.js
node test/pieces-selftest.js
node test/security-selftest.js

# Phase 3 Multi-Room, SQLite & Seat Auth
node test/p3-multiroom-selftest.js
node test/p3-sqlite-selftest.js
node test/p3-seat-selftest.js

# Tier 0 Draw Rules, Flag Fall & Dead-Code
node test/t0-draw-flagfall-selftest.js
node test/t0-deadcode-selftest.js

# Engine & Mobile Visuals
node test/p2-stockfish-selftest.js
node test/t1-mobile-visuals-selftest.js

# Social & Time Controls
node test/p3-social-timecontrol-selftest.js

# AI Features (Bot, Puzzles, Coach, Report, Voice/Accessibility)
node test/c5-ai-bot-selftest.js
node test/c7-ai-puzzles-selftest.js
node test/c2-c4-coach-selftest.js
node test/c6-ai-report-selftest.js
node test/c8-d4-voice-selftest.js

# Differential Engine Verification (200 random games vs chess.js, 37,800+ plies)
node test/differential-selftest.js

# Rating Engine
node test/rating-selftest.js

# Puzzles & Training
node test/puzzle-service-selftest.js
node test/puzzle-rating-selftest.js
node test/puzzle-storm-selftest.js
node test/daily-puzzle-selftest.js
node test/puzzle-repetition-selftest.js
node test/study-tree-selftest.js
node test/openings-explorer-selftest.js
node test/eval-graph-selftest.js
node test/puzzle-racer-selftest.js

# Accounts, Ratings & Matchmaking
node test/accounts-selftest.js
node test/ratings-pool-selftest.js
node test/lobby-selftest.js
node test/arena-selftest.js

# Platform (PWA, SSE, Security)
node test/pwa-selftest.js
node test/sse-hardening-selftest.js
node test/security-headers-selftest.js

# Breadth (Analysis, Accessibility, Game Modes)
node test/masters-db-selftest.js
node test/acpl-selftest.js
node test/a11y-intents-selftest.js
node test/chess960-selftest.js
node test/fen-setup-selftest.js
node test/time-control-selftest.js
node test/tablebase-selftest.js

# Bets (Social, Variants, i18n)
node test/social-graph-selftest.js
node test/chat-upgrades-selftest.js
node test/correspondence-selftest.js
node test/personality-bots-selftest.js
node test/pov-export-selftest.js
node test/embed-viewer-selftest.js
node test/variants-selftest.js
node test/i18n-selftest.js
```

---

## Documentation
- [Recommendations & Parity Benchmark](RECOMMENDATIONS.md)
- [Architecture & Design Details](docs/01-design.md)
- [Technology Stack](docs/02-tech-stack.md)
- [Evolution Journey](docs/03-evolution-journey.md)
- [Code Flow & Diagrams](docs/04-code-flow+diagrams.md)
- [File Inventory](docs/05-file-inventory.md)
