#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`PASS: ${message}`);
    passed++;
  } else {
    console.error(`FAIL: ${message}`);
    failed++;
  }
}

async function runTests() {
  console.log('=== Phase 3: SQLite Game Archive & PGN Database Self-Test ===\n');

  const gameArchiveMod = require('./game-archive.js');
  const { createServer } = require('./server.js');

  // -------------------------------------------------------------
  // 1. Storage Backend Initialization (SQLite & JSON Fallback)
  // -------------------------------------------------------------
  console.log('--- 1. Storage Backend Initialization ---');
  const hasSqlite = (() => {
    if (process.env.CHESS_ARCHIVE_FORCE_JSON === '1') return false;
    try {
      const { DatabaseSync } = require('node:sqlite');
      return typeof DatabaseSync === 'function';
    } catch (_) {
      return false;
    }
  })();

  const sqliteArchive = gameArchiveMod.createGameArchive(':memory:');
  if (hasSqlite) {
    assert(sqliteArchive.backendType === 'sqlite', 'createGameArchive(":memory:") uses SQLite backend');
  } else {
    assert(sqliteArchive.backendType === 'json', 'createGameArchive(":memory:") gracefully falls back to JSON when node:sqlite is unavailable');
  }

  const tmpJsonPath = path.join(__dirname, `.test-archive-${Date.now()}.json`);
  const jsonArchive = gameArchiveMod.createGameArchive({ forceJson: true, jsonPath: tmpJsonPath });
  assert(jsonArchive.backendType === 'json', 'createGameArchive({ forceJson: true }) uses JSON file fallback');

  // -------------------------------------------------------------
  // 2. PGN Parsing & Exporting
  // -------------------------------------------------------------
  console.log('\n--- 2. PGN Parsing & Exporting ---');
  const samplePgn = `[Event "World Championship"]
[Site "Reykjavik ISL"]
[Date "1972.07.23"]
[Round "6"]
[White "Fischer, Robert J."]
[Black "Spassky, Boris V."]
[Result "1-0"]
[ECO "D59"]

1. c4 {English opening start} e6 2. Nf3 d5 3. d4 (3. e3) Nf6 4. Nc3 Be7 5. Bg5 O-O 1-0`;

  const parsed = gameArchiveMod.parsePgn(samplePgn);
  assert(parsed.white === 'Fischer, Robert J.', `parsePgn: White is "${parsed.white}"`);
  assert(parsed.black === 'Spassky, Boris V.', `parsePgn: Black is "${parsed.black}"`);
  assert(parsed.date === '1972.07.23', `parsePgn: Date is "${parsed.date}"`);
  assert(parsed.result === '1-0', `parsePgn: Result is "${parsed.result}"`);
  assert(parsed.eco === 'D59', `parsePgn: ECO is "${parsed.eco}"`);
  assert(parsed.headers.Event === 'World Championship', 'parsePgn: Event header preserved');
  assert(Array.isArray(parsed.moves) && parsed.moves.length === 10, `parsePgn: 10 moves extracted without comments/variations (got ${parsed.moves.length})`);
  assert(parsed.moves[0] === 'c4' && parsed.moves[parsed.moves.length - 1] === 'O-O', 'parsePgn: First move is c4 and last is O-O');

  // Test bare movetext parsing
  const barePgn = '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 1/2-1/2';
  const bareParsed = gameArchiveMod.parsePgn(barePgn);
  assert(bareParsed.result === '1/2-1/2', `parsePgn bare: result is "${bareParsed.result}"`);
  assert(bareParsed.moves.length === 6, `parsePgn bare: 6 moves extracted (got ${bareParsed.moves.length})`);
  assert(bareParsed.eco === 'C50', `parsePgn bare: auto-detected Italian Game ECO C50 (got "${bareParsed.eco}")`);

  // Test exportPgn
  const exported = gameArchiveMod.exportPgn({
    white: 'Kasparov',
    black: 'Karpov',
    date: '1985.11.09',
    result: '1-0',
    eco: 'B44',
    moves: ['e4', 'c5', 'Nf3', 'e6', 'd4', 'cxd4', 'Nxd4', 'Nc6']
  });
  assert(exported.includes('[White "Kasparov"]'), 'exportPgn: contains White header');
  assert(exported.includes('[Black "Karpov"]'), 'exportPgn: contains Black header');
  assert(exported.includes('[Result "1-0"]'), 'exportPgn: contains Result header');
  assert(exported.includes('[ECO "B44"]'), 'exportPgn: contains ECO header');
  assert(exported.includes('1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 Nc6 1-0'), 'exportPgn: contains numbered movetext with result');

  // Test exportPgn with UCI moves
  const exportedUci = gameArchiveMod.exportPgn({
    white: 'Player 1',
    black: 'Player 2',
    result: '*',
    moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6']
  });
  assert(exportedUci.includes('1. e4 e5 2. Nf3 Nc6 *'), 'exportPgn: converts UCI moves to SAN format in movetext');

  // -------------------------------------------------------------
  // 3. SQLite Game Archive CRUD & Search
  // -------------------------------------------------------------
  console.log('\n--- 3. SQLite Game Archive CRUD & Search ---');
  const game1 = sqliteArchive.saveGame({
    white: 'Magnus Carlsen',
    black: 'Hikaru Nakamura',
    date: '2024.05.20',
    result: '1-0',
    eco: 'C65',
    moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'Nf6']
  });
  assert(typeof game1.id === 'string' && game1.id.length > 0, `saveGame: generated id "${game1.id}"`);
  assert(game1.white === 'Magnus Carlsen', 'saveGame: stored White name');
  assert(game1.pgn && game1.pgn.includes('Magnus Carlsen'), 'saveGame: auto-generated full PGN text');
  assert(typeof game1.created_at === 'number', 'saveGame: set created_at timestamp');

  // Save game 2 via raw PGN
  const game2 = sqliteArchive.saveGame({
    pgn: samplePgn
  });
  assert(game2.white === 'Fischer, Robert J.', 'saveGame with PGN: parsed White from PGN headers');
  assert(game2.eco === 'D59', 'saveGame with PGN: parsed ECO D59');
  assert(game2.result === '1-0', 'saveGame with PGN: parsed Result 1-0');

  // Save game 3
  const game3 = sqliteArchive.saveGame({
    id: 'custom-game-id-003',
    white: 'Viswanathan Anand',
    black: 'Vladimir Kramnik',
    date: '2008.10.14',
    result: '1/2-1/2',
    moves: ['d4', 'd5', 'c4', 'c6']
  });
  assert(game3.id === 'custom-game-id-003', 'saveGame: respected custom id');
  assert(game3.eco === 'D10', `saveGame: auto-detected Slav Defense ECO D10 (got "${game3.eco}")`);

  // Retrieve game
  const retrieved1 = sqliteArchive.getGame(game1.id);
  assert(retrieved1 !== null, 'getGame: found game1 by id');
  assert(retrieved1.white === 'Magnus Carlsen' && retrieved1.black === 'Hikaru Nakamura', 'getGame: metadata matches');

  const retrievedMissing = sqliteArchive.getGame('non-existent-uuid');
  assert(retrievedMissing === null, 'getGame: returns null for unknown id');

  // List games
  const allGames = sqliteArchive.listGames();
  assert(allGames.length === 3, `listGames: returned 3 games (got ${allGames.length})`);
  assert(allGames[0].id === game3.id, 'listGames: ordered by created_at DESC by default');

  const pagedGames = sqliteArchive.listGames({ limit: 2, offset: 1 });
  assert(pagedGames.length === 2, `listGames: pagination limit=2 returned 2 games`);
  assert(pagedGames[0].id === game2.id, 'listGames: pagination offset=1 returned second game');

  // Search games by string
  const searchCarlsen = sqliteArchive.searchGames('Carlsen');
  assert(searchCarlsen.length === 1 && searchCarlsen[0].white === 'Magnus Carlsen', 'searchGames("Carlsen"): matched 1 game');

  const searchFischer = sqliteArchive.searchGames('fischer');
  assert(searchFischer.length === 1 && searchFischer[0].white.includes('Fischer'), 'searchGames("fischer"): case-insensitive match');

  const searchEco = sqliteArchive.searchGames('D10');
  assert(searchEco.length === 1 && searchEco[0].id === 'custom-game-id-003', 'searchGames("D10"): matched by ECO code');

  const searchDraw = sqliteArchive.searchGames('1/2-1/2');
  assert(searchDraw.length === 1 && searchDraw[0].result === '1/2-1/2', 'searchGames("1/2-1/2"): matched by result');

  // Search games by object filter
  const filterWhite = sqliteArchive.searchGames({ white: 'Magnus' });
  assert(filterWhite.length === 1, 'searchGames({ white: "Magnus" }): matched 1 game');

  const filterNoMatch = sqliteArchive.searchGames({ white: 'Nobody' });
  assert(filterNoMatch.length === 0, 'searchGames non-matching: returns empty array');

  // Update game (INSERT OR REPLACE)
  const updated1 = sqliteArchive.saveGame(Object.assign({}, game1, { result: '1/2-1/2' }));
  const reGet1 = sqliteArchive.getGame(game1.id);
  assert(reGet1.result === '1/2-1/2', 'saveGame: successfully updated existing game result');

  sqliteArchive.close();

  // -------------------------------------------------------------
  // 4. JSON Storage Adapter Parity Verification
  // -------------------------------------------------------------
  console.log('\n--- 4. JSON Storage Adapter Parity ---');
  const jGame1 = jsonArchive.saveGame({
    white: 'Paul Morphy',
    black: 'Duke of Brunswick',
    date: '1858.11.02',
    result: '1-0',
    moves: ['e4', 'e5', 'Nf3', 'd6', 'd4', 'Bg4']
  });
  assert(jsonArchive.getGame(jGame1.id) !== null, 'jsonArchive: saveGame and getGame succeed');
  assert(jsonArchive.listGames().length === 1, 'jsonArchive: listGames returns 1 game');
  assert(jsonArchive.searchGames('Morphy').length === 1, 'jsonArchive: searchGames("Morphy") succeeds');
  jsonArchive.close();
  try { if (fs.existsSync(tmpJsonPath)) fs.unlinkSync(tmpJsonPath); } catch (_) {}

  // -------------------------------------------------------------
  // 5. Server API Endpoints
  // -------------------------------------------------------------
  console.log('\n--- 5. Server API Endpoints ---');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const prevAllowedOrigin = process.env.CHESS_ALLOWED_ORIGIN;
  process.env.CHESS_ALLOWED_ORIGIN = `http://localhost:${port},http://127.0.0.1:${port}`;

  try {
    // 5.1 POST /api/games
    const postRes = await fetch(`${baseUrl}/api/games`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        white: 'Garry Kasparov',
        black: 'Deep Blue',
        date: '1996.02.10',
        result: '0-1',
        eco: 'B22',
        moves: ['e4', 'c5', 'c3', 'd5']
      })
    });
    assert(postRes.status === 201, `POST /api/games: status 201 (got ${postRes.status})`);
    const postJson = await postRes.json();
    assert(postJson.ok === true && typeof postJson.id === 'string', 'POST /api/games: returned { ok: true, id }');
    const createdId = postJson.id;

    // 5.2 POST /api/games with bad body
    const badPostRes = await fetch(`${baseUrl}/api/games`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'invalid-json'
    });
    assert(badPostRes.status === 400, `POST /api/games invalid json: status 400 (got ${badPostRes.status})`);

    // 5.3 GET /api/games
    const listRes = await fetch(`${baseUrl}/api/games`);
    assert(listRes.status === 200, `GET /api/games: status 200 (got ${listRes.status})`);
    const listJson = await listRes.json();
    assert(listJson.ok === true && Array.isArray(listJson.games), 'GET /api/games: returns { ok: true, games: [...] }');
    assert(listJson.games.some(g => g.id === createdId), 'GET /api/games: contains the newly created game');

    // 5.4 GET /api/games?q=Kasparov
    const searchRes = await fetch(`${baseUrl}/api/games?q=Kasparov`);
    const searchJson = await searchRes.json();
    assert(searchJson.games.length >= 1 && searchJson.games[0].white === 'Garry Kasparov', 'GET /api/games?q=Kasparov: returns matching games');

    // 5.5 GET /api/games/:id
    const getRes = await fetch(`${baseUrl}/api/games/${createdId}`);
    assert(getRes.status === 200, `GET /api/games/:id: status 200 (got ${getRes.status})`);
    const getJson = await getRes.json();
    assert(getJson.ok === true && getJson.game.id === createdId, 'GET /api/games/:id: returned requested game');
    assert(getJson.game.black === 'Deep Blue', 'GET /api/games/:id: metadata preserved');

    // 5.6 GET /api/games/non-existent-id -> 404
    const notFoundRes = await fetch(`${baseUrl}/api/games/unknown-id-99999`);
    assert(notFoundRes.status === 404, `GET /api/games/:id unknown: status 404 (got ${notFoundRes.status})`);

    // 5.7 GET /api/games/:id/pgn
    const pgnRes = await fetch(`${baseUrl}/api/games/${createdId}/pgn`);
    assert(pgnRes.status === 200, `GET /api/games/:id/pgn: status 200 (got ${pgnRes.status})`);
    const ct = pgnRes.headers.get('content-type');
    assert(ct && ct.includes('application/x-chess-pgn'), `GET /api/games/:id/pgn: content-type application/x-chess-pgn (got "${ct}")`);
    const cd = pgnRes.headers.get('content-disposition');
    assert(cd && cd.includes(`filename="${createdId}.pgn"`), `GET /api/games/:id/pgn: attachment content-disposition set`);
    const pgnRaw = await pgnRes.text();
    assert(pgnRaw.includes('[White "Garry Kasparov"]') && pgnRaw.includes('1. e4 c5 2. c3 d5 0-1'), 'GET /api/games/:id/pgn: returned valid PGN text');

    // 5.8 GET /api/games/:id/pgn non-existent -> 404
    const pgnNotFoundRes = await fetch(`${baseUrl}/api/games/unknown-id-99999/pgn`);
    assert(pgnNotFoundRes.status === 404, `GET /api/games/:id/pgn unknown: status 404 (got ${pgnNotFoundRes.status})`);

    // 5.9 Static script serve for game-archive.js
    const scriptRes = await fetch(`${baseUrl}/game-archive.js`);
    assert(scriptRes.status === 200, `GET /game-archive.js in ALLOWED_FILES: status 200 (got ${scriptRes.status})`);
    const scriptCt = scriptRes.headers.get('content-type');
    assert(scriptCt && scriptCt.includes('application/javascript'), 'GET /game-archive.js: content-type application/javascript');

    // 5.10 CORS headers check on /api/games
    const corsRes = await fetch(`${baseUrl}/api/games`, {
      headers: { 'Origin': `http://localhost:${port}` }
    });
    assert(corsRes.headers.get('access-control-allow-origin') === `http://localhost:${port}`, 'CORS: echoes allowed origin header on /api/games');

  } finally {
    server.close();
    if (prevAllowedOrigin !== undefined) {
      process.env.CHESS_ALLOWED_ORIGIN = prevAllowedOrigin;
    } else {
      delete process.env.CHESS_ALLOWED_ORIGIN;
    }
  }

  // -------------------------------------------------------------
  // 6. Frontend DOM & Invariants
  // -------------------------------------------------------------
  console.log('\n--- 6. Frontend DOM & Architectural Invariants ---');
  const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

  assert(indexHtml.includes('id="game-archive-btn"'), 'index.html contains #game-archive-btn button');
  assert(indexHtml.includes('id="archive-modal"'), 'index.html contains #archive-modal container');
  assert(indexHtml.includes('id="games-table"'), 'index.html contains #games-table table element');
  assert(indexHtml.includes('id="import-pgn-modal"'), 'index.html contains #import-pgn-modal container');
  assert(indexHtml.includes('src="game-archive.js"'), 'index.html includes game-archive.js script tag');

  const uiSource = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');
  assert(!/makeMove\s*\(/.test(uiSource), 'ARCHITECTURAL INVARIANT: ui.js does NOT call makeMove(');
  assert(!/createInitialBoard\s*\(/.test(uiSource), 'ARCHITECTURAL INVARIANT: ui.js does NOT call createInitialBoard(');
  assert(uiSource.includes('loadGameArchiveList'), 'ui.js defines loadGameArchiveList');
  assert(uiSource.includes('viewArchivedGame'), 'ui.js defines viewArchivedGame');
  assert(uiSource.includes('setupGameArchiveUI'), 'ui.js defines setupGameArchiveUI');

  // Summary
  console.log(`\n========================================`);
  console.log(`P3 SQLite Self-Test Summary:`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test run error:', err);
  process.exit(1);
});
