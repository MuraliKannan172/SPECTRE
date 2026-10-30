#!/usr/bin/env node
/**
 * qa-neural-core-providers.mjs: SPECTRE browser smoke test for the Neural Core
 * providers (docs/ADR-002-providers.md §3, P4). Puppeteer, like every QA
 * script here (the brief said Playwright; the ADR records the deviation).
 *
 * Drives the real app in headless Chromium against a running dev server
 * (`npm run dev`, :4173). /api/intel/* is a stateful mock of the intel
 * service's provider and chat routes, so neither the service nor any API key
 * is needed; the mock enforces the session token on every write.
 *
 *   (i)   CHIP: the header chip says where the model runs, in text; the
 *         settings view lists every provider with a text badge.
 *   (ii)  KEYS: a canary key typed into POWER UP's Neural Core row goes to
 *         PUT /providers/{id}/key once, the field is cleared, and the key is
 *         in no DOM text or field, localStorage, sessionStorage or IndexedDB,
 *         and never reaches POWER UP's own save.
 *   (iii) CONSENT: choosing a cloud model opens the dialog with focus on
 *         Cancel; Tab stays inside; Escape cancels, restores focus and
 *         changes nothing; Allow grants consent and selects the model; the
 *         chip and the disclaimer then name the cloud provider.
 *   (iv)  NO SILENT FALLBACK: local-only mode refuses the turn with a way
 *         out, and a provider failure offers Retry; neither switches
 *         provider on its own.
 *   (v)   BUDGET: the budget event offers Continue, a gated write.
 *   (vi)  MARKUP: model output with <script> and <img onerror> renders as
 *         text and runs nothing.
 *   (vii) PHONE: at 390 px the settings view has no sideways scroll.
 *
 * Screenshots go to qa-shots/ (gitignored). Exits non-zero on any FAIL.
 * Run:  node scripts/qa-neural-core-providers.mjs [--url http://localhost:4173] [--headful]
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
const CANARY = 'sk-test-CANARY-qa0123456789abcdef';
const TOKEN = 'qa-session-token';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Mocked intel service (shapes from intel/app/api/providers.py, chat.py) ──
const state = {
  keys: { anthropic: false },
  consent: { anthropic: false },
  policy: {
    local_only: false,
    map_context: true,
    session_budget: 100000,
    context_ceiling: 16384,
  },
  selection: null,
  turn: 'answer',
};
const writes = [];
const turns = [];
const leaks = [];

function providerView(id) {
  const base = {
    ollama: { label: 'Ollama', kind: 'local', key: { required: false } },
    anthropic: {
      label: 'Claude (Anthropic API)',
      kind: 'cloud',
      adapter: 'anthropic',
      key: {
        required: true,
        configured: state.keys.anthropic,
        source: state.keys.anthropic ? 'keyring' : null,
        env: ['ANTHROPIC_API_KEY'],
        writable: true,
      },
    },
  }[id];
  return {
    id,
    docs: null,
    base_url:
      id === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.anthropic.com',
    base_url_editable: id !== 'ollama',
    workspace_id: null,
    adapter: base.adapter || id,
    params: {},
    chat_completions_models: [],
    consent: Boolean(state.consent[id]),
    ...base,
  };
}

function status() {
  const chosen = state.selection || { provider: 'ollama', model: 'qwen:9b' };
  const cloud = chosen.provider === 'anthropic';
  let problem = null;
  if (cloud && state.policy.local_only) problem = 'local_only';
  return {
    model: chosen.model,
    provider: chosen.provider,
    kind: cloud ? 'cloud' : 'local',
    ready: problem === null,
    problem,
    usage: {
      input: 1200,
      output: 300,
      cloud: cloud ? 1500 : 0,
      priced: { input: 1200, output: 300 },
    },
    budget: { spent: 0, allowance: 100000, budget: 100000 },
    num_ctx: 16384,
    low_resource: false,
    search: null,
    chat_problem: null,
    ollama: { reachable: true, version: '0.40.13' },
    model_present: true,
    tools: true,
    loaded: null,
  };
}

const sse = (events) =>
  events
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
const turnStart = () => [
  'turn',
  { turn_id: 'a'.repeat(32), conversation_id: 1, ...(state.selection || {}) },
];
const done = () => [
  'done',
  {
    model: 'm',
    provider: 'anthropic',
    usage: { input: 10, output: 5 },
    citations: [],
  },
];
const TURNS = {
  answer: () =>
    sse([turnStart(), ['token', { text: 'Plain answer.' }], done()]),
  local_only: () =>
    sse([
      turnStart(),
      [
        'error',
        {
          code: 'local_only',
          message: 'blocked',
          provider: 'anthropic',
          retryable: false,
        },
      ],
    ]),
  unavailable: () =>
    sse([
      turnStart(),
      [
        'error',
        {
          code: 'provider_unavailable',
          message: 'down',
          provider: 'anthropic',
          retryable: true,
        },
      ],
    ]),
  budget: () =>
    sse([
      turnStart(),
      ['budget', { spent: 100500, allowance: 100000, budget: 100000 }],
    ]),
  markup: () =>
    sse([
      turnStart(),
      ['thinking', { text: 'Plan: <img src=y onerror="window.__pwned=3">' }],
      ['token', { text: 'Look: <img src=x onerror="window.__pwned=1"> ' }],
      ['token', { text: '<script>window.__pwned=2</script> done.' }],
      done(),
    ]),
};

async function intercept(request) {
  const url = new URL(request.url());
  const method = request.method();
  const body = request.postData() || '';
  // Whatever goes out, the canary may only travel in its one key request.
  if (
    body.includes(CANARY) &&
    !(method === 'PUT' && url.pathname === '/api/intel/providers/anthropic/key')
  )
    leaks.push(`${method} ${url.pathname}`);
  const json = (payload, code = 200) =>
    request.respond({
      status: code,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  if (!url.pathname.startsWith('/api/intel/')) return request.continue();
  const route = url.pathname.slice('/api/intel'.length);
  if (route.startsWith('/providers') && method !== 'GET') {
    if (request.headers()['x-spectre-session'] !== TOKEN)
      return json({ detail: { code: 'session_required' } }, 403);
    writes.push({ method, route, body: body ? JSON.parse(body) : null });
  }
  if (route === '/providers/session') return json({ token: TOKEN });
  if (route === '/providers' && method === 'GET')
    return json({
      providers: ['ollama', 'anthropic'].map(providerView),
      policy: state.policy,
      keyring: true,
      selection: state.selection,
    });
  if (route === '/providers/ollama/models')
    return json({
      models: [
        {
          id: 'qwen:9b',
          label: 'qwen:9b',
          kind: 'local',
          supports_tools: 'yes',
          capabilities: ['completion', 'tools'],
          context_window: 65536,
          details: { size: 5_000_000_000 },
        },
      ],
    });
  if (route === '/providers/anthropic/models')
    return json({
      models: [
        {
          id: 'claude-x',
          label: 'Claude X',
          kind: 'cloud',
          supports_tools: 'unknown',
          capabilities: ['completion'],
          context_window: 200000,
          details: {},
        },
      ],
    });
  if (route === '/providers/ollama/gpu') return json({ gpu: null });
  if (route === '/providers/anthropic/key') {
    state.keys.anthropic = method === 'PUT';
    return json(providerView('anthropic').key);
  }
  if (route === '/providers/anthropic/consent') {
    state.consent.anthropic = JSON.parse(body).granted;
    return json({ consent: state.consent.anthropic });
  }
  if (route === '/providers/policy') {
    Object.assign(state.policy, JSON.parse(body));
    return json(state.policy);
  }
  if (route === '/providers/selection') {
    state.selection = JSON.parse(body);
    return json({ conversation_id: 1, selection: state.selection });
  }
  if (route === '/providers/budget/continue')
    return json({ allowance: 200000 });
  if (route === '/chat/status') return json(status());
  if (route === '/chat/history')
    return json({ conversation_id: 1, messages: [] });
  if (route === '/chat' && method === 'POST') {
    turns.push(JSON.parse(body || '{}'));
    return request.respond({
      status: 200,
      contentType: 'text/event-stream',
      body: TURNS[state.turn](),
    });
  }
  if (route === '/voice/status')
    return json({ state: 'missing', ready: false });
  if (route === '/news')
    return json({
      items: [],
      next_cursor: null,
      freshness: {
        state: 'live',
        stale: false,
        offline: false,
        updated_at: new Date().toISOString(),
        age_seconds: 1,
        poll_seconds: 600,
      },
    });
  if (route === '/health') return json({ state: 'live' });
  return request.respond({ status: 204, body: '' });
}

// ── Page helpers ──────────────────────────────────────────────────────────
async function boot(page, query = '') {
  await page.goto(`${APP_URL}/${query}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.viewer &&
      document.querySelector('.spectre-nc-launcher'),
    { timeout: 90_000 },
  );
  await sleep(2500);
  // Escape dismisses the first-launch chooser, and would close POWER UP too.
  if (!query.includes('setup=1')) await page.keyboard.press('Escape');
}

async function openPanel(page) {
  await page.evaluate(() => {
    const panel = document.getElementById('spectre-neural-core');
    if (panel.hidden) document.querySelector('.spectre-nc-launcher').click();
  });
  await page.waitForFunction(
    () => document.querySelector('.spectre-nc-chip')?.textContent,
    { timeout: 15_000 },
  );
}

async function openSettings(page) {
  await page.click('.spectre-nc-chip');
  await page.waitForFunction(
    () => document.querySelectorAll('.spectre-nc-provider').length > 0,
    { timeout: 15_000 },
  );
}

async function ask(page, text) {
  await page.evaluate((message) => {
    const panel = document.getElementById('spectre-neural-core');
    if (panel.dataset.view === 'settings')
      panel.querySelector('.spectre-nc-back').click();
    panel.querySelector('.spectre-nc-input').value = message;
    panel.querySelector('.spectre-nc-composer').requestSubmit();
  }, text);
  await page.waitForFunction(
    () =>
      document.getElementById('spectre-neural-core').dataset.busy === 'false',
    { timeout: 30_000 },
  );
  await sleep(300);
}

const lastAnswer = (page) =>
  page.evaluate(() => {
    const items = document.querySelectorAll('.spectre-nc-msg.is-assistant');
    const last = items[items.length - 1];
    return {
      text: last?.querySelector('.spectre-nc-text')?.textContent || '',
      error: last?.querySelector('.spectre-nc-error')?.textContent || '',
      actions: [
        ...(last?.querySelectorAll('.spectre-nc-recovery button') || []),
      ].map((b) => b.textContent),
      images: last?.querySelectorAll('.spectre-nc-text img').length ?? -1,
      thinking:
        last?.querySelector('.spectre-nc-thinking-text')?.textContent || '',
      thinkingOpen: last?.querySelector('.spectre-nc-thinking')?.open ?? null,
      thinkingImages:
        last?.querySelectorAll('.spectre-nc-thinking img').length ?? -1,
    };
  });

async function storageHas(page, needle) {
  return page.evaluate(async (value) => {
    const found = [];
    for (const area of [localStorage, sessionStorage])
      for (let i = 0; i < area.length; i += 1) {
        const key = area.key(i);
        if (`${key}=${area.getItem(key)}`.includes(value))
          found.push(`storage:${key}`);
      }
    const dbs = (await indexedDB.databases?.()) || [];
    for (const { name } of dbs) {
      if (!name) continue;
      const db = await new Promise((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      }).catch(() => null);
      if (!db) continue;
      for (const store of db.objectStoreNames) {
        const rows = await new Promise((resolve) => {
          const get = db
            .transaction(store, 'readonly')
            .objectStore(store)
            .getAll();
          get.onsuccess = () => resolve(get.result);
          get.onerror = () => resolve([]);
        });
        if (JSON.stringify(rows).includes(value))
          found.push(`indexeddb:${name}/${store}`);
      }
      db.close();
    }
    const fields = [...document.querySelectorAll('input, textarea')].some(
      (field) => field.value.includes(value),
    );
    if (fields) found.push('dom:field');
    if (document.documentElement.outerHTML.includes(value))
      found.push('dom:html');
    return found;
  }, needle);
}

async function shot(page, name) {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(SHOTS_DIR, `providers-${name}.png`),
  });
}

// ── Sections ──────────────────────────────────────────────────────────────
async function run(page) {
  console.log('(i) CHIP: where the model runs, in text...');
  await boot(page);
  await openPanel(page);
  const chip = await page.$eval('.spectre-nc-chip', (node) => node.textContent);
  record(
    'The chip names a local model as LOCAL',
    chip.startsWith('LOCAL · qwen:9b'),
    chip,
  );
  await openSettings(page);
  const list = await page.$$eval('.spectre-nc-provider', (nodes) =>
    nodes.map((n) => n.textContent),
  );
  record(
    'Settings list every provider with a text badge and state',
    list.length === 2 &&
      list[0].includes('LOCAL') &&
      list[1].includes('CLOUD') &&
      list[1].includes('Not configured'),
    list.join(' | '),
  );
  const disclaimer = await page.$eval(
    '.spectre-nc-disclaimer',
    (n) => n.textContent,
  );
  record(
    'The disclaimer stays visible and says local',
    disclaimer.startsWith('Local model;'),
    disclaimer.slice(0, 40),
  );

  console.log('(ii) KEYS: a canary key typed into POWER UP...');
  await boot(page, '?setup=1');
  const row = await page
    .waitForSelector(
      '[data-key-setup-neural-core] input[data-nc-key="anthropic"]',
      { timeout: 20_000 },
    )
    .catch(() => null);
  record('POWER UP shows the Neural Core key rows', Boolean(row));
  if (row) {
    // The rows can re-render once the service answers: type into the live
    // field and check the key is really there before saving.
    const field = '[data-key-setup-neural-core] input[data-nc-key="anthropic"]';
    await sleep(1000);
    await page.type(field, CANARY);
    const typed = await page.$eval(field, (input) => input.value.length);
    record(
      'The key field took the typed key',
      typed === CANARY.length,
      `${typed} characters`,
    );
    await page.evaluate(() =>
      document
        .querySelector(
          '[data-key-setup-neural-core] input[data-nc-key="anthropic"]',
        )
        .nextElementSibling.click(),
    );
    await page.waitForFunction(
      () =>
        !document.querySelector(
          '[data-key-setup-neural-core] input[data-nc-key="anthropic"]',
        )?.value,
      { timeout: 10_000 },
    );
    const keyWrites = writes.filter(
      (w) => w.route === '/providers/anthropic/key',
    );
    record(
      'The key went to PUT /providers/anthropic/key once',
      keyWrites.length === 1 && keyWrites[0].body.key === CANARY,
      keyWrites
        .map(
          (w) => `${w.method} ${w.body?.key === CANARY ? 'canary' : 'other'}`,
        )
        .join(', '),
    );
    const envVarInputs = await page.$$eval(
      '[data-key-setup-neural-core] [data-env-var]',
      (n) => n.length,
    );
    record(
      "No Neural Core field carries POWER UP's data-env-var",
      envVarInputs === 0,
    );
    const found = await storageHas(page, CANARY);
    record(
      'The canary is in no field, DOM, localStorage, sessionStorage or IndexedDB',
      found.length === 0,
      found.join(', ') || 'clean',
    );
    record(
      'No other request carried the canary (POWER UP save included)',
      leaks.length === 0,
      leaks.join(', ') || 'none',
    );
    const tokenStored = await storageHas(page, TOKEN);
    record(
      'The session token is kept in memory only',
      tokenStored.length === 0,
      tokenStored.join(', ') || 'memory',
    );
  }

  console.log('(iii) CONSENT: choosing a cloud model...');
  await boot(page);
  await openPanel(page);
  await openSettings(page);
  await page.evaluate(() =>
    [...document.querySelectorAll('.spectre-nc-provider')][1].click(),
  );
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.spectre-nc-model button')].some(
        (b) => b.textContent === 'Use',
      ),
    { timeout: 15_000 },
  );
  const useModel = () =>
    page.evaluate(() => {
      const use = [
        ...document.querySelectorAll('.spectre-nc-model button'),
      ].find((b) => b.textContent === 'Use');
      use.focus();
      use.click();
    });
  await useModel();
  await page.waitForSelector('.spectre-nc-dialog', { timeout: 5000 });
  const dialog = await page.evaluate(() => ({
    role: document.querySelector('.spectre-nc-dialog').getAttribute('role'),
    modal: document
      .querySelector('.spectre-nc-dialog')
      .getAttribute('aria-modal'),
    focus: document.activeElement.textContent,
    items: document.querySelectorAll('.spectre-nc-dialog li').length,
  }));
  record(
    'The consent dialog is a modal with focus on Cancel and lists what is sent',
    dialog.role === 'dialog' &&
      dialog.modal === 'true' &&
      dialog.focus === 'Cancel' &&
      dialog.items === 3,
    JSON.stringify(dialog),
  );
  await shot(page, 'consent');
  await page.keyboard.press('Tab');
  const afterTab = await page.evaluate(
    () => document.activeElement.textContent,
  );
  await page.keyboard.press('Tab');
  const afterTwo = await page.evaluate(
    () => document.activeElement.textContent,
  );
  record(
    'Tab stays inside the dialog',
    afterTab === 'Allow' && afterTwo === 'Cancel',
    `${afterTab} → ${afterTwo}`,
  );
  await page.keyboard.press('Escape');
  await sleep(200);
  const escaped = await page.evaluate(() => ({
    open: Boolean(document.querySelector('.spectre-nc-dialog')),
    focus: document.activeElement.textContent,
  }));
  record(
    'Escape cancels, restores focus and changes nothing',
    !escaped.open &&
      escaped.focus === 'Use' &&
      !writes.some((w) => w.route === '/providers/selection'),
    JSON.stringify(escaped),
  );
  await useModel();
  await page.waitForSelector('.spectre-nc-dialog-confirm', { timeout: 5000 });
  await page.click('.spectre-nc-dialog-confirm');
  await page.waitForFunction(
    () =>
      document
        .querySelector('.spectre-nc-chip')
        ?.textContent.startsWith('CLOUD'),
    { timeout: 15_000 },
  );
  const consentThenSelect = writes
    .filter((w) =>
      ['/providers/anthropic/consent', '/providers/selection'].includes(
        w.route,
      ),
    )
    .map((w) => w.route);
  record(
    'Allow grants consent, then selects the model',
    consentThenSelect.join(',') ===
      '/providers/anthropic/consent,/providers/selection',
    consentThenSelect.join(','),
  );
  const cloudChip = await page.$eval('.spectre-nc-chip', (n) => n.textContent);
  const cloudDisclaimer = await page.$eval(
    '.spectre-nc-disclaimer',
    (n) => n.textContent,
  );
  record(
    'The chip and the disclaimer name the cloud provider',
    cloudChip.startsWith('CLOUD · Claude (Anthropic API) · claude-x') &&
      cloudDisclaimer.startsWith('Cloud model (Claude (Anthropic API))'),
    `${cloudChip} | ${cloudDisclaimer.slice(0, 40)}`,
  );

  console.log('(iv) NO SILENT FALLBACK...');
  await page.evaluate(() => {
    const box = [...document.querySelectorAll('.spectre-nc-toggle input')][0];
    box.click();
  });
  await page.waitForFunction(() => true);
  await sleep(500);
  record(
    'Local-only mode is a gated policy write',
    writes.some(
      (w) => w.route === '/providers/policy' && w.body.local_only === true,
    ),
  );
  await page.evaluate(() => {
    const ceiling = document.querySelectorAll(
      '.spectre-nc-policy input[type="number"]',
    )[1];
    ceiling.value = '65536';
    ceiling.dispatchEvent(new Event('change'));
  });
  await sleep(500);
  record(
    'The context ceiling is a gated policy write',
    writes.some(
      (w) =>
        w.route === '/providers/policy' && w.body.context_ceiling === 65536,
    ),
  );
  state.turn = 'local_only';
  const before = turns.length;
  await ask(page, 'Is the map clear?');
  let answer = await lastAnswer(page);
  record(
    'Local-only refuses the turn with a way out, not a switch',
    answer.error.includes('Local-only mode is on') &&
      answer.actions.includes('Choose another model') &&
      turns.length === before + 1 &&
      !writes.some(
        (w) =>
          w.route === '/providers/selection' && w.body.provider === 'ollama',
      ),
    `${answer.error.slice(0, 50)} | ${answer.actions.join(',')}`,
  );
  state.turn = 'unavailable';
  await ask(page, 'Try again?');
  answer = await lastAnswer(page);
  record(
    'A provider failure offers Retry and Choose another model',
    answer.actions.includes('Retry') &&
      answer.actions.includes('Choose another model'),
    answer.actions.join(','),
  );
  state.turn = 'answer';
  const beforeRetry = turns.length;
  await page.evaluate(() => {
    const items = document.querySelectorAll('.spectre-nc-msg.is-assistant');
    [...items[items.length - 1].querySelectorAll('.spectre-nc-recovery button')]
      .find((b) => b.textContent === 'Retry')
      .click();
  });
  await page.waitForFunction((n) => true, {}, beforeRetry);
  await sleep(1500);
  record(
    'Retry asks the same provider again, only when clicked',
    turns.length === beforeRetry + 1 &&
      turns[turns.length - 1].regenerate === true,
  );

  console.log('(v) BUDGET...');
  state.turn = 'budget';
  await ask(page, 'One more?');
  answer = await lastAnswer(page);
  record(
    'The budget event says so and offers Continue',
    answer.error.includes('cloud tokens') &&
      answer.actions.includes('Continue'),
    answer.error.slice(0, 60),
  );
  state.turn = 'answer';
  await page.evaluate(() => {
    const items = document.querySelectorAll('.spectre-nc-msg.is-assistant');
    [...items[items.length - 1].querySelectorAll('.spectre-nc-recovery button')]
      .find((b) => b.textContent === 'Continue')
      .click();
  });
  await sleep(1500);
  record(
    'Continue is a gated write, then the turn runs',
    writes.some((w) => w.route === '/providers/budget/continue'),
  );

  console.log('(vi) MARKUP from a model renders as text...');
  state.turn = 'markup';
  await ask(page, 'Show me something.');
  answer = await lastAnswer(page);
  const pwned = await page.evaluate(() => window.__pwned ?? null);
  record(
    '<script> and <img onerror> stay text and run nothing',
    pwned === null &&
      answer.images === 0 &&
      answer.text.includes('<img src=x') &&
      answer.text.includes('<script>'),
    `pwned=${pwned}, images=${answer.images}`,
  );
  record(
    'Thinking shows collapsed, as text, and runs nothing',
    answer.thinking.includes('<img src=y') &&
      answer.thinkingImages === 0 &&
      answer.thinkingOpen === false,
    `open=${answer.thinkingOpen}, images=${answer.thinkingImages}`,
  );

  console.log(
    '(vi b) SWITCH: an existing history is not sent without asking...',
  );
  const useIn = (providerIndex) =>
    page.evaluate(async (index) => {
      const panel = document.getElementById('spectre-neural-core');
      if (panel.dataset.view !== 'settings')
        document.querySelector('.spectre-nc-chip').click();
      await new Promise((r) => setTimeout(r, 800));
      [...document.querySelectorAll('.spectre-nc-provider')][index].click();
      for (let i = 0; i < 30; i += 1) {
        const use = [
          ...document.querySelectorAll('.spectre-nc-model button'),
        ].find((b) => b.textContent === 'Use');
        if (use) {
          use.focus();
          use.click();
          return true;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      return false;
    }, providerIndex);
  await useIn(0); // the local Ollama model: no dialog
  await sleep(800);
  const toLocal = await page.evaluate(() =>
    Boolean(document.querySelector('.spectre-nc-dialog')),
  );
  const selectionsBefore = writes.filter(
    (w) => w.route === '/providers/selection',
  ).length;
  await useIn(1); // back to the consented cloud model, with a history
  const confirm = await page
    .waitForSelector('.spectre-nc-dialog', { timeout: 5000 })
    .then(() => page.$eval('.spectre-nc-dialog h2', (n) => n.textContent))
    .catch(() => '');
  await page.keyboard.press('Escape');
  await sleep(300);
  const selectionsAfter = writes.filter(
    (w) => w.route === '/providers/selection',
  ).length;
  record(
    'Switching to a cloud model with a history asks first; a local switch does not',
    !toLocal &&
      confirm.startsWith('Send this conversation to Claude') &&
      selectionsAfter === selectionsBefore,
    `local dialog=${toLocal}, cloud: "${confirm}"`,
  );

  console.log('(vii) PHONE: 390 px...');
  await page.setViewport({
    width: 390,
    height: 760,
    isMobile: true,
    hasTouch: true,
  });
  await boot(page); // a mobile viewport reloads the page
  await openPanel(page);
  await page.evaluate(() => {
    const panel = document.getElementById('spectre-neural-core');
    if (panel.dataset.view !== 'settings')
      document.querySelector('.spectre-nc-chip').click();
  });
  await sleep(1500);
  const phone = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    settings: document
      .querySelector('.spectre-nc-settings')
      .getBoundingClientRect().right,
  }));
  await shot(page, 'phone');
  record(
    'No sideways scroll at 390 px with settings open',
    phone.scrollWidth <= 390 && phone.settings <= 391,
    JSON.stringify(phone),
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
