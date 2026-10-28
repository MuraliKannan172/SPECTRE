#!/usr/bin/env node
/**
 * qa-spectre-boot.mjs — SPECTRE boot overlay and brand glitch smoke test.
 *
 * Drives the real app in headless Chromium against a running dev server
 * (`npm run dev`, default :4173). /api/intel/* is answered from fixtures by
 * request interception, so neither the intel service nor Ollama is needed.
 *
 *   (i)    ROWS — with the intel service and Ollama ready, all four rows reach
 *          ONLINE from real signals (Cesium's first frame, the layer catalog,
 *          /api/intel/health, /api/intel/chat/status); the overlay then leaves
 *          the DOM, with no console errors on the way.
 *   (ii)   DEGRADED — a failing feed and no Ollama show DEGRADED and OFFLINE.
 *   (iii)  INTEL DOWN — 503s show both service rows OFFLINE; the app opens.
 *   (iv)   TIMEOUT — a health request that never answers is NO RESPONSE
 *          after the probe's 3 s timeout.
 *   (v)    SKIP — a key skips the boot and never reaches the app.
 *   (vi)   REDUCED MOTION — no animation runs on the overlay or the mark.
 *   (vii)  OFF — ?boot=off, ?embed=1 and the Boot animation setting show no
 *          overlay, and the first-paint cover is gone.
 *   (viii) GLITCH — the header mark glitches on hover, not in recording or
 *          clean view, and not with Brand glitch off.
 *   (ix)   PHONE — at 390 px the overlay has no sideways scroll.
 *   (x)    MAX WAIT — with Cesium blocked the app never starts; the globe and
 *          layer rows end as NO RESPONSE at 9 s and the overlay still leaves.
 *
 * Screenshots saved to qa-shots/ (gitignored). Exits non-zero on any FAIL.
 * Run:  node scripts/qa-spectre-boot.mjs [--url http://localhost:4173] [--headful]
 */

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR = path.join(path.resolve(__dirname, '..'), 'qa-shots');
const argv = process.argv.slice(2);
const urlAt = argv.indexOf('--url');
const APP_URL =
  urlAt >= 0 && argv[urlAt + 1] ? argv[urlAt + 1] : 'http://localhost:4173';
const HEADFUL = argv.includes('--headful');
const VIEW = '#v=2&lat=24&lon=10&alt=16000000&heading=0&pitch=-90&roll=0';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Fixtures (shapes from intel/app/api/routes.py and chat.py) ────────────
const minutesAgo = (minutes) =>
  new Date(Date.now() - minutes * 60_000).toISOString();
function feed(id, extra = {}) {
  return {
    id,
    name: `Feed ${id}`,
    state: 'ok',
    consecutive_errors: 0,
    last_attempt_at: minutesAgo(1),
    last_success_at: minutesAgo(1),
    ...extra,
  };
}
function health(feeds, state = 'live') {
  return {
    now: new Date().toISOString(),
    freshness: { state, stale_after_seconds: 900 },
    feeds,
  };
}
const HEALTH = {
  live: () => health([feed('a'), feed('b'), feed('c')]),
  failing: () =>
    health([
      feed('a'),
      feed('b'),
      feed('c', { state: 'error', consecutive_errors: 3 }),
    ]),
};
const CHAT = {
  ready: {
    model: 'qa-model:7b',
    ollama: { reachable: true, version: '0.40.11' },
    model_present: true,
    tools: true,
  },
  noOllama: {
    model: 'qa-model:7b',
    ollama: { reachable: false, version: null },
    model_present: null,
    tools: null,
  },
};

/** How /api/intel/health and /api/intel/chat/status answer on one page. */
function interceptor(scenario) {
  return (request) => {
    const url = new URL(request.url());
    // Cesium.js (build) or Vite's prebundled cesium.js (dev): without it the
    // app never starts, so only the boot's own 9 s release can end it.
    if (scenario === 'no-app' && /\/cesium\.js$/i.test(url.pathname))
      return request.abort();
    const json = (body, status = 200) =>
      request.respond({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    if (!url.pathname.startsWith('/api/intel/')) return request.continue();
    if (scenario === 'down') return json({ error: 'intel_unavailable' }, 503);
    if (url.pathname === '/api/intel/health') {
      if (scenario === 'hang') return undefined; // never answered
      return json(scenario === 'failing' ? HEALTH.failing() : HEALTH.live());
    }
    if (url.pathname === '/api/intel/chat/status')
      return json(scenario === 'failing' ? CHAT.noOllama : CHAT.ready);
    if (url.pathname === '/api/intel/chat/history')
      return json({ conversation_id: null, messages: [] });
    if (url.pathname === '/api/intel/voice/status')
      return json({
        state: 'unavailable',
        reason: 'models_missing',
        error: null,
        speaks: ['en'],
      });
    if (url.pathname === '/api/intel/news/stream')
      return request.respond({ status: 204, body: '' });
    if (url.pathname === '/api/intel/news')
      return json({
        items: [],
        next_cursor: null,
        freshness: { state: 'live' },
      });
    return json({ error: 'not_mocked' }, 404);
  };
}

/**
 * In the page from the first script. The page's main thread is busy loading
 * the app for seconds, when Puppeteer cannot look; this records the overlay's
 * timeline, rows, animations and keys as they happen.
 */
function instrument() {
  const qa = (window.__qa = {
    rows: {},
    keys: [],
    keysReachedApp: 0,
    overlayStart: null,
    overlayGone: null,
    reduced: null,
    maxRunning: 0,
    glitchSeen: false,
  });
  // Registered before the boot's own listener, so it sees every key first.
  window.addEventListener(
    'keydown',
    (event) =>
      qa.keys.push({
        key: event.key,
        at: performance.now(),
        overlay: !!document.querySelector('.sp-boot:not(.is-out)'),
      }),
    true,
  );
  document.addEventListener('keydown', () => {
    qa.keysReachedApp += 1;
  });
  const sample = () => {
    if (!document.querySelector('.sp-boot')) return;
    const running = document
      .getAnimations()
      .filter(
        (a) =>
          a.playState === 'running' &&
          a.constructor.name === 'CSSAnimation' &&
          a.effect?.target?.closest?.('.sp-boot, .sp-part'),
      );
    qa.maxRunning = Math.max(qa.maxRunning, running.length);
    for (const a of running)
      qa.runningNames = [
        ...new Set([...(qa.runningNames || []), a.animationName]),
      ];
    if (document.querySelector('.is-glitch')) qa.glitchSeen = true;
    const detail = document.querySelector('.sp-boot__sys .sp-d');
    qa.layout = {
      scrollWidth: Math.max(
        qa.layout?.scrollWidth || 0,
        document.documentElement.scrollWidth,
      ),
      overlayWidth: Math.round(
        document.querySelector('.sp-boot').getBoundingClientRect().width,
      ),
      detail: detail ? getComputedStyle(detail).display : null,
    };
    requestAnimationFrame(sample);
  };
  new MutationObserver(() => {
    const overlay = document.querySelector('.sp-boot');
    if (overlay && qa.overlayStart == null) {
      qa.overlayStart = performance.now();
      qa.reduced = overlay.dataset.reduced;
      qa.busy = overlay.getAttribute('aria-busy');
      qa.live = overlay
        .querySelector('.sp-boot__sys')
        ?.getAttribute('aria-live');
      qa.decorative = overlay
        .querySelector('.sp-boot__scan')
        ?.getAttribute('aria-hidden');
      requestAnimationFrame(sample);
    }
    if (overlay)
      for (const li of overlay.querySelectorAll('.sp-boot__sys li'))
        qa.rows[li.dataset.id] = {
          state: li.dataset.state,
          detail: li.querySelector('.sp-d').textContent,
          value: li.querySelector('.sp-v').textContent,
          glyph: li.querySelector('.sp-i').textContent,
          at: Math.round(performance.now() - qa.overlayStart),
        };
    if (overlay?.classList.contains('is-out') && qa.outAt == null)
      qa.outAt = performance.now();
    if (!overlay && qa.overlayStart != null && qa.overlayGone == null)
      qa.overlayGone = performance.now();
  }).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
}

const qaState = (page) => page.evaluate(() => window.__qa);

async function openPage(
  browser,
  { scenario = 'ready', width = 1280, height = 720, reduced = false } = {},
) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // Provider Settings asks the dev server's /api/setup/status; the preview
    // server CI runs against has no such route, with or without the boot.
    if (/\/api\/setup\/status$/.test(message.location()?.url || '')) return;
    consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) =>
    consoleErrors.push(String(error?.message || error)),
  );
  await page.setViewport({ width, height });
  if (reduced)
    await page.emulateMediaFeatures([
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ]);
  await page.setRequestInterception(true);
  const answer = interceptor(scenario);
  page.on('request', (request) => {
    if (request.isInterceptResolutionHandled()) return;
    Promise.resolve(answer(request)).catch(() => {});
  });
  await page.evaluateOnNewDocument(instrument);
  return { context, page, consoleErrors };
}

/** Wait until every row has left `pending`; returns the rows as recorded. */
async function settledRows(page, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let rows = {};
  while (Date.now() < deadline) {
    rows = (await qaState(page).catch(() => null))?.rows ?? rows;
    const values = Object.values(rows);
    if (values.length === 4 && values.every((r) => r.state !== 'pending'))
      return rows;
    await sleep(200);
  }
  return rows;
}

async function overlayGone(page, timeoutMs = 20_000) {
  try {
    await page.waitForFunction(() => window.__qa.overlayGone != null, {
      timeout: timeoutMs,
    });
    return true;
  } catch {
    return false;
  }
}

const describeRows = (r) =>
  Object.entries(r)
    .map(
      ([id, row]) =>
        `${id}=${row.value}${row.detail ? ` (${row.detail})` : ''}`,
    )
    .join(', ');

async function run(browser) {
  console.log('(i) ROWS — every row from a real signal...');
  {
    const { context, page, consoleErrors } = await openPage(browser, {
      scenario: 'ready',
    });
    await page.goto(`${APP_URL}/?boot=full${VIEW}`);
    const settled = await settledRows(page);
    const early = await qaState(page);
    record(
      'Overlay is up with aria-busy and a polite live region',
      early.overlayStart != null &&
        early.busy === 'true' &&
        early.live === 'polite' &&
        early.decorative === 'true',
      `in the DOM at ${Math.round(early.overlayStart)} ms`,
    );
    const ok = (id) => settled[id]?.state === 'ok';
    record(
      'All four rows reach ONLINE',
      ['globe', 'layers', 'intel', 'core'].every(ok),
      describeRows(settled),
    );
    record(
      'Rows carry real details (Cesium version, layer and feed counts, model)',
      /^Cesium \d/.test(settled.globe?.detail || '') &&
        /^\d+ layers$/.test(settled.layers?.detail || '') &&
        settled.intel?.detail === '3 feeds' &&
        settled.core?.detail === CHAT.ready.model,
    );
    record(
      'Status is glyph + label, never colour alone',
      Object.values(settled).every(
        (r) => r.glyph && r.value && r.glyph !== r.value,
      ),
    );
    const gone = await overlayGone(page);
    const after = await page.evaluate(() => ({
      overlay: !!document.querySelector('.sp-boot'),
      cover: !!document.getElementById('spectre-boot-cover'),
      viewer: !!window.__godsEyeView?.viewer,
      ms: Math.round(window.__qa.overlayGone - window.__qa.overlayStart),
    }));
    record(
      'Overlay leaves the DOM and the app is up behind it',
      gone && !after.overlay && !after.cover && after.viewer,
      `${after.ms} ms on screen`,
    );
    record(
      'No console errors on load',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(' | '),
    );
    await context.close();
  }

  console.log('(ii) DEGRADED — a failing feed, Ollama not running...');
  {
    const { context, page } = await openPage(browser, { scenario: 'failing' });
    await page.goto(`${APP_URL}/?boot=full${VIEW}`);
    const settled = await settledRows(page);
    record(
      'INTEL SERVICE DEGRADED with stale feeds 1/3',
      settled.intel?.state === 'degraded' &&
        settled.intel?.detail === 'stale feeds 1/3',
      describeRows(settled),
    );
    record(
      'NEURAL CORE OFFLINE when Ollama is not reachable',
      settled.core?.state === 'offline' && settled.core?.value === 'OFFLINE',
    );
    await context.close();
  }

  console.log('(iii) INTEL DOWN — the service answers 503...');
  {
    const { context, page } = await openPage(browser, { scenario: 'down' });
    await page.goto(`${APP_URL}/?boot=full${VIEW}`);
    const settled = await settledRows(page);
    record(
      'INTEL SERVICE and NEURAL CORE show OFFLINE',
      settled.intel?.value === 'OFFLINE' && settled.core?.value === 'OFFLINE',
      describeRows(settled),
    );
    const gone = await overlayGone(page);
    const viewer = await page.evaluate(() => !!window.__godsEyeView?.viewer);
    record('The app still opens', gone && viewer);
    await context.close();
  }

  console.log('(iv) TIMEOUT — a health request that never answers...');
  {
    const { context, page } = await openPage(browser, { scenario: 'hang' });
    await page.goto(`${APP_URL}/?boot=full${VIEW}`);
    await settledRows(page);
    const timing = (await qaState(page)).rows.intel || {};
    record(
      'INTEL SERVICE is NO RESPONSE after about 3 s',
      timing.state === 'timeout' &&
        timing.value === 'NO RESPONSE' &&
        timing.at >= 2900 &&
        timing.at < 5000,
      `${timing.at} ms`,
    );
    await context.close();
  }

  console.log('(v) SKIP — a key ends the boot and stays with the overlay...');
  {
    const { context, page } = await openPage(browser, { scenario: 'hang' });
    // Not awaited: the key goes in while the app is still loading, as a
    // user's would. 'h' is also the HUD shortcut.
    const navigation = page
      .goto(`${APP_URL}/?boot=full${VIEW}`)
      .catch(() => {});
    await sleep(1500);
    await page.keyboard.press('h');
    await navigation;
    await overlayGone(page, 5000);
    const qa = await qaState(page);
    const key = qa.keys[0];
    // The skip itself is synchronous (is-out: transparent, no pointer
    // events); removal follows the fade, on timers the loading app delays.
    record(
      'Key press skips the boot at once, and the overlay is removed',
      key?.overlay === true &&
        qa.outAt != null &&
        qa.outAt - key.at < 50 &&
        qa.overlayGone != null,
      key
        ? `skip applied ${Math.round(qa.outAt - key.at)} ms after the key; removed ${Math.round(qa.overlayGone - key.at)} ms after`
        : 'no key seen',
    );
    record(
      'The skip key never reaches the app',
      qa.keysReachedApp === 0,
      `${qa.keysReachedApp} keydown(s) seen`,
    );
    await context.close();
  }

  console.log('(vi) REDUCED MOTION — static logo, no glitch...');
  {
    const { context, page } = await openPage(browser, {
      scenario: 'ready',
      reduced: true,
    });
    await page.goto(`${APP_URL}/?boot=full${VIEW}`);
    await overlayGone(page);
    const qa = await qaState(page);
    const reduced = {
      flag: qa.reduced,
      maxRunning: qa.maxRunning,
      names: qa.runningNames,
      rows: Object.fromEntries(
        Object.entries(qa.rows).map(([id, r]) => [id, `${r.state}@${r.at}`]),
      ),
      glitchSeen: qa.glitchSeen,
      onScreenMs: Math.round(qa.overlayGone - qa.overlayStart),
    };
    record(
      'Overlay is static for its whole life: no running animation, no glitch',
      reduced.flag === '1' && reduced.maxRunning === 0 && !reduced.glitchSeen,
      JSON.stringify(reduced),
    );
    const hover = await page.evaluate(async () => {
      const mark = document.querySelector('#title-bar .title-logo');
      mark.dispatchEvent(new PointerEvent('pointerenter'));
      await new Promise((r) => setTimeout(r, 120));
      return mark.classList.contains('is-glitch');
    });
    record('Header mark does not glitch under reduced motion', hover === false);
    await context.close();
  }

  console.log('(vii) OFF — URL, embed and the Boot animation setting...');
  for (const query of ['?boot=off', '?embed=1']) {
    const { context, page } = await openPage(browser, { scenario: 'ready' });
    await page.goto(`${APP_URL}/${query}${VIEW}`);
    await page.waitForFunction(() => window.__godsEyeView?.viewer, {
      timeout: 60_000,
    });
    const state = await page.evaluate(() => ({
      ever: window.__qa.overlayStart != null,
      cover: !!document.getElementById('spectre-boot-cover'),
    }));
    record(
      `${query} shows no overlay and drops the cover`,
      !state.ever && !state.cover,
      JSON.stringify(state),
    );
    await context.close();
  }
  {
    const { context, page } = await openPage(browser, { scenario: 'ready' });
    await page.goto(`${APP_URL}/?boot=off${VIEW}`);
    await page.waitForSelector('.spectre-brand-settings select', {
      timeout: 60_000,
    });
    const saved = await page.evaluate(() => {
      const select = document.querySelector('.spectre-brand-settings select');
      select.value = 'off';
      select.dispatchEvent(new Event('change'));
      return localStorage.getItem('spectre.boot.animation');
    });
    await page.goto(`${APP_URL}/${VIEW}`);
    await page.waitForFunction(() => window.__godsEyeView?.viewer, {
      timeout: 60_000,
    });
    const ever = await page.evaluate(() => window.__qa.overlayStart != null);
    record(
      'Boot animation Off is saved and honoured on the next load',
      saved === 'off' && !ever,
      `saved=${saved}`,
    );
    await context.close();
  }

  console.log(
    '(viii) GLITCH — header mark on hover, never in recording or clean view...',
  );
  {
    const { context, page } = await openPage(browser, { scenario: 'ready' });
    await page.goto(`${APP_URL}/?boot=off${VIEW}`);
    await page.waitForSelector('.spectre-brand-settings select', {
      timeout: 60_000,
    });
    const hoverGlitches = (bodyClass) =>
      page.evaluate(async (cls) => {
        document.body.classList.remove('recording-mode', 'ui-clean-view');
        if (cls) document.body.classList.add(cls);
        const mark = document.querySelector('#title-bar .title-logo');
        await new Promise((r) => setTimeout(r, 1300)); // past the hover cooldown
        mark.dispatchEvent(new PointerEvent('pointerenter'));
        await new Promise((r) => setTimeout(r, 60));
        const glitched = mark.classList.contains('is-glitch');
        document.body.classList.remove('recording-mode', 'ui-clean-view');
        return glitched;
      }, bodyClass);
    const plain = await hoverGlitches(null);
    const recording = await hoverGlitches('recording-mode');
    const clean = await hoverGlitches('ui-clean-view');
    record('Header mark glitches on hover', plain === true);
    record('Silent in recording mode', recording === false);
    record('Silent in clean view', clean === false);
    const parts = await page.evaluate(() => ({
      ghosts: document.querySelectorAll('#title-bar .title-logo .sp-ghost')
        .length,
      outside: [...document.querySelectorAll('.sp-part')].filter(
        (el) => !el.closest('#title-bar .title-logo, .sp-lockup'),
      ).length,
    }));
    record(
      'Glitch layers sit on the logo only',
      parts.ghosts === 2 && parts.outside === 0,
      JSON.stringify(parts),
    );
    await page.evaluate(() => {
      const select = document.querySelectorAll(
        '.spectre-brand-settings select',
      )[1];
      select.value = 'off';
      select.dispatchEvent(new Event('change'));
    });
    const off = await hoverGlitches(null);
    const saved = await page.evaluate(() =>
      localStorage.getItem('spectre.brand.glitch'),
    );
    record(
      'Brand glitch Off stops it and is saved',
      off === false && saved === 'off',
    );
    await context.close();
  }

  console.log('(ix) PHONE — 390 x 760...');
  {
    const { context, page } = await openPage(browser, {
      scenario: 'ready',
      width: 390,
      height: 760,
    });
    await page.goto(`${APP_URL}/?boot=full${VIEW}`);
    await overlayGone(page);
    const layout = (await qaState(page)).layout || {};
    record(
      'No sideways scroll; the detail column drops',
      layout.scrollWidth <= 390 &&
        layout.overlayWidth === 390 &&
        layout.detail === 'none',
      JSON.stringify(layout),
    );
    await context.close();
  }
}

async function runMaxWait(browser) {
  console.log('(x) MAX WAIT — the app never starts...');
  const { context, page } = await openPage(browser, { scenario: 'no-app' });
  await page.goto(`${APP_URL}/?boot=full${VIEW}`);
  await overlayGone(page, 20_000);
  const qa = await qaState(page);
  const late = (id) =>
    qa.rows[id]?.state === 'timeout' && qa.rows[id]?.at >= 8800;
  record(
    'GLOBE ENGINE and DATA LAYERS are NO RESPONSE at 9 s',
    late('globe') && late('layers') && qa.rows.globe?.value === 'NO RESPONSE',
    `globe ${qa.rows.globe?.state}@${qa.rows.globe?.at} ms, layers ${qa.rows.layers?.state}@${qa.rows.layers?.at} ms`,
  );
  const cover = await page.evaluate(
    () => !!document.getElementById('spectre-boot-cover'),
  );
  record(
    'The overlay and the cover still leave',
    qa.overlayGone != null && !cover,
  );
  await context.close();
}

async function main() {
  try {
    await fetch(APP_URL);
  } catch (error) {
    console.error(
      `No dev server at ${APP_URL} (${error.message}). Start one with: npm run dev`,
    );
    process.exit(2);
  }
  const executablePath = await puppeteer.executablePath();
  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    ...(executablePath && fs.existsSync(executablePath)
      ? { executablePath }
      : {}),
    args: [
      '--no-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--window-size=1280,720',
    ],
  });
  try {
    await run(browser);
    await runMaxWait(browser);
  } finally {
    await browser.close();
  }
  const failed = results.filter((result) => !result.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed.`,
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
