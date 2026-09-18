# Vendored engine: Stockfish 19 (lite, single-threaded WASM)

Source: https://github.com/nmrugg/stockfish.js — npm `stockfish@19.0.0`, files
`bin/stockfish-19-lite-single.js` (21 KB loader) and
`bin/stockfish-19-lite-single.wasm` (1.79 MB, sscg13 1 MB NNUE compiled in).

- Licence: **GPL-3.0** (`Copying.txt`). Stockfish.js (c) 2026, Chess.com, LLC;
  Stockfish (c) the Stockfish developers. Distributing this app distributes
  GPL code — keep this directory and licence intact.
- Why this build: runs without COOP/COEP (single-threaded), ~1.8 MB one-time
  download, cached by the service worker. The 99 MB full-net build is
  deliberately NOT shipped (roadmap E1).
- Used by: `src/stockfish-worker.js` (browser Web Worker, `importScripts`) and
  `src/engine-server.js` (Node, for `bot-service.js`).
- To upgrade: download the same two files from the release matching the
  version in this README, replace, update the version here and in
  `test/wave1-engine-selftest.js`.
