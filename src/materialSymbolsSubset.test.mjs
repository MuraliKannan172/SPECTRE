import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BROWSER_CSP } from '../build/vite.js';

// SPECTRE bundles the whole Material Symbols Outlined font (material-symbols,
// Apache-2.0) instead of requesting an icon_names subset from Google Fonts, so
// every glyph a source names renders, offline, with no list to keep in sync.
const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the icon font and text fonts are bundled, not fetched from Google Fonts', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  const fonts = read('src/theme/spectre-fonts.css');
  assert.match(fonts, /@import 'material-symbols\/outlined\.css';/);
  for (const family of ['jetbrains-mono', 'inter', 'rajdhani'])
    assert.match(fonts, new RegExp(`@import '@fontsource/${family}/`));
  assert.match(html, /href="\/src\/theme\/spectre-fonts\.css"/);
  assert.doesNotMatch(
    BROWSER_CSP,
    /fonts\.googleapis\.com|fonts\.gstatic\.com/,
  );
});

test('the unused Material Icons Round family is not loaded', () => {
  // A second icon font, 173 kB, for a family no source ever uses — and
  // src/cockpitMarkup.test.mjs already asserts the markup must not use it.
  const html = read('index.html');
  assert.doesNotMatch(
    html,
    /Material\+Icons\+Round/,
    'index.html loads an icon font nothing renders',
  );
});
