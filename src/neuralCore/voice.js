/**
 * SKYNET Neural Core local voice (Phase 5): push-to-talk recording, sentence
 * splitting of a streamed answer, and an ordered, bounded speech queue. The
 * speech itself is made by the intel service (faster-whisper and Kokoro, on
 * this machine); the panel wires these pieces to its mic button.
 *
 * The microphone opens on each press and closes on release, so the browser's
 * recording indicator is off between questions. Audio is sent once, to the
 * local service, and never kept.
 */

export const MAX_RECORDING_MS = 30_000;
export const MIN_RECORDING_MS = 300;
const MAX_SENTENCE_CHARS = 240;
const MIN_SENTENCE_CHARS = 12;
const RECORDING_TYPES = Object.freeze([
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/mp4',
]);
const SENTENCE_END = /[.!?…]["'”’)\]]*\s+|\n+/;

/** Whether this browser can record and play local voice. */
export function voiceSupported(globals = globalThis) {
  return Boolean(
    globals.navigator?.mediaDevices?.getUserMedia &&
    globals.MediaRecorder &&
    (globals.AudioContext || globals.webkitAudioContext),
  );
}

/**
 * Feed streamed answer text in; complete sentences come out, ready to speak.
 * A decimal ("3.75") is not a sentence end; very short pieces ("1.") join the
 * next sentence; a sentence longer than MAX_SENTENCE_CHARS is cut at a comma
 * or a space so the first audio is not held back by a long one.
 */
export function createSentenceSplitter({ maxChars = MAX_SENTENCE_CHARS } = {}) {
  let buffer = '';
  let carry = '';

  function emit(out, piece, final) {
    const sentence = `${carry}${piece}`.trim();
    carry = '';
    if (!sentence) return;
    if (sentence.length < MIN_SENTENCE_CHARS && !final) {
      carry = `${sentence} `;
      return;
    }
    out.push(sentence);
  }

  function take(final) {
    const out = [];
    for (let match = SENTENCE_END.exec(buffer); match;) {
      const end = match.index + match[0].length;
      emit(out, buffer.slice(0, end), false);
      buffer = buffer.slice(end);
      match = SENTENCE_END.exec(buffer);
    }
    while (buffer.length > maxChars) {
      const head = buffer.slice(0, maxChars);
      const comma = head.lastIndexOf(', ');
      const space = head.lastIndexOf(' ');
      const cut =
        comma > maxChars / 2 ? comma + 1 : space > 0 ? space : maxChars;
      emit(out, buffer.slice(0, cut), false);
      buffer = buffer.slice(cut);
    }
    if (final) {
      emit(out, buffer, true);
      buffer = '';
    }
    return out;
  }

  return {
    push: (text) => {
      buffer += text || '';
      return take(false);
    },
    flush: () => take(true),
  };
}

/**
 * Push-to-talk recorder. `start()` opens the microphone and records;
 * `stop()` closes it and returns `{blob, ms}`, or null when nothing was
 * recorded (released before the microphone opened, e.g. during the browser's
 * permission prompt).
 */
export function createRecorder({
  mediaDevices,
  MediaRecorder: Recorder,
  maxMs = MAX_RECORDING_MS,
  setTimer = (...args) => setTimeout(...args),
  clearTimer = (id) => clearTimeout(id),
  now = () => performance.now(),
}) {
  let session = null;

  const mimeType = () =>
    RECORDING_TYPES.find((type) => Recorder.isTypeSupported?.(type)) || '';

  async function start({ onLimit } = {}) {
    if (session) return false;
    const current = { cancelled: false, recorder: null, stream: null };
    session = current;
    let stream;
    try {
      stream = await mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch (error) {
      if (session === current) session = null;
      throw error;
    }
    if (current.cancelled) {
      for (const track of stream.getTracks()) track.stop();
      return false;
    }
    const type = mimeType();
    const recorder = new Recorder(stream, {
      ...(type ? { mimeType: type } : {}),
      audioBitsPerSecond: 32_000,
    });
    const chunks = [];
    current.chunks = chunks;
    current.stream = stream;
    current.recorder = recorder;
    current.stopped = new Promise((resolve) => {
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data?.size) chunks.push(event.data);
      });
      recorder.addEventListener('stop', () => resolve(), { once: true });
    });
    recorder.start();
    current.startedAt = now();
    current.limit = setTimer(() => onLimit?.(), maxMs);
    return true;
  }

  async function stop() {
    const current = session;
    session = null;
    if (!current) return null;
    current.cancelled = true;
    if (!current.recorder) return null;
    clearTimer(current.limit);
    const ms = now() - current.startedAt;
    if (current.recorder.state !== 'inactive') current.recorder.stop();
    await current.stopped;
    for (const track of current.stream.getTracks()) track.stop();
    const type = current.recorder.mimeType || mimeType() || 'audio/webm';
    return { blob: new Blob(current.chunks, { type }), ms };
  }

  return {
    start,
    stop,
    get active() {
      return session !== null;
    },
  };
}

/**
 * Speaks sentences in order. At most two requests are out at once (the
 * sentence being fetched or played and one prefetched); later sentences wait
 * as text, so the service never builds a backlog. `stop()` aborts both and
 * drops the rest.
 */
export function createSpeaker({
  speak,
  createContext = () =>
    new (globalThis.AudioContext || globalThis.webkitAudioContext)(),
  onFirstAudio = () => {},
  onPlay = () => {},
  onIdle = () => {},
  onError = () => {},
}) {
  let context = null;
  let generation = 0;
  let controller = null;
  let prefetch = null;
  let running = false;
  let current = null;
  let firstPending = false;
  const queue = [];

  /** Call inside the press handler: browsers allow audio after a gesture. */
  function unlock() {
    context ??= createContext();
    if (context.state === 'suspended') void context.resume();
  }

  function request(text) {
    const pending = speak(text, { signal: controller.signal });
    pending.catch(() => {}); // awaited later; never an unhandled rejection
    return pending;
  }

  async function play(clip, epoch) {
    unlock();
    const buffer = await context.decodeAudioData(clip.audio);
    if (epoch !== generation) return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const ended = new Promise((resolve) => {
      source.onended = resolve;
    });
    current = source;
    source.start();
    onPlay();
    if (firstPending) {
      firstPending = false;
      onFirstAudio(clip);
    }
    await ended;
    if (current === source) current = null;
  }

  async function run(epoch) {
    running = true;
    try {
      while (epoch === generation && (prefetch || queue.length)) {
        const next = prefetch ?? request(queue.shift());
        prefetch = queue.length ? request(queue.shift()) : null;
        let clip;
        try {
          clip = await next;
        } catch (error) {
          if (epoch !== generation) return;
          onError(error);
          continue;
        }
        if (epoch !== generation) return;
        try {
          await play(clip, epoch);
        } catch (error) {
          if (epoch === generation) onError(error);
        }
      }
    } finally {
      if (epoch === generation) {
        running = false;
        onIdle();
      }
    }
  }

  function stop() {
    generation += 1;
    controller?.abort();
    controller = null;
    queue.length = 0;
    prefetch = null;
    running = false;
    firstPending = false;
    try {
      current?.stop();
    } catch {
      /* already stopped */
    }
    current = null;
  }

  return {
    unlock,
    stop,
    /** A new reply: stop the old one; its first audio is reported. */
    begin() {
      stop();
      firstPending = true;
    },
    say(text) {
      if (!text) return;
      controller ??= new AbortController();
      queue.push(text);
      if (running && !prefetch) prefetch = request(queue.shift());
      else if (!running) void run(generation);
    },
    get speaking() {
      return running;
    },
  };
}
