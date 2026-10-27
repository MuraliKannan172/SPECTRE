import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { normalizeNewsPage, normalizeNewsStory } from './records.js';

/**
 * SKYNET: read news from the local intel service through the app's own
 * /api/intel proxy (same origin; the browser never contacts the service).
 */

export const NEWS_RESPONSE_LIMIT = 4 * 1024 * 1024;
export const NEWS_PAGE_SIZE = 200;
export const NEWS_MAX_RECORDS = 600;
export const NEWS_WINDOW_HOURS = Object.freeze([6, 24, 72, 168]);
export const NEWS_DEFAULT_WINDOW_HOURS = 24;

// Data, not UI copy: freshness.js marks them for the catalog and translates
// them when they are shown (this module stays free of i18n).
export const INTEL_OFFLINE =
  'Intel service offline: run scripts\\skynet.ps1 to start it';
export const NEWS_UNAVAILABLE = 'News unavailable';

/** The intel service is not running (the proxy answered intel_offline). */
export class IntelOfflineError extends Error {
  constructor() {
    super(INTEL_OFFLINE);
    this.name = 'IntelOfflineError';
    this.code = 'intel_offline';
  }
}

async function readPage(fetchImpl, url, signal) {
  const response = await fetchImpl(url, {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (response.status === 503) {
    const body = await response.json().catch(() => null);
    if (body?.state === 'intel_offline') throw new IntelOfflineError();
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${NEWS_UNAVAILABLE} (HTTP ${response.status})`);
  }
  const page = normalizeNewsPage(
    await readResponseJsonCapped(response, NEWS_RESPONSE_LIMIT, signal),
  );
  if (!page) throw new Error(NEWS_UNAVAILABLE);
  return page;
}

function clampWindow(hours) {
  return NEWS_WINDOW_HOURS.includes(hours) ? hours : NEWS_DEFAULT_WINDOW_HOURS;
}

/**
 * @param {{fetchImpl?: typeof fetch, baseUrl?: string, now?: () => number}} [options]
 */
export function createIntelNewsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  baseUrl = '/api/intel',
  now = () => Date.now(),
} = {}) {
  const url = (path, params) => {
    const query = new URLSearchParams(
      Object.entries(params).filter(
        ([, value]) => value !== undefined && value !== null && value !== '',
      ),
    );
    return `${baseUrl}${path}${query.size ? `?${query}` : ''}`;
  };

  /** Pages of stories newest first, until `max` records or no next page. */
  async function collect(params, { signal, max = NEWS_MAX_RECORDS } = {}) {
    const records = [];
    let freshness = null;
    let cursor = null;
    do {
      signal?.throwIfAborted();
      const page = await readPage(
        fetchImpl,
        url('/news', {
          ...params,
          limit: Math.min(NEWS_PAGE_SIZE, max - records.length),
          cursor,
        }),
        signal,
      );
      freshness ??= page.freshness;
      records.push(...page.records);
      cursor = page.nextCursor;
    } while (cursor && records.length < max);
    return { records: records.slice(0, max), freshness };
  }

  return {
    /**
     * Stories placed on the globe within the time window, for the layer.
     * @param {{signal?: AbortSignal, windowHours?: number, categories?: string[]}} [options]
     */
    async getSnapshot({ signal, windowHours, categories = [] } = {}) {
      const hours = clampWindow(windowHours);
      return collect(
        {
          located: 'true',
          since: new Date(now() - hours * 3600_000).toISOString(),
          category: categories.length ? categories.join(',') : undefined,
        },
        { signal },
      );
    },

    /** Any stories (placed or not) for the panel's list and filters. */
    async search(
      { q, windowHours, categories = [], region, source } = {},
      { signal, max = NEWS_PAGE_SIZE } = {},
    ) {
      const hours = clampWindow(windowHours);
      return collect(
        {
          q: q?.trim() || undefined,
          since: new Date(now() - hours * 3600_000).toISOString(),
          category: categories.length ? categories.join(',') : undefined,
          region: region || undefined,
          source: source || undefined,
        },
        { signal, max },
      );
    },

    /** One story with all its outlets, or null when it is gone or hidden. */
    async getStory(id, { signal } = {}) {
      if (!Number.isSafeInteger(id) || id < 1) return null;
      const response = await fetchImpl(`${baseUrl}/news/${id}`, {
        signal,
        headers: { Accept: 'application/json' },
      });
      if (response.status === 404) return null;
      if (response.status === 503) throw new IntelOfflineError();
      if (!response.ok) throw new Error(NEWS_UNAVAILABLE);
      return normalizeNewsStory(
        await readResponseJsonCapped(response, NEWS_RESPONSE_LIMIT, signal),
      );
    },

    streamUrl: `${baseUrl}/news/stream`,
  };
}
