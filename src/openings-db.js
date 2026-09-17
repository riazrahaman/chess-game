'use strict';

// ECO Chess Openings Database & Master Statistics Engine
// Provides standardized ECO classifications, win/draw rates, and popular continuation lines

const OPENINGS_DB = {
  '': {
    eco: 'A00',
    name: 'Starting Position',
    stats: { white: 38, draw: 34, black: 28 },
    popularMoves: [
      { uci: 'e2e4', san: 'e4', name: "King's Pawn Opening", frequency: 47 },
      { uci: 'd2d4', san: 'd4', name: "Queen's Pawn Opening", frequency: 36 },
      { uci: 'c2c4', san: 'c4', name: 'English Opening', frequency: 9 },
      { uci: 'g1f3', san: 'Nf3', name: 'Zukertort Opening', frequency: 6 }
    ]
  },
  'e2e4': {
    eco: 'B00',
    name: "King's Pawn Opening",
    stats: { white: 38, draw: 32, black: 30 },
    popularMoves: [
      { uci: 'c7c5', san: 'c5', name: 'Sicilian Defense', frequency: 46 },
      { uci: 'e7e5', san: 'e5', name: 'Open Game', frequency: 28 },
      { uci: 'e7e6', san: 'e6', name: 'French Defense', frequency: 13 },
      { uci: 'c7c6', san: 'c6', name: 'Caro-Kann Defense', frequency: 9 }
    ]
  },
  'e2e4 e7e5': {
    eco: 'C20',
    name: 'Open Game',
    stats: { white: 39, draw: 33, black: 28 },
    popularMoves: [
      { uci: 'g1f3', san: 'Nf3', name: "King's Knight Opening", frequency: 83 },
      { uci: 'f1c4', san: 'Bc4', name: "Bishop's Opening", frequency: 8 },
      { uci: 'b1c3', san: 'Nc3', name: 'Vienna Game', frequency: 6 }
    ]
  },
  'e2e4 e7e5 g1f3': {
    eco: 'C40',
    name: "King's Knight Opening",
    stats: { white: 40, draw: 33, black: 27 },
    popularMoves: [
      { uci: 'b8c6', san: 'Nc6', name: 'Open Game: Normal Variation', frequency: 82 },
      { uci: 'g8f6', san: 'Nf6', name: "Petrov's Defense", frequency: 12 },
      { uci: 'd7d6', san: 'd6', name: 'Philidor Defense', frequency: 4 }
    ]
  },
  'e2e4 e7e5 g1f3 b8c6': {
    eco: 'C44',
    name: 'Open Game: Three / Four Knights Setup',
    stats: { white: 39, draw: 34, black: 27 },
    popularMoves: [
      { uci: 'f1b5', san: 'Bb5', name: 'Ruy Lopez', frequency: 53 },
      { uci: 'f1c4', san: 'Bc4', name: 'Italian Game', frequency: 34 },
      { uci: 'd2d4', san: 'd4', name: 'Scotch Game', frequency: 10 }
    ]
  },
  'e2e4 e7e5 g1f3 b8c6 f1c4': {
    eco: 'C50',
    name: 'Italian Game',
    stats: { white: 41, draw: 33, black: 26 },
    popularMoves: [
      { uci: 'f8c5', san: 'Bc5', name: 'Giuoco Piano', frequency: 55 },
      { uci: 'g8f6', san: 'Nf6', name: 'Two Knights Defense', frequency: 37 },
      { uci: 'f8e7', san: 'Be7', name: 'Hungarian Defense', frequency: 5 }
    ]
  },
  'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5': {
    eco: 'C53',
    name: 'Italian Game: Giuoco Piano',
    stats: { white: 40, draw: 35, black: 25 },
    popularMoves: [
      { uci: 'c2c3', san: 'c3', name: 'Main Line', frequency: 60 },
      { uci: 'd2d3', san: 'd3', name: 'Giuoco Pianissimo', frequency: 30 },
      { uci: 'b2b4', san: 'b4', name: 'Evans Gambit', frequency: 8 }
    ]
  },
  'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6': {
    eco: 'C55',
    name: 'Italian Game: Two Knights Defense',
    stats: { white: 41, draw: 32, black: 27 },
    popularMoves: [
      { uci: 'd2d3', san: 'd3', name: 'Quiet System', frequency: 50 },
      { uci: 'f3g5', san: 'Ng5', name: 'Knight Attack', frequency: 38 },
      { uci: 'd2d4', san: 'd4', name: 'Modern Variation', frequency: 10 }
    ]
  },
  'e2e4 e7e5 g1f3 b8c6 f1b5': {
    eco: 'C60',
    name: 'Ruy Lopez (Spanish Opening)',
    stats: { white: 41, draw: 35, black: 24 },
    popularMoves: [
      { uci: 'a7a6', san: 'a6', name: 'Morphy Defense', frequency: 72 },
      { uci: 'g8f6', san: 'Nf6', name: 'Berlin Defense', frequency: 18 },
      { uci: 'd7d6', san: 'd6', name: 'Steinitz Defense', frequency: 5 }
    ]
  },
  'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6': {
    eco: 'C68',
    name: 'Ruy Lopez: Morphy Defense',
    stats: { white: 40, draw: 36, black: 24 },
    popularMoves: [
      { uci: 'b5a4', san: 'Ba4', name: 'Columbus Variation', frequency: 85 },
      { uci: 'b5c6', san: 'Bxc6', name: 'Exchange Variation', frequency: 14 }
    ]
  },
  'e2e4 c7c5': {
    eco: 'B20',
    name: 'Sicilian Defense',
    stats: { white: 37, draw: 31, black: 32 },
    popularMoves: [
      { uci: 'g1f3', san: 'Nf3', name: 'Open Sicilian Preparation', frequency: 79 },
      { uci: 'b1c3', san: 'Nc3', name: 'Closed Sicilian', frequency: 11 },
      { uci: 'c2c3', san: 'c3', name: 'Alapin Variation', frequency: 7 }
    ]
  },
  'e2e4 c7c5 g1f3 d7d6': {
    eco: 'B50',
    name: 'Sicilian Defense: Modern Variations',
    stats: { white: 38, draw: 31, black: 31 },
    popularMoves: [
      { uci: 'd2d4', san: 'd4', name: 'Open Sicilian', frequency: 92 },
      { uci: 'f1b5', san: 'Bb5+', name: 'Moscow Variation', frequency: 7 }
    ]
  },
  'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6': {
    eco: 'B90',
    name: 'Sicilian Defense: Najdorf Variation',
    stats: { white: 36, draw: 33, black: 31 },
    popularMoves: [
      { uci: 'c1e3', san: 'Be3', name: 'English Attack', frequency: 38 },
      { uci: 'f1e2', san: 'Be2', name: 'Classical Opocensky', frequency: 25 },
      { uci: 'c1g5', san: 'Bg5', name: 'Main Line', frequency: 22 }
    ]
  },
  'e2e4 e7e6': {
    eco: 'C00',
    name: 'French Defense',
    stats: { white: 40, draw: 31, black: 29 },
    popularMoves: [
      { uci: 'd2d4', san: 'd4', name: 'Main Line', frequency: 90 },
      { uci: 'd2d3', san: 'd3', name: "King's Indian Attack", frequency: 5 }
    ]
  },
  'e2e4 c7c6': {
    eco: 'B10',
    name: 'Caro-Kann Defense',
    stats: { white: 39, draw: 34, black: 27 },
    popularMoves: [
      { uci: 'd2d4', san: 'd4', name: 'Main Line', frequency: 86 },
      { uci: 'b1c3', san: 'Nc3', name: 'Two Knights Variation', frequency: 9 }
    ]
  },
  'e2e4 d7d5': {
    eco: 'B01',
    name: 'Scandinavian Defense',
    stats: { white: 42, draw: 29, black: 29 },
    popularMoves: [
      { uci: 'e4d5', san: 'exd5', name: 'Main Line', frequency: 88 },
      { uci: 'b1c3', san: 'Nc3', name: 'Closed Variation', frequency: 6 }
    ]
  },
  'd2d4': {
    eco: 'A40',
    name: "Queen's Pawn Game",
    stats: { white: 39, draw: 35, black: 26 },
    popularMoves: [
      { uci: 'd7d5', san: 'd5', name: 'Closed Game', frequency: 50 },
      { uci: 'g8f6', san: 'Nf6', name: 'Indian Defenses', frequency: 42 },
      { uci: 'e7e6', san: 'e6', name: 'Horwitz Defense', frequency: 4 }
    ]
  },
  'd2d4 d7d5': {
    eco: 'D00',
    name: "Queen's Pawn Game: Closed",
    stats: { white: 39, draw: 36, black: 25 },
    popularMoves: [
      { uci: 'c2c4', san: 'c4', name: "Queen's Gambit", frequency: 70 },
      { uci: 'g1f3', san: 'Nf3', name: 'London System / Torre Attack', frequency: 22 }
    ]
  },
  'd2d4 d7d5 c2c4': {
    eco: 'D06',
    name: "Queen's Gambit",
    stats: { white: 42, draw: 36, black: 22 },
    popularMoves: [
      { uci: 'e7e6', san: 'e6', name: "Queen's Gambit Declined", frequency: 54 },
      { uci: 'c7c6', san: 'c6', name: 'Slav Defense', frequency: 32 },
      { uci: 'd5c4', san: 'dxc4', name: "Queen's Gambit Accepted", frequency: 11 }
    ]
  },
  'd2d4 d7d5 c2c4 e7e6': {
    eco: 'D30',
    name: "Queen's Gambit Declined",
    stats: { white: 41, draw: 38, black: 21 },
    popularMoves: [
      { uci: 'b1c3', san: 'Nc3', name: 'Three Knights', frequency: 58 },
      { uci: 'g1f3', san: 'Nf3', name: 'Modern Line', frequency: 35 }
    ]
  },
  'd2d4 d7d5 c2c4 c7c6': {
    eco: 'D10',
    name: 'Slav Defense',
    stats: { white: 39, draw: 40, black: 21 },
    popularMoves: [
      { uci: 'g1f3', san: 'Nf3', name: 'Modern Line', frequency: 55 },
      { uci: 'b1c3', san: 'Nc3', name: 'Main System', frequency: 35 }
    ]
  },
  'd2d4 g8f6': {
    eco: 'A45',
    name: 'Indian Defense',
    stats: { white: 38, draw: 36, black: 26 },
    popularMoves: [
      { uci: 'c2c4', san: 'c4', name: 'Main Line Indian', frequency: 78 },
      { uci: 'g1f3', san: 'Nf3', name: 'Quiet Indian', frequency: 15 }
    ]
  },
  'd2d4 g8f6 c2c4 g7g6': {
    eco: 'E60',
    name: "King's Indian Defense",
    stats: { white: 41, draw: 33, black: 26 },
    popularMoves: [
      { uci: 'b1c3', san: 'Nc3', name: 'Classical Setup', frequency: 65 },
      { uci: 'g1f3', san: 'Nf3', name: 'Fianchetto Setup', frequency: 25 }
    ]
  },
  'c2c4': {
    eco: 'A10',
    name: 'English Opening',
    stats: { white: 38, draw: 37, black: 25 },
    popularMoves: [
      { uci: 'e7e5', san: 'e5', name: 'Reversed Sicilian', frequency: 38 },
      { uci: 'g8f6', san: 'Nf6', name: 'Anglo-Indian', frequency: 34 },
      { uci: 'c7c5', san: 'c5', name: 'Symmetrical English', frequency: 18 }
    ]
  },
  'g1f3': {
    eco: 'A04',
    name: 'Réti Opening',
    stats: { white: 37, draw: 37, black: 26 },
    popularMoves: [
      { uci: 'd7d5', san: 'd5', name: 'Réti Gambit Accepted / Declined', frequency: 52 },
      { uci: 'g8f6', san: 'Nf6', name: 'King’s Indian Attack Setup', frequency: 35 }
    ]
  }
};

/**
 * Searches the opening database for the deepest matching move sequence.
 * @param {string[]} moves - Array of UCI move strings e.g. ['e2e4', 'e7e5', 'g1f3']
 * @returns {object} Opening information including ECO code, name, win rates, and candidate lines.
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
