import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyChatStatus,
  classifyGlobe,
  classifyIntelHealth,
  classifyLayers,
  probeEndpoint,
  probeGlobe,
  probeRow,
} from './probes.js';

const NOW = '2026-10-28T12:00:00Z';
const minutesBefore = (minutes) =>
  new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
const feed = (extra = {}) => ({
  state: 'ok',
  consecutive_errors: 0,
  last_success_at: minutesBefore(2),
  ...extra,
});
const health = (feeds, state = 'live') => ({
  now: NOW,
  freshness: { state, stale_after_seconds: 900 },
  feeds,
});

test('intel health: fresh active feeds are ONLINE with their count', () => {
  assert.deepEqual(
    classifyIntelHealth(
      health([feed(), feed(), feed({ state: 'disabled_noncommercial' })]),
    ),
    { state: 'ok', detail: '2 feeds' },
  );
});

test('intel health: failing or stale feeds are DEGRADED with a count', () => {
  const failing = feed({ state: 'error', consecutive_errors: 2 });
  const stale = feed({ last_success_at: minutesBefore(20) });
  assert.deepEqual(classifyIntelHealth(health([feed(), failing, stale])), {
    state: 'degraded',
    detail: 'stale feeds 2/3',
  });
  // The service says stale but no single feed lags: all of them count.
  assert.deepEqual(classifyIntelHealth(health([feed(), feed()], 'stale')), {
    state: 'degraded',
    detail: 'stale feeds 2/2',
  });
  assert.deepEqual(classifyIntelHealth(health([])), {
    state: 'degraded',
    detail: 'no active feeds',
  });
});

test('chat status: Ollama and the model decide the Neural Core row', () => {
  const base = { model: 'm:7b', ollama: { reachable: true } };
  assert.deepEqual(
    classifyChatStatus({ ...base, model_present: true, tools: true }),
    { state: 'ok', detail: 'm:7b' },
  );
  assert.deepEqual(classifyChatStatus({ ...base, model_present: false }), {
    state: 'degraded',
    detail: 'm:7b not pulled',
  });
  assert.equal(
    classifyChatStatus({ ...base, model_present: null }).state,
    'degraded',
  );
  assert.deepEqual(
    classifyChatStatus({ ...base, model_present: true, tools: false }),
    { state: 'degraded', detail: 'm:7b, JSON tool calls' },
  );
  assert.deepEqual(
    classifyChatStatus({ model: 'm:7b', ollama: { reachable: false } }),
    { state: 'offline', detail: 'Ollama not reachable' },
  );
});

test('chat status: an API provider is judged by ready/problem, not by Ollama', () => {
  const api = {
    provider: 'anthropic',
    model: 'claude-x',
    ollama: { reachable: false },
  };
  assert.deepEqual(classifyChatStatus({ ...api, ready: true }), {
    state: 'ok',
    detail: 'anthropic · claude-x',
  });
  assert.deepEqual(
    classifyChatStatus({ ...api, ready: false, problem: 'no_key' }),
    { state: 'degraded', detail: 'no API key' },
  );
  assert.deepEqual(
    classifyChatStatus({ ...api, ready: false, problem: 'mystery' }),
    { state: 'degraded', detail: 'provider unavailable' },
  );
  // An Ollama :cloud model under local-only mode is blocked, not ready.
  assert.deepEqual(
    classifyChatStatus({
      provider: 'ollama',
      model: 'm:cloud',
      ollama: { reachable: true },
      model_present: true,
      ready: false,
      problem: 'local_only',
    }),
    { state: 'degraded', detail: 'blocked by local-only mode' },
  );
  // A :cloud model waiting for consent is not "ok" either.
  assert.deepEqual(
    classifyChatStatus({
      provider: 'ollama',
      model: 'm:cloud',
      ollama: { reachable: true },
      model_present: true,
      ready: false,
      problem: 'consent_required',
    }),
    { state: 'degraded', detail: 'waiting for consent' },
  );
  // A LAN viewer sees that cloud models stay on the host, not the key state.
  for (const provider of ['acme', 'ollama'])
    assert.deepEqual(
      classifyChatStatus({
        provider,
        model: 'm:cloud',
        ollama: { reachable: true },
        model_present: true,
        ready: false,
        problem: 'lan_viewer',
      }),
      {
        state: 'degraded',
        detail: 'cloud and network models answer on the host only',
      },
    );
});

test('globe: the basemap in use, or the fallback the map stack took', () => {
  const stack = { activeStack: { label: 'NASA Blue Marble' } };
  assert.deepEqual(classifyGlobe(stack, '1.138.0'), {
    state: 'ok',
    detail: 'Cesium 1.138.0 · NASA Blue Marble',
  });
  assert.deepEqual(
    classifyGlobe({ ...stack, switchOrigin: 'automatic' }, '1.138.0'),
    {
      state: 'degraded',
      detail: 'Cesium 1.138.0 · fell back to NASA Blue Marble',
    },
  );
  assert.equal(classifyGlobe({ ...stack, lastError: 'x' }).state, 'degraded');
});

test('layers: the catalog size, and layers whose source is missing', () => {
  const layers = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(classifyLayers({ layers }), {
    state: 'ok',
    detail: '3 layers',
  });
  assert.deepEqual(
    classifyLayers({
      layers,
      getSourceAvailability: (id) => ({ available: id !== 'b' }),
    }),
    { state: 'degraded', detail: '1 of 3 layers unavailable' },
  );
});

const reply = (body, status = 200) => ({
  ok: status < 300,
  status,
  json: async () => body,
});

test('endpoint probe: answers, errors, hangs and odd bodies never throw', async () => {
  const classify = (body) => ({ state: 'ok', detail: body.name });
  assert.deepEqual(
    await probeEndpoint('/x', classify, {
      fetchImpl: async () => reply({ name: 'up' }),
    }),
    { state: 'ok', detail: 'up' },
  );
  assert.deepEqual(
    await probeEndpoint('/x', classify, {
      fetchImpl: async () => reply({}, 503),
      offlineDetail: 'down',
    }),
    { state: 'offline', detail: 'down' },
  );
  assert.deepEqual(
    await probeEndpoint('/x', classify, {
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    }),
    { state: 'offline', detail: '' },
  );
  const hanging = (url, { signal }) =>
    new Promise((resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('aborted'))),
    );
  assert.deepEqual(
    await probeEndpoint('/x', classify, { fetchImpl: hanging, timeoutMs: 20 }),
    { state: 'timeout', detail: '' },
  );
  assert.deepEqual(
    await probeEndpoint(
      '/x',
      () => {
        throw new Error('bad shape');
      },
      { fetchImpl: async () => reply({}) },
    ),
    { state: 'degraded', detail: 'unexpected reply' },
  );
});

test('row probe: NO RESPONSE at the timeout, then a late answer replaces it', async () => {
  const reports = [];
  const late = () =>
    new Promise((resolve) => setTimeout(() => resolve(reply({})), 60));
  await probeRow(
    (state, detail) => reports.push([state, detail]),
    '/x',
    () => ({ state: 'offline', detail: 'Ollama not reachable' }),
    { fetchImpl: late, timeoutMs: 20, lateMs: 500 },
  );
  assert.deepEqual(reports, [
    ['timeout', ''],
    ['offline', 'Ollama not reachable'],
  ]);

  const quick = [];
  await probeRow(
    (state) => quick.push(state),
    '/x',
    () => ({ state: 'ok', detail: '' }),
    { fetchImpl: async () => reply({}), timeoutMs: 200 },
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(quick, ['ok'], 'an answer in time is the only report');
});

function fakeScene({ renders = true, throws = false } = {}) {
  const listeners = new Set();
  return {
    mapStackController: {
      getState: () => ({ activeStack: { label: 'NASA Blue Marble' } }),
    },
    viewer: {
      scene: {
        postRender: {
          addEventListener(listener) {
            if (throws) throw new Error('WebGL context lost');
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        requestRender() {
          if (renders) setTimeout(() => listeners.forEach((l) => l()), 5);
        },
      },
    },
    listeners,
  };
}

test('globe probe: first frame, no frame and a failing viewer', async () => {
  const scene = fakeScene();
  assert.deepEqual(await probeGlobe(scene, { version: '1.138.0' }), {
    state: 'ok',
    detail: 'Cesium 1.138.0 · NASA Blue Marble',
  });
  assert.equal(scene.listeners.size, 0, 'the frame listener is removed');
  assert.deepEqual(
    await probeGlobe(fakeScene({ renders: false }), { timeoutMs: 20 }),
    { state: 'timeout', detail: '' },
  );
  assert.deepEqual(await probeGlobe(fakeScene({ throws: true })), {
    state: 'offline',
    detail: 'WebGL context lost',
  });
});
