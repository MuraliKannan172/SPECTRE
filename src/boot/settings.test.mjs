import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOOT_ANIMATION_KEY,
  BRAND_GLITCH_KEY,
  bootModeFor,
  brandGlitchPaused,
  readBrandPrefs,
  writeBrandPref,
} from './settings.js';
import { resolveBootMode } from './spectre-boot.js';

function memoryStorage(entries = {}) {
  const data = new Map(Object.entries(entries));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    data,
  };
}
const throwing = {
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('QuotaExceededError');
  },
};

test('brand prefs: defaults, saved values, and junk ignored', () => {
  assert.deepEqual(readBrandPrefs(memoryStorage()), {
    animation: 'full',
    glitch: 'on',
  });
  assert.deepEqual(
    readBrandPrefs(
      memoryStorage({
        [BOOT_ANIMATION_KEY]: 'short',
        [BRAND_GLITCH_KEY]: 'off',
      }),
    ),
    { animation: 'short', glitch: 'off' },
  );
  assert.deepEqual(
    readBrandPrefs(memoryStorage({ [BOOT_ANIMATION_KEY]: 'loud' })),
    { animation: 'full', glitch: 'on' },
  );
});

test('brand prefs: missing or throwing storage falls back to defaults', () => {
  assert.deepEqual(readBrandPrefs(null), { animation: 'full', glitch: 'on' });
  assert.deepEqual(readBrandPrefs(throwing), {
    animation: 'full',
    glitch: 'on',
  });
  assert.equal(writeBrandPref(BOOT_ANIMATION_KEY, 'off', throwing), false);
  assert.equal(writeBrandPref(BOOT_ANIMATION_KEY, 'off', null), false);
  const storage = memoryStorage();
  assert.equal(writeBrandPref(BOOT_ANIMATION_KEY, 'off', storage), true);
  assert.equal(storage.data.get(BOOT_ANIMATION_KEY), 'off');
});

test('Full is the long boot once per session, then the short one', () => {
  assert.equal(bootModeFor('full'), 'auto');
  assert.equal(bootModeFor('short'), 'short');
  assert.equal(bootModeFor('off'), 'off');
});

test('boot mode: ?boot= overrides, auto follows the session', (t) => {
  const saved = {
    location: Object.getOwnPropertyDescriptor(globalThis, 'location'),
    sessionStorage: Object.getOwnPropertyDescriptor(
      globalThis,
      'sessionStorage',
    ),
  };
  t.after(() => {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const set = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true });

  set('location', { search: '' });
  set('sessionStorage', memoryStorage());
  assert.equal(resolveBootMode('auto'), 'full');
  set('sessionStorage', memoryStorage({ 'spectre.boot.seen': '1' }));
  assert.equal(resolveBootMode('auto'), 'short');
  assert.equal(resolveBootMode('off'), 'off');

  set('location', { search: '?boot=off' });
  assert.equal(resolveBootMode('full'), 'off');
  assert.equal(resolveBootMode('full', { respectUrl: false }), 'full');
  set('location', { search: '?boot=sideways' });
  assert.equal(resolveBootMode('short'), 'short');

  // Blocked session storage counts as a first visit.
  set('location', { search: '' });
  set('sessionStorage', throwing);
  assert.equal(resolveBootMode('auto'), 'full');
});

test('the header glitch pauses in recording and clean view', () => {
  const doc = (...classes) => ({
    body: { classList: { contains: (name) => classes.includes(name) } },
  });
  assert.equal(brandGlitchPaused(doc()), false);
  assert.equal(brandGlitchPaused(doc('recording-mode')), true);
  assert.equal(brandGlitchPaused(doc('ui-clean-view')), true);
  assert.equal(brandGlitchPaused({ body: null }), true);
});
