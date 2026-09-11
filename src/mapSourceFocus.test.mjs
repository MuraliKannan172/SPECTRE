import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Exercise the installed event routes and central close method, without WebGL.
const source = readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
const initStart = source.indexOf('  _initAutoHoverPanel(');
const initEnd = source.indexOf('  /**\n   * Sets up drag-to-reposition', initStart);
const closeStart = source.indexOf('  setPanelCollapsed(panelId, collapsed, {');
const closeEnd = source.indexOf('  /**\n   * Toggles "clean view"', closeStart);
const syncStart = source.indexOf('  _syncPanelCollapseButton(panelEl) {');
const syncEnd = source.indexOf('  /**\n   * Converts a panel', syncStart);
assert.ok(initStart >= 0 && initEnd > initStart
  && closeStart >= 0 && closeEnd > closeStart);
assert.ok(syncStart >= 0 && syncEnd > syncStart);

function harness({ hidden = false, selected = true, noChips = false } = {}) {
  let now = 0;
  let nextTimer = 0;
  let focusCalls = 0;
  const timers = new Map();
  const document = { activeElement: null };
  const makeNode = (id, attributes = {}) => {
    const listeners = new Map();
    const classes = new Set();
    return {
      id, listeners, classes, hovered: false,
      setAttribute(name, value) { attributes[name] = String(value); },
      getAttribute(name) { return attributes[name] ?? null; },
      classList: {
        contains: (name) => classes.has(name),
        remove: (name) => classes.delete(name),
        toggle(name, value) { if (value) classes.add(name); else classes.delete(name); },
      },
      addEventListener(type, callback) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(callback);
      },
      matches(selector) { return selector === ':hover' ? this.hovered : true; },
      closest() { return this.isDisclosure ? this : null; },
    };
  };
  const panel = makeNode('control-panel');
  const location = makeNode('location-bar');
  panel.classes.add('collapsed');
  location.classes.add('collapsed');
  const disclosure = makeNode('control-panel-toggle');
  disclosure.isDisclosure = true;
  const first = makeNode('photoreal');
  const active = makeNode('osm');
  const elsewhere = makeNode('elsewhere');
  const nodes = [panel, location, disclosure, first, active, elsewhere].filter(Boolean);
  document.getElementById = (id) => nodes.find((node) => node.id === id);
  panel.contains = (node) => [panel, disclosure, first, active].includes(node);
  location.contains = (node) => Boolean(node) && [location].includes(node);
  panel.querySelector = (selector) => {
    if (selector.startsWith('[data-dock-toggle-target')) return disclosure;
    if (selector.split(',').some((part) => part.trim() === '.panel-title')) return { textContent: 'VISUAL STYLES' };
    if (noChips) return null;
    if (selector === '.map-stack-chip.active') return selected ? active : null;
    return selector === '.map-stack-chip' ? first : null;
  };
  location.querySelector = (selector) => {
    if (selector.split(',').some((part) => part.trim() === '.location-toolbar-label')) return { textContent: 'LOCATION' };
    return null;
  };
  panel.querySelectorAll = location.querySelectorAll = () => [];
  const emit = (node, type, values = {}) => {
    assert.ok(node, 'the event target exists in the actual panel markup');
    const event = {
      target: node, defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...values,
    };
    for (const callback of node.listeners.get(type) || []) callback(event);
    return event;
  };
  const focus = (node) => {
    const prior = document.activeElement;
    if (prior === node) return;
    document.activeElement = node;
    for (const owner of [panel, location]) {
      if (owner.contains(prior)) emit(owner, 'focusout', { target: prior, relatedTarget: node });
      if (owner.contains(node)) emit(owner, 'focusin', { target: node, relatedTarget: prior });
    }
  };
  disclosure.focus = () => focus(disclosure);
  for (const chip of [first, active]) {
    chip.focus = () => { focusCalls += 1; if (!hidden) focus(chip); };
  }
  const window = {
    setTimeout(callback, delay) { timers.set(++nextTimer, { callback, at: now + delay }); return nextTimer; },
  };
  const methods = new Function('document', 'window', 'clearTimeout', 'performance', 'requestAnimationFrame',
    `return ({${source.slice(initStart, initEnd)},\n${source.slice(closeStart, closeEnd)},\n${source.slice(syncStart, syncEnd)}});`)(
    document, window, (id) => timers.delete(id), { now: () => now }, () => {},
  );
  const saves = [];
  const claims = [];
  let shareSyncs = 0;
  const manager = {
    ...methods,
    _savePanelCollapsedState(...args) { saves.push(args); },
    _scheduleLeftPanelLayout() {}, _scheduleRightPanelLayout() {},
    shareLinkManager: {
      claimRestoreLane(...args) { claims.push(args); },
      onPanelStateChange() { shareSyncs += 1; },
    },
  };
  manager._initAutoHoverPanel('control-panel');
  manager._initAutoHoverPanel('location-bar');
  disclosure.focus();
  const tick = () => {
    const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) return;
    timers.delete(next[0]); now = next[1].at; next[1].callback();
  };
  return {
    manager, panel, location, disclosure,
    first, active, elsewhere, document, timers, emit, focus, tick, saves, claims,
    calls: () => focusCalls,
    shareSyncs: () => shareSyncs,
    show() { hidden = false; },
    select(value) { selected = value; },
    key(key = 'Enter', repeat = false) { return emit(disclosure, 'keydown', { key, repeat }); },
    escape() { emit(panel, 'keydown', { key: 'Escape' }); },
    click(detail = 1) { emit(disclosure, 'click', { detail }); },
    drain() { for (let i = 0; i < 40 && timers.size; i += 1) tick(); },
  };
}

test('Enter focuses selected OSM rather than the first chip', () => {
  const h = harness(); h.key(); h.tick();
  assert.equal(h.document.activeElement, h.active);
  assert.equal(h.panel.classList.contains('collapsed'), false);
  assert.equal(h.timers.size, 0);
});
test('repeated keydown does not close an opening tray or replace its timer', () => {
  const h = harness(); h.key(); const timer = [...h.timers.keys()][0]; h.key('Enter', true);
  assert.equal([...h.timers.keys()][0], timer);
  assert.equal(h.panel.classList.contains('collapsed'), false);
});
test('missing selection falls back to the first chip', () => {
  const h = harness({ selected: false }); h.key(); h.tick();
  assert.equal(h.document.activeElement, h.first);
});
test('delayed visibility retries until focus lands', () => {
  const h = harness({ hidden: true }); h.key(); h.tick(); h.tick();
  assert.equal(h.document.activeElement, h.disclosure);
  assert.equal(h.timers.size, 1); h.show(); h.tick();
  assert.equal(h.document.activeElement, h.active);
  assert.equal(h.calls(), 3); assert.equal(h.timers.size, 0);
});
test('selection is read again when a delayed attempt can focus', () => {
  const h = harness({ hidden: true, selected: false }); h.key(); h.tick();
  h.select(true); h.show(); h.tick();
  assert.equal(h.document.activeElement, h.active);
});
test('permanently hidden and missing targets have bounded work', () => {
  for (const options of [{ hidden: true }, { noChips: true }]) {
    const h = harness(options); h.key(); h.drain();
    assert.equal(h.timers.size, 0);
    assert.equal(h.calls(), options.noChips ? 0 : 25);
    assert.equal(h.document.activeElement, h.disclosure);
  }
});
test('focus departure cancels immediately even if focus returns before the timer', () => {
  const h = harness(); h.key(); h.focus(h.elsewhere); h.focus(h.disclosure);
  assert.equal(h.timers.size, 0); h.drain();
  assert.equal(h.document.activeElement, h.disclosure); assert.equal(h.calls(), 0);
});
test('deliberate focus movement inside the tray cancels pending retries', () => {
  const h = harness({ hidden: true }); h.key(); h.tick(); h.focus(h.first);
  assert.equal(h.timers.size, 0); h.show(); h.drain();
  assert.equal(h.document.activeElement, h.first); assert.equal(h.calls(), 1);
});
test('Escape cancels immediately, closes the tray and restores disclosure focus', () => {
  const h = harness({ hidden: true }); h.key(); h.tick(); h.escape();
  assert.equal(h.timers.size, 0); assert.equal(h.document.activeElement, h.disclosure);
  assert.equal(h.panel.classList.contains('collapsed'), true); h.show(); h.drain();
  assert.equal(h.calls(), 1);
});
test('the central close seam cancels before both transition and already-closed return', () => {
  for (const alreadyClosed of [false, true]) {
    const h = harness(); h.key();
    if (alreadyClosed) h.panel.classes.add('collapsed');
    h.manager.setPanelCollapsed('control-panel', true, { persist: false, syncShare: false });
    assert.equal(h.timers.size, 0); h.drain(); assert.equal(h.calls(), 0);
  }
});
test('opening the unpinned Location sibling cancels the Map Source request', () => {
  const h = harness(); h.key(); h.manager.setPanelCollapsed('location-bar', false);
  assert.equal(h.panel.classList.contains('collapsed'), true);
  assert.equal(h.timers.size, 0); h.drain(); assert.equal(h.calls(), 0);
});
test('a pinned Map Source tray retains its own request when the sibling opens', () => {
  const h = harness(); h.panel.classes.add('dock-pinned'); h.key();
  h.manager.setPanelCollapsed('location-bar', false); h.tick();
  assert.equal(h.panel.classList.contains('collapsed'), false);
  assert.equal(h.document.activeElement, h.active);
});
test('pointer activation revokes a pending keyboard request without moving focus', () => {
  const h = harness(); h.key(); h.emit(h.panel, 'pointerdown');
  assert.equal(h.timers.size, 0); h.drain();
  assert.equal(h.document.activeElement, h.disclosure); assert.equal(h.calls(), 0);
});
test('close then pointer or programmatic reopen cannot inherit a keyboard request', () => {
  for (const reopen of [(h) => h.click(1), (h) => h.manager.setPanelCollapsed('control-panel', false)]) {
    const h = harness(); h.key(); const stale = [...h.timers.values()][0].callback;
    h.escape(); reopen(h); stale(); h.drain();
    assert.equal(h.panel.classList.contains('collapsed'), false);
    assert.equal(h.document.activeElement, h.disclosure); assert.equal(h.calls(), 0);
  }
});
test('a stale callback cannot focus or clear the timer owned by a new keyboard opening', () => {
  const h = harness(); h.key(); const stale = [...h.timers.values()][0].callback;
  h.escape(); h.key(); const timer = [...h.timers.keys()][0]; stale();
  assert.equal(h.calls(), 0); assert.equal([...h.timers.keys()][0], timer);
  h.tick(); assert.equal(h.document.activeElement, h.active);
});
test('plain pointer opening does not request focus', () => {
  const h = harness(); h.click(1); h.drain();
  assert.equal(h.document.activeElement, h.disclosure); assert.equal(h.calls(), 0);
});
test('pointer leave preserves established keyboard focus and the open tray', () => {
  const h = harness(); h.key(); h.tick(); h.emit(h.panel, 'pointerleave', { pointerType: 'mouse' }); h.drain();
  assert.equal(h.document.activeElement, h.active);
  assert.equal(h.panel.classList.contains('collapsed'), false);
});


