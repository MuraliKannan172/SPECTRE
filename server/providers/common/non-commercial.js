/**
 * SPECTRE: free APIs whose terms allow only personal, non-commercial use stay
 * off by default. They are OpenSky (flights and tracks), Open-Meteo's free
 * tier (cockpit weather and weather effects), Google News RSS (regional
 * headlines), adsbdb route data (callsign routes) and S2 Underground's
 * GhostMaps products (CC BY-NC-SA 4.0).
 *
 * The owner turns them on with the "Non-commercial sources" switch in Provider
 * Settings, which writes SPECTRE_NONCOMMERCIAL_SOURCES=1. Providers read it per
 * request, so a save applies without restarting.
 */
export const NON_COMMERCIAL_SOURCES_ENV = 'SPECTRE_NONCOMMERCIAL_SOURCES';

/** English reason sent to clients when a gated source is off. */
export const NON_COMMERCIAL_SOURCES_OFF_REASON =
  'Off: this free API allows personal, non-commercial use only. Turn on Non-commercial sources in Provider Settings to use it.';

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean} whether the owner opted in to non-commercial sources.
 */
export function nonCommercialSourcesEnabled(env = process.env) {
  return ENABLED_VALUES.has(
    String(env[NON_COMMERCIAL_SOURCES_ENV] ?? '')
      .trim()
      .toLowerCase(),
  );
}
