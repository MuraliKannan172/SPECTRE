/**
 * SKYNET Neural Core panel: a launcher and a chat window over the globe
 * (ADR-001 D5). Streams answers, shows real tool progress, numbered citation
 * chips and "As of", runs globe tools through the app's own runner, and keeps
 * history in the intel service. Text is only ever set with textContent; links
 * are real anchors to http(s) URLs, opened with noopener.
 */
import { BRANDING } from '../branding.js';
import { t } from '../i18n/index.js';
import { NeuralCoreError } from './client.js';
import {
  answerSegments,
  endsWithAsOf,
  errorText,
  statusSummary,
  toolLabel,
} from './view.js';

const STATUS_POLL_MS = 10_000;
const MAX_INPUT = 4000;
const NEAR_BOTTOM_PX = 48;

function element(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(document, className, label, title) {
  const node = element(document, 'button', className, label);
  node.type = 'button';
  if (title) {
    node.title = title;
    node.setAttribute('aria-label', title);
  }
  return node;
}

/** A snapshot that cannot fail a turn: on error the model just gets none. */
function safely(snapshot) {
  try {
    return snapshot();
  } catch {
    return null;
  }
}

/** The error code for a failed turn request. */
function failureCode(error) {
  if (error?.name === 'AbortError') return 'stopped';
  if (error instanceof NeuralCoreError) return error.code;
  return error instanceof TypeError ? 'network' : 'client_error';
}

function safeLink(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

/**
 * @param {{document: Document, client: ReturnType<import('./client.js').createNeuralCoreClient>,
 *   execute: (name: string, args: object) => Promise<{ok: boolean, result?: any, error?: string}>,
 *   viewport: () => object, layerState: () => object,
 *   setTimer?: typeof setInterval, clearTimer?: typeof clearInterval,
 *   onOpen?: () => void}} options
 */
export function mountNeuralCorePanel({
  document,
  client,
  execute,
  viewport,
  layerState,
  setTimer = (...args) => setInterval(...args),
  clearTimer = (id) => clearInterval(id),
  onOpen = () => {},
}) {
  const body = document.body;
  const launcher = button(
    document,
    'skynet-nc-launcher',
    null,
    t('Open the Neural Core chat'),
  );
  launcher.append(
    element(document, 'span', 'skynet-nc-launcher-mark', '◉'),
    element(document, 'span', '', t('NEURAL CORE')),
  );
  launcher.setAttribute('aria-controls', 'skynet-neural-core');
  launcher.setAttribute('aria-expanded', 'false');

  const panel = element(document, 'section', 'skynet-nc');
  panel.id = 'skynet-neural-core';
  panel.hidden = true;
  panel.setAttribute('aria-label', BRANDING.neuralCoreLabel);

  const header = element(document, 'header', 'skynet-nc-header');
  const brand = element(document, 'div', 'skynet-nc-brand');
  const mark = element(document, 'span', 'skynet-nc-wordmark');
  mark.setAttribute('translate', 'no');
  mark.append(
    document.createTextNode(BRANDING.wordmark.lead),
    element(document, 'span', 'skynet-nc-accent', BRANDING.wordmark.accent),
  );
  brand.append(
    mark,
    element(document, 'span', 'skynet-nc-sublabel', BRANDING.neuralCoreLabel),
  );
  const clearButton = button(
    document,
    'skynet-nc-icon',
    '⌫',
    t('Clear chat history'),
  );
  const closeButton = button(
    document,
    'skynet-nc-icon',
    '×',
    t('Close the Neural Core'),
  );
  header.append(brand, clearButton, closeButton);
  const statusLine = element(document, 'p', 'skynet-nc-status');
  const searchLine = element(document, 'p', 'skynet-nc-search');

  const list = element(document, 'ol', 'skynet-nc-messages');
  list.setAttribute('aria-label', t('Conversation'));
  const empty = element(
    document,
    'p',
    'skynet-nc-empty',
    t(
      'Ask about the news, the web or the map: “What’s the latest on the cyclone?”, “Fly to Lima”, “Show earthquakes”.',
    ),
  );
  const announcer = element(document, 'p', 'skynet-nc-sr');
  announcer.setAttribute('role', 'status');

  const form = element(document, 'form', 'skynet-nc-composer');
  const input = element(document, 'textarea', 'skynet-nc-input');
  input.rows = 1;
  input.maxLength = MAX_INPUT;
  input.placeholder = t('Ask the Neural Core');
  input.setAttribute('aria-label', t('Message to the Neural Core'));
  const sendButton = button(document, 'skynet-nc-send', t('Send'));
  sendButton.type = 'submit';
  const stopButton = button(document, 'skynet-nc-stop', t('Stop'));
  stopButton.hidden = true;
  form.append(input, sendButton, stopButton);
  const disclaimer = element(
    document,
    'p',
    'skynet-nc-disclaimer',
    t(
      'Local model; answers can be wrong. Not for navigation or emergencies. It will not locate or track people.',
    ),
  );
  panel.append(
    header,
    statusLine,
    searchLine,
    list,
    empty,
    announcer,
    form,
    disclaimer,
  );
  body.append(launcher, panel);

  // -- state ---------------------------------------------------------------
  let destroyed = false;
  let historyLoaded = false;
  let pollTimer = null;
  let model = '';
  let busy = false;
  let controller = null;
  let currentTurn = null;
  let clearArmed = null;
  const listeners = [];
  const on = (target, type, handler) => {
    target.addEventListener(type, handler);
    listeners.push(() => target.removeEventListener(type, handler));
  };

  const isOpen = () => !panel.hidden;
  const nearBottom = () =>
    list.scrollHeight - list.scrollTop - list.clientHeight < NEAR_BOTTOM_PX;
  function keepScrolled(stick) {
    if (stick) list.scrollTop = list.scrollHeight;
  }

  // -- status ----------------------------------------------------------------
  async function refreshStatus() {
    let summary;
    try {
      const status = await client.status();
      model = status?.model || model;
      summary = statusSummary(status);
    } catch (error) {
      summary = statusSummary(
        null,
        error instanceof NeuralCoreError ? error.code : 'network',
      );
    }
    if (destroyed) return;
    statusLine.textContent = summary.text;
    statusLine.dataset.tone = summary.tone;
    searchLine.textContent = summary.search || '';
    searchLine.hidden = !summary.search;
    launcher.dataset.tone = summary.tone;
  }

  // -- messages --------------------------------------------------------------
  function renderText(target, text, citations) {
    target.replaceChildren();
    for (const segment of answerSegments(text, citations)) {
      if (segment.kind === 'cite') {
        const url = safeLink(segment.url);
        const chip = url
          ? element(document, 'a', 'skynet-nc-cite', `${segment.n}`)
          : element(document, 'span', 'skynet-nc-cite', `${segment.n}`);
        if (url) {
          chip.href = url;
          chip.target = '_blank';
          chip.rel = 'noopener noreferrer';
        }
        chip.title = segment.title || segment.url;
        target.append(chip);
        continue;
      }
      segment.text.split('\n').forEach((line, index) => {
        if (index) target.append(document.createElement('br'));
        if (line) target.append(document.createTextNode(line));
      });
    }
  }

  function addUser(text) {
    const item = element(document, 'li', 'skynet-nc-msg is-user');
    item.append(element(document, 'p', 'skynet-nc-text', text));
    list.append(item);
    empty.hidden = true;
    return item;
  }

  function addAssistant() {
    const item = element(document, 'li', 'skynet-nc-msg is-assistant');
    const tools = element(document, 'ul', 'skynet-nc-tools');
    const text = element(document, 'div', 'skynet-nc-text');
    const sources = element(document, 'ol', 'skynet-nc-sources');
    const asOf = element(document, 'p', 'skynet-nc-asof');
    const error = element(document, 'p', 'skynet-nc-error');
    const footer = element(document, 'footer', 'skynet-nc-footer');
    const meta = element(document, 'span', 'skynet-nc-meta');
    const copy = button(document, 'skynet-nc-action', t('Copy'));
    const regenerate = button(
      document,
      'skynet-nc-action skynet-nc-regenerate',
      t('Regenerate'),
    );
    footer.append(meta, copy, regenerate);
    for (const node of [sources, asOf, error, footer]) node.hidden = true;
    item.append(tools, text, sources, asOf, error, footer);
    list.append(item);
    empty.hidden = true;
    const entry = {
      item,
      tools,
      text,
      sources,
      asOf,
      error,
      footer,
      meta,
      copy,
      regenerate,
      raw: '',
      citations: [],
      running: new Map(),
    };
    on(copy, 'click', () => copyText(entry));
    on(regenerate, 'click', () => void send({ regenerate: true }, entry));
    return entry;
  }

  function toolChip(entry, data) {
    const key = data.tool;
    let chip = entry.running.get(key);
    if (data.state === 'start' || !chip) {
      chip = element(document, 'li', 'skynet-nc-tool');
      entry.tools.append(chip);
      entry.running.set(key, chip);
    }
    chip.dataset.state = data.state;
    chip.textContent = toolLabel(data);
    if (data.state !== 'start') entry.running.delete(key);
  }

  function renderSources(entry) {
    entry.sources.replaceChildren();
    for (const source of entry.citations) {
      const row = element(document, 'li', 'skynet-nc-source');
      const url = safeLink(source.url);
      const link = url
        ? element(document, 'a', '', source.title || url)
        : element(document, 'span', '', source.title || source.url);
      if (url) {
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
      row.value = source.n;
      row.append(link);
      if (source.source)
        row.append(
          element(document, 'span', 'skynet-nc-outlet', source.source),
        );
      entry.sources.append(row);
    }
    entry.sources.hidden = entry.citations.length === 0;
  }

  function finish(entry, done) {
    entry.citations = done.citations || entry.citations;
    renderText(entry.text, entry.raw, entry.citations);
    renderSources(entry);
    if (done.as_of && !endsWithAsOf(entry.raw)) {
      entry.asOf.textContent = t('As of {time}', { time: done.as_of });
      entry.asOf.hidden = false;
    }
    const speed = Number.isFinite(done.tokens_per_s)
      ? t('{rate} tokens/s', { rate: done.tokens_per_s })
      : null;
    entry.meta.textContent = [done.model, speed].filter(Boolean).join(' · ');
    entry.footer.hidden = false;
    // Only the latest answer can be regenerated.
    for (const node of list.querySelectorAll('.skynet-nc-regenerate'))
      node.hidden = true;
    entry.regenerate.hidden = Boolean(done.refused);
  }

  function fail(entry, code) {
    entry.error.textContent = errorText(code, { model });
    entry.error.hidden = false;
    entry.footer.hidden = false;
    entry.copy.hidden = !entry.raw;
  }

  async function copyText(entry) {
    try {
      await globalThis.navigator?.clipboard?.writeText(entry.raw);
      entry.copy.textContent = t('Copied');
    } catch {
      entry.copy.textContent = t('Copy failed');
    }
  }

  function renderHistory(messages) {
    list.replaceChildren();
    for (const message of messages) {
      if (message.role === 'user') {
        addUser(message.content);
        continue;
      }
      const entry = addAssistant();
      entry.raw = message.content;
      finish(entry, {
        citations: message.citations,
        as_of: message.meta?.as_of,
        model: message.meta?.model,
        tokens_per_s: message.meta?.tokens_per_s,
        refused: message.meta?.refused,
      });
    }
    empty.hidden = messages.length > 0;
    keepScrolled(true);
  }

  // -- a turn ------------------------------------------------------------------
  function setBusy(value) {
    busy = value;
    sendButton.hidden = value;
    stopButton.hidden = !value;
    input.disabled = false;
    panel.dataset.busy = value ? 'true' : 'false';
  }

  async function runClientTool(data) {
    const outcome = await execute(data.name, data.args || {});
    try {
      await client.toolResult({
        turnId: data.turn_id,
        callId: data.call_id,
        ...outcome,
      });
    } catch {
      /* the turn times the call out and tells the model */
    }
  }

  async function send({ message = '', regenerate = false } = {}, replace) {
    if (busy || destroyed) return;
    if (!regenerate && !message.trim()) return;
    if (regenerate && replace) replace.item.remove();
    else if (!regenerate) addUser(message.trim());
    const entry = addAssistant();
    toolChip(entry, { tool: 'model', state: 'start' });
    entry.running
      .get('model')
      .replaceChildren(document.createTextNode(t('Waiting for the model…')));
    keepScrolled(true);
    controller = new AbortController();
    setBusy(true);
    const clearWaiting = () => {
      const waiting = entry.running.get('model');
      if (waiting) {
        waiting.remove();
        entry.running.delete('model');
      }
    };
    try {
      await client.turn({
        message,
        regenerate,
        viewport: safely(viewport),
        layerState: safely(layerState),
        signal: controller.signal,
        onEvent(name, data) {
          const stick = nearBottom();
          if (name === 'turn') currentTurn = data.turn_id;
          else if (name === 'token') {
            clearWaiting();
            entry.raw += data.text || '';
            renderText(entry.text, entry.raw, entry.citations);
          } else if (name === 'tool_status') {
            clearWaiting();
            toolChip(entry, data);
          } else if (name === 'client_tool') void runClientTool(data);
          else if (name === 'citation') {
            entry.citations = [...entry.citations, data];
          } else if (name === 'done') {
            clearWaiting();
            finish(entry, data);
            announcer.textContent = t('Answer ready');
          } else if (name === 'error') {
            clearWaiting();
            fail(entry, data.code);
          }
          keepScrolled(stick);
        },
      });
    } catch (error) {
      clearWaiting();
      fail(entry, failureCode(error));
    } finally {
      clearWaiting();
      for (const chip of entry.running.values()) chip.dataset.state = 'done';
      currentTurn = null;
      controller = null;
      setBusy(false);
      void refreshStatus();
    }
  }

  // -- open, close, clear ----------------------------------------------------
  async function open() {
    if (destroyed) return;
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    body.classList.add('skynet-nc-open');
    onOpen();
    input.focus();
    void refreshStatus();
    if (pollTimer === null) pollTimer = setTimer(refreshStatus, STATUS_POLL_MS);
    if (!historyLoaded) {
      historyLoaded = true;
      try {
        renderHistory((await client.history()).messages || []);
      } catch {
        historyLoaded = false; // the status line already says why
      }
    }
  }

  function close({ restoreFocus = false } = {}) {
    if (panel.hidden) return;
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    body.classList.remove('skynet-nc-open');
    if (pollTimer !== null) clearTimer(pollTimer);
    pollTimer = null;
    if (restoreFocus) launcher.focus();
  }

  async function clearHistory() {
    if (busy) return;
    if (!clearArmed) {
      clearButton.textContent = t('Clear?');
      clearArmed = setTimeout(() => {
        clearArmed = null;
        clearButton.textContent = '⌫';
      }, 4000);
      return;
    }
    clearTimeout(clearArmed);
    clearArmed = null;
    clearButton.textContent = '⌫';
    try {
      await client.clearHistory();
      list.replaceChildren();
      empty.hidden = false;
    } catch (error) {
      statusLine.textContent = errorText(
        error instanceof NeuralCoreError ? error.code : 'network',
      );
    }
  }

  on(launcher, 'click', () =>
    isOpen() ? close({ restoreFocus: true }) : void open(),
  );
  on(closeButton, 'click', () => close({ restoreFocus: true }));
  on(clearButton, 'click', () => void clearHistory());
  on(panel, 'keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close({ restoreFocus: true });
    }
  });
  on(form, 'submit', (event) => {
    event.preventDefault();
    const message = input.value;
    if (!message.trim() || busy) return;
    input.value = '';
    input.style.height = '';
    void send({ message });
  });
  on(input, 'keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  on(input, 'input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  });
  on(stopButton, 'click', () => {
    if (currentTurn) void client.stop(currentTurn).catch(() => {});
    controller?.abort();
  });

  return {
    open,
    close: () => close(),
    send: (message) => send({ message }),
    destroy() {
      destroyed = true;
      controller?.abort();
      if (pollTimer !== null) clearTimer(pollTimer);
      if (clearArmed) clearTimeout(clearArmed);
      for (const remove of listeners) remove();
      body.classList.remove('skynet-nc-open');
      launcher.remove();
      panel.remove();
    },
  };
}
