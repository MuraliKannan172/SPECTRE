import { BRANDING } from '../branding.js';
import { t } from '../i18n/index.js';

/**
 * Fill every `[data-brand]` element from src/branding.js: `wordmark` (lead
 * text plus an accented `.title-accent` span), `name`, or `tagline` (in the
 * active language). Run after the page has picked its language.
 * @param {Document|Element} [root=document]
 * @returns {number} Count of elements filled.
 */
export function applyBranding(root = document) {
  if (typeof root?.querySelectorAll !== 'function') return 0;
  const documentRef = root.ownerDocument || root;
  let filled = 0;
  for (const element of root.querySelectorAll('[data-brand]')) {
    const field = element.dataset.brand;
    if (field === 'wordmark') {
      const accent = documentRef.createElement('span');
      accent.className = 'title-accent';
      accent.textContent = BRANDING.wordmark.accent;
      element.replaceChildren(BRANDING.wordmark.lead, accent);
    } else if (field === 'name') {
      element.textContent = BRANDING.name;
    } else if (field === 'tagline') {
      element.textContent = t(BRANDING.tagline);
    } else {
      continue;
    }
    filled++;
  }
  return filled;
}
