import test from 'node:test';
import assert from 'node:assert/strict';

import {
  exposedServices,
  formatServicesReport,
  inspectServices,
  networkAddresses,
  nvidiaGpus,
  ollamaUrl,
} from '../scripts/spectre-doctor.mjs';

function fakeFetch(routes) {
  return async (url) => {
    const path = new URL(url).pathname;
    const body = routes[`${new URL(url).origin}${path}`];
    if (body === undefined)
      throw new TypeError('fetch failed: connection refused');
    return { ok: true, status: 200, json: async () => body };
  };
}

const READY = {
  'http://127.0.0.1:8100/api/intel/health': {
    stories: 183,
    freshness: { state: 'live' },
  },
  'http://127.0.0.1:8100/api/intel/chat/status': {
    model: 'qwen3.5-9b-64k-gpu:latest',
    ollama: { reachable: true, version: '0.40.11' },
    model_present: true,
    tools: true,
    loaded: { size: 6_680_000_000, size_vram: 5_390_000_000 },
    search: { provider: 'ddgs', configured: true, best_effort: true },
  },
  'http://127.0.0.1:8100/api/intel/voice/status': {
    state: 'unavailable',
    reason: 'not_installed',
  },
  'http://127.0.0.1:11434/api/version': { version: '0.40.11' },
};

test('OLLAMA_HOST is read the way Ollama reads it', () => {
  assert.equal(ollamaUrl(''), 'http://127.0.0.1:11434');
  assert.equal(ollamaUrl('0.0.0.0'), 'http://127.0.0.1:11434');
  assert.equal(ollamaUrl('0.0.0.0:11500'), 'http://127.0.0.1:11500');
  assert.equal(ollamaUrl('http://gpu-box:11434/'), 'http://gpu-box:11434');
});

test('everything running: the report says what is loaded and what is optional', async () => {
  const services = await inspectServices({
    fetchImpl: fakeFetch(READY),
    gpus: () => [{ name: 'RTX 5060', totalMib: 8151, usedMib: 5600 }],
    exposure: async () => [],
  });
  const text = formatServicesReport(services);
  assert.match(
    text,
    /\[OK\] Intel service at http:\/\/127\.0\.0\.1:8100: news live, 183 stories/,
  );
  assert.match(
    text,
    /\[OK\] Ollama 0\.40\.11; model qwen3\.5-9b-64k-gpu:latest with tool calling/,
  );
  assert.match(text, /\[OK\] Model loaded: 6\.7 GB, 5\.4 GB of it on the GPU/);
  assert.match(text, /\[OK\] Web search: ddgs \(keyless, best effort\)/);
  assert.match(
    text,
    /\[--\] Local voice not set up \(optional\): \.\\scripts\\spectre\.ps1 -Voice/,
  );
  assert.match(text, /\[OK\] GPU: RTX 5060, 5600 of 8151 MiB in use/);
  assert.match(
    text,
    /\[OK\] No SPECTRE or Ollama port answers on your network address/,
  );
});

test('nothing running (as in CI): plain warnings, and nothing throws', async () => {
  const services = await inspectServices({
    fetchImpl: fakeFetch({}),
    gpus: () => null,
    exposure: async () => [],
    readEnv: () => '',
  });
  assert.equal(services.intel.reachable, false);
  assert.equal(services.ollama.reachable, false);
  const text = formatServicesReport(services);
  assert.match(
    text,
    /\[WARN\] Intel service not running at http:\/\/127\.0\.0\.1:8100/,
  );
  assert.match(
    text,
    /\[WARN\] Ollama not reachable at http:\/\/127\.0\.0\.1:11434/,
  );
  assert.match(text, /nvidia-smi not found/);
  assert.doesNotMatch(text, /Web search|Local voice/);
});

test('a missing model, a degraded model and an exposed port are warnings', async () => {
  const missing = structuredClone(READY);
  missing['http://127.0.0.1:8100/api/intel/chat/status'].model_present = false;
  missing['http://127.0.0.1:8100/api/intel/chat/status'].loaded = null;
  const text = formatServicesReport(
    await inspectServices({
      fetchImpl: fakeFetch(missing),
      gpus: () => null,
      exposure: async () => [
        { name: 'Ollama', port: 11434, address: '192.168.1.37' },
      ],
    }),
  );
  assert.match(
    text,
    /\[WARN\] .*model qwen3\.5-9b-64k-gpu:latest is not installed: run ollama pull/,
  );
  assert.match(
    text,
    /\[WARN\] Ollama answers on your network address 192\.168\.1\.37:11434/,
  );

  const degraded = structuredClone(READY);
  degraded['http://127.0.0.1:8100/api/intel/chat/status'].tools = false;
  const degradedText = formatServicesReport(
    await inspectServices({
      fetchImpl: fakeFetch(degraded),
      gpus: () => null,
      exposure: async () => [],
    }),
  );
  assert.match(degradedText, /\[WARN\] .*no native tool calling \(degraded\)/);
});

test('SPECTRE_INTEL_URL and OLLAMA_HOST move the probes', async () => {
  const asked = [];
  await inspectServices({
    readEnv: (name) =>
      ({
        SPECTRE_INTEL_URL: 'http://127.0.0.1:8200/',
        OLLAMA_HOST: '127.0.0.1:11500',
      })[name] || '',
    fetchImpl: async (url) => {
      asked.push(url);
      throw new TypeError('refused');
    },
    gpus: () => null,
    exposure: async () => [],
  });
  assert.ok(asked.includes('http://127.0.0.1:8200/api/intel/health'));
  assert.ok(asked.includes('http://127.0.0.1:11500/api/version'));
});

test('exposure probes each port on the network addresses only', async () => {
  const probed = [];
  const exposed = await exposedServices({
    addresses: ['192.168.1.37'],
    probe: async (host, port) => {
      probed.push(`${host}:${port}`);
      return port === 11434;
    },
  });
  assert.deepEqual(probed.sort(), [
    '192.168.1.37:11434',
    '192.168.1.37:4173',
    '192.168.1.37:8100',
  ]);
  assert.deepEqual(exposed, [
    { name: 'Ollama', port: 11434, address: '192.168.1.37' },
  ]);
  assert.deepEqual(
    networkAddresses({
      lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      eth: [
        { family: 'IPv4', internal: false, address: '192.168.1.37' },
        { family: 'IPv6', internal: false, address: 'fe80::1' },
        { family: 'IPv4', internal: false, address: '169.254.10.2' },
      ],
    }),
    ['192.168.1.37'],
  );
});

test('nvidia-smi output is read, and its absence is not an error', () => {
  assert.deepEqual(
    nvidiaGpus(() => ({
      status: 0,
      stdout: 'NVIDIA GeForce RTX 5060 Laptop GPU, 8151, 1234\n',
    })),
    [
      {
        name: 'NVIDIA GeForce RTX 5060 Laptop GPU',
        totalMib: 8151,
        usedMib: 1234,
      },
    ],
  );
  assert.equal(
    nvidiaGpus(() => ({ error: new Error('ENOENT') })),
    null,
  );
});
