import { createLimiter } from '../../limiter.js';
import {
  API_CONCURRENCY,
  API_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  NEAREST_FOV_TOLERANCE_DEG,
  NEAREST_LIMIT,
  NEAREST_RADIUS_M,
  PANORAMAX_API,
  TILE_CONCURRENCY,
  TILE_TIMEOUT_MS,
} from './policy.js';

/** An HTTP or API failure; `retryAfterSec` is set while Panoramax is busy. */
export class PanoramaxSourceError extends Error {
  constructor(message, { status = 0, retryAfterSec = null } = {}) {
    super(message);
    this.name = 'PanoramaxSourceError';
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

const NO_ANSWER = 'Panoramax did not answer in time — try again';

/** Seconds from a Retry-After header, or null. */
function retryAfterSeconds(response) {
  const header = response.headers?.get?.('retry-after');
  const value = header == null || header === '' ? NaN : Number(header);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** The body as bytes, refusing more than MAX_RESPONSE_BYTES whatever the headers say. */
async function readBounded(response) {
  const tooMuch = () =>
    new PanoramaxSourceError('Panoramax sent too much data', {
      status: response.status,
    });
  const length = Number(response.headers?.get?.('content-length'));
  if (length > MAX_RESPONSE_BYTES) throw tooMuch();
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw tooMuch();
    return bytes;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      reader.cancel().catch(() => {});
      throw tooMuch();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Every network path the Panoramax provider uses, browser-side and keyless:
 * the meta-catalogue allows any origin. Vector tiles for coverage and
 * cones, STAC search for single pictures and nearest ones.
 * @param {{fetchImpl?: typeof fetch, api?: string}} [options]
 */
export function createPanoramaxSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  api = PANORAMAX_API,
} = {}) {
  const root = api.replace(/\/+$/, '');
  const apiLimiter = createLimiter(API_CONCURRENCY, { lifo: true });
  const tileLimiter = createLimiter(TILE_CONCURRENCY);

  /** GET within `timeoutMs`; the caller's abort wins over the timeout. */
  async function get(url, { signal, timeoutMs, empty = [] }) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    if (signal?.aborted) throw signal.reason;
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new PanoramaxSourceError(NO_ANSWER)),
      timeoutMs,
    );
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (empty.includes(response.status)) return null;
      if (response.status === 429 || response.status === 503)
        throw new PanoramaxSourceError('Panoramax is busy', {
          status: response.status,
          retryAfterSec: retryAfterSeconds(response) ?? 5,
        });
      if (!response.ok)
        throw new PanoramaxSourceError(
          `Panoramax answered HTTP ${response.status}`,
          { status: response.status },
        );
      return await readBounded(response);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof PanoramaxSourceError) throw error;
      throw new PanoramaxSourceError(NO_ANSWER);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** A STAC search, through the API gate (newest request first). */
  async function search(params, { signal } = {}) {
    const url = `${root}/search?${new URLSearchParams(params)}`;
    const bytes = await apiLimiter.run(
      () => get(url, { signal, timeoutMs: API_TIMEOUT_MS }),
      { signal },
    );
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new PanoramaxSourceError('Panoramax sent an unreadable answer');
    }
    return Array.isArray(payload?.features) ? payload.features : [];
  }

  return {
    api: root,

    /** Raw vector-tile bytes; an empty array where there is no coverage. */
    async getTile({ x, y, z }, { signal } = {}) {
      const url = `${root}/map/${z}/${x}/${y}.mvt`;
      const bytes = await tileLimiter.run(
        () =>
          get(url, { signal, timeoutMs: TILE_TIMEOUT_MS, empty: [204, 404] }),
        { signal },
      );
      return bytes ?? new Uint8Array(0);
    },

    /** One picture (a STAC item) by id, or null. */
    async getItem(id, { signal } = {}) {
      const [item] = await search({ ids: String(id), limit: '1' }, { signal });
      return item && String(item.id) === String(id) ? item : null;
    },

    /**
     * Pictures within `radius` metres of a point, nearest first, whichever
     * way they look; `collections` keeps one sequence's, `pano` and
     * `sinceMs` filter as the imagery filter does.
     */
    async nearestItems(
      {
        lat,
        lon,
        radius = NEAREST_RADIUS_M,
        limit = NEAREST_LIMIT,
        collections = null,
        pano = 'all',
        sinceMs = null,
      },
      { signal } = {},
    ) {
      const params = {
        place_position: `${Number(lon).toFixed(7)},${Number(lat).toFixed(7)}`,
        place_distance: `0-${Math.min(1000, Math.max(1, Math.round(radius)))}`,
        place_fov_tolerance: String(NEAREST_FOV_TOLERANCE_DEG),
        limit: String(Math.min(100, Math.max(1, limit))),
      };
      if (collections) params.collections = String(collections);
      if (pano === 'pano') params.filter = 'field_of_view=360';
      else if (pano === 'flat') params.filter = 'field_of_view<360';
      if (Number.isFinite(sinceMs) && sinceMs > 0)
        params.datetime = `${new Date(sinceMs).toISOString()}/..`;
      return search(params, { signal });
    },
  };
}
