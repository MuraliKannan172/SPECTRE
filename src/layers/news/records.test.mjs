import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeNewsFreshness,
  normalizeNewsPage,
  normalizeNewsStory,
  safeNewsLink,
} from './records.js';

const STORY = {
  id: 42,
  title: 'Magnitude 6.2 earthquake strikes near Hualien, Taiwan',
  summary: 'Strong shaking was felt across the island.',
  url: 'https://example.org/quake',
  published_at: '2026-10-24T10:00:00Z',
  first_seen_at: '2026-10-24T10:03:12Z',
  updated_at: '2026-10-24T10:09:40Z',
  category: 'disaster',
  severity: 3,
  location: {
    lat: 23.98,
    lon: 121.6,
    place_name: 'Hualien',
    country_code: 'TW',
    confidence: 0.95,
    on_globe: true,
  },
  source_count: 2,
  sources: [
    {
      name: 'USGS significant earthquakes',
      url: 'https://earthquake.usgs.gov/x',
      feed_id: 'usgs-quakes-significant',
      published_at: '2026-10-24T10:00:00Z',
    },
    {
      name: 'example.org',
      url: 'https://example.org/quake',
      feed_id: 'gdelt-disasters',
      published_at: '2026-10-24T10:05:00Z',
    },
  ],
};

test('a valid story becomes a frozen record', () => {
  const record = normalizeNewsStory(STORY);
  assert.ok(Object.isFrozen(record));
  assert.equal(record.id, 42);
  assert.equal(record.category, 'disaster');
  assert.equal(record.severity, 3);
  assert.equal(record.publishedAt, Date.parse('2026-10-24T10:00:00Z'));
  assert.deepEqual(
    { ...record.location },
    {
      lat: 23.98,
      lon: 121.6,
      placeName: 'Hualien',
      countryCode: 'TW',
      confidence: 0.95,
      onGlobe: true,
    },
  );
  assert.equal(record.sourceCount, 2);
  assert.equal(record.viaGdelt, true);
});

test('invalid stories are dropped, not repaired', () => {
  for (const bad of [
    { ...STORY, id: 0 },
    { ...STORY, id: '42' },
    { ...STORY, title: '' },
    { ...STORY, title: 'x'.repeat(301) },
    { ...STORY, url: 'javascript:alert(1)' },
    { ...STORY, url: 'https://user:pass@example.org/' },
    { ...STORY, published_at: 'yesterday' },
    null,
  ]) {
    assert.equal(normalizeNewsStory(bad), null);
  }
});

test('unsafe parts are removed and unknown values fall back', () => {
  const record = normalizeNewsStory({
    ...STORY,
    category: 'gossip',
    severity: 9,
    location: { ...STORY.location, lat: 120 },
    sources: [
      { name: 'Bad', url: 'data:text/html,<script>' },
      ...STORY.sources.slice(0, 1),
    ],
  });
  assert.equal(record.category, 'world');
  assert.equal(record.severity, 4);
  assert.equal(record.location, null);
  assert.deepEqual(
    record.sources.map((source) => source.name),
    ['USGS significant earthquakes'],
  );
  assert.equal(record.viaGdelt, false);
});

test('links must be absolute http(s) without credentials', () => {
  assert.equal(safeNewsLink('https://a.example/x'), 'https://a.example/x');
  assert.equal(safeNewsLink('http://a.example/'), 'http://a.example/');
  for (const bad of ['/relative', 'ftp://a.example', 'mailto:a@b.c', 42]) {
    assert.equal(safeNewsLink(bad), null);
  }
});

test('pages keep valid, distinct stories and a safe cursor', () => {
  const page = normalizeNewsPage({
    items: [STORY, STORY, { ...STORY, id: 43, url: 'nope' }],
    next_cursor: 'eyJwIjox',
    freshness: { state: 'live', stale: false, age_seconds: 60 },
  });
  assert.deepEqual(
    page.records.map((record) => record.id),
    [42],
  );
  assert.equal(page.nextCursor, 'eyJwIjox');
  assert.equal(page.freshness.state, 'live');
  assert.equal(
    normalizeNewsPage({ items: [], next_cursor: '"><svg>' }).nextCursor,
    null,
  );
  assert.equal(normalizeNewsPage({}), null);
  assert.equal(normalizeNewsFreshness({ state: 'weird' }).state, 'offline');
});
