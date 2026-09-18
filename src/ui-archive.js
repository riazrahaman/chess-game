'use strict';
// ui-archive.js — SQLite Game Archive & PGN Library UI extracted from ui.js.
// Loaded as a classic <script> before ui.js. Shares global scope.
// Depends on: liveHistory, liveBoard, moveHistory, historyPositions, viewedPly,
//             sanListFromPositions, buildPgn, pgnResultToken, positionsToHistorySnapshots, livePositions,
//             jumpToPly, updateHistoryUI, updateScrubberButtons,
//             renderBoard, showUiError, runRefereeCommand, withRoomParam,
//             getAuthHeaders, pollReferee, statusElement (all from ui.js / engine.js).

let lastAutoSavedGameId = null;
let viewingArchivedGame = false;
let savedLiveStateBeforeArchive = null;

async function autoSaveFinishedGame(state) {
  if (!state || !state.gameOver || !liveHistory || liveHistory.length === 0) return;
  const gameSignature = `${state.result || '*'}:${liveHistory.join(',')}`;
  if (lastAutoSavedGameId === gameSignature) return;
  lastAutoSavedGameId = gameSignature;

  const rawHistory = liveHistory;
  const sanList = sanListFromPositions(livePositions, rawHistory);
  const resultToken = pgnResultToken();
  const pgnText = buildPgn(sanList, resultToken);

  try {
    await fetch('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        white: 'White',
        black: 'Black',
        result: resultToken,
        moves: rawHistory,
        pgn: pgnText
      })
    });
  } catch (err) {
    console.warn('Auto-save game archive failed:', err);
  }
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function loadGameArchiveList(query) {
  if (query === undefined) query = '';
  const tableBody = document.getElementById('games-table-body');
  const statusMsg = document.getElementById('archive-status-msg');
  if (statusMsg) statusMsg.textContent = 'Loading archive...';

  try {
    const url = query ? `/api/games?q=${encodeURIComponent(query)}` : '/api/games';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const games = data.games || [];

    if (!tableBody) return;
    tableBody.innerHTML = '';

    if (games.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 16px; color: #64748b;">No games found.</td></tr>';
      if (statusMsg) statusMsg.textContent = query ? 'No matching games found.' : 'No saved games yet.';
      return;
    }

    for (const game of games) {
      const tr = document.createElement('tr');
      const movesCount = game.moves ? game.moves.trim().split(/\s+/).filter(Boolean).length : 0;
      const movesDisplay = movesCount > 0 ? `${Math.ceil(movesCount / 2)} moves` : '-';

      tr.innerHTML = `
        <td style="padding: 6px 8px;">${escapeHtml(game.date || '-')}</td>
        <td style="padding: 6px 8px; font-weight: 500;">${escapeHtml(game.white || 'White')}</td>
        <td style="padding: 6px 8px; font-weight: 500;">${escapeHtml(game.black || 'Black')}</td>
        <td style="padding: 6px 8px;"><span style="display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 0.75rem; background: rgba(0,0,0,0.06); font-family: monospace;">${escapeHtml(game.result || '*')}</span></td>
        <td style="padding: 6px 8px; font-family: monospace;">${escapeHtml(game.eco || '-')}</td>
        <td style="padding: 6px 8px; color: #64748b;">${escapeHtml(movesDisplay)}</td>
        <td style="padding: 6px 8px; text-align: right; white-space: nowrap;">
          <button type="button" class="archive-view-btn" data-id="${escapeHtml(game.id)}" style="padding: 2px 8px; margin-right: 4px; font-size: 0.8rem; cursor: pointer;">View</button>
          <button type="button" class="archive-download-btn" data-id="${escapeHtml(game.id)}" style="padding: 2px 8px; margin-right: 4px; font-size: 0.8rem; cursor: pointer;">PGN</button>
          <button type="button" class="archive-reload-btn" data-id="${escapeHtml(game.id)}" style="padding: 2px 8px; font-size: 0.8rem; cursor: pointer;">Load</button>
        </td>
      `;
      tableBody.appendChild(tr);
    }

    tableBody.querySelectorAll('.archive-view-btn').forEach(btn => {
      btn.onclick = () => viewArchivedGame(btn.dataset.id);
    });
    tableBody.querySelectorAll('.archive-download-btn').forEach(btn => {
      btn.onclick = () => downloadArchivedGamePgn(btn.dataset.id);
    });
    tableBody.querySelectorAll('.archive-reload-btn').forEach(btn => {
      btn.onclick = () => reloadArchivedGameOntoBoard(btn.dataset.id);
    });

    if (statusMsg) statusMsg.textContent = `Showing ${games.length} game${games.length === 1 ? '' : 's'}`;
  } catch (err) {
    if (statusMsg) statusMsg.textContent = `Failed to load games: ${err.message}`;
  }
}

async function viewArchivedGame(gameId) {
  try {
    const res = await fetch(`/api/games/${encodeURIComponent(gameId)}`);
    if (!res.ok) throw new Error(`Failed to fetch game details: ${res.status}`);
    const data = await res.json();
    const game = data.game;
    if (!game) return;

    let uciMoves = [];
    if (game.moves) {
      const split = game.moves.trim().split(/\s+/).filter(Boolean);
      if (split.length > 0 && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(split[0])) {
        uciMoves = split;
      }
    }

    if (uciMoves.length === 0 && game.pgn) {
      const chessClass = (typeof Chess !== 'undefined' ? Chess : (typeof window !== 'undefined' && window.Chess ? window.Chess : null));
      if (chessClass) {
        try {
          const c = new chessClass();
          c.loadPgn(game.pgn);
          uciMoves = c.history({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''));
        } catch (_) {}
      }
    }

    if (!viewingArchivedGame) {
      savedLiveStateBeforeArchive = {
        history: liveHistory.slice(),
        board: liveBoard,
        moves: moveHistory.slice(),
        positions: historyPositions.slice(),
        livePositions: livePositions.slice(),
        viewedPly
      };
    }
    viewingArchivedGame = true;

    liveHistory = uciMoves.slice();
    // B3: the server ships per-ply positions for archived games too.
    livePositions = Array.isArray(game.positions) ? game.positions : [];
    const sanHistory = sanListFromPositions(livePositions, uciMoves);
    const moves = [];
    for (let i = 0; i < uciMoves.length; i += 2) {
      moves.push({
        whiteMove: sanHistory[i],
        blackMove: sanHistory[i + 1] || '',
        raw: uciMoves[i],
        rawBlack: uciMoves[i + 1] || ''
      });
    }
    moveHistory = moves;
    historyPositions = positionsToHistorySnapshots(livePositions);
    jumpToPly(0);
    updateHistoryUI();
    if (statusElement) {
      statusElement.textContent = `Viewing archive: ${game.white} vs ${game.black} (${game.result || '*'})`;
      statusElement.style.color = '#0284c7';
    }

    const modal = document.getElementById('archive-modal');
    if (modal) modal.classList.add('hidden');
  } catch (err) {
    showUiError(`Could not view game: ${err.message}`);
  }
}

function exitArchivedGameView() {
  if (!viewingArchivedGame || !savedLiveStateBeforeArchive) return;
  viewingArchivedGame = false;
  liveHistory = savedLiveStateBeforeArchive.history;
  liveBoard = savedLiveStateBeforeArchive.board;
  moveHistory = savedLiveStateBeforeArchive.moves;
  historyPositions = savedLiveStateBeforeArchive.positions;
  livePositions = savedLiveStateBeforeArchive.livePositions || [];
  viewedPly = savedLiveStateBeforeArchive.viewedPly;
  savedLiveStateBeforeArchive = null;
  renderBoard();
  updateHistoryUI();
  updateScrubberButtons();
  if (statusElement) {
    statusElement.textContent = 'Returned to live game';
    statusElement.style.color = '';
  }
}

function downloadArchivedGamePgn(gameId) {
  const link = document.createElement('a');
  link.href = `/api/games/${encodeURIComponent(gameId)}/pgn`;
  link.download = `${gameId}.pgn`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

async function reloadArchivedGameOntoBoard(gameId) {
  try {
    const res = await fetch(`/api/games/${encodeURIComponent(gameId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const game = data.game;
    if (!game) return;

    let uciMoves = [];
    if (game.moves) {
      const split = game.moves.trim().split(/\s+/).filter(Boolean);
      if (split.length > 0 && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(split[0])) {
        uciMoves = split;
      }
    }
    if (uciMoves.length === 0 && game.pgn) {
      const chessClass = (typeof Chess !== 'undefined' ? Chess : (typeof window !== 'undefined' && window.Chess ? window.Chess : null));
      if (chessClass) {
        try {
          const c = new chessClass();
          c.loadPgn(game.pgn);
          uciMoves = c.history({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''));
        } catch (_) {}
      }
    }

    const resetSuccess = await runRefereeCommand('Resetting referee', () =>
      fetch(withRoomParam('/api/reset'), {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ id: 'reset-archive:' + Date.now() })
      })
    );
    if (!resetSuccess) {
      throw new Error('Failed to reset referee state');
    }

    for (let i = 0; i < uciMoves.length; i++) {
      const move = uciMoves[i];
      const moveRes = await fetch(withRoomParam('/api/move'), {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ move, id: `archive:${gameId}:${i}:${Date.now()}` })
      });
      if (!moveRes.ok) {
        const errPayload = await moveRes.json().catch(() => ({}));
        throw new Error(`Move ${i + 1} (${move}) failed: ${errPayload.error || moveRes.status}`);
      }
    }

    const modal = document.getElementById('archive-modal');
    if (modal) modal.classList.add('hidden');
    if (statusElement) {
      statusElement.textContent = `Loaded game onto board (${uciMoves.length} moves)`;
      statusElement.style.color = '#10b981';
    }
    pollReferee();
  } catch (err) {
    showUiError(`Could not reload game onto board: ${err.message}`);
  }
}

function setupGameArchiveUI() {
  const archiveBtn = document.getElementById('game-archive-btn');
  const archiveModal = document.getElementById('archive-modal');
  const closeArchiveBtn = document.getElementById('close-archive-btn');
  const searchInput = document.getElementById('archive-search-input');
  const searchBtn = document.getElementById('archive-search-btn');
  const refreshBtn = document.getElementById('archive-refresh-btn');

  const importModal = document.getElementById('import-pgn-modal');
  const openImportBtn = document.getElementById('open-import-pgn-btn');
  const closeImportBtn = document.getElementById('close-import-pgn-btn');
  const cancelImportBtn = document.getElementById('cancel-import-pgn-btn');
  const submitImportBtn = document.getElementById('submit-import-pgn-btn');
  const importTextarea = document.getElementById('import-pgn-textarea');
  const importStatus = document.getElementById('import-pgn-status');

  if (archiveBtn && archiveModal) {
    archiveBtn.onclick = () => {
      archiveModal.classList.remove('hidden');
      loadGameArchiveList(searchInput ? searchInput.value : '');
    };
  }

  if (closeArchiveBtn && archiveModal) {
    closeArchiveBtn.onclick = () => archiveModal.classList.add('hidden');
  }

  if (searchBtn && searchInput) {
    searchBtn.onclick = () => loadGameArchiveList(searchInput.value);
  }

  if (searchInput) {
    searchInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        loadGameArchiveList(searchInput.value);
      }
    };
  }

  if (refreshBtn) {
    refreshBtn.onclick = () => {
      if (searchInput) searchInput.value = '';
      loadGameArchiveList('');
    };
  }

  if (openImportBtn && importModal) {
    openImportBtn.onclick = () => {
      importModal.classList.remove('hidden');
      if (importStatus) importStatus.textContent = '';
      if (importTextarea) importTextarea.focus();
    };
  }

  const closeImport = () => {
    if (importModal) importModal.classList.add('hidden');
  };

  if (closeImportBtn) closeImportBtn.onclick = closeImport;
  if (cancelImportBtn) cancelImportBtn.onclick = closeImport;

  if (submitImportBtn && importTextarea) {
    submitImportBtn.onclick = async () => {
      const pgn = importTextarea.value.trim();
      if (!pgn) {
        if (importStatus) {
          importStatus.textContent = 'Please paste a PGN string.';
          importStatus.style.color = '#dc2626';
        }
        return;
      }
      if (importStatus) {
        importStatus.textContent = 'Saving game to library...';
        importStatus.style.color = '#2563eb';
      }

      try {
        const res = await fetch('/api/games', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pgn })
        });
        const result = await res.json();
        if (!res.ok || !result.ok) {
          throw new Error(result.error || 'Failed to save game');
        }
        if (importStatus) {
          importStatus.textContent = 'Game saved successfully!';
          importStatus.style.color = '#16a34a';
        }
        importTextarea.value = '';
        setTimeout(() => {
          closeImport();
          loadGameArchiveList();
        }, 600);
      } catch (err) {
        if (importStatus) {
          importStatus.textContent = `Error: ${err.message}`;
          importStatus.style.color = '#dc2626';
        }
      }
    };
  }
}