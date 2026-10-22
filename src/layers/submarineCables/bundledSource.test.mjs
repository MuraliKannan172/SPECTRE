import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPTIONAL_DATA_MISSING,
  createBundledCableSource,
} from './bundledSource.js';

test('a failed bundled response releases its body', async () => {
  let released = 0;
  const source = createBundledCableSource({
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      body: {
        cancel: async () => {
          released++;
        },
      },
    }),
  });
  await assert.rejects(source.fetch(), /HTTP 503/);
  assert.equal(released, 2);
});

test('an absent optional dataset reports itself as not installed', async () => {
  const notFound = createBundledCableSource({
    fetchImpl: async () => ({ ok: false, status: 404, body: null }),
  });
  await assert.rejects(notFound.fetch(), { code: OPTIONAL_DATA_MISSING });

  // The dev server answers an unknown path with its HTML app shell.
  const htmlFallback = createBundledCableSource({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      body: null,
    }),
  });
  await assert.rejects(htmlFallback.fetch(), { code: OPTIONAL_DATA_MISSING });
});

test('cancellation during JSON parsing cannot return a late snapshot', async () => {
  const controller = new AbortController();
  const source = createBundledCableSource({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        controller.abort();
        return { type: 'FeatureCollection', features: [] };
      },
    }),
  });
  await assert.rejects(source.fetch(controller.signal), { name: 'AbortError' });
});
