'use strict';

// ECO opening names (compact fallback) + eval-graph geometry.
//
// Wave 2 / E3: this table carries ONLY eco + name for 25 common lines. The
// former `stats: {white, draw, black}` percentages and `popularMoves[].frequency`
// figures were invented ("illustrative") and have been deleted, not replaced —
// there is no real game-count source in this repo. Real opening names for
// ~3,800 lines come from data/openings.tsv (lichess chess-openings, CC0) via
// src/openings-explorer.js and GET /api/openings/lookup; the player's own
// results come from GET /api/openings/personal (game-archive.js).

const OPENINGS_DB = {
  '': {
    eco: 'A00',
    name: 'Starting Position'
  },
  'e2e4': {
    eco: 'B00',
    name: "King's Pawn Opening"
  },
  'e2e4 e7e5': {
    eco: 'C20',
    name: 'Open Game'
  },
  'e2e4 e7e5 g1f3': {
    eco: 'C40',
    name: "King's Knight Opening"
  },
  'e2e4 e7e5 g1f3 b8c6': {
    eco: 'C44',
    name: 'Open Game: Three / Four Knights Setup'
  },
  'e2e4 e7e5 g1f3 b8c6 f1c4': {
    eco: 'C50',
    name: 'Italian Game'
  },
  'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5': {
    eco: 'C53',
    name: 'Italian Game: Giuoco Piano'
  },
  'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6': {
    eco: 'C55',
    name: 'Italian Game: Two Knights Defense'
  },
  'e2e4 e7e5 g1f3 b8c6 f1b5': {
    eco: 'C60',
    name: 'Ruy Lopez (Spanish Opening)'
  },
  'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6': {
    eco: 'C68',
    name: 'Ruy Lopez: Morphy Defense'
  },
  'e2e4 c7c5': {
    eco: 'B20',
    name: 'Sicilian Defense'
  },
  'e2e4 c7c5 g1f3 d7d6': {
    eco: 'B50',
    name: 'Sicilian Defense: Modern Variations'
  },
  'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6': {
    eco: 'B90',
    name: 'Sicilian Defense: Najdorf Variation'
  },
  'e2e4 e7e6': {
    eco: 'C00',
    name: 'French Defense'
  },
  'e2e4 c7c6': {
    eco: 'B10',
    name: 'Caro-Kann Defense'
  },
  'e2e4 d7d5': {
    eco: 'B01',
    name: 'Scandinavian Defense'
  },
  'd2d4': {
    eco: 'A40',
    name: "Queen's Pawn Game"
  },
  'd2d4 d7d5': {
    eco: 'D00',
    name: "Queen's Pawn Game: Closed"
  },
  'd2d4 d7d5 c2c4': {
    eco: 'D06',
    name: "Queen's Gambit"
  },
  'd2d4 d7d5 c2c4 e7e6': {
    eco: 'D30',
    name: "Queen's Gambit Declined"
  },
  'd2d4 d7d5 c2c4 c7c6': {
    eco: 'D10',
    name: 'Slav Defense'
  },
  'd2d4 g8f6': {
    eco: 'A45',
    name: 'Indian Defense'
  },
  'd2d4 g8f6 c2c4 g7g6': {
    eco: 'E60',
    name: "King's Indian Defense"
  },
  'c2c4': {
    eco: 'A10',
    name: 'English Opening'
  },
  'g1f3': {
    eco: 'A04',
    name: 'Réti Opening'
  }
};

/**
 * Searches the opening database for the deepest matching move sequence.
 * @param {string[]} moves - Array of UCI move strings e.g. ['e2e4', 'e7e5', 'g1f3']
 * @returns {{eco:string, name:string, matchedPlies:number, isExact?:boolean}}
 *   ECO code + name only — no statistics (none exist in this module).
 */
function findOpening(moves) {
  if (!moves || !Array.isArray(moves) || moves.length === 0) {
    return { ...OPENINGS_DB[''], matchedPlies: 0 };
  }

  // Search from longest prefix back to empty string
  for (let i = moves.length; i > 0; i--) {
    const key = moves.slice(0, i).join(' ');
    if (OPENINGS_DB[key]) {
      return {
        ...OPENINGS_DB[key],
        matchedPlies: i,
        isExact: i === moves.length
      };
    }
  }

  return { ...OPENINGS_DB[''], matchedPlies: 0, isExact: false };
}

/**
 * Generates an SVG path data string for an evaluation sparkline graph.
 * @param {number[]} evals - Centipawns array across plies e.g. [0, 30, 20, 150, -50]
 * @param {number} width - Graph SVG width
 * @param {number} height - Graph SVG height
 * @returns {object} { pathData, points, zeroY }
 */
function generateEvalGraphData(evals, width = 400, height = 120) {
  if (!Array.isArray(evals) || evals.length === 0) {
    evals = [0];
  }

  const zeroY = height / 2;
  const paddingX = 10;
  const paddingY = 8;
  const usableWidth = Math.max(1, width - paddingX * 2);
  const usableHeight = Math.max(1, height - paddingY * 2);

  const stepX = evals.length > 1 ? usableWidth / (evals.length - 1) : usableWidth;

  const points = evals.map((cp, idx) => {
    const x = paddingX + (evals.length > 1 ? idx * stepX : usableWidth / 2);
    // Clamp cp between -800 and +800
    const clamped = Math.max(-800, Math.min(800, typeof cp === 'number' ? cp : 0));
    // Centipawns > 0 (White advantage) goes toward top (y = 0), < 0 goes toward bottom (y = height)
    const normalized = -clamped / 800; // -1 to +1
    const y = zeroY + (normalized * (usableHeight / 2));
    return { x, y, cp, ply: idx };
  });

  const pathData = points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`).join(' ');

  return {
    pathData,
    points,
    zeroY,
    width,
    height
  };
}

const OpeningsModule = {
  OPENINGS_DB,
  findOpening,
  generateEvalGraphData
};

if (typeof window !== 'undefined') {
  window.Openings = OpeningsModule;
}
if (typeof module !== 'undefined') {
  module.exports = OpeningsModule;
}
