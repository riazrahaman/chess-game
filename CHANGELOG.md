# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The app version shown in the UI is
single-sourced from `package.json` and served by `GET /api/version`.

## [1.1.1] — 2026-09-24

### Security
- **Google Sign-In ID tokens are now cryptographically verified.** `POST /api/auth/google` previously
  base64-decoded the JWT payload and trusted it, without checking the signature — a forged token with the
  public client ID and an arbitrary `sub` was accepted on production (`server.js`). The endpoint now verifies
  RS256 signatures against Google's JWKS (`verifyGoogleIdToken`), validates `iss`, `exp` and `aud`, and fails
  closed. Regression coverage in `test/auth-routes-selftest.js` (forged token rejected; trusted key accepted;
  untrusted-key and wrong-issuer rejected).
- **Credential-free demo sign-in is now opt-in.** It required `ALLOW_DEMO_AUTH !== '0'` (enabled by default);
  it now requires `ALLOW_DEMO_AUTH === '1'`, matching the documented behaviour.
- **Archived-game reads are scoped by requester** across the by-id endpoints, closing an IDOR that exposed
  other players' games (c0e4a88).

### Fixed
- Scheduled bot moves are cancelled on disable/reconfigure, so a pending timer can no longer play a stray
  move onto a fresh board (B23).
- A plain visit keeps the root URL; the private room is resolved from storage instead of being written into
  the address bar (`manifest.webmanifest` `start_url: "/"` now holds).
- Repaired the Gate-4 and p1-premove self-test `window` mocks and wired both suites into `test:unit`/`lint`.

### Changed
- Removed Render platform references; the deployment target is Railway at https://chess.riazrahaman.com.

## [1.1.0] — 2026-09-20

This release consolidated the full roadmap build: Part 1 (Tiers 0–D) plus all five delivery waves, and a
repository reorganisation into `src/` + `test/`. Highlights below.

### Added — Wave 1 (engine credibility)
- Vendored **Stockfish 19 lite** (WASM) running in a browser Web Worker with a PST fallback (X1).
- Lichess win-probability logistic curve in move review (X2) and a FEN-keyed eval cache in SQLite (X3).
- **Glicko-2** rating engine, `src/rating.js` (X4).
- Split the `ui.js` monolith into `ui-sound`/`ui-theme`/`ui-annotations`/`ui-archive` and added an ESLint flat
  config (X5).

### Added — Wave 2 (retention)
- Lichess puzzle CSV import with UCI→SAN conversion (`src/puzzle-service.js`, 8,861 CC0 puzzles).
- Puzzle Glicko-2 rating loop, Puzzle Storm and Daily Puzzle, spaced-repetition review.
- Studies variation tree with PGN/RAV round-trip, a real opening explorer (lichess TSV + personal stats), and
  an interactive click-to-jump eval graph.

### Added — Wave 3 (platform)
- Accounts (scrypt) with profiles, Glicko-2 rating pools and leaderboards, and a lobby/matchmaking service.
- PWA (manifest + service worker), event-driven SSE with `Last-Event-ID` replay, and security headers with
  SQLite-backed persistent rate limiting.

### Added — Wave 4 (breadth)
- Masters-DB mistake whitelist, ACPL/phase-accuracy report upgrades, Puzzle Racer.
- Accessibility: typed move entry, touch gestures, voice intents.
- Chess960, FEN board setup (referee `setup` command + `POST /api/setup`), fuller time controls
  (per-colour, delay, Bronstein, odds), and Syzygy tablebase probes.

### Added — Wave 5 (bets)
- Arena tournaments, a social graph, chat upgrades, correspondence games.
- Personality bots, annotated POV exports, an embed viewer, variant rules (crazyhouse/atomic/king-of-the-hill/
  three-check), and an i18n layer.

### Changed
- Reorganised the repository: 49 modules into `src/`, 62 self-tests into `test/` (7afa675).
- Added an About view and a version badge single-sourced from `package.json`.

### Fixed
- Resolved the B1–B28 audit findings: draw negotiation/claim UI, SSE polling backoff, room chat layout, Gate-4
  string-concatenation bypass, clock start, ghost pieces while scrubbing, bot seat resets, CI browser flakes,
  and more (see `docs/06-world-class-roadmap.md`).

## [1.0.0] — 2026-09-13

### Added
- First public release (`first-gold`): authoritative Node.js referee (per-room state, clocks, history, draw
  policy), vanilla-JS client, vendored Stockfish 19 lite engine, live play, analysis, puzzles, library,
  insights and accessible play.
- Part 1 (Tiers 0–D) complete, with the full self-test battery green.

[1.1.1]: https://github.com/riazrahaman/chess-game/releases/tag/v1.1.1
[1.1.0]: https://github.com/riazrahaman/chess-game/releases/tag/v1.1.0
[1.0.0]: https://github.com/riazrahaman/chess-game/releases/tag/v1.0.0
