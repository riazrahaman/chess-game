/**
 * time-control.js — Time-control completeness (G3).
 *
 * Pure, analysis-only module (no referee mutation, no makeMove/createInitialBoard,
 * no require of referee-service.js/rules-engine.js/engine.js). Implements the
 * pieces needed for a complete time-control layer:
 *
 *   - Lichess TC label formula: initial + 40·increment, bucketed into
 *     UltraBullet / Bullet / Blitz / Rapid / Classical for archive/search tagging.
 *   - Human-readable label + category from a timeControl descriptor.
 *   - Per-color clock descriptors (white/black may differ).
 *   - Increment presets (including >15s increments).
 *   - Simple delay (a.k.a. waiting increment) applied before the main clock runs.
 *   - Bronstein (optional): the delay only accrues when the move consumed >= the
 *     delay, and is applied to the base instead of the running clock.
 *   - Odds / handicap games: a starting material advantage for one color.
 *   - A clock simulator used to compute post-move remaining time under each mode.
 *
 * Determinism: no Math.random; callers pass explicit values.
 *
 * Dual-format module: CommonJS (Node) and browser script.
 */
(function () {
   'use strict';

   // Lichess category boundaries (seconds of initial + 40·increment).
   var CATEGORIES = [
      { name: 'UltraBullet', max: 15 },
      { name: 'Bullet', max: 180 },
      { name: 'Blitz', max: 900 },
      { name: 'Rapid', max: 3600 },
      { name: 'Classical', max: Infinity }
   ];

   // Built-in increment presets — includes increments > 15s (10+30, 30+30, 60+0).
   var PRESETS = {
      'nanobullet_10': { baseSeconds: 10, incrementSeconds: 0, name: 'UltraBullet 10' },
      'nanobullet_15': { baseSeconds: 15, incrementSeconds: 0, name: 'UltraBullet 15' },
      'bullet_1_0': { baseSeconds: 60, incrementSeconds: 0, name: 'Bullet 1+0' },
      'blitz_3_2': { baseSeconds: 180, incrementSeconds: 2, name: 'Blitz 3+2' },
      'blitz_5_3': { baseSeconds: 300, incrementSeconds: 3, name: 'Blitz 5+3' },
      'rapid_10_15': { baseSeconds: 600, incrementSeconds: 15, name: 'Rapid 10+15' },
      'rapid_15_10': { baseSeconds: 900, incrementSeconds: 10, name: 'Rapid 15+10' },
      'rapid_30_20': { baseSeconds: 1800, incrementSeconds: 20, name: 'Rapid 30+20' },
      'rapid_30_30': { baseSeconds: 1800, incrementSeconds: 30, name: 'Rapid 30+30' },
      'classical_15_10': { baseSeconds: 900, incrementSeconds: 10, name: 'Classical 15+10' },
      'classical_60_0': { baseSeconds: 3600, incrementSeconds: 0, name: 'Classical 60+0' }
   };

   // Well-known odds (handicap) materials, keyed by odds name.
   var ODDS_MATERIAL = {
      'queen': 9, 'rook': 5, 'bishop': 3, 'knight': 3,
      'pawns': 0, 'none': 0
   };

   function minutesString(baseSeconds) {
      var mins = Math.floor(baseSeconds / 60);
      var secs = baseSeconds % 60;
      return secs > 0 ? mins + '+' + secs : String(mins);
   }

   /**
    * Lichess TC label: initial + 40·increment, bucketed by category.
    * @param {Object} tc { baseSeconds, incrementSeconds }
    * @returns {string} e.g. 'Rapid' or the literal label when base is odd.
    */
   function labelFormula(tc) {
      var base = (tc && typeof tc.baseSeconds === 'number') ? tc.baseSeconds : 0;
      var inc = (tc && typeof tc.incrementSeconds === 'number') ? tc.incrementSeconds : 0;
      var effective = base + 40 * inc;
      for (var i = 0; i < CATEGORIES.length; i++) {
        if (effective < CATEGORIES[i].max) return CATEGORIES[i].name;
       }
      return 'Classical';
   }

   /**
    * Human-readable label. Uses tc.name when present, otherwise builds from
    * base/increment. Returns 'Custom' for null/empty.
    */
   /**
    * Human-readable base-time display: "M:SS" when the base has leftover seconds,
    * otherwise just "M". This keeps the increment field unambiguous.
    */
   function baseDisplay(baseSeconds) {
      var mins = Math.floor(baseSeconds / 60);
      var secs = baseSeconds % 60;
      return secs > 0 ? (mins + ':' + (secs < 10 ? '0' + secs : '' + secs)) : String(mins);
   }

   function getLabel(tc) {
      if (!tc) return 'Custom';
      if (tc.name) return tc.name;
      var base = (typeof tc.baseSeconds === 'number') ? tc.baseSeconds : 0;
      var inc = (typeof tc.incrementSeconds === 'number') ? tc.incrementSeconds : 0;
      var baseStr = baseDisplay(base);
      var incStr = inc > 0 ? ('+' + inc) : '';
      return baseStr + incStr;
      }

   /**
    * Category from a time control. Falls back to the 40·increment formula when
    * only a base time is present, matching Lichess tagging.
    */
   function getCategory(tc) {
      if (!tc) return 'Unknown';
      var base = (typeof tc.baseSeconds === 'number') ? tc.baseSeconds : 0;
      var inc = (typeof tc.incrementSeconds === 'number') ? tc.incrementSeconds : 0;
      var effective;
      if (inc > 0) {
        effective = base + 40 * inc;
       } else {
        effective = base;
       }
      for (var i = 0; i < CATEGORIES.length; i++) {
        if (effective < CATEGORIES[i].max) return CATEGORIES[i].name;
       }
      return 'Classical';
   }

   function clampBase(baseSeconds) {
      return Math.max(1, Math.min(72000, Math.round(baseSeconds)));
   }

   function clampIncrement(incSeconds) {
      return Math.max(0, Math.min(120, Math.round(incSeconds || 0)));
   }

   /**
    * Normalize a time-control descriptor. Honors an explicit preset id, or builds
    * a custom one from baseSeconds/incrementSeconds. Optional per-color, delay,
    * bronstein, and odds fields are carried through and validated.
    *
    * @param {Object} args
    * @returns {Object} normalized timeControl descriptor
    */
   function normalize(args) {
      args = args || {};
      var tc;
      if (args.preset && PRESETS[args.preset]) {
        var p = PRESETS[args.preset];
        tc = {
          preset: args.preset,
          baseSeconds: p.baseSeconds,
          incrementSeconds: p.incrementSeconds,
          name: args.name || p.name
          };
       } else if (typeof args.baseSeconds === 'number') {
        tc = {
          preset: 'custom',
          baseSeconds: clampBase(args.baseSeconds),
          incrementSeconds: clampIncrement(args.incrementSeconds),
          name: args.name || ('Custom ' + baseDisplay(clampBase(args.baseSeconds)))
         };
      } else {
        // Default.
        tc = {
          preset: 'rapid_10_15',
          baseSeconds: 600,
          incrementSeconds: 15,
          name: 'Rapid 10+15'
         };
      }

      // Per-color override: white/black clocks may differ.
      tc.perColor = {
        white: clampBase(typeof args.white === 'number' ? args.white : tc.baseSeconds),
        black: clampBase(typeof args.black === 'number' ? args.black : tc.baseSeconds)
       };

      // Simple delay / Bronstein.
      if (typeof args.delay === 'number') {
        tc.delay = Math.max(0, Math.min(1200, Math.round(args.delay)));
      } else {
        tc.delay = 0;
       }
      tc.bronstein = args.bronstein === true;

      // Odds / handicap.
      if (args.odds) {
        var oddsName = ODDS_MATERIAL.hasOwnProperty(args.odds) ? args.odds : 'none';
        tc.odds = {
          type: oddsName,
          material: ODDS_MATERIAL[oddsName],
          color: (args.oddsFor === 'black') ? 'black' : 'white'
         };
       } else {
        tc.odds = null;
       }

      tc.category = getCategory(tc);
      tc.label = getLabel(tc);
      return tc;
   }

   /**
    * Resolve a color's starting clock from a normalized descriptor. Per-color wins
    * when specified; otherwise both colors start at baseSeconds.
    */
   function startingClocks(tc) {
      if (!tc) return { white: 600, black: 600 };
      if (tc.perColor) {
        return { white: tc.perColor.white, black: tc.perColor.black };
       }
      var base = (typeof tc.baseSeconds === 'number') ? tc.baseSeconds : 600;
      return { white: base, black: base };
   }

   /**
    * Compute the remaining clock after a move under the configured mode.
    *
    * @param {Object} args {
    *   remaining: number,   // clock before the move (seconds)
    *   baseSeconds: number, // the color's starting base
    *   incrementSeconds: number,
    *   moveDuration: number, // seconds the move took
    *   delay: number,
    *   bronstein: boolean
    * }
    * @returns {number} remaining seconds after the move (never below 0 unless flag)
    */
   function advanceClock(args) {
      args = args || {};
      var remaining = (typeof args.remaining === 'number') ? args.remaining : 0;
      var base = (typeof args.baseSeconds === 'number') ? args.baseSeconds : 0;
      var inc = clampIncrement(args.incrementSeconds);
      var dur = (typeof args.moveDuration === 'number') ? args.moveDuration : 0;
      var delay = (typeof args.delay === 'number') ? args.delay : 0;
      var bronstein = args.bronstein === true;

      // Simple delay: the first `delay` seconds of every move are free — the main
      // clock does not tick during that window.
      var clockUsed = Math.max(0, dur - delay);
      var after = remaining - clockUsed;

      if (bronstein) {
        // Bronstein: increment only when the move consumed >= delay; it is added
        // to the base, not the running clock, and only if it does not exceed base.
        if (dur >= delay && inc > 0) {
          var added = Math.min(inc, base - remaining);
          if (added < 0) added = 0;
          after = remaining + added - clockUsed;
          // Keep within [0, base].
          if (after > base) after = base;
          if (after < 0) after = 0;
          return after;
         }
        // No increment this move under Bronstein (move was short of delay).
        return Math.max(0, after);
       }

      // Standard increment.
      after = after + inc;
      return Math.max(0, after);
   }

   /**
    * Build a full clock descriptor for one color, including delay/bronstein/odds.
    */
   function buildColor(tc, color) {
      var clocks = startingClocks(tc);
      var c = clocks[color] !== undefined ? clocks[color] : clocks.white;
      return {
        clock: c,
        delay: tc.delay || 0,
        bronstein: tc.bronstein === true,
        increment: tc.incrementSeconds || 0,
        base: c
       };
   }

   var api = {
      CATEGORIES: CATEGORIES,
      PRESETS: PRESETS,
      ODDS_MATERIAL: ODDS_MATERIAL,
      minutesString: minutesString,
      labelFormula: labelFormula,
      getLabel: getLabel,
      getCategory: getCategory,
      clampBase: clampBase,
      clampIncrement: clampIncrement,
      normalize: normalize,
      startingClocks: startingClocks,
      advanceClock: advanceClock,
      buildColor: buildColor
   };

   if (typeof module !== 'undefined' && module.exports) {
     module.exports = api;
    }
   if (typeof window !== 'undefined') {
     window.TimeControl = api;
    }
 })();
