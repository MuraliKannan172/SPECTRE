// N-04: the HUD locality line passes the city upper-cased ("TOKYO") to the
// place-name lookup, which knows only "Tokyo", so the city never translates.
// The formatter below is the HUD's own (src/hud.js LOCALIZED_LOCALITY.near);
// hud.js itself does not load under node (mgrs CommonJS import).
// Place: src/hudLocalityCity.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from './i18n/index.js';
import { composeLocalityTag } from './hudLocality.js';
import { localizePlaceName } from './ui/placeNames.js';

const nearest = { poi: 'Tokyo Tower', city: 'Tokyo', distKm: 2 };
const hudFormat = {
  near: ({ city }) => localizePlaceName(city),
  sector: () => '',
};

test('ru: the HUD locality names Tokyo in Russian', () => {
  setLocale('ru');
  try {
    const shown = composeLocalityTag(nearest, 35.66, 139.75, hudFormat);
    assert.match(shown, /токио/i);
  } finally {
    setLocale('en');
  }
});
