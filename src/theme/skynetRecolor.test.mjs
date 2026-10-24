import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  contrastOnBlack,
  generate,
  recolor,
  recolorValue,
} from '../../scripts/generate-skynet-recolor.mjs';
import { BRANDING } from '../branding.js';

test('the generated recolor sheet matches the current upstream stylesheets', () => {
  const committed = readFileSync(
    new URL('./skynet-recolor.css', import.meta.url),
    'utf8',
  );
  assert.equal(
    committed,
    generate(),
    'run node scripts/generate-skynet-recolor.mjs after changing src/ui/styles/',
  );
});

test("upstream's cyan accent maps exactly to the brand red", () => {
  const hex = BRANDING.colors.accent.toLowerCase();
  assert.equal(recolorValue('#00d4ff'), hex);
  assert.equal(
    recolorValue('rgba(0, 212, 255, 0.15)'),
    'rgba(255, 40, 0, 0.15)',
  );
  assert.equal(
    recolorValue('1px solid #00D4FF !important'),
    `1px solid ${hex} !important`,
  );
});

test('recoloured text stays WCAG AA on black, raising opacity then lightness', () => {
  const parse = (css) => {
    const [, r, g, b, alpha = '1'] =
      /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/.exec(css) || [
        null,
        ...css.match(/[0-9a-f]{2}/gi).map((h) => parseInt(h, 16)),
        '1',
      ];
    return { rgb: [r, g, b].map(Number), alpha: Number(alpha) };
  };
  for (const value of [
    'rgba(0, 255, 255, 0.6)',
    'rgba(0, 212, 255, 0.35)',
    '#00d4ff',
    '#28b9db',
  ]) {
    const { rgb, alpha } = parse(recolorValue(value, { text: true }));
    assert.ok(
      contrastOnBlack(rgb, alpha) >= 4.5,
      `${value} -> ${rgb} @ ${alpha}`,
    );
  }
  // Non-text uses (borders, fills, glows) keep the original opacity.
  assert.equal(
    recolorValue('rgba(0, 212, 255, 0.35)'),
    'rgba(255, 40, 0, 0.35)',
  );
});

test('non-accent colours are left alone', () => {
  for (const colour of [
    [255, 68, 68], // error red
    [84, 227, 156], // status green
    [143, 138, 255], // violet
    [120, 120, 120], // grey
  ])
    assert.equal(recolor(colour), null, colour.join(','));
  assert.equal(recolorValue('rgba(255, 255, 255, 0.08)'), null);
});
