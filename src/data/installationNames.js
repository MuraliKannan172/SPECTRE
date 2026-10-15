/**
 * The English names the data gives a military installation that has no
 * mapped name. They stay English in data — the server provider, the AI tools
 * and the voice context read the records — and the display translates them
 * (installationTitle in src/layers/installations/classLabel.js and
 * formatAwarenessLabel in src/data/militaryAwarenessEngine.js).
 *
 * The server, tools and source modules load this file, so it marks the names
 * with a local msg() instead of importing i18n.
 */
const msg = (text) => text;

/** Name of an unnamed feature, by installation class. */
export const UNNAMED_INSTALLATION_LABEL_BY_CLASS = Object.freeze({
  airfield: msg('Military airfield'),
  naval_base: msg('Naval base'),
  range: msg('Firing range'),
  military_land: msg('Military land'),
});

/** Name of an unnamed feature without a usable class. */
export const UNNAMED_INSTALLATION_FALLBACK = msg('Mapped installation');

/** Name of a military polygon the names pack has not named. */
export const UNNAMED_MILITARY_AREA = msg('Military area');

/** Every name above, for the display to translate. */
export const UNNAMED_PLACE_NAMES = Object.freeze([
  ...Object.values(UNNAMED_INSTALLATION_LABEL_BY_CLASS),
  UNNAMED_INSTALLATION_FALLBACK,
  UNNAMED_MILITARY_AREA,
]);
