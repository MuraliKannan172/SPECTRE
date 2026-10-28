/**
 * SPECTRE was called SKYNET until 2026-10-28. Settings still named `SKYNET_*`
 * keep working for one release: each is adopted under its `SPECTRE_*` name
 * when that name is unset, with one deprecation warning, so every reader only
 * ever looks up `SPECTRE_*`. Remove this file in the release after next.
 */
export const LEGACY_PREFIX = 'SKYNET_';
export const BRAND_PREFIX = 'SPECTRE_';

/** `SPECTRE_X` for `SKYNET_X`, or null for any other name. */
export function brandNameFor(legacyName) {
  return String(legacyName).startsWith(LEGACY_PREFIX)
    ? BRAND_PREFIX + legacyName.slice(LEGACY_PREFIX.length)
    : null;
}

/** `SKYNET_X` for `SPECTRE_X`, or null for any other name. */
export function legacyNameFor(name) {
  return String(name).startsWith(BRAND_PREFIX)
    ? LEGACY_PREFIX + name.slice(BRAND_PREFIX.length)
    : null;
}

/**
 * Copy each `SKYNET_*` value into its `SPECTRE_*` name where that is unset.
 * The new name always wins when both are present. `env` is changed in place:
 * it is the process environment (or a parsed dotenv map) that readers share.
 * @param {Record<string, string|undefined>} env
 * @param {{warn?: (message: string) => void}} [options]
 * @returns {string[]} the `SPECTRE_*` names that were adopted
 */
export function adoptLegacyBrandEnv(
  env,
  { warn = (message) => console.warn(message) } = {},
) {
  const adopted = [];
  for (const [legacyName, value] of Object.entries(env)) {
    const name = brandNameFor(legacyName);
    if (!name || value === undefined || env[name] !== undefined) continue;
    env[name] = value;
    adopted.push(name);
  }
  if (adopted.length)
    warn(
      `[SPECTRE] Deprecated setting names: ${adopted.map(legacyNameFor).join(', ')}. ` +
        'Rename them to SPECTRE_* (the old names still work for one release).',
    );
  return adopted;
}

/**
 * Provider Settings updates that also retire the old `SKYNET_*` line of each
 * `SPECTRE_*` name being written, so an old value can never override a
 * switch turned off under the new name.
 * @param {Record<string, string|null>} updates
 * @returns {Record<string, string|null>}
 */
export function withLegacyRetired(updates) {
  const retired = {};
  for (const name of Object.keys(updates)) {
    const legacyName = legacyNameFor(name);
    if (legacyName && !(legacyName in updates)) retired[legacyName] = null;
  }
  return { ...updates, ...retired };
}
