'use strict';

function normalizeUtcDate(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const simpleDate = value.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (simpleDate) {
      const year = Number(simpleDate[1]);
      const month = Number(simpleDate[2]);
      const day = Number(simpleDate[3]);
      const parsed = new Date(Date.UTC(year, month - 1, day));
      if (parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day) {
        return parsed.toISOString().slice(0, 10);
      }
      return null;
    }
  }

  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function stableDateHash(dateText) {
  let hash = 5381;
  for (let i = 0; i < dateText.length; i++) {
    hash = Math.imul(hash, 33) ^ dateText.charCodeAt(i);
  }
  return hash >>> 0;
}

function dailyPuzzleFor(date, puzzles) {
  if (!Array.isArray(puzzles) || puzzles.length === 0) return null;
  const dateText = normalizeUtcDate(date);
  if (!dateText) return null;
  const ordered = puzzles.slice().sort((left, right) => {
    const leftId = String(left.id);
    const rightId = String(right.id);
    return leftId < rightId ? -1 : (leftId > rightId ? 1 : 0);
  });
  return ordered[stableDateHash(dateText) % ordered.length];
}

function dailyPuzzleToday(puzzles) {
  return dailyPuzzleFor(new Date(), puzzles);
}

const DailyPuzzle = {
  normalizeUtcDate,
  stableDateHash,
  dailyPuzzleFor,
  dailyPuzzleToday
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DailyPuzzle;
}
if (typeof window !== 'undefined') {
  window.DailyPuzzle = DailyPuzzle;
}
