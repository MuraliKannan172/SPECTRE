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
