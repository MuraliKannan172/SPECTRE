import test from 'node:test';
import assert from 'node:assert/strict';

import { createProvidersClient } from './providersClient.js';
import {
  budgetText,
  consentItems,
  disclaimerText,
  filterModels,
  formatContext,
  keySourceText,
  kindBadge,
  modelChips,
  pricePerMillion,
  providerState,
  usageText,
  vramFit,
} from './providersView.js';

test('badges and the disclaimer say where the model runs, in text', () => {
  assert.equal(kindBadge('local'), 'LOCAL');
  assert.equal(kindBadge('remote'), 'REMOTE');
  assert.equal(kindBadge('cloud', 'Claude'), 'CLOUD · Claude');
  assert.match(disclaimerText('local'), /^Local model; answers can be wrong/);
  assert.match(
    disclaimerText('cloud', 'Claude'),
    /^Cloud model \(Claude\): the conversation is sent to it/,
  );
  for (const kind of ['local', 'remote', 'cloud'])
    assert.match(
      disclaimerText(kind, 'X'),
      /It will not locate or track people\.$/,
    );
});

test('consent lists what is sent, the map only when it is', () => {
  assert.equal(consentItems({ mapContext: true }).length, 3);
  assert.match(consentItems({ mapContext: true })[2], /^Map context/);
  assert.match(consentItems({ mapContext: false })[2], /^Not the map/);
});

test('provider states and key sources', () => {
  const key = (k) => ({ id: 'openai', kind: 'cloud', key: k });
  assert.equal(
    providerState(key({ required: true, configured: false })).code,
    'not_configured',
  );
  assert.equal(
    providerState({
      ...key({ required: true, configured: false }),
      id: 'custom',
    }).code,
    'ready',
  );
  assert.equal(
    providerState({ id: 'ollama', kind: 'local', key: { required: false } })
      .code,
    'local',
  );
  assert.equal(
    providerState(key({ required: true, configured: true }), { ok: true }).code,
    'connected',
  );
  assert.equal(
    providerState(key({ required: true, configured: true }), { ok: false })
      .code,
    'error',
  );
  assert.equal(
    keySourceText({ required: true, configured: true, source: 'env_file' }),
    'Key from .env (shared with POWER UP)',
  );
  assert.equal(keySourceText({ required: false }), 'Takes no API key');
});

test('model chips: tools, vision, context and a price or ?', () => {
  const openrouter = {
    id: 'm',
    supports_tools: 'yes',
    capabilities: ['completion', 'tools', 'vision'],
    context_window: 131072,
    details: { pricing: { prompt: '0.000003', completion: '0.000015' } },
  };
  assert.deepEqual(modelChips(openrouter), [
    'TOOLS',
    'VISION',
    '128K',
    '$3 / $15 per 1M',
  ]);
  assert.deepEqual(modelChips({ id: 'x', supports_tools: 'unknown' }), [
    'TOOLS ?',
    '?',
  ]);
  assert.deepEqual(
    pricePerMillion({ id: 'y' }, { price_in: 1, price_out: 2 }),
    { input: 1, output: 2 },
  );
  assert.equal(pricePerMillion({ id: 'y' }, {}), null);
  assert.equal(formatContext(1_048_576), '1M');
});

test('the picker puts favourites first and filters by id or label', () => {
  const models = [
    { id: 'b', label: 'Beta' },
    { id: 'a', label: 'Alpha' },
    { id: 'c', label: 'Gamma' },
  ];
  assert.deepEqual(
    filterModels(models, '', ['c']).map((m) => m.id),
    ['c', 'a', 'b'],
  );
  assert.deepEqual(
    filterModels(models, 'ALP').map((m) => m.id),
    ['a'],
  );
});

test('the VRAM fit is an estimate and says so', () => {
  const fit = vramFit(5_000_000_000, 8);
  assert.equal(fit.fits, true);
  assert.match(fit.text, /\(estimate\)$/);
  assert.equal(vramFit(9_000_000_000, 8).fits, false);
  assert.equal(vramFit(undefined, 8), null);
});

test('usage and budget lines', () => {
  assert.equal(usageText({ input: 0, output: 0 }), null);
  assert.equal(usageText({ input: 1200, output: 300 }), '1.5K tokens');
  const priced = { input: 1_000_000, output: 0 };
  assert.equal(
    usageText(
      { input: 1_000_000, output: 0, priced },
      { input: 3, output: 15 },
    ),
    '1,000K tokens · $3',
  );
  // Local tokens from earlier in the conversation are counted, never priced.
  assert.equal(
    usageText(
      { input: 3_000_000, output: 0, priced },
      { input: 3, output: 15 },
    ),
    '3,000K tokens · $3',
  );
  assert.equal(
    usageText({ input: 5, output: 5 }, { input: 3, output: 15 }),
    '10 tokens',
    'an older service sends no priced share: no cost rather than a wrong one',
  );
  assert.match(
    budgetText({ spent: 100500, allowance: 100000, budget: 100000 }),
    /used 100,500 cloud tokens/,
  );
});

test('writes carry the session token from memory and refetch it once', async () => {
  const calls = [];
  let issued = 'one';
  const respond = (status, body) =>
    new Response(JSON.stringify(body), { status });
  const fetchImpl = async (url, init = {}) => {
    calls.push({
      url,
      method: init.method || 'GET',
      token: init.headers?.['X-Spectre-Session'],
    });
    if (url.endsWith('/session')) return respond(200, { token: issued });
    if (init.headers?.['X-Spectre-Session'] !== issued)
      return respond(403, { detail: { code: 'session_required' } });
    return respond(200, { configured: true, source: 'keyring' });
  };
  const client = createProvidersClient({ fetchImpl });
  const saved = await client.setKey('openai', 'sk-test-value-123');
  assert.equal(saved.source, 'keyring');
  issued = 'two'; // the service restarted
  await client.setConsent('openai', true);
  assert.deepEqual(
    calls.map((c) =>
      `${c.method} ${c.url.replace('/api/intel/providers', '')} ${c.token ?? ''}`.trim(),
    ),
    [
      'GET /session',
      'PUT /openai/key one',
      'PUT /openai/consent one',
      'GET /session',
      'PUT /openai/consent two',
    ],
  );
  assert.equal(globalThis.localStorage?.getItem?.('token') ?? null, null);
});

test('a refusal other than the token is not retried', async () => {
  let writes = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/session'))
      return new Response('{"token":"t"}', { status: 200 });
    writes += 1;
    return new Response('{"detail":{"code":"bad_key"}}', { status: 400 });
  };
  const client = createProvidersClient({ fetchImpl });
  await assert.rejects(
    client.setKey('openai', 'x'),
    (error) => error.code === 'bad_key',
  );
  assert.equal(writes, 1);
});
