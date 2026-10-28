/**
 * SPECTRE: how the News layer's settings travel in share links and the stored
 * layer state (src/data/layerState.js, SPECTRE block). Each spec follows that
 * codec's contract: key, token, defaultValue, normalize, encode, decode, and
 * patchRequested for a value a request changes without naming it.
 *
 * Categories travel as one canonical string, the chosen categories in
 * NEWS_CATEGORIES order joined by '-' ('' shows every category), the way
 * upstream's Street Level carries providerSwitches.
 */
import {
  NEWS_CATEGORIES,
  NEWS_DEFAULT_WINDOW_HOURS,
  NEWS_WINDOW_HOURS,
} from './records.js';

const SEPARATOR = '-';
const MAX_FILTER_LENGTH = 120;

/** Chosen categories as the canonical string ('' when none are chosen). */
export function encodeNewsCategoryFilter(categories) {
  const chosen = new Set(Array.isArray(categories) ? categories : []);
  return NEWS_CATEGORIES.filter((category) => chosen.has(category)).join(
    SEPARATOR,
  );
}

/** The canonical string back to categories, or null when it is not valid. */
export function decodeNewsCategoryFilter(value) {
  if (typeof value !== 'string' || value.length > MAX_FILTER_LENGTH)
    return null;
  if (!value) return [];
  const parts = value.split(SEPARATOR);
  if (
    parts.some((part) => !NEWS_CATEGORIES.includes(part)) ||
    new Set(parts).size !== parts.length
  )
    return null;
  return NEWS_CATEGORIES.filter((category) => parts.includes(category));
}

function normalizeCategoryFilter(value) {
  const categories = decodeNewsCategoryFilter(value);
  return categories === null ? null : encodeNewsCategoryFilter(categories);
}

function normalizeWindowHours(value) {
  const hours =
    typeof value === 'string' && /^\d{1,3}$/.test(value)
      ? Number(value)
      : value;
  return NEWS_WINDOW_HOURS.includes(hours) ? hours : null;
}

export const NEWS_SHARE_OPTIONS = Object.freeze([
  Object.freeze({
    key: 'windowHours',
    token: 'w',
    defaultValue: NEWS_DEFAULT_WINDOW_HOURS,
    normalize: normalizeWindowHours,
    encode: (value) => String(value),
    decode: normalizeWindowHours,
  }),
  Object.freeze({
    key: 'categoryFilter',
    token: 'c',
    defaultValue: '',
    normalize: normalizeCategoryFilter,
    encode: (value) => value,
    decode: normalizeCategoryFilter,
    // The row's category chips send toggleCategory, never categoryFilter,
    // so persist the filter they produced.
    patchRequested: (previous, applied, requested) =>
      Object.hasOwn(requested, 'toggleCategory') ||
      Object.hasOwn(requested, 'categories')
        ? applied
        : undefined,
  }),
]);
