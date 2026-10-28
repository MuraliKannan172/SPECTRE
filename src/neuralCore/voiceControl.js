/**
 * SKYNET Neural Core: the push-to-talk mic button. Hold it (pointer, or Space
 * or Enter on the focused button) to record; release to transcribe on this
 * machine and hand the text to the panel as an ordinary question. Pressing it
 * also silences a reply being spoken. When local voice cannot run, the button
 * stays visible, marked unavailable, and pressing it says why.
 */
import { t } from '../i18n/index.js';
import { NeuralCoreError } from './client.js';
import { micFailure, voiceState, voiceText } from './view.js';
import { MIN_RECORDING_MS } from './voice.js';

/**
 * @param {{document: Document, client: ReturnType<import('./client.js').createNeuralCoreClient>,
 *   recorder: ReturnType<import('./voice.js').createRecorder> | null,
 *   speaker: ReturnType<import('./voice.js').createSpeaker> | null,
 *   isBusy: () => boolean,
 *   onQuestion: (question: {text: string, language: string, releasedAt: number,
 *     recordedAt: number, transcribedAt: number, sttSeconds: number}) => void,
 *   now?: () => number}} options
 */
export function mountVoiceControl({
  document,
  client,
  recorder,
  speaker,
  isBusy,
  onQuestion,
  now = () => performance.now(),
}) {
  const mic = document.createElement('button');
  mic.type = 'button';
  mic.className = 'skynet-nc-mic';
  mic.textContent = '🎙';
  const hint = document.createElement('p');
  hint.className = 'skynet-nc-voice';
  hint.setAttribute('aria-live', 'polite');
  hint.hidden = true;

  let state = voiceState(null, { supported: Boolean(recorder && speaker) });
  let pressed = false;
  let working = false;
  const listeners = [];
  const on = (target, type, handler) => {
    target.addEventListener(type, handler);
    listeners.push(() => target.removeEventListener(type, handler));
  };

  function show(code) {
    hint.textContent = code ? voiceText(code) : '';
    hint.hidden = !code;
    hint.dataset.code = code || '';
  }

  function render() {
    const label = state.ready ? t('Hold to talk') : state.reason;
    mic.title = label;
    mic.setAttribute('aria-label', label);
    mic.setAttribute('aria-disabled', state.ready ? 'false' : 'true');
    mic.dataset.state = pressed ? 'recording' : state.ready ? 'ready' : 'off';
  }

  async function press() {
    if (pressed || working) return;
    speaker?.stop();
    if (!state.ready) {
      hint.textContent = state.reason;
      hint.hidden = false;
      hint.dataset.code = 'unavailable';
      return;
    }
    if (isBusy()) {
      show('busy');
      return;
    }
    speaker.unlock(); // inside the gesture, so the reply may play later
    pressed = true;
    render();
    show('listening');
    try {
      await recorder.start({ onLimit: () => void release() });
    } catch (error) {
      pressed = false;
      render();
      show(micFailure(error));
    }
  }

  async function release() {
    if (!pressed) return;
    pressed = false;
    render();
    const releasedAt = now();
    working = true;
    try {
      const take = await recorder.stop();
      if (!take || take.ms < MIN_RECORDING_MS) {
        show('too_short');
        return;
      }
      show('transcribing');
      const recordedAt = now();
      const heard = await client.transcribe(take.blob);
      show(null);
      onQuestion({
        text: heard.text,
        language: heard.language,
        releasedAt,
        recordedAt,
        transcribedAt: now(),
        sttSeconds: heard.seconds,
      });
    } catch (error) {
      show(error instanceof NeuralCoreError ? error.code : 'network');
    } finally {
      working = false;
    }
  }

  on(mic, 'pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    mic.setPointerCapture?.(event.pointerId);
    void press();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
    on(mic, type, () => void release());
  on(mic, 'keydown', (event) => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
      event.preventDefault();
      void press();
    }
  });
  on(mic, 'keyup', (event) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      void release();
    }
  });
  on(mic, 'contextmenu', (event) => event.preventDefault());
  render();

  return {
    mic,
    hint,
    show,
    /** New status from the service, or the code of the failure to get it. */
    update(status, failureCode = null) {
      state = voiceState(status, {
        supported: Boolean(recorder && speaker),
        failureCode,
      });
      render();
    },
    destroy() {
      for (const remove of listeners) remove();
      if (pressed) void recorder.stop();
      speaker?.stop();
    },
  };
}
