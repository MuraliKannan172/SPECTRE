import http from 'node:http';

import { admitKeySetupRequest } from '../../src/keySetupCore.mjs';

/**
 * SPECTRE: same-origin proxy from /api/intel/* to the local intel service
 * (intel/, FastAPI on 127.0.0.1:8100). The browser never talks to the service
 * directly, so the app's CSP stays same-origin.
 *
 * - News routes are read-only: GET and HEAD on news, story, stream, health.
 * - Neural Core routes (/chat..., /voice...) answer only requests from this
 *   machine. SPECTRE_CHAT_ALLOW_LAN=1 opts LAN viewers in to chat, never to
 *   voice: a LAN page over http cannot use a microphone, so all the flag
 *   would do there is feed untrusted audio to the decoder. Writes must
 *   come from this page's own origin and carry a body of the route's type and
 *   size: JSON of at most 64 KB, or for /voice/transcribe one recorded
 *   question (audio, at most 2 MB).
 * - Provider routes (/providers..., keys and Neural Core provider settings)
 *   pass the same gate as POWER UP, admitKeySetupRequest: never proxied or
 *   shared, a loopback socket, a local Host, and every write with an exact
 *   local Origin. SPECTRE_CHAT_ALLOW_LAN never opens them. Only these routes
 *   forward X-Spectre-Session, the token the service requires on writes.
 * - The target is loopback only. SPECTRE_INTEL_URL may move the port, never
 *   the host off this machine.
 * - Host is set to the target's, which the service's DNS-rebinding allowlist
 *   accepts; only Accept, Last-Event-ID and Content-Type are forwarded, never
 *   cookies, credentials or Origin (the service refuses any request that
 *   carries an Origin, so only this proxy can write to it).
 * - Event streams (news, a chat turn) are piped unbuffered with no timeout,
 *   and closing the browser's request closes the upstream one.
 * - When the service is not running, the answer is 503
 *   {"state":"intel_offline"}, and the rest of the app is unaffected.
 */

const DEFAULT_TARGET = 'http://127.0.0.1:8100';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const JSON_BODY = Object.freeze({
  types: ['application/json'],
  limit: 64 * 1024,
});
const AUDIO_BODY = Object.freeze({
  types: ['audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/mp4'],
  limit: 2 * 1024 * 1024,
});
const ROUTES = Object.freeze([
  {
    methods: ['GET', 'HEAD'],
    pattern: /^\/(?:news(?:\/stream|\/\d{1,12})?|health)(?:\?|$)/,
    stream: /^\/news\/stream/,
  },
  { methods: ['GET'], pattern: /^\/chat\/(?:status|history)$/, chat: true },
  {
    methods: ['DELETE'],
    pattern: /^\/chat\/history$/,
    chat: true,
    write: true,
  },
  {
    methods: ['POST'],
    pattern: /^\/chat(?:\/tool-result|\/stop)?$/,
    chat: true,
    write: true,
    body: JSON_BODY,
    stream: /^\/chat$/,
  },
  {
    methods: ['GET'],
    pattern: /^\/voice\/status$/,
    chat: true,
    localOnly: true,
  },
  {
    methods: ['POST'],
    pattern: /^\/voice\/transcribe$/,
    chat: true,
    localOnly: true,
    write: true,
    body: AUDIO_BODY,
  },
  {
    methods: ['POST'],
    pattern: /^\/voice\/speak$/,
    chat: true,
    localOnly: true,
    write: true,
    body: JSON_BODY,
  },
  {
    methods: ['GET'],
    pattern: /^\/providers(?:\/session|\/[a-z][a-z0-9_-]{1,31}\/models)?$/,
    providers: true,
  },
  {
    methods: ['PUT'],
    pattern:
      /^\/providers\/(?:policy|[a-z][a-z0-9_-]{1,31}\/(?:key|settings|consent))$/,
    providers: true,
    write: true,
    body: JSON_BODY,
  },
  {
    methods: ['DELETE'],
    pattern: /^\/providers\/[a-z][a-z0-9_-]{1,31}\/key$/,
    providers: true,
    write: true,
  },
  {
    methods: ['POST'],
    pattern: /^\/providers\/[a-z][a-z0-9_-]{1,31}\/test$/,
    providers: true,
    write: true,
    body: JSON_BODY,
  },
]);
const FORWARD_REQUEST_HEADERS = ['accept', 'last-event-id'];
const SESSION_HEADER = 'x-spectre-session';
const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'retry-after',
  'x-voice-seconds',
];
const REQUEST_TIMEOUT_MS = 15_000;

/** The service base URL: SPECTRE_INTEL_URL when it is http on loopback. */
export function intelTarget(env = process.env) {
  const raw = String(env.SPECTRE_INTEL_URL || '').trim();
  if (!raw) return DEFAULT_TARGET;
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) {
      return `${url.protocol}//${url.host}`;
    }
  } catch {
    /* fall back below */
  }
  console.warn(
    '[intel proxy] SPECTRE_INTEL_URL must be http:// on 127.0.0.1 or localhost; using the default',
  );
  return DEFAULT_TARGET;
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function isLoopbackAddress(address = '') {
  return (
    address === '::1' ||
    address.startsWith('127.') ||
    address.startsWith('::ffff:127.')
  );
}

/** A write from this page: no Origin (not a browser), or this host's own. */
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { code: 'TOO_LARGE' }));
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * POWER UP's admission gate for a provider route. Every write is gated as a
 * POST, so it needs an exact local Origin. A write without a body (DELETE of
 * a key) skips only the JSON check, which exists to force a CORS preflight
 * that a DELETE always triggers anyway.
 *
 * Reads need one more rule than POWER UP's: an <img> on another page sends
 * no Origin, yet GET /providers/{id}/models makes the service call out with
 * the stored key. So, as in localRequestGate.mjs, a Sec-Fetch-Site other
 * than same-origin or none (a typed URL) is refused, including same-site:
 * another port on localhost is same-site.
 */
function admitProviderRequest(req, route, env) {
  const site = String(req.headers['sec-fetch-site'] || '')
    .trim()
    .toLowerCase();
  if (site !== '' && site !== 'same-origin' && site !== 'none') {
    return { ok: false, status: 403, code: 'cross-site' };
  }
  return admitKeySetupRequest({
    method: route.write ? 'POST' : 'GET',
    remoteAddress: req.socket?.remoteAddress,
    hostHeader: req.headers.host,
    protocol: req.socket?.encrypted ? 'https:' : 'http:',
    origin: req.headers.origin,
    contentType: route.body ? req.headers['content-type'] : 'application/json',
    proxyHeaders: req.headers,
    env,
  });
}

/** The route for this path and method, or the status that refuses it. */
function routeFor(path, method) {
  const matches = ROUTES.filter((route) => route.pattern.test(path));
  if (!matches.length) return { status: 404, error: 'not_found' };
  const route = matches.find((entry) => entry.methods.includes(method));
  return route ? { route } : { status: 405, error: 'method_not_allowed' };
}

/**
 * @param {{target?: string, request?: typeof http.request, timeoutMs?: number,
 *   env?: Record<string, string|undefined>}} [options]
 * @returns {(req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>}
 */
export function createIntelHandler({
  target = intelTarget(),
  request = http.request,
  timeoutMs = REQUEST_TIMEOUT_MS,
  env = process.env,
} = {}) {
  const base = new URL(target);
  const allowLan = String(env.SPECTRE_CHAT_ALLOW_LAN || '') === '1';
  return async function intelHandler(req, res) {
    const path = req.url || '/';
    const { route, status, error } = routeFor(path, req.method);
    if (!route) {
      sendJson(res, status, { error });
      return;
    }
    if (
      route.chat &&
      (route.localOnly || !allowLan) &&
      !isLoopbackAddress(req.socket?.remoteAddress)
    ) {
      sendJson(res, 403, {
        error: route.localOnly ? 'voice_local_only' : 'chat_local_only',
      });
      return;
    }
    if (route.providers) {
      const gate = admitProviderRequest(req, route, env);
      if (!gate.ok) {
        sendJson(res, gate.status, { error: `providers_${gate.code}` });
        return;
      }
    }
    if (route.write && !sameOrigin(req)) {
      sendJson(res, 403, { error: 'cross_origin' });
      return;
    }
    const headers = { host: base.host };
    const forwarded = route.providers
      ? [...FORWARD_REQUEST_HEADERS, SESSION_HEADER]
      : FORWARD_REQUEST_HEADERS;
    for (const name of forwarded) {
      if (typeof req.headers[name] === 'string')
        headers[name] = req.headers[name];
    }
    let body = null;
    if (route.body) {
      const type = String(req.headers['content-type'] || '')
        .split(';', 1)[0]
        .trim()
        .toLowerCase();
      if (!route.body.types.includes(type)) {
        sendJson(res, 415, {
          error: route.body === JSON_BODY ? 'json_only' : 'audio_only',
        });
        return;
      }
      try {
        body = await readBody(req, route.body.limit);
      } catch (failure) {
        const tooLarge = failure.code === 'TOO_LARGE';
        res.setHeader('Connection', 'close');
        sendJson(res, tooLarge ? 413 : 400, {
          error: tooLarge ? 'too_large' : 'bad_body',
        });
        return;
      }
      headers['content-type'] = type;
      headers['content-length'] = String(body.length);
    }
    const streaming = Boolean(route.stream?.test(path));
    const upstream = request({
      hostname: base.hostname.replace(/^\[|\]$/g, ''),
      port: base.port || 80,
      path: `/api/intel${path}`,
      method: req.method,
      headers,
    });
    // The browser left (tab closed, stream closed): stop the upstream too.
    const closeUpstream = () => upstream.destroy();
    res.once('close', closeUpstream);
    if (!streaming) {
      upstream.setTimeout(timeoutMs, () =>
        upstream.destroy(
          Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
        ),
      );
    }
    upstream.on('response', (incoming) => {
      const out = { 'X-Content-Type-Options': 'nosniff' };
      for (const name of FORWARD_RESPONSE_HEADERS) {
        if (incoming.headers[name]) out[name] = incoming.headers[name];
      }
      if (streaming) {
        out['Cache-Control'] = 'no-cache';
        out['X-Accel-Buffering'] = 'no';
      }
      res.writeHead(incoming.statusCode || 502, out);
      if (streaming) res.flushHeaders?.();
      incoming.pipe(res);
    });
    upstream.on('error', (failure) => {
      res.removeListener('close', closeUpstream);
      if (res.destroyed || res.writableEnded) return; // the browser already left
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, 503, {
        state: 'intel_offline',
        error:
          failure.code === 'ECONNREFUSED'
            ? 'connection_refused'
            : failure.code === 'ETIMEDOUT'
              ? 'timeout'
              : 'unavailable',
      });
    });
    upstream.end(body ?? undefined);
  };
}

/** Vite plugin: mount the proxy for the dev and preview servers. */
export function intelProxy(options = {}) {
  const handler = createIntelHandler(options);
  return {
    name: 'spectre-intel',
    configureServer({ middlewares }) {
      middlewares.use('/api/intel', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/intel', handler);
    },
  };
}
