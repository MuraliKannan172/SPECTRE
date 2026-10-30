/**
 * SPECTRE Neural Core: the browser side of /api/intel/chat and /voice, through
 * the app's same-origin proxy (server/providers/intel.js). Transport only, no
 * DOM.
 */

const BASE = '/api/intel/chat';
const VOICE = '/api/intel/voice';

/** A failed call; `code` is the service's or proxy's own reason. */
export class NeuralCoreError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.name = 'NeuralCoreError';
    this.code = code;
    this.status = status;
  }
}

export async function failure(response) {
  let code = `http_${response.status}`;
  try {
    const body = await response.json();
    code = body?.detail?.code || body?.state || body?.error || code;
  } catch {
    /* not JSON: keep the status code */
  }
  return new NeuralCoreError(code, response.status);
}

function post(body) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * Feed text in, get `onEvent(name, data)` per complete server-sent event.
 * Blocks may arrive split across chunks; malformed data is skipped.
 * @param {(name: string, data: any) => void} onEvent
 * @returns {(text: string) => void}
 */
export function createSseParser(onEvent) {
  let buffer = '';
  return (text) => {
    buffer += text.replace(/\r\n/g, '\n');
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let name = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (!data.length) continue;
      let parsed;
      try {
        parsed = JSON.parse(data.join('\n'));
      } catch {
        continue;
      }
      onEvent(name, parsed);
    }
  };
}

/**
 * @param {{fetchImpl?: typeof fetch}} [options]
 */
export function createNeuralCoreClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function call(url, init = {}) {
    const response = await fetchImpl(url, init);
    if (!response.ok) throw await failure(response);
    return response;
  }
  async function json(path, init = {}, base = BASE) {
    const response = await call(`${base}${path}`, init);
    return response.status === 204 ? null : response.json();
  }

  return {
    status: ({ signal } = {}) => json('/status', { signal }),
    history: ({ signal } = {}) => json('/history', { signal }),
    clearHistory: () => json('/history', { method: 'DELETE' }),
    stop: (turnId) => json('/stop', post({ turn_id: turnId })),
    toolResult: ({ turnId, callId, ok, result, error }) =>
      json(
        '/tool-result',
        post({
          turn_id: turnId,
          call_id: callId,
          ok,
          result: ok ? result : null,
          error: ok ? null : String(error ?? 'failed').slice(0, 500),
        }),
      ),

    /** Local voice: whether it can run, and why not. */
    voiceStatus: ({ signal } = {}) => json('/status', { signal }, VOICE),
    /** One recorded question as text: {text, language, seconds, ...}. */
    transcribe: (audio, { signal } = {}) =>
      json(
        '/transcribe',
        {
          method: 'POST',
          headers: { 'Content-Type': audio.type || 'audio/webm' },
          body: audio,
          signal,
        },
        VOICE,
      ),
    /** One sentence as WAV audio, and the seconds the service took. */
    async speak(text, { signal } = {}) {
      const response = await call(`${VOICE}/speak`, {
        ...post({ text }),
        signal,
      });
      return {
        audio: await response.arrayBuffer(),
        seconds: Number(response.headers.get('x-voice-seconds')) || null,
      };
    },

    /**
     * Run one turn; resolves when the stream ends. Events arrive through
     * `onEvent` as they stream.
     */
    async turn({
      message = '',
      regenerate = false,
      conversationId = null,
      viewport = null,
      layerState = null,
      signal,
      onEvent,
    }) {
      const response = await fetchImpl(BASE, {
        ...post({
          message,
          regenerate,
          conversation_id: conversationId,
          viewport,
          layer_state: layerState,
        }),
        signal,
      });
      if (!response.ok) throw await failure(response);
      const parse = createSseParser(onEvent);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parse(decoder.decode(value, { stream: true }));
      }
      parse(decoder.decode());
    },
  };
}
