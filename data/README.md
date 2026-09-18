# data/

Real datasets shipped in-repo. Nothing in here is fabricated.

## puzzles-sample.csv

| | |
|---|---|
| Source | [lichess.org open puzzle database](https://database.lichess.org/#puzzles) — `lichess_db_puzzle.csv.zst`, snapshot dated 2026-09-09 (6,100,952 puzzles) |
| Licence | [CC0 1.0 (public domain)](https://creativecommons.org/publicdomain/zero/1.0/) — lichess releases the puzzle database without restriction |
| Rows | **8,861** puzzles (+ 1 header line), 1,675,098 bytes (1.6 MiB) |
| Layout | Unmodified lichess column layout: `PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags,DailyDate`. Rows are verbatim lines from the source file. |
| Semantics | `FEN` is the position *before* `Moves[0]`; `Moves[0]` is the opponent's move and the solver answers from `Moves[1]` onwards (odd indices). Moves are UCI; SAN is derived at import time. |

### How it was produced

Stratified reservoir sample (deterministic seed `20260918`) across
9 rating bands (600–2400 in steps of 200) × 13 main themes
(`mate, mateIn1, mateIn2, fork, pin, skewer, discoveredAttack, hangingPiece,
endgame, opening, middlegame, advantage, crushing`) = 117 cells, ≈76 puzzles per cell,
keeping only puzzles with `Popularity ≥ 50` and `NbPlays ≥ 100`. Every kept row was
replayed with chess.js (0 invalid). The sample covers 73 distinct lichess themes.

```bash
curl -sL https://database.lichess.org/lichess_db_puzzle.csv.zst \
  | zstd -dc \
  | node scripts/import-puzzles.mjs - --sample-out data/puzzles-sample.csv --max 9000
```

### Loading it

The server imports this file into the SQLite `puzzles` table (`game-archive.js`) on the
first `/api/puzzle/*` request when the table is empty. To import manually, or to import the
full 6.1M-row lichess file (streaming, rows that fail to replay are skipped and counted):

```bash
node scripts/import-puzzles.mjs data/puzzles-sample.csv
zstd -dc lichess_db_puzzle.csv.zst | node scripts/import-puzzles.mjs - --db src/games.db
```

Set `CHESS_DB_FILE` to point the import (and the server) at a different database file.
