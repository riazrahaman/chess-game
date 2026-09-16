'use strict';

const DEFAULT_RATING = 1500;
const DEFAULT_TOLERANCE = 200;
const DEFAULT_TIME_CONTROL = 'rapid';
const DEFAULT_SEED = 'chess-lobby-default-seed';
const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function seedToUint32(seed) {
  const text = String(seed);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createSeededRng(seed = DEFAULT_SEED) {
  let state = seedToUint32(seed) || 0x6d2b79f5;
  return function seededRandom() {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizePlayerId(playerId) {
  if (playerId && typeof playerId === 'object') {
    playerId = playerId.playerId == null ? playerId.id : playerId.playerId;
  }
  if (playerId == null || String(playerId).trim() === '') {
    throw new TypeError('player id must be a non-empty value');
  }
  return String(playerId);
}

function normalizeTimeControl(timeControl) {
  const value = timeControl == null ? DEFAULT_TIME_CONTROL : String(timeControl).trim().toLowerCase();
  return value || DEFAULT_TIME_CONTROL;
}

function normalizeTolerance(value, fallback = DEFAULT_TOLERANCE) {
  const tolerance = Number(value);
  return Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : fallback;
}

function isValidRoomId(roomId) {
  return typeof roomId === 'string' && ROOM_ID_PATTERN.test(roomId);
}

function copy(value) {
  return value ? { ...value } : null;
}

class LobbyStore {
  constructor(options = {}) {
    this.ratingsStore = options.ratingsStore || null;
    this.defaultRating = Number.isFinite(options.defaultRating) ? options.defaultRating : DEFAULT_RATING;
    this.defaultTolerance = normalizeTolerance(options.ratingTolerance, DEFAULT_TOLERANCE);
    this.rng = typeof options.rng === 'function'
      ? options.rng
      : createSeededRng(Object.prototype.hasOwnProperty.call(options, 'seed') ? options.seed : DEFAULT_SEED);
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.seeks = new Map();
    this.challenges = new Map();
    this.pairings = new Map();
    this.sequence = 0;
  }

  _nextId(prefix) {
    this.sequence++;
    return `${prefix}-${this.sequence}`;
  }

  _ratingFor(playerId, timeControl, suppliedRating) {
    if (Number.isFinite(suppliedRating)) return suppliedRating;
    if (this.ratingsStore && typeof this.ratingsStore.getPlayer === 'function') {
      try {
        const player = this.ratingsStore.getPlayer(timeControl, playerId);
        if (player && Number.isFinite(player.rating)) return player.rating;
      } catch (_) {}
    }
    return this.defaultRating;
  }

  _closePlayerSeeks(playerId, reason) {
    for (const seek of this.seeks.values()) {
      if (seek.playerId === playerId && seek.status === 'open') {
        seek.status = 'closed';
        seek.closedReason = reason;
        seek.closedAt = this.now();
      }
    }
  }

  _createPairing(playerA, playerB, options = {}) {
    const generatedRoomId = this._nextId('match');
    const roomId = options.roomId == null ? generatedRoomId : String(options.roomId);
    if (!isValidRoomId(roomId)) throw new TypeError('roomId contains unsupported characters');
    const swapColors = this.rng() >= 0.5;
    const pairing = {
      id: generatedRoomId,
      roomId,
      whiteId: swapColors ? playerB.playerId : playerA.playerId,
      blackId: swapColors ? playerA.playerId : playerB.playerId,
      playerAId: playerA.playerId,
      playerBId: playerB.playerId,
      playerARating: playerA.rating,
      playerBRating: playerB.rating,
      timeControl: normalizeTimeControl(options.timeControl),
      rated: options.rated !== false,
      createdAt: this.now()
    };
    this.pairings.set(pairing.id, pairing);
    this._closePlayerSeeks(playerA.playerId, 'paired');
    this._closePlayerSeeks(playerB.playerId, 'paired');
    return copy(pairing);
  }

  createSeek(options = {}) {
    const playerId = normalizePlayerId(options.playerId || options.player);
    const timeControl = normalizeTimeControl(options.timeControl);
    const duplicate = this.listOpenSeeks({ playerId, timeControl });
    if (duplicate.length > 0) {
      const error = new Error('player already has an open seek for this time control');
      error.code = 'SEEK_EXISTS';
      throw error;
    }
    const seek = {
      id: this._nextId('seek'),
      playerId,
      username: String(options.username || playerId),
      rating: this._ratingFor(playerId, timeControl, options.rating),
      ratingTolerance: normalizeTolerance(options.ratingTolerance, this.defaultTolerance),
      timeControl,
      rated: options.rated !== false,
      status: 'open',
      createdAt: this.now()
    };
    this.seeks.set(seek.id, seek);
    return copy(seek);
  }

  listOpenSeeks(filters = {}) {
    const playerId = filters.playerId == null ? null : normalizePlayerId(filters.playerId);
    const timeControl = filters.timeControl == null ? null : normalizeTimeControl(filters.timeControl);
    return Array.from(this.seeks.values())
      .filter(seek => seek.status === 'open')
      .filter(seek => playerId == null || seek.playerId === playerId)
      .filter(seek => timeControl == null || seek.timeControl === timeControl)
      .filter(seek => filters.rated == null || seek.rated === Boolean(filters.rated))
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map(copy);
  }

  cancelSeek(seekId, playerId) {
    const seek = this.seeks.get(String(seekId));
    if (!seek || seek.status !== 'open') return false;
    if (playerId != null && seek.playerId !== normalizePlayerId(playerId)) return false;
    seek.status = 'cancelled';
    seek.closedReason = 'cancelled';
    seek.closedAt = this.now();
    return true;
  }

  createChallenge(options = {}) {
    const challengerId = normalizePlayerId(options.challengerId || options.challenger);
    const challengedId = normalizePlayerId(options.challengedId || options.challenged);
    if (challengerId === challengedId) throw new TypeError('players cannot challenge themselves');
    const timeControl = normalizeTimeControl(options.timeControl);
    const challenge = {
      id: this._nextId('challenge'),
      challengerId,
      challengedId,
      challengerRating: this._ratingFor(challengerId, timeControl, options.challengerRating),
      challengedRating: this._ratingFor(challengedId, timeControl, options.challengedRating),
      timeControl,
      rated: options.rated !== false,
      status: 'pending',
      createdAt: this.now()
    };
    this.challenges.set(challenge.id, challenge);
    return copy(challenge);
  }

  listChallenges(filters = {}) {
    return Array.from(this.challenges.values())
      .filter(challenge => filters.status == null || challenge.status === filters.status)
      .filter(challenge => filters.playerId == null ||
        challenge.challengerId === String(filters.playerId) || challenge.challengedId === String(filters.playerId))
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map(copy);
  }

  acceptChallenge(challengeId, playerId, options = {}) {
    const challenge = this.challenges.get(String(challengeId));
    if (!challenge || challenge.status !== 'pending') return null;
    if (playerId != null && challenge.challengedId !== normalizePlayerId(playerId)) return null;
    const pairing = this._createPairing(
      { playerId: challenge.challengerId, rating: challenge.challengerRating },
      { playerId: challenge.challengedId, rating: challenge.challengedRating },
      { timeControl: challenge.timeControl, rated: challenge.rated, roomId: options.roomId }
    );
    challenge.status = 'accepted';
    challenge.resolvedAt = this.now();
    challenge.pairingId = pairing.id;
    challenge.roomId = pairing.roomId;
    return { challenge: copy(challenge), pairing };
  }

  declineChallenge(challengeId, playerId) {
    const challenge = this.challenges.get(String(challengeId));
    if (!challenge || challenge.status !== 'pending') return null;
    if (playerId != null && challenge.challengedId !== normalizePlayerId(playerId)) return null;
    challenge.status = 'declined';
    challenge.resolvedAt = this.now();
    return copy(challenge);
  }

  matchmake(options = {}) {
    const playerId = normalizePlayerId(options.playerId || options.player);
    const timeControl = normalizeTimeControl(options.timeControl);
    const rated = options.rated !== false;
    const rating = this._ratingFor(playerId, timeControl, options.rating);
    const tolerance = normalizeTolerance(options.ratingTolerance, this.defaultTolerance);
    const candidates = this.listOpenSeeks({ timeControl, rated })
      .filter(seek => seek.playerId !== playerId)
      .map(seek => ({ seek, distance: Math.abs(seek.rating - rating) }))
      .filter(candidate => candidate.distance <= tolerance && candidate.distance <= candidate.seek.ratingTolerance)
      .sort((left, right) => left.distance - right.distance || left.seek.id.localeCompare(right.seek.id));

    if (candidates.length === 0) return null;
    const nearestDistance = candidates[0].distance;
    const nearest = candidates.filter(candidate => candidate.distance === nearestDistance);
    const selected = nearest[Math.floor(this.rng() * nearest.length)].seek;
    selected.status = 'matched';
    selected.closedReason = 'paired';
    selected.closedAt = this.now();
    return this._createPairing(
      { playerId, rating },
      { playerId: selected.playerId, rating: selected.rating },
      { timeControl, rated, roomId: options.roomId }
    );
  }
}

function createLobby(options) {
  return new LobbyStore(options);
}

let defaultLobby = null;
function getDefaultLobby() {
  if (!defaultLobby) defaultLobby = createLobby();
  return defaultLobby;
}

function resetLobby(options) {
  defaultLobby = createLobby(options);
  return defaultLobby;
}

const Lobby = {
  DEFAULT_RATING,
  DEFAULT_TOLERANCE,
  DEFAULT_TIME_CONTROL,
  DEFAULT_SEED,
  ROOM_ID_PATTERN,
  createSeededRng,
  isValidRoomId,
  LobbyStore,
  createLobby,
  resetLobby,
  createSeek: options => getDefaultLobby().createSeek(options),
  listOpenSeeks: filters => getDefaultLobby().listOpenSeeks(filters),
  cancelSeek: (seekId, playerId) => getDefaultLobby().cancelSeek(seekId, playerId),
  createChallenge: options => getDefaultLobby().createChallenge(options),
  listChallenges: filters => getDefaultLobby().listChallenges(filters),
  acceptChallenge: (challengeId, playerId, options) => getDefaultLobby().acceptChallenge(challengeId, playerId, options),
  declineChallenge: (challengeId, playerId) => getDefaultLobby().declineChallenge(challengeId, playerId),
  matchmake: options => getDefaultLobby().matchmake(options)
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Lobby;
}
if (typeof window !== 'undefined') {
  window.Lobby = Lobby;
}
