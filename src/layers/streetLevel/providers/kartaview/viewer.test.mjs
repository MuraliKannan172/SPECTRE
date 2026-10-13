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

function fakeRenderer() {
  const view = { yaw: 0, pitch: 0, fov: 80 };
  return {
    images: [],
    setImage(image) {
      this.images.push(image.src);
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

function setup({ failLoads = [], rendererThrows = false, steps = {} } = {}) {
  const loads = [];
  const renderers = [];
  const stepped = [];
  const viewer = createKartaViewViewer({
    getPhoto: async (id) => {
      if (!PHOTOS[id]) throw new Error('no such photo');
      return PHOTOS[id];
    },
    step: async (photo, delta) => steps[`${photo.id}:${delta}`] ?? null,
    onStepped: (id) => stepped.push(id),
    load: async (url, options) => {
      loads.push({ url, crossOrigin: options?.crossOrigin });
      if (failLoads.some((part) => url.includes(part)))
        throw new Error('The KartaView photo could not be loaded');
      return { src: url };
    },
    createRenderer: () => {
      if (rendererThrows) throw new Error('WebGL is unavailable');
      const renderer = fakeRenderer();
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
  const { viewer, poses, host, loads } = setup();
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
  assert.equal(pose.externalUrl, PHOTOS.flat1.urls.full);
  assert.equal(loads[0].url, PHOTOS.flat1.urls.view);
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

test('a missing 1280 px rendition falls back to the proxy-shrunk full photo', async () => {
  const { viewer, host, loads } = setup({ failLoads: ['/lth/'] });
  await viewer.mount(host);
  await viewer.open('flat1');
  assert.match(loads[1].url, /rs:fit:2560:2560/);
  assert.equal(parts(host).picture.hidden, false);
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

test('‹ › and the arrow keys step along the sequence; the end disables the button', async () => {
  const { viewer, poses, host, stepped } = setup({
    steps: { 'flat1:1': 'flat2' },
  });
  await viewer.mount(host);
  await viewer.open('flat1');
  const { root, prev, next } = parts(host);
  next.fire('click');
  await settle();
  await settle();
  assert.equal(poses.at(-1).imageId, 'flat2');
  assert.deepEqual(stepped, ['flat2']);
  root.fire('keydown', { key: 'ArrowRight' });
  await settle();
  await settle();
  assert.equal(next.disabled, true, 'flat2 is the last photo');
  root.fire('keydown', { key: 'ArrowLeft', metaKey: true });
  await settle();
  assert.equal(poses.at(-1).imageId, 'flat2', 'modified arrows are not ours');
  assert.equal(prev.disabled, false);
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
