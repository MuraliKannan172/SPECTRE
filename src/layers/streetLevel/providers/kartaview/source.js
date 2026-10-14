import {
  IMAGE_PROBE_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  KARTAVIEW_API_HOST,
  NEAREST_LIMIT,
  NEAREST_SEARCH_ZOOM,
  PAGE_CONCURRENCY,
  PAGE_TIMEOUT_MS,
  PHOTO_API_CONCURRENCY,
  PHOTO_API_RETRIES,
  PHOTO_API_RETRY_BASE_MS,
  PHOTO_API_RETRY_MAX_MS,
  PHOTO_API_FIRST_TIMEOUT_MS,
  PHOTO_API_TIMEOUT_MS,
  TILE_CONCURRENCY,
  TILE_TIMEOUT_MS,
} from './policy.js';
import { createLimiter } from '../../limiter.js';

export { createLimiter } from '../../limiter.js';

/** An HTTP or API failure; `retryAfterSec` is set while KartaView rate-limits. */
export class KartaViewSourceError extends Error {
  constructor(message, { status = 0, retryAfterSec = null } = {}) {
    super(message);
    this.name = 'KartaViewSourceError';
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

const NO_ANSWER = 'KartaView did not answer in time — try again';
/** Statuses that mean a photo file is gone, not that storage hiccupped. */
const GONE_STATUSES = Object.freeze([403, 404, 409, 410]);

/** Resolves after `ms`, or rejects when `signal` aborts first. */
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
  });
}

/** Seconds from a Retry-After header, or null. */
function retryAfterSeconds(response) {
  const header = response.headers?.get?.('retry-after');
  const value = header == null || header === '' ? NaN : Number(header);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * KartaView's public API, browser-side and keyless (it allows any origin).
 * It speaks HTTP/1.1, so the browser opens six connections to it: tiles take
 * at most three, photo lookups two and sequence pages one, so a lookup never
 * waits behind slow tiles or pages. The photo API answers 429 to more than
 * about three requests at once; a 429 (and a lookup that timed out) is
 * retried.
 * @param {{fetchImpl?: typeof fetch, apiHost?: string, retryBaseMs?: number}} [options]
 */
export function createKartaViewSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  apiHost = KARTAVIEW_API_HOST,
  retryBaseMs = PHOTO_API_RETRY_BASE_MS,
} = {}) {
  const limiter = createLimiter(PHOTO_API_CONCURRENCY);
  const tileLimiter = createLimiter(TILE_CONCURRENCY);
  const pageLimiter = createLimiter(PAGE_CONCURRENCY, { lifo: true });

  /** GET JSON within `timeoutMs`; the caller's abort wins over the timeout. */
  async function getJson(url, { signal, timeoutMs }) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    if (signal?.aborted) throw signal.reason;
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new KartaViewSourceError(NO_ANSWER)),
      timeoutMs,
    );
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (response.status === 429)
        throw new KartaViewSourceError('KartaView is rate-limiting requests', {
          status: 429,
          retryAfterSec: retryAfterSeconds(response) ?? 2,
        });
      if (!response.ok)
        throw new KartaViewSourceError(
          `KartaView answered HTTP ${response.status}`,
          { status: response.status },
        );
      const length = Number(response.headers?.get?.('content-length'));
      const tooMuch = () =>
        new KartaViewSourceError('KartaView sent too much data', {
          status: response.status,
        });
      if (length > MAX_RESPONSE_BYTES) throw tooMuch();
      // KartaView answers chunked, without a length: count while reading.
      const reader = response.body?.getReader?.();
      if (!reader) return await response.json();
      const chunks = [];
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          reader.cancel().catch(() => {});
          throw tooMuch();
        }
        chunks.push(value);
      }
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(new TextDecoder().decode(body));
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof KartaViewSourceError) throw error;
      throw new KartaViewSourceError(NO_ANSWER);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * A photo-API call through `gate`, retrying 429s with backoff and, once, a
   * call that timed out.
   */
  async function photoApi(
    path,
    params,
    { signal } = {},
    {
      gate = limiter,
      timeoutMs = PHOTO_API_TIMEOUT_MS,
      firstTimeoutMs = PHOTO_API_FIRST_TIMEOUT_MS,
    } = {},
  ) {
    const query = params ? `?${new URLSearchParams(params)}` : '';
    const url = `${apiHost}${path}${query}`;
    let timeouts = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        const payload = await gate.run(
          // A slow first answer is usually quick when asked again.
          () =>
            getJson(url, {
              signal,
              timeoutMs: timeouts === 0 ? firstTimeoutMs : timeoutMs,
            }),
          { signal },
        );
        const code = Number(payload?.status?.apiCode);
        // 600 ok, 601 empty, 602 partial: anything else is a refusal.
        if (Number.isFinite(code) && (code < 600 || code > 603))
          throw new KartaViewSourceError(
            `KartaView refused the request (code ${code})`,
            { status: Number(payload?.status?.httpCode) || 0 },
          );
        return payload?.result ?? {};
      } catch (error) {
        if (signal?.aborted) throw error;
        const timedOut = error?.message === NO_ANSWER && error.status === 0;
        if (timedOut && timeouts++ < 1) continue;
        if (error?.status !== 429 || attempt >= PHOTO_API_RETRIES) {
          if (error?.status === 429)
            throw new KartaViewSourceError(
              'KartaView is rate-limiting requests — try again in a moment',
              { status: 429, retryAfterSec: error.retryAfterSec },
            );
          throw error;
        }
        await wait(
          Math.min(
            PHOTO_API_RETRY_MAX_MS,
            Math.max(
              retryBaseMs * 2 ** attempt,
              (error.retryAfterSec ?? 0) * 1000,
            ),
          ),
          signal,
        );
      }
    }
  }

  return {
    /** A coverage tile: `{lines: [{track: [{lat, lng}]}]}`. */
    async getTile({ x, y, z }, { signal } = {}) {
      const url = `${apiHost}/2.0/sequence/tiles/${x}/${y}/${z}.json`;
      const once = () =>
        tileLimiter.run(
          () => getJson(url, { signal, timeoutMs: TILE_TIMEOUT_MS }),
          { signal },
        );
      try {
        return await once();
      } catch (error) {
        // A cold dense tile can outlast the timeout; KartaView has it ready
        // by the second ask.
        if (signal?.aborted || error?.message !== NO_ANSWER) throw error;
        return once();
      }
    },

    /**
     * Whether a photo file is there: true, false when it is gone (archived
     * photos answer 409, and a HEAD says 200 regardless), or null when the
     * storage did not say (timeout, network, 5xx). It GETs and stops at the
     * headers.
     */
    async probeImage(url, { signal } = {}) {
      if (!url) return false;
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal.reason);
      if (signal?.aborted) throw signal.reason;
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(
        () => controller.abort(),
        IMAGE_PROBE_TIMEOUT_MS,
      );
      try {
        const response = await fetchImpl(url, { signal: controller.signal });
        if (response.ok) return true;
        return GONE_STATUSES.includes(response.status) ? false : null;
      } catch {
        if (signal?.aborted) throw signal.reason;
        return null;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        // The body is not needed: drop it.
        controller.abort();
      }
    },

    /** Photo records around a point, nearest first. */
    async nearestPhotos({ lat, lon }, { signal } = {}) {
      const result = await photoApi(
        '/2.0/photo/',
        {
          lat: lat.toFixed(7),
          lng: lon.toFixed(7),
          zoomLevel: String(NEAREST_SEARCH_ZOOM),
          itemsPerPage: String(NEAREST_LIMIT),
        },
        { signal },
      );
      return Array.isArray(result.data) ? result.data : [];
    },

    /** One photo record. */
    async getPhoto(photoId, { signal } = {}) {
      const result = await photoApi(
        `/2.0/photo/${encodeURIComponent(photoId)}`,
        null,
        { signal },
      );
      if (!result.data || typeof result.data !== 'object')
        throw new KartaViewSourceError('KartaView has no such photo');
      return result.data;
    },

    /** A page of a sequence's photos in capture order (1-based `page`). */
    async getSequencePhotos(
      sequenceId,
      { page, itemsPerPage },
      { signal } = {},
    ) {
      const result = await photoApi(
        `/2.0/sequence/${encodeURIComponent(sequenceId)}/photos`,
        { page: String(page), itemsPerPage: String(itemsPerPage) },
        { signal },
        {
          gate: pageLimiter,
          timeoutMs: PAGE_TIMEOUT_MS,
          firstTimeoutMs: PAGE_TIMEOUT_MS,
        },
      );
      return {
        photos: Array.isArray(result.data) ? result.data : [],
        hasMore: result.hasMoreData === true,
      };
    },
  };
}
