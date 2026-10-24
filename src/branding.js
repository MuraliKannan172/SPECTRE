/**
 * SKYNET branding: every product name, wordmark, tagline and brand colour the
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
  name: 'SKYNET',
  shortName: 'SKYNET',
  /** Shown as `lead` + accented `accent` in the title bar and loader. */
  wordmark: Object.freeze({ lead: 'SKY', accent: 'NET' }),
  tagline: msg('GLOBAL INTELLIGENCE GLOBE'),
  description:
    'A local-first global intelligence globe: live flights, satellites, weather and news on a 3D Earth.',
  /** Name the voice assistant and AI clients use for the app's assistant. */
  assistantName: 'SKYNET',
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
 * @returns {string} e.g. `SKYNET-cctv-proxy/0.1`
 */
export function brandUserAgent(component, purpose) {
  const product = `${BRANDING.name}-${component}/${BRANDING.version}`;
  return purpose ? `${product} (${purpose})` : product;
}
