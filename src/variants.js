/**
 * variants.js — V4 Variants (rule helpers).
 *
 * Pure module. Rule helpers for chess variants as pure functions over board
 * state: Crazyhouse (drop pocket), Atomic (explosion captures), King-of-the-hill
 * (win by reaching d4/e4/d5/e5), and Three-Check (win by delivering 3rd check).
 * No real move generation — just the variant-specific predicates/transformations
 * that a caller composes with a normal move engine.
 *
 * Gate-4 safe: no makeMove/createInitialBoard, no require of referee/rules-engine/
 * engine. Deterministic: no Math.random.
 *
 * Dual-format module: CommonJS (Node) and browser script.
 */
(function () {
    'use strict';

    var KING_HILL_SQUARES = ['d4', 'e4', 'd5', 'e5'];

    // Crazyhouse: a captured piece (color-flipped, pawns excluded) enters the
    // capturer's pocket for later drops.
    function crazyhouseCapture(pocket, capturedPiece) {
        if (!capturedPiece) return pocket;
        if (capturedPiece === 'p' || capturedPiece === 'P') return pocket; // pawns are not kept
        var out = pocket.slice();
        var flipped = capturedPiece === capturedPiece.toUpperCase()
            ? capturedPiece.toLowerCase()
            : capturedPiece.toUpperCase();
        out.push(flipped);
        out.sort();
        return out;
    }

    // Crazyhouse: a drop places a pocket piece on an empty square.
    function crazyhouseDrop(pocket, piece, targetSquare, boardOccupied) {
        var idx = pocket.indexOf(piece);
        if (idx === -1) return null;
        if (boardOccupied[targetSquare]) return null; // can't drop on occupied
        var out = pocket.slice();
        out.splice(idx, 1);
        return out;
    }

    // Atomic: capturing removes the capture target AND all non-pawn pieces on
    // the 8 surrounding squares (the capturing piece is also removed).
    function atomicCaptureSquares(fromIndex, toIndex, board) {
        var captured = board[toIndex];
        if (!captured) return []; // not a capture, no explosion
        var removed = [fromIndex, toIndex];
        var r = Math.floor(toIndex / 8), c = toIndex % 8;
        for (var dr = -1; dr <= 1; dr++) {
            for (var dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                var rr = r + dr, cc = c + dc;
                if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
                var idx = rr * 8 + cc;
                var p = board[idx];
                if (p && p !== 'p' && p !== 'P') {
                    if (removed.indexOf(idx) === -1) removed.push(idx);
                }
            }
        }
        return removed.sort(function (a, b) { return a - b; });
    }

    // King-of-the-hill: win condition when a king sits on d4/e4/d5/e5.
    function isKingOfTheHillWin(board, side) {
        var king = side === 'white' ? 'K' : 'k';
        for (var i = 0; i < KING_HILL_SQUARES.length; i++) {
            var sq = KING_HILL_SQUARES[i];
            var idx = (8 - parseInt(sq[1], 10)) * 8 + 'abcdefgh'.indexOf(sq[0]);
            if (board[idx] === king) return true;
        }
        return false;
    }

    function squareIndex(square) {
        return (8 - parseInt(square[1], 10)) * 8 + 'abcdefgh'.indexOf(square[0]);
    }

    // Three-Check: track checks delivered per side; win when a side reaches 3.
    function threeCheckState(checks, deliverer) {
        var out = { white: checks.white, black: checks.black };
        if (deliverer === 'white') out.white += 1;
        else if (deliverer === 'black') out.black += 1;
        return out;
    }

    function threeCheckWin(checks) {
        return checks.white >= 3 ? 'white' : (checks.black >= 3 ? 'black' : null);
    }

    var api = {
        KING_HILL_SQUARES: KING_HILL_SQUARES,
        crazyhouseCapture: crazyhouseCapture,
        crazyhouseDrop: crazyhouseDrop,
        atomicCaptureSquares: atomicCaptureSquares,
        isKingOfTheHillWin: isKingOfTheHillWin,
        squareIndex: squareIndex,
        threeCheckState: threeCheckState,
        threeCheckWin: threeCheckWin
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (typeof window !== 'undefined') {
        window.Variants = api;
    }
})();
