import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

test('index.html: all interactive input elements have accessible names (WCAG 4.1.2)', () => {
  const htmlPath = path.resolve(process.cwd(), 'index.html');
  const html = readFileSync(htmlPath, 'utf8');

  // Match all <input ... /> tags
  const inputMatches = [...html.matchAll(/<input\b([^>]*)\/?>/g)];
  assert.ok(inputMatches.length > 5, 'expected to find interactive input elements');

  for (const match of inputMatches) {
    const attrs = match[1];
    const hasAriaLabel = /aria-label=["'][^"']+["']/.test(attrs);
    const hasAriaLabelledby = /aria-labelledby=["'][^"']+["']/.test(attrs);
    const idMatch = attrs.match(/\bid=["']([^"']+)["']/);
    const id = idMatch ? idMatch[1] : null;

    let hasAssociatedLabel = false;
    if (id) {
      // Check if there is a <label for="id">
      const labelForRegex = new RegExp(`<label\\b[^>]*\\bfor=["']${id}["']`, 'i');
      hasAssociatedLabel = labelForRegex.test(html);
    }

    const hasAccessibleName = hasAriaLabel || hasAriaLabelledby || hasAssociatedLabel;
    assert.ok(
      hasAccessibleName,
      `input tag "${match[0]}" must have an accessible name (aria-label, aria-labelledby, or label for)`
    );
  }
});

test('index.html: HUD sliders and controls have descriptive accessible labels', () => {
  const htmlPath = path.resolve(process.cwd(), 'index.html');
  const html = readFileSync(htmlPath, 'utf8');

  assert.match(html, /id="scope-feather-slider"[^>]*aria-label="Scope edge feather"/);
  assert.match(html, /id="bloom-intensity-slider"[^>]*aria-label="Bloom intensity"/);
  assert.match(html, /id="sharpen-intensity-slider"[^>]*aria-label="Sharpen intensity"/);
  assert.match(html, /id="location-search"[^>]*aria-label="Search location by name or coordinates"/);
  assert.match(html, /data-first-run-suppress[^>]*aria-label="Do not show this message again on startup"/);
});

test('ui.js: dynamic style parameter sliders set aria-label', () => {
  const uiPath = path.resolve(process.cwd(), 'src/ui.js');
  const uiJs = readFileSync(uiPath, 'utf8');

  assert.match(uiJs, /slider\.setAttribute\(['"]aria-label['"],\s*uMeta\.label\)/);
});
