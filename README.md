# Chess Game — Grandmaster Edition

A high-performance, accessible, full-featured web chess implementation built with vanilla JavaScript, authoritative Node.js referee architecture, Stockfish 17 NNUE WASM engine, and real-time multiplayer capabilities.

---

## Key Highlights & Capabilities

### 1. Board & Playing Experience
- **Vector Artwork**: Crisp, scale-independent vector chess pieces based on Colin M.L. Burnett's standard designs (`pieces.js`).
- **Web Audio & Haptics**: Realistic soundpack (moves, captures, checks, castling, terminal states, low-time clock pulse) with acoustic volume falloff and mobile vibration feedback.
- **Multi-Premove Queueing**: Queue up to 5 plies in advance with dashed visual indicators, automatic turn-by-turn execution, and invalidation safety.
- **Interactive Annotation Canvas**: Right-click board doodling—draw colored arrows (Green, Red, Blue, Yellow via Shift/Alt/Ctrl keys) and square highlights, with instant left-click clear.
- **Move Tree Scrubber**: Full keyboard navigation (`ArrowLeft`, `ArrowRight`, `Home`, `End`), jump to any historical ply, and review previous board states while clocks run live.

### 2. Deep Engine Analysis & Game Review
- **Stockfish 17 NNUE WASM Worker**: True Web Worker running full UCI protocol (`uci`, `isready`, `ucinewgame`, `position fen`, `go depth`).
- **Multi-PV Candidate Arrows**: Visualizes top 3 candidate engine evaluation lines with color-coded directional SVG arrows and real-time breakdown panel.
- **CAPS Win-Probability Move Review**: Computer Aggregated Precision Score (0–100%) and move classifications:
  - **Brilliant (!!)**: Winning piece sacrifices.
  - **Great (!)** / **Best (★)** / **Excellent** / **Good**: Engine-optimal play.
  - **Inaccuracy (?!)** / **Mistake (?)** / **Blunder (??)**: Suboptimal play with quantified win probability loss.
- **ECO Opening Explorer**: Deepest prefix matching against comprehensive ECO opening database with master win rates (White / Draw / Black %) and popular continuation suggestions.
- **Interactive Advantage Graph**: SVG evaluation sparkline tracking centipawn advantage across all plies with clickable ply navigation dots.

### 3. Server Architecture, Security & Multiplayer
- **Authoritative Long-Lived Referee**: In-process FIFO command queue, monotonic revision counter, append-only event journal (`.referee-journal.jsonl`), and atomic JSON state snapshots with crash recovery.
- **Cryptographic Player Seat Tokens**: Session tokens for White, Black, and Spectator roles preventing unauthorized moves or hijacking (`seat-auth.js`).
- **NTP-Style Latency Compensation**: Ping-pong RTT tracking (`/api/time`) to credit network transit lag back to active player clocks.
- **Multi-Tenant Room Router**: Isolated game rooms at `/game/:roomId` with isolated referee queues, state files, and SSE channels.
- **SQLite Game Archive & PGN Library**: Native Node.js `node:sqlite` resilient database with search, pagination, Seven Tag Roster PGN parsing, and PGN export.
- **Security Boundary**: Strict CORS origin verification, 8KB request payload cap, path traversal protection, dotfile denial, and nosniff/no-store HTTP headers.

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
# Core engine & SVG pieces
node engine-selftest.js
node pieces-selftest.js

# Security, CORS & Traversal Protection
node security-selftest.js

# Phase 1: Audio, Premoves, Annotations, Scrubber
node p1-audio-selftest.js
node p1-premove-selftest.js
node p1-annotations-selftest.js
node p1-scrubber-selftest.js

# Phase 2: Stockfish WASM, Multi-PV, CAPS Move Review, Opening Explorer
node p2-stockfish-selftest.js
node p2-multipv-selftest.js
node p2-review-selftest.js
node p2-opening-selftest.js

# Phase 3: Player Seat Tokens, Latency Compensation, Multi-Room & SQLite Archive
node p3-seat-selftest.js
node p3-lag-selftest.js
node p3-multiroom-selftest.js
node p3-sqlite-selftest.js

# Differential Engine Verification (200 random games vs chess.js, 37,800+ plies)
node differential-selftest.js
```

---

## Documentation
- [Architecture & Design Details](docs/01-design.md)
- [Technology Stack](docs/02-tech-stack.md)
- [Evolution Journey](docs/03-evolution-journey.md)
- [Code Flow & Diagrams](docs/04-code-flow+diagrams.md)
- [File Inventory](docs/05-file-inventory.md)
