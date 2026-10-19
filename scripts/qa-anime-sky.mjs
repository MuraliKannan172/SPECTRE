#!/usr/bin/env node
/**
 * qa-anime-sky — the anime style must cel-shade the Earth, and leave the sky
 * without bands.
 *
 * Earlier the anime shader exempted the far plane, judged from the
 * post-process depth, from its luminance bands. That depth cannot tell the
 * sky from far geometry, so the Earth lost its bands. The shader now matches
 * main, and src/ui/visualEffects.js fades the Milky Way out with the style.
 * Each case runs headless against a Vite dev server:
 *
 *   satellites  whole globe from 20 000 km with the satellites layer on
 *               (near clamps to 0.1 m): no Earth pixel may skip the bands.
 *   keyless     keyless stack, Denver 1700 m looking west: no terrain pixel
 *               above the ellipsoid horizon may skip the bands.
 *   milkyway    the real anime style, looking away from the Earth at the
 *               Galactic Centre: at most 0.5 % of the sky (the stars) may
 *               reach the first band.
 *
 * The first two cases compile the checkout's anime shader with a debug
 * output (R = pixel skipped the bands, G = raw depth 1.0) as an extra stage.
 *
 * Usage: node scripts/qa-anime-sky.mjs [--url http://localhost:4333/] [--case satellites|keyless|milkyway|all]
 * Exit: 0 all pass, 1 a case failed, 2 a scenario was not reached or the case is unknown.
 */
import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const opt = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const URL_ = opt('url', 'http://localhost:4333/');
const ALL_CASES = ['satellites', 'keyless', 'milkyway'];
const requested = opt('case', 'all');
const CASES = requested === 'all' ? ALL_CASES : [requested];
if (!CASES.every((c) => ALL_CASES.includes(c))) {
  console.error(
    `unknown case ${requested}; expected ${ALL_CASES.join('|')}|all`,
  );
  process.exit(2);
}

let fs = readFileSync(
  fileURLToPath(new URL('../src/styles/anime.js', import.meta.url)),
  'utf8',
);
fs = fs
  .slice(fs.indexOf('/* glsl */ `') + 12, fs.lastIndexOf('`'))
  .replace('uniform float intensity;', 'const float intensity = 1.0;')
  .replace('uniform float saturation;', 'const float saturation = 1.0;')
  .replace('uniform float edgeThick;', 'const float edgeThick = 0.5;');
if (!/uniform\s+sampler2D\s+depthTexture/.test(fs))
  fs = fs.replace(
    'uniform sampler2D colorTexture;',
    'uniform sampler2D colorTexture;\n    uniform sampler2D depthTexture;',
  );
if (!/float bands\b/.test(fs))
  throw new Error(
    'anime.js has no `bands` variable: adapt the debug line of this script',
  );
fs = fs
  .replace(
    /out_FragColor = [^;]+;\s*}\s*$/,
    `out_FragColor = mode < 0.5 ? texture(colorTexture, uv)
      : vec4(bands > 255.0 ? 1.0 : 0.0, texture(depthTexture, uv).r >= 1.0 ? 1.0 : 0.0, 0.0, 1.0);
    }`,
  )
  .replace('void main()', 'uniform float mode;\n    void main()');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--ignore-gpu-blocklist'],
});
let failed = false,
  unreached = false;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERR', String(e).slice(0, 300)));
  await page.setViewport({ width: 1000, height: 700 });
  await page.evaluateOnNewDocument(() =>
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed'),
  );
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__godsEyeView?.viewer?.scene, {
    timeout: 120000,
  });
  await sleep(12000);
  await page.evaluate(async (fs) => {
    const entry = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((n) => /\.vite\/deps\/cesium\.js/.test(n));
    if (!entry)
      throw new Error(
        'run against the Vite dev server (needs .vite/deps/cesium.js)',
      );
    const C = (window.__C = await import(entry));
    window.__dbg = window.__godsEyeView.viewer.scene.postProcessStages.add(
      new C.PostProcessStage({ fragmentShader: fs, uniforms: { mode: 1 } }),
    );
  }, fs);
  const setView = (v) =>
    page.evaluate((v) => {
      const C = window.__C,
        s = window.__godsEyeView.viewer.scene;
      s.camera.cancelFlight();
      s.camera.setView({
        destination: C.Cartesian3.fromDegrees(v.lon, v.lat, v.h),
        orientation: {
          heading: C.Math.toRadians(v.heading ?? 0),
          pitch: C.Math.toRadians(v.pitch),
          roll: 0,
        },
      });
      s.requestRender();
    }, v);
  // returns per-pixel {exempt, raw1, ground?} counts
  const measure = (truth) =>
    page.evaluate((truth) => {
      const s = window.__godsEyeView.viewer.scene;
      const read = () => {
        s.requestRender();
        s.render();
        const gl = s.context._gl,
          w = gl.drawingBufferWidth,
          h = gl.drawingBufferHeight,
          px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };
      window.__dbg.uniforms.mode = 1;
      const px = read();
      let g;
      if (truth) {
        const keep = [s.skyAtmosphere, s.skyBox, s.sun, s.moon].map(
          (o) => o && o.show,
        );
        [s.skyAtmosphere, s.skyBox, s.sun, s.moon].forEach(
          (o) => o && (o.show = false),
        );
        window.__dbg.uniforms.mode = 0;
        g = read();
        [s.skyAtmosphere, s.skyBox, s.sun, s.moon].forEach(
          (o, i) => o && (o.show = keep[i]),
        );
        window.__dbg.uniforms.mode = 1;
      }
      const r = {
        total: px.length / 4,
        near: s._view.frustumCommandsList[0]?.near ?? null,
        frusta: s._view.frustumCommandsList.length,
        geom: 0,
        geomExempt: 0,
        raw1: 0,
        raw1Exempt: 0,
        ground: 0,
        groundRaw1: 0,
        groundExempt: 0,
        clearGlobeDepth: s._environmentState.clearGlobeDepth,
      };
      for (let i = 0; i < px.length; i += 4) {
        const ex = px[i] > 127,
          raw1 = px[i + 1] > 127;
        if (raw1) {
          r.raw1++;
          if (ex) r.raw1Exempt++;
        } else {
          r.geom++;
          if (ex) r.geomExempt++;
        }
        if (g && g[i] + g[i + 1] + g[i + 2] > 6) {
          r.ground++;
          if (raw1) r.groundRaw1++;
          if (ex) r.groundExempt++;
        }
      }
      return r;
    }, truth);
  const verdict = (name, ok, reached, msg, r) => {
    const tag = !reached ? 'UNREACHED' : ok ? 'PASS' : 'FAIL';
    if (!reached) unreached = true;
    else if (!ok) failed = true;
    console.log(`${tag} ${name}: ${msg}\n     ${JSON.stringify(r)}`);
  };

  for (const c of CASES) {
    if (c === 'satellites') {
      await page.evaluate(() =>
        window.__godsEyeView.dataManager.setEnabled('satellites', true, {
          origin: 'user',
        }),
      );
      await sleep(20000);
      await setView({ lon: 10, lat: 20, h: 2.0e7, pitch: -90 });
      await sleep(5000);
      const r = await measure(false);
      verdict(
        'satellites',
        r.geomExempt <= 0.01 * r.geom,
        r.frusta > 0 && r.near !== null && r.near < 1 && r.geom > 50000,
        `${r.geomExempt} of ${r.geom} Earth pixels exempt from cel-shading (near ${r.near} m)`,
        r,
      );
      await page.evaluate(() =>
        window.__godsEyeView.dataManager.setEnabled('satellites', false, {
          origin: 'user',
        }),
      );
      await sleep(5000);
    } else if (c === 'keyless') {
      await setView({
        lon: -104.99,
        lat: 39.74,
        h: 1700,
        heading: 270,
        pitch: 0,
      });
      await sleep(25000);
      const r = await measure(true);
      verdict(
        'keyless',
        r.groundExempt <= 0.01 * r.ground,
        r.clearGlobeDepth && r.groundRaw1 > 1000,
        `${r.groundExempt} of ${r.ground} terrain pixels exempt (${r.groundRaw1} terrain pixels have raw depth 1.0)`,
        r,
      );
    } else if (c === 'milkyway') {
      const r = await page.evaluate(async () => {
        const C = window.__C,
          g = window.__godsEyeView,
          v = g.viewer,
          s = v.scene;
        window.__dbg.enabled = false;
        g.styleManager.setStyle('anime', { userInitiated: true });
        const t = v.clock.currentTime;
        await C.Transforms.preloadIcrfFixed(
          new C.TimeInterval({
            start: C.JulianDate.addDays(t, -1, new C.JulianDate()),
            stop: C.JulianDate.addDays(t, 1, new C.JulianDate()),
          }),
        );
        const m = C.Transforms.computeIcrfToFixedMatrix(t);
        const ra = C.Math.toRadians(266.4),
          dec = C.Math.toRadians(-29);
        const look = C.Matrix3.multiplyByVector(
          m,
          new C.Cartesian3(
            Math.cos(dec) * Math.cos(ra),
            Math.cos(dec) * Math.sin(ra),
            Math.sin(dec),
          ),
          new C.Cartesian3(),
        );
        const north = C.Matrix3.multiplyByVector(
          m,
          C.Cartesian3.UNIT_Z,
          new C.Cartesian3(),
        );
        const right = C.Cartesian3.normalize(
          C.Cartesian3.cross(look, north, new C.Cartesian3()),
          new C.Cartesian3(),
        );
        s.camera.cancelFlight();
        s.camera.setView({
          destination: C.Cartesian3.multiplyByScalar(
            look,
            3e7,
            new C.Cartesian3(),
          ),
          orientation: {
            direction: look,
            up: C.Cartesian3.cross(right, look, new C.Cartesian3()),
          },
        });
        await new Promise((res) => setTimeout(res, 2500));
        s.requestRender();
        s.render();
        const gl = s.context._gl,
          w = gl.drawingBufferWidth,
          h = gl.drawingBufferHeight,
          px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let banded = 0;
        for (let i = 0; i < px.length; i += 4)
          if (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2] >= 51)
            banded++;
        const out = {
          total: px.length / 4,
          banded,
          visibility: s.skyBox.milkyWayVisibility,
          animeOn: (() => {
            const stages = s.postProcessStages;
            for (let i = 0; i < stages.length; i++) {
              const stage = stages.get(i);
              if (stage.name === 'godsEyeView_anime')
                return stage.enabled && stage.uniforms.intensity > 0.99;
            }
            return false;
          })(),
        };
        g.styleManager.setStyle('normal', { userInitiated: true });
        window.__dbg.enabled = true;
        return out;
      });
      verdict(
        'milkyway',
        r.banded <= 0.005 * r.total,
        r.total > 0 && r.animeOn,
        `${r.banded} of ${r.total} sky pixels at or above the first cel band (luma >= 0.2)`,
        r,
      );
    }
  }
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : unreached ? 2 : 0;
