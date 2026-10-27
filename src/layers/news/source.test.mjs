import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INTEL_OFFLINE,
  IntelOfflineError,
  NEWS_MAX_RECORDS,
  createIntelNewsSource,
} from './source.js';

const NOW = Date.parse('2026-10-25T12:00:00Z');

function story(id) {
  return {
    id,
    title: `Story ${id}`,
    summary: '',
    url: `https://example.org/${id}`,
    published_at: '2026-10-25T11:00:00Z',
    category: 'world',
    severity: 1,
    location: null,
    source_count: 1,
    sources: [],
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('the snapshot asks for placed stories in the window and follows cursors', async () => {
  const urls = [];
  const source = createIntelNewsSource({
    now: () => NOW,
    fetchImpl: async (url) => {
      urls.push(url);
      return url.includes('cursor=')
        ? json({ items: [story(3)], next_cursor: null, freshness: null })
        : json({
            items: [story(1), story(2)],
            next_cursor: 'abc',
            freshness: { state: 'live' },
          });
    },
  });
  const { records, freshness } = await source.getSnapshot({
    windowHours: 6,
    categories: ['disaster', 'cyber'],
  });
  assert.deepEqual(
    records.map((record) => record.id),
    [1, 2, 3],
  );
  assert.equal(freshness.state, 'live');
  const first = new URL(urls[0], 'http://app.test');
  assert.equal(first.pathname, '/api/intel/news');
  assert.equal(first.searchParams.get('located'), 'true');
  assert.equal(first.searchParams.get('since'), '2026-10-25T06:00:00.000Z');
  assert.equal(first.searchParams.get('category'), 'disaster,cyber');
  assert.equal(
    new URL(urls[1], 'http://app.test').searchParams.get('cursor'),
    'abc',
  );
});

test('an unknown window falls back to 24 hours; paging stops at the cap', async () => {
  let calls = 0;
  const source = createIntelNewsSource({
    now: () => NOW,
    fetchImpl: async (url) => {
      calls += 1;
      const since = new URL(url, 'http://app.test').searchParams.get('since');
      assert.equal(since, '2026-10-24T12:00:00.000Z');
      const base = calls * 1000;
      return json({
        items: Array.from({ length: 200 }, (_, i) => story(base + i)),
        next_cursor: 'more',
      });
    },
  });
  const { records } = await source.getSnapshot({ windowHours: 5 });
  assert.equal(records.length, NEWS_MAX_RECORDS);
  assert.equal(calls, NEWS_MAX_RECORDS / 200);
});

test('a stopped intel service is reported as offline, not as broken data', async () => {
  const source = createIntelNewsSource({
    fetchImpl: async () =>
      json({ state: 'intel_offline', error: 'connection_refused' }, 503),
  });
  await assert.rejects(source.getSnapshot(), (error) => {
    assert.ok(error instanceof IntelOfflineError);
    assert.equal(error.code, 'intel_offline');
    assert.equal(error.message, INTEL_OFFLINE);
    return true;
  });
  await assert.rejects(
    createIntelNewsSource({
      fetchImpl: async () => json({ detail: 'boom' }, 500),
    }).getSnapshot(),
    /News unavailable \(HTTP 500\)/,
  );
});

test('search passes the panel filters; a hidden story reads as gone', async () => {
  const urls = [];
  const source = createIntelNewsSource({
    now: () => NOW,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.endsWith('/news/7')) return json({ detail: 'x' }, 404);
      return json({ items: [story(1)] });
    },
  });
  await source.search({
    q: '  flood ',
    region: 'africa',
    source: 'nhc-atlantic',
    windowHours: 72,
  });
  const params = new URL(urls[0], 'http://app.test').searchParams;
  assert.equal(params.get('q'), 'flood');
  assert.equal(params.get('region'), 'africa');
  assert.equal(params.get('source'), 'nhc-atlantic');
  assert.equal(params.get('located'), null);
  assert.equal(await source.getStory(7), null);
  assert.equal(await source.getStory(-1), null);
});
