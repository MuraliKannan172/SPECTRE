#!/usr/bin/env node
/**
 * qa-sky-sun-moon — the custom sky must keep Cesium's Sun and Moon.
 *
 * CesiumWidget creates `scene.sun` and `scene.moon` only when the `skyBox`
 * option is not `false`, so replacing the sky box the wrong way silently
 * removes the Sun disc and its bloom. Points the camera at the Sun from
 * 22 000 km and fails unless both bodies exist; saves a screenshot.
 *
 * Usage: node scripts/qa-sky-sun-moon.mjs [--url http://localhost:4317] [--out qa-shots/sky-sun.png]
 */
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv;
const option = (name, fallback) =>
  argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const url = option('--url', 'http://localhost:4317');
const out = option('--out', 'qa-shots/sky-sun.png');
mkdirSync(path.dirname(out), { recursive: true });

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.evaluateOnNewDocument(() =>
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed'),
  );
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__godsEyeView?.viewer?.scene, {
    timeout: 90_000,
  });
  await new Promise((r) => setTimeout(r, 10_000));
  const info = await page.evaluate(async () => {
    // The page's own Cesium instance, as Vite served it.
    const entry = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((n) => /\.vite\/deps\/cesium\.js/.test(n));
    const C = await import(entry);
    const { viewer } = window.__godsEyeView;
    const scene = viewer.scene;
    scene.camera.cancelFlight();
    const time = viewer.clock.currentTime;
    const sun = C.Cartesian3.normalize(
      C.Matrix3.multiplyByVector(
        C.Transforms.computeTemeToPseudoFixedMatrix(time),
        C.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
          time,
        ),
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    // Off to the side of the Earth, looking straight at the Sun.
    const side = C.Cartesian3.normalize(
      C.Cartesian3.cross(sun, C.Cartesian3.UNIT_Z, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const destination = C.Cartesian3.add(
      C.Cartesian3.multiplyByScalar(side, 2.2e7, new C.Cartesian3()),
      C.Cartesian3.multiplyByScalar(sun, -0.6e7, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const up = C.Cartesian3.normalize(
      C.Cartesian3.cross(
        C.Cartesian3.cross(sun, C.Cartesian3.UNIT_Z, new C.Cartesian3()),
        sun,
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    scene.camera.setView({ destination, orientation: { direction: sun, up } });
    scene.requestRender();
    return {
      sun: Boolean(scene.sun),
      moon: Boolean(scene.moon),
      skyBox: scene.skyBox?.constructor?.name,
    };
  });
  await new Promise((r) => setTimeout(r, 4_000));
  await page.evaluate(() => window.__godsEyeView.viewer.scene.requestRender());
  await new Promise((r) => setTimeout(r, 1_500));
  await page.screenshot({ path: out });
  console.log(JSON.stringify({ url, ...info, screenshot: out }));
  if (!info.sun || !info.moon) {
    console.error('FAIL: scene.sun and scene.moon must both exist');
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
