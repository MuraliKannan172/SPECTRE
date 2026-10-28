import test from 'node:test';
import assert from 'node:assert/strict';

import { NeuralCoreError } from './client.js';
import { micFailure, voiceState, voiceTimingText } from './view.js';
import { mountVoiceControl } from './voiceControl.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeElement() {
  const listeners = {};
  return {
    dataset: {},
    attributes: {},
    hidden: false,
    textContent: '',
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
    setPointerCapture() {},
    fire(type, event = {}) {
      for (const fn of listeners[type] || [])
        fn({ preventDefault() {}, button: 0, ...event });
    },
  };
}

function setup({ ready = true, take = { ms: 1500 }, busy = false } = {}) {
  const calls = {
    started: 0,
    stopped: 0,
    transcribed: [],
    questions: [],
    spoken: 0,
  };
  const recorder = {
    start: async () => {
      calls.started += 1;
      return true;
    },
    stop: async () => {
      calls.stopped += 1;
      return (
        take && { blob: new Blob(['opus'], { type: 'audio/webm' }), ...take }
      );
    },
  };
  const speaker = {
    unlock() {},
    stop() {
      calls.spoken += 1;
    },
  };
  const client = {
    transcribe: async (blob) => {
      calls.transcribed.push(blob);
      return { text: 'Fly to Nairobi.', language: 'en', seconds: 0.8 };
    },
  };
  let clock = 0;
  const control = mountVoiceControl({
    document: { createElement: fakeElement },
    client,
    recorder,
    speaker,
    isBusy: () => busy,
    onQuestion: (question) => calls.questions.push(question),
    now: () => (clock += 100),
  });
  if (ready) control.update({ state: 'ready', speaks: ['en'] });
  return { control, calls, client, recorder };
}

async function hold(mic) {
  mic.fire('pointerdown');
  await tick();
  mic.fire('pointerup');
  await tick();
  await tick();
}

test('hold, speak, release: the transcript becomes a question', async () => {
  const { control, calls } = setup();
  assert.equal(control.mic.attributes['aria-disabled'], 'false');
  control.mic.fire('pointerdown');
  await tick();
  assert.equal(control.mic.dataset.state, 'recording');
  assert.equal(control.hint.dataset.code, 'listening');
  control.mic.fire('pointerup');
  control.mic.fire('lostpointercapture'); // a second release changes nothing
  await tick();
  await tick();
  assert.equal(calls.stopped, 1);
  assert.equal(calls.transcribed.length, 1);
  assert.equal(calls.questions.length, 1);
  assert.equal(calls.questions[0].text, 'Fly to Nairobi.');
  assert.equal(calls.questions[0].sttSeconds, 0.8);
  assert.ok(calls.questions[0].transcribedAt > calls.questions[0].releasedAt);
  assert.equal(control.hint.hidden, true);
  assert.equal(control.mic.dataset.state, 'ready');
  assert.ok(calls.spoken >= 1, 'a press silences any reply being spoken');
});

test('it says Listening only once the microphone is really recording', async () => {
  const { control, recorder } = setup();
  let open;
  recorder.start = () => new Promise((resolve) => (open = resolve));
  control.mic.fire('pointerdown');
  await tick();
  assert.equal(control.hint.dataset.code, 'opening');
  open(true);
  await tick();
  assert.equal(control.hint.dataset.code, 'listening');
});

test('the keyboard works the same way, ignoring key repeat', async () => {
  const { control, calls } = setup();
  control.mic.fire('keydown', { key: ' ' });
  control.mic.fire('keydown', { key: ' ', repeat: true });
  await tick();
  control.mic.fire('keyup', { key: ' ' });
  await tick();
  await tick();
  assert.equal(calls.started, 1);
  assert.equal(calls.questions.length, 1);
});

test('a tap, or a release during the permission prompt, sends nothing', async () => {
  for (const take of [{ ms: 120 }, null]) {
    const { control, calls } = setup({ take });
    await hold(control.mic);
    assert.equal(calls.transcribed.length, 0);
    assert.equal(control.hint.dataset.code, 'too_short');
  }
});

test('when local voice cannot run, a press says why and records nothing', async () => {
  const { control, calls } = setup({ ready: false });
  control.update({ state: 'unavailable', reason: 'models_missing' });
  assert.equal(control.mic.attributes['aria-disabled'], 'true');
  assert.match(control.mic.title, /skynet\.ps1 -Voice/);
  await hold(control.mic);
  assert.equal(calls.started, 0);
  assert.match(control.hint.textContent, /scripts\\skynet\.ps1 -Voice/);
});

test('a refused microphone, a busy panel and a failed transcript each say so', async () => {
  const denied = setup();
  denied.recorder.start = async () => {
    throw Object.assign(new Error('no'), { name: 'NotAllowedError' });
  };
  await hold(denied.control.mic);
  assert.equal(denied.control.hint.dataset.code, 'mic_denied');
  assert.equal(denied.control.mic.dataset.state, 'ready');

  const busy = setup({ busy: true });
  await hold(busy.control.mic);
  assert.equal(busy.calls.started, 0);
  assert.equal(busy.control.hint.dataset.code, 'busy');

  const silent = setup();
  silent.client.transcribe = async () => {
    throw new NeuralCoreError('no_speech', 422);
  };
  await hold(silent.control.mic);
  assert.equal(silent.control.hint.dataset.code, 'no_speech');
  assert.equal(silent.calls.questions.length, 0);
});

test('voice state, microphone failures and timings read plainly', () => {
  assert.deepEqual(voiceState({ state: 'ready' }), { ready: true, reason: '' });
  assert.match(voiceState({ state: 'loading' }).reason, /loading/);
  assert.match(voiceState({ state: 'failed' }).reason, /failed to load/);
  assert.match(
    voiceState({ state: 'unavailable', reason: 'not_installed' }).reason,
    /not installed: run scripts\\skynet\.ps1 -Voice/,
  );
  assert.match(
    voiceState(null, { failureCode: 'intel_offline' }).reason,
    /offline/,
  );
  assert.match(
    voiceState({ state: 'ready' }, { supported: false }).reason,
    /cannot record/,
  );
  // A LAN page over http, or the proxy refusing voice off this machine.
  const localOnly = /only on the computer running SKYNET/;
  assert.match(
    voiceState(null, { supported: false, secure: false }).reason,
    localOnly,
  );
  assert.match(
    voiceState(null, { failureCode: 'voice_local_only' }).reason,
    localOnly,
  );
  assert.equal(micFailure({ name: 'NotAllowedError' }), 'mic_denied');
  assert.equal(micFailure({ name: 'NotFoundError' }), 'no_mic');
  assert.equal(micFailure(new Error('x')), 'mic_failed');
  assert.equal(voiceTimingText({ heardMs: 1234 }), 'voice: heard in 1.2 s');
  assert.equal(
    voiceTimingText({ heardMs: 1234, firstWordMs: 4567 }),
    'voice: heard in 1.2 s, first word after 4.6 s',
  );
});
