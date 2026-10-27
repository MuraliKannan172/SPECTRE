import { readResponseJsonCapped } from '../../sources/httpBody.js';

/**
 * SKYNET: NASA EONET natural events through the app's /api/eonet proxy. The
 * proxy has already reduced each event to one point; this side re-validates
 * every field because the browser renders them.
 */

export const EONET_RESPONSE_LIMIT = 4 * 1024 * 1024;
// Data, not UI copy: the layer translates it when shown.
export const EONET_UNAVAILABLE = 'Natural events unavailable';

function text(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max && !/[\u0000-\u001f<>]/.test(trimmed)
    ? trimmed
    : null;
}

function link(value) {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** One proxy event to a frozen record, or null. */
export function normalizeEonetEvent(raw) {
  const id =
    typeof raw?.id === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(raw.id)
      ? raw.id
      : null;
  const title = text(raw?.title, 200);
  const categoryId =
    typeof raw?.category?.id === 'string' &&
    /^[A-Za-z]{1,32}$/.test(raw.category.id)
      ? raw.category.id
      : null;
  const { lat, lon } = raw ?? {};
  const observedAt = Date.parse(raw?.observedAt);
  if (
    !id ||
    !title ||
    !categoryId ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180 ||
    !Number.isFinite(observedAt)
  )
    return null;
  const magnitude =
    Number.isFinite(raw.magnitude?.value) && text(raw.magnitude?.unit, 24)
      ? Object.freeze({ value: raw.magnitude.value, unit: raw.magnitude.unit })
      : null;
  return Object.freeze({
    id,
    title,
    categoryId,
    categoryTitle: text(raw.category.title, 60) ?? categoryId,
    lat,
    lon,
    observedAt,
    magnitude,
    sources: Object.freeze(
      (Array.isArray(raw.sources) ? raw.sources : [])
        .map((source) => ({
          id: text(source?.id, 64) ?? 'source',
          url: link(source?.url),
        }))
        .filter((source) => source.url)
        .slice(0, 8),
    ),
  });
}

export function createEonetSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  url = '/api/eonet',
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(url, {
        signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(EONET_UNAVAILABLE);
      const payload = await readResponseJsonCapped(
        response,
        EONET_RESPONSE_LIMIT,
        signal,
      );
      if (!payload || !Array.isArray(payload.events))
        throw new Error(EONET_UNAVAILABLE);
      return {
        events: payload.events.map(normalizeEonetEvent).filter(Boolean),
        stale: payload.stale === true,
        unavailable: payload.unavailable === true,
        reason: typeof payload.reason === 'string' ? payload.reason : null,
        fetchedAt: Date.parse(payload.fetchedAt) || null,
      };
    },
  };
}
