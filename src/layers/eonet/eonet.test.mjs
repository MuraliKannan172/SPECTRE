import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EONET_CATEGORIES,
  buildEonetCard,
  createEonetSource,
  createEonetLayer,
  normalizeEonetEvent,
} from './index.js';

const EVENT = {
  id: 'EONET_1',
  title: 'Wildfire BEE HAVEN, Hamilton, Florida',
  category: { id: 'wildfires', title: 'Wildfires' },
  lat: 30.4953,
  lon: -82.8578,
  observedAt: '2026-10-22T21:45:00.000Z',
  magnitude: { value: 2060, unit: 'acres' },
  sources: [
    { id: 'IRWIN', url: 'https://irwin.doi.gov/observer/incidents/1' },
    { id: 'BAD', url: 'javascript:alert(1)' },
  ],
};

test('events are re-validated in the browser', () => {
  const record = normalizeEonetEvent(EVENT);
  assert.equal(record.categoryId, 'wildfires');
  assert.deepEqual(
    record.sources.map((source) => source.id),
    ['IRWIN'],
  );
  for (const bad of [
    { ...EVENT, lat: 95 },
    { ...EVENT, id: '../x' },
    { ...EVENT, title: '<img src=x>' },
    { ...EVENT, observedAt: 'soon' },
  ]) {
    assert.equal(normalizeEonetEvent(bad), null);
  }
});

test('the card names the category, NASA EONET and the source to open', () => {
  const card = buildEonetCard(normalizeEonetEvent(EVENT));
  assert.equal(card.title, EVENT.title);
  assert.equal(card.accent, EONET_CATEGORIES.wildfires.color);
  assert.equal(card.interactive, true);
  assert.ok(card.details.some((line) => /NASA EONET/.test(line)));
  assert.ok(card.details.some((line) => /IRWIN/.test(line)));
  const unlinked = buildEonetCard(
    normalizeEonetEvent({ ...EVENT, sources: [] }),
  );
  assert.equal(unlinked.interactive, false);
});

test('the layer draws one point per event and reports an outage', async () => {
  const added = [];
  const viewer = {
    dataSources: { add: (source) => added.push(source), remove: () => {} },
    scene: { requestRender: () => {} },
  };
  let payload = {
    events: [EVENT, { ...EVENT, id: 'EONET_2' }],
    stale: false,
    unavailable: false,
    fetchedAt: '2026-10-25T00:00:00.000Z',
  };
  const source = createEonetSource({
    fetchImpl: async () =>
      new Response(JSON.stringify(payload), { status: 200 }),
  });
  const layer = createEonetLayer({ source });
  layer.init(viewer);
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(added[0].entities.values.length, 2);
  assert.equal(layer.getStats().count, 2);
  assert.equal(layer.getRowControls().legend[0].count, 2);

  payload = { events: [], stale: true, unavailable: true };
  assert.equal(await layer.update(), false);
  assert.equal(layer.getStats().error, 'Natural events unavailable');
  layer.disable();
});
