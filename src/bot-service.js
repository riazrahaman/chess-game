'use strict';

/**
 * bot-service.js
 * C5: Play vs Computer (Levels 1–8 AI Opponent Bot)
 * Autonomous bot opponent using local heuristic engine with strength levels,
 * humanized think delays, flavor commentary, and referee integration.
 */

const stockfishWorker = require('./stockfish-worker.js');
const rulesEngine = require('./rules-engine.js');
const openingsDb = require('./openings-db.js');

const BOT_LEVELS = {
  1: { level: 1, name: 'Novice Bot', rating: 800, depth: 1, blunderRate: 0.35, greeting: 'Hi! Let’s have a fun match!' },
  2: { level: 2, name: 'Apprentice Bot', rating: 1000, depth: 1, blunderRate: 0.20, greeting: 'Watch out for my knights!' },
  3: { level: 3, name: 'Club Player Bot', rating: 1200, depth: 2, blunderRate: 0.10, greeting: 'Let’s battle for the center.' },
  4: { level: 4, name: 'Tactician Bot', rating: 1400, depth: 2, blunderRate: 0.02, greeting: 'I’m watching every tactical pin and fork.' },
  5: { level: 5, name: 'Expert Bot', rating: 1600, depth: 3, blunderRate: 0.00, greeting: 'Solid openings and precise calculation.' },
  6: { level: 6, name: 'Master Bot', rating: 1800, depth: 3, blunderRate: 0.00, greeting: 'Preparing a deep positional strategy.' },
  7: { level: 7, name: 'International Master Bot', rating: 2000, depth: 4, blunderRate: 0.00, greeting: 'Calculation initiated. Every tempo counts.' },
  8: { level: 8, name: 'Grandmaster Bot', rating: 2200, depth: 4, blunderRate: 0.00, greeting: 'Grandmaster mode engaged. Maximum precision.' }
};

class BotService {
  constructor(seatAuthManager) {
    this.seatAuth = seatAuthManager;
    this.rooms = new Map(); // roomId -> { enabled, level, color, token, thinking }
  }

  getBotConfig(roomId = 'default') {
    const config = this.rooms.get(roomId);
    if (!config || !config.enabled) {
      return { enabled: false, level: 3, color: 'black', name: 'Bot (Inactive)' };
    }
    const info = BOT_LEVELS[config.level] || BOT_LEVELS[3];
    return {
      enabled: true,
      level: config.level,
      color: config.color,
      name: `${info.name} (${info.rating})`,
      rating: info.rating
    };
  }

  setBotConfig(roomId = 'default', options = {}) {
    const enabled = options.enabled === true;
    const level = Math.max(1, Math.min(8, parseInt(options.level, 10) || 3));
    const color = options.color === 'white' ? 'white' : 'black';

    const existing = this.rooms.get(roomId);
    if (existing && existing.token && this.seatAuth && (!enabled || existing.color !== color)) {
      try { this.seatAuth.releaseSeat(roomId, existing.token); } catch (_) {}
    }

    if (!enabled) {
      this.rooms.delete(roomId);
      return { ok: true, enabled: false };
    }

    let token = null;
    if (this.seatAuth) {
      // Claim the seat for the bot so human spectators cannot override bot turns
      const claim = this.seatAuth.claimSeat(roomId, color, { isBot: true });
      if (claim.ok) {
        token = claim.token;
      } else {
        // Seat might already belong to the bot or be open
        const currentSeat = this.seatAuth._getRoom(roomId)[color];
        if (currentSeat && !this.seatAuth._isExpired(currentSeat)) {
          currentSeat.isBot = true;
          token = currentSeat.token;
        }
      }
    }

    const state = {
      enabled: true,
      level,
      color,
      token,
      thinking: false
    };
    this.rooms.set(roomId, state);

    return {
      ok: true,
      ...this.getBotConfig(roomId)
    };
  }

  computeBotMove(fen, level = 3, moveHistory = []) {
    const profile = BOT_LEVELS[level] || BOT_LEVELS[3];
    const parsed = typeof fen === 'string' ? stockfishWorker.parseFen(fen) : fen;
    if (!parsed) return null;

    const candidateMoves = stockfishWorker.generateCandidateMoves(parsed);
    if (!candidateMoves || candidateMoves.length === 0) return null;

    const fenStr = typeof fen === 'string' ? fen : (rulesEngine ? rulesEngine.boardToFen(fen) : '');
    const isStartPos = fenStr.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR');

    // 1. Opening book check (first 10 plies)
    if (openingsDb && typeof openingsDb.findOpening === 'function') {
      const history = Array.isArray(moveHistory) ? moveHistory : [];
      const canConsultBook = history.length > 0 ? (history.length < 10) : isStartPos;
      if (canConsultBook) {
        const opening = openingsDb.findOpening(history);
        if (opening && opening.popularMoves && opening.popularMoves.length > 0) {
          const isExactMatch = opening.isExact || (history.length === 0 && isStartPos);
          if (isExactMatch) {
            const followBook = profile.blunderRate === 0 || Math.random() > profile.blunderRate;
            if (followBook) {
              const bookCandidates = level >= 5
                ? [opening.popularMoves[0].uci]
                : opening.popularMoves.map(m => m.uci);

              const chosenBookMove = bookCandidates.find(bm => candidateMoves.some(m => m.uci === bm));
              if (chosenBookMove) {
                return chosenBookMove;
              }
            }
          }
        }
      }
    }

    // 2. Check blunder roll for lower difficulty levels
    if (profile.blunderRate > 0 && Math.random() < profile.blunderRate && candidateMoves.length > 1) {
      const randomIndex = Math.floor(Math.random() * candidateMoves.length);
      return candidateMoves[randomIndex].uci;
    }

    // 3. Engine calculation with profile's configured depth
    const searchResult = stockfishWorker.findBestMove(parsed, { depth: profile.depth });
    if (searchResult && searchResult.bestMove && candidateMoves.some(m => m.uci === searchResult.bestMove)) {
      return searchResult.bestMove;
    }

    return candidateMoves[0].uci;
  }

  getFlavorCommentary(level, eventType) {
    const profile = BOT_LEVELS[level] || BOT_LEVELS[3];
    if (eventType === 'start') {
      return profile.greeting;
    }
    if (eventType === 'win') {
      return level >= 5 ? 'Checkmate. Well played, thank you for the game.' : 'Good game! That was exciting!';
    }
    if (eventType === 'loss') {
      return level >= 5 ? 'Impressive attack. You played that masterfully.' : 'Good job! You got me!';
    }
    return null;
  }

  triggerBotMoveIfNeeded(roomId = 'default', referee, broadcastCallback) {
    const config = this.rooms.get(roomId);
    if (!config || !config.enabled || config.thinking) return false;

    const ref = referee.getReferee(roomId);
    if (!ref || !ref.state || ref.state.gameOver) return false;

    const currentTurn = (ref.state.board && ref.state.board.turn) || 'white';
    if (currentTurn !== config.color) return false;

    config.thinking = true;
    const thinkDelay = 200 + Math.floor(Math.random() * 250);

    setTimeout(async () => {
      try {
        const freshRef = referee.getReferee(roomId);
        if (!freshRef || !freshRef.state || freshRef.state.gameOver) {
          config.thinking = false;
          return;
        }
        if (freshRef.state.board.turn !== config.color) {
          config.thinking = false;
          return;
        }

        const fen = freshRef.state.fen || rulesEngine.boardToFen(freshRef.state.board);
        const history = (freshRef.state && Array.isArray(freshRef.state.history)) ? freshRef.state.history : [];
        const botMove = this.computeBotMove(fen, config.level, history);

        if (botMove) {
          const cmdId = 'bot-' + config.color + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
          const result = await freshRef.enqueue({
            id: cmdId,
            type: 'move',
            args: { move: botMove }
          });

          if (result && result.ok) {
            // Post flavor chat commentary on game end or first bot move
            if (freshRef.state.gameOver) {
              const won = (freshRef.state.result === '1-0' && config.color === 'white') ||
                          (freshRef.state.result === '0-1' && config.color === 'black');
              const comment = this.getFlavorCommentary(config.level, won ? 'win' : 'loss');
              if (comment && typeof freshRef.addChatMessage === 'function') {
                const msg = freshRef.addChatMessage(BOT_LEVELS[config.level].name, comment);
                if (broadcastCallback) broadcastCallback('chat', msg);
              }
            } else if (freshRef.state.history && freshRef.state.history.length <= 2) {
              const greeting = this.getFlavorCommentary(config.level, 'start');
              if (greeting && typeof freshRef.addChatMessage === 'function') {
                const msg = freshRef.addChatMessage(BOT_LEVELS[config.level].name, greeting);
                if (broadcastCallback) broadcastCallback('chat', msg);
              }
            }

            if (broadcastCallback) broadcastCallback('state');
          }
        }
      } catch (err) {
        console.error('Error executing bot move:', err);
      } finally {
        config.thinking = false;
      }
    }, thinkDelay);

    return true;
  }
}

module.exports = {
  BotService,
  BOT_LEVELS
};
