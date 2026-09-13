'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const engine = require('./engine.js');
const { PIECE_SVGS, pieceSvgMarkup, renderPieceSvg } = require('./pieces.js');

// SHA-256 fingerprints of the ordered `d` attributes from the standard
// 45x45 cburnett artwork. Keeping these outside pieces.js makes this test an
// independent guard against an accidental piece/path substitution.
const CBURNETT_PATH_HASHES = Object.freeze({
  'white-k': 'd43ecf833028728c35533470e15d3bc1b96c84367d2a5eae808164fe9b53bacf',
  'white-q': 'c167ed5ef86378cce302cfd8b024ffc16738a1b261fdd7f5759db7964427f11f',
  'white-r': '66494336de24c5d7831d8b674b0e9a1e6ad616891d8b6fe8416f492ffbebb0a3',
  'white-b': '6cd3d803f4a8b05684b7c6cb5d2c8100158b06fc420beff44664a9b6cdacf61d',
  'white-n': 'f37db793a36d40e5f67d946996e2683b512948a90b97a6da5826094f1ad4e6fd',
  'white-p': '5100d818ff566a4c45d59efe05037f13bfc180f302f4750141f13d52b3e78015',
  'black-k': 'af90b4147f000d6c6df7b2e30f78c584e1c81a32bf0a17471a7027119c456949',
  'black-q': '9a437ebe2cc9597647f3cd0804526a8394754bde1062c822a6a3cb4857847f47',
  'black-r': '553dc11cf83f48a0e63292e074978e57a5b24bfb34276e8f1e7ebeb871e1c90d',
  'black-b': '6cd3d803f4a8b05684b7c6cb5d2c8100158b06fc420beff44664a9b6cdacf61d',
  'black-n': 'f37db793a36d40e5f67d946996e2683b512948a90b97a6da5826094f1ad4e6fd',
  'black-p': '5100d818ff566a4c45d59efe05037f13bfc180f302f4750141f13d52b3e78015'
});

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`PASS: ${message}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${message}`);
  }
}

const rendered = [];
for (const color of ['white', 'black']) {
  for (const type of ['k', 'q', 'r', 'b', 'n', 'p']) {
    const target = { innerHTML: '' };
    const markup = renderPieceSvg(target, color, type);
    const key = `${color}-${type}`;
    rendered.push(markup);
    assert(
      target.innerHTML === markup &&
        markup.startsWith('<svg ') &&
        markup.includes(`data-piece="${key}"`) &&
        markup.includes(`piece-${color}`) &&
        markup.includes(`piece-${type}`) &&
        markup.includes('viewBox="0 0 45 45"') &&
        markup.endsWith('</svg>') &&
        markup.includes(PIECE_SVGS[key]),
      `${color} ${type} renders its cburnett inline SVG`
    );

    const pathData = [...PIECE_SVGS[key].matchAll(/\sd="([^"]+)"/g)].map(match => match[1]);
    const pathHash = crypto.createHash('sha256').update(JSON.stringify(pathData)).digest('hex');
    assert(
      pathData.length > 0 && pathData.every(data => data.trim()) && pathHash === CBURNETT_PATH_HASHES[key],
      `${color} ${type} path data matches the cburnett specification`
    );
  }
}

assert(new Set(rendered).size === 12, 'all 12 color and type combinations render uniquely');
const engineSymbols = new Set(
  Object.values(engine.createInitialBoard().pieces)
    .filter(Boolean)
    .map(piece => `${piece.color}-${piece.type}`)
);
assert(
  Object.keys(CBURNETT_PATH_HASHES).every(key => engineSymbols.has(key)) && engineSymbols.size === 12,
  'the SVG set covers every color and type symbol emitted by the engine'
);
assert(pieceSvgMarkup('white', 'x') === '', 'unknown piece types render no artwork');
assert(pieceSvgMarkup('green', 'k') === '', 'unknown piece colors render no artwork');

const uiSource = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');
const unicodeChessPieces = /[\u2654-\u265f]/;
assert(!rendered.some(markup => unicodeChessPieces.test(markup)), 'rendered pieces contain no Unicode chess glyphs');
assert(!unicodeChessPieces.test(uiSource), 'UI source contains no Unicode chess glyphs');
assert(!/pieceGlyphs/.test(uiSource), 'legacy Unicode pieceGlyphs rendering is removed');
assert(/renderPieceSvg\(squareDiv, color, type\)/.test(uiSource), 'board squares render pieces through the SVG renderer');

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed) process.exit(1);
