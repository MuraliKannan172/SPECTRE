import test from 'node:test';
import assert from 'node:assert/strict';

import { createNewsLayer } from './index.js';
import { INTEL_OFFLINE, IntelOfflineError } from './source.js';
import { normalizeNewsStory } from './records.js';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const HOUR = 3600_000;

function story(id, { hoursAgo = 1, category = 'world', onGlobe = true } = {}) {
  return normalizeNewsStory({
    id,
    title: `Story ${id}`,
    summary: '',
    url: `https://example.org/${id}`,
    published_at: new Date(NOW - hoursAgo * HOUR).toISOString(),
    category,
    severity: 1,
    location: {
      lat: 10,
      lon: 20,
      place_name: 'Somewhere',
      country_code: 'KE',
      confidence: onGlobe ? 0.9 : 0.4,
      on_globe: onGlobe,
    },
    source_count: 1,
    sources: [
      {
        name: 'Alpha',
        url: `https://example.org/${id}`,
        feed_id: 'alpha',
      },
    ],
  });
}

function fakeViewer() {
  const added = [];
  return {
    added,
    dataSources: {
      add: (source) => added.push(source),
      remove: () => {},
    },
    scene: { requestRender: () => {}, pick: () => null, canvas: {} },
    camera: { flyTo: () => {}, flyToBoundingSphere: () => {} },
  };
}

class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }
  close() {
    this.closed = true;
  }
}

function build(snapshot) {
  const calls = [];
  const source = {
    streamUrl: '/api/intel/news/stream',
    getSnapshot: async (options) => {
      calls.push(options);
      if (snapshot instanceof Error) throw snapshot;
      return snapshot;
    },
  };
  const layer = createNewsLayer({
    source,
    now: () => NOW,
    eventSourceFactory: (url) => new FakeEventSource(url),
  });
  const viewer = fakeViewer();
  layer.init(viewer);
  return { layer, viewer, calls };
}

test('only placed stories within the window and chosen categories are drawn', async () => {
  const { layer, viewer, calls } = build({
    records: [
      story(1),
      story(2, { hoursAgo: 30 }),
      story(3, { onGlobe: false }),
      story(4, { category: 'cyber' }),
    ],
    freshness: { state: 'live', stale: false, ageSeconds: 60 },
  });
  layer.enable();
  assert.equal(await layer.update(), true);
  const entities = viewer.added[0].entities.values.map((entity) => entity.id);
  assert.deepEqual(entities.sort(), ['news:1', 'news:4']);
  assert.equal(calls[0].windowHours, 24);
  assert.equal(layer.getStats().count, 2);

  layer.setParams({ toggleCategory: 'cyber' });
  assert.deepEqual(layer.getParams().categories, ['cyber']);
  assert.deepEqual(
    viewer.added[0].entities.values.map((entity) => entity.id),
    ['news:4'],
  );
  layer.setParams({ windowHours: 72 });
  assert.equal(layer.getParams().windowHours, 72);
  layer.setParams({ windowHours: 5 }); // not an offered window: ignored
  assert.equal(layer.getParams().windowHours, 72);
  layer.disable();
});

test('the row lists the newest stories, freshness and the GDELT citation', async () => {
  const gdelt = normalizeNewsStory({
    id: 9,
    title: 'Via GDELT',
    url: 'https://news.example/9',
    published_at: new Date(NOW - HOUR / 2).toISOString(),
    category: 'disaster',
    location: { lat: 1, lon: 2, confidence: 0.9, on_globe: true },
    sources: [
      {
        name: 'news.example',
        url: 'https://news.example/9',
        feed_id: 'gdelt-disasters',
      },
    ],
  });
  const { layer } = build({
    records: [story(1, { hoursAgo: 2 }), gdelt],
    freshness: { state: 'live', stale: false, ageSeconds: 120 },
  });
  layer.enable();
  await layer.update();
  const controls = layer.getRowControls();
  assert.deepEqual(
    controls.list.items.map((item) => item.text),
    ['Via GDELT', 'Story 1'],
  );
  assert.deepEqual(controls.list.items[0].params, { storyId: 9, focus: true });
  assert.match(controls.info, /Updated 2m ago/);
  assert.match(controls.info, /GDELT Project \(gdeltproject\.org\)/);
  assert.equal(
    controls.chips.filter((chip) => chip.id.startsWith('window-')).length,
    4,
  );
  layer.disable();
});

test('the live stream exists only while the layer is on', async () => {
  FakeEventSource.instances = [];
  const { layer, viewer } = build({ records: [], freshness: null });
  layer.enable();
  assert.equal(FakeEventSource.instances.length, 1);
  const connection = FakeEventSource.instances[0];
  assert.equal(connection.url, '/api/intel/news/stream');
  connection.listeners.story({
    data: JSON.stringify({
      id: 77,
      title: 'Live story',
      url: 'https://example.org/77',
      published_at: new Date(NOW).toISOString(),
      category: 'world',
      location: { lat: 5, lon: 5, confidence: 0.9, on_globe: true },
      sources: [],
    }),
    lastEventId: '77',
  });
  assert.deepEqual(
    viewer.added[0].entities.values.map((entity) => entity.id),
    ['news:77'],
  );
  layer.disable();
  assert.equal(connection.closed, true);
});

test('a stopped intel service shows the start instruction', async () => {
  const { layer } = build(new IntelOfflineError());
  layer.enable();
  assert.equal(await layer.update(), false);
  assert.equal(layer.getStats().error, INTEL_OFFLINE);
  assert.match(layer.getRowControls().info, /skynet\.ps1/);
  layer.disable();
});
