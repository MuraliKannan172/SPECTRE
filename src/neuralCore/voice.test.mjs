import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRecorder,
  createSentenceSplitter,
  createSpeaker,
  voiceSupported,
} from './voice.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('streamed text comes out as whole sentences, decimals intact', () => {
  const split = createSentenceSplitter();
  const out = [];
  for (const piece of [
    'The rate is 3.',
    '75 to 4.00% [1]. Flying',
    ' to Nairobi',
    ' now!\n1. ',
    'Done',
  ]) {
    out.push(...split.push(piece));
  }
  assert.deepEqual(out, [
    'The rate is 3.75 to 4.00% [1].',
    'Flying to Nairobi now!',
  ]);
  assert.deepEqual(split.flush(), ['1. Done']);
  assert.deepEqual(split.flush(), []);
});

test('a long sentence is cut at a comma or a space', () => {
  const split = createSentenceSplitter({ maxChars: 40 });
  const pieces = split.push(
    'Storms crossed the region overnight, flooding roads and closing schools across three provinces',
  );
  assert.ok(pieces.length >= 2);
  assert.ok(pieces.every((piece) => piece.length <= 40));
  assert.equal(pieces[0], 'Storms crossed the region overnight,');
  const rest = [...pieces.slice(1), ...split.flush()].join(' ');
  assert.equal(
    rest,
    'flooding roads and closing schools across three provinces',
  );
});

function fakeMedia({ grantAfter = 0 } = {}) {
  const tracks = [];
  let grant;
  const media = {
    tracks,
    requests: 0,
    grant: () => grant?.(),
    mediaDevices: {
      getUserMedia: () => {
        media.requests += 1;
        const track = { stopped: false, stop: () => (track.stopped = true) };
        tracks.push(track);
        const stream = { getTracks: () => [track] };
        if (!grantAfter) return Promise.resolve(stream);
        return new Promise((resolve) => (grant = () => resolve(stream)));
      },
    },
  };
  class FakeRecorder {
    static isTypeSupported = (type) => type === 'audio/webm;codecs=opus';
    constructor(stream, options) {
      this.mimeType = options.mimeType;
      this.state = 'inactive';
      this.listeners = {};
      FakeRecorder.last = this;
    }
    addEventListener(name, fn) {
      (this.listeners[name] ||= []).push(fn);
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      for (const fn of this.listeners.dataavailable || [])
        fn({ data: new Blob(['opus'], { type: this.mimeType }) });
      for (const fn of this.listeners.stop || []) fn();
    }
  }
  media.MediaRecorder = FakeRecorder;
  return media;
}

test('a press records opus and the release closes the microphone', async () => {
  const media = fakeMedia();
  let clock = 1000;
  const recorder = createRecorder({ ...media, now: () => clock });
  assert.equal(await recorder.start(), true);
  assert.equal(recorder.active, true);
  clock += 2500;
  const { blob, ms } = await recorder.stop();
  assert.equal(ms, 2500);
  assert.equal(blob.type, 'audio/webm;codecs=opus');
  assert.equal(await blob.text(), 'opus');
  assert.equal(media.tracks[0].stopped, true);
  assert.equal(recorder.active, false);
});

test('released during the permission prompt: nothing recorded, microphone closed', async () => {
  const media = fakeMedia({ grantAfter: 1 });
  const recorder = createRecorder(media);
  const started = recorder.start();
  await tick();
  assert.equal(await recorder.stop(), null);
  media.grant();
  assert.equal(await started, false);
  assert.equal(media.tracks[0].stopped, true);
  assert.equal(recorder.active, false);
});

test('a refused microphone rejects and leaves the recorder free', async () => {
  const media = fakeMedia();
  media.mediaDevices.getUserMedia = () =>
    Promise.reject(
      Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
    );
  const recorder = createRecorder(media);
  await assert.rejects(recorder.start(), { name: 'NotAllowedError' });
  assert.equal(recorder.active, false);
});

function fakeAudio() {
  const played = [];
  const sources = [];
  const context = {
    state: 'suspended',
    resumed: 0,
    destination: {},
    resume() {
      this.resumed += 1;
      this.state = 'running';
      return Promise.resolve();
    },
    decodeAudioData: async (audio) => ({ audio }),
    createBufferSource() {
      const source = {
        connect() {},
        start() {
          played.push(source.buffer.audio);
        },
        stop() {
          source.stopped = true;
          source.onended?.();
        },
      };
      sources.push(source);
      return source;
    },
  };
  return { context, played, sources, end: (i) => sources[i].onended() };
}

function fakeService() {
  const calls = [];
  const service = {
    calls,
    inFlight: 0,
    maxInFlight: 0,
    speak(text, { signal }) {
      service.inFlight += 1;
      service.maxInFlight = Math.max(service.maxInFlight, service.inFlight);
      return new Promise((resolve, reject) => {
        let settled = false;
        const settle = () => {
          if (settled) return false;
          settled = true;
          service.inFlight -= 1;
          return true;
        };
        calls.push({
          text,
          signal,
          resolve: () => settle() && resolve({ audio: text, seconds: 0.5 }),
        });
        signal.addEventListener('abort', () => {
          if (settle())
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    },
  };
  return service;
}

test('sentences play in order with at most two requests out', async () => {
  const audio = fakeAudio();
  const service = fakeService();
  const first = [];
  const speaker = createSpeaker({
    speak: service.speak,
    createContext: () => audio.context,
    onFirstAudio: (clip) => first.push(clip.audio),
  });
  speaker.unlock();
  assert.equal(audio.context.resumed, 1);
  speaker.begin();
  for (const text of ['One.', 'Two.', 'Three.', 'Four.']) speaker.say(text);
  await tick();
  assert.deepEqual(
    service.calls.map((c) => c.text),
    ['One.', 'Two.'],
  );
  service.calls[1].resolve();
  service.calls[0].resolve();
  await tick();
  assert.deepEqual(audio.played, ['One.']);
  assert.deepEqual(first, ['One.']);
  audio.end(0);
  await tick();
  assert.deepEqual(audio.played, ['One.', 'Two.']);
  assert.deepEqual(
    service.calls.map((c) => c.text),
    ['One.', 'Two.', 'Three.'],
  );
  service.calls[2].resolve();
  audio.end(1);
  await tick();
  service.calls[3].resolve();
  audio.end(2);
  await tick();
  audio.end(3);
  await tick();
  assert.deepEqual(audio.played, ['One.', 'Two.', 'Three.', 'Four.']);
  assert.equal(service.maxInFlight, 2);
  assert.deepEqual(first, ['One.']);
  assert.equal(speaker.speaking, false);
});

test('stop silences the reply, aborts its requests and drops the rest', async () => {
  const audio = fakeAudio();
  const service = fakeService();
  const errors = [];
  const speaker = createSpeaker({
    speak: service.speak,
    createContext: () => audio.context,
    onError: (error) => errors.push(error),
  });
  speaker.begin();
  for (const text of ['One.', 'Two.', 'Three.']) speaker.say(text);
  service.calls[0].resolve();
  await tick();
  assert.deepEqual(audio.played, ['One.']);
  speaker.stop();
  await tick();
  assert.equal(audio.sources[0].stopped, true);
  assert.equal(service.calls[1].signal.aborted, true);
  assert.equal(service.inFlight, 0);
  assert.equal(service.calls.length, 2);
  assert.deepEqual(errors, []);
  speaker.say('Again.');
  await tick();
  assert.equal(service.calls.at(-1).text, 'Again.');
  assert.equal(service.calls.at(-1).signal.aborted, false);
});

test('voice needs a microphone, a recorder and Web Audio', () => {
  assert.equal(voiceSupported({}), false);
  assert.equal(
    voiceSupported({
      navigator: { mediaDevices: { getUserMedia() {} } },
      MediaRecorder: class {},
      AudioContext: class {},
    }),
    true,
  );
});
