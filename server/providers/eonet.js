import { readResponseTextCapped } from './common/http.js';
import { brandUserAgent } from '../../src/branding.js';

/**
 * SKYNET: NASA EONET v3 natural events (open events from the last 30 days).
 *
 * EONET is a NASA service; its event metadata is public domain. Each event
 * is reduced to one point (its latest geometry; a polygon's centroid), a
 * category, the latest observation time and magnitude, and the source links
 * EONET lists. Strings are validated and only http(s) links are kept, because
 * the browser renders them.
 */

const EVENTS_URL =
  'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30';
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 1000;
const CACHE_MS = 10 * 60_000;
const RETRY_MS = 60_000;
const STALE_LIMIT_MS = 24 * 3600_000;
// Data, not UI copy: src/layers/eonet/ translates these when shown.
const UNAVAILABLE = 'Natural events unavailable';
const STALE = 'Cached natural events; EONET unavailable';

function cleanText(value, max = 200) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > max || /[\u0000-\u001f<>]/.test(text)) return null;
  return text;
}

function cleanId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value)
    ? value
    : null;
}

function httpLink(value) {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function finitePoint(lon, lat) {
  return Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
    ? { lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4 }
    : null;
}

/** A geometry's representative point: the point itself, or the outer ring's centroid. */
export function eonetGeometryPoint(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;
  const coordinates = geometry.coordinates;
  if (geometry.type === 'Point' && Array.isArray(coordinates)) {
    return finitePoint(Number(coordinates[0]), Number(coordinates[1]));
  }
  if (geometry.type === 'Polygon' && Array.isArray(coordinates?.[0])) {
    const ring = coordinates[0].filter(
      (pair) => Array.isArray(pair) && pair.length >= 2,
    );
    if (ring.length < 3) return null;
    let lon = 0;
    let lat = 0;
    for (const [x, y] of ring) {
      lon += Number(x);
      lat += Number(y);
    }
    return finitePoint(lon / ring.length, lat / ring.length);
  }
  return null;
}

/** EONET v3 /events JSON to the layer's records. Invalid events are skipped. */
export function parseEonetEvents(payload) {
  if (!payload || !Array.isArray(payload.events)) {
    throw new Error('invalid_eonet_payload');
  }
  const events = [];
  for (const raw of payload.events) {
    if (events.length >= MAX_EVENTS) break;
    const id = cleanId(raw?.id);
    const title = cleanText(raw?.title);
    const category = raw?.categories?.[0];
    const categoryId = cleanId(category?.id);
    if (!id || !title || !categoryId || !Array.isArray(raw.geometry)) continue;
    // EONET lists observations oldest first; use the newest one with a valid point.
    let latest = null;
    for (const geometry of raw.geometry) {
      const point = eonetGeometryPoint(geometry);
      const time = Date.parse(geometry?.date);
      if (!point || !Number.isFinite(time)) continue;
      if (!latest || time >= latest.time) latest = { point, time, geometry };
    }
    if (!latest) continue;
    const value = Number(latest.geometry.magnitudeValue);
    const unit = cleanText(latest.geometry.magnitudeUnit, 24);
    events.push({
      id,
      title,
      category: {
        id: categoryId,
        title: cleanText(category.title, 60) ?? categoryId,
      },
      ...latest.point,
      observedAt: new Date(latest.time).toISOString(),
      observations: raw.geometry.length,
      magnitude: Number.isFinite(value) && unit ? { value, unit } : null,
      sources: (Array.isArray(raw.sources) ? raw.sources : [])
        .map((source) => ({
          id: cleanId(source?.id) ?? 'source',
          url: httpLink(source?.url),
        }))
        .filter((source) => source.url)
        .slice(0, 8),
      link: httpLink(raw.link),
    });
  }
  return events;
}

export function eonetProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = 15_000,
} = {}) {
  let cache = null;
  let inFlight = null;
  let attemptedAt = -Infinity;

  async function refresh() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(EVENTS_URL, {
        signal: controller.signal,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'User-Agent': brandUserAgent('eonet', 'NASA EONET natural events'),
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`eonet_http_${response.status}`);
      }
      const text = await readResponseTextCapped(
        response,
        MAX_BYTES,
        controller.signal,
      );
      cache = { events: parseEonetEvents(JSON.parse(text)), fetchedAt: now() };
      return cache;
    } finally {
      clearTimeout(timer);
    }
  }

  async function acquire() {
    if (cache && now() - cache.fetchedAt < CACHE_MS) return cache;
    if (!inFlight) {
      if (now() - attemptedAt < RETRY_MS) throw new Error('eonet_retry_later');
      attemptedAt = now();
      inFlight = refresh().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  function describe(value, stale) {
    return {
      schemaVersion: 1,
      source: 'NASA EONET',
      attribution: 'NASA Earth Observatory Natural Event Tracker (EONET)',
      fetchedAt: value ? new Date(value.fetchedAt).toISOString() : null,
      stale: stale || !value,
      unavailable: !value,
      reason: !value ? UNAVAILABLE : stale ? STALE : null,
      events: value?.events ?? [],
    };
  }

  async function handler(req, res) {
    const json = (status, value) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    if (req.url !== '/' && req.url !== '') {
      return json(400, { error: 'invalid_eonet_query' });
    }
    try {
      json(200, describe(await acquire(), false));
    } catch {
      const usable = cache && now() - cache.fetchedAt <= STALE_LIMIT_MS;
      json(200, describe(usable ? cache : null, true));
    }
  }

  return {
    name: 'skynet-eonet',
    configureServer({ middlewares }) {
      middlewares.use('/api/eonet', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/eonet', handler);
    },
  };
}
