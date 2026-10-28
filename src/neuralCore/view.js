/**
 * SKYNET Neural Core: what the panel shows, as plain data. Pure (no DOM), so
 * it is tested in Node; panel.js only renders it. Every label reflects real
 * state reported by the intel service.
 */
import { msg, t, translateKnown } from '../i18n/index.js';

export const TOOL_LABELS = Object.freeze({
  web_search: msg('Searching the web'),
  fetch_page: msg('Reading {host}'),
  news_search: msg('Searching the news store'),
  news_near: msg('Searching news near a place'),
  layer_state: msg('Reading the map layers'),
  viewport: msg('Reading the view'),
  fly_to_location: msg('Flying the camera'),
  adjust_camera_zoom: msg('Zooming'),
  zoom_to_globe: msg('Showing the whole globe'),
  set_layer_visibility: msg('Switching a layer'),
  set_map_stack: msg('Changing the base map'),
  set_visual_style: msg('Changing the visual style'),
  track_entity: msg('Finding and tracking'),
  stop_tracking: msg('Stopping tracking'),
  annotate_map: msg('Drawing on the map'),
  clear_annotations: msg('Clearing drawings'),
  next_satellite_pass: msg('Predicting a satellite pass'),
  get_earthquakes: msg('Checking earthquakes'),
});

const TOOL_FAILURES = Object.freeze({
  timeout: msg('timed out'),
  invalid_arguments: msg('rejected: invalid arguments'),
  robots_disallowed: msg('blocked by the site’s robots.txt'),
  private_address: msg('blocked: not a public address'),
  not_configured: msg('no search provider is set up'),
});

const ERRORS = Object.freeze({
  intel_offline: msg(
    'Intel service offline: run scripts\\skynet.ps1 to start it',
  ),
  ollama_offline: msg('Ollama is not running. Start Ollama, then try again.'),
  ollama_model_missing: msg(
    'Model {model} is not installed: run ollama pull {model}',
  ),
  ollama_not_found: msg(
    'Model {model} is not installed: run ollama pull {model}',
  ),
  ollama_timeout: msg('The model took too long to answer.'),
  busy: msg('Another answer is still being written.'),
  rate_limited: msg('Too many questions in a minute. Wait a moment.'),
  stopped: msg('Stopped.'),
  chat_local_only: msg('The Neural Core answers only on this computer.'),
  nothing_to_regenerate: msg('There is no answer to regenerate.'),
  network: msg('Could not reach the app server.'),
});

/** The failure message for an error code from the service or proxy. */
export function errorText(code, { model = '' } = {}) {
  const template = ERRORS[code];
  if (template) return t(template, { model });
  return t('The Neural Core failed ({code}).', { code: String(code || '?') });
}

/** One line for a tool's progress chip. */
export function toolLabel({ tool, state, host = null, code = null }) {
  const template = TOOL_LABELS[tool];
  const label = template
    ? t(template, { host: host || t('a page') })
    : t('Running {tool}', { tool });
  if (state === 'start') return t('{label}…', { label });
  if (state === 'error') {
    const reason = TOOL_FAILURES[code] ? t(TOOL_FAILURES[code]) : code;
    return reason
      ? t('{label}: {reason}', { label, reason })
      : t('{label} failed', { label });
  }
  return label;
}

const CITATION = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g;

/**
 * Split answer text into text runs and citation chips. A bracketed number
 * becomes a chip only when the turn really has that source.
 * @returns {Array<{kind: 'text', text: string} | {kind: 'cite', n: number, url: string, title: string}>}
 */
export function answerSegments(text, citations = []) {
  const byNumber = new Map(citations.map((item) => [item.n, item]));
  const out = [];
  let last = 0;
  for (const match of String(text || '').matchAll(CITATION)) {
    const numbers = match[1].split(',').map((part) => Number(part.trim()));
    if (!numbers.every((n) => byNumber.has(n))) continue;
    if (match.index > last)
      out.push({ kind: 'text', text: text.slice(last, match.index) });
    for (const n of numbers) {
      const source = byNumber.get(n);
      out.push({ kind: 'cite', n, url: source.url, title: source.title });
    }
    last = match.index + match[0].length;
  }
  if (last < String(text || '').length)
    out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/** True when the answer already ends with its own "As of" line. */
export function endsWithAsOf(text) {
  const lines = String(text || '')
    .trim()
    .split('\n');
  return /^\s*as of\b/i.test(lines.at(-1) || '');
}

/**
 * The header readout from GET /api/intel/chat/status (or the failure to get it).
 * @returns {{tone: 'ready'|'idle'|'degraded'|'offline', text: string, search: string|null}}
 */
export function statusSummary(status, failureCode = null) {
  if (failureCode)
    return { tone: 'offline', text: errorText(failureCode), search: null };
  const model = status?.model || '?';
  const search = searchNote(status?.search);
  if (status?.chat_problem)
    return {
      tone: 'offline',
      text: translateKnown(status.chat_problem),
      search,
    };
  if (!status?.ollama?.reachable)
    return { tone: 'offline', text: errorText('ollama_offline'), search };
  if (status.model_present === false)
    return {
      tone: 'offline',
      text: errorText('ollama_model_missing', { model }),
      search,
    };
  if (status.tools === false)
    return {
      tone: 'degraded',
      text: t('{model} · degraded: no native tool calling', { model }),
      search,
    };
  const vram = status.loaded?.size_vram;
  if (status.loaded)
    return {
      tone: 'ready',
      text: Number.isFinite(vram)
        ? t('{model} · loaded · {gb} GB on the GPU', {
            model,
            gb: (vram / 1e9).toFixed(1),
          })
        : t('{model} · loaded', { model }),
      search,
    };
  return {
    tone: 'idle',
    text: t('{model} · not loaded (the first answer loads it)', { model }),
    search,
  };
}

function searchNote(search) {
  if (!search) return null;
  if (!search.configured)
    return t('Web search off: {problem}', {
      problem: translateKnown(search.problem || ''),
    });
  if (search.best_effort)
    return t('Web search: DuckDuckGo via ddgs (best effort)');
  return t('Web search: {provider}', { provider: search.provider });
}

const VOICE_TEXT = Object.freeze({
  ready: msg('Hold to talk'),
  unsupported: msg('This browser cannot record audio.'),
  disabled: msg('Local voice is turned off (SKYNET_VOICE=0).'),
  not_installed: msg(
    'Local voice is not installed: run scripts\\skynet.ps1 -Voice',
  ),
  models_missing: msg(
    'Local voice models are missing: run scripts\\skynet.ps1 -Voice',
  ),
  voice_idle: msg('Local voice is starting…'),
  voice_loading: msg('Local voice is loading…'),
  voice_failed: msg('Local voice failed to load; see the intel service log.'),
  voice_unavailable: msg('Local voice is not available.'),
  listening: msg('Listening… release to send'),
  transcribing: msg('Transcribing…'),
  speaking: msg('Speaking… press the mic to stop'),
  too_short: msg('Hold the button while you speak.'),
  no_speech: msg('No speech heard. Hold the button while you speak.'),
  bad_audio: msg('The recording could not be read.'),
  too_long: msg('That recording was too long.'),
  mic_denied: msg('Microphone access was denied.'),
  no_mic: msg('No microphone was found.'),
  mic_failed: msg('The microphone could not be opened.'),
  busy: msg('Wait for the answer, or press Stop.'),
  english_only: msg(
    'Spoken replies are in English only; this answer is shown as text.',
  ),
  speech_failed: msg('The answer could not be spoken.'),
});

/** The text for a local voice state or failure code. */
export function voiceText(code) {
  const template = VOICE_TEXT[code];
  return template ? t(template) : errorText(code);
}

/**
 * Whether the mic can be used, from GET /api/intel/voice/status (or the
 * failure to get it), and the reason when it cannot.
 * @returns {{ready: boolean, reason: string}}
 */
export function voiceState(
  status,
  { supported = true, failureCode = null } = {},
) {
  if (!supported) return { ready: false, reason: voiceText('unsupported') };
  if (failureCode) return { ready: false, reason: errorText(failureCode) };
  if (status?.state === 'ready') return { ready: true, reason: '' };
  if (status?.state === 'unavailable')
    return { ready: false, reason: voiceText(status.reason) };
  return {
    ready: false,
    reason: voiceText(`voice_${status?.state || 'unavailable'}`),
  };
}

/** The microphone failure code for a getUserMedia error. */
export function micFailure(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError')
    return 'mic_denied';
  if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError')
    return 'no_mic';
  return 'mic_failed';
}

/** Footer note for a spoken turn: seconds from release to transcript and to the first word. */
export function voiceTimingText({ heardMs, firstWordMs }) {
  const seconds = (ms) => (ms / 1000).toFixed(1);
  if (!Number.isFinite(firstWordMs))
    return t('voice: heard in {heard} s', { heard: seconds(heardMs) });
  return t('voice: heard in {heard} s, first word after {first} s', {
    heard: seconds(heardMs),
    first: seconds(firstWordMs),
  });
}
