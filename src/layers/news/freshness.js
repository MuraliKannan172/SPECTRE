/**
 * SKYNET: one freshness label for every news surface (layer row, drawer,
 * ticker), so all three say "updated X ago" and show the same stale and
 * offline states. Pure; the tone is a CSS hook, the text is translated.
 */
import { msg, t, translateKnown } from '../../i18n/index.js';
import { formatNewsAge } from './cards.js';

export const NEWS_STALE_BADGE = msg('STALE');
export const NEWS_OFFLINE_BADGE = msg('OFFLINE');

/** source.js's error texts, marked here for the catalog; a test keeps them equal. */
export const NEWS_ERROR_TEXTS = Object.freeze([
  msg('Intel service offline: run scripts\\skynet.ps1 to start it'),
  msg('News unavailable'),
]);

/**
 * @param {{freshness?: object|null, error?: string|null, loading?: boolean}} model
 * @returns {{tone: 'live'|'stale'|'offline'|'loading'|'idle', badge: string|null, text: string|null}}
 */
export function newsFreshness({
  freshness = null,
  error = null,
  loading = false,
} = {}) {
  if (error)
    return {
      tone: 'offline',
      badge: t(NEWS_OFFLINE_BADGE),
      text: translateKnown(error),
    };
  if (freshness?.offline || freshness?.state === 'offline')
    return {
      tone: 'offline',
      badge: t(NEWS_OFFLINE_BADGE),
      text: t('Every news source is failing; showing cached stories'),
    };
  const age =
    freshness?.ageSeconds != null
      ? formatNewsAge(freshness.ageSeconds * 1000)
      : null;
  if (freshness?.stale)
    return {
      tone: 'stale',
      badge: t(NEWS_STALE_BADGE),
      text: age ? t('Stale · updated {age} ago', { age }) : t(NEWS_STALE_BADGE),
    };
  if (age)
    return { tone: 'live', badge: null, text: t('Updated {age} ago', { age }) };
  if (loading)
    return { tone: 'loading', badge: null, text: t('Loading news…') };
  return { tone: 'idle', badge: null, text: null };
}
