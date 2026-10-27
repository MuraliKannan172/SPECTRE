import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NEWS_SHARE_OPTIONS,
  decodeNewsCategoryFilter,
  encodeNewsCategoryFilter,
} from './shareOptions.js';

const [windowSpec, categorySpec] = NEWS_SHARE_OPTIONS;

test('categories become one canonical string and back', () => {
  assert.equal(
    encodeNewsCategoryFilter(['world', 'conflict']),
    'conflict-world',
  );
  assert.equal(encodeNewsCategoryFilter([]), '');
  assert.equal(encodeNewsCategoryFilter(['nonsense']), '');
  assert.deepEqual(decodeNewsCategoryFilter('world-conflict'), [
    'conflict',
    'world',
  ]);
  assert.deepEqual(decodeNewsCategoryFilter(''), []);
  for (const bad of [
    'conflict-conflict',
    'weather',
    'conflict-',
    42,
    null,
    'x'.repeat(500),
  ])
    assert.equal(decodeNewsCategoryFilter(bad), null, String(bad).slice(0, 20));
});

test('the window spec accepts only the offered windows', () => {
  assert.equal(windowSpec.key, 'windowHours');
  assert.equal(windowSpec.defaultValue, 24);
  assert.equal(windowSpec.decode('72'), 72);
  assert.equal(windowSpec.normalize(168), 168);
  assert.equal(windowSpec.encode(6), '6');
  for (const bad of ['48', 48, '', '1e2', null])
    assert.equal(windowSpec.decode(bad), null);
});

test('a category chip toggle persists the filter it produced', () => {
  assert.equal(categorySpec.key, 'categoryFilter');
  assert.equal(
    categorySpec.patchRequested('', 'cyber', { toggleCategory: 'cyber' }),
    'cyber',
  );
  assert.equal(
    categorySpec.patchRequested('', 'health', { categories: ['health'] }),
    'health',
  );
  assert.equal(
    categorySpec.patchRequested('cyber', 'cyber', { windowHours: 6 }),
    undefined,
    'a window change leaves the stored filter alone',
  );
});
