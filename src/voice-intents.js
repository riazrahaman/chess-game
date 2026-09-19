(function() {
'use strict';

/**
 * voice-intents.js — AB3: Voice-loop coverage (extend voice commands beyond moves).
 *
 * Intent router that recognizes spoken commands such as "resign", "offer draw",
 * "analyze this", "show best move" and maps them to a normalized action. The
 * voice parser already exists in accessibility-voice.js; this module adds the
 * intent vocabulary and routes ambiguous utterances. Pure logic — no referee
 * mutation, no makeMove/createInitialBoard.
 *
 * Public API:
 *   parseIntent(transcript) — { action, confidence } | null
 *   INTENTS — vocabulary map
 */

const INTENTS = {
  'resign': 'resign',
  'i resign': 'resign',
  'offer draw': 'draw',
  'draw offer': 'draw',
  'i offer a draw': 'draw',
  'accept draw': 'accept_draw',
  'accept': 'accept_draw',
  'decline draw': 'decline_draw',
  'decline': 'decline_draw',
  'accept undo': 'accept_undo',
  'allow undo': 'accept_undo',
  'decline undo': 'decline_undo',
  'reject undo': 'decline_undo',
  'analyze this': 'analyze',
  'analyze the position': 'analyze',
  'analyze': 'analyze',
  'show best move': 'best',
  'what is the best move': 'best',
  'best move': 'best',
  'give me a hint': 'hint',
  'hint': 'hint',
  'coach hint': 'hint',
  'what should i play': 'hint',
  'undo that move': 'undo',
  'take back': 'undo',
  'takeback': 'undo',
  'new game': 'new_game',
  'start over': 'new_game',
  'restart': 'new_game',
  'show clock': 'clocks',
  'time': 'clocks',
  'how much time': 'clocks'
};

function normalize(text) {
  if (!text || typeof text !== 'string') return '';
  return text.toLowerCase().trim()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Recognize a spoken intent. Returns null when the utterance is not a known
 * command (so the caller can fall through to move parsing).
 */
function parseIntent(transcript) {
  const raw = normalize(transcript);
  if (!raw) return null;
  if (INTENTS[raw]) {
    return { action: INTENTS[raw], confidence: 0.98 };
  }
  return null;
}

const VoiceIntents = {
  parseIntent,
  INTENTS
};

if (typeof window !== 'undefined') {
  window.VoiceIntents = VoiceIntents;
}
if (typeof module !== 'undefined') {
  module.exports = VoiceIntents;
}
})();
