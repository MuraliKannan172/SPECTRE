/**
 * SPECTRE: how a news story looks on the globe. Pure numbers and CSS colors,
 * so it is testable without Cesium.
 *
 * - Color names the category. No category uses the brand red: red is kept
 *   for true alerts (severity 4), which also get a ring, so severity never
 *   rests on hue alone.
 * - Size grows with the number of outlets reporting the story.
 * - Opacity fades with age across the chosen time window.
 */

export const NEWS_CATEGORY_COLORS = Object.freeze({
  disaster: '#F59E0B',
  conflict: '#F472B6',
  cyber: '#22D3EE',
  health: '#4ADE80',
  space: '#A78BFA',
  science: '#FDE68A',
  economy: '#A3E635',
  politics: '#60A5FA',
  world: '#E5E7EB',
});
export const NEWS_ALERT_RING = '#F80000'; // BRANDING.colors.accent (was '#FF2800')
export const NEWS_CLUSTER_COLOR = '#E5E7EB';

const BASE_PIXELS = 8;
const PER_EXTRA_SOURCE = 2;
const MAX_EXTRA_SOURCES = 4;
const MIN_OPACITY = 0.35;
const FRESH_MS = 3600_000;

/** Marker diameter in pixels: 8 for one outlet, up to 16 for five or more. */
export function newsMarkerSize(record) {
  const extra = Math.min(
    MAX_EXTRA_SOURCES,
    Math.max(0, (record?.sourceCount || 1) - 1),
  );
  return BASE_PIXELS + PER_EXTRA_SOURCE * extra;
}

/** 1 for the last hour, falling linearly to 0.35 at the end of the window. */
export function newsMarkerOpacity(record, now, windowHours) {
  const age = Math.max(0, now - (record?.publishedAt ?? now));
  const span = Math.max(FRESH_MS, windowHours * 3600_000);
  if (age <= FRESH_MS) return 1;
  const fraction = Math.min(1, (age - FRESH_MS) / (span - FRESH_MS || 1));
  return Math.round((1 - fraction * (1 - MIN_OPACITY)) * 100) / 100;
}

/** Everything the renderer needs for one marker. */
export function newsMarkerStyle(record, now, windowHours) {
  const alert = record?.severity === 4;
  return Object.freeze({
    color: NEWS_CATEGORY_COLORS[record?.category] ?? NEWS_CATEGORY_COLORS.world,
    opacity: newsMarkerOpacity(record, now, windowHours),
    pixelSize: newsMarkerSize(record),
    outlineColor: alert ? NEWS_ALERT_RING : '#000000',
    outlineWidth: alert ? 3 : 1,
    alert,
  });
}

/** Cluster marker size from how many stories it stands for. */
export function newsClusterSize(count) {
  return Math.min(34, 14 + Math.round(Math.log2(Math.max(1, count)) * 4));
}
