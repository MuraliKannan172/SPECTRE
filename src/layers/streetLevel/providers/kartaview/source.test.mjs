import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KartaViewSourceError,
  createKartaViewSource,
  createLimiter,
} from './source.js';
import {
  PHOTO_API_CONCURRENCY,
  PHOTO_API_RETRIES,
  TILE_CONCURRENCY,
} from './policy.js';

const ok = (body) => ({
  ok: true,
  status: 200,
  headers: new Map(),
  json: async () => body,
});
const status = (code, headers = new Map()) => ({
  ok: false,
  status: code,
  headers,
  json: async () => ({}),
});
const photoPayload = (data) => ({
  status: { apiCode: 600, httpCode: 200 },
  result: { data, hasMoreData: false },
});

test('coverage tiles come from api.kartaview.org as JSON', async () => {
  const urls = [];
  const source = createKartaViewSource({
    fetchImpl: async (url) => {
      urls.push(url);
      return ok({ lines: [] });
    },
  });
  assert.deepEqual(await source.getTile({ x: 4412, y: 6061, z: 14 }), {
    lines: [],
  });
  assert.deepEqual(urls, [
    'https://api.kartaview.org/2.0/sequence/tiles/4412/6061/14.json',
  ]);
});

test('photo lookups run at most two at a time', async () => {
  let running = 0;
  let peak = 0;
  const source = createKartaViewSource({
    fetchImpl: async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return ok(photoPayload({ id: '1' }));
    },
  });
  await Promise.all(
    Array.from({ length: 7 }, (_, i) => source.getPhoto(String(i))),
  );
  assert.equal(peak, PHOTO_API_CONCURRENCY);
});

test('a 429 is retried after a wait, then answered', async () => {
  let calls = 0;
  const source = createKartaViewSource({
    retryBaseMs: 1,
    fetchImpl: async () => {
      calls++;
      return calls < 3
        ? status(429, new Map([['retry-after', '0']]))
        : ok(photoPayload([{ id: '9' }]));
    },
  });
  const records = await source.nearestPhotos({ lat: 42.3, lon: -83.04 });
  assert.deepEqual(records, [{ id: '9' }]);
  assert.equal(calls, 3);
});

test('rate-limiting that outlasts the retries is reported with a wait', async () => {
  let calls = 0;
  const source = createKartaViewSource({
    retryBaseMs: 1,
    fetchImpl: async () => {
      calls++;
      return status(429, new Map([['retry-after', '0.001']]));
    },
  });
  await assert.rejects(source.getPhoto('1'), (error) => {
    assert.ok(error instanceof KartaViewSourceError);
    assert.equal(error.status, 429);
    assert.ok(error.retryAfterSec > 0);
    assert.match(error.message, /try again in a moment/);
    return true;
  });
  assert.equal(calls, PHOTO_API_RETRIES + 1);
});

test('an API refusal inside a 200 is a readable error with its code; 601 is just empty', async () => {
  const refusing = createKartaViewSource({
    fetchImpl: async () =>
      ok({
        status: { apiCode: 612, apiMessage: ' out of range ', httpCode: 400 },
        result: {},
      }),
  });
  await assert.rejects(
    refusing.getPhoto('1'),
    /KartaView refused the request \(code 612\)/,
  );
  const empty = createKartaViewSource({
    fetchImpl: async () =>
      ok({ status: { apiCode: 601 }, result: { data: [] } }),
  });
  assert.deepEqual(await empty.nearestPhotos({ lat: 0, lon: 0 }), []);
  const page = await empty.getSequencePhotos('2008', {
    page: 2,
    itemsPerPage: 1000,
  });
  assert.deepEqual(page, { photos: [], hasMore: false });
});

test('HTTP errors, network failures and non-JSON become readable errors', async () => {
  const http = createKartaViewSource({ fetchImpl: async () => status(500) });
  await assert.rejects(http.getTile({ x: 0, y: 0, z: 14 }), /HTTP 500/);
  const offline = createKartaViewSource({
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  await assert.rejects(offline.getPhoto('1'), /did not answer/);
  const garbled = createKartaViewSource({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }),
  });
  await assert.rejects(
    garbled.getTile({ x: 0, y: 0, z: 14 }),
    /did not answer/,
  );
});

test('an abort stops a queued lookup without fetching, and wins over a retry wait', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const source = createKartaViewSource({
    retryBaseMs: 10_000,
    fetchImpl: async (url) => {
      calls++;
      if (url.includes('/slow')) await gate;
      return status(429);
    },
  });
  // Two slow lookups fill the queue; the third waits for a slot.
  const first = new AbortController();
  const slow = [
    source.getPhoto('slow', { signal: first.signal }),
    source.getPhoto('slow', { signal: first.signal }),
  ];
  const controller = new AbortController();
  const queued = source.getPhoto('queued', { signal: controller.signal });
  controller.abort(new Error('overtaken'));
  await assert.rejects(queued, /overtaken/);
  assert.equal(calls, 2, 'the queued lookup never fetched');
  release();
  // Each slow one is now waiting 10 s to retry; nothing else is asked.
  const retrying = new AbortController();
  const waiting = source.getPhoto('slow', { signal: retrying.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  retrying.abort(new Error('closed'));
  await assert.rejects(waiting, /closed/);
  // The two first lookups are still waiting out their backoff: drop them.
  first.abort(new Error('done'));
  for (const promise of slow) await assert.rejects(promise, /done/);
});

test('the limiter runs tasks in order and keeps going after a failure', async () => {
  const limiter = createLimiter(1);
  const order = [];
  const failing = limiter.run(async () => {
    order.push('a');
    throw new Error('a failed');
  });
  const second = limiter.run(async () => {
    order.push('b');
    return 'b';
  });
  await assert.rejects(failing, /a failed/);
  assert.equal(await second, 'b');
  assert.deepEqual(order, ['a', 'b']);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(limiter.pending, 0);
});

test('tiles, lookups and sequence pages queue separately, so a lookup never waits behind them', async () => {
  const running = { tile: 0, photo: 0, page: 0 };
  const peak = { tile: 0, photo: 0, page: 0 };
  const release = [];
  const kind = (url) =>
    url.includes('/tiles/')
      ? 'tile'
      : url.includes('/photos')
        ? 'page'
        : 'photo';
  const source = createKartaViewSource({
    fetchImpl: async (url) => {
      const k = kind(url);
      running[k]++;
      peak[k] = Math.max(peak[k], running[k]);
      if (k !== 'photo') await new Promise((resolve) => release.push(resolve));
      running[k]--;
      return k === 'tile' ? ok({ lines: [] }) : ok(photoPayload([]));
    },
  });
  const tiles = Array.from({ length: 9 }, (_, i) =>
    source.getTile({ x: i, y: 0, z: 14 }),
  );
  const pages = [1, 2].map((page) =>
    source.getSequencePhotos('1', { page, itemsPerPage: 500 }),
  );
  // Every slow tile and page is in flight or queued; a lookup still answers.
  assert.deepEqual(await source.nearestPhotos({ lat: 1, lon: 1 }), []);
  assert.equal(peak.tile, TILE_CONCURRENCY);
  assert.equal(peak.page, 1);
  while (release.length) {
    release.shift()();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await Promise.all([...tiles, ...pages]);
  assert.equal(peak.tile, TILE_CONCURRENCY);
  assert.equal(peak.page, 1);
});

test('a lookup that times out is asked once more; a second timeout says to try again', async () => {
  let calls = 0;
  const source = createKartaViewSource({
    fetchImpl: async () => {
      calls++;
      throw new TypeError('Failed to fetch');
    },
  });
  await assert.rejects(
    source.getPhoto('1'),
    /did not answer in time — try again/,
  );
  assert.equal(calls, 2);
});

test('an image probe reads only the status: an archived photo (409) is not showable', async () => {
  const seen = [];
  const source = createKartaViewSource({
    fetchImpl: async (url, { signal }) => {
      seen.push(signal);
      return {
        ok: !url.includes('archived'),
        status: url.includes('archived') ? 409 : 200,
      };
    },
  });
  assert.equal(
    await source.probeImage('https://storage13.openstreetcam.org/ok.jpg'),
    true,
  );
  assert.equal(
    await source.probeImage('https://storage13.openstreetcam.org/archived.jpg'),
    false,
  );
  assert.equal(await source.probeImage(null), false);
  assert.ok(
    seen.every((signal) => signal.aborted),
    'the body is dropped',
  );
  const offline = createKartaViewSource({
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  assert.equal(
    await offline.probeImage('https://x.openstreetcam.org/a.jpg'),
    false,
  );
});
