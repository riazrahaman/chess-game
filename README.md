# Chess Game

A full chess site built in vanilla JavaScript on an authoritative Node.js referee. No build step, no
framework, no bundler. A vendored **Stockfish 19** (lite single-threaded WASM, GPL-3.0) powers analysis in the
browser and the bots on the server. Live at https://chess.riazrahaman.com.

## What you can do

**Play** — human vs human in shareable rooms (`/game/<room>`) with live clocks, premoves, chat, draw
offers/claims and rematches; or vs eight Stockfish-backed bot levels (~800 to ~2300). Every move, clock and
draw is decided by the server-side referee; the browser only renders what the referee reports.

**Analyse** — an Analysis view with its own engine worker (MultiPV, depth 16), per-ply scrubber, opening names
from the lichess *chess-openings* database, your own results in each line, Syzygy tablebase probes, ACPL and
phase accuracy, missed-tactic detection with an engine-hidden retry loop, and annotated PGN / summary-card /
embed exports. Game Review labels moves Brilliant → Blunder plus *Miss*, with plain-English "Why?" explanations
and a coach hint on your turn.

**Train** — 8,861 real lichess puzzles (CC0) in Daily, Rated, Custom (theme × rating), Storm and
spaced-repetition Review modes, solved with server-side verification and a Glicko-2 puzzle rating; mistake
puzzles generated from your own games.

**Compete & keep going** — accounts (local or Google sign-in), per-time-control Glicko-2 ratings for
human-vs-human games, leaderboards, lobby seeks, arenas, weekly promotion-only leagues, activity streaks with
slack, skill-event achievements, an Insights dashboard (metric × dimension × filter), and a Library that
imports your lichess / Chess.com history.

**Accessibility** — blind mode with an 8×8 keyboard grid and swipe gestures, spoken move announcements, voice
move input and voice intents, typed SAN/UCI command entry, ARIA live regions, colour-blind board themes.

## Quick start

```bash
npm install
node server.js                 # http://127.0.0.1:39281  (CHESS_PORT or PORT to override)
```

Optional environment:

| Variable | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID` | Enables Google Identity sign-in. |
| `ALLOW_DEMO_AUTH=1` | Enables the credential-free demo login (dev/demo deployments only). |
| `CHESS_ADMIN_TOKEN` | Unlocks `GET/POST /api/admin/rooms[/gc]` and `POST /api/league/close-week`. |
| `CHESS_ROOM_IDLE_MS`, `CHESS_ROOM_GC_INTERVAL_MS`, `CHESS_ROOM_MAX`, `CHESS_ROOM_GC=0` | Idle-room garbage collection (default: collect after 24 h idle, sweep hourly). |
| `CHESS_ALLOWED_ORIGIN`, `CHESS_CSP`, `CHESS_HSTS` | CORS / security-header overrides. |
| `CHESS_STATE_FILE`, `CHESS_DB_FILE`, `CHESS_ACCOUNTS_DB_FILE`, `CHESS_SOCIAL_DB_PATH`, `CHESS_LEAGUES_DB_PATH` | Relocate runtime state (tests point these at a temp dir). |

Runtime data (`src/games.db`, `src/accounts.db`, `social.db`, `leagues.db`, `.referee-*`) is created on demand
and gitignored. The puzzle sample is imported into SQLite on the first puzzle request;
`scripts/import-puzzles.mjs` streams the full 6M-row lichess dump if you want more.

## Testing

```bash
npm run check          # lint + every unit suite (~7 min; includes a 200-game differential test vs chess.js)
npm run test:browser   # Playwright smoke + UI-feature suites (start the server on :39281 first)
node test/<name>-selftest.js   # any single suite — each is a standalone Node script
```

Two guards are worth knowing about: `test/t0-deadcode-selftest.js` token-scans every client module for engine
mutators (the browser must never compute game state), and `test/reachability-selftest.js` fails if a module is
shipped but never called, or listed as servable but missing — the list of known-dark modules may only shrink.

## Repository layout

```
server.js                 HTTP + SSE + static allowlist + security headers + room GC
index.html                the single page; the shell shows one <section data-view> at a time
service-worker.js         precaches the shell (never /api/*)
src/                      referee, rules, engine bridge, route modules, feature libraries, ui-*.js views
vendor/stockfish/         Stockfish 19 lite single-threaded WASM + GPL-3.0 licence
data/                     openings.tsv (lichess chess-openings, CC0), puzzles-sample.csv (lichess, CC0)
test/                     *-selftest.js suites
scripts/                  Playwright suites, engine probe, puzzle importer, kanban sync
docs/                     design, architecture, evolution, roadmap, kanban manifest
```

## Documentation

- [CLAUDE.md](CLAUDE.md) — invariants, conventions and Definition of Done (read this before changing code)
- [docs/06-world-class-roadmap.md](docs/06-world-class-roadmap.md) — audited state, bug table, phased roadmap
- [HANDOVER.md](HANDOVER.md) — per-wave status tables and open follow-ups
- [docs/01-design.md](docs/01-design.md) · [02-tech-stack](docs/02-tech-stack.md) · [03-evolution](docs/03-evolution-journey.md) · [04-code-flow](docs/04-code-flow+diagrams.md) · [05-file-inventory](docs/05-file-inventory.md)
- [RECOMMENDATIONS.md](RECOMMENDATIONS.md) — the original 2026 roadmap (historical; superseded by docs/06)

## Licence

- **Engine:** Stockfish 19 via [stockfish.js](https://github.com/nmrugg/stockfish.js), vendored under
  `vendor/stockfish/`, **GPL-3.0** (`Copying.txt`). Distributing this app distributes GPL code — keep the
  directory and licence intact and treat the combined distribution accordingly.
- **Data:** lichess chess-openings and lichess puzzles are CC0 (provenance in `data/README*.md`).
- **Piece artwork:** Colin M.L. Burnett's cburnett set (`CBURNETT-LICENSE.txt`).
