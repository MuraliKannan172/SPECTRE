import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { BRANDING, brandUserAgent } from './branding.js';
import { applyBrandHtml } from '../build/branding-html.js';
import { applyBranding } from './ui/branding.js';

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const UPSTREAM_NAMES = /god['’]?s[\s-]?eye|GEV MIC|halfpixel/i;

test('the install manifest is pinned to src/branding.js', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest'));
  assert.equal(manifest.name, BRANDING.name);
  assert.equal(manifest.short_name, BRANDING.shortName);
  assert.equal(manifest.description, BRANDING.description);
  assert.equal(manifest.background_color, BRANDING.colors.background);
  assert.equal(manifest.theme_color, BRANDING.colors.background);
});

test('the Pinokio launcher is pinned to src/branding.js', () => {
  const launcher = createRequire(import.meta.url)('../pinokio/pinokio.js');
  assert.equal(launcher.title, BRANDING.name);
  assert.equal(launcher.description, BRANDING.description);
  assert.match(read('pinokio/pinokio.js'), new RegExp(`Open ${BRANDING.name}`));
});

const publicFile = (href) => new URL(`../public${href}`, import.meta.url);

test('the header and loader show the emblem mark shipped in public/brand', () => {
  for (const template of ['scene-chrome', 'hud-loading']) {
    const src = read(`src/ui/templates/${template}.html`).match(
      /class="[^"]*brand-logo[^"]*"[^>]*><img src="([^"]+)"/,
    )?.[1];
    assert.match(src ?? '', /^\/brand\/spectre-mark-\d+\.png$/, template);
    assert.ok(existsSync(publicFile(src)), src);
  }
  assert.ok(existsSync(publicFile(BRANDING.logo)), BRANDING.logo);
  // The opaque master is for docs only, never the shipped bundle.
  assert.ok(
    existsSync(
      new URL('../docs/brand/spectre-logo-source.png', import.meta.url),
    ),
  );
  assert.ok(!existsSync(publicFile('/brand/spectre-logo-source.png')));
});

test('the theme reds match BRANDING.colors, so a revert cannot half-apply', () => {
  const css = read('src/theme/spectre.css');
  const token = (name) =>
    css
      .match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]
      .trim()
      .toLowerCase();
  const { accent, accentDeep } = BRANDING.colors;
  assert.equal(token('sp-red'), accent.toLowerCase());
  assert.equal(token('sp-red-deep'), accentDeep.toLowerCase());
  const rgb = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16));
  assert.equal(token('sp-red-rgb'), rgb.join(', '));
});

test('index.html takes its product name and colour from branding tokens', () => {
  const html = applyBrandHtml(read('index.html'));
  assert.match(html, new RegExp(`<title>${BRANDING.title}</title>`));
  for (const [, href] of html.matchAll(
    /<meta (?:property="og:image"|name="twitter:image") content="([^"]+)"/g,
  ))
    assert.ok(existsSync(publicFile(href)), href);
  assert.match(
    html,
    new RegExp(`name="theme-color" content="${BRANDING.colors.background}"`),
  );
  assert.doesNotMatch(html, /\{\{\s*brand\./);
  assert.throws(
    () => applyBrandHtml('{{brand.unknown}}'),
    /Unknown branding token/,
  );
  assert.equal(
    applyBrandHtml('<b>{{ brand.name }}</b>'),
    `<b>${BRANDING.name}</b>`,
  );
});

test('no shipped page surface names the upstream product', () => {
  const templates = readdirSync(new URL('./ui/templates/', import.meta.url))
    .filter((name) => name.endsWith('.html'))
    .map((name) => `src/ui/templates/${name}`);
  for (const path of [
    'index.html',
    'public/manifest.webmanifest',
    'pinokio/pinokio.js',
    ...templates,
  ])
    assert.doesNotMatch(read(path), UPSTREAM_NAMES, path);
});

test('user agents identify SPECTRE, never the upstream project', () => {
  assert.equal(
    brandUserAgent('cctv-proxy'),
    `${BRANDING.name}-cctv-proxy/${BRANDING.version}`,
  );
  assert.equal(
    brandUserAgent('radio', 'Radio Browser directory client'),
    `${BRANDING.name}-radio/${BRANDING.version} (Radio Browser directory client)`,
  );
});

test('applyBranding fills the wordmark, name and translated tagline', () => {
  const created = [];
  const documentRef = {
    createElement(tag) {
      const element = { tag, className: '', textContent: '' };
      created.push(element);
      return element;
    },
  };
  const element = (brand) => ({
    dataset: { brand },
    textContent: '',
    children: null,
    replaceChildren(...children) {
      this.children = children;
    },
  });
  const wordmark = element('wordmark');
  const name = element('name');
  const tagline = element('tagline');
  const other = element('unknown');
  const root = {
    ownerDocument: documentRef,
    querySelectorAll: () => [wordmark, name, tagline, other],
  };
  assert.equal(applyBranding(root), 3);
  assert.equal(wordmark.children[0], BRANDING.wordmark.lead);
  assert.equal(wordmark.children[1].className, 'title-accent');
  assert.equal(wordmark.children[1].textContent, BRANDING.wordmark.accent);
  assert.equal(name.textContent, BRANDING.name);
  assert.equal(tagline.textContent, BRANDING.tagline);
  assert.equal(other.textContent, '');
});
