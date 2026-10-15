/**
 * The tool name to show for a pointer owner.
 *
 * Pointer-owner ids (src/data/inputOwnership.js) are stable internal
 * identifiers — 'draw', 'recent-imagery-box' — and never belong on screen.
 * This maps each to the English name of the tool, which the caller translates
 * with translateKnown() where it is shown. Pure and stateless, so any package
 * can carry it without a second copy of the pointer claim.
 */

// English marker for the i18n extractor; this module imports no i18n.
const msg = (text) => text;

const POINTER_OWNER_NAMES = Object.freeze({
  draw: msg('Draw'),
  directions: msg('Directions'),
  'recent-imagery-box': msg('Recent imagery'),
});

/**
 * English display name of a pointer owner. An owner without a registered name
 * falls back to its id.
 * @param {string|null} owner Pointer-owner id, as `pointerOwner()` returns it.
 * @returns {string}
 */
export function pointerOwnerName(owner) {
  const id = typeof owner === 'string' ? owner.trim() : '';
  if (!id) return '';
  return Object.hasOwn(POINTER_OWNER_NAMES, id) ? POINTER_OWNER_NAMES[id] : id;
}
