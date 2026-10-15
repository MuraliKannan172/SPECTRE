// The global loading chip translates the closed status vocabulary of
// loadingFeedback.js at the presentation boundary. The ALPR retry detail keeps
// its layer-name prefix in every language (it is what tells the chip apart
// from a mapped-sites retry), and every mapped-site failure reason label has a
// catalog entry, not only the default one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../i18n/index.js';

const elements = {
  'global-loading-status': { hidden: true, dataset: {} },
  'global-loading-detail': { textContent: '' },
};
globalThis.document ??= {
  getElementById: (id) => elements[id] ?? null,
  addEventListener() {},
  removeEventListener() {},
  hidden: false,
};
const { ShellFeedback, localizeLoadingPresentation } =
  await import('./shellFeedback.js');

function alprChipDetail(locale, retryInMs) {
  setLocale(locale);
  const layer = {
    id: 'alpr-cameras',
    name: 'ALPR cameras',
    enabled: true,
    stats: {
      status: 'unavailable',
      error: 'Unavailable',
      retryAt: Date.now() + retryInMs,
    },
  };
  const feedback = new ShellFeedback({ readLayers: () => [layer] });
  feedback._armLoadingFeedbackTicker = () => {};
  feedback._updateGlobalLoadingFeedback(0);
  return elements['global-loading-detail'].textContent;
}

test.afterEach(() => setLocale('en'));

test('English ALPR retry chip keeps the layer name (as on main)', () => {
  assert.equal(alprChipDetail('en', 12000), 'ALPR cameras · retrying in 12s');
  assert.equal(alprChipDetail('en', -1000), 'ALPR cameras · retry pending');
});

test('Spanish ALPR retry chip keeps the layer name', () => {
  assert.match(alprChipDetail('es', 12000), /ALPR.* · reintento en 12 s/);
});

test('Spanish ALPR retry-pending chip is translated', () => {
  const detail = alprChipDetail('es', -1000);
  assert.match(detail, /ALPR/);
  assert.doesNotMatch(detail, /retry pending/);
});

test('English presentation passes through unchanged', () => {
  setLocale('en');
  for (const label of [
    'OVERPASS TEMPORARILY UNAVAILABLE',
    'OVERPASS RATE-LIMITED',
    'OVERPASS TIMED OUT',
    'OVERPASS COULD NOT COMPLETE THE QUERY',
    'MAP TILES TEMPORARILY UNAVAILABLE',
    'MAPPED NAMES TEMPORARILY UNAVAILABLE',
  ]) {
    assert.deepEqual(
      localizeLoadingPresentation({
        state: 'retry',
        label,
        detail: 'retrying in 12s',
      }),
      { state: 'retry', label, detail: 'retrying in 12s' },
    );
  }
});

for (const locale of ['es', 'ru']) {
  test(`${locale}: every mapped-site retry label is translated with its detail`, () => {
    setLocale(locale);
    for (const label of [
      'OVERPASS TEMPORARILY UNAVAILABLE',
      'OVERPASS RATE-LIMITED',
      'OVERPASS TIMED OUT',
      'OVERPASS COULD NOT COMPLETE THE QUERY',
      'MAP TILES TEMPORARILY UNAVAILABLE',
      'MAPPED NAMES TEMPORARILY UNAVAILABLE',
    ]) {
      const localized = localizeLoadingPresentation({
        state: 'retry',
        label,
        detail: 'retrying in 12s',
      });
      assert.notEqual(localized.label, label, `label stays English: ${label}`);
      assert.notEqual(localized.detail, 'retrying in 12s');
    }
  });

  test(`${locale}: a live provider error label passes through verbatim`, () => {
    setLocale(locale);
    const localized = localizeLoadingPresentation({
      state: 'retry',
      label: 'HTTP 503 FROM OVERPASS-API.DE',
      detail: 'retry pending',
    });
    assert.equal(localized.label, 'HTTP 503 FROM OVERPASS-API.DE');
    assert.notEqual(localized.detail, 'retry pending');
  });
}
