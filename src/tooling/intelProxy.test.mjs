import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import {
  createIntelHandler,
  intelTarget,
} from '../../server/providers/intel.js';

/** A loopback HTTP server on an ephemeral port; returns {server, url}. */
async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

/** Mount the proxy the way Vite does: req.url relative to /api/intel. */
async function proxyFor(target) {
  const handler = createIntelHandler({ target, timeoutMs: 2_000 });
  return listen((req, res) => {
    if (!req.url.startsWith('/api/intel')) {
      res.writeHead(404).end();
      return;
    }
    req.url = req.url.slice('/api/intel'.length) || '/';
    handler(req, res);
  });
}

async function closeAll(...servers) {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections?.();
          server.close(resolve);
        }),
    ),
  );
}

test('the target stays on this machine', () => {
  assert.equal(intelTarget({}), 'http://127.0.0.1:8100');
  assert.equal(
    intelTarget({ SKYNET_INTEL_URL: 'http://localhost:9100/' }),
    'http://localhost:9100',
  );
  for (const unsafe of [
    'http://example.com:8100',
    'https://127.0.0.1:8100',
    'http://10.0.0.5:8100',
    'not a url',
  ]) {
    assert.equal(
      intelTarget({ SKYNET_INTEL_URL: unsafe }),
      'http://127.0.0.1:8100',
    );
  }
});

test('reads are forwarded with the target Host and no credentials', async (t) => {
  const seen = [];
  const upstream = await listen((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'x=1',
    });
    res.end('{"items":[]}');
  });
  const proxy = await proxyFor(upstream.url);
  t.after(() => closeAll(upstream.server, proxy.server));

  const response = await fetch(`${proxy.url}/api/intel/news?q=flood&limit=5`, {
    headers: {
      Cookie: 'session=secret',
      Authorization: 'Bearer secret',
      'Last-Event-ID': '42',
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { items: [] });
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(seen[0].url, '/api/intel/news?q=flood&limit=5');
  assert.equal(seen[0].headers.host, new URL(upstream.url).host);
  assert.equal(seen[0].headers['last-event-id'], '42');
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[0].headers.authorization, undefined);

  const story = await fetch(`${proxy.url}/api/intel/news/17`);
  assert.equal(story.status, 200);
  assert.equal(seen[1].url, '/api/intel/news/17');
});

test('only the read routes are reachable', async (t) => {
  const upstream = await listen((_req, res) => res.writeHead(200).end('{}'));
  const proxy = await proxyFor(upstream.url);
  t.after(() => closeAll(upstream.server, proxy.server));

  for (const path of [
    '/api/intel/docs',
    '/api/intel/openapi.json',
    '/api/intel/news/abc',
    '/api/intel/../x',
  ]) {
    assert.equal((await fetch(`${proxy.url}${path}`)).status, 404, path);
  }
  const post = await fetch(`${proxy.url}/api/intel/news`, {
    method: 'POST',
    body: '{}',
  });
  assert.equal(post.status, 405);
});

test('a stopped service answers 503 intel_offline', async (t) => {
  // Bind then close a port so nothing is listening on it.
  const dead = await listen(() => {});
  await closeAll(dead.server);
  const proxy = await proxyFor(dead.url);
  t.after(() => closeAll(proxy.server));

  const response = await fetch(`${proxy.url}/api/intel/health`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    state: 'intel_offline',
    error: 'connection_refused',
  });
});

test('the stream is relayed as it arrives and closes upstream when the browser leaves', async (t) => {
  let upstreamClosed;
  const closed = new Promise((resolve) => (upstreamClosed = resolve));
  const upstream = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: ready\ndata: {"latest_id":3}\n\n');
    req.on('close', upstreamClosed); // never ends on its own
  });
  const proxy = await proxyFor(upstream.url);
  t.after(() => closeAll(upstream.server, proxy.server));

  const controller = new AbortController();
  const response = await fetch(`${proxy.url}/api/intel/news/stream`, {
    signal: controller.signal,
  });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body.getReader();
  const { value } = await reader.read(); // arrives while the upstream is still open
  assert.match(new TextDecoder().decode(value), /event: ready/);
  controller.abort();
  await closed;
});
