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
  // Registry order (natural-events, news), tokens 0y and 0z.
  assert.equal(params.get('l'), '0y.0z');
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
      .filter((part) => part.startsWith('0z.'))
      .join('_'),
    '0z.w.72_0z.c.conflict-cyber',
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
    !(params.get('lo') || '').split('_').some((part) => part.startsWith('0z.')),
  );

  const forged = new URLSearchParams(
    'v=2&l=0z&lo=0z.w.48_0z.c.conflict-weather',
  );
  assert.deepEqual(decodeLayerStateParams(forged).options.news, {
    windowHours: 24,
    categoryFilter: '',
  });
});
