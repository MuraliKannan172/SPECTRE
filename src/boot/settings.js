/**
 * SPECTRE brand settings: Boot animation (Full / Short / Off) and Brand glitch
 * (On / Off), kept in localStorage. Storage can be missing or throw (private
 * windows, blocked site data); the defaults apply then.
 */
import { t } from '../i18n/index.js';
import { attachBrandGlitch } from './spectre-boot.js';

export const BOOT_ANIMATION_KEY = 'spectre.boot.animation';
export const BRAND_GLITCH_KEY = 'spectre.brand.glitch';
const ANIMATIONS = ['full', 'short', 'off'];
const GLITCH = ['on', 'off'];
const DEFAULTS = Object.freeze({ animation: 'full', glitch: 'on' });

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(store, key, allowed, fallback) {
  try {
    const value = store?.getItem(key);
    return allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

/** @returns {{animation: 'full'|'short'|'off', glitch: 'on'|'off'}} */
export function readBrandPrefs(store = storage()) {
  return {
    animation: read(store, BOOT_ANIMATION_KEY, ANIMATIONS, DEFAULTS.animation),
    glitch: read(store, BRAND_GLITCH_KEY, GLITCH, DEFAULTS.glitch),
  };
}

/** Save one preference; returns false when storage refused it. */
export function writeBrandPref(key, value, store = storage()) {
  try {
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The startBoot mode for a Boot animation choice. Full is the long boot on
 * the first visit of a session and the short one after it.
 */
export function bootModeFor(animation) {
  return animation === 'full' ? 'auto' : animation;
}

/** Recording and clean view hide the chrome; the header mark stays still. */
export function brandGlitchPaused(doc = document) {
  const body = doc.body;
  return (
    !body ||
    body.classList.contains('recording-mode') ||
    body.classList.contains('ui-clean-view')
  );
}

let detachHeaderGlitch = null;

/** Start or stop the header mark's brand glitch. */
export function setHeaderGlitch(enabled, doc = document) {
  detachHeaderGlitch?.();
  detachHeaderGlitch = null;
  if (!enabled) return;
  const mark = doc.querySelector('#title-bar .title-logo');
  detachHeaderGlitch = attachBrandGlitch(mark, {
    paused: () => brandGlitchPaused(doc),
  });
}

function selectRow(doc, { label, value, options, onChange }) {
  const row = doc.createElement('div');
  row.className = 'pp-slider-row visible';
  const caption = doc.createElement('span');
  caption.className = 'pp-slider-mini-label';
  caption.textContent = label;
  const select = doc.createElement('select');
  select.className = 'pp-select gev-field gev-field--compact';
  select.setAttribute('aria-label', label);
  for (const [optionValue, optionLabel] of options) {
    const option = doc.createElement('option');
    option.value = optionValue;
    option.textContent = optionLabel;
    select.append(option);
  }
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  row.append(caption, select);
  return row;
}

/**
 * Add the two brand settings to the Display panel. Returns a cleanup, or
 * null when the panel is not on the page.
 */
export function mountBrandSettings(doc = document) {
  const body = doc.querySelector('#pp-toggles .pp-panel-body');
  if (!body) return null;
  const prefs = readBrandPrefs();
  const group = doc.createElement('div');
  group.className = 'pp-toggle-group spectre-brand-settings';
  group.append(
    selectRow(doc, {
      label: t('Boot animation'),
      value: prefs.animation,
      options: [
        ['full', t('Full')],
        ['short', t('Short')],
        ['off', t('Off')],
      ],
      onChange: (value) => writeBrandPref(BOOT_ANIMATION_KEY, value),
    }),
    selectRow(doc, {
      label: t('Brand glitch'),
      value: prefs.glitch,
      options: [
        ['on', t('On')],
        ['off', t('Off')],
      ],
      onChange: (value) => {
        writeBrandPref(BRAND_GLITCH_KEY, value);
        setHeaderGlitch(value === 'on', doc);
      },
    }),
  );
  body.append(group);
  return () => group.remove();
}
