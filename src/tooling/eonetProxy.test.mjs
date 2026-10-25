import test from 'node:test';
import assert from 'node:assert/strict';

import {
  eonetGeometryPoint,
  eonetProxy,
  parseEonetEvents,
} from '../../server/providers/eonet.js';

const PAYLOAD = {
  events: [
    {
      id: 'EONET_1',
      title: 'Wildfire BEE HAVEN, Hamilton, Florida',
      link: 'https://eonet.gsfc.nasa.gov/api/v3/events/EONET_1',
      categories: [{ id: 'wildfires', title: 'Wildfires' }],
      sources: [
        { id: 'IRWIN', url: 'https://irwin.doi.gov/observer/incidents/1' },
        { id: 'BAD', url: 'javascript:alert(1)' },
      ],
      geometry: [
        {
          date: '2026-10-20T00:00:00Z',
          type: 'Point',
          coordinates: [-82.0, 30.0],
        },
        {
          date: '2026-10-22T21:45:00Z',
          type: 'Point',
          coordinates: [-82.8577778, 30.4952778],
          magnitudeValue: 2060,
          magnitudeUnit: 'acres',
        },
      ],
    },
    {
      id: 'EONET_2',
      title: 'Iceberg A23A',
      categories: [{ id: 'seaLakeIce', title: 'Sea and Lake Ice' }],
      sources: [],
      geometry: [
        {
          date: '2026-10-21T00:00:00Z',
          type: 'Polygon',
          coordinates: [
            [
              [10, -60],
              [12, -60],
              [12, -62],
              [10, -62],
            ],
          ],
        },
      ],
    },
    { id: 'EONET_3', title: 'No category', categories: [], geometry: [] },
    {
      id: 'EONET_4',
      title: '<script>bad</script>',
      categories: [{ id: 'volcanoes', title: 'Volcanoes' }],
      geometry: [
        { date: '2026-10-21T00:00:00Z', type: 'Point', coordinates: [0, 0] },
      ],
    },
  ],
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function call(plugin) {
  let handler;
  plugin.configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  return new Promise((resolve) => {
    const res = {
      destroyed: false,
      writableEnded: false,
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.writableEnded = true;
        resolve({ status: this.status, body: JSON.parse(body) });
      },
    };
    handler({ method: 'GET', url: '/' }, res);
  });
}

test('events reduce to their newest point, with only safe text and links', () => {
  const events = parseEonetEvents(PAYLOAD);
  assert.deepEqual(
    events.map((event) => event.id),
    ['EONET_1', 'EONET_2'],
  );
  const fire = events[0];
  assert.deepEqual([fire.lat, fire.lon], [30.4953, -82.8578]);
  assert.equal(fire.observedAt, '2026-10-22T21:45:00.000Z');
  assert.deepEqual(fire.magnitude, { value: 2060, unit: 'acres' });
  assert.deepEqual(fire.category, { id: 'wildfires', title: 'Wildfires' });
  assert.deepEqual(
    fire.sources.map((source) => source.id),
    ['IRWIN'],
  );
  assert.deepEqual([events[1].lat, events[1].lon], [-61, 11]);
  assert.equal(events[1].magnitude, null);
  assert.throws(() => parseEonetEvents({}), /invalid_eonet_payload/);
});

test('geometry points reject impossible coordinates', () => {
  assert.equal(
    eonetGeometryPoint({ type: 'Point', coordinates: [200, 10] }),
    null,
  );
  assert.equal(
    eonetGeometryPoint({ type: 'LineString', coordinates: [] }),
    null,
  );
});

test('the proxy caches, cools down after a failure, and serves stale data', async () => {
  let clock = 1_000_000;
  let calls = 0;
  let fail = false;
  const plugin = eonetProxy({
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      if (fail) throw new Error('offline');
      return jsonResponse(PAYLOAD);
    },
  });

  const first = await call(plugin);
  assert.equal(first.status, 200);
  assert.equal(first.body.events.length, 2);
  assert.equal(first.body.stale, false);
  assert.equal(first.body.source, 'NASA EONET');

  await call(plugin);
  assert.equal(calls, 1, 'served from cache within 10 minutes');

  clock += 11 * 60_000;
  fail = true;
  const stale = await call(plugin);
  assert.equal(calls, 2);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.unavailable, false);
  assert.equal(stale.body.events.length, 2);

  await call(plugin);
  assert.equal(calls, 2, 'no retry within the 60 s cooldown');

  clock += 25 * 3600_000;
  const gone = await call(plugin);
  assert.equal(gone.body.unavailable, true);
  assert.deepEqual(gone.body.events, []);
});
