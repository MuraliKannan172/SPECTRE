import assert from 'node:assert/strict';
import test from 'node:test';
import { createKartaViewProvider, kartaViewZoomFor } from './index.js';
import { SEQUENCE_PAGE_SIZE } from './policy.js';
import { validateProviders } from '../../registry.js';
import { fakeHost } from '../../../../testSupport/kartaViewFakes.mjs';

/** A photo record `metres` east of (42.3314, -83.0458), in sequence `seq` at `index`. */
function photoRecord(id, { metres = 0, seq = '14010', index = 0 } = {}) {
  const lon = -83.0458 + metres / 82_300;
  return {
    id: String(id),
    sequenceId: seq,
    sequenceIndex: String(index),
    lat: '42.3314',
    lng: String(lon),
    heading: '90',
    projection: 'PLANE',
    fieldOfView: '0',
    shotDate: '2016-08-23 20:17:47.000',
    storage: 'storage2',
    filepathLTh: `2016/8/24/lth/${id}.jpg`,
    filepathProc: `2016/8/24/proc/${id}.jpg`,
  };
}

/**
 * A source over `sequences` (id → indexes present, in page order: KartaView
 * pages follow photo ids, which only roughly follow the index), recording
 * calls. Photos whose id is in `archived` answer 409.
 */
function fakeSource({ nearest = [], sequences = {}, archived = [] } = {}) {
  const calls = { nearest: 0, photo: [], pages: [], probes: [] };
  return {
    calls,
    probeImage: async (url) => {
      calls.probes.push(url);
      return !archived.some((id) => url.includes(`/${id}.jpg`));
    },
    getTile: async () => ({ lines: [] }),
    nearestPhotos: async () => {
      calls.nearest++;
      return nearest;
    },
    getPhoto: async (id) => {
      calls.photo.push(id);
      for (const [seq, indexes] of Object.entries(sequences))
        for (const index of indexes)
          if (`${seq}-${index}` === id) return photoRecord(id, { seq, index });
      throw new Error('KartaView has no such photo');
    },
    getSequencePhotos: async (seq, { page, itemsPerPage }) => {
      calls.pages.push(`${seq}:${page}`);
      const indexes = sequences[seq] || [];
      const rows = indexes.slice(
        (page - 1) * itemsPerPage,
        page * itemsPerPage,
      );
      return {
        photos: rows.map((index) =>
          photoRecord(`${seq}-${index}`, { seq, index }),
        ),
        hasMore: page * itemsPerPage < indexes.length,
      };
    },
  };
}

function fakeContext() {
  const actions = { opened: [], nearest: [], instance: null };
  return {
    actions,
    context: {
      services: {},
      getFilter: () => ({ pano: 'all', sinceMs: null }),
      isActive: () => true,
      groundCaster: null,
      meshSampler: null,
      getSurface: () => 'draped',
      notify() {},
      actions: {
        // As the core does: the provider's own viewer opens it.
        openImage: async (id, options) => {
          actions.opened.push({ id, options });
          await actions.instance?.viewer.open(id);
          return true;
        },
        openNearest: (point) => actions.nearest.push(point),
        reportError() {},
      },
    },
  };
}

function setup(sourceOptions) {
  const source = fakeSource(sourceOptions);
  const loads = [];
  const definition = createKartaViewProvider({
    source,
    viewerOptions: {
      load: async (url) => {
        loads.push(url);
        return { src: url };
      },
      createRenderer: () => {
        throw new Error('no WebGL in Node');
      },
    },
  });
  const { context, actions } = fakeContext();
  const instance = definition.create(context);
  actions.instance = instance;
  return { definition, instance, source, actions, loads };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('KartaView registers keyless, off by default, with no filters and its own wording', () => {
  const { definition } = setup();
  assert.equal(definition.id, 'kartaview');
  assert.equal(definition.requiresKeyId, null);
  assert.equal(definition.defaultOn, false);
  assert.deepEqual(definition.filters, []);
  assert.match(
    definition.credit.html,
    /KartaView<\/a> contributors, CC BY-SA 4\.0/,
  );
  assert.equal(definition.colors.coverage, '#635bff');
  assert.deepEqual(definition.coverageLabel, {
    noun: 'streets',
    action: 'click a line for its nearest photo',
  });
  // Its prefix fits beside the others.
  validateProviders([
    { ...definition, id: 'mapillary', pickPrefix: 'mly:' },
    { ...definition, id: 'google', pickPrefix: 'gsv:' },
    definition,
  ]);
});

test('coverage is drawn from z14 near the street and z13 a little higher; never from orbit', () => {
  assert.deepEqual(kartaViewZoomFor(300), { zoom: 14, kind: 'sequence' });
  assert.deepEqual(kartaViewZoomFor(2_500), { zoom: 14, kind: 'sequence' });
  assert.deepEqual(kartaViewZoomFor(4_000), { zoom: 13, kind: 'sequence' });
  assert.equal(kartaViewZoomFor(6_001), null);
  assert.equal(kartaViewZoomFor(NaN), null);
});

test('the nearest photo is the closest within 50 m, and opening it asks nothing more', async () => {
  const { instance, source, loads } = setup({
    nearest: [
      photoRecord('far', { metres: 80 }),
      photoRecord('mid', { metres: 30 }),
      photoRecord('near', { metres: 12 }),
    ],
  });
  const id = await instance.nearestImage({ lat: 42.3314, lon: -83.0458 });
  assert.equal(id, 'near');
  const host = fakeHost();
  await instance.viewer.mount(host);
  await instance.viewer.open(id);
  assert.deepEqual(source.calls.photo, [], 'the lookup filled the cache');
  assert.equal(
    loads[0],
    'https://storage2.openstreetcam.org/files/photo/2016/8/24/lth/near.jpg',
  );
  const none = setup({ nearest: [photoRecord('far', { metres: 80 })] });
  assert.equal(
    await none.instance.nearestImage({ lat: 42.3314, lon: -83.0458 }),
    null,
  );
});

test('a cone opens its photo; a line opens the photo nearest the click', () => {
  const { instance, actions } = setup();
  actions.instance = null;
  assert.equal(instance.handlePick('kv:img:123'), true);
  assert.deepEqual(actions.opened, [{ id: '123', options: undefined }]);
  const point = { lon: -83.0458, lat: 42.3314 };
  assert.equal(
    instance.handlePick('kv:line:14/1/2/3', { groundPoint: () => point }),
    true,
  );
  assert.deepEqual(actions.nearest, [point]);
  // Over the sky the line is still ours, but there is nowhere to look.
  assert.equal(
    instance.handlePick('kv:line:14/1/2/3', { groundPoint: () => null }),
    true,
  );
  assert.equal(actions.nearest.length, 1);
  assert.equal(instance.handlePick('mly:seq:1'), false);
});

test('coverage stats report KartaView as configured and key-free', async () => {
  const { instance } = setup();
  assert.deepEqual(await instance.status(), { configured: true });
  const stats = instance.coverageStats();
  assert.equal(stats.keyRequired, false);
  assert.equal(stats.keyRejected, false);
  assert.equal(stats.count, 0);
});

const press = async (button) => {
  button.fire('click');
  for (let i = 0; i < 12; i++) await settle();
};

async function mounted(sourceOptions) {
  const env = setup(sourceOptions);
  const host = fakeHost();
  await env.instance.viewer.mount(host);
  const poses = [];
  env.instance.viewer.onPose((pose) => poses.push(pose.imageId));
  const [, , prev, next] = host.children[0].children;
  return { ...env, poses, prev, next };
}

test('› walks across sequence pages without moving the camera; ‹ walks back; the ends stop', async () => {
  const size = SEQUENCE_PAGE_SIZE;
  const indexes = Array.from({ length: size + 5 }, (_, i) => i);
  const { instance, actions, source, poses, prev, next } = await mounted({
    sequences: { s: indexes },
  });
  await instance.viewer.open(`s-${size - 1}`);
  await press(next);
  assert.equal(poses.at(-1), `s-${size}`, 'onto the second page');
  assert.deepEqual(actions.opened.at(-1), {
    id: `s-${size}`,
    options: { frame: false },
  });
  assert.ok(source.calls.pages.includes('s:2'));
  await press(prev);
  assert.equal(poses.at(-1), `s-${size - 1}`);
  await instance.viewer.open('s-0');
  for (let i = 0; i < 6; i++) await settle();
  assert.equal(prev.disabled, true, 'nothing before the first photo');
  await press(prev);
  assert.equal(poses.at(-1), 's-0');
});

test('pages that overlap in index (id order) step one photo at a time across the edge', async () => {
  const size = SEQUENCE_PAGE_SIZE;
  // As KartaView pages by id: page 1 holds 0…size+2 less two, page 2 starts
  // with those two (size-2, size) before the rest.
  const first = Array.from({ length: size + 3 }, (_, i) => i).filter(
    (i) => i !== size - 2 && i !== size,
  );
  const second = [
    size - 2,
    size,
    ...Array.from({ length: 50 }, (_, i) => size + 3 + i),
  ];
  const { instance, poses, next } = await mounted({
    sequences: { s: [...first, ...second] },
  });
  await instance.viewer.open(`s-${size - 5}`);
  for (let k = 1; k <= 8; k++) await press(next);
  assert.deepEqual(
    poses.slice(-9).map((id) => Number(id.slice(2))),
    Array.from({ length: 9 }, (_, i) => size - 5 + i),
    'no photo skipped at the page edge',
  );
});

test('a photo whose index outruns the page count is found, and its neighbours are real', async () => {
  // 1,000 photos with 500–1499 deleted: index 1500 is on page 2, not 4.
  const indexes = [
    ...Array.from({ length: 500 }, (_, i) => i),
    ...Array.from({ length: 500 }, (_, i) => 1500 + i),
  ];
  const { instance, poses, prev, next } = await mounted({
    sequences: { s: indexes },
  });
  await instance.viewer.open('s-1500');
  await press(next);
  assert.equal(poses.at(-1), 's-1501');
  await press(prev);
  await press(prev);
  assert.equal(poses.at(-1), 's-499', 'back across the gap');
  await instance.viewer.open('s-1999');
  for (let i = 0; i < 8; i++) await settle();
  assert.equal(next.disabled, true, 'the last photo');
});

test('archived photos are skipped: by the nearest lookup, and by › and ‹', async () => {
  const { instance, poses, next } = await mounted({
    nearest: [
      photoRecord('gone', { metres: 3 }),
      photoRecord('kept', { metres: 9 }),
    ],
    archived: ['gone', 's-2', 's-3'],
    sequences: { s: [0, 1, 2, 3, 4] },
  });
  assert.equal(
    await instance.nearestImage({ lat: 42.3314, lon: -83.0458 }),
    'kept',
  );
  await instance.viewer.open('s-1');
  await press(next);
  assert.equal(poses.at(-1), 's-4', 'two archived photos stepped over');
  const allGone = setup({
    nearest: [photoRecord('gone', { metres: 3 })],
    archived: ['gone'],
  });
  await assert.rejects(
    allGone.instance.nearestImage({ lat: 42.3314, lon: -83.0458 }),
    /archived and cannot be shown/,
  );
  const noFiles = setup({
    nearest: [
      {
        ...photoRecord('bare', { metres: 2 }),
        filepathLTh: '',
        filepathProc: '',
      },
    ],
  });
  assert.equal(
    await noFiles.instance.nearestImage({ lat: 42.3314, lon: -83.0458 }),
    null,
    'a record with no file is not a photo',
  );
});
