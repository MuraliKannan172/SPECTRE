#!/usr/bin/env node
// Renders the maskable home-screen icon from the SPECTRE mark. The other icons
// in `public/brand/` (favicons, apple-touch-icon, icon-192/512) are drawn by
// hand and copied as they are; their art reaches past the maskable safe zone.
//
// Re-run after changing the mark: `node scripts/generate-icons.mjs`. The output
// is committed, because the install icons have to exist in a plain `vite build`
// and contributors should not need an image toolchain to ship the app.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { BRANDING } from '../src/branding.js';

const REPO_ROOT = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
);
const LOGO = path.join(REPO_ROOT, 'public', 'brand', 'spectre-mark.png');
const OUT_DIR = path.join(REPO_ROOT, 'public', 'brand');

/** The brand background (src/branding.js), so the tile matches the app. */
const BACKGROUND = BRANDING.colors.background;

/**
 * Fraction of the canvas the mark is allowed to occupy.
 *
 * A maskable icon may be cropped to a circle inscribed in the middle 80% of the
 * square, so its mark stays well inside that circle.
 */
const INSET = { maskable: 0.54 };

const TARGETS = [
  { file: 'icon-512-maskable.png', size: 512, inset: INSET.maskable },
];

/** Fit the mark inside `size * inset` and centre it on an opaque square. */
async function render(source, { size, inset }) {
  const box = Math.round(size * inset);
  // The mark is about twice as wide as it is tall, so `contain` bounds it by
  // width and leaves the vertical padding uneven — centring is done by the
  // composite below rather than by the resize.
  const mark = await sharp(source)
    .resize(box, box, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: BACKGROUND,
    },
  })
    .composite([{ input: mark, gravity: 'centre' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

const source = await readFile(LOGO);
await mkdir(OUT_DIR, { recursive: true });
for (const target of TARGETS) {
  await writeFile(
    path.join(OUT_DIR, target.file),
    await render(source, target),
  );
  console.log(`icons: wrote ${target.file} (${target.size}px)`);
}
