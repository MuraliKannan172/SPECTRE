/** SKYNET: card model and colors for NASA EONET events. Pure — no Cesium. */
import { formatNumber, formatUtcDayMonth, msg, t } from '../../i18n/index.js';

export const EONET_OVERLAY_SOURCE_ID = 'natural-events';
export const EONET_ATTRIBUTION = msg(
  'NASA EONET (Earth Observatory Natural Event Tracker)',
);

/** EONET category ids to a color and a UI label. Unknown ids use "other". */
export const EONET_CATEGORIES = Object.freeze({
  wildfires: Object.freeze({ color: '#F97316', label: msg('Wildfires') }),
  severeStorms: Object.freeze({
    color: '#60A5FA',
    label: msg('Severe storms'),
  }),
  volcanoes: Object.freeze({ color: '#EF4444', label: msg('Volcanoes') }),
  seaLakeIce: Object.freeze({
    color: '#BAE6FD',
    label: msg('Sea and lake ice'),
  }),
  floods: Object.freeze({ color: '#3B82F6', label: msg('Floods') }),
  earthquakes: Object.freeze({ color: '#FBBF24', label: msg('Earthquakes') }),
  landslides: Object.freeze({ color: '#A16207', label: msg('Landslides') }),
  drought: Object.freeze({ color: '#D97706', label: msg('Drought') }),
  dustHaze: Object.freeze({ color: '#D6D3D1', label: msg('Dust and haze') }),
  snow: Object.freeze({ color: '#F8FAFC', label: msg('Heavy snow') }),
  tempExtremes: Object.freeze({
    color: '#F472B6',
    label: msg('Temperature extremes'),
  }),
  waterColor: Object.freeze({ color: '#2DD4BF', label: msg('Water color') }),
  manmade: Object.freeze({ color: '#A78BFA', label: msg('Manmade') }),
  other: Object.freeze({ color: '#E5E7EB', label: msg('Other') }),
});

export function eonetCategory(id) {
  return EONET_CATEGORIES[id] ?? EONET_CATEGORIES.other;
}

/** The link a click on the card opens: the first source EONET lists. */
export function eonetPrimaryLink(record) {
  return record?.sources?.[0]?.url ?? null;
}

/** Overlay-host entry for one selected event (the caller adds `position`). */
export function buildEonetCard(record, { canOpen = true } = {}) {
  const category = eonetCategory(record.categoryId);
  const details = [
    t('{category} · observed {date}', {
      category: t(category.label),
      date: formatUtcDayMonth(new Date(record.observedAt).toISOString()),
    }),
  ];
  if (record.magnitude)
    details.push(
      `${formatNumber(Math.round(record.magnitude.value * 10) / 10)} ${record.magnitude.unit}`,
    );
  details.push(t(EONET_ATTRIBUTION));
  const link = canOpen ? eonetPrimaryLink(record) : null;
  if (link)
    details.push(
      t('Source: {source} ↗ · click card to open', {
        source: record.sources[0].id,
      }),
    );
  return {
    id: `eonet-card:${record.id}`,
    selected: true,
    interactive: Boolean(link),
    ...(link
      ? {
          accessibilityLabel: t('Open the source for {title}', {
            title: record.title,
          }),
        }
      : undefined),
    title: record.title,
    details,
    accent: category.color,
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
