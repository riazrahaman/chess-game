/**
 * i18n.js — M2 i18n layer.
 *
 * Pure module. A message catalog keyed by locale with `{placeholder}`
 * interpolation and a graceful fallback chain (requested locale -> default ->
 * raw key). Extracts UI strings out of hardcoded English.
 *
 * Gate-4 safe: no makeMove/createInitialBoard, no require of referee/rules-engine/
 * engine. Deterministic: no Math.random.
 *
 * Dual-format module: CommonJS (Node) and browser script.
 */
(function () {
    'use strict';

    var DEFAULT_LOCALE = 'en';

    var CATALOG = {
        en: {
            'app.title': 'Chess',
            'game.white': 'White',
            'game.black': 'Black',
            'game.draw': 'Draw',
            'game.resign': 'Resign',
            'game.undo': 'Undo',
            'game.new': 'New game',
            'status.check': 'Check',
            'status.checkmate': 'Checkmate',
            'status.stalemate': 'Stalemate',
            'status.yourTurn': 'Your turn',
            'status.opponentTurn': 'Opponent\'s turn',
            'greeting': 'Hello, {name}!',
            'move.made': '{player} played {move}'
        },
        es: {
            'app.title': 'Ajedrez',
            'game.white': 'Blancas',
            'game.black': 'Negras',
            'game.draw': 'Tablas',
            'game.resign': 'Rendirse',
            'game.undo': 'Deshacer',
            'game.new': 'Nueva partida',
            'status.check': 'Jaque',
            'status.checkmate': 'Jaque mate',
            'status.stalemate': 'Ahogado',
            'status.yourTurn': 'Tu turno',
            'status.opponentTurn': 'Turno del rival',
            'greeting': 'Hola, {name}!',
            'move.made': '{player} jugó {move}'
        },
        fr: {
            'app.title': 'Échecs',
            'game.white': 'Blancs',
            'game.black': 'Noirs',
            'game.draw': 'Nulle',
            'game.resign': 'Abandonner',
            'game.undo': 'Annuler',
            'game.new': 'Nouvelle partie',
            'status.check': 'Échec',
            'status.checkmate': 'Échec et mat',
            'status.stalemate': 'Pat',
            'status.yourTurn': 'À toi de jouer',
            'status.opponentTurn': 'Tour de l\'adversaire',
            'greeting': 'Bonjour, {name} !',
            'move.made': '{player} a joué {move}'
        }
    };

    function createI18n(options) {
        options = options || {};
        var locale = options.locale || DEFAULT_LOCALE;
        var catalog = options.catalog || CATALOG;
        return {
            setLocale: function (l) { locale = l; },
            getLocale: function () { return locale; },
            has: function (key, l) {
                var loc = l || locale;
                return !!(catalog[loc] && catalog[loc][key] !== undefined);
            },
            t: function (key, params) {
                var msg = (catalog[locale] && catalog[locale][key]);
                if (msg === undefined) msg = (catalog[DEFAULT_LOCALE] && catalog[DEFAULT_LOCALE][key]);
                if (msg === undefined) return key;
                if (params) {
                    Object.keys(params).forEach(function (k) {
                        msg = msg.split('{' + k + '}').join(String(params[k]));
                    });
                }
                return msg;
            },
            availableLocales: function () {
                return Object.keys(catalog);
            }
        };
    }

    function interpolate(template, params) {
        var out = template;
        if (params) {
            Object.keys(params).forEach(function (k) {
                out = out.split('{' + k + '}').join(String(params[k]));
            });
        }
        return out;
    }

    var api = {
        DEFAULT_LOCALE: DEFAULT_LOCALE,
        CATALOG: CATALOG,
        createI18n: createI18n,
        interpolate: interpolate
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (typeof window !== 'undefined') {
        window.I18n = api;
    }
})();
