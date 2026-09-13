'use strict';

// Cryptographic Player Seat Tokens and Spectator Security Module
// Manages tamper-proof session tokens for White, Black, and Spectator roles
// Prevents move hijacking in multi-seat games while preserving backward compatibility

const crypto = require('crypto');

const SEAT_TIMEOUT_MS = 60000; // 60s idle timeout for claimed seats

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
    return (Date.now() - seatInfo.lastSeen) > SEAT_TIMEOUT_MS;
  }

  generateToken() {
    return crypto.randomBytes(24).toString('hex');
  }

  /**
   * Claims a player seat ('white', 'black', or 'spectator')
   */
  claimSeat(roomId = 'default', role) {
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
      lastSeen: now
    };

    return { ok: true, role, token, roomId };
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
