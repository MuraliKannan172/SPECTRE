#!/usr/bin/env node
/**
 * qa-neural-core.mjs — SKYNET Phase 4 browser smoke test for the Neural Core
 * panel (docs/ADR-001.md, phase 4; brief §9 "sends a chat message against a
 * mock").
 *
 * Drives the real app in headless Chromium against a running dev server
 * (`npm run dev`, default :4173). Every /api/intel/chat* request is answered by
 * request interception with the payloads the intel service sends, so neither
 * the service nor Ollama is needed.
 *
 *   (i)   READY — the header shows the model, its load state and the search
 *         provider from /chat/status.
 *   (ii)  TURN — a message streams an answer; the globe tool the "model" asks
 *         for really runs (the camera moves) and its result is posted back;
 *         the answer shows tool progress, a citation chip, its source list,
 *         "As of" and tokens/s.
 *   (iii) OFFLINE — with Ollama reported unreachable, the header and the turn
 *         both say so plainly.
 *   (iv)  PHONE — at 375 px the panel is a sheet above the tab bar with no
 *         horizontal scroll.
 *
 * Screenshots go to qa-shots/ (gitignored). Exits non-zero on any FAIL.
 * Run:  node scripts/qa-neural-core.mjs [--url http://localhost:4173] [--headful]
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

// ── Mocked intel service (shapes from intel/app/api/chat.py) ──────────────
const TURN_ID = 'a'.repeat(32);
const CALL_ID = 'b'.repeat(12);
const TOKYO = { latitude: 35.68, longitude: 139.69 };
const CITATION = {
  n: 1,
  url: 'https://example.org/quake',
  title: 'Quake report',
  source: 'example.org',
};
const STATUS = {
  ready: {
    model: 'bonsai-2:9b',
    num_ctx: 16384,
    low_resource: false,
    search: {
      provider: 'ddgs',
      keyless: true,
      best_effort: true,
      configured: true,
      problem: null,
    },
    chat_problem: null,
    ollama: { reachable: true, version: '0.40.11' },
    model_present: true,
    tools: true,
    loaded: { size_vram: 3_400_000_000, context_length: 16384 },
  },
  offline: {
    model: 'bonsai-2:9b',
    num_ctx: 16384,
    low_resource: false,
    search: null,
    chat_problem: null,
    ollama: { reachable: false, version: null, error: 'offline' },
    model_present: null,
    tools: null,
    loaded: null,
  },
};
const sse = (events) =>
  events
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
const TURN = {
  ready: sse([
    ['turn', { turn_id: TURN_ID, conversation_id: 1 }],
    ['tool_status', { tool: 'fly_to_location', state: 'start' }],
    [
      'client_tool',
      {
        turn_id: TURN_ID,
        call_id: CALL_ID,
        name: 'fly_to_location',
        args: TOKYO,
      },
    ],
    ['tool_status', { tool: 'fly_to_location', state: 'done' }],
    ['tool_status', { tool: 'web_search', state: 'start', host: null }],
    ['citation', CITATION],
    ['tool_status', { tool: 'web_search', state: 'done' }],
    ['token', { text: 'A magnitude 6.1 quake struck ' }],
    ['token', { text: 'offshore [1].' }],
    [
      'done',
      {
        model: 'bonsai-2:9b',
        tokens_per_s: 60,
        as_of: '2026-10-27 12:00 IST',
        citations: [CITATION],
        degraded: false,
      },
    ],
  ]),
  offline: sse([
    ['turn', { turn_id: TURN_ID, conversation_id: 1 }],
    ['error', { code: 'ollama_offline', message: 'offline' }],
  ]),
};

let mode = 'ready';
const toolResults = [];

function intercept(request) {
  const url = new URL(request.url());
  const json = (body, status = 200) =>
    request.respond({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  if (url.pathname === '/api/intel/chat/status') return json(STATUS[mode]);
  if (url.pathname === '/api/intel/chat/history')
    return json({ conversation_id: null, messages: [] });
  if (url.pathname === '/api/intel/chat/tool-result') {
    toolResults.push(JSON.parse(request.postData() || '{}'));
    return request.respond({ status: 204, body: '' });
  }
  if (url.pathname === '/api/intel/chat' && request.method() === 'POST')
    return request.respond({
      status: 200,
      contentType: 'text/event-stream',
      body: TURN[mode],
    });
  return request.continue();
}

// ── Page helpers ──────────────────────────────────────────────────────────
async function boot(page) {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.viewer &&
      document.querySelector('.skynet-nc-launcher'),
    { timeout: 90_000 },
  );
  await sleep(3000);
  await page.keyboard.press('Escape');
}

async function openPanel(page) {
  await page.evaluate(() => {
    const panel = document.getElementById('skynet-neural-core');
    if (panel.hidden) document.querySelector('.skynet-nc-launcher').click();
  });
  await page.waitForFunction(
    () =>
      document.querySelector('.skynet-nc-status')?.textContent.includes('·') ||
      document.querySelector('.skynet-nc-status')?.dataset.tone === 'offline',
    { timeout: 15_000 },
  );
}

async function ask(page, text) {
  await page.evaluate((message) => {
    const panel = document.getElementById('skynet-neural-core');
    panel.querySelector('.skynet-nc-input').value = message;
    panel.querySelector('.skynet-nc-composer').requestSubmit();
  }, text);
  await page.waitForFunction(
    () =>
      document.getElementById('skynet-neural-core').dataset.busy === 'false',
    { timeout: 30_000 },
  );
  return page.evaluate(() => {
    const panel = document.getElementById('skynet-neural-core');
    const answer = [
      ...panel.querySelectorAll('.skynet-nc-msg.is-assistant'),
    ].at(-1);
    const visible = (selector) => {
      const node = answer.querySelector(selector);
      return node && !node.hidden ? node.textContent : null;
    };
    return {
      text: answer.querySelector('.skynet-nc-text').textContent,
      chips: [...answer.querySelectorAll('a.skynet-nc-cite')].map((a) => ({
        n: a.textContent,
        href: a.href,
        rel: a.rel,
        target: a.target,
      })),
      sources: answer.querySelectorAll('.skynet-nc-source').length,
      asOf: visible('.skynet-nc-asof'),
      error: visible('.skynet-nc-error'),
      meta: visible('.skynet-nc-meta'),
      tools: [...answer.querySelectorAll('.skynet-nc-tool')].map(
        (chip) => `${chip.dataset.state}:${chip.textContent}`,
      ),
    };
  });
}

function header(page) {
  return page.evaluate(() => ({
    status: document.querySelector('.skynet-nc-status').textContent,
    tone: document.querySelector('.skynet-nc-status').dataset.tone,
    search: document.querySelector('.skynet-nc-search').textContent,
  }));
}

function camera(page) {
  return page.evaluate(() => {
    const place = window.__godsEyeView.viewer.camera.positionCartographic;
    return {
      lat: (place.latitude * 180) / Math.PI,
      lon: (place.longitude * 180) / Math.PI,
    };
  });
}

// ── Run ───────────────────────────────────────────────────────────────────
async function run(page) {
  const pageErrors = [];
  page.on('pageerror', (error) =>
    pageErrors.push(String(error?.stack || error)),
  );
  await boot(page);

  console.log('(i) READY...');
  await openPanel(page);
  const ready = await header(page);
  record(
    'Header shows the model, its load state and the search provider',
    ready.tone === 'ready' &&
      ready.status === 'bonsai-2:9b · loaded · 3.4 GB on the GPU' &&
      ready.search === 'Web search: DuckDuckGo via ddgs (best effort)',
    JSON.stringify(ready),
  );

  console.log('(ii) TURN...');
  const answer = await ask(page, 'Fly to Tokyo and tell me about the quake.');
  record(
    'The answer streams in',
    answer.text.startsWith('A magnitude 6.1 quake struck offshore'),
    JSON.stringify(answer.text),
  );
  await sleep(4000); // the camera flight
  const at = await camera(page);
  record(
    'The globe tool really ran: the camera is over Tokyo',
    Math.abs(at.lat - TOKYO.latitude) < 1 &&
      Math.abs(at.lon - TOKYO.longitude) < 1,
    JSON.stringify(at),
  );
  const posted = toolResults[0];
  record(
    'Its result was posted back to the turn',
    posted?.turn_id === TURN_ID &&
      posted?.call_id === CALL_ID &&
      posted?.ok === true,
    JSON.stringify(posted)?.slice(0, 160),
  );
  record(
    'Tool progress is shown and settles',
    answer.tools.join(' | ') ===
      'done:Flying the camera | done:Searching the web',
    answer.tools.join(' | '),
  );
  const chip = answer.chips[0];
  record(
    'The citation is a chip linking its source, opened safely',
    answer.chips.length === 1 &&
      chip.href === CITATION.url &&
      chip.rel === 'noopener noreferrer' &&
      chip.target === '_blank' &&
      answer.sources === 1,
    JSON.stringify(answer.chips),
  );
  record(
    'The answer ends with As of and the model readout',
    answer.asOf === 'As of 2026-10-27 12:00 IST' &&
      answer.meta === 'bonsai-2:9b · 60 tokens/s',
    `${answer.asOf} | ${answer.meta}`,
  );
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(SHOTS_DIR, 'skynet-neural-core.png'),
  });

  console.log('(iii) OFFLINE...');
  mode = 'offline';
  await boot(page);
  await openPanel(page);
  const offline = await header(page);
  const failed = await ask(page, 'Hello?');
  record(
    'With Ollama unreachable the header says so',
    offline.tone === 'offline' &&
      offline.status === 'Ollama is not running. Start Ollama, then try again.',
    JSON.stringify(offline),
  );
  record(
    'And so does the turn',
    failed.error === 'Ollama is not running. Start Ollama, then try again.' &&
      failed.text === '',
    JSON.stringify(failed.error),
  );

  console.log('(iv) PHONE...');
  mode = 'ready';
  await page.setViewport({ width: 375, height: 812, isMobile: true });
  await boot(page);
  await openPanel(page);
  const phone = await page.evaluate(() => {
    const panel = document
      .getElementById('skynet-neural-core')
      .getBoundingClientRect();
    const tabs = document
      .getElementById('mobile-tab-bar')
      ?.getBoundingClientRect();
    return {
      shell: document.body.classList.contains('mobile-shell'),
      left: Math.round(panel.left),
      right: Math.round(panel.right),
      bottom: Math.round(panel.bottom),
      tabsTop: tabs ? Math.round(tabs.top) : null,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  record(
    'At 375 px the panel is a sheet above the tab bar, no sideways scroll',
    phone.shell &&
      phone.left === 0 &&
      phone.right === 375 &&
      phone.bottom <= phone.tabsTop &&
      phone.scrollWidth === 375,
    JSON.stringify(phone),
  );
  await page.screenshot({
    path: path.join(SHOTS_DIR, 'skynet-neural-core-375px.png'),
  });

  const ours = pageErrors.filter((stack) => /neuralCore\//.test(stack));
  record(
    'No page errors from the Neural Core',
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
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (request.isInterceptResolutionHandled()) return;
      Promise.resolve(intercept(request)).catch(() => {});
    });
    await run(page);
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
