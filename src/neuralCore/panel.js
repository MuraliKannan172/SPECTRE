/**
 * SPECTRE Neural Core panel: a launcher and a chat window over the globe
 * (ADR-001 D5). Streams answers, shows real tool progress, numbered citation
 * chips and "As of", runs globe tools through the app's own runner, and keeps
 * history in the intel service. Text is only ever set with textContent; links
 * are real anchors to http(s) URLs, opened with noopener. With local voice
 * (Phase 5), a held mic button asks by voice and the answer is spoken as it
 * streams.
 */
import { BRANDING } from '../branding.js';
import { t } from '../i18n/index.js';
import { NeuralCoreError } from './client.js';
import { mountProviderControls } from './providerControls.js';
import { createProvidersClient } from './providersClient.js';
import { budgetText } from './providersView.js';
import {
  answerSegments,
  endsWithAsOf,
  errorText,
  statusSummary,
  toolLabel,
  turnErrorCode,
  voiceTimingText,
} from './view.js';
import {
  createRecorder,
  createSentenceSplitter,
  createSpeaker,
  voiceSupported,
} from './voice.js';
import { mountVoiceControl } from './voiceControl.js';

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
 *   onOpen?: () => void, localVoice?: boolean, now?: () => number}} options
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
  localVoice = voiceSupported(),
  now = () => performance.now(),
  providers = createProvidersClient(),
}) {
  const body = document.body;
  const launcher = button(
    document,
    'spectre-nc-launcher',
    null,
    t('Open the Neural Core chat'),
  );
  launcher.append(
    element(document, 'span', 'spectre-nc-launcher-mark', '◉'),
    element(document, 'span', '', t('NEURAL CORE')),
  );
  launcher.setAttribute('aria-controls', 'spectre-neural-core');
  launcher.setAttribute('aria-expanded', 'false');

  const panel = element(document, 'section', 'spectre-nc');
  panel.id = 'spectre-neural-core';
  panel.hidden = true;
  panel.setAttribute('aria-label', BRANDING.neuralCoreLabel);

  const header = element(document, 'header', 'spectre-nc-header');
  const brand = element(document, 'div', 'spectre-nc-brand');
  const emblem = element(document, 'img', 'spectre-nc-emblem');
  emblem.src = `${import.meta.env?.BASE_URL || '/'}brand/spectre-mark-128.png`;
  emblem.alt = '';
  emblem.width = 128;
  emblem.height = 65;
  const mark = element(document, 'span', 'spectre-nc-wordmark');
  mark.setAttribute('translate', 'no');
  mark.append(
    document.createTextNode(BRANDING.wordmark.lead),
    element(document, 'span', 'spectre-nc-accent', BRANDING.wordmark.accent),
  );
  brand.append(
    emblem,
    mark,
    element(document, 'span', 'spectre-nc-sublabel', BRANDING.neuralCoreLabel),
  );
  const clearButton = button(
    document,
    'spectre-nc-icon',
    '⌫',
    t('Clear chat history'),
  );
  const closeButton = button(
    document,
    'spectre-nc-icon',
    '×',
    t('Close the Neural Core'),
  );
  header.append(brand, clearButton, closeButton);
  const statusLine = element(document, 'p', 'spectre-nc-status');
  const searchLine = element(document, 'p', 'spectre-nc-search');

  const list = element(document, 'ol', 'spectre-nc-messages');
  list.setAttribute('aria-label', t('Conversation'));
  const empty = element(
    document,
    'p',
    'spectre-nc-empty',
    t(
      'Ask about the news, the web or the map: “What’s the latest on the cyclone?”, “Fly to Lima”, “Show earthquakes”.',
    ),
  );
  const announcer = element(document, 'p', 'spectre-nc-sr');
  announcer.setAttribute('role', 'status');

  const form = element(document, 'form', 'spectre-nc-composer');
  const input = element(document, 'textarea', 'spectre-nc-input');
  input.rows = 1;
  input.maxLength = MAX_INPUT;
  input.placeholder = t('Ask the Neural Core');
  input.setAttribute('aria-label', t('Message to the Neural Core'));
  const sendButton = button(document, 'spectre-nc-send', t('Send'));
  sendButton.type = 'submit';
  const stopButton = button(document, 'spectre-nc-stop', t('Stop'));
  stopButton.hidden = true;

  // -- local voice -------------------------------------------------------------
  let busy = false;
  let voiceStatus = null;
  let spokenTurn = null;
  const speaker = localVoice
    ? createSpeaker({
        speak: (text, options) => client.speak(text, options),
        onFirstAudio: (clip) => {
          if (!spokenTurn) return;
          spokenTurn.ttsSeconds = clip.seconds;
          markVoice(spokenTurn, 'firstAudio');
        },
        onPlay: () => {
          if (!voice.hint.dataset.code) voice.show('speaking');
        },
        onIdle: () => {
          if (voice.hint.dataset.code === 'speaking') voice.show(null);
        },
        // A sentence that is only a citation or an "As of" line has nothing
        // to say; that is not a failure.
        onError: (error) => {
          if (error?.code !== 'nothing_to_say') voice.show('speech_failed');
        },
      })
    : null;
  const recorder = localVoice
    ? createRecorder({
        mediaDevices: globalThis.navigator.mediaDevices,
        MediaRecorder: globalThis.MediaRecorder,
      })
    : null;
  const voice = mountVoiceControl({
    document,
    client,
    recorder,
    speaker,
    isBusy: () => busy,
    onQuestion: (question) =>
      void send({ message: question.text, spoken: question }),
  });
  form.append(input, voice.mic, sendButton, stopButton);
  const disclaimer = element(
    document,
    'p',
    'spectre-nc-disclaimer',
    t(
      'Local model; answers can be wrong. Not for navigation or emergencies. It will not locate or track people.',
    ),
  );
  // ADR-002 P4: provider chip, quick switch and settings view (providerControls.js).
  const controls = mountProviderControls({
    document,
    providers,
    panel,
    disclaimer,
    historyLength: () =>
      list.querySelectorAll('.spectre-nc-msg.is-user').length,
    onChanged: () => void refreshStatus(),
  });
  header.insertBefore(controls.chip, clearButton);
  header.insertBefore(controls.switcher, clearButton);
  panel.dataset.view = 'chat';
  panel.append(
    header,
    controls.settings,
    statusLine,
    searchLine,
    list,
    empty,
    announcer,
    form,
    voice.hint,
    disclaimer,
  );
  body.append(launcher, panel);

  // -- state ---------------------------------------------------------------
  let destroyed = false;
  let historyLoaded = false;
  let pollTimer = null;
  let model = '';
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
      controls.update(status);
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

  async function refreshVoice() {
    if (!localVoice) return;
    try {
      voiceStatus = await client.voiceStatus();
      if (!destroyed) voice.update(voiceStatus);
    } catch (error) {
      if (!destroyed)
        voice.update(
          null,
          error instanceof NeuralCoreError ? error.code : 'network',
        );
    }
  }

  // -- messages --------------------------------------------------------------
  function renderText(target, text, citations) {
    target.replaceChildren();
    for (const segment of answerSegments(text, citations)) {
      if (segment.kind === 'cite') {
        const url = safeLink(segment.url);
        const chip = url
          ? element(document, 'a', 'spectre-nc-cite', `${segment.n}`)
          : element(document, 'span', 'spectre-nc-cite', `${segment.n}`);
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
    const item = element(document, 'li', 'spectre-nc-msg is-user');
    item.append(element(document, 'p', 'spectre-nc-text', text));
    list.append(item);
    empty.hidden = true;
    return item;
  }

  function addAssistant() {
    const item = element(document, 'li', 'spectre-nc-msg is-assistant');
    const tools = element(document, 'ul', 'spectre-nc-tools');
    const text = element(document, 'div', 'spectre-nc-text');
    const sources = element(document, 'ol', 'spectre-nc-sources');
    const asOf = element(document, 'p', 'spectre-nc-asof');
    const error = element(document, 'p', 'spectre-nc-error');
    const footer = element(document, 'footer', 'spectre-nc-footer');
    const meta = element(document, 'span', 'spectre-nc-meta');
    const voiceMeta = element(document, 'span', 'spectre-nc-meta');
    voiceMeta.hidden = true;
    const copy = button(document, 'spectre-nc-action', t('Copy'));
    const regenerate = button(
      document,
      'spectre-nc-action spectre-nc-regenerate',
      t('Regenerate'),
    );
    footer.append(meta, voiceMeta, copy, regenerate);
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
      voiceMeta,
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
      chip = element(document, 'li', 'spectre-nc-tool');
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
      const row = element(document, 'li', 'spectre-nc-source');
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
          element(document, 'span', 'spectre-nc-outlet', source.source),
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
    for (const node of list.querySelectorAll('.spectre-nc-regenerate'))
      node.hidden = true;
    entry.regenerate.hidden = Boolean(done.refused);
  }

  function fail(entry, code, text = null) {
    entry.error.textContent = text || errorText(code, { model });
    entry.error.hidden = false;
    entry.footer.hidden = false;
    entry.copy.hidden = !entry.raw;
    // What can be done about it; never a silent switch (ADR-002 D6).
    const actions = controls.recovery(code);
    if (!actions.length) return;
    const row = element(document, 'span', 'spectre-nc-recovery');
    for (const { label, run } of actions) {
      const choice = button(document, 'spectre-nc-action', label);
      // A refused write (a LAN viewer, a restarted service) says so here.
      choice.addEventListener('click', () =>
        Promise.resolve(run(() => send({ regenerate: true }, entry))).catch(
          (error) => {
            entry.error.textContent = errorText(
              error instanceof NeuralCoreError ? error.code : 'network',
              { model },
            );
          },
        ),
      );
      row.append(choice);
    }
    entry.error.append(document.createTextNode(' '), row);
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

  /** Milliseconds from the mic's release to `step`, kept on the answer for the latency bench. */
  function markVoice(turn, step) {
    if (turn[step] != null) return;
    turn[step] = now() - turn.releasedAt;
    const item = turn.entry.item;
    const key = `voice${step[0].toUpperCase()}${step.slice(1)}Ms`;
    item.dataset[key] = String(Math.round(turn[step]));
    if (step === 'firstAudio' && turn.ttsSeconds != null)
      item.dataset.voiceTtsSeconds = String(turn.ttsSeconds);
    turn.entry.voiceMeta.textContent = voiceTimingText({
      heardMs: turn.heard,
      firstWordMs: turn.firstAudio,
    });
    turn.entry.voiceMeta.hidden = false;
  }

  /** Speak a turn asked by voice, sentence by sentence, as it streams. */
  function startSpeech(entry, spoken) {
    const turn = {
      entry,
      releasedAt: spoken.releasedAt,
      heard: spoken.transcribedAt - spoken.releasedAt,
    };
    entry.item.dataset.voiceRecordedMs = String(
      Math.round(spoken.recordedAt - spoken.releasedAt),
    );
    entry.item.dataset.voiceHeardMs = String(Math.round(turn.heard));
    entry.item.dataset.voiceSttSeconds = String(spoken.sttSeconds ?? '');
    entry.voiceMeta.textContent = voiceTimingText({ heardMs: turn.heard });
    entry.voiceMeta.hidden = false;
    const speaks = (voiceStatus?.speaks || ['en']).includes(spoken.language);
    if (!speaker || !speaks) {
      voice.show('english_only');
      return { push() {}, end() {} };
    }
    speaker.begin();
    spokenTurn = turn;
    const splitter = createSentenceSplitter();
    const say = (sentences) => {
      for (const sentence of sentences) {
        markVoice(turn, 'firstSentence');
        speaker.say(sentence);
      }
    };
    return {
      push(text) {
        markVoice(turn, 'firstToken');
        say(splitter.push(text));
      },
      end: () => say(splitter.flush()),
    };
  }

  async function send(
    { message = '', regenerate = false, spoken = null } = {},
    replace,
  ) {
    if (busy || destroyed) return;
    if (!regenerate && !message.trim()) return;
    if (regenerate && replace) replace.item.remove();
    else if (!regenerate) addUser(message.trim());
    const entry = addAssistant();
    const speech = spoken ? startSpeech(entry, spoken) : null;
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
            speech?.push(data.text || '');
          } else if (name === 'tool_status') {
            clearWaiting();
            toolChip(entry, data);
          } else if (name === 'client_tool') void runClientTool(data);
          else if (name === 'citation') {
            entry.citations = [...entry.citations, data];
          } else if (name === 'done') {
            clearWaiting();
            finish(entry, data);
            speech?.end();
            announcer.textContent = t('Answer ready');
          } else if (name === 'error') {
            clearWaiting();
            fail(entry, turnErrorCode(data));
          } else if (name === 'budget') {
            clearWaiting();
            fail(entry, 'budget', budgetText(data));
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
    body.classList.add('spectre-nc-open');
    onOpen();
    input.focus();
    void refreshStatus();
    void refreshVoice();
    if (pollTimer === null)
      pollTimer = setTimer(() => {
        void refreshStatus();
        void refreshVoice();
      }, STATUS_POLL_MS);
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
    speaker?.stop();
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    body.classList.remove('spectre-nc-open');
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
    speaker?.stop();
    if (currentTurn) void client.stop(currentTurn).catch(() => {});
    controller?.abort();
  });

  return {
    open,
    close: () => close(),
    send: (message) => send({ message }),
    destroy() {
      destroyed = true;
      voice.destroy();
      controller?.abort();
      if (pollTimer !== null) clearTimer(pollTimer);
      if (clearArmed) clearTimeout(clearArmed);
      for (const remove of listeners) remove();
      body.classList.remove('spectre-nc-open');
      launcher.remove();
      panel.remove();
    },
  };
}
