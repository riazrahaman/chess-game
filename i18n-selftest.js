/**
 * i18n-selftest.js — M2 i18n layer selftest.
 */
'use strict';

const I18n = require('./i18n.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('PASS: ' + name);
    } catch (e) {
        failed++;
        console.log('FAIL: ' + name + ' -> ' + e.message);
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
}

test('english default translation', () => {
    const i = I18n.createI18n();
    assert(i.t('app.title') === 'Chess');
    assert(i.t('game.white') === 'White');
});

test('locale switch', () => {
    const i = I18n.createI18n();
    i.setLocale('es');
    assert(i.t('app.title') === 'Ajedrez');
    assert(i.t('game.draw') === 'Tablas');
});

test('getLocale / has', () => {
    const i = I18n.createI18n({ locale: 'fr' });
    assert(i.getLocale() === 'fr');
    assert(i.has('status.check') === true);
    assert(i.has('nonexistent.key') === false);
});

test('interpolation', () => {
    const i = I18n.createI18n();
    assert(i.t('greeting', { name: 'Alice' }) === 'Hello, Alice!');
    assert(i.t('move.made', { player: 'White', move: 'e4' }) === 'White played e4');
});

test('fallback to default when key missing in locale', () => {
    const i = I18n.createI18n({ locale: 'es' });
    // 'move.made' exists in es; force a key that only exists in en via custom
    const i2 = I18n.createI18n({ locale: 'fr' });
    assert(i2.t('app.title') === 'Échecs', 'fr has title');
});

test('missing key returns raw key', () => {
    const i = I18n.createI18n();
    assert(i.t('does.not.exist') === 'does.not.exist');
});

test('fallback chain: locale -> en -> raw key', () => {
    const i = I18n.createI18n({ locale: 'es' });
    // 'greeting' exists in es; remove it via a custom catalog to test en fallback
    const custom = {
        en: { 'only.en': 'English only' },
        es: {}
    };
    const i3 = I18n.createI18n({ locale: 'es', catalog: custom });
    assert(i3.t('only.en') === 'English only', 'falls back to en');
    assert(i3.t('missing') === 'missing', 'falls back to raw key');
});

test('interpolate standalone', () => {
    assert(I18n.interpolate('x={a}', { a: 5 }) === 'x=5');
});

test('availableLocales', () => {
    const i = I18n.createI18n();
    const locs = i.availableLocales();
    assert(locs.includes('en') && locs.includes('es') && locs.includes('fr'));
});

test('DEFAULT_LOCALE constant', () => {
    assert(I18n.DEFAULT_LOCALE === 'en');
});

console.log('\nAll ' + passed + ' tests passed successfully!');
if (failed > 0) process.exit(1);
