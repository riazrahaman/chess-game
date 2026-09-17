(function() {
'use strict';

/**
 * a11y-text-entry.js — AB1: Text command entry for non-visual UI parity.
 *
 * Lets a screen-reader user type a move (SAN or UCI) or a command into a text
 * box instead of using the board. Pure parsing layer — delegates the actual
 * move through the caller's authoritative submit callback; never calls
 * makeMove or createInitialBoard and never mutates referee state.
 *
 * Public API:
 *   parseTextInput(text, legalCandidates) — { move|action, confidence }
 *   ACTION_WORDS — recognized game commands
 */

const ACTION_WORDS = {
  'resign': 'resign',
  'i resign': 'resign',
  'offer draw': 'draw',
  'draw': 'draw',
  'accept': 'accept_draw',
  'accept draw': 'accept_draw',
  'decline': 'decline_draw',
  'decline draw': 'decline_draw',
  'undo': 'undo',
  'takeback': 'undo',
  'analyze': 'analyze',
  'analyze this': 'analyze',
  'show best move': 'best',
  'best move': 'best',
  'hint': 'hint',
  'coach': 'hint'
};

function normalize(text) {
  if (!text || typeof text !== 'string') return '';
  return text.toLowerCase().trim()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a typed move or command.
 * @param {string} text
 * @param {Array} legalCandidates  — [{ san, uci, from, to, promo }]
 * @returns {{action?:string, move?:object, confidence:number}|null}
 */
function parseTextInput(text, legalCandidates = []) {
  const raw = normalize(text);
  if (!raw) return null;

  // 1. Direct action words
  if (ACTION_WORDS[raw]) {
    return { action: ACTION_WORDS[raw], confidence: 1 };
  }

  // 2. UCI coordinate: "e2e4" or "e2 e4"
  const coordMatch = raw.replace(/\s+/g, '').match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/);
  if (coordMatch) {
    const from = coordMatch[1];
    const to = coordMatch[2];
    const promo = coordMatch[3] || undefined;
    const candidate = legalCandidates.find(c => c.from === from && c.to === to && (!promo || c.promo === promo));
    if (candidate) return { move: candidate, confidence: 1 };
    return { error: 'illegal', confidence: 0 };
  }

  // 3. SAN: exact match against a candidate's san (case-insensitive)
  const san = raw.replace(/[+#]/g, '');
  for (const candidate of legalCandidates) {
    const cSan = (candidate.san || '').toLowerCase().replace(/[+#]/g, '');
    if (san === cSan) return { move: candidate, confidence: 1 };
  }

  // 4. Castling shorthands (dash stripped by normalize -> "o o" / "ooo")
  if (raw === 'o-o' || raw === 'o o' || raw === 'ooo' || raw === 'castle' || raw === 'castle king') {
    const candidate = legalCandidates.find(c => c.san === 'O-O' || c.uci === 'e1g1' || c.uci === 'e8g8');
    if (candidate) return { move: candidate, confidence: 1 };
  }
  if (raw === 'o-o-o' || raw === 'o o o' || raw === 'oooo' || raw === 'castle queen') {
    const candidate = legalCandidates.find(c => c.san === 'O-O-O' || c.uci === 'e1c1' || c.uci === 'e8c8');
    if (candidate) return { move: candidate, confidence: 1 };
  }

  return { error: 'unrecognized', confidence: 0 };
}

const A11yTextEntry = {
  parseTextInput,
  ACTION_WORDS
};

if (typeof window !== 'undefined') {
  window.A11yTextEntry = A11yTextEntry;
}
if (typeof module !== 'undefined') {
  module.exports = A11yTextEntry;
}
})();
