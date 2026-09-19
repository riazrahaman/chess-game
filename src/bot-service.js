'use strict';

/**
 * bot-service.js
 * C5: Play vs Computer (Levels 1–8 AI Opponent Bot)
 * Autonomous bot opponent driven by Stockfish 19 lite (engine-server.js,
 * worker thread) with the PST heuristic engine as fallback, strength levels,
 * humanized think delays, flavor commentary, and referee integration.
 */

const stockfishWorker = require('./stockfish-worker.js');
const rulesEngine = require('./rules-engine.js');
// Opening book (L1–L4): named lines from data/openings.tsv (lichess
// chess-openings, CC0) via openings-explorer.js. Loaded once at require time so
// the server pays the ~1 s SAN→UCI conversion at boot, not on the first move.
const openingsExplorer = require('./openings-explorer.js');
const BOOK_LOADED = openingsExplorer.ensureDefaultLoaded();
const maiaBot = require('./maia-bot.js');
const playCoach = require('./play-coach.js');
let engineServer = null;
try {
  engineServer = require('./engine-server.js');
} catch (_) {
  engineServer = null; // vendored engine missing: PST fallback only
}

// E1b/E2 — the ladder is implemented on the real engine (Stockfish 19 lite,
// `engine-server.js`, in a worker thread). Per level we set either
// `Skill Level` (0–20, L1–L3) or `UCI_LimitStrength` + `UCI_Elo` (L4–L8),
// plus a depth/movetime cap so the server stays responsive.
//
// `rating` values are "~" ESTIMATES. L4–L8 quote the UCI_Elo target we hand
// Stockfish. That option is calibrated by the Stockfish team for the
// full-strength engine at roughly classical time controls; the 1 MB "lite"
// net searching for <= 600 ms is somewhat weaker than the number it targets,
// so treat these as upper bounds until measured against real players.
// L1–L3 use Skill Level at a fixed shallow depth (Skill 0 at depth 1 is far
// below the 1320 floor of UCI_Elo) and are rough guesses.
//
// `blunderRate` (a uniformly random legal move, rolled in this file) is kept
// only for L1–L2 to mimic the "hangs a piece" errors of true beginners.
// `useBook`: consult the opening book (L1–L4 only, first 10 plies). The book is
// the set of named lines in data/openings.tsv; the pick is uniform over the
// lines that extend the current move sequence — there are no popularity
// weights because the dataset has none (roadmap E3). Real-engine levels just
// play the engine's move.
const BOT_LEVELS = {
  1: { level: 1, name: 'Novice Bot', rating: 800, skill: 0, elo: null, depth: 1, movetime: null, blunderRate: 0.10, useBook: true, greeting: 'Hi! Let’s have a fun match!' },
  2: { level: 2, name: 'Apprentice Bot', rating: 1000, skill: 2, elo: null, depth: 2, movetime: null, blunderRate: 0.04, useBook: true, greeting: 'Watch out for my knights!' },
  3: { level: 3, name: 'Casual Bot', rating: 1200, skill: 5, elo: null, depth: 4, movetime: null, blunderRate: 0, useBook: true, greeting: 'Let’s battle for the center.' },
  4: { level: 4, name: 'Club Bot', rating: 1400, skill: null, elo: 1400, depth: null, movetime: 300, blunderRate: 0, useBook: true, greeting: 'I’m watching every tactical pin and fork.' },
  5: { level: 5, name: 'Tactician Bot', rating: 1600, skill: null, elo: 1600, depth: null, movetime: 400, blunderRate: 0, useBook: false, greeting: 'Solid openings and steady calculation.' },
  6: { level: 6, name: 'Strong Club Bot', rating: 1800, skill: null, elo: 1800, depth: null, movetime: 500, blunderRate: 0, useBook: false, greeting: 'Preparing a positional plan.' },
  7: { level: 7, name: 'Advanced Bot', rating: 2000, skill: null, elo: 2000, depth: null, movetime: 600, blunderRate: 0, useBook: false, greeting: 'Calculation initiated. Every tempo counts.' },
  8: { level: 8, name: 'Expert Bot', rating: 2300, skill: null, elo: 2300, depth: null, movetime: 600, blunderRate: 0, useBook: false, greeting: 'Maximum precision. Stockfish 19 at ~2300.' },
  // Wave 4: Maia rating-matched human-like bots
  'maia-1100': { level: 'maia-1100', name: 'Maia 1100', rating: 1100, maiaRating: 1100, isMaia: true, blunderRate: 0, useBook: true, greeting: 'Hello! I am Maia 1100, calibrated to human beginner play.' },
  'maia-1500': { level: 'maia-1500', name: 'Maia 1500', rating: 1500, maiaRating: 1500, isMaia: true, blunderRate: 0, useBook: true, greeting: 'Hello! I am Maia 1500, calibrated to club player human play.' },
  'maia-1900': { level: 'maia-1900', name: 'Maia 1900', rating: 1900, maiaRating: 1900, isMaia: true, blunderRate: 0, useBook: true, greeting: 'Hello! I am Maia 1900, calibrated to advanced human play.' }
};
// Search cap for the legacy PST fallback engine (`stockfish-worker.js`), used
// only when the real engine is unavailable or rejects.
const PST_FALLBACK_DEPTH = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 3, 7: 4, 8: 4 };

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
      name: `${info.name} (~${info.rating})`,
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
    if (this.seatAuth) {
      const room = this.seatAuth._getRoom(roomId);
      if (!enabled) {
        if (room.white && room.white.isBot) room.white = null;
        if (room.black && room.black.isBot) room.black = null;
      } else {
        const otherColor = color === 'white' ? 'black' : 'white';
        if (room[otherColor] && room[otherColor].isBot) room[otherColor] = null;
      }
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

    // Warm the real engine so its one-time init overlaps the human's first move.
    if (engineServer && engineServer.isAvailable()) {
      engineServer.getEngine().ready().catch(() => {});
    }

    return {
      ok: true,
      ...this.getBotConfig(roomId)
    };
  }

  /**
   * Uniform pick among the TSV lines that extend `history`; returns that
   * line's next move when legal, else null. Pure w.r.t. game state (Gate 4:
   * reads the book only). `isLegal(uci)` is supplied by the caller.
   */
  static pickBookMove(history, isLegal) {
    const lines = openingsExplorer.linesExtending(history);
    if (!lines.length) return null;
    const line = lines[Math.floor(Math.random() * lines.length)];
    const candidate = line.moves[history.length];
    if (!candidate || (typeof isLegal === 'function' && !isLegal(candidate))) return null;
    return candidate;
  }

  /**
   * Pick the bot's move for `fen` at `level`. Async: the real engine runs in
   * a worker thread. Resolves to a UCI string or null when no legal move.
   * Order: opening book (L1–L4, first 10 plies) → blunder roll (L1–L2) →
   * Stockfish 19 via engine-server.js → PST fallback (stockfish-worker.js).
   */
  async computeBotMove(fen, level = 3, moveHistory = []) {
    const profile = BOT_LEVELS[level] || BOT_LEVELS[3];
    const parsed = typeof fen === 'string' ? stockfishWorker.parseFen(fen) : fen;
    if (!parsed) return null;

    const candidateMoves = stockfishWorker.generateCandidateMoves(parsed);
    if (!candidateMoves || candidateMoves.length === 0) return null;
    const isLegal = (uci) => candidateMoves.some(m => m.uci === uci);

    const fenStr = typeof fen === 'string' ? fen : (rulesEngine ? rulesEngine.boardToFen(fen) : '');
    const isStartPos = fenStr.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR');

    // 1. Opening book (L1–L4 only, first 10 plies): pick one TSV line
    //    uniformly among those extending the game so far and play its next
    //    move. Only positions reached from the standard start have a history
    //    the TSV can extend; an empty history off the start position is skipped.
    if (profile.useBook && BOOK_LOADED) {
      const history = Array.isArray(moveHistory) ? moveHistory : [];
      const canConsultBook = history.length > 0 ? (history.length < 10) : isStartPos;
      if (canConsultBook) {
        const bookMove = BotService.pickBookMove(history, isLegal);
        if (bookMove) return bookMove;
      }
    }

    // 2. Blunder roll (L1–L2): a uniformly random legal move.
    if (profile.blunderRate > 0 && Math.random() < profile.blunderRate && candidateMoves.length > 1) {
      return candidateMoves[Math.floor(Math.random() * candidateMoves.length)].uci;
    }

    // 2.5 Maia Human-Like Bot: evaluate move probabilities according to learned human policy
    if (profile.isMaia) {
      const legalUcis = candidateMoves.map(m => m.uci);
      const chosen = maiaBot.selectMaiaMove(legalUcis, profile.maiaRating);
      if (chosen && chosen.move && isLegal(chosen.move)) {
        return chosen.move;
      }
    }

    // 3. Real engine. Any rejection (missing vendor files, crash, timeout)
    //    falls through to the PST path so the bot never stalls.
    if (engineServer && engineServer.isAvailable()) {
      try {
        const opts = {};
        if (profile.depth !== null) opts.depth = profile.depth;
        if (profile.movetime !== null) opts.movetime = profile.movetime;
        if (profile.elo !== null) opts.elo = profile.elo;
        if (profile.skill !== null) opts.skill = profile.skill;
        const result = await engineServer.analyse(fenStr, opts);
        if (result && result.bestMove && isLegal(result.bestMove)) {
          return result.bestMove;
        }
      } catch (err) {
        if (!this._warnedEngine) {
          this._warnedEngine = true;
          console.warn('bot-service: real engine unavailable, using PST fallback:', err && err.message);
        }
      }
    }

    // 4. PST fallback (legacy heuristic engine, much weaker than the labels).
    const searchResult = stockfishWorker.findBestMove(parsed, { depth: PST_FALLBACK_DEPTH[profile.level] || 2 });
    if (searchResult && searchResult.bestMove && isLegal(searchResult.bestMove)) {
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
        const botMove = await this.computeBotMove(fen, config.level, history);

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
  BOT_LEVELS,
  PST_FALLBACK_DEPTH,
  PlayCoach: playCoach
};
