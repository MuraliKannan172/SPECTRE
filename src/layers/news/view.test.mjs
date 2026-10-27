import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeNewsStory } from './records.js';
import { NEWS_CATEGORY_COLORS } from './style.js';
import {
  GDELT_HOME,
  NEWS_REGIONS,
  gdeltCitation,
  newsDrawerItems,
  newsFilterOptions,
  newsSourceOptions,
  newsTickerEntries,
} from './view.js';

const NOW = Date.parse('2026-10-24T12:00:00Z');

function story(id, overrides = {}) {
  return normalizeNewsStory({
    id,
    title: `Story ${id}`,
    summary: `Summary ${id}`,
    url: `https://example.org/${id}`,
    published_at: '2026-10-24T09:00:00Z',
    first_seen_at: '2026-10-24T09:01:00Z',
    category: 'disaster',
    severity: 2,
    location: {
      lat: 10,
      lon: 20,
      place_name: 'Hualien',
      country_code: 'TW',
      confidence: 0.9,
      on_globe: true,
    },
    source_count: 1,
    sources: [
      {
        name: 'Outlet A',
        url: `https://a.example/${id}`,
        feed_id: 'a',
        published_at: '2026-10-24T09:00:00Z',
      },
    ],
    ...overrides,
  });
}

test('filter options cover every window, category and region', () => {
  const options = newsFilterOptions();
  assert.deepEqual(
    options.windows.map((option) => option.value),
    ['6', '24', '72', '168'],
  );
  assert.equal(options.categories[0].value, '');
  assert.ok(options.categories.some((option) => option.value === 'cyber'));
  assert.deepEqual(
    options.regions.map((option) => option.value),
    ['', ...NEWS_REGIONS],
  );
  for (const option of [...options.windows, ...options.regions])
    assert.ok(option.label.length > 0);
});

test('source options are distinct outlet names, sorted, keeping the selection', () => {
  const records = [
    story(1),
    story(2, {
      source_count: 2,
      sources: [
        { name: 'Zeta', url: 'https://z.example/2', feed_id: 'z' },
        { name: 'Outlet A', url: 'https://a.example/2', feed_id: 'a' },
      ],
    }),
  ];
  assert.deepEqual(
    newsSourceOptions(records, 'Gone').map((option) => option.value),
    ['', 'Gone', 'Outlet A', 'Zeta'],
  );
});

test('drawer items carry headline, meta, outlets and selection', () => {
  const [item] = newsDrawerItems([story(7)], { now: NOW, selectedId: 7 });
  assert.equal(item.id, 7);
  assert.equal(item.title, 'Story 7');
  assert.equal(item.color, NEWS_CATEGORY_COLORS.disaster);
  assert.equal(item.meta, '3h ago · Hualien · 1 outlet');
  assert.equal(item.located, true);
  assert.equal(item.selected, true);
  assert.equal(item.alert, false);
  assert.deepEqual(item.outlets, [
    { name: 'Outlet A', url: 'https://a.example/7' },
  ]);
});

test('a story with no listed outlet links its own article; alerts are flagged', () => {
  const [item] = newsDrawerItems(
    [story(8, { sources: [], source_count: 1, severity: 4 })],
    { now: NOW },
  );
  assert.deepEqual(item.outlets, [
    { name: 'Article', url: 'https://example.org/8' },
  ]);
  assert.equal(item.alert, true);
  assert.equal(item.selected, false);
});

test('the ticker keeps the ten newest entries in the order given', () => {
  const records = Array.from({ length: 14 }, (_, index) => story(index + 1));
  const entries = newsTickerEntries(records, { now: NOW });
  assert.equal(entries.length, 10);
  assert.deepEqual(
    entries.map((entry) => entry.id),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.equal(entries[0].age, '3h');
});

test('GDELT stories are flagged and the citation links GDELT', () => {
  const gdelt = story(9, {
    sources: [
      {
        name: 'example.org',
        url: 'https://example.org/9',
        feed_id: 'gdelt-disasters',
      },
    ],
  });
  assert.equal(newsDrawerItems([gdelt], { now: NOW })[0].gdelt, true);
  assert.equal(newsTickerEntries([gdelt], { now: NOW })[0].gdelt, true);
  assert.equal(newsDrawerItems([story(10)], { now: NOW })[0].gdelt, false);
  assert.deepEqual(gdeltCitation(), {
    text: 'Headlines via the GDELT Project (gdeltproject.org)',
    url: GDELT_HOME,
  });
});
