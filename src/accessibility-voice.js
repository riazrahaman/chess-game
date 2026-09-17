(function() {
'use strict';

/**
 * accessibility-voice.js
 * C8: Spoken Move Announcements & Natural-Language / Voice Move Commands
 * D4: Blind / Low-Vision Accessibility Mode & Screen Reader Support
 * 
 * Strict architectural rule: Read-only display layer; delegates move submission
 * through authoritative submitMove callbacks without local state mutation.
 */

const PIECE_NAMES_NATURAL = {
  N: 'Knight',
  B: 'Bishop',
  R: 'Rook',
  Q: 'Queen',
  K: 'King',
  P: 'Pawn'
};

const PHONETIC_SQUARES = {
  a: 'alpha',
  b: 'bravo',
  c: 'charlie',
  d: 'delta',
  e: 'echo',
  f: 'foxtrot',
  g: 'golf',
  h: 'hotel'
};

function sanToNaturalSpeech(san, color) {
  if (!san || typeof san !== 'string') return '';
  let s = san.trim();
  const prefix = color ? `${color === 'white' ? 'White' : 'Black'}: ` : '';

  if (s === 'O-O' || s === '0-0') return `${prefix}Kingside castle`;
  if (s === 'O-O-O' || s === '0-0-0') return `${prefix}Queenside castle`;

  let checkSuffix = '';
  if (s.endsWith('#')) {
    checkSuffix = ' checkmate';
    s = s.slice(0, -1);
  } else if (s.endsWith('+')) {
    checkSuffix = ' check';
    s = s.slice(0, -1);
  }

  let promoSuffix = '';
  if (s.includes('=')) {
    const parts = s.split('=');
    s = parts[0];
    const promoPiece = PIECE_NAMES_NATURAL[parts[1]] || parts[1];
    promoSuffix = ` promotes to ${promoPiece}`;
  }

  const isCapture = s.includes('x');
  const clean = s.replace('x', '');

  let pieceName = '';
  let targetSquare = '';
  let disambiguation = '';

  const firstChar = clean.charAt(0);
  if (PIECE_NAMES_NATURAL[firstChar]) {
    pieceName = PIECE_NAMES_NATURAL[firstChar];
    const rest = clean.slice(1);
    if (rest.length > 2) {
      disambiguation = rest.slice(0, rest.length - 2) + ' ';
      targetSquare = rest.slice(rest.length - 2);
    } else {
      targetSquare = rest;
    }
  } else {
    // Pawn move
    pieceName = 'Pawn';
    if (isCapture) {
      const fromFile = s.charAt(0);
      const toSquare = s.slice(2);
      return `${prefix}${fromFile} takes ${toSquare}${promoSuffix}${checkSuffix}`;
    }
    targetSquare = clean;
  }

  if (isCapture) {
    return `${prefix}${pieceName} ${disambiguation}takes ${targetSquare}${promoSuffix}${checkSuffix}`.trim();
  }
  return `${prefix}${pieceName} ${disambiguation}to ${targetSquare}${promoSuffix}${checkSuffix}`.trim();
}

function parseSpokenMove(transcript, legalCandidates = []) {
  if (!transcript || typeof transcript !== 'string') return null;
  const raw = transcript.toLowerCase().trim()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, ' ')
    .replace(/\s+/g, ' ');

  // Direct special commands
  if (raw === 'resign' || raw === 'i resign') return { action: 'resign' };
  if (raw === 'offer draw' || raw === 'draw offer' || raw === 'draw') return { action: 'draw' };
  if (raw === 'accept draw' || raw === 'accept') return { action: 'accept_draw' };
  if (raw === 'decline draw' || raw === 'decline') return { action: 'decline_draw' };

  // Castling phrases
  if (raw.includes('castle king') || raw.includes('kingside') || raw.includes('short castle') || raw === 'castle') {
    const match = legalCandidates.find(c => c.san === 'O-O' || c.uci === 'e1g1' || c.uci === 'e8g8');
    if (match) return { move: match, confidence: 0.95 };
  }
  if (raw.includes('castle queen') || raw.includes('queenside') || raw.includes('long castle')) {
    const match = legalCandidates.find(c => c.san === 'O-O-O' || c.uci === 'e1c1' || c.uci === 'e8c8');
    if (match) return { move: match, confidence: 0.95 };
  }

  // Pure coordinate notation: e.g. "e2 to e4", "e2 e4", "e 2 to e 4"
  const coordMatch = raw.replace(/\s+/g, '').match(/^([a-h][1-8])to?([a-h][1-8])([qrbn])?$/);
  if (coordMatch) {
    const from = coordMatch[1];
    const to = coordMatch[2];
    const promo = coordMatch[3] || undefined;
    const match = legalCandidates.find(c => c.from === from && c.to === to && (!promo || c.promo === promo));
    if (match) return { move: match, confidence: 0.99 };
  }

  // Token normalized matching
  const tokens = raw.split(' ');
  // Handle phonetic homophones
  const tokenMap = {
    'night': 'knight',
    'see': 'c',
    'sea': 'c',
    'be': 'b',
    'bee': 'b',
    'too': '2',
    'two': '2',
    'for': '4',
    'four': '4',
    'fore': '4',
    'ate': '8',
    'eight': '8',
    'won': '1',
    'one': '1'
  };
  const normalizedTokens = tokens.map(t => tokenMap[t] || t);
  const normalizedText = normalizedTokens.join(' ');

  for (const candidate of legalCandidates) {
    const san = (candidate.san || '').toLowerCase().replace(/[+#]/g, '');
    const uci = (candidate.uci || `${candidate.from}${candidate.to}`).toLowerCase();
    
    // Exact SAN or UCI match
    if (normalizedText === san || normalizedText === uci || raw.replace(/\s+/g, '') === san) {
      return { move: candidate, confidence: 0.95 };
    }

    // Natural speech match: e.g. "knight to f3"
    const natural = sanToNaturalSpeech(candidate.san, '').toLowerCase();
    if (normalizedText === natural || normalizedText.replace('to ', '') === natural.replace('to ', '')) {
      return { move: candidate, confidence: 0.90 };
    }

    // "Pawn to e4" vs "e4"
    if (natural.startsWith('pawn to ') && normalizedText === natural.replace('pawn to ', '')) {
      return { move: candidate, confidence: 0.85 };
    }
    // "Takes d4" capture match if unambiguous
    if (san.includes('x') && (normalizedText.includes('takes ' + candidate.to) || normalizedText.includes('take ' + candidate.to))) {
      return { move: candidate, confidence: 0.85 };
    }
  }

  return null;
}

class AccessibilityVoiceController {
  constructor(options = {}) {
    this.voiceEnabled = options.voiceEnabled !== undefined ? options.voiceEnabled : false;
    this.blindModeEnabled = options.blindModeEnabled !== undefined ? options.blindModeEnabled : false;
    this.speechStyle = options.speechStyle || 'natural'; // 'natural' | 'san'
    this.submitMoveCallback = options.submitMoveCallback || null;
    this.statusCallback = options.statusCallback || null;

    this.recognition = null;
    this.isListening = false;
    this.focusedCoord = { file: 4, rank: 1 }; // Default focused square: e2 (0-indexed file 0=a..7=h, rank 0=1..7=8)
    this.lastAnnouncedHistoryLength = 0;

    this._initStorage();
  }

  _initStorage() {
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        const storedVoice = window.localStorage.getItem('chess_voice_enabled');
        if (storedVoice !== null) this.voiceEnabled = storedVoice === 'true';
        const storedBlind = window.localStorage.getItem('chess_blind_mode');
        if (storedBlind !== null) this.blindModeEnabled = storedBlind === 'true';
      } catch (e) {}
    }
  }

  toggleVoice(enabled) {
    const prev = this.voiceEnabled;
    this.voiceEnabled = enabled !== undefined ? enabled : !this.voiceEnabled;
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.setItem('chess_voice_enabled', String(this.voiceEnabled));
      } catch (e) {}
    }
    const msg = this.voiceEnabled ? 'Voice announcements enabled' : 'Voice announcements muted';
    if (this.voiceEnabled) {
      this.speak(msg);
    } else {
      // Speak final confirmation before muting, and announce via live region
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        try {
          window.speechSynthesis.cancel();
          const utterance = new window.SpeechSynthesisUtterance(msg);
          utterance.rate = 1.05;
          window.speechSynthesis.speak(utterance);
        } catch (_) {}
      }
    }
    this.announceLive(msg, true);
    return this.voiceEnabled;
  }

  toggleBlindMode(enabled) {
    this.blindModeEnabled = enabled !== undefined ? enabled : !this.blindModeEnabled;
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.setItem('chess_blind_mode', String(this.blindModeEnabled));
      } catch (e) {}
    }
    const msg = this.blindModeEnabled ? 'Blind accessibility mode enabled. Use arrow keys to navigate the board.' : 'Blind accessibility mode disabled';
    this.announceLive(msg, true);
    return this.blindModeEnabled;
  }

  speak(text) {
    if (!text) return;
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    if (!this.voiceEnabled && !this.blindModeEnabled) return;

    try {
      window.speechSynthesis.cancel();
      const utterance = new window.SpeechSynthesisUtterance(text);
      utterance.rate = 1.05;
      utterance.pitch = 1.0;
      window.speechSynthesis.speak(utterance);
    } catch (e) {
      // safe fallback if speech synthesis errors in restricted context
    }
  }

  announceLive(text, assertive = false) {
    if (!text) return;
    if (typeof document !== 'undefined') {
      const announcer = document.getElementById('accessibility-announcer');
      if (announcer) {
        announcer.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
        announcer.textContent = text;
      }
    }
    if (this.voiceEnabled || this.blindModeEnabled) {
      this.speak(text);
    }
  }

  announceMove(san, color) {
    if (!san) return;
    const text = this.speechStyle === 'san'
      ? `${color ? (color === 'white' ? 'White' : 'Black') + ' ' : ''}${san}`
      : sanToNaturalSpeech(san, color);

    this.announceLive(text, false);
  }

  announceGameOutcome(status, result, reason) {
    let outcome = '';
    if (result === '1-0') outcome = 'Checkmate. White wins the game.';
    else if (result === '0-1') outcome = 'Checkmate. Black wins the game.';
    else if (result === '1/2-1/2') outcome = `Game drawn by ${reason || 'mutual agreement'}.`;
    else if (status === 'timeout') outcome = `Time out. ${result === '1-0' ? 'White' : 'Black'} wins on time.`;
    else outcome = `Game over: ${status}.`;

    this.announceLive(outcome, true);
  }

  announceClocks(whiteSecs, blackSecs) {
    const formatTime = (s) => {
      const m = Math.floor(s / 60);
      const rem = s % 60;
      return m > 0 ? `${m} minute${m === 1 ? '' : 's'} ${rem} second${rem === 1 ? '' : 's'}` : `${rem} seconds`;
    };
    const msg = `White has ${formatTime(whiteSecs)}. Black has ${formatTime(blackSecs)}.`;
    this.announceLive(msg, true);
  }

  startVoiceRecognition(onMoveRecognized, onStatusUpdate) {
    if (typeof window === 'undefined') return false;
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      if (onStatusUpdate) onStatusUpdate('Speech recognition not supported in this browser.', true);
      return false;
    }

    try {
      if (this.recognition) {
        this.recognition.abort();
      }
      this.recognition = new SpeechRec();
      this.recognition.continuous = false;
      this.recognition.interimResults = false;
      this.recognition.lang = 'en-US';

      this.recognition.onstart = () => {
        this.isListening = true;
        if (onStatusUpdate) onStatusUpdate('Listening for chess move (e.g., "e4", "Knight to f3")...', false);
      };

      this.recognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript;
        if (onStatusUpdate) onStatusUpdate(`Heard: "${transcript}"`, false);
        if (onMoveRecognized) onMoveRecognized(transcript);
      };

      this.recognition.onerror = (event) => {
        this.isListening = false;
        if (onStatusUpdate) onStatusUpdate(`Mic error: ${event.error}`, true);
      };

      this.recognition.onend = () => {
        this.isListening = false;
      };

      this.recognition.start();
      return true;
    } catch (e) {
      this.isListening = false;
      if (onStatusUpdate) onStatusUpdate('Microphone access denied or error.', true);
      return false;
    }
  }

  stopVoiceRecognition() {
    if (this.recognition) {
      try { this.recognition.abort(); } catch (e) {}
      this.recognition = null;
    }
    this.isListening = false;
  }

  // Keyboard navigation helpers (0-indexed file a=0..h=7, rank 1=0..8=7)
  getSquareFromCoord(fileIdx, rankIdx) {
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    return `${files[fileIdx]}${rankIdx + 1}`;
  }

  moveCursor(dFile, dRank) {
    this.focusedCoord.file = Math.max(0, Math.min(7, this.focusedCoord.file + dFile));
    this.focusedCoord.rank = Math.max(0, Math.min(7, this.focusedCoord.rank + dRank));
    return this.getSquareFromCoord(this.focusedCoord.file, this.focusedCoord.rank);
  }

  setCursor(squareId) {
    if (!squareId || squareId.length !== 2) return;
    const file = squareId.charCodeAt(0) - 97;
    const rank = parseInt(squareId.charAt(1), 10) - 1;
    if (file >= 0 && file <= 7 && rank >= 0 && rank <= 7) {
      this.focusedCoord.file = file;
      this.focusedCoord.rank = rank;
    }
  }
}

const AccessibilityVoiceModule = {
  sanToNaturalSpeech,
  parseSpokenMove,
  AccessibilityVoiceController
};

if (typeof window !== 'undefined') {
  window.AccessibilityVoice = AccessibilityVoiceModule;
}
if (typeof module !== 'undefined') {
  module.exports = AccessibilityVoiceModule;
}
})();
