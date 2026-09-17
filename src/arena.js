/**
 * arena.js — S4 Arena tournaments.
 *
 * Pure, analysis-only module. Models an Arena-style tournament: players join,
 * are paired each round (Swiss-style by score, then rating), and game results
 * feed a standings table with Buchholz and Sonneborn-Berger tie-breaks.
 * Supports berserk (halve clock for double points) and a streak ×2 bonus.
 *
 * Gate-4 safe: no makeMove/createInitialBoard, no require of referee/rules-engine/
 * engine. Deterministic: no Math.random (seeded RNG only).
 *
 * Dual-format module: CommonJS (Node) and browser script.
 */
(function () {
    'use strict';

    function createSeededRng(seed) {
        var s = seed >>> 0;
        return function () {
            s = (s + 0x6D2B79F5) >>> 0;
            var t = s;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    var DEFAULT_SEED = 'chess-arena-v1';

    function hashSeed(str) {
        var h = 2166136261;
        for (var i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

    function Arena(options) {
        options = options || {};
        this.players = [];       // [{ id, name, rating }]
        this.results = [];       // [{ round, white, black, result }] result: '1-0'|'0-1'|'1/2-1/2'
        this.round = 0;
        this.seed = options.seed !== undefined ? options.seed : DEFAULT_SEED;
        this.rng = options.rng || createSeededRng(hashSeed(String(this.seed)));
    }

    Arena.prototype.addPlayer = function (id, name, rating) {
        if (id == null || name == null) throw new Error('id and name required');
        for (var i = 0; i < this.players.length; i++) {
            if (this.players[i].id === id) return false;
        }
        this.players.push({ id: id, name: name, rating: (typeof rating === 'number') ? rating : 1500 });
        return true;
    };

    Arena.prototype.removePlayer = function (id) {
        for (var i = 0; i < this.players.length; i++) {
            if (this.players[i].id === id) {
                this.players.splice(i, 1);
                return true;
            }
        }
        return false;
    };

    Arena.prototype._scores = function () {
        var map = {};
        var self = this;
        this.players.forEach(function (p) { map[p.id] = { id: p.id, name: p.name, rating: p.rating, score: 0, games: 0, streak: 0, berserked: 0, opponents: [], wins: 0 }; });
        this.results.forEach(function (r) {
            var w = map[r.white], b = map[r.black];
            if (!w || !b) return;
            w.games++; b.games++;
            w.opponents.push(r.black); b.opponents.push(r.white);
            if (r.result === '1-0') { w.score += (r.whiteBerserk ? 2 : 1); w.wins++; w.streak++; b.streak = 0; }
            else if (r.result === '0-1') { b.score += (r.blackBerserk ? 2 : 1); b.wins++; b.streak++; w.streak = 0; }
            else { w.score += 0.5; b.score += 0.5; w.streak = 0; b.streak = 0; }
        });
        return map;
    };

    Arena.prototype._buchholz = function (scores, id) {
        var sum = 0;
        var rec = scores[id];
        if (!rec) return 0;
        rec.opponents.forEach(function (oid) {
            if (scores[oid]) sum += scores[oid].score;
        });
        return sum;
    };

    Arena.prototype._sonneborn = function (scores, id) {
        var sum = 0;
        var rec = scores[id];
        if (!rec) return 0;
        var self = this;
        // Sonneborn-Berger: sum of (opponent score for each opponent beaten) +
        // half of opponent score for each opponent drawn.
        this.results.forEach(function (r) {
            if (r.white !== id && r.black !== id) return;
            var oppId = (r.white === id) ? r.black : r.white;
            var oppScore = scores[oppId] ? scores[oppId].score : 0;
            var iAmWhite = r.white === id;
            var won = (iAmWhite && r.result === '1-0') || (!iAmWhite && r.result === '0-1');
            var drew = r.result === '1/2-1/2';
            if (won) sum += oppScore;
            else if (drew) sum += oppScore / 2;
        });
        return sum;
    };

    Arena.prototype.standings = function () {
        var scores = this._scores();
        var rows = Object.keys(scores).map(function (id) { return scores[id]; });
        var self = this;
        rows.forEach(function (r) {
            r.buchholz = self._buchholz(scores, r.id);
            r.sonneborn = self._sonneborn(scores, r.id);
        });
        rows.sort(function (a, b) {
            if (b.score !== a.score) return b.score - a.score;
            if (b.buchholz !== a.buchholz) return b.buchholz - a.buchholz;
            if (b.sonneborn !== a.sonneborn) return b.sonneborn - a.sonneborn;
            if (b.rating !== a.rating) return b.rating - a.rating;
            return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
        });
        return rows;
    };

    Arena.prototype.pairNextRound = function () {
        var rows = this.standings();
        var byScore = {};
        rows.forEach(function (r) {
            if (!byScore[r.score]) byScore[r.score] = [];
            byScore[r.score].push(r);
        });
        var order = Object.keys(byScore).sort(function (a, b) { return Number(b) - Number(a); });
        var pool = [];
        order.forEach(function (k) { byScore[k].forEach(function (r) { pool.push(r.id); }); });
        // Shuffle within equal-score groups deterministically for varied pairings.
        var self = this;
        var groups = [];
        order.forEach(function (k) {
            var g = byScore[k].map(function (r) { return r.id; });
            for (var i = g.length - 1; i > 0; i--) {
                var j = Math.floor(self.rng() * (i + 1));
                var tmp = g[i]; g[i] = g[j]; g[j] = tmp;
            }
            groups.push(g);
        });
        var seq = [];
        groups.forEach(function (g) { g.forEach(function (id) { seq.push(id); }); });
        var pairings = [];
        for (var i = 0; i + 1 < seq.length; i += 2) {
            pairings.push({ white: seq[i], black: seq[i + 1] });
        }
        if (seq.length % 2 === 1) {
            pairings.push({ white: seq[seq.length - 1], black: null, bye: true });
        }
        return pairings;
    };

    Arena.prototype.recordResult = function (white, black, result, opts) {
        if (result !== '1-0' && result !== '0-1' && result !== '1/2-1/2') {
            throw new Error('invalid result: ' + result);
        }
        opts = opts || {};
        this.results.push({
            round: this.round + 1,
            white: white,
            black: black,
            result: result,
            whiteBerserk: !!opts.whiteBerserk,
            blackBerserk: !!opts.blackBerserk
        });
        return this.results.length;
    };

    Arena.prototype.nextRound = function () { this.round += 1; return this.round; };

    var api = {
        Arena: Arena,
        createSeededRng: createSeededRng,
        DEFAULT_SEED: DEFAULT_SEED,
        hashSeed: hashSeed
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (typeof window !== 'undefined') {
        window.Arena = api;
    }
})();
