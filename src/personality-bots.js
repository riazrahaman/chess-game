/**
 * personality-bots.js — V1 Personality bots.
 *
 * Pure module. Defines named bot personas with distinct play-style biases
 * (aggression, solidity, risk) that influence move selection via a scoring
 * modifier, plus deterministic chat lines. Seeded RNG only.
 *
 * Gate-4 safe: no makeMove/createInitialBoard, no require of referee/rules-engine/
 * engine. Deterministic: no Math.random.
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

    function hashSeed(str) {
        var h = 2166136261;
        for (var i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

    var PERSONAS = {
        'tal':   { name: 'Tal',   style: 'aggressive', aggression: 1.0, solidity: 0.1, risk: 0.9, avatar: '♞', lines: ['Sacrifices make the game beautiful.', 'Attack, always attack.', 'I saw it all.'] },
        'karpov': { name: 'Karpov', style: 'solid', aggression: 0.1, solidity: 1.0, risk: 0.1, avatar: '♖', lines: ['Position first, tactics later.', 'Small advantages accumulate.', 'Patience wins games.'] },
        'capablanca': { name: 'Capablanca', style: 'endgame', aggression: 0.3, solidity: 0.8, risk: 0.2, avatar: '♔', lines: ['The endgame is where I shine.', 'Simplify and win.', 'A good plan is everything.'] },
        'morphy': { name: 'Morphy', style: 'development', aggression: 0.7, solidity: 0.5, risk: 0.6, avatar: '♗', lines: ['Develop, develop, develop!', 'Tempo is everything.', 'Open lines, open attacks.'] },
        'nimzowitsch': { name: 'Nimzowitsch', style: 'prophylaxis', aggression: 0.2, solidity: 0.9, risk: 0.3, avatar: '♘', lines: ['Restrain, blockade, destroy.', 'Prevention is better than cure.', 'Overprotect your strong points.'] }
    };

    var DEFAULT_PERSONA = 'tal';

    function persona(id) {
        var key = (id && PERSONAS[id]) ? id : DEFAULT_PERSONA;
        return Object.assign({ id: key }, PERSONAS[key]);
    }

    function listPersonas() {
        return Object.keys(PERSONAS).map(function (k) {
            return { id: k, name: PERSONAS[k].name, style: PERSONAS[k].style, avatar: PERSONAS[k].avatar };
        });
    }

    // Adjust a raw move score by the persona's biases. Higher aggression favors
    // moves that trade material for activity; solidity favors quiet moves.
    // `moveScore` is an engine-like centipawn eval, `activity` is a heuristic
    // 0..1 of how "sharp" the move is. Returns the adjusted score.
    function adjustScore(id, moveScore, activity) {
        var p = persona(id);
        var activityBias = (p.aggression - p.solidity) * (activity || 0);
        return moveScore + activityBias * 40; // up to ±40cp bias
    }

    function pickMove(id, candidates, rng) {
        rng = rng || createSeededRng(hashSeed(id || DEFAULT_PERSONA));
        if (!candidates || !candidates.length) return null;
        var best = null;
        var bestScore = -Infinity;
        for (var i = 0; i < candidates.length; i++) {
            var c = candidates[i];
            var adj = adjustScore(id, c.score, c.activity);
            if (adj > bestScore) {
                bestScore = adj;
                best = c;
            }
        }
        return best;
    }

    function chatLine(id, rng) {
        rng = rng || createSeededRng(hashSeed(id || DEFAULT_PERSONA));
        var p = persona(id);
        var idx = Math.floor(rng() * p.lines.length);
        return p.lines[idx];
    }

    var api = {
        PERSONAS: PERSONAS,
        DEFAULT_PERSONA: DEFAULT_PERSONA,
        persona: persona,
        listPersonas: listPersonas,
        adjustScore: adjustScore,
        pickMove: pickMove,
        chatLine: chatLine,
        createSeededRng: createSeededRng,
        hashSeed: hashSeed
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (typeof window !== 'undefined') {
        window.PersonalityBots = api;
    }
})();
