/**
 * embed-viewer.js — V3 Embeddable game viewer.
 *
 * Pure module. Renders a self-contained board (SVG) for an embeddable iframe
 * snippet from a PGN/FEN. Produces the board markup plus a wrapper snippet
 * string the caller can paste into an iframe srcdoc. No fabricated data —
 * derives from the supplied position.
 *
 * Gate-4 safe: no makeMove/createInitialBoard, no require of referee/rules-engine/
 * engine. Deterministic: no Math.random.
 *
 * Dual-format module: CommonJS (Node) and browser script.
 */
(function () {
    'use strict';

    var FILES = 'abcdefgh';

    // Parse a FEN board field into a 64-entry array of piece chars.
    // Each char is one of: KQRBNP (white), kqrbnp (black), or '' (empty).
    function fenBoardToArray(boardField) {
        var out = [];
        var rows = String(boardField).split('/');
        for (var r = 0; r < rows.length; r++) {
            var row = rows[r];
            for (var i = 0; i < row.length; i++) {
                var c = row[i];
                if (c >= '1' && c <= '8') {
                    var n = parseInt(c, 10);
                    for (var j = 0; j < n; j++) out.push('');
                } else {
                    out.push(c);
                }
            }
        }
        return out;
    }

    var PIECE_GLYPH = {
        'K': '\u2654', 'Q': '\u2655', 'R': '\u2656', 'B': '\u2657', 'N': '\u2658', 'P': '\u2659',
        'k': '\u265A', 'q': '\u265B', 'r': '\u265C', 'b': '\u265D', 'n': '\u265E', 'p': '\u265F'
    };

    // Render a board SVG. `board` = 64-char array (a8..h1). `lastMove` optional {from,to}.
    function boardSvg(board, opts) {
        opts = opts || {};
        var sq = 48;
        var w = sq * 8;
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + w + '" viewBox="0 0 ' + w + ' ' + w + '">';
        for (var r = 0; r < 8; r++) {
            for (var c = 0; c < 8; c++) {
                var isLight = (r + c) % 2 === 0;
                var fill = isLight ? '#f0d9b5' : '#b58863';
                var x = c * sq, y = r * sq;
                svg += '<rect x="' + x + '" y="' + y + '" width="' + sq + '" height="' + sq + '" fill="' + fill + '"/>';
            }
        }
        for (var i = 0; i < 64; i++) {
            var piece = board[i];
            if (!piece) continue;
            var glyph = PIECE_GLYPH[piece];
            if (!glyph) continue;
            var rr = Math.floor(i / 8), cc = i % 8;
            var cx = cc * sq + sq / 2, cy = rr * sq + sq / 2;
            var isWhite = piece === piece.toUpperCase();
            svg += '<text x="' + cx + '" y="' + (cy + 12) + '" font-size="36" text-anchor="middle" fill="' + (isWhite ? '#ffffff' : '#202020') + '" stroke="' + (isWhite ? '#202020' : '#606060') + '" stroke-width="0.5">' + glyph + '</text>';
        }
        svg += '</svg>';
        return svg;
    }

    // Build a self-contained iframe srcdoc snippet.
    function iframeSnippet(opts) {
        opts = opts || {};
        var board = opts.board;
        if (!board || board.length !== 64) {
            if (opts.fen) board = fenBoardToArray(opts.fen.split(/\s+/)[0]);
            else board = null;
        }
        if (!board) return null;
        var svg = boardSvg(board, opts);
        var title = opts.title || 'Chess game';
        var html = '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title>' +
            '<style>body{margin:0;display:flex;align-items:center;justify-content:center;background:#1e1e2e;min-height:100vh}</style></head>' +
            '<body>' + svg + '</body></html>';
        return html;
    }

    function squareToIndex(square) {
        var f = FILES.indexOf(square[0]);
        var rank = parseInt(square[1], 10);
        if (f < 0 || rank < 1 || rank > 8) return -1;
        return (8 - rank) * 8 + f;
    }

    var api = {
        fenBoardToArray: fenBoardToArray,
        boardSvg: boardSvg,
        iframeSnippet: iframeSnippet,
        squareToIndex: squareToIndex,
        PIECE_GLYPH: PIECE_GLYPH
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (typeof window !== 'undefined') {
        window.EmbedViewer = api;
    }
})();
