import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NeuralCoreError,
  createNeuralCoreClient,
  createSseParser,
} from './client.js';
import { layerStateSnapshot, viewportSnapshot } from './context.js';
import { createClientToolExecutor, plainResult } from './executor.js';
import {
  answerSegments,
  endsWithAsOf,
  errorText,
  statusSummary,
  turnErrorCode,
  toolLabel,
} from './view.js';

test('the SSE parser handles split chunks, CRLF and bad data', () => {
  const events = [];
  const feed = createSseParser((name, data) => events.push([name, data]));
  feed('event: turn\ndata: {"turn_id":"a"}\n\nevent: tok');
  feed('en\r\ndata: {"text":"Hi"}\r\n\r\nevent: x\ndata: not json\n\n');
  feed('data: {"bare":true}\n\n');
  assert.deepEqual(events, [
    ['turn', { turn_id: 'a' }],
    ['token', { text: 'Hi' }],
    ['message', { bare: true }],
  ]);
});

test('a turn posts JSON and streams events; failures carry the reason', async () => {
  const requests = [];
  const body = new ReadableStream({
    start(controller) {
      const encode = (text) => new TextEncoder().encode(text);
      controller.enqueue(encode('event: turn\ndata: {"turn_id":"t"}\n\n'));
      controller.enqueue(encode('event: done\ndata: {"as_of":null}\n\n'));
      controller.close();
    },
  });
  const client = createNeuralCoreClient({
    fetchImpl: async (url, init) => {
      requests.push([url, init]);
      if (url.endsWith('/status'))
        return new Response(JSON.stringify({ state: 'intel_offline' }), {
          status: 503,
        });
      if (url.endsWith('/history'))
        return new Response(JSON.stringify({ detail: { code: 'busy' } }), {
          status: 409,
        });
      return new Response(body, { status: 200 });
    },
  });
  const events = [];
  await client.turn({
    message: 'hi',
    viewport: { center: { lat: 1, lon: 2 } },
    onEvent: (name) => events.push(name),
  });
  assert.deepEqual(events, ['turn', 'done']);
  const [url, init] = requests[0];
  assert.equal(url, '/api/intel/chat');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body).viewport, {
    center: { lat: 1, lon: 2 },
  });
  await assert.rejects(client.status(), (error) => {
    assert.ok(error instanceof NeuralCoreError);
    assert.equal(error.code, 'intel_offline');
    return true;
  });
  await assert.rejects(client.clearHistory(), { code: 'busy' });
});

test('map snapshots are plain, bounded data', () => {
  const viewer = {
    camera: {
      positionCartographic: { latitude: 0.6, longitude: 2.4, height: 5000.4 },
      heading: Math.PI,
      pitch: -Math.PI / 4,
      computeViewRectangle: () => ({
        west: 2.3,
        south: 0.5,
        east: 2.5,
        north: 0.7,
      }),
    },
    scene: { globe: { ellipsoid: {} } },
    trackedEntity: { gevTrackedId: 'satellites:25544' },
  };
  const view = viewportSnapshot(viewer, new Date('2026-10-27T12:00:00Z'));
  assert.equal(view.altitude_m, 5000);
  assert.equal(view.heading_deg, 180);
  assert.equal(view.center.lat, 34.3775);
  assert.equal(view.bbox.length, 4);
  assert.equal(view.tracking, 'satellites:25544');
  assert.deepEqual(Object.keys(viewportSnapshot(null)), [
    'time_utc',
    'local_time',
  ]);

  const modules = new Map([
    ['news', { module: { getParams: () => ({ windowHours: 24 }) } }],
    ['flights', { module: { getParams: () => ({ blob: 'x'.repeat(500) }) } }],
    [
      'broken',
      {
        module: {
          getParams: () => {
            throw new Error('x');
          },
        },
      },
    ],
  ]);
  const layers = layerStateSnapshot({
    getEnabledLayerIds: () => new Set(['news', 'flights', 'broken']),
    layers: modules,
  });
  assert.deepEqual(layers, {
    on: ['news', 'flights', 'broken'],
    options: { news: { windowHours: 24 } },
  });
});

test('only registered globe tools with valid arguments reach the runner', async () => {
  const calls = [];
  const execute = createClientToolExecutor({
    runner: async (name, args) => {
      calls.push([name, args]);
      return { ok: true, said: 'Flying to Tokyo', fn() {} };
    },
  });
  assert.deepEqual(await execute('fly_to_location', { query: 'Tokyo' }), {
    ok: true,
    result: { ok: true, said: 'Flying to Tokyo' },
  });
  const unknown = await execute('run_shell', { cmd: 'x' });
  assert.equal(unknown.ok, false);
  const invalid = await execute('set_layer_visibility', { layerId: 'nope' });
  assert.equal(invalid.ok, false);
  assert.equal(calls.length, 1);

  const slow = createClientToolExecutor({
    runner: () => new Promise(() => {}),
    timeoutMs: 20,
  });
  const timedOut = await slow('zoom_to_globe', {});
  assert.deepEqual(timedOut, {
    ok: false,
    error: 'the globe did not finish in time',
  });
});

test('a globe action the app refused is reported as failed', async () => {
  const refused = {
    ok: false,
    layerId: 'news',
    error: 'Could not enable the requested layer',
    say: "Couldn't turn on news.",
  };
  const execute = createClientToolExecutor({ runner: async () => refused });
  assert.deepEqual(
    await execute('set_layer_visibility', { layerId: 'news', enabled: true }),
    {
      ok: false,
      error: 'Could not enable the requested layer',
      result: refused,
    },
  );
  const quiet = createClientToolExecutor({
    runner: async () => ({ ok: false }),
  });
  assert.deepEqual(await quiet('zoom_to_globe', {}), {
    ok: false,
    error: 'the globe refused the action',
    result: { ok: false },
  });
});

test('runner results are reduced to bounded JSON', () => {
  class Entity {}
  const loop = { a: 1 };
  loop.self = loop;
  assert.deepEqual(plainResult({ entity: new Entity(), n: 1n, loop }), {
    n: '1',
    loop: { a: 1 },
  });
  assert.equal(plainResult({ text: 'x'.repeat(9000) }).truncated, true);
});

test('citation chips appear only for sources the turn has', () => {
  const citations = [
    { n: 1, url: 'https://a.example', title: 'A' },
    { n: 2, url: 'https://b.example', title: 'B' },
  ];
  assert.deepEqual(
    answerSegments('Quake [1], aftershocks [1, 2]; not [9].', citations).map(
      (part) => (part.kind === 'cite' ? `#${part.n}` : part.text),
    ),
    ['Quake ', '#1', ', aftershocks ', '#1', '#2', '; not [9].'],
  );
  assert.ok(endsWithAsOf('Text [1].\nAs of 2026-10-27 12:00'));
  assert.ok(!endsWithAsOf('As of yesterday it rained.\nMore text'));
});

test('labels and errors describe real state', () => {
  assert.equal(
    toolLabel({ tool: 'web_search', state: 'start' }),
    'Searching the web…',
  );
  assert.equal(
    toolLabel({
      tool: 'fetch_page',
      state: 'error',
      host: 'x.org',
      code: 'robots_disallowed',
    }),
    'Reading x.org: blocked by the site’s robots.txt',
  );
  assert.equal(
    errorText('ollama_model_missing', { model: 'm:1' }),
    'Model m:1 is not installed: run ollama pull m:1',
  );
  assert.equal(errorText('weird'), 'The Neural Core failed (weird).');
  assert.equal(statusSummary(null, 'intel_offline').tone, 'offline');
  assert.equal(
    statusSummary({ model: 'm', ollama: { reachable: false } }).text,
    'Ollama is not running. Start Ollama, then try again.',
  );
  const ready = statusSummary({
    model: 'm',
    ollama: { reachable: true },
    model_present: true,
    tools: true,
    loaded: { size_vram: 3_400_000_000 },
    search: { configured: true, best_effort: true, provider: 'ddgs' },
  });
  assert.equal(ready.tone, 'ready');
  assert.equal(ready.text, 'm · loaded · 3.4 GB on the GPU');
  assert.equal(ready.search, 'Web search: DuckDuckGo via ddgs (best effort)');
  assert.equal(
    statusSummary({ model: 'm', ollama: { reachable: true }, tools: false })
      .tone,
    'degraded',
  );
  // A selected API provider is not judged by Ollama (ADR-002 D7).
  const api = {
    provider: 'deepseek',
    model: 'd1',
    ollama: { reachable: false },
  };
  assert.deepEqual(statusSummary({ ...api, ready: true }), {
    tone: 'ready',
    text: 'deepseek · d1 · ready',
    search: null,
  });
  assert.equal(
    statusSummary({ ...api, ready: false, problem: 'consent_required' }).text,
    'deepseek · d1 · This provider has not been allowed to receive the conversation yet.',
  );
  // An Ollama :cloud model waiting for consent does not read as loaded.
  const cloudOllama = statusSummary({
    provider: 'ollama',
    model: 'beam:cloud',
    ollama: { reachable: true },
    model_present: true,
    ready: false,
    problem: 'consent_required',
    loaded: { size_vram: 1 },
  });
  assert.equal(cloudOllama.tone, 'offline');
  assert.match(
    cloudOllama.text,
    /^beam:cloud · This provider has not been allowed/,
  );
  assert.equal(
    statusSummary({
      provider: 'ollama',
      model: 'beam:cloud',
      ollama: { reachable: true },
      model_present: true,
      ready: false,
      problem: 'lan_viewer',
    }).text,
    'beam:cloud · Cloud and network models answer only on the computer running SPECTRE.',
  );
  assert.equal(
    turnErrorCode({ code: 'rate_limited', provider: 'openai' }),
    'provider_rate_limited',
  );
  assert.equal(turnErrorCode({ code: 'rate_limited' }), 'rate_limited');
});
