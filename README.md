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

### 2. Time Controls & Social Layer (B7, B8)
- **Time Control Presets (B7)**: Bullet 1+0, Blitz 3+2, Blitz 5+3, Rapid 10+0, Rapid 10+15, Classical 15+10, and custom time controls configurable pre-game per room.
- **In-Game Chat & Spectator Presence (B8)**: Real-time room chat (`/api/chat` with SSE broadcast), live spectator count badge (`#spectator-badge`), and interactive rematch negotiation flow (`/api/rematch/:action`).

### 3. AI-Era Capabilities (C2, C4, C5, C6, C7, C8)
- **Play vs Computer (C5)**: Autonomous bot opponents with 8 difficulty tiers (Novice 800 to Grandmaster 2200), search depths 1–4, blunder rates, human think delay, and persona flavor commentary (`bot-service.js`).
- **Retry Your Mistakes / Blunder Puzzles (C7)**: Automatic mistake puzzle generator turning game review blunders into interactive puzzles to discover optimal moves (`#retry-mistakes-section`, `move-review.js`).
- **"Why?" Move Explanations & Coach Mode (C2, C4)**: Contextual plain-English move breakdown cards explaining tactical reasons (`#why-move-btn`) and real-time coaching suggestions on your turn (`#coach-hint-btn`, `ai-coach.js`).
- **Post-Game Narrative Report (C6)**: Prose storytelling of match narrative, opening evaluation, critical turning point swing analysis, endgame performance, tactical takeaways, and exportable annotated PGN with NAG glyphs and eval comments (`game-report.js`).
- **Voice Move Commands & Spoken Announcements (C8)**: Natural spoken English audio announcements of moves via SpeechSynthesis API, voice move input recognition via Web Speech API (`#mic-move-btn`), and spoken chess parser (`accessibility-voice.js`).

### 4. Blind & Screen-Reader Accessibility (D4)
- **Blind Accessibility Mode**: Dedicated toggle (`#blind-mode-toggle` or shortcut `B`), ARIA live regions (`#accessibility-announcer`), full 8x8 keyboard grid navigation (Arrow keys move cursor, Enter/Space selects and moves, Esc cancels), with spoken square and piece descriptions.
- **Accessible Hotkeys**:
  - `V`: Toggle Voice Announcements
  - `M`: Trigger Microphone Voice Move Input
  - `B`: Toggle Blind Accessibility Mode
  - `C`: Read Clock Times
  - `S`: Read Game / Position Status

### 5. Engine Analysis & Game Review
- **Lightweight Local Heuristic Engine & UCI Worker**: In-browser evaluator (PST + material evaluation, candidate move search) running UCI protocol (`uci`, `isready`, `ucinewgame`, `position fen`, `go depth`) with Stockfish 17 UCI alias for protocol compatibility.
- **Multi-PV Candidate Arrows**: Visualizes top 3 candidate engine evaluation lines with color-coded directional SVG arrows and real-time breakdown panel.
- **CAPS Win-Probability Move Review**: Computer Aggregated Precision Score (0–100%) and move classifications:
  - **Brilliant (!!)**: Winning piece sacrifices.
  - **Great (!)** / **Best (★)** / **Excellent** / **Good**: Engine-optimal play.
  - **Inaccuracy (?!)** / **Mistake (?)** / **Blunder (??)**: Suboptimal play with quantified win probability loss.
- **ECO Opening Explorer**: Deepest prefix matching against comprehensive ECO opening database with master win rates (White / Draw / Black %) and popular continuation suggestions.
- **Interactive Advantage Graph**: SVG evaluation sparkline tracking centipawn advantage across all plies with clickable ply navigation dots.

### 6. Server Architecture, Security & Multiplayer
- **Authoritative Long-Lived Referee**: In-process FIFO command queue, monotonic revision counter, append-only event journal (`.referee-journal.jsonl`), and atomic JSON state snapshots with crash recovery.
- **Strict Seat Authorization on All Mutations**: Cryptographic session tokens enforce player identity not just on moves, but across `/api/reset`, `/api/undo`, `/api/draw`, and `/api/resign`, preventing observer tampering while maintaining unseated compatibility (`seat-auth.js`).
- **Client Seat Keepalive Heartbeat**: Periodic 25s client heartbeat (`/api/seat/heartbeat`) maintains player leases during deep thoughts.
- **Authoritative Draw Rules & Claims**: Referee evaluates automatic draws (threefold/fivefold repetition, 75-move, insufficient material) and handles draw offers/acceptance and 50-move claims (`/api/draw-claim`).
- **Server-Side Flag Fall**: Clocks actively check for timeout expiry via `/api/flag` and on state reads, flagging players even if they stop moving.
- **NTP-Style Latency Compensation & Live Ping**: Ping-pong RTT tracking (`/api/time`) with periodic client clock synchronization to credit network transit lag back to active player clocks.
- **Multi-Tenant Room Router**: Isolated game rooms at `/game/:roomId` with isolated referee queues, state files, and SSE channels.
- **SQLite Game Archive & PGN Library**: Native Node.js `node:sqlite` resilient database with search, pagination, Seven Tag Roster PGN parsing, and PGN export.
- **Security Boundary & Rate Limiting**: Strict CORS origin verification, 8KB request payload cap, IP rate limiting with LRU cleanup, path traversal protection, dotfile denial, and nosniff/no-store HTTP headers.

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

## Test Suites & Quality Verification

Run the complete test suite:
```bash
npm test
```

Or run individual verification suites:
```bash
# Core engine, pieces & security
node engine-selftest.js
node pieces-selftest.js
node security-selftest.js

# Phase 3 Multi-Room, SQLite & Seat Auth
node p3-multiroom-selftest.js
node p3-sqlite-selftest.js
node p3-seat-selftest.js

# Tier 0 Draw Rules, Flag Fall & Dead-Code
node t0-draw-flagfall-selftest.js
node t0-deadcode-selftest.js

# Engine & Mobile Visuals
node p2-stockfish-selftest.js
node t1-mobile-visuals-selftest.js

# Social & Time Controls
node p3-social-timecontrol-selftest.js

# AI Features (Bot, Puzzles, Coach, Report, Voice/Accessibility)
node c5-ai-bot-selftest.js
node c7-ai-puzzles-selftest.js
node c2-c4-coach-selftest.js
node c6-ai-report-selftest.js
node c8-d4-voice-selftest.js

# Differential Engine Verification (200 random games vs chess.js, 37,800+ plies)
node differential-selftest.js
```

---

## Documentation
- [Recommendations & Parity Benchmark](RECOMMENDATIONS.md)
- [Architecture & Design Details](docs/01-design.md)
- [Technology Stack](docs/02-tech-stack.md)
- [Evolution Journey](docs/03-evolution-journey.md)
- [Code Flow & Diagrams](docs/04-code-flow+diagrams.md)
- [File Inventory](docs/05-file-inventory.md)
