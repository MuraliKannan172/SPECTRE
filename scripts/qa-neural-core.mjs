#!/usr/bin/env node
/**
 * qa-neural-core.mjs — SPECTRE Phase 4 browser smoke test for the Neural Core
 * panel (docs/ADR-001.md, phase 4; brief §9 "sends a chat message against a
 * mock").
 *
 * Drives the real app in headless Chromium against a running dev server
 * (`npm run dev`, default :4173). Every /api/intel/chat* request is answered by
 * request interception with the payloads the intel service sends, and the news
 * feed with an empty live page, so neither the service nor Ollama is needed.
 *
 *   (i)   READY — the header shows the model, its load state and the search
 *         provider from /chat/status.
 *   (ii)  TURN — a message streams an answer; the globe tools the "model" asks
 *         for really run (the camera moves, the News layer turns on) and their
 *         results are posted back; the answer shows tool progress, a citation
 *         chip, its source list, "As of" and tokens/s. Regenerate re-asks the
 *         question; Clear asks once more before deleting the history.
 *   (iii) OFFLINE — with Ollama reported unreachable, the header and the turn
 *         both say so plainly.
 *   (iv)  VOICE — push-to-talk with Chrome's fake microphone: without the
 *         models the mic says how to install them; held and released, the
 *         recording is transcribed (mocked), sent as the question and the
 *         answer is spoken sentence by sentence; a press while it speaks
 *         stops it, and the rest of the answer is never requested.
 *   (v)   PHONE — at 375 px the panel is a sheet above the tab bar with no
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
const LAYER_CALL_ID = 'c'.repeat(12);
const NEWS_FRESHNESS = {
  state: 'live',
  stale: false,
  offline: false,
  updated_at: new Date().toISOString(),
  age_seconds: 60,
  poll_seconds: 600,
};
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
    // A SPECTRE layer that only the Neural Core's copy of the enum names.
    ['tool_status', { tool: 'set_layer_visibility', state: 'start' }],
    [
      'client_tool',
      {
        turn_id: TURN_ID,
        call_id: LAYER_CALL_ID,
        name: 'set_layer_visibility',
        args: { layerId: 'news', enabled: true },
      },
    ],
    ['tool_status', { tool: 'set_layer_visibility', state: 'done' }],
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

// Local voice (shapes from intel/app/api/voice.py).
const VOICE_STATUS = {
  missing: {
    state: 'unavailable',
    reason: 'models_missing',
    error: null,
    speaks: ['en'],
  },
  ready: { state: 'ready', reason: null, error: null, speaks: ['en'] },
};
const SPOKEN_QUESTION = 'Fly to Tokyo and show me the news.';
const SPOKEN_TURN = sse([
  ['turn', { turn_id: TURN_ID, conversation_id: 1 }],
  ['token', { text: 'The first sentence is about Tokyo. ' }],
  ['token', { text: 'The second one names the layer. ' }],
  ['token', { text: 'The third one would end it.' }],
  ['done', { model: 'bonsai-2:9b', tokens_per_s: 60, citations: [] }],
]);
const SPEAK_DELAY_MS = 600;

/** `seconds` of silence as a 16 kHz mono 16-bit WAV file. */
function silentWav(seconds) {
  const samples = Math.round(16_000 * seconds);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}
const CLIP = silentWav(2);

let mode = 'ready';
let voiceMode = 'missing';
const transcribed = [];
const spokenTexts = [];
const toolResults = [];
const turnBodies = [];
let historyCleared = 0;

async function intercept(request) {
  const url = new URL(request.url());
  const json = (body, status = 200) =>
    request.respond({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  if (url.pathname === '/api/intel/chat/status') return json(STATUS[mode]);
  if (url.pathname === '/api/intel/chat/history') {
    if (request.method() === 'DELETE') {
      historyCleared += 1;
      return request.respond({ status: 204, body: '' });
    }
    return json({ conversation_id: null, messages: [] });
  }
  if (url.pathname === '/api/intel/chat/tool-result') {
    toolResults.push(JSON.parse(request.postData() || '{}'));
    return request.respond({ status: 204, body: '' });
  }
  // An empty but live news feed, so the News layer can turn on.
  if (url.pathname === '/api/intel/news/stream')
    return request.respond({ status: 204, body: '' });
  if (url.pathname === '/api/intel/news')
    return json({ items: [], next_cursor: null, freshness: NEWS_FRESHNESS });
  if (url.pathname === '/api/intel/health') return json({ state: 'live' });
  if (url.pathname === '/api/intel/voice/status')
    return json(VOICE_STATUS[voiceMode]);
  if (url.pathname === '/api/intel/voice/transcribe') {
    // A binary body is not in postData(); fetch it to see it was sent.
    const body = request.hasPostData()
      ? await request.fetchPostData().catch(() => '')
      : '';
    transcribed.push({
      type: request.headers()['content-type'] || '',
      bytes: body?.length ?? 0,
    });
    return json({ text: SPOKEN_QUESTION, language: 'en', seconds: 0.4 });
  }
  if (url.pathname === '/api/intel/voice/speak') {
    spokenTexts.push(JSON.parse(request.postData() || '{}').text);
    return sleep(SPEAK_DELAY_MS).then(() =>
      request.respond({
        status: 200,
        contentType: 'audio/wav',
        headers: { 'X-Voice-Seconds': '0.2' },
        body: CLIP,
      }),
    );
  }
  if (url.pathname === '/api/intel/chat' && request.method() === 'POST') {
    const body = JSON.parse(request.postData() || '{}');
    turnBodies.push(body);
    return request.respond({
      status: 200,
      contentType: 'text/event-stream',
      body: body.message === SPOKEN_QUESTION ? SPOKEN_TURN : TURN[mode],
    });
  }
  return request.continue();
}

// ── Page helpers ──────────────────────────────────────────────────────────
async function boot(page) {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.viewer &&
      document.querySelector('.spectre-nc-launcher'),
    { timeout: 90_000 },
  );
  await sleep(3000);
  await page.keyboard.press('Escape');
}

async function openPanel(page) {
  await page.evaluate(() => {
    const panel = document.getElementById('spectre-neural-core');
    if (panel.hidden) document.querySelector('.spectre-nc-launcher').click();
  });
  await page.waitForFunction(
    () =>
      document.querySelector('.spectre-nc-status')?.textContent.includes('·') ||
      document.querySelector('.spectre-nc-status')?.dataset.tone === 'offline',
    { timeout: 15_000 },
  );
}

async function ask(page, text) {
  await page.evaluate((message) => {
    const panel = document.getElementById('spectre-neural-core');
    panel.querySelector('.spectre-nc-input').value = message;
    panel.querySelector('.spectre-nc-composer').requestSubmit();
  }, text);
  await page.waitForFunction(
    () =>
      document.getElementById('spectre-neural-core').dataset.busy === 'false',
    { timeout: 30_000 },
  );
  return page.evaluate(() => {
    const panel = document.getElementById('spectre-neural-core');
    const answer = [
      ...panel.querySelectorAll('.spectre-nc-msg.is-assistant'),
    ].at(-1);
    const visible = (selector) => {
      const node = answer.querySelector(selector);
      return node && !node.hidden ? node.textContent : null;
    };
    return {
      text: answer.querySelector('.spectre-nc-text').textContent,
      chips: [...answer.querySelectorAll('a.spectre-nc-cite')].map((a) => ({
        n: a.textContent,
        href: a.href,
        rel: a.rel,
        target: a.target,
      })),
      sources: answer.querySelectorAll('.spectre-nc-source').length,
      asOf: visible('.spectre-nc-asof'),
      error: visible('.spectre-nc-error'),
      meta: visible('.spectre-nc-meta'),
      tools: [...answer.querySelectorAll('.spectre-nc-tool')].map(
        (chip) => `${chip.dataset.state}:${chip.textContent}`,
      ),
    };
  });
}

/**
 * Hold the mic button down with the mouse (a real gesture): with
 * `untilListening`, first until the panel says the microphone is recording
 * (it can take a moment to open), then for `ms` more, as a person would.
 */
async function holdMic(page, ms, { untilListening = false } = {}) {
  const box = await (await page.$('.spectre-nc-mic')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  if (untilListening)
    await page
      .waitForFunction(
        () =>
          document.querySelector('.spectre-nc-voice')?.dataset.code ===
          'listening',
        { timeout: 10_000 },
      )
      .catch(() => {});
  await sleep(ms);
  await page.mouse.up();
  await sleep(300);
}

function header(page) {
  return page.evaluate(() => ({
    status: document.querySelector('.spectre-nc-status').textContent,
    tone: document.querySelector('.spectre-nc-status').dataset.tone,
    search: document.querySelector('.spectre-nc-search').textContent,
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
  const layerResult = toolResults.find((r) => r.call_id === LAYER_CALL_ID);
  const newsOn = await page.evaluate(() =>
    window.__godsEyeView.dataManager.isEnabled('news'),
  );
  record(
    'The Neural Core can turn on the News layer (a SPECTRE layer)',
    layerResult?.ok === true && newsOn === true,
    JSON.stringify({ ok: layerResult?.ok, newsOn }),
  );
  record(
    'Tool progress is shown and settles',
    answer.tools.join(' | ') ===
      'done:Flying the camera | done:Switching a layer | done:Searching the web',
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
    path: path.join(SHOTS_DIR, 'spectre-neural-core.png'),
  });

  // Regenerate replaces the answer; it does not add a second one.
  await page.evaluate(() =>
    [...document.querySelectorAll('.spectre-nc-regenerate')]
      .find((button) => !button.hidden)
      .click(),
  );
  await page.waitForFunction(
    () =>
      document.getElementById('spectre-neural-core').dataset.busy === 'false',
    { timeout: 30_000 },
  );
  await sleep(300);
  const afterRegenerate = await page.evaluate(() => ({
    answers: document.querySelectorAll('.spectre-nc-msg.is-assistant').length,
    questions: document.querySelectorAll('.spectre-nc-msg.is-user').length,
  }));
  record(
    'Regenerate re-asks the same question and replaces the answer',
    turnBodies.at(-1)?.regenerate === true &&
      afterRegenerate.answers === 1 &&
      afterRegenerate.questions === 1,
    JSON.stringify({ body: turnBodies.at(-1), ...afterRegenerate }),
  );

  // Clear needs two clicks, then empties the conversation.
  await page.evaluate(() => {
    const clear = document.querySelector('.spectre-nc-header .spectre-nc-icon');
    clear.click();
  });
  const armed = await page.evaluate(() => ({
    label: document.querySelector('.spectre-nc-header .spectre-nc-icon')
      .textContent,
    messages: document.querySelectorAll('.spectre-nc-msg').length,
  }));
  await page.evaluate(() =>
    document.querySelector('.spectre-nc-header .spectre-nc-icon').click(),
  );
  await sleep(500);
  const cleared = await page.evaluate(
    () => document.querySelectorAll('.spectre-nc-msg').length,
  );
  record(
    'Clear history asks once more, then deletes and empties the list',
    armed.label === 'Clear?' &&
      armed.messages > 0 &&
      historyCleared === 1 &&
      cleared === 0,
    JSON.stringify({ armed, historyCleared, cleared }),
  );

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

  console.log('(iv) VOICE...');
  mode = 'ready';
  voiceMode = 'missing';
  await boot(page);
  await openPanel(page);
  await page.waitForFunction(
    () =>
      document
        .querySelector('.spectre-nc-mic')
        ?.getAttribute('aria-disabled') === 'true',
    { timeout: 10_000 },
  );
  await holdMic(page, 400);
  const missing = await page.evaluate(() => ({
    title: document.querySelector('.spectre-nc-mic').title,
    hint: document.querySelector('.spectre-nc-voice').textContent,
  }));
  record(
    'Without the models the mic stays visible and says how to install them',
    /scripts\\spectre\.ps1 -Voice/.test(missing.title) &&
      missing.hint === missing.title &&
      transcribed.length === 0,
    JSON.stringify(missing),
  );

  voiceMode = 'ready';
  await boot(page);
  await openPanel(page);
  await page.waitForFunction(
    () =>
      document
        .querySelector('.spectre-nc-mic')
        ?.getAttribute('aria-disabled') === 'false',
    { timeout: 15_000 },
  );
  const turnsBefore = turnBodies.length;
  await holdMic(page, 1500, { untilListening: true });
  await page
    .waitForFunction(
      () =>
        document.querySelector('.is-assistant:last-child')?.dataset
          .voiceFirstAudioMs,
      { timeout: 20_000 },
    )
    .catch(() => {});
  const spoken = await page.evaluate(() => {
    const answer = document.querySelector('.is-assistant:last-child');
    const users = document.querySelectorAll('.is-user');
    return {
      question: users[users.length - 1]?.textContent,
      firstAudioMs: answer?.dataset.voiceFirstAudioMs,
      heardMs: answer?.dataset.voiceHeardMs,
      meta: [...(answer?.querySelectorAll('.spectre-nc-meta') || [])]
        .map((node) => node.textContent)
        .join(' | '),
      hint: document.querySelector('.spectre-nc-voice').textContent,
    };
  });
  record(
    'Held and released, the recording is sent once as audio',
    transcribed.length === 1 &&
      /^audio\//.test(transcribed[0].type) &&
      transcribed[0].bytes > 0,
    JSON.stringify(transcribed),
  );
  record(
    'The transcript is asked as an ordinary question',
    spoken.question === SPOKEN_QUESTION &&
      turnBodies.length === turnsBefore + 1 &&
      turnBodies.at(-1).message === SPOKEN_QUESTION,
    JSON.stringify({ question: spoken.question }),
  );
  record(
    'The answer is spoken sentence by sentence, with its timing shown',
    spokenTexts[0] === 'The first sentence is about Tokyo.' &&
      Number(spoken.firstAudioMs) > 0 &&
      /first word after/.test(spoken.meta) &&
      spoken.hint.startsWith('Speaking'),
    JSON.stringify({ spokenTexts, ...spoken }),
  );
  // A press while it speaks silences it: the second sentence's request is
  // aborted and the third is never made.
  await holdMic(page, 50);
  await sleep(SPEAK_DELAY_MS * 3 + 2500);
  const stopped = await page.evaluate(
    () => document.querySelector('.spectre-nc-voice').textContent,
  );
  record(
    'A press while it speaks stops it, and the rest is never requested',
    spokenTexts.length === 2 && !stopped.startsWith('Speaking'),
    JSON.stringify({ spokenTexts, hint: stopped }),
  );
  await page.screenshot({
    path: path.join(SHOTS_DIR, 'spectre-neural-core-voice.png'),
  });

  console.log('(v) PHONE...');
  mode = 'ready';
  await page.setViewport({ width: 375, height: 812, isMobile: true });
  await boot(page);
  await openPanel(page);
  const phone = await page.evaluate(() => {
    const panel = document
      .getElementById('spectre-neural-core')
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
    path: path.join(SHOTS_DIR, 'spectre-neural-core-375px.png'),
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
      // A fake microphone (a tone) granted without a prompt, for section (iv).
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
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
