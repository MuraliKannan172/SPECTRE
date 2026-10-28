/**
 * SPECTRE: what the News drawer and ticker show, as plain data. Pure — no DOM
 * and no Cesium — so it is tested in Node; panel.js only renders it.
 */
import { msg, t, tn } from '../../i18n/index.js';
import {
  GDELT_CITATION,
  NEWS_CATEGORY_LABELS,
  formatNewsAge,
} from './cards.js';
import { NEWS_CATEGORIES } from './records.js';
import { NEWS_WINDOW_HOURS } from './source.js';
import { NEWS_CATEGORY_COLORS } from './style.js';

export const GDELT_HOME = 'https://www.gdeltproject.org/';
export const NEWS_REGIONS = Object.freeze([
  'world',
  'africa',
  'americas',
  'asia-pacific',
  'europe',
  'middle-east',
]);
export const NEWS_REGION_LABELS = Object.freeze({
  world: msg('Global feeds'),
  africa: msg('Africa'),
  americas: msg('Americas'),
  'asia-pacific': msg('Asia-Pacific'),
  europe: msg('Europe'),
  'middle-east': msg('Middle East'),
});
export const NEWS_WINDOW_LABELS = Object.freeze({
  6: msg('Last 6 hours'),
  24: msg('Last 24 hours'),
  72: msg('Last 3 days'),
  168: msg('Last 7 days'),
});
const TICKER_SIZE = 10;

/** Select options for the drawer's filters, translated. */
export function newsFilterOptions() {
  return {
    windows: NEWS_WINDOW_HOURS.map((hours) => ({
      value: String(hours),
      label: t(NEWS_WINDOW_LABELS[hours]),
    })),
    categories: [
      { value: '', label: t('All categories') },
      ...NEWS_CATEGORIES.map((category) => ({
        value: category,
        label: t(NEWS_CATEGORY_LABELS[category]),
      })),
    ],
    regions: [
      { value: '', label: t('All regions') },
      ...NEWS_REGIONS.map((region) => ({
        value: region,
        label: t(NEWS_REGION_LABELS[region]),
      })),
    ],
  };
}

/** Distinct outlet names in the results, for the source filter. */
export function newsSourceOptions(records, selected = '') {
  const names = new Set();
  for (const record of records) {
    for (const source of record.sources) names.add(source.name);
  }
  if (selected) names.add(selected);
  return [
    { value: '', label: t('All sources') },
    ...[...names]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ value: name, label: name })),
  ];
}

/** One drawer row per story: headline, place, age, outlets and links. */
export function newsDrawerItems(records, { now, selectedId = null } = {}) {
  return records.map((record) => ({
    id: record.id,
    title: record.title,
    summary: record.summary,
    color: NEWS_CATEGORY_COLORS[record.category] ?? NEWS_CATEGORY_COLORS.world,
    category: t(
      NEWS_CATEGORY_LABELS[record.category] ?? NEWS_CATEGORY_LABELS.world,
    ),
    alert: record.severity === 4,
    meta: [
      t('{age} ago', { age: formatNewsAge(now - record.publishedAt) }),
      record.location?.placeName || record.location?.countryCode || null,
      tn(record.sourceCount, '{count} outlet', '{count} outlets', {
        count: record.sourceCount,
      }),
    ]
      .filter(Boolean)
      .join(' · '),
    located: Boolean(record.location?.onGlobe),
    outlets: (record.sources.length
      ? record.sources
      : [{ name: t('Article'), url: record.url }]
    ).map((source) => ({ name: source.name, url: source.url })),
    gdelt: record.viaGdelt,
    selected: record.id === selectedId,
  }));
}

/** The ticker's rotation: the newest stories, headline and age. */
export function newsTickerEntries(records, { now } = {}) {
  return records.slice(0, TICKER_SIZE).map((record) => ({
    id: record.id,
    title: record.title,
    age: formatNewsAge(now - record.publishedAt),
    color: NEWS_CATEGORY_COLORS[record.category] ?? NEWS_CATEGORY_COLORS.world,
    alert: record.severity === 4,
    located: Boolean(record.location?.onGlobe),
    gdelt: record.viaGdelt,
  }));
}

/** The GDELT citation, as text plus the link its terms require. */
export function gdeltCitation() {
  return { text: t(GDELT_CITATION), url: GDELT_HOME };
}
