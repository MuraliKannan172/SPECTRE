#!/usr/bin/env node
/**
 * qa-skynet-news.mjs — SKYNET Phase 3 smoke test (docs/ADR-001.md, phase 3).
 *
 * Drives the real app in headless Chromium against a running dev server
 * (`npm run dev`, default :4173). Every /api/intel/* and /api/eonet request
 * is answered from fixtures by request interception, so neither the intel
 * service nor the network is needed for these layers.
 *
 *   (i)   NEWS — the layer loads the fixture feed and draws one point per
 *         placed story; a pick at a projected story hits that story.
 *   (ii)  TICKER + DRAWER — the ticker shows the newest headline; the drawer
 *         lists every story (placed or not), links outlets with noopener,
 *         cites GDELT, filters by search and closes on Escape.
 *   (iii) EONET — the Natural Events layer draws one point per event.
 *   (iv)  SHARE LINK — the hash carries both layers and the News window and
 *         category filter; the link alone restores all of it in a fresh
 *         browser context (no local storage).
 *   (v)   TOGGLES — turning each layer off hides it (and the ticker), and
 *         turning News back on redraws it.
 *
 * Screenshot saved to qa-shots/ (gitignored). Exits non-zero on any FAIL.
 * Run:  node scripts/qa-skynet-news.mjs [--url http://localhost:4173] [--headful]
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

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Fixtures ──────────────────────────────────────────────────────────────
const NOW = Date.now();
const ago = (hours) => new Date(NOW - hours * 3600_000).toISOString();
function story(id, title, category, hoursAgo, place, sources, extra = {}) {
  return {
    id,
    title,
    category,
    severity: 2,
    summary: `${title} (fixture).`,
    url: `https://example.org/story/${id}`,
    published_at: ago(hoursAgo),
    first_seen_at: ago(hoursAgo),
    location: place,
    source_count: sources.length,
    sources,
    ...extra,
  };
}
const outlet = (name, url, feedId) => ({
  name,
  url,
  feed_id: feedId,
  published_at: ago(1),
});
const placed = (lat, lon, placeName, countryCode) => ({
  lat,
  lon,
  place_name: placeName,
  country_code: countryCode,
  confidence: 0.9,
  on_globe: true,
});
const STORIES = [
  story(
    101,
    'Fixture quake shakes Tokyo Bay',
    'disaster',
    1,
    placed(35.68, 139.69, 'Tokyo', 'JP'),
    [
      outlet('Outlet A', 'https://a.example/101', 'a'),
      outlet('Outlet B', 'https://b.example/101', 'b'),
    ],
    { severity: 4 },
  ),
  story(
    102,
    'Fixture clinic opens in Nairobi',
    'health',
    3,
    placed(-1.29, 36.82, 'Nairobi', 'KE'),
    [outlet('example.org', 'https://example.org/102', 'gdelt-health')],
  ),
  story(
    103,
    'Fixture launch window opens over Lima',
    'space',
    5,
    placed(-12.05, -77.04, 'Lima', 'PE'),
    [outlet('Outlet C', 'https://c.example/103', 'c')],
  ),
  story(
    104,
    'Fixture markets close mixed',
    'economy',
    2,
    {
      lat: 0,
      lon: 0,
      place_name: null,
      country_code: null,
      confidence: 0.2,
      on_globe: false,
    },
    [outlet('Outlet D', 'https://d.example/104', 'd')],
  ),
];
const PLACED = STORIES.filter((item) => item.location.on_globe);
// Section (iv) narrows News to 72 h of disaster and space stories.
const FILTER = { windowHours: 72, categoryFilter: 'disaster-space' };
const FILTERED = PLACED.filter((item) =>
  ['disaster', 'space'].includes(item.category),
);
const FRESHNESS = {
  state: 'live',
  stale: false,
  offline: false,
  updated_at: ago(0.02),
  age_seconds: 60,
  poll_seconds: 600,
};
const EVENTS = [
  {
    id: 'EONET_9001',
    title: 'Fixture wildfire, Mendocino',
    category: { id: 'wildfires', title: 'Wildfires' },
    lat: 39.3,
    lon: -123.4,
    observedAt: ago(10),
    sources: [{ id: 'InciWeb', url: 'https://inciweb.wildfire.gov/' }],
  },
  {
    id: 'EONET_9002',
    title: 'Fixture volcano, Etna',
    category: { id: 'volcanoes', title: 'Volcanoes' },
    lat: 37.75,
    lon: 14.99,
    observedAt: ago(30),
    sources: [{ id: 'SIVolcano', url: 'https://volcano.si.edu/' }],
  },
];

function newsPage(searchParams) {
  const q = (searchParams.get('q') || '').toLowerCase();
  const items = (
    searchParams.get('located') === 'true' ? PLACED : STORIES
  ).filter((item) => !q || item.title.toLowerCase().includes(q));
  return { items, next_cursor: null, freshness: FRESHNESS };
}

function respondJson(request, body, status = 200) {
  return request.respond({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function intercept(request) {
  const url = new URL(request.url());
  if (url.pathname === '/api/intel/news/stream')
    return request.respond({ status: 204, body: '' });
  if (url.pathname === '/api/intel/news')
    return respondJson(request, newsPage(url.searchParams));
  if (url.pathname === '/api/intel/health')
    return respondJson(request, { state: 'live' });
  if (url.pathname === '/api/eonet')
    return respondJson(request, {
      events: EVENTS,
      stale: false,
      fetchedAt: ago(0.1),
    });
  return request.continue();
}

// ── Page probes ───────────────────────────────────────────────────────────
async function boot(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(
    () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
    { timeout: 90_000 },
  );
  await sleep(3000);
  await page.keyboard.press('Escape');
}

/** Poll in the page until `probe(state)` is truthy or the deadline passes. */
async function waitFor(page, probe, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await layerState(page);
    if (probe(state)) return state;
    await sleep(500);
  }
  return state;
}

function layerState(page) {
  return page.evaluate(() => {
    const { dataManager: dm, viewer } = window.__godsEyeView;
    const sources = [...Array(viewer.dataSources.length).keys()].map((i) =>
      viewer.dataSources.get(i),
    );
    const source = (name) => {
      const found = sources.find((candidate) => candidate.name === name);
      return found
        ? {
            show: found.show,
            points: found.entities.values.filter((entity) => entity.point)
              .length,
          }
        : null;
    };
    const ticker = document.getElementById('skynet-news-ticker');
    const hash = new URLSearchParams(location.hash.slice(1));
    return {
      news: {
        enabled: dm.isEnabled('news'),
        source: source('news'),
        params: dm.layers.get('news')?.module?.getParams?.() ?? null,
      },
      eonet: {
        enabled: dm.isEnabled('natural-events'),
        source: source('natural-events'),
      },
      ticker: ticker ? { hidden: ticker.hidden, text: ticker.innerText } : null,
      drawerHidden:
        document.getElementById('skynet-news-drawer')?.hidden ?? null,
      layerTokens: (hash.get('l') || '').split('.').filter(Boolean),
      newsOptions: (hash.get('lo') || '')
        .split('_')
        .filter((part) => part.startsWith('5.')),
    };
  });
}

/** Fly over one story, render, and pick at its projected window position. */
function pickStory(page, storyId, lon, lat) {
  return page.evaluate(
    async (id, longitude, latitude) => {
      const { viewer } = window.__godsEyeView;
      const d2r = Math.PI / 180;
      const ellipsoid = viewer.scene.globe.ellipsoid;
      try {
        viewer.camera.cancelFlight();
      } catch {
        /* no flight */
      }
      viewer.camera.setView({
        destination: ellipsoid.cartographicToCartesian({
          longitude: longitude * d2r,
          latitude: latitude * d2r,
          height: 3_000_000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      const entity = [...Array(viewer.dataSources.length).keys()]
        .map((i) => viewer.dataSources.get(i))
        .find((source) => source.name === 'news')
        ?.entities.getById(`news:${id}`);
      for (let frame = 0; frame < 20; frame += 1) {
        viewer.scene.requestRender();
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      const position = entity?.position?.getValue(viewer.clock.currentTime);
      const at =
        position && viewer.scene.cartesianToCanvasCoordinates(position);
      if (!at) return { picked: null, reason: 'not projected' };
      for (const [dx, dy] of [
        [0, 0],
        [0, -3],
        [0, 3],
        [-3, 0],
        [3, 0],
      ]) {
        const picked = viewer.scene.pick({ x: at.x + dx, y: at.y + dy });
        const pickedId = picked?.id?.id ?? picked?.id;
        if (pickedId === `news:${id}`) return { picked: pickedId };
      }
      return {
        picked: null,
        reason: `nothing at ${Math.round(at.x)},${Math.round(at.y)}`,
      };
    },
    storyId,
    lon,
    lat,
  );
}

function drawerState(page) {
  return page.evaluate(() => {
    const drawer = document.getElementById('skynet-news-drawer');
    const rows = [...drawer.querySelectorAll('.skynet-news-item')];
    const links = [...drawer.querySelectorAll('.skynet-news-item a')];
    return {
      hidden: drawer.hidden,
      rows: rows.length,
      unplaced: [
        ...drawer.querySelectorAll('.skynet-news-headline:disabled'),
      ].map((button) => button.textContent),
      linksSafe:
        links.length > 0 &&
        links.every(
          (a) =>
            a.target === '_blank' &&
            a.rel === 'noopener noreferrer' &&
            a.href.startsWith('https://'),
        ),
      gdelt: links.some((a) => a.href === 'https://www.gdeltproject.org/'),
      status: drawer.querySelector('.skynet-news-status')?.textContent ?? '',
      focus:
        document.activeElement?.id || document.activeElement?.className || '',
    };
  });
}

// ── Run ───────────────────────────────────────────────────────────────────
const pageErrors = [];

/** A page whose /api/intel and /api/eonet requests get the fixtures. */
async function openPage(context) {
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (request.isInterceptResolutionHandled()) return;
    Promise.resolve(intercept(request)).catch(() => {});
  });
  page.on('pageerror', (error) =>
    pageErrors.push(String(error?.stack || error)),
  );
  return page;
}

async function run(browser) {
  let page = await openPage(browser);
  await boot(page, APP_URL);

  console.log('(i) NEWS — fixture feed through the real layer...');
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('news', true, {
      origin: 'user',
    }),
  );
  let state = await waitFor(
    page,
    (s) => s.news.source?.points === PLACED.length,
  );
  record(
    'News draws one point per placed story',
    state.news.enabled &&
      state.news.source?.show &&
      state.news.source.points === PLACED.length,
    JSON.stringify(state.news),
  );
  const pick = await pickStory(page, 102, 36.82, -1.29);
  record(
    'A pick over Nairobi hits the Nairobi story',
    pick.picked === 'news:102',
    JSON.stringify(pick),
  );

  console.log('(ii) TICKER + DRAWER...');
  record(
    'Ticker shows the newest headline',
    state.ticker &&
      !state.ticker.hidden &&
      state.ticker.text.includes(STORIES[0].title),
    JSON.stringify(state.ticker),
  );
  await page.click('#skynet-news-toggle');
  await sleep(1500);
  let drawer = await drawerState(page);
  record(
    'Drawer lists every story, placed or not',
    !drawer.hidden && drawer.rows === STORIES.length,
    `rows=${drawer.rows} status=${drawer.status}`,
  );
  record(
    'The unplaced story cannot fly anywhere',
    drawer.unplaced.length === 1 && drawer.unplaced[0].includes('markets'),
    JSON.stringify(drawer.unplaced),
  );
  record(
    'Outlet links open in a new tab with noopener noreferrer',
    drawer.linksSafe,
  );
  record('GDELT stories carry the GDELT link', drawer.gdelt);
  await page.type('.skynet-news-search', 'Nairobi');
  await sleep(1500);
  drawer = await drawerState(page);
  record('Search narrows the list', drawer.rows === 1, `rows=${drawer.rows}`);
  await page.keyboard.press('Escape');
  await sleep(300);
  drawer = await drawerState(page);
  record(
    'Escape closes the drawer and returns focus to the toggle',
    drawer.hidden && drawer.focus === 'skynet-news-toggle',
    `focus=${drawer.focus}`,
  );

  console.log('(iii) EONET...');
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('natural-events', true, {
      origin: 'user',
    }),
  );
  state = await waitFor(page, (s) => s.eonet.source?.points === EVENTS.length);
  record(
    'Natural Events draws one point per event',
    state.eonet.enabled &&
      state.eonet.source?.show &&
      state.eonet.source.points === EVENTS.length,
    JSON.stringify(state.eonet),
  );

  console.log('(iv) SHARE LINK...');
  // As the row's chips do it: a window chip, then two category chips.
  await page.evaluate(() => {
    const dm = window.__godsEyeView.dataManager;
    dm.setLayerParams('news', { windowHours: 72 }, { origin: 'user' });
    dm.setLayerParams(
      'news',
      { toggleCategory: 'disaster' },
      { origin: 'user' },
    );
    dm.setLayerParams('news', { toggleCategory: 'space' }, { origin: 'user' });
  });
  state = await waitFor(
    page,
    (s) =>
      s.news.source?.points === FILTERED.length && s.newsOptions.length === 2,
    15_000,
  );
  record(
    'The News filter narrows the points and lands in the hash',
    state.news.source?.points === FILTERED.length &&
      state.newsOptions.join('_') === '5.w.72_5.c.disaster-space',
    `points=${state.news.source?.points} lo=${state.newsOptions.join('_')}`,
  );
  state = await waitFor(
    page,
    (s) => s.layerTokens.includes('5') && s.layerTokens.includes('6'),
    10_000,
  );
  record(
    'The share hash carries both layers (tokens 5 and 6)',
    state.layerTokens.includes('5') && state.layerTokens.includes('6'),
    `l=${state.layerTokens.join('.')}`,
  );
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, 'skynet-news.png') });
  const shareUrl = page.url();
  await page.close();
  const fresh = await browser.createBrowserContext();
  page = await openPage(fresh);
  await boot(page, shareUrl);
  state = await waitFor(
    page,
    (s) =>
      s.news.source?.points === FILTERED.length &&
      s.eonet.source?.points === EVENTS.length,
  );
  record(
    'The share link alone restores both layers and the News filter in a fresh context',
    state.news.enabled &&
      state.eonet.enabled &&
      state.news.source?.points === FILTERED.length &&
      state.eonet.source?.points === EVENTS.length &&
      state.news.params?.windowHours === FILTER.windowHours &&
      state.news.params?.categoryFilter === FILTER.categoryFilter,
    JSON.stringify({ news: state.news, eonet: state.eonet }),
  );

  console.log('(v) TOGGLES...');
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('news', false, {
      origin: 'user',
    }),
  );
  state = await waitFor(
    page,
    (s) => s.news.source?.show === false && s.ticker?.hidden === true,
    10_000,
  );
  record(
    'News off hides its points, the ticker and the drawer',
    !state.news.enabled &&
      state.news.source?.show === false &&
      state.ticker?.hidden === true &&
      state.drawerHidden === true,
    JSON.stringify({ news: state.news, ticker: state.ticker?.hidden }),
  );
  record(
    'News off leaves Natural Events on',
    state.eonet.enabled && state.eonet.source?.show === true,
  );
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('news', true, {
      origin: 'user',
    }),
  );
  state = await waitFor(
    page,
    (s) => s.news.source?.show && s.news.source.points === FILTERED.length,
  );
  record(
    'News back on redraws it, filter kept',
    state.news.enabled && state.news.source?.points === FILTERED.length,
  );
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('natural-events', false, {
      origin: 'user',
    }),
  );
  state = await waitFor(page, (s) => s.eonet.source?.show === false, 10_000);
  record(
    'Natural Events off hides its points',
    !state.eonet.enabled && state.eonet.source?.show === false,
  );

  const ours = pageErrors.filter((stack) =>
    /layers\/(news|eonet|satelliteFootprint)\//.test(stack),
  );
  record(
    'No page errors from the SKYNET layers',
    ours.length === 0,
    ours[0] ?? `${pageErrors.length} page errors elsewhere`,
  );
}

async function main() {
  try {
    const response = await fetch(APP_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
      '--window-size=1440,900',
    ],
  });
  try {
    await run(browser);
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
