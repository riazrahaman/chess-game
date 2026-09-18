'use strict';

// Cryptographic Player Seat Tokens and Spectator Security Module
// Manages tamper-proof session tokens for White, Black, and Spectator roles
// Prevents move hijacking in multi-seat games while preserving backward compatibility

const crypto = require('crypto');

const SEAT_TIMEOUT_MS = Number(process.env.CHESS_SEAT_TIMEOUT_MS) || 300000; // 5 min idle timeout for claimed seats

class SeatAuthManager {
  constructor() {
    // Map<roomId, { white: SeatInfo|null, black: SeatInfo|null, spectators: Map<string, number> }>
    this.rooms = new Map();
  }

  _getRoom(roomId = 'default') {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, {
        white: null,
        black: null,
        spectators: new Map()
      });
    }
    return this.rooms.get(roomId);
  }

  _isExpired(seatInfo) {
    if (!seatInfo) return true;
    if (seatInfo.isBot) return false;
    return (Date.now() - seatInfo.lastSeen) > SEAT_TIMEOUT_MS;
  }

  generateToken() {
    return crypto.randomBytes(24).toString('hex');
  }

  /**
   * Claims a player seat ('white', 'black', or 'spectator')
   */
  claimSeat(roomId = 'default', role, options = {}) {
    const isBot = typeof options === 'boolean' ? options : Boolean(options && options.isBot);
    // Wave 2 (R2): optional seat -> account link, resolved by the server from the
    // caller's auth session at claim time. Anonymous seats carry accountId null,
    // which rating-hook.js treats as "unrated".
    const account = (options && typeof options === 'object' && options.account) ? options.account : null;
    const accountId = account && (account.userId || account.id) ? String(account.userId || account.id) : null;
    const username = account && account.username ? String(account.username) : null;
    const room = this._getRoom(roomId);
    const now = Date.now();

    if (role === 'spectator') {
      const token = this.generateToken();
      room.spectators.set(token, now);
      return { ok: true, role: 'spectator', token, roomId };
    }

    if (role !== 'white' && role !== 'black') {
      return { ok: false, status: 400, error: 'Invalid seat role requested (must be white, black, or spectator)' };
    }

    const currentSeat = room[role];
    if (currentSeat && !this._isExpired(currentSeat)) {
      return { ok: false, status: 409, error: `Seat '${role}' is currently occupied` };
    }

    const token = this.generateToken();
    room[role] = {
      token,
      claimedAt: now,
      lastSeen: now,
      isBot,
      accountId,
      username
    };

    return { ok: true, role, token, roomId, accountId, username };
  }

  /**
   * Who holds each player seat, for the rating layer. Returns the stored link
   * regardless of idle expiry — identity at game end is what matters, not
   * activity — but always reports isBot. Never exposes tokens.
   */
  getSeatAccounts(roomId = 'default') {
    const room = this._getRoom(roomId);
    const view = seat => (seat ? {
      accountId: seat.accountId || null,
      username: seat.username || null,
      isBot: Boolean(seat.isBot),
      expired: this._isExpired(seat)
    } : null);
    return { white: view(room.white), black: view(room.black) };
  }

  /**
   * Releases an occupied seat
   */
  releaseSeat(roomId = 'default', token) {
    if (!token) return { ok: false, status: 400, error: 'Token is required' };
    const room = this._getRoom(roomId);

    if (room.white && room.white.token === token) {
      room.white = null;
      return { ok: true, released: 'white' };
    }
    if (room.black && room.black.token === token) {
      room.black = null;
      return { ok: true, released: 'black' };
    }
    if (room.spectators.has(token)) {
      room.spectators.delete(token);
      return { ok: true, released: 'spectator' };
    }

    return { ok: false, status: 404, error: 'No active seat found matching token' };
  }

  /**
   * Heartbeat to keep seat claim alive
   */
  heartbeat(roomId = 'default', token) {
    if (!token) return { ok: false, status: 400, error: 'Token is required' };
    const room = this._getRoom(roomId);
    const now = Date.now();

    if (room.white && room.white.token === token) {
      room.white.lastSeen = now;
      return { ok: true, role: 'white' };
    }
    if (room.black && room.black.token === token) {
      room.black.lastSeen = now;
      return { ok: true, role: 'black' };
    }
    if (room.spectators.has(token)) {
      room.spectators.set(token, now);
      return { ok: true, role: 'spectator' };
    }

    return { ok: false, status: 404, error: 'Seat session expired or invalid' };
  }

  /**
   * Validates if a token is authorized to execute a move for turn ('white' | 'black')
   */
  validateMove(roomId = 'default', token, currentTurn) {
    const room = this._getRoom(roomId);
    const claimedSeat = room[currentTurn];

    // Backward compatibility: If nobody has claimed the seat for current turn, allow open play
    if (!claimedSeat || this._isExpired(claimedSeat)) {
      return { ok: true, unseated: true };
    }

    // A seat is claimed for this side: caller must provide matching token
    if (!token) {
      return { ok: false, status: 401, error: `Seat '${currentTurn}' is reserved. Seat token required to move.` };
    }

    if (claimedSeat.token !== token) {
      return { ok: false, status: 403, error: `Unauthorized move: token does not match active '${currentTurn}' player seat.` };
    }

    // Refresh active seat timestamp
    claimedSeat.lastSeen = Date.now();
    return { ok: true, role: currentTurn };
  }

  /**
   * Validates if a token is authorized to mutate game state (reset, undo, draw, resign).
   * In unseated rooms (neither seat occupied), mutations are allowed for backward compatibility.
   * In seated rooms, mutations require a valid token belonging to an active seated player (white or black).
   * If requiredRole is specified ('white' or 'black'), the token must match that specific seat.
   */
  validateMutation(roomId = 'default', token, requiredRole = null) {
    const room = this._getRoom(roomId);
    const whiteActive = !!(room.white && !this._isExpired(room.white));
    const blackActive = !!(room.black && !this._isExpired(room.black));

    const humanWhiteActive = whiteActive && !room.white.isBot;
    const humanBlackActive = blackActive && !room.black.isBot;

    // Backward compatibility & Solo Bot Play:
    // If neither human player seat is occupied, allow open mutation (resets, undo, draw, resign)
    if (!humanWhiteActive && !humanBlackActive) {
      return { ok: true, unseated: true };
    }

    if (!token) {
      return { ok: false, status: 401, error: 'Authentication required: game has active player seats.' };
    }

    let matchedRole = null;
    if (whiteActive && room.white.token === token) {
      matchedRole = 'white';
      room.white.lastSeen = Date.now();
    } else if (blackActive && room.black.token === token) {
      matchedRole = 'black';
      room.black.lastSeen = Date.now();
    }

    if (!matchedRole) {
      return { ok: false, status: 403, error: 'Unauthorized mutation: token is not an active seated player.' };
    }

    if (requiredRole && requiredRole !== matchedRole) {
      return { ok: false, status: 403, error: `Unauthorized mutation: token belongs to '${matchedRole}', but '${requiredRole}' is required.` };
    }

    return { ok: true, role: matchedRole };
  }

  getRole(roomId = 'default', token) {
    if (!token) return null;
    const room = this._getRoom(roomId);
    if (room.white && room.white.token === token && !this._isExpired(room.white)) return 'white';
    if (room.black && room.black.token === token && !this._isExpired(room.black)) return 'black';
    if (room.spectators.has(token)) return 'spectator';
    return null;
  }

  /**
   * Returns current seat occupancy status
   */
  getStatus(roomId = 'default') {
    const room = this._getRoom(roomId);
    return {
      whiteOccupied: !!(room.white && !this._isExpired(room.white)),
      blackOccupied: !!(room.black && !this._isExpired(room.black)),
      spectatorsCount: room.spectators.size
    };
  }

  /**
   * Resets all seats for a room
   */
  resetSeats(roomId = 'default') {
    this.rooms.delete(roomId);
  }
}

const seatAuthManager = new SeatAuthManager();

module.exports = {
  SeatAuthManager,
  seatAuthManager
};
