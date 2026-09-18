# data/openings.tsv — real opening names (E3)

Source: lichess-org/chess-openings (https://github.com/lichess-org/chess-openings),
files `a.tsv` … `e.tsv` concatenated (single header row kept from `a.tsv`).

- Upstream commit: `4b8622759e7ae6f93f011cc6c83a3823401ab45e` (master, 2026-08-04)
- Fetched: 2026-09-18
- Licence: CC0 1.0 Universal (public domain dedication) — no attribution required,
  attribution given anyway.
- Rows: 3810 data lines + 1 header (`eco	name	pgn`), 388 KB.
- Columns: `eco` (ECO code), `name` (opening / variation name), `pgn` (SAN move
  sequence that reaches the named position).

## What this file is and is not

It is a list of **named positions** — which move sequences have an ECO code and a
name. It carries **no game counts, win rates or popularity figures**, and nothing in
this repo derives any. Where the app shows a count next to an opening it is either
"lines in this file that continue from here" (labelled as such) or the player's own
archived games ("your games" from `game-archive.js`).

## Where it is used (server-side only; the file is not served to browsers)

- `src/openings-explorer.js` — `loadFromTSV` converts the SAN `pgn` column to UCI
  with chess.js at boot, builds the prefix / continuation index.
- `src/routes-openings.js` — `GET /api/openings/lookup`, `GET /api/openings/personal`.
- `src/bot-service.js` — the L1–L4 opening book picks uniformly among lines here.
- `src/masters-db.js` — "is a known book line" presence check (Node side).

## Refreshing

```
for f in a b c d e; do curl -sSfL -o /tmp/$f.tsv \
  https://raw.githubusercontent.com/lichess-org/chess-openings/master/$f.tsv; done
{ head -1 /tmp/a.tsv; for f in a b c d e; do tail -n +2 /tmp/$f.tsv; done; } > data/openings.tsv
```
Then update the commit SHA / date / row count above.
