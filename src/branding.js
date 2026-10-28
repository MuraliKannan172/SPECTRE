/**
 * SPECTRE branding: every product name, wordmark, tagline and brand colour the
 * app shows or sends lives here, so a rename is a one-file change.
 *
 * Pure data plus one helper; it imports only the msg() marker, so the page,
 * the server, scripts and tests can all read it. Consumers:
 * - build/branding-html.js fills index.html's title, app name and theme colour;
 * - src/ui/branding.js fills `[data-brand]` elements and the voice name;
 * - server providers send `brandUserAgent()` to upstream services;
 * - public/manifest.webmanifest and scripts/generate-icons.mjs are pinned to
 *   these values by src/branding.test.mjs.
 *
 * Storage keys, `GEV_*` environment variables and file formats inherited from
 * God's Eye View keep their names for compatibility; they are not branding.
 */
import { msg } from './i18n/marker.js';

export const BRANDING = Object.freeze({
  name: 'SPECTRE',
  shortName: 'SPECTRE',
  /** Lower-case name for file, package and plugin names. */
  slug: 'spectre',
  /**
   * Shown as `lead` + accented `accent` in the title bar and loader. The
   * emblem's wordmark is one colour, so nothing is accented.
   */
  wordmark: Object.freeze({ lead: 'SPECTRE', accent: '' }),
  tagline: msg('GLOBAL INTELLIGENCE DASHBOARD'),
  /** The emblem's sub-line, in its order. */
  subline: Object.freeze([
    msg('REAL-TIME'),
    msg('ANALYZE'),
    msg('PREDICT'),
    msg('GLOBAL INSIGHTS'),
  ]),
  description:
    'A local-first global intelligence dashboard: live flights, satellites, weather and news on a 3D Earth.',
  /** Name the voice assistant and AI clients use for the app's assistant. */
  assistantName: 'SPECTRE',
  /** Sub-label of the local chat panel. */
  neuralCoreLabel: 'Neural Core',
  logo: '/logo.svg',
  colors: Object.freeze({
    background: '#000000',
    surface: '#0B0B0E',
    accent: '#FF2800',
    accentDeep: '#D40000',
  }),
  version: '0.1',
});

/**
 * Identifying User-Agent for one server component, as upstream services ask
 * (for example the OSMF and NOAA usage policies).
 * @param {string} component e.g. `cctv-proxy`
 * @param {string} [purpose] optional note shown in parentheses
 * @returns {string} e.g. `SPECTRE-cctv-proxy/0.1`
 */
export function brandUserAgent(component, purpose) {
  const product = `${BRANDING.name}-${component}/${BRANDING.version}`;
  return purpose ? `${product} (${purpose})` : product;
}
