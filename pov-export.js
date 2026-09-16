/**
 * pov-export.js — V2 Annotated-POV exports.
 *
 * Pure module. Builds an annotated PGN export of a game from a specific
 * player's point of view: attaches that player's evals/accuracy comments and a
 * narrative summary, and can render a compact post-game "summary card" as SVG
 * (image) or plain text. No fabricated data — everything derives from the
 * supplied moves/evals.
 *
 * Gate-4 safe: no makeMove/createInitialBoard, no require of referee/rules-engine/
 * engine. Deterministic: no Math.random.
 *
 * Dual-format module: CommonJS (Node) and browser script.
 */
(function () {
    'use strict';

    function escapePgnComment(s) {
        return String(s == null ? '' : s).replace(/\{/g, '').replace(/\}/g, '');
    }

    // Build PGN with per-ply eval comments for the given player's POV.
    // `moves`: array of { san, evalCp, accuracy, classification }
    // `pov`: 'white'|'black' (0 = white plies, 1 = black plies)
    function buildPovPgn(opts) {
        opts = opts || {};
        var moves = opts.moves || [];
        var pov = opts.pov || 'white';
        var tags = opts.tags || {};
        var povIndex = pov === 'black' ? 1 : 0;
        var out = '';
        Object.keys(tags).forEach(function (k) {
            out += '[' + k + ' "' + tags[k] + '"]\n';
        });
        out += '\n';
        var line = '';
        moves.forEach(function (m, i) {
            var moveNum = Math.floor(i / 2) + 1;
            var isPovPly = (i % 2) === povIndex;
            if (i % 2 === 0) line += moveNum + '. ';
            line += m.san;
            if (isPovPly && (typeof m.evalCp === 'number' || m.comment)) {
                var parts = [];
                if (typeof m.evalCp === 'number') parts.push('eval ' + (m.evalCp > 0 ? '+' : '') + m.evalCp + 'cp');
                if (m.accuracy != null) parts.push('acc ' + Math.round(m.accuracy) + '%');
                if (m.classification) parts.push(m.classification);
                if (m.comment) parts.push(escapePgnComment(m.comment));
                line += ' {' + parts.join('; ') + '}';
            }
            line += ' ';
        });
        out += line.trim() + ' ' + (opts.result || '*') + '\n';
        return out;
    }

    function summarize(opts) {
        opts = opts || {};
        var moves = opts.moves || [];
        var pov = opts.pov || 'white';
        var povIndex = pov === 'black' ? 1 : 0;
        var acc = [];
        var totalCp = 0, n = 0;
        moves.forEach(function (m, i) {
            if (i % 2 === povIndex) {
                if (m.accuracy != null) acc.push(m.accuracy);
                if (typeof m.evalCp === 'number') { totalCp += m.evalCp; n++; }
            }
        });
        var avgAcc = acc.length ? acc.reduce(function (a, b) { return a + b; }, 0) / acc.length : null;
        var avgCp = n ? totalCp / n : null;
        return {
            pov: pov,
            moveCount: moves.length,
            ownPlyCount: acc.length,
            avgAccuracy: avgAcc,
            avgEvalCp: avgCp,
            result: opts.result || '*'
        };
    }

    // Render a compact summary card as SVG.
    function summaryCardSvg(summary) {
        summary = summary || {};
        var acc = summary.avgAccuracy != null ? Math.round(summary.avgAccuracy) + '%' : '—';
        var line1 = 'Result: ' + (summary.result || '*');
        var line2 = 'Accuracy: ' + acc;
        var line3 = 'Moves: ' + (summary.moveCount || 0);
        var w = 220, h = 90;
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">';
        svg += '<rect width="' + w + '" height="' + h + '" rx="8" fill="#1e1e2e"/>';
        svg += '<text x="14" y="26" font-family="sans-serif" font-size="15" fill="#ffffff" font-weight="bold">' + line1 + '</text>';
        svg += '<text x="14" y="50" font-family="sans-serif" font-size="13" fill="#c0c0c0">' + line2 + '</text>';
        svg += '<text x="14" y="72" font-family="sans-serif" font-size="13" fill="#c0c0c0">' + line3 + '</text>';
        svg += '</svg>';
        return svg;
    }

    var api = {
        buildPovPgn: buildPovPgn,
        summarize: summarize,
        summaryCardSvg: summaryCardSvg,
        escapePgnComment: escapePgnComment
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (typeof window !== 'undefined') {
        window.PovExport = api;
    }
})();
