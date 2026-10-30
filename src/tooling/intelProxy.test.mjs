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
    intelTarget({ SPECTRE_INTEL_URL: 'http://localhost:9100/' }),
    'http://localhost:9100',
  );
  for (const unsafe of [
    'http://example.com:8100',
    'https://127.0.0.1:8100',
    'http://10.0.0.5:8100',
    'not a url',
  ]) {
    assert.equal(
      intelTarget({ SPECTRE_INTEL_URL: unsafe }),
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

test('chat writes are forwarded as JSON, without Origin, and the turn streams', async (t) => {
  const seen = [];
  const upstream = await listen(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (req.url === '/api/intel/chat') {
      // A slow first event must not trip the request timeout.
      await new Promise((resolve) => setTimeout(resolve, 300));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('event: turn\ndata: {}\n\n');
      return;
    }
    res.writeHead(req.method === 'GET' ? 200 : 204).end();
  });
  const handler = createIntelHandler({ target: upstream.url, timeoutMs: 100 });
  const proxy = await listen((req, res) => {
    req.url = req.url.slice('/api/intel'.length) || '/';
    handler(req, res);
  });
  t.after(() => closeAll(upstream.server, proxy.server));
  const origin = proxy.url;

  const turn = await fetch(`${proxy.url}/api/intel/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ message: 'hi' }),
  });
  assert.equal(turn.status, 200);
  assert.equal(turn.headers.get('x-accel-buffering'), 'no');
  assert.match(await turn.text(), /event: turn/);
  const forwarded = seen[0];
  assert.equal(forwarded.body, '{"message":"hi"}');
  assert.equal(forwarded.headers['content-type'], 'application/json');
  assert.equal(forwarded.headers.origin, undefined);
  assert.equal(forwarded.headers.host, new URL(upstream.url).host);

  const status = await fetch(`${proxy.url}/api/intel/chat/status`);
  assert.equal(status.status, 200);
  const cleared = await fetch(`${proxy.url}/api/intel/chat/history`, {
    method: 'DELETE',
    headers: { origin },
  });
  assert.equal(cleared.status, 204);
  assert.deepEqual(
    seen.slice(1).map((r) => `${r.method} ${r.url}`),
    ['GET /api/intel/chat/status', 'DELETE /api/intel/chat/history'],
  );
});

test('chat writes from other sites, or not JSON, or too big are refused', async (t) => {
  let reached = 0;
  const upstream = await listen((_req, res) => {
    reached += 1;
    res.writeHead(204).end();
  });
  const proxy = await proxyFor(upstream.url);
  t.after(() => closeAll(upstream.server, proxy.server));
  const post = (headers, body = '{}') =>
    fetch(`${proxy.url}/api/intel/chat/stop`, {
      method: 'POST',
      headers,
      body,
    });

  const json = { 'content-type': 'application/json' };
  assert.equal(
    (await post({ ...json, origin: 'https://evil.example' })).status,
    403,
  );
  assert.equal(
    (await post({ ...json, 'sec-fetch-site': 'cross-site' })).status,
    403,
  );
  assert.equal((await post({ 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(json, 'x'.repeat(70_000))).status, 413);
  const evilDelete = await fetch(`${proxy.url}/api/intel/chat/history`, {
    method: 'DELETE',
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(evilDelete.status, 403);
  assert.equal((await fetch(`${proxy.url}/api/intel/chat/run`)).status, 404);
  assert.equal(reached, 0);
});

test('chat answers this machine only unless LAN is opted in', async () => {
  const calls = [];
  const fakeRequest = () => {
    calls.push(1);
    return {
      on() {},
      once() {},
      setTimeout() {},
      end() {},
      destroy() {},
    };
  };
  const reply = () => {
    const res = { headersSent: false, status: 0, body: '' };
    res.writeHead = (code) => (res.status = code);
    res.end = (text = '') => (res.body = String(text));
    res.once = () => {};
    return res;
  };
  const lan = {
    method: 'GET',
    url: '/chat/status',
    headers: {},
    socket: { remoteAddress: '192.168.1.40' },
  };
  const closed = createIntelHandler({ request: fakeRequest, env: {} });
  const refused = reply();
  await closed(lan, refused);
  assert.equal(refused.status, 403);
  assert.match(refused.body, /chat_local_only/);
  // News stays readable from the LAN (it was before); chat does not.
  await closed({ ...lan, url: '/health' }, reply());
  assert.equal(calls.length, 1);

  const open = createIntelHandler({
    request: fakeRequest,
    env: { SPECTRE_CHAT_ALLOW_LAN: '1' },
  });
  await open(lan, reply());
  assert.equal(calls.length, 2);
});

test('a LAN viewer is marked for the service, and a client cannot forge the mark', async () => {
  const sent = [];
  const fakeRequest = (options) => {
    sent.push(options.headers);
    return { on() {}, once() {}, setTimeout() {}, end() {}, destroy() {} };
  };
  const reply = () => ({
    writeHead() {},
    end() {},
    once() {},
    headersSent: false,
  });
  const open = createIntelHandler({
    request: fakeRequest,
    env: { SPECTRE_CHAT_ALLOW_LAN: '1' },
  });
  const forged = { 'x-spectre-viewer': 'local' };
  await open(
    {
      method: 'GET',
      url: '/chat/status',
      headers: forged,
      socket: { remoteAddress: '192.168.1.40' },
    },
    reply(),
  );
  await open(
    {
      method: 'GET',
      url: '/chat/status',
      headers: { 'x-spectre-viewer': 'lan' },
      socket: { remoteAddress: '127.0.0.1' },
    },
    reply(),
  );
  assert.equal(sent[0]['x-spectre-viewer'], 'lan');
  assert.equal(sent[1]['x-spectre-viewer'], undefined);
});

test('voice uploads keep their audio type, and replies keep their timing', async (t) => {
  const seen = [];
  const upstream = await listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks),
    });
    if (req.url === '/api/intel/voice/speak') {
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'X-Voice-Seconds': '0.812',
      });
      res.end(Buffer.from('RIFF'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"text":"Fly to Nairobi."}');
  });
  const proxy = await proxyFor(upstream.url);
  t.after(() => closeAll(upstream.server, proxy.server));
  const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);

  const heard = await fetch(`${proxy.url}/api/intel/voice/transcribe`, {
    method: 'POST',
    headers: { 'content-type': 'audio/webm;codecs=opus', origin: proxy.url },
    body: audio,
  });
  assert.equal(heard.status, 200);
  assert.deepEqual(await heard.json(), { text: 'Fly to Nairobi.' });
  assert.equal(seen[0].headers['content-type'], 'audio/webm');
  assert.equal(seen[0].headers.origin, undefined);
  assert.deepEqual(seen[0].body, audio);

  const spoken = await fetch(`${proxy.url}/api/intel/voice/speak`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: proxy.url },
    body: '{"text":"Done."}',
  });
  assert.equal(spoken.headers.get('content-type'), 'audio/wav');
  assert.equal(spoken.headers.get('x-voice-seconds'), '0.812');
  assert.equal(Buffer.from(await spoken.arrayBuffer()).toString(), 'RIFF');
});

test('voice refuses other sites, the wrong type, oversize audio and the LAN', async (t) => {
  let reached = 0;
  const upstream = await listen((_req, res) => {
    reached += 1;
    res.writeHead(200).end('{}');
  });
  const proxy = await proxyFor(upstream.url);
  t.after(() => closeAll(upstream.server, proxy.server));
  const transcribe = (headers, body = 'x') =>
    fetch(`${proxy.url}/api/intel/voice/transcribe`, {
      method: 'POST',
      headers,
      body,
    });
  const webm = { 'content-type': 'audio/webm' };
  assert.equal(
    (await transcribe({ ...webm, origin: 'https://evil.example' })).status,
    403,
  );
  const json = await transcribe({ 'content-type': 'application/json' }, '{}');
  assert.equal(json.status, 415);
  assert.match(await json.text(), /audio_only/);
  const speakAudio = await fetch(`${proxy.url}/api/intel/voice/speak`, {
    method: 'POST',
    headers: webm,
    body: 'x',
  });
  assert.equal(speakAudio.status, 415);
  assert.equal(
    (await transcribe(webm, Buffer.alloc(2 * 1024 * 1024 + 1))).status,
    413,
  );
  assert.equal(reached, 0);

  const handler = createIntelHandler({ target: upstream.url, env: {} });
  const res = { status: 0, body: '' };
  res.writeHead = (code) => (res.status = code);
  res.end = (text = '') => (res.body = String(text));
  await handler(
    {
      method: 'GET',
      url: '/voice/status',
      headers: {},
      socket: { remoteAddress: '192.168.1.40' },
    },
    res,
  );
  assert.equal(res.status, 403);
  assert.equal(reached, 0);

  // Opting LAN viewers in to chat never opens voice to them.
  const lanChat = createIntelHandler({
    target: upstream.url,
    env: { SPECTRE_CHAT_ALLOW_LAN: '1' },
  });
  const refused = { status: 0, body: '' };
  refused.writeHead = (code) => (refused.status = code);
  refused.end = (text = '') => (refused.body = String(text));
  await lanChat(
    {
      method: 'GET',
      url: '/voice/status',
      headers: {},
      socket: { remoteAddress: '192.168.1.40' },
    },
    refused,
  );
  assert.equal(refused.status, 403);
  assert.match(refused.body, /voice_local_only/);
  assert.equal(reached, 0);
});

/** A minimal response double for handler-level tests. */
function replyDouble() {
  const res = { status: 0, body: '' };
  res.writeHead = (code) => (res.status = code);
  res.end = (text = '') => (res.body = String(text));
  res.once = () => {};
  return res;
}

test('provider writes forward the session token, never Origin, with an exact local Origin', async (t) => {
  const seen = [];
  const upstream = await listen(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
  const proxy = await proxyFor(upstream.url);
  t.after(() => closeAll(upstream.server, proxy.server));
  const origin = proxy.url;
  const token = { 'x-spectre-session': 'abc' };
  const json = { 'content-type': 'application/json' };

  const put = await fetch(`${proxy.url}/api/intel/providers/openai/key`, {
    method: 'PUT',
    headers: { ...json, ...token, origin },
    body: JSON.stringify({ key: 'sk-x' }),
  });
  assert.equal(put.status, 200);
  const removed = await fetch(`${proxy.url}/api/intel/providers/openai/key`, {
    method: 'DELETE',
    headers: { ...token, origin },
  });
  assert.equal(removed.status, 200);
  for (const path of [
    '/api/intel/providers',
    '/api/intel/providers/session',
    '/api/intel/providers/openai/models',
  ]) {
    const response = await fetch(`${proxy.url}${path}`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(response.status, 200, path);
  }
  const tested = await fetch(`${proxy.url}/api/intel/providers/openai/test`, {
    method: 'POST',
    headers: { ...json, ...token, origin },
    body: '{}',
  });
  assert.equal(tested.status, 200);

  assert.deepEqual(
    seen.map((r) => `${r.method} ${r.url}`),
    [
      'PUT /api/intel/providers/openai/key',
      'DELETE /api/intel/providers/openai/key',
      'GET /api/intel/providers',
      'GET /api/intel/providers/session',
      'GET /api/intel/providers/openai/models',
      'POST /api/intel/providers/openai/test',
    ],
  );
  assert.equal(seen[0].headers['x-spectre-session'], 'abc');
  assert.equal(seen[0].headers.origin, undefined);
  assert.equal(seen[0].body, '{"key":"sk-x"}');

  // The token is a provider-route header only.
  await fetch(`${proxy.url}/api/intel/chat/status`, { headers: token });
  assert.equal(seen.at(-1).headers['x-spectre-session'], undefined);
});

test('provider routes refuse other sites, missing Origin, non-JSON, proxies and sharing', async (t) => {
  let reached = 0;
  const upstream = await listen((_req, res) => {
    reached += 1;
    res.writeHead(200).end('{}');
  });
  const proxy = await proxyFor(upstream.url);
  t.after(() => closeAll(upstream.server, proxy.server));
  const origin = proxy.url;
  const url = `${proxy.url}/api/intel/providers/openai/key`;
  const json = { 'content-type': 'application/json' };
  const put = (headers, body = '{"key":"sk-x"}') =>
    fetch(url, { method: 'PUT', headers, body });
  const error = async (response) => (await response.json()).error;

  assert.equal(await error(await put(json)), 'providers_origin-required');
  assert.equal(
    await error(await put({ ...json, origin: 'https://evil.example' })),
    'providers_cross-origin',
  );
  assert.equal(
    await error(await put({ 'content-type': 'text/plain', origin })),
    'providers_content-type',
  );
  assert.equal(
    await error(await put({ ...json, origin, 'x-forwarded-for': '1.2.3.4' })),
    'providers_proxied',
  );
  assert.equal(
    await error(
      await fetch(`${proxy.url}/api/intel/providers`, {
        headers: { origin: 'https://evil.example' },
      }),
    ),
    'providers_cross-origin',
  );
  assert.equal(
    await error(await fetch(url, { method: 'DELETE' })),
    'providers_origin-required',
  );
  // An <img> or link from another page, even another localhost port, sends
  // no Origin but does send Sec-Fetch-Site; reading models would spend the key.
  for (const site of ['cross-site', 'same-site']) {
    assert.equal(
      await error(
        await fetch(`${proxy.url}/api/intel/providers/openai/models`, {
          headers: { 'sec-fetch-site': site },
        }),
      ),
      'providers_cross-site',
      site,
    );
  }
  for (const path of [
    '/api/intel/providers/Bad/key',
    '/api/intel/providers/openai/secret',
    '/api/intel/providers/openai/key/x',
  ]) {
    const response = await fetch(`${proxy.url}${path}`, {
      method: 'PUT',
      headers: { ...json, origin },
      body: '{}',
    });
    assert.equal(response.status, 404, path);
  }
  assert.equal(
    (await fetch(`${proxy.url}/api/intel/providers/policy`)).status,
    405,
  );
  assert.equal(reached, 0);

  const shared = createIntelHandler({
    target: upstream.url,
    env: { PINOKIO_SHARE_CLOUDFLARE: '1' },
  });
  const res = replyDouble();
  await shared(
    {
      method: 'GET',
      url: '/providers',
      headers: { host: '127.0.0.1:4173' },
      socket: { remoteAddress: '127.0.0.1' },
    },
    res,
  );
  assert.equal(res.status, 403);
  assert.match(res.body, /providers_sharing/);
  assert.equal(reached, 0);
});

test('provider routes stay closed to the LAN even with chat opened to it', async () => {
  let calls = 0;
  const fakeRequest = () => {
    calls += 1;
    return { on() {}, once() {}, setTimeout() {}, end() {}, destroy() {} };
  };
  const open = createIntelHandler({
    request: fakeRequest,
    env: { SPECTRE_CHAT_ALLOW_LAN: '1' },
  });
  const lan = {
    method: 'GET',
    headers: { host: '192.168.1.10:4173' },
    socket: { remoteAddress: '192.168.1.40' },
  };
  for (const url of ['/providers', '/providers/session']) {
    const res = replyDouble();
    await open({ ...lan, url }, res);
    assert.equal(res.status, 403, url);
    assert.match(res.body, /providers_not-loopback/);
  }
  // Nor may a LAN viewer pick the provider, which would spend the owner's key.
  const pick = replyDouble();
  await open(
    {
      ...lan,
      method: 'PUT',
      url: '/providers/selection',
      headers: {
        ...lan.headers,
        origin: 'http://192.168.1.10:4173',
        'content-type': 'application/json',
      },
    },
    pick,
  );
  assert.equal(pick.status, 403);
  assert.match(pick.body, /providers_not-loopback/);
  // A loopback socket with a foreign Host (DNS rebinding, a tunnel) too.
  const rebound = replyDouble();
  await open(
    {
      ...lan,
      url: '/providers',
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: 'attacker.example' },
    },
    rebound,
  );
  assert.match(rebound.body, /providers_not-local-host/);
  await open({ ...lan, url: '/chat/status' }, replyDouble());
  assert.equal(calls, 1, 'only the chat read reached the service');
});
