import http from 'node:http';

/**
 * SKYNET: same-origin proxy from /api/intel/* to the local intel service
 * (intel/, FastAPI on 127.0.0.1:8100). The browser never talks to the service
 * directly, so the app's CSP stays same-origin.
 *
 * - Read-only: GET and HEAD on the news, story, stream and health routes.
 * - The target is loopback only. SKYNET_INTEL_URL may move the port, never
 *   the host off this machine.
 * - Host is set to the target's, which the service's DNS-rebinding allowlist
 *   accepts; only Accept and Last-Event-ID are forwarded, never cookies or
 *   credentials.
 * - The SSE stream is piped unbuffered, and closing the browser's request
 *   closes the upstream one.
 * - When the service is not running, the answer is 503
 *   {"state":"intel_offline"}, and the rest of the app is unaffected.
 */

const DEFAULT_TARGET = 'http://127.0.0.1:8100';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const ROUTE = /^\/(?:news(?:\/stream|\/\d{1,12})?|health)(?:\?|$)/;
const FORWARD_REQUEST_HEADERS = ['accept', 'last-event-id'];
const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'retry-after',
];
const REQUEST_TIMEOUT_MS = 15_000;

/** The service base URL: SKYNET_INTEL_URL when it is http on loopback. */
export function intelTarget(env = process.env) {
  const raw = String(env.SKYNET_INTEL_URL || '').trim();
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
    '[intel proxy] SKYNET_INTEL_URL must be http:// on 127.0.0.1 or localhost; using the default',
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

/**
 * @param {{target?: string, request?: typeof http.request, timeoutMs?: number}} [options]
 * @returns {(req: http.IncomingMessage, res: http.ServerResponse) => void}
 */
export function createIntelHandler({
  target = intelTarget(),
  request = http.request,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const base = new URL(target);
  return function intelHandler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    const path = req.url || '/';
    if (!ROUTE.test(path)) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    const streaming = path.startsWith('/news/stream');
    const headers = { host: base.host };
    for (const name of FORWARD_REQUEST_HEADERS) {
      if (typeof req.headers[name] === 'string')
        headers[name] = req.headers[name];
    }
    const upstream = request({
      hostname: base.hostname.replace(/^\[|\]$/g, ''),
      port: base.port || 80,
      path: `/api/intel${path}`,
      method: req.method,
      headers,
    });
    // The browser left (tab closed, EventSource closed): stop the upstream too.
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
    upstream.on('error', (error) => {
      res.removeListener('close', closeUpstream);
      if (res.destroyed || res.writableEnded) return; // the browser already left
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, 503, {
        state: 'intel_offline',
        error:
          error.code === 'ECONNREFUSED'
            ? 'connection_refused'
            : error.code === 'ETIMEDOUT'
              ? 'timeout'
              : 'unavailable',
      });
    });
    upstream.end();
  };
}

/** Vite plugin: mount the proxy for the dev and preview servers. */
export function intelProxy(options = {}) {
  const handler = createIntelHandler(options);
  return {
    name: 'skynet-intel',
    configureServer({ middlewares }) {
      middlewares.use('/api/intel', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/intel', handler);
    },
  };
}
