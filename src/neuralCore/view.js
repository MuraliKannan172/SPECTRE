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
