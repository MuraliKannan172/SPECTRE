import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

test('the logo names the product and keeps the parts the gaze animation moves', () => {
  const logo = read('public/logo.svg');
  assert.match(
    logo,
    new RegExp(`<title id="logo-title">${BRANDING.name}</title>`),
  );
  assert.match(logo, /id="globe"/);
  assert.match(logo, /id="globe_cage"/);
});

test('index.html takes its product name and colour from branding tokens', () => {
  const html = applyBrandHtml(read('index.html'));
  assert.match(html, new RegExp(`<title>${BRANDING.name}</title>`));
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
    'public/logo.svg',
    'pinokio/pinokio.js',
    ...templates,
  ])
    assert.doesNotMatch(read(path), UPSTREAM_NAMES, path);
});

test('user agents identify SKYNET, never the upstream project', () => {
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
