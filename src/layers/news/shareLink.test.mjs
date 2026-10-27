import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REGISTERED_LAYER_IDS,
  decodeLayerStateParams,
  encodeLayerStateParams,
  normalizeLayerState,
} from '../../data/layerState.js';

test('News and Natural Events round-trip through a share link', () => {
  assert.ok(REGISTERED_LAYER_IDS.includes('news'));
  assert.ok(REGISTERED_LAYER_IDS.includes('natural-events'));
  for (const enabled of [
    ['news'],
    ['natural-events'],
    ['flights', 'natural-events', 'news'],
  ]) {
    const state = normalizeLayerState({ enabledLayerIds: enabled });
    const params = new URLSearchParams([['v', '2']]);
    encodeLayerStateParams(params, state);
    const restored = decodeLayerStateParams(params);
    assert.deepEqual(
      [...restored.enabledLayerIds].sort(),
      [...enabled].sort(),
      params.toString(),
    );
  }
  const params = new URLSearchParams([['v', '2']]);
  encodeLayerStateParams(
    params,
    normalizeLayerState({ enabledLayerIds: ['news', 'natural-events'] }),
  );
  // Registry order (natural-events, news), tokens 6 and 5.
  assert.equal(params.get('l'), '6.5');
});

test('the News time window and category filter round-trip too', () => {
  const state = normalizeLayerState({
    enabledLayerIds: ['news'],
    options: { news: { windowHours: 72, categoryFilter: 'cyber-conflict' } },
  });
  // Canonical order follows NEWS_CATEGORIES (conflict before cyber).
  assert.deepEqual(state.options.news, {
    windowHours: 72,
    categoryFilter: 'conflict-cyber',
  });
  const params = new URLSearchParams([['v', '2']]);
  encodeLayerStateParams(params, state);
  assert.equal(
    params
      .get('lo')
      .split('_')
      .filter((part) => part.startsWith('5.'))
      .join('_'),
    '5.w.72_5.c.conflict-cyber',
  );
  assert.deepEqual(
    decodeLayerStateParams(params).options.news,
    state.options.news,
  );
});

test('default News settings add nothing to the link, and bad values are dropped', () => {
  const params = new URLSearchParams([['v', '2']]);
  encodeLayerStateParams(
    params,
    normalizeLayerState({ enabledLayerIds: ['news'] }),
  );
  assert.ok(
    !(params.get('lo') || '').split('_').some((part) => part.startsWith('5.')),
  );

  const forged = new URLSearchParams('v=2&l=5&lo=5.w.48_5.c.conflict-weather');
  assert.deepEqual(decodeLayerStateParams(forged).options.news, {
    windowHours: 24,
    categoryFilter: '',
  });
});
