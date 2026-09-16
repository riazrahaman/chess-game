/**
 * chat-upgrades.js — S6 Chat upgrades.
 *
 * Pure module. Adds chat-message types (move references, draw offers, reactions/
 * emoji), a moderation filter, and a bounded message history. No real transport —
 * callers inject persistence or keep it in-memory. No fabricated data.
 *
 * Gate-4 safe: no makeMove/createInitialBoard, no require of referee/rules-engine/
 * engine. Deterministic: no Math.random.
 *
 * Dual-format module: CommonJS (Node) and browser script.
 */
(function () {
    'use strict';

    var MAX_HISTORY = 200;
    var BANNED_WORDS = ['idiot', 'stupid', 'hate']; // minimal example list

    function Chat(options) {
        options = options || {};
        this.messages = [];       // [{ id, author, type, body, ts, refs }]
        this.maxHistory = (typeof options.maxHistory === 'number') ? options.maxHistory : MAX_HISTORY;
        this.banned = options.banned || BANNED_WORDS.slice();
        this.nextId = 1;
        this.whisperTargets = {}; // room -> Map<recipient, [messageIds]>
    }

    Chat.prototype._cap = function () {
        while (this.messages.length > this.maxHistory) {
            this.messages.shift();
        }
    };

    Chat.prototype.send = function (author, body, opts) {
        opts = opts || {};
        var type = opts.type || 'chat';
        var msg = {
            id: this.nextId++,
            author: author,
            type: type,
            body: body,
            ts: opts.ts || Date.now(),
            refs: opts.refs || null
        };
        if (opts.whisperTo) msg.whisperTo = opts.whisperTo;
        this.messages.push(msg);
        this._cap();
        return msg;
    };

    Chat.prototype.sendMoveRef = function (author, san, fen) {
        return this.send(author, san, { type: 'move', refs: { san: san, fen: fen } });
    };

    Chat.prototype.sendDrawOffer = function (author) {
        return this.send(author, 'draw offer', { type: 'draw_offer' });
    };

    Chat.prototype.sendReaction = function (author, messageId, emoji) {
        var target = this.messages.find(function (m) { return m.id === messageId; });
        if (!target) return null;
        if (!target.reactions) target.reactions = {};
        if (!target.reactions[emoji]) target.reactions[emoji] = [];
        if (!target.reactions[emoji].includes(author)) target.reactions[emoji].push(author);
        return target.reactions[emoji].length;
    };

    Chat.prototype.history = function () {
        return this.messages.slice();
    };

    Chat.prototype.filter = function (text) {
        if (typeof text !== 'string') return '';
        var out = text;
        this.banned.forEach(function (w) {
            var re = new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
            out = out.replace(re, '****');
        });
        return out;
    };

    Chat.prototype.containsBanned = function (text) {
        if (typeof text !== 'string') return false;
        var lower = text.toLowerCase();
        return this.banned.some(function (w) { return lower.indexOf(w) !== -1; });
    };

    Chat.prototype.sendFiltered = function (author, body, opts) {
        var clean = this.filter(body);
        if (clean === body) return this.send(author, body, opts);
        return this.send(author, clean, opts); // stores the moderated text
    };

    var api = {
        Chat: Chat,
        MAX_HISTORY: MAX_HISTORY
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (typeof window !== 'undefined') {
        window.ChatUpgrades = api;
    }
})();
