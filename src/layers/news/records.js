/**
 * SPECTRE: validate the intel service's news stories before anything renders.
 *
 * The service already cleans what it stores, but the browser treats the API
 * as untrusted: every string is bounded and control-free, every link must be
 * absolute http(s), every number finite and in range. A story that fails is
 * dropped, not repaired. Text is only ever placed with textContent.
 */

export const NEWS_CATEGORIES = Object.freeze([
  'disaster',
  'conflict',
  'cyber',
  'health',
  'space',
  'science',
  'economy',
  'politics',
  'world',
]);
/** The time windows the layer offers, in hours. */
export const NEWS_WINDOW_HOURS = Object.freeze([6, 24, 72, 168]);
export const NEWS_DEFAULT_WINDOW_HOURS = 24;
const CATEGORY_SET = new Set(NEWS_CATEGORIES);
const FRESHNESS_STATES = new Set([
  'live',
  'stale',
  'offline',
  'starting',
  'no_sources',
]);
const MAX_SOURCES = 12;

function text(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed.length > max || /[\u0000-\u001f]/.test(trimmed))
    return null;
  return trimmed;
}

/** An absolute http(s) URL with no credentials, or null. */
export function safeNewsLink(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function time(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function location(value) {
  if (!value || typeof value !== 'object') return null;
  const { lat, lon, confidence } = value;
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180 ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  )
    return null;
  const countryCode =
    typeof value.country_code === 'string' &&
    /^[A-Z]{2}$/.test(value.country_code)
      ? value.country_code
      : null;
  return Object.freeze({
    lat,
    lon,
    placeName: text(value.place_name, 120),
    countryCode,
    confidence,
    onGlobe: value.on_globe === true,
  });
}

function source(value) {
  const url = safeNewsLink(value?.url);
  const name = text(value?.name, 120);
  if (!url || !name) return null;
  const feedId =
    typeof value.feed_id === 'string' && /^[a-z0-9-]{1,64}$/.test(value.feed_id)
      ? value.feed_id
      : null;
  return Object.freeze({
    name,
    url,
    feedId,
    publishedAt: time(value.published_at),
  });
}

/** One API story to a frozen record, or null when any field is invalid. */
export function normalizeNewsStory(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id;
  const title = text(raw.title, 300);
  const url = safeNewsLink(raw.url);
  const publishedAt = time(raw.published_at);
  if (!Number.isSafeInteger(id) || id < 1 || !title || !url || !publishedAt)
    return null;
  const severity = Number.isInteger(raw.severity)
    ? Math.min(4, Math.max(1, raw.severity))
    : 1;
  const sources = (Array.isArray(raw.sources) ? raw.sources : [])
    .slice(0, MAX_SOURCES)
    .map(source)
    .filter(Boolean);
  return Object.freeze({
    id,
    title,
    summary:
      typeof raw.summary === 'string' ? (text(raw.summary, 400) ?? '') : '',
    url,
    publishedAt,
    firstSeenAt: time(raw.first_seen_at) ?? publishedAt,
    category: CATEGORY_SET.has(raw.category) ? raw.category : 'world',
    severity,
    location: location(raw.location),
    sourceCount: Math.max(
      sources.length || 1,
      Number.isSafeInteger(raw.source_count) ? raw.source_count : 1,
    ),
    sources: Object.freeze(sources),
    // GDELT's terms require a citation and link wherever its data is shown.
    viaGdelt: sources.some((entry) => entry.feedId?.startsWith('gdelt-')),
  });
}

/** The API's freshness block, normalized; unknown states read as 'offline'. */
export function normalizeNewsFreshness(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const state = FRESHNESS_STATES.has(raw.state) ? raw.state : 'offline';
  return Object.freeze({
    state,
    stale: raw.stale === true,
    offline: raw.offline === true,
    updatedAt: time(raw.updated_at),
    ageSeconds: Number.isFinite(raw.age_seconds) ? raw.age_seconds : null,
    pollSeconds: Number.isFinite(raw.poll_seconds) ? raw.poll_seconds : null,
  });
}

/** A /api/intel/news page: valid stories, the next cursor, and freshness. */
export function normalizeNewsPage(payload) {
  if (!payload || !Array.isArray(payload.items)) return null;
  const records = [];
  const seen = new Set();
  for (const item of payload.items) {
    const record = normalizeNewsStory(item);
    if (record && !seen.has(record.id)) {
      seen.add(record.id);
      records.push(record);
    }
  }
  return {
    records,
    nextCursor:
      typeof payload.next_cursor === 'string' &&
      /^[A-Za-z0-9_-]{1,400}$/.test(payload.next_cursor)
        ? payload.next_cursor
        : null,
    freshness: normalizeNewsFreshness(payload.freshness),
  };
}
