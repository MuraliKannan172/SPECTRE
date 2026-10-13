import {
  KARTAVIEW_API_HOST,
  NEAREST_LIMIT,
  NEAREST_SEARCH_ZOOM,
  PHOTO_API_CONCURRENCY,
  PHOTO_API_RETRIES,
  PHOTO_API_RETRY_BASE_MS,
  PHOTO_API_TIMEOUT_MS,
  TILE_TIMEOUT_MS,
} from './policy.js';

/** An HTTP or API failure; `retryAfterSec` is set while KartaView rate-limits. */
export class KartaViewSourceError extends Error {
  constructor(message, { status = 0, retryAfterSec = null } = {}) {
    super(message);
    this.name = 'KartaViewSourceError';
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

const NO_ANSWER = 'KartaView did not answer — check the network and try again';

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

/** A first-in, first-out gate letting at most `limit` tasks run at once. */
export function createLimiter(limit) {
  let running = 0;
  const queue = [];
  function next() {
    while (running < limit && queue.length) {
      const { task, resolve, reject, signal } = queue.shift();
      if (signal?.aborted) {
        reject(signal.reason);
        continue;
      }
      running++;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          running--;
          next();
        });
    }
  }
  return {
    run(task, { signal } = {}) {
      return new Promise((resolve, reject) => {
        const item = { task, resolve, reject, signal };
        queue.push(item);
        signal?.addEventListener(
          'abort',
          () => {
            const at = queue.indexOf(item);
            if (at === -1) return;
            queue.splice(at, 1);
            reject(signal.reason);
          },
          { once: true },
        );
        next();
      });
    },
    get pending() {
      return running + queue.length;
    },
  };
}

/**
 * KartaView's public API, browser-side and keyless (it allows any origin).
 * Coverage tiles are not rate-limited; photo lookups are, so they queue two
 * at a time and retry a 429.
 * @param {{fetchImpl?: typeof fetch, apiHost?: string, retryBaseMs?: number}} [options]
 */
export function createKartaViewSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  apiHost = KARTAVIEW_API_HOST,
  retryBaseMs = PHOTO_API_RETRY_BASE_MS,
} = {}) {
  const limiter = createLimiter(PHOTO_API_CONCURRENCY);

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
      return await response.json();
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

  /** A photo-API call through the limiter, retrying 429s with backoff. */
  async function photoApi(path, params, { signal } = {}) {
    const query = params ? `?${new URLSearchParams(params)}` : '';
    const url = `${apiHost}${path}${query}`;
    for (let attempt = 0; ; attempt++) {
      try {
        const payload = await limiter.run(
          () => getJson(url, { signal, timeoutMs: PHOTO_API_TIMEOUT_MS }),
          { signal },
        );
        const code = Number(payload?.status?.apiCode);
        // 600 ok, 601 empty, 602 partial: anything else is a refusal.
        if (Number.isFinite(code) && (code < 600 || code > 603))
          throw new KartaViewSourceError(
            String(
              payload?.status?.apiMessage || 'KartaView refused the request',
            ).trim(),
            { status: Number(payload?.status?.httpCode) || 0 },
          );
        return payload?.result ?? {};
      } catch (error) {
        if (error?.status !== 429 || attempt >= PHOTO_API_RETRIES) throw error;
        await wait(
          Math.max(
            retryBaseMs * 2 ** attempt,
            (error.retryAfterSec ?? 0) * 1000,
          ),
          signal,
        );
      }
    }
  }

  return {
    /** A coverage tile: `{lines: [{track: [{lat, lng}]}]}`. */
    async getTile({ x, y, z }, { signal } = {}) {
      return getJson(`${apiHost}/2.0/sequence/tiles/${x}/${y}/${z}.json`, {
        signal,
        timeoutMs: TILE_TIMEOUT_MS,
      });
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
      );
      return {
        photos: Array.isArray(result.data) ? result.data : [],
        hasMore: result.hasMoreData === true,
      };
    },
  };
}
