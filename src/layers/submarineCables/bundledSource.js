// This dataset is CC BY-NC-SA 3.0, not the project's MIT license, so SPECTRE
// does not ship it. scripts/fetch-optional-data.ps1 downloads it into this
// gitignored folder for personal, non-commercial use. See DATA_SOURCES.md.
// Resolved when read, so importing this module never needs a module URL.
function cableUrl() {
  return new URL(
    '../../data/local_data/telegeography_submarine_cables/cable-geo.json',
    import.meta.url,
  ).href;
}
function landingPointUrl() {
  return new URL(
    '../../data/local_data/telegeography_submarine_cables/landing-point-geo.json',
    import.meta.url,
  ).href;
}

export const OPTIONAL_DATA_MISSING = 'optional-data-missing';

function optionalDataMissing() {
  const error = new Error('TeleGeography optional dataset is not installed');
  error.code = OPTIONAL_DATA_MISSING;
  return error;
}

/** Supply GeoJSON collections without coupling the renderer to asset URLs. */
export function createBundledCableSource({
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  async function read(url, signal) {
    signal?.throwIfAborted();
    const response = await fetchImpl(url, { signal, cache: 'force-cache' });
    // A missing optional file is a 404, or the dev server's HTML fallback.
    const contentType = response.headers?.get?.('content-type') || '';
    const missing =
      response.status === 404 || (response.ok && contentType.includes('html'));
    if (!response.ok || missing) {
      try {
        await response.body?.cancel();
      } catch {
        /* best effort */
      }
      if (missing) throw optionalDataMissing();
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    const json = await response.json();
    signal?.throwIfAborted();
    return json;
  }
  return {
    label: 'TeleGeography', // i18n-ignore: data provider name
    async fetch(signal) {
      const [cables, landingPoints] = await Promise.all([
        read(cableUrl(), signal),
        read(landingPointUrl(), signal),
      ]);
      return { cables, landingPoints };
    },
  };
}
