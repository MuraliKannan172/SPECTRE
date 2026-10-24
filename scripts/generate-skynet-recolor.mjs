#!/usr/bin/env node
// Generate src/theme/skynet-recolor.css: SKYNET's red for every cyan accent
// that upstream stylesheets hard-code instead of using `--accent`.
//
// Upstream God's Eye View paints its accent cyan in ~200 literals across
// src/ui/styles/*.css. Rather than edit those files (and fight every upstream
// merge), this script copies each rule that uses a cyan-family colour, keeps
// only those declarations, and moves their hue to the brand red while keeping
// lightness, saturation and alpha. style.css imports the result after every
// other sheet, so the same selectors win by order.
//
//   node scripts/generate-skynet-recolor.mjs          # write
//   node scripts/generate-skynet-recolor.mjs --check  # fail if stale
//
// src/theme/skynetRecolor.test.mjs runs --check under npm test.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BRANDING } from '../src/branding.js';

const STYLES = new URL('../src/ui/styles/', import.meta.url);
const OUTPUT = new URL('../src/theme/skynet-recolor.css', import.meta.url);
// cyber.css is upstream's own red theme, scoped to its HUD layout.
const SKIPPED = new Set(['cyber.css']);

/** Hue band treated as the upstream accent family, in degrees. */
const CYAN_HUE = [170, 215];
const MIN_SATURATION = 0.3;

function hexToRgb(hex) {
  let value = hex.slice(1);
  if (value.length === 3)
    value = [...value].map((digit) => digit + digit).join('');
  return [0, 2, 4].map((offset) =>
    parseInt(value.slice(offset, offset + 2), 16),
  );
}

function rgbToHsl([r, g, b]) {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation =
    lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue;
  if (max === rn) hue = (gn - bn) / delta + (gn < bn ? 6 : 0);
  else if (max === gn) hue = (bn - rn) / delta + 2;
  else hue = (rn - gn) / delta + 4;
  return [hue * 60, saturation, lightness];
}

function hslToRgb([hue, saturation, lightness]) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const section = hue / 60;
  const x = chroma * (1 - Math.abs((section % 2) - 1));
  const [r, g, b] =
    section < 1
      ? [chroma, x, 0]
      : section < 2
        ? [x, chroma, 0]
        : section < 3
          ? [0, chroma, x]
          : section < 4
            ? [0, x, chroma]
            : section < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const m = lightness - chroma / 2;
  return [r, g, b].map((channel) => Math.round((channel + m) * 255));
}

const BRAND_HUE = rgbToHsl(hexToRgb(BRANDING.colors.accent))[0];

/** The brand-red equivalent of a cyan-family colour, or null to keep it. */
export function recolor([r, g, b]) {
  const [hue, saturation, lightness] = rgbToHsl([r, g, b]);
  if (hue < CYAN_HUE[0] || hue > CYAN_HUE[1] || saturation < MIN_SATURATION)
    return null;
  return hslToRgb([BRAND_HUE, saturation, lightness]);
}

const HEX = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
const RGB = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(\s*,\s*[\d.]+%?)?\s*\)/g;
const toHex = (rgb) =>
  `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;

/** WCAG 2.x relative luminance of an sRGB colour. */
function luminance(rgb) {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast of a colour drawn at `alpha` over the black page background. */
export function contrastOnBlack(rgb, alpha = 1) {
  const shown = rgb.map((channel) => channel * alpha);
  return (luminance(shown) + 0.05) / 0.05;
}

/** WCAG AA for normal text. */
const TEXT_CONTRAST = 4.5;

/**
 * Text drawn in red needs more opacity or lightness than the cyan it replaces
 * to stay readable: raise the alpha first, then the lightness, until it meets
 * AA on black (the app's panels are near-black glass).
 */
function readable(rgb, alpha) {
  let next = alpha;
  while (next < 1 && contrastOnBlack(rgb, next) < TEXT_CONTRAST)
    next = Math.min(1, Math.round((next + 0.05) * 100) / 100);
  let colour = rgb;
  const [hue, saturation, lightness] = rgbToHsl(rgb);
  for (
    let step = lightness;
    contrastOnBlack(colour, next) < TEXT_CONTRAST && step < 0.95;
    step += 0.02
  )
    colour = hslToRgb([hue, saturation, step]);
  return { rgb: colour, alpha: next };
}

/**
 * Recolour the cyan-family colours in one declaration value.
 * @param {string} value
 * @param {{text?: boolean}} [options] text colours are kept at WCAG AA on black.
 */
export function recolorValue(value, { text = false } = {}) {
  let changed = false;
  const next = value
    .replace(HEX, (hex) => {
      let rgb = recolor(hexToRgb(hex));
      if (!rgb) return hex;
      changed = true;
      if (text) rgb = readable(rgb, 1).rgb;
      return toHex(rgb);
    })
    .replace(RGB, (whole, r, g, b, alphaPart = '') => {
      const rgb = recolor([Number(r), Number(g), Number(b)]);
      if (!rgb) return whole;
      changed = true;
      const alpha = alphaPart
        ? Number.parseFloat(alphaPart.replace(/[,\s%]/g, '')) /
          (alphaPart.includes('%') ? 100 : 1)
        : 1;
      const shown = text ? readable(rgb, alpha) : { rgb, alpha };
      return shown.alpha < 1
        ? `rgba(${shown.rgb.join(', ')}, ${shown.alpha})`
        : `rgb(${shown.rgb.join(', ')})`;
    });
  return changed ? next : null;
}

/** Properties whose colour is text, so it must stay readable. */
const TEXT_PROPERTIES = new Set(['color', '-webkit-text-fill-color']);

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Split a declaration block into declarations, respecting parentheses. */
function declarations(block) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of block) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ';' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.includes(':'));
}

/** Walk rules (and @media/@supports/@container blocks); collect overrides. */
function overrides(css, out = []) {
  let index = 0;
  while (index < css.length) {
    const open = css.indexOf('{', index);
    if (open < 0) break;
    const prelude = css.slice(index, open).trim();
    let depth = 1;
    let close = open + 1;
    while (close < css.length && depth > 0) {
      if (css[close] === '{') depth++;
      if (css[close] === '}') depth--;
      close++;
    }
    const body = css.slice(open + 1, close - 1);
    if (/^@(media|supports|container)\b/.test(prelude)) {
      const nested = overrides(body, []);
      if (nested.length) out.push({ prelude, nested });
    } else if (!prelude.startsWith('@') && !body.includes('{')) {
      const changed = declarations(body)
        .map((declaration) => {
          const colon = declaration.indexOf(':');
          // Custom properties are included (the HUD's --hud-color, say);
          // src/theme/skynet.css loads later and re-points the main tokens.
          const property = declaration.slice(0, colon).trim();
          const value = recolorValue(declaration.slice(colon + 1).trim(), {
            text: TEXT_PROPERTIES.has(property),
          });
          return value ? `${property}: ${value}` : null;
        })
        .filter(Boolean);
      if (changed.length) out.push({ prelude, declarations: changed });
    }
    index = close;
  }
  return out;
}

function render(items, indent = '') {
  return items
    .map((item) =>
      item.nested
        ? `${indent}${item.prelude} {\n${render(item.nested, `${indent}  `)}\n${indent}}`
        : `${indent}${item.prelude.replace(/\s*\n\s*/g, ' ')} {\n` +
          item.declarations.map((line) => `${indent}  ${line};`).join('\n') +
          `\n${indent}}`,
    )
    .join('\n');
}

export function generate() {
  const files = readdirSync(STYLES)
    .filter((name) => name.endsWith('.css') && !SKIPPED.has(name))
    .sort();
  const sections = files
    .map((name) => {
      const items = overrides(
        stripComments(readFileSync(new URL(name, STYLES), 'utf8')),
      );
      return items.length ? `/* ${name} */\n${render(items)}` : null;
    })
    .filter(Boolean);
  return (
    '/* GENERATED by scripts/generate-skynet-recolor.mjs — do not edit.\n' +
    '   SKYNET red for the cyan accents upstream stylesheets hard-code.\n' +
    '   Re-run the script after changing src/ui/styles/. */\n\n' +
    `${sections.join('\n\n')}\n`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const css = generate();
  if (process.argv.includes('--check')) {
    const current = readFileSync(OUTPUT, 'utf8');
    if (current !== css) {
      console.error(
        'src/theme/skynet-recolor.css is stale: run node scripts/generate-skynet-recolor.mjs',
      );
      process.exit(1);
    }
  } else {
    writeFileSync(OUTPUT, css);
    console.log(
      `wrote ${fileURLToPath(OUTPUT)} (${css.split('\n').length} lines)`,
    );
  }
}
