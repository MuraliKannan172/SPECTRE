/** SKYNET: card model for one selected news story. Pure — no Cesium types. */
import { msg, t, tn } from '../../i18n/index.js';
import { NEWS_ALERT_RING, NEWS_CATEGORY_COLORS } from './style.js';

export const NEWS_OVERLAY_SOURCE_ID = 'news';
const TITLE_MAX = 110;

/** Category names in the UI language (msg marks them for the catalog). */
export const NEWS_CATEGORY_LABELS = Object.freeze({
  disaster: msg('Disaster'),
  conflict: msg('Conflict'),
  cyber: msg('Cybersecurity'),
  health: msg('Health'),
  space: msg('Space'),
  science: msg('Science'),
  economy: msg('Economy'),
  politics: msg('Politics'),
  world: msg('World affairs'),
});

/** The citation GDELT's terms require wherever its data is shown. */
export const GDELT_CITATION = msg(
  'Headlines via the GDELT Project (gdeltproject.org)',
);

/** Compact age, "5m" / "3h" / "2d", reusing the app's translated age forms. */
export function formatNewsAge(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0)
    return t('{count}m', { context: 'age', count: 1 });
  const hours = Math.floor(deltaMs / 3600000);
  if (hours < 1)
    return t('{count}m', {
      context: 'age',
      count: Math.max(1, Math.floor(deltaMs / 60000)),
    });
  if (hours < 24) return t('{count}h', { context: 'age', count: hours });
  return t('{count}d', { context: 'age', count: Math.floor(hours / 24) });
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The outlet a click on the card opens: the story's first listed source. */
export function primaryNewsLink(record) {
  return record?.sources?.[0]?.url ?? record?.url ?? null;
}

/**
 * Overlay-host entry for one selected story (the caller adds `position`).
 * @param {Object} record - A normalized news record (records.js).
 * @param {number} nowMs - Current epoch milliseconds.
 * @param {{canOpen?: boolean}} [options] - Whether a click can open the link.
 */
export function buildNewsCard(
  record,
  nowMs,
  { canOpen = true, colocated = 0 } = {},
) {
  const category = t(
    NEWS_CATEGORY_LABELS[record.category] ?? NEWS_CATEGORY_LABELS.world,
  );
  const where =
    record.location?.placeName || record.location?.countryCode || null;
  const age = formatNewsAge(nowMs - record.publishedAt);
  const details = [
    [where, t('{age} ago', { age })].filter(Boolean).join(' · '),
    [
      category,
      tn(record.sourceCount, '{count} outlet', '{count} outlets', {
        count: record.sourceCount,
      }),
    ].join(' · '),
  ];
  if (colocated > 0)
    details.push(
      tn(
        colocated,
        '{count} more story at this place · see the News panel',
        '{count} more stories at this place · see the News panel',
        { count: colocated },
      ),
    );
  if (record.viaGdelt) details.push(t(GDELT_CITATION));
  const link = canOpen ? primaryNewsLink(record) : null;
  if (link) details.push(t('Click the card to open the article ↗'));
  const headline = clip(record.title, TITLE_MAX);
  const title =
    record.severity === 4 ? t('ALERT · {headline}', { headline }) : headline;
  return {
    id: `news-card:${record.id}`,
    selected: true,
    interactive: Boolean(link),
    ...(link
      ? { accessibilityLabel: t('Open article: {title}', { title: headline }) }
      : undefined),
    title,
    details,
    accent:
      record.severity === 4
        ? NEWS_ALERT_RING
        : NEWS_CATEGORY_COLORS[record.category],
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
