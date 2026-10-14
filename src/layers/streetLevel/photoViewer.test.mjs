import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhotoViewer } from './photoViewer.js';
import { fakeHost, until } from '../../testSupport/kartaViewFakes.mjs';

const PHOTOS = {
  a: { id: 'a', sequenceId: 's', lon: 1, lat: 2, heading: 0, isPano: true },
  b: { id: 'b', sequenceId: 's', lon: 1, lat: 2, heading: 0, isPano: true },
  f: { id: 'f', sequenceId: 's', lon: 1, lat: 2, heading: 0, isPano: false },
};

/** Sources whose panoramas and sharper flat versions are named after the photo. */
const SOURCES = {
  hasPano: (photo) => photo.isPano,
  panoFirst: (photo) => ({ url: `${photo.id}-first`, width: 2048 }),
  panoSharp: (photo) => ({ url: `${photo.id}-sharp` }),
  flatFirst: (photo) => [`${photo.id}-first`],
  flatSharp: (photo, pixels) => (pixels > 1000 ? `${photo.id}-sharp` : null),
  describe: () => ({ externalUrl: 'https://example.org' }),
};

/** A viewer whose loads wait until `release(url)` (or fail with `fail(url)`). */
function setup() {
  const pending = new Map();
  const loads = [];
  const images = [];
  const viewer = createPhotoViewer({
    providerId: 'test',
    name: 'Test',
    sources: SOURCES,
    getPhoto: async (id) => PHOTOS[id],
    step: async () => null,
    onStep() {},
    load: (url) =>
      new Promise((resolve, reject) => {
        loads.push(url);
        pending.set(url, { resolve, reject });
      }),
    createRenderer: () => ({
      setImage: (image) => images.push(image.src),
      setView() {},
      getView: () => ({ yaw: 0, pitch: 0, fov: 80 }),
      resize() {},
      clear() {},
      destroy() {},
    }),
  });
  const release = (url) => {
    const closed = { value: false };
    pending.get(url).resolve({ src: url, close: () => (closed.value = true) });
    pending.delete(url);
    return closed;
  };
  const fail = (url) => {
    pending.get(url).reject(new Error('gone'));
    pending.delete(url);
  };
  return { viewer, loads, images, release, fail, host: fakeHost() };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const parts = (host) => {
  const [picture, canvas] = host.children[0].children;
  return { picture, canvas };
};

test('a panorama that arrives after another photo opened is released, not shown', async () => {
  const env = setup();
  await env.viewer.mount(env.host);
  const first = env.viewer.open('a');
  await tick();
  const second = env.viewer.open('b');
  await tick();
  const stale = env.release('a-first');
  await first;
  assert.equal(stale.value, true, 'its bitmap is closed');
  env.release('b-first');
  await second;
  assert.deepEqual(env.images, ['b-first']);
});

test('one sharp panorama download per open, even across a quick switch and a burst of resizes', async (t) => {
  const env = setup();
  t.after(() => delete globalThis.devicePixelRatio);
  globalThis.devicePixelRatio = 1;
  await env.viewer.mount(env.host);
  const { canvas } = parts(env.host);
  canvas.clientWidth = 1800;
  const opening = env.viewer.open('a');
  await tick();
  env.release('a-first');
  await opening;
  await tick();
  assert.ok(env.loads.includes('a-sharp'), 'expanded: the sharp one is asked');
  // Photo b opens while a's sharp version is still on its way.
  const next = env.viewer.open('b');
  await tick();
  env.release('b-first');
  await next;
  await tick();
  assert.ok(env.loads.includes('b-sharp'));
  // a's download finishes late; resizes must not ask for b's again.
  env.release('a-sharp');
  await tick();
  env.viewer.resize();
  env.viewer.resize();
  await tick();
  assert.equal(env.loads.filter((url) => url === 'b-sharp').length, 1);
  env.release('b-sharp');
  await tick();
  assert.deepEqual(env.images, ['a-first', 'b-first', 'b-sharp']);
});

test('a sharper flat version that failed is tried again on the next resize', async (t) => {
  const env = setup();
  t.after(() => delete globalThis.devicePixelRatio);
  globalThis.devicePixelRatio = 1;
  await env.viewer.mount(env.host);
  const { picture } = parts(env.host);
  picture.clientWidth = 1200;
  const opening = env.viewer.open('f');
  await tick();
  env.release('f-first');
  await opening;
  await tick();
  env.fail('f-sharp');
  await tick();
  assert.equal(picture.src, 'f-first');
  env.viewer.resize();
  await tick();
  assert.equal(env.loads.filter((url) => url === 'f-sharp').length, 2);
  env.release('f-sharp');
  assert.ok(await until(() => picture.src === 'f-sharp'));
});
