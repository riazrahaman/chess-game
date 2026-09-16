/**
 * correspondence.js — S7 Correspondence mode.
 *
 * Pure module. Models turn-based correspondence games with day-based clocks,
 * moves persisted through an injected store, and per-player notification state.
 * Supports conditional premoves (a move to play automatically if the opponent
 * plays a predicted reply).
 *
 * Gate-4 safe: no makeMove/createInitialBoard, no require of referee/rules-engine/
 * engine. Deterministic: no Math.random.
 *
 * Dual-format module: CommonJS (Node) and browser script.
 */
(function () {
    'use strict';

    var DAY_MS = 24 * 60 * 60 * 1000;

    function CorrespondenceGame(options) {
        options = options || {};
        this.id = options.id || 'game';
        this.players = options.players || ['white', 'black'];
        this.turn = options.turn || this.players[0];
        this.moves = options.moves || [];          // [{ san, by, ts }]
        this.daysPerMove = options.daysPerMove || 3;
        this.clockStartedAt = options.clockStartedAt || Date.now();
        this.deadlineAt = options.deadlineAt || (this.clockStartedAt + this.daysPerMove * DAY_MS);
        this.conditionalPremoves = {};              // playerId -> { ifMove, reply }
        this.notifications = {};                    // playerId -> { newMoves: number, deadline: bool }
        this.store = options.store || null;         // { load, save }
        this._load();
    }

    CorrespondenceGame.prototype._serialize = function () {
        return {
            id: this.id,
            players: this.players,
            turn: this.turn,
            moves: this.moves,
            daysPerMove: this.daysPerMove,
            clockStartedAt: this.clockStartedAt,
            deadlineAt: this.deadlineAt,
            conditionalPremoves: this.conditionalPremoves,
            notifications: this.notifications
        };
    };

    CorrespondenceGame.prototype._load = function () {
        if (this.store && typeof this.store.load === 'function') {
            var d = this.store.load(this.id);
            if (d && typeof d === 'object') {
                this.players = d.players || this.players;
                this.turn = d.turn || this.turn;
                this.moves = d.moves || this.moves;
                this.daysPerMove = d.daysPerMove || this.daysPerMove;
                this.clockStartedAt = d.clockStartedAt || this.clockStartedAt;
                this.deadlineAt = d.deadlineAt || this.deadlineAt;
                this.conditionalPremoves = d.conditionalPremoves || {};
                this.notifications = d.notifications || {};
            }
        }
    };

    CorrespondenceGame.prototype._save = function () {
        if (this.store && typeof this.store.save === 'function') {
            this.store.save(this._serialize());
        }
    };

    CorrespondenceGame.prototype._opponent = function (p) {
        return this.players[0] === p ? this.players[1] : this.players[0];
    };

    CorrespondenceGame.prototype._touchNotifications = function (mover) {
        var opp = this._opponent(mover);
        if (!this.notifications[opp]) this.notifications[opp] = { newMoves: 0, deadline: false };
        this.notifications[opp].newMoves += 1;
    };

    CorrespondenceGame.prototype.makeMove = function (san, by) {
        if (by !== this.turn) throw new Error('not your turn: ' + by);
        this.moves.push({ san: san, by: by, ts: Date.now() });
        this._touchNotifications(by);
        this.turn = this._opponent(by);
        this.clockStartedAt = Date.now();
        this.deadlineAt = this.clockStartedAt + this.daysPerMove * DAY_MS;
        this._save();
        return this.moves.length;
    };

    CorrespondenceGame.prototype.setConditionalPremove = function (player, ifMove, reply) {
        if (player !== this._opponent(this.turn)) {
            throw new Error('conditional premove only when it is the opponent to move');
        }
        this.conditionalPremoves[player] = { ifMove: ifMove, reply: reply };
        this._save();
        return true;
    };

    CorrespondenceGame.prototype.resolveConditionalPremove = function (san, by) {
        var cp = this.conditionalPremoves[this.turn];
        if (cp && cp.ifMove === san) {
            delete this.conditionalPremoves[this.turn];
            return cp.reply;
        }
        return null;
    };

    CorrespondenceGame.prototype.clearConditionalPremove = function (player) {
        delete this.conditionalPremoves[player];
        this._save();
    };

    CorrespondenceGame.prototype.hoursRemaining = function () {
        return Math.max(0, (this.deadlineAt - Date.now()) / 3600000);
    };

    CorrespondenceGame.prototype.isFlagged = function () {
        return Date.now() > this.deadlineAt;
    };

    CorrespondenceGame.prototype.turnPlayer = function () {
        return this.turn;
    };

    CorrespondenceGame.prototype.clearNotifications = function (player) {
        if (this.notifications[player]) {
            this.notifications[player].newMoves = 0;
            this.notifications[player].deadline = false;
        }
        this._save();
    };

    var api = {
        CorrespondenceGame: CorrespondenceGame,
        DAY_MS: DAY_MS
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (typeof window !== 'undefined') {
        window.Correspondence = api;
    }
})();
