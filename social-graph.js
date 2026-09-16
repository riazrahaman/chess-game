/**
 * social-graph.js — S5 Social graph lite.
 *
 * Pure module. Models a directed follow/friend graph with mutual-follow
 * (friend) detection and a block list, persisted through an injected storage
 * backend (game-archive) so no data is fabricated. Degrades to in-memory when
 * no backend is provided.
 *
 * Gate-4 safe: no makeMove/createInitialBoard, no require of referee/rules-engine/
 * engine. Deterministic: no Math.random.
 *
 * Dual-format module: CommonJS (Node) and browser script.
 */
(function () {
    'use strict';

    function SocialGraph(options) {
        options = options || {};
        this.follows = {};       // userId -> Set<targetId>
        this.blocks = {};        // userId -> Set<targetId>
        this.backend = options.backend || null; // optional: { loadGraph, saveGraph }
        this._load();
    }

    SocialGraph.prototype._serialize = function () {
        var follows = {};
        var blocks = {};
        Object.keys(this.follows).forEach(function (k) { follows[k] = Array.from(this.follows[k]); }, this);
        Object.keys(this.blocks).forEach(function (k) { blocks[k] = Array.from(this.blocks[k]); }, this);
        return { follows: follows, blocks: blocks };
    };

    SocialGraph.prototype._load = function () {
        if (this.backend && typeof this.backend.loadGraph === 'function') {
            var data = this.backend.loadGraph();
            if (data && typeof data === 'object') {
                var self = this;
                Object.keys(data.follows || {}).forEach(function (k) {
                    self.follows[k] = new Set(data.follows[k] || []);
                });
                Object.keys(data.blocks || {}).forEach(function (k) {
                    self.blocks[k] = new Set(data.blocks[k] || []);
                });
                return;
            }
        }
        this.follows = {};
        this.blocks = {};
    };

    SocialGraph.prototype._save = function () {
        if (this.backend && typeof this.backend.saveGraph === 'function') {
            this.backend.saveGraph(this._serialize());
        }
    };

    SocialGraph.prototype._ensure = function (u) {
        if (!this.follows[u]) this.follows[u] = new Set();
        if (!this.blocks[u]) this.blocks[u] = new Set();
    };

    SocialGraph.prototype.follow = function (follower, target) {
        if (follower == null || target == null) return false;
        if (follower === target) return false;
        this._ensure(follower);
        if (this.blocks[follower].has(target)) return false; // can't follow a blocked user
        this.follows[follower].add(target);
        this._save();
        return true;
    };

    SocialGraph.prototype.unfollow = function (follower, target) {
        this._ensure(follower);
        var had = this.follows[follower].has(target);
        this.follows[follower].delete(target);
        if (had) this._save();
        return had;
    };

    SocialGraph.prototype.block = function (user, target) {
        if (user == null || target == null || user === target) return false;
        this._ensure(user);
        this.blocks[user].add(target);
        this.follows[user].delete(target);   // blocking removes any follow
        this.follows[target] && this.follows[target].delete(user); // and any reverse follow
        this._save();
        return true;
    };

    SocialGraph.prototype.unblock = function (user, target) {
        this._ensure(user);
        var had = this.blocks[user].has(target);
        this.blocks[user].delete(target);
        if (had) this._save();
        return had;
    };

    SocialGraph.prototype.isFollowing = function (follower, target) {
        return !!(this.follows[follower] && this.follows[follower].has(target));
    };

    SocialGraph.prototype.isBlocked = function (user, target) {
        return !!(this.blocks[user] && this.blocks[user].has(target));
    };

    SocialGraph.prototype.areFriends = function (a, b) {
        return this.isFollowing(a, b) && this.isFollowing(b, a);
    };

    SocialGraph.prototype.followersOf = function (user) {
        var out = [];
        var self = this;
        Object.keys(this.follows).forEach(function (u) {
            if (self.follows[u].has(user)) out.push(u);
        });
        return out;
    };

    SocialGraph.prototype.followingOf = function (user) {
        return this.follows[user] ? Array.from(this.follows[user]) : [];
    };

    SocialGraph.prototype.mutualFriends = function (user) {
        var self = this;
        return this.followingOf(user).filter(function (t) { return self.isFollowing(t, user); });
    };

    SocialGraph.prototype.blockedBy = function (user) {
        var out = [];
        var self = this;
        Object.keys(this.blocks).forEach(function (u) {
            if (self.blocks[u].has(user)) out.push(u);
        });
        return out;
    };

    var api = {
        SocialGraph: SocialGraph
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (typeof window !== 'undefined') {
        window.SocialGraph = api;
    }
})();
