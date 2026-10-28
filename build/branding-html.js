import { BRANDING } from '../src/branding.js';

const escapeHtml = (text) =>
  String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** The `{{brand.*}}` tokens index.html may use, from src/branding.js. */
export const BRAND_HTML_TOKENS = Object.freeze({
  'brand.name': BRANDING.name,
  'brand.shortName': BRANDING.shortName,
  'brand.description': BRANDING.description,
  'brand.background': BRANDING.colors.background,
});

/** Replace `{{brand.*}}` tokens; an unknown token is a build error. */
export function applyBrandHtml(html) {
  return html.replace(/\{\{\s*(brand\.[A-Za-z]+)\s*\}\}/g, (_, token) => {
    if (!Object.hasOwn(BRAND_HTML_TOKENS, token))
      throw new Error(`Unknown branding token: ${token}`);
    return escapeHtml(BRAND_HTML_TOKENS[token]);
  });
}

/** Fill the document head's product name and colours before Vite runs. */
export function brandingHtmlPlugin() {
  return {
    name: 'spectre-branding-html',
    transformIndexHtml: { order: 'pre', handler: applyBrandHtml },
  };
}
