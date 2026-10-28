/* SPECTRE boot loader and brand glitch, ported from the rebrand pack's
 * reference implementation (vanilla ES module, no dependencies beyond the
 * i18n marker).
 *
 *   startBoot({ assetUrl, systems, minMs, maxMs, mode, translate })
 *     -> { mark, finish, skip, whenDone, element }
 *   attachBrandGlitch(hostEl, { idle, hover, paused }) -> detach()
 *   glitch(partEl, ms) -> one glitch burst on a .sp-part
 *
 * Design rules baked in:
 *  - Progress and status rows come from REAL readiness signals via mark();
 *    nothing is time-faked.
 *  - Boot never blocks the app: maxMs force-resolves any system that did not
 *    report.
 *  - prefers-reduced-motion => static logo, no glitch, shorter hold.
 *  - Brand glitch is decorative only, on logo layers. Alerts must NOT reuse it
 *    (they keep their own icon + label + pulse).
 */
import { msg } from '../i18n/marker.js';

const LOCKUP = {
  aspect: 1.65212,
  parts: {
    mark: {
      file: 'spectre-mark.png',
      left: 10.1247,
      top: 0,
      width: 78.1365,
      height: 65.697,
    },
    wordmark: {
      file: 'spectre-wordmark.png',
      left: 0,
      top: 68,
      width: 100,
      height: 17.697,
    },
    subtitle: {
      file: 'spectre-subtitle.png',
      left: 0.5869,
      top: 87.1515,
      width: 99.4131,
      height: 6.5455,
    },
    tagline: {
      file: 'spectre-tagline.png',
      left: 7.3368,
      top: 95.3939,
      width: 85.62,
      height: 4.6061,
    },
  },
};
const PART_ORDER = ['mark', 'wordmark', 'subtitle', 'tagline'];
const STATE_LABEL = {
  pending: '···',
  ok: msg('ONLINE'),
  degraded: msg('DEGRADED'),
  offline: msg('OFFLINE'),
  timeout: msg('NO RESPONSE'),
};
const STATE_ICON = {
  pending: '○',
  ok: '●',
  degraded: '◐',
  offline: '✕',
  timeout: '✕',
};
export const DEFAULT_SYSTEMS = Object.freeze([
  { id: 'globe', label: msg('GLOBE ENGINE') },
  { id: 'layers', label: msg('DATA LAYERS') },
  { id: 'intel', label: msg('INTEL SERVICE') },
  { id: 'core', label: msg('NEURAL CORE') },
]);
const VARIANTS = ['a', 'b', 'c'];
const SEEN_KEY = 'spectre.boot.seen';

let reducedOverride = null; // tests / demo only
export function setReducedMotionOverride(value) {
  reducedOverride = value;
}
const prefersReduced = () => {
  if (reducedOverride !== null) return reducedOverride;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};
/** English fallback for `translate`: fill `{name}` placeholders. */
const interpolate = (text, values) =>
  text.replace(/\{(\w+)\}/g, (match, key) => values?.[key] ?? match);
const rand = (a, b) => a + Math.random() * (b - a);
const safe = (fn) => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};

/* ---------- glitch primitives ---------- */

function ensureGhosts(part) {
  const img = part.querySelector(':scope > img');
  if (!img) return;
  if (!part.querySelector('.sp-ghost')) {
    for (const k of ['r', 'w']) {
      const ghost = document.createElement('span');
      ghost.className = `sp-ghost sp-ghost--${k}`;
      ghost.setAttribute('aria-hidden', 'true');
      part.appendChild(ghost);
    }
  }
  const setMask = () => {
    part.style.setProperty('--sp-mask', `url("${img.currentSrc || img.src}")`);
    part.classList.add('has-mask');
  };
  if (img.complete && img.naturalWidth) setMask();
  else img.addEventListener('load', setMask, { once: true });
}

export function glitch(part, ms = 380) {
  if (!part || prefersReduced() || document.hidden) return;
  clearTimeout(part._spT);
  part.dataset.spVariant = VARIANTS[(Math.random() * VARIANTS.length) | 0];
  part.style.setProperty('--sp-dur', `${ms}ms`);
  part.classList.remove('is-glitch');
  void part.offsetWidth; // restart the animation
  part.classList.add('is-glitch');
  part._spT = setTimeout(() => part.classList.remove('is-glitch'), ms + 40);
}

/**
 * Glitch a logo element on hover and every `minMs`–`maxMs` while idle.
 * `paused()` (SPECTRE) is asked before each burst, so recording and clean
 * view stay still; a hidden tab never glitches (see glitch()).
 */
export function attachBrandGlitch(
  host,
  {
    idle = true,
    hover = true,
    minMs = 9000,
    maxMs = 18000,
    paused = () => false,
  } = {},
) {
  if (!host) return () => {};
  if (!host.classList.contains('sp-part'))
    host.classList.add('sp-part', 'sp-part--inline');
  ensureGhosts(host);
  let timer = 0;
  let last = 0;
  const schedule = () => {
    timer = setTimeout(kick, rand(minMs, maxMs));
  };
  const kick = () => {
    if (!paused()) glitch(host, rand(200, 320));
    schedule();
  };
  const onEnter = () => {
    const now = performance.now();
    if (now - last > 1200 && !paused()) {
      last = now;
      glitch(host, 260);
    }
  };
  if (idle) schedule();
  if (hover) host.addEventListener('pointerenter', onEnter);
  return () => {
    clearTimeout(timer);
    host.removeEventListener('pointerenter', onEnter);
  };
}

/* ---------- boot ---------- */

function buildLockup(assetUrl) {
  const root = document.createElement('div');
  root.className = 'sp-lockup';
  root.style.setProperty('--ar', LOCKUP.aspect);
  for (const name of PART_ORDER) {
    const p = LOCKUP.parts[name];
    const part = document.createElement('div');
    part.className = 'sp-part';
    part.dataset.part = name;
    Object.assign(part.style, {
      left: `${p.left}%`,
      top: `${p.top}%`,
      width: `${p.width}%`,
      height: `${p.height}%`,
    });
    const img = new Image();
    img.src = assetUrl(p.file);
    img.decoding = 'async';
    img.draggable = false;
    if (name === 'wordmark') img.alt = 'SPECTRE';
    else {
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
    }
    part.appendChild(img);
    ensureGhosts(part);
    root.appendChild(part);
  }
  return root;
}

/** The boot mode `startBoot` will use: `?boot=` wins, then `mode`. */
export function resolveBootMode(mode = 'auto', { respectUrl = true } = {}) {
  const urlMode = respectUrl
    ? safe(() => new URLSearchParams(location.search).get('boot'))
    : null;
  let m = ['off', 'full', 'short'].includes(urlMode) ? urlMode : mode;
  const seen = safe(() => sessionStorage.getItem(SEEN_KEY)) === '1';
  if (m === 'auto') m = seen ? 'short' : 'full';
  return m;
}

export function startBoot({
  root = document.body,
  assetUrl = (f) => `/brand/${f}`,
  systems = DEFAULT_SYSTEMS,
  minMs = 1600,
  maxMs = 9000,
  mode = 'auto', // 'auto' | 'full' | 'short' | 'off'
  respectUrl = true, // ?boot=off|full|short overrides mode
  translate = interpolate, // SPECTRE: t() from src/i18n
} = {}) {
  const m = resolveBootMode(mode, { respectUrl });
  if (m === 'off') {
    return {
      mark() {},
      finish() {},
      skip() {},
      element: null,
      whenDone: Promise.resolve({ skipped: true, ms: 0 }),
    };
  }

  const reduced = prefersReduced();
  if (m === 'short') minMs = Math.min(minMs, 600);
  if (reduced) minMs = Math.min(minMs, 900);

  const t0 = performance.now();
  const state = new Map(systems.map((s) => [s.id, 'pending']));
  const timers = new Set();
  const later = (fn, ms) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
    return id;
  };
  let finished = false;
  let skipped = false;
  let exitScheduled = false;
  let resolveDone;
  const whenDone = new Promise((r) => {
    resolveDone = r;
  });

  const el = document.createElement('div');
  el.className = 'sp-boot';
  el.dataset.mode = m;
  el.dataset.reduced = reduced ? '1' : '0';
  el.setAttribute('aria-busy', 'true');
  el.innerHTML =
    '<div class="sp-boot__scan" aria-hidden="true"></div>' +
    '<div class="sp-boot__stage"></div>' +
    '<p class="sp-boot__hint"></p>';
  el.querySelector('.sp-boot__hint').textContent = translate(
    msg('PRESS ANY KEY OR CLICK TO SKIP'),
  );
  const stage = el.querySelector('.sp-boot__stage');
  const lockup = buildLockup(assetUrl);
  const list = document.createElement('ul');
  list.className = 'sp-boot__sys';
  list.setAttribute('aria-live', 'polite');
  list.setAttribute(
    'aria-label',
    translate(msg('{name} startup status'), { name: 'SPECTRE' }),
  );
  for (const s of systems) {
    const li = document.createElement('li');
    li.dataset.id = s.id;
    li.dataset.state = 'pending';
    li.innerHTML =
      '<span class="sp-i" aria-hidden="true">○</span><span class="sp-k"></span><span class="sp-d"></span><span class="sp-v">···</span>';
    // textContent: details may contain arbitrary strings
    li.querySelector('.sp-k').textContent = translate(s.label);
    list.appendChild(li);
  }
  const bar = document.createElement('div');
  bar.className = 'sp-boot__bar';
  bar.setAttribute('aria-hidden', 'true');
  bar.innerHTML = '<i></i>';
  stage.append(lockup, list, bar);
  root.appendChild(el);

  const parts = [...lockup.querySelectorAll('.sp-part')];
  const rowFor = (id) => [...list.children].find((li) => li.dataset.id === id);

  function exit({ fast = false } = {}) {
    if (finished) return;
    finished = true;
    for (const id of timers) clearTimeout(id);
    timers.clear();
    window.removeEventListener('keydown', onKey, true);
    el.removeEventListener('pointerdown', onPointer);
    el.setAttribute('aria-busy', 'false');
    const remove = () => {
      el.remove();
      safe(() => sessionStorage.setItem(SEEN_KEY, '1'));
      resolveDone({ skipped, ms: Math.round(performance.now() - t0) });
    };
    if (fast || reduced) {
      el.classList.add('is-out');
      setTimeout(remove, reduced ? 260 : 190);
      return;
    }
    parts.forEach((p) => glitch(p, 360)); // exit burst
    setTimeout(() => el.classList.add('is-out'), 300);
    setTimeout(remove, 520);
  }

  function scheduleExit() {
    if (finished || exitScheduled) return;
    exitScheduled = true;
    later(exit, Math.max(0, minMs - (performance.now() - t0)));
  }

  function mark(id, st, detail = '') {
    if (finished || !state.has(id)) return;
    if (!STATE_LABEL[st] || st === 'pending') st = 'degraded';
    state.set(id, st);
    const li = rowFor(id);
    li.dataset.state = st;
    li.querySelector('.sp-i').textContent = STATE_ICON[st];
    li.querySelector('.sp-v').textContent = translate(STATE_LABEL[st]);
    li.querySelector('.sp-d').textContent = detail;
    li.classList.remove('is-flash');
    void li.offsetWidth;
    li.classList.add('is-flash');
    const resolved = [...state.values()].filter((v) => v !== 'pending').length;
    bar.firstElementChild.style.transform = `scaleX(${resolved / state.size})`;
    if (resolved === state.size) scheduleExit();
  }

  const skip = () => {
    skipped = true;
    exit({ fast: true });
  };
  function onKey(e) {
    if (
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      ['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key)
    )
      return;
    e.preventDefault();
    e.stopPropagation(); // the skip key must not also fire an app shortcut behind the overlay
    skip();
  }
  function onPointer() {
    skip();
  }
  window.addEventListener('keydown', onKey, true);
  el.addEventListener('pointerdown', onPointer);

  // choreography
  if (m === 'full' && !reduced) {
    [0, 360, 620, 780].forEach((at, i) =>
      later(() => {
        parts[i].classList.add('is-in');
        glitch(parts[i], 420);
      }, 120 + at),
    );
    later(() => list.classList.add('is-on'), 1000);
    const idle = () => {
      glitch(parts[(Math.random() * 2) | 0], rand(180, 320));
      later(idle, rand(1600, 3200));
    };
    later(idle, 1900);
  } else {
    parts.forEach((p) => p.classList.add('is-on'));
    list.classList.add('is-on');
    if (!reduced) later(() => parts.forEach((p) => glitch(p, 260)), 60);
  }

  // never block the app: anything that has not reported by maxMs is marked as such
  later(() => {
    for (const [id, v] of state) if (v === 'pending') mark(id, 'timeout');
  }, maxMs);

  return { mark, finish: scheduleExit, skip, whenDone, element: el };
}
