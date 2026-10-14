import assert from 'node:assert/strict';
import test from 'node:test';
import { PanoramaxSourceError, createPanoramaxSource } from './source.js';
import { MAX_RESPONSE_BYTES } from './policy.js';

/** A fetch answering from `respond(url)`, recording every URL asked. */
function fakeFetch(respond) {
  const urls = [];
  const fetchImpl = async (url, { signal } = {}) => {
    urls.push(url);
    const answer = await respond(url, signal);
    if (answer instanceof Response) return answer;
    const { status = 200, body = '', headers = {} } = answer;
    return new Response(status === 204 ? null : body, { status, headers });
  };
  return { urls, fetchImpl };
}

const json = (value) => ({ body: JSON.stringify(value) });

test('a tile is the raw vector-tile bytes; 204 and 404 mean no coverage', async () => {
  const { urls, fetchImpl } = fakeFetch((url) =>
    url.includes('/14/')
      ? { body: new Uint8Array([1, 2, 3]) }
      : { status: 204 },
  );
  const source = createPanoramaxSource({ fetchImpl });
  assert.deepEqual(
    [...(await source.getTile({ x: 8299, y: 5634, z: 14 }))],
    [1, 2, 3],
  );
  assert.equal(urls[0], 'https://api.panoramax.xyz/api/map/14/8299/5634.mvt');
  assert.equal((await source.getTile({ x: 1, y: 1, z: 13 })).length, 0);
  const missing = createPanoramaxSource({
    fetchImpl: fakeFetch(() => ({ status: 404 })).fetchImpl,
  });
  assert.equal((await missing.getTile({ x: 1, y: 1, z: 13 })).length, 0);
});

test('a busy API says so and when to come back; other failures name the status', async () => {
  const busy = createPanoramaxSource({
    fetchImpl: fakeFetch(() => ({
      status: 429,
      headers: { 'retry-after': '12' },
    })).fetchImpl,
  });
  await assert.rejects(busy.getTile({ x: 0, y: 0, z: 0 }), (error) => {
    assert.ok(error instanceof PanoramaxSourceError);
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterSec, 12);
    return true;
  });
  const down = createPanoramaxSource({
    fetchImpl: fakeFetch(() => ({ status: 503 })).fetchImpl,
  });
  await assert.rejects(down.getTile({ x: 0, y: 0, z: 0 }), (error) => {
    assert.equal(error.retryAfterSec, 5, 'a default wait without the header');
    return true;
  });
  const broken = createPanoramaxSource({
    fetchImpl: fakeFetch(() => ({ status: 500 })).fetchImpl,
  });
  await assert.rejects(broken.getItem('x'), /HTTP 500/);
});

test('an oversized answer is refused while it streams', async () => {
  let pulled = 0;
  const huge = new ReadableStream({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(4 * 1024 * 1024));
    },
  });
  const source = createPanoramaxSource({
    fetchImpl: async () => new Response(huge, { status: 200 }),
  });
  await assert.rejects(source.getTile({ x: 0, y: 0, z: 0 }), /too much data/);
  assert.ok(pulled * 4 * 1024 * 1024 <= MAX_RESPONSE_BYTES + 8 * 1024 * 1024);
  // A declared length over the cap is refused before reading.
  const declared = createPanoramaxSource({
    fetchImpl: fakeFetch(() => ({
      body: 'x',
      headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
    })).fetchImpl,
  });
  await assert.rejects(declared.getItem('a'), /too much data/);
});

test('a picture by id is a STAC search; another id in the answer is not taken for it', async () => {
  const { urls, fetchImpl } = fakeFetch((url) =>
    url.includes('ids=good')
      ? json({ features: [{ id: 'good' }] })
      : json({ features: [{ id: 'other' }] }),
  );
  const source = createPanoramaxSource({ fetchImpl });
  assert.deepEqual(await source.getItem('good'), { id: 'good' });
  assert.equal(await source.getItem('bad'), null);
  const asked = new URL(urls[0]);
  assert.equal(asked.pathname, '/api/search');
  assert.equal(asked.searchParams.get('ids'), 'good');
  assert.equal(asked.searchParams.get('limit'), '1');
});

test('nearest pictures: any direction within the radius, filtered as the imagery filter asks', async () => {
  const { urls, fetchImpl } = fakeFetch(() => json({ features: [] }));
  const source = createPanoramaxSource({ fetchImpl });
  await source.nearestItems({ lat: 48.85, lon: 2.35 });
  await source.nearestItems({
    lat: 48.85,
    lon: 2.35,
    collections: 'seq',
    pano: 'pano',
    sinceMs: Date.UTC(2025, 0, 1),
    radius: 5000,
    limit: 500,
  });
  await source.nearestItems({ lat: 48.85, lon: 2.35, pano: 'flat' });
  const [plain, filtered, flat] = urls.map((u) => new URL(u).searchParams);
  assert.equal(plain.get('place_position'), '2.3500000,48.8500000');
  assert.equal(plain.get('place_distance'), '0-50');
  assert.equal(plain.get('place_fov_tolerance'), '180');
  assert.equal(plain.get('collections'), null);
  assert.equal(plain.get('filter'), null);
  assert.equal(plain.get('datetime'), null);
  assert.equal(filtered.get('collections'), 'seq');
  assert.equal(filtered.get('filter'), 'field_of_view=360');
  assert.equal(filtered.get('datetime'), '2025-01-01T00:00:00.000Z/..');
  assert.equal(filtered.get('place_distance'), '0-1000', 'capped');
  assert.equal(filtered.get('limit'), '100', 'capped');
  assert.equal(flat.get('filter'), 'field_of_view<360');
});

test('an unreadable search answer, or one with no features, is handled', async () => {
  const garbled = createPanoramaxSource({
    fetchImpl: fakeFetch(() => ({ body: '<html>' })).fetchImpl,
  });
  await assert.rejects(garbled.getItem('a'), /unreadable/);
  const empty = createPanoramaxSource({
    fetchImpl: fakeFetch(() => json({ type: 'FeatureCollection' })).fetchImpl,
  });
  assert.deepEqual(await empty.nearestItems({ lat: 0, lon: 0 }), []);
});

test('the caller’s abort wins; a silent API times out with a readable message', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hang = (url, signal) =>
    new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason)),
    );
  const source = createPanoramaxSource({
    fetchImpl: fakeFetch(hang).fetchImpl,
  });
  const controller = new AbortController();
  const asked = source.getItem('a', { signal: controller.signal });
  await Promise.resolve();
  controller.abort(new Error('overtaken'));
  await assert.rejects(asked, /overtaken/);
  const slow = source.getTile({ x: 0, y: 0, z: 0 });
  // Let the request start before the clock runs out.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  t.mock.timers.tick(60_000);
  await assert.rejects(slow, /did not answer in time/);
});

test('a network failure reads as no answer, not as a stack trace', async () => {
  const source = createPanoramaxSource({
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  await assert.rejects(source.getTile({ x: 0, y: 0, z: 0 }), (error) => {
    assert.ok(error instanceof PanoramaxSourceError);
    assert.match(error.message, /did not answer/);
    return true;
  });
});
