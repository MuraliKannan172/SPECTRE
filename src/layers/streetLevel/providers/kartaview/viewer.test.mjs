import assert from 'node:assert/strict';
import test from 'node:test';
import { createKartaViewViewer } from './viewer.js';
import { fakeHost } from '../../../../testSupport/kartaViewFakes.mjs';

const PHOTOS = {
  flat1: {
    id: 'flat1',
    sequenceId: 's1',
    sequenceIndex: 1,
    lon: -83.04,
    lat: 42.33,
    heading: 90,
    isPano: false,
    capturedAt: Date.UTC(2016, 7, 23),
    urls: {
      view: 'https://storage2.openstreetcam.org/lth/a.jpg',
      full: 'https://storage2.openstreetcam.org/proc/a.jpg',
      pano: null,
    },
  },
  flat2: {
    id: 'flat2',
    sequenceId: 's1',
    sequenceIndex: 2,
    lon: -83.0401,
    lat: 42.33,
    heading: 92,
    isPano: false,
    capturedAt: Date.UTC(2016, 7, 23),
    urls: {
      view: 'https://storage2.openstreetcam.org/lth/b.jpg',
      full: 'https://storage2.openstreetcam.org/proc/b.jpg',
      pano: null,
    },
  },
  pano1: {
    id: 'pano1',
    sequenceId: 's2',
    sequenceIndex: 7,
    lon: 106.84,
    lat: -6.19,
    heading: 150,
    isPano: true,
    capturedAt: Date.UTC(2022, 2, 21),
    urls: {
      view: 'https://storage13.openstreetcam.org/lth/p.jpg',
      full: 'https://storage13.openstreetcam.org/wrapped_proc/p.jpg',
      pano: 'https://storage13.openstreetcam.org/wrapped_proc/p.jpg',
    },
  },
};

function fakeRenderer(canvas) {
  const view = { yaw: 0, pitch: 0, fov: 80 };
  return {
    images: [],
    hiddenAtSetImage: [],
    setImage(image) {
      this.images.push(image.src);
      // A hidden canvas measures 0×0: sizing it then gives a 1×1 buffer.
      this.hiddenAtSetImage.push(canvas?.hidden);
    },
    setView(next) {
      Object.assign(view, next);
    },
    getView: () => ({ ...view }),
    resize() {},
    clear() {},
    destroy() {
      this.destroyed = true;
    },
  };
}

function setup({
  failLoads = [],
  rendererThrows = false,
  steps = {},
  failSteps = false,
} = {}) {
  const loads = [];
  const renderers = [];
  const stepped = [];
  const viewer = createKartaViewViewer({
    getPhoto: async (id) => {
      if (!PHOTOS[id]) throw new Error('no such photo');
      return PHOTOS[id];
    },
    step: async (photo, delta) => {
      if (failSteps) throw new Error('KartaView did not answer in time');
      return steps[`${photo.id}:${delta}`] ?? null;
    },
    // The core opens what ‹ › chose; here the adapter is opened directly.
    onStep: (id) => {
      stepped.push(id);
      viewer.open(id).catch(() => {});
    },
    load: async (url, options) => {
      loads.push({ url, crossOrigin: options?.crossOrigin });
      if (failLoads.some((part) => url.includes(part)))
        throw new Error('The KartaView photo could not be loaded');
      return { src: url };
    },
    createRenderer: (canvas) => {
      if (rendererThrows) throw new Error('WebGL is unavailable');
      const renderer = fakeRenderer(canvas);
      renderers.push(renderer);
      return renderer;
    },
  });
  const poses = [];
  viewer.onPose((pose) => poses.push(pose));
  const host = fakeHost();
  return { viewer, poses, host, loads, renderers, stepped };
}

const parts = (host) => {
  const root = host.children[0];
  const [picture, canvas, prev, next] = root.children;
  return { root, picture, canvas, prev, next };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a flat photo shows its 1280 px version, then the sharp one, with a pose facing its heading', async () => {
  const { viewer, poses, host, loads } = setup({
    steps: { 'flat1:1': 'flat2', 'flat1:-1': 'flat0' },
  });
  await viewer.mount(host);
  const { picture, canvas, prev, next } = parts(host);
  assert.equal(prev.disabled, true, 'nothing to step through yet');
  await viewer.open('flat1');
  assert.equal(picture.hidden, false);
  assert.equal(canvas.hidden, true);
  assert.equal(prev.disabled, false);
  assert.equal(next.disabled, false);
  const pose = poses.at(-1);
  assert.deepEqual(
    {
      providerId: pose.providerId,
      imageId: pose.imageId,
      position: pose.position,
      bearing: pose.bearing,
      tilt: pose.tilt,
      isPano: pose.isPano,
      sequenceId: pose.sequenceId,
      capturedAt: pose.capturedAt,
      title: pose.title,
    },
    {
      providerId: 'kartaview',
      imageId: 'flat1',
      position: { lon: -83.04, lat: 42.33 },
      bearing: 90,
      tilt: 0,
      isPano: false,
      sequenceId: 's1',
      capturedAt: Date.UTC(2016, 7, 23),
      title: null,
    },
  );
  assert.match(pose.externalUrl, /^https:\/\/cdn\.kartaview\.org\/pr:sharp\//);
  // The proxy's 1,280 px version first: KartaView's own can be 1.7 MB.
  assert.match(
    loads[0].url,
    /^https:\/\/cdn\.kartaview\.org\/.*rs:fit:1280:1280/,
  );
  assert.equal(loads[0].crossOrigin, false, 'an <img> needs no CORS');
  await settle();
  assert.match(
    loads[1].url,
    /^https:\/\/cdn\.kartaview\.org\/.*rs:fit:2560:2560/,
  );
  assert.equal(picture.src, loads[1].url, 'upgraded to the sharp version');
  assert.equal(viewer.supportsRenderModes(), true);
  viewer.setRenderMode('fill');
  assert.equal(picture.style.objectFit, 'cover');
});

test('a failing image proxy falls back to the photo on KartaView storage', async () => {
  const { viewer, host, loads } = setup({ failLoads: ['cdn.kartaview.org'] });
  await viewer.mount(host);
  await viewer.open('flat1');
  assert.equal(loads[1].url, PHOTOS.flat1.urls.view);
  assert.equal(parts(host).picture.hidden, false);
  assert.equal(parts(host).picture.src, PHOTOS.flat1.urls.view);
});

test('a 360° photo shows on the panorama, preview first; dragging turns the bearing', async () => {
  const { viewer, poses, host, loads, renderers } = setup();
  await viewer.mount(host);
  await viewer.open('pano1');
  const { picture, canvas } = parts(host);
  assert.equal(canvas.hidden, false);
  assert.equal(picture.hidden, true);
  assert.match(loads[0].url, /rs:fit:1024:512/);
  assert.equal(loads[0].crossOrigin, true, 'WebGL textures need CORS');
  assert.equal(poses.at(-1).isPano, true);
  assert.equal(poses.at(-1).bearing, 150);
  assert.equal(viewer.supportsRenderModes(), false, 'no frame to fit');
  await settle();
  assert.match(renderers[0].images.at(-1), /rs:fit:4096:2048/);
  // Drag left by a quarter of the width: the view turns right.
  const frames = [];
  globalThis.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return frames.length;
  };
  try {
    canvas.fire('pointerdown', {
      button: 0,
      pointerId: 1,
      clientX: 200,
      clientY: 100,
    });
    canvas.fire('pointermove', { pointerId: 1, clientX: 100, clientY: 100 });
    canvas.fire('pointerup', { pointerId: 1 });
    frames.forEach((callback) => callback());
  } finally {
    delete globalThis.requestAnimationFrame;
  }
  const turned = poses.at(-1).bearing;
  assert.ok(turned > 150 && turned < 360, `bearing ${turned} turned right`);
});

test('without WebGL, or when the panorama fails, a 360° photo shows its front view', async () => {
  const noGl = setup({ rendererThrows: true });
  await noGl.viewer.mount(noGl.host);
  await noGl.viewer.open('pano1');
  assert.equal(parts(noGl.host).picture.hidden, false);
  assert.equal(noGl.loads[0].url, PHOTOS.pano1.urls.view);
  assert.equal(noGl.poses.at(-1).isPano, false);
  await settle();
  assert.equal(
    noGl.loads.length,
    1,
    'the equirectangular image never replaces it',
  );

  const broken = setup({ failLoads: ['cdn.kartaview.org'] });
  await broken.viewer.mount(broken.host);
  await broken.viewer.open('pano1');
  assert.equal(parts(broken.host).picture.hidden, false);
  assert.equal(broken.poses.at(-1).imageId, 'pano1');
});

test('‹ › and the arrow keys step along the sequence; ends disable at once', async () => {
  const { viewer, poses, host, stepped } = setup({
    steps: { 'flat1:1': 'flat2', 'flat2:-1': 'flat1' },
  });
  await viewer.mount(host);
  await viewer.open('flat1');
  const { root, prev, next } = parts(host);
  await settle();
  assert.equal(prev.disabled, true, 'flat1 is the first photo: known up front');
  assert.equal(next.disabled, false);
  next.fire('click');
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(poses.at(-1).imageId, 'flat2');
  assert.deepEqual(stepped, ['flat2'], 'the core is asked to open it');
  assert.equal(next.disabled, true, 'flat2 is the last photo');
  assert.equal(prev.disabled, false);
  root.fire('keydown', { key: 'ArrowLeft', metaKey: true });
  await settle();
  assert.equal(poses.at(-1).imageId, 'flat2', 'modified arrows are not ours');
  root.fire('keydown', { key: 'ArrowLeft' });
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(poses.at(-1).imageId, 'flat1');
});

test('quick presses each step on from the photo the last one chose', async () => {
  const chain = { 'flat1:1': 'flat2', 'flat2:1': 'pano1' };
  const { viewer, host, stepped } = setup({
    steps: chain,
    rendererThrows: true,
  });
  await viewer.mount(host);
  await viewer.open('flat1');
  const { next } = parts(host);
  next.fire('click');
  next.fire('click');
  for (let i = 0; i < 8; i++) await settle();
  assert.deepEqual(stepped, ['flat2', 'pano1']);
});

test('a newer open wins; close hides the photo; unmount tears down the panorama', async () => {
  const { viewer, poses, host, renderers } = setup();
  await viewer.mount(host);
  const first = viewer.open('pano1');
  const second = viewer.open('flat1');
  await Promise.all([first, second]);
  assert.deepEqual(
    poses.map((pose) => pose.imageId),
    ['flat1'],
    'the overtaken panorama never posed',
  );
  assert.equal(renderers.length, 0, 'nor built a WebGL context');
  await viewer.open('pano1');
  viewer.close();
  const { picture, canvas, root } = parts(host);
  assert.equal(canvas.hidden, true);
  assert.equal(picture.hidden, true);
  assert.equal(root.dataset.kind, '');
  await assert.rejects(viewer.open('nope'), /no such photo/);
  viewer.unmount();
  assert.equal(host.children.length, 0);
  assert.equal(renderers[0].destroyed, true);
  await assert.rejects(viewer.open('flat1'), /not mounted/);
});

test('a panorama is put on screen before its image is sized into the canvas', async () => {
  const { viewer, host, renderers } = setup();
  await viewer.mount(host);
  await viewer.open('flat1');
  await viewer.open('pano1');
  await settle();
  assert.deepEqual(renderers[0].hiddenAtSetImage, [false, false]);
});

test('a step that gets no answer is not the end of the sequence', async () => {
  const { viewer, host, poses } = setup({ failSteps: true });
  await viewer.mount(host);
  await viewer.open('flat1');
  const { next } = parts(host);
  next.disabled = false;
  next.fire('click');
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(next.disabled, false, 'still enabled: try again');
  assert.equal(poses.at(-1).imageId, 'flat1');
});

test('the keyboard looks around a panorama: Shift+arrows turn, ↑ ↓ tilt, + − zoom', async (t) => {
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  t.after(() => delete globalThis.requestAnimationFrame);
  const { viewer, host, renderers, stepped } = setup({
    steps: { 'pano1:1': 'flat1' },
  });
  await viewer.mount(host);
  await viewer.open('pano1');
  const { root } = parts(host);
  const view = () => renderers[0].getView();
  root.fire('keydown', { key: 'ArrowRight', shiftKey: true });
  assert.ok(view().yaw > 0, 'turned right');
  root.fire('keydown', { key: 'ArrowUp' });
  assert.ok(view().pitch > 0, 'looked up');
  const before = view().fov;
  root.fire('keydown', { key: '+' });
  assert.ok(view().fov < before, 'zoomed in');
  root.fire('keydown', { key: '-' });
  root.fire('keydown', { key: '-' });
  assert.ok(view().fov > before, 'zoomed out');
  for (let i = 0; i < 4; i++) await settle();
  assert.deepEqual(stepped, [], 'none of those stepped');
  root.fire('keydown', { key: 'ArrowRight' });
  for (let i = 0; i < 4; i++) await settle();
  assert.deepEqual(stepped, ['flat1'], 'a plain arrow still steps');
});

test('two fingers pinch the panorama’s zoom', async () => {
  const { viewer, host, renderers } = setup();
  await viewer.mount(host);
  await viewer.open('pano1');
  const { canvas } = parts(host);
  const before = renderers[0].getView().fov;
  canvas.fire('pointerdown', {
    pointerId: 1,
    pointerType: 'touch',
    clientX: 100,
    clientY: 100,
  });
  canvas.fire('pointerdown', {
    pointerId: 2,
    pointerType: 'touch',
    clientX: 140,
    clientY: 100,
  });
  canvas.fire('pointermove', {
    pointerId: 2,
    pointerType: 'touch',
    clientX: 180,
    clientY: 100,
  });
  assert.ok(renderers[0].getView().fov < before, 'spread zooms in');
  canvas.fire('pointerup', { pointerId: 1 });
  canvas.fire('pointerup', { pointerId: 2 });
});

test('a lost WebGL context drops the panorama and shows the photo again on a new one', async () => {
  const { viewer, host, renderers, poses } = setup();
  await viewer.mount(host);
  await viewer.open('pano1');
  parts(host).canvas.fire('webglcontextlost');
  assert.equal(renderers[0].destroyed, true);
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(renderers.length, 2, 'a new renderer');
  assert.equal(poses.at(-1).imageId, 'pano1');
  assert.equal(parts(host).canvas.hidden, false);
});

test('a WebGL failure only lasts until the viewer is mounted again', async () => {
  let fail = true;
  const built = [];
  const viewer = createKartaViewViewer({
    getPhoto: async (id) => PHOTOS[id],
    step: async () => null,
    onStep() {},
    load: async (url) => ({ src: url }),
    createRenderer: (canvas) => {
      if (fail) throw new Error('WebGL is unavailable');
      const renderer = fakeRenderer(canvas);
      built.push(renderer);
      return renderer;
    },
  });
  const host = fakeHost();
  await viewer.mount(host);
  await viewer.open('pano1');
  assert.equal(parts(host).picture.hidden, false, 'front view');
  viewer.unmount();
  fail = false;
  const again = fakeHost();
  await viewer.mount(again);
  await viewer.open('pano1');
  assert.equal(built.length, 1);
  assert.equal(parts(again).canvas.hidden, false);
});
