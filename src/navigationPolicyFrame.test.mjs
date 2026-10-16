// N-06: voice frame_overhead under Cockpit passed the noun 'frame', which had
// no entry in COCKPIT_REFUSALS, so the toast fell back to the template with
// the English id («Sal de la cabina para volar a frame»). The second test
// collects every noun the callers hand to the navigation policy, so the next
// noun without its own sentence fails here instead of reaching the page.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setLocale } from './i18n/index.js';
import {
  COCKPIT_REFUSAL_NOUNS,
  runExplicitNavigation,
} from './navigationPolicy.js';
import { WORLD_FOCUS_FRAMING } from './worldFocus.js';

const SRC = fileURLToPath(new URL('.', import.meta.url));

test.afterEach(() => setLocale('en'));

function cockpitToast(noun) {
  const log = [];
  runExplicitNavigation({
    cockpitActive: true,
    noun,
    showToast: (text) => log.push(text),
    stamp: () => 1,
    release: () => {},
    navigate: () => {},
  });
  assert.equal(log.length, 1);
  return log[0];
}

test('es: the Cockpit refusal for frame_overhead has no English id', () => {
  setLocale('es');
  const shown = cockpitToast('frame');
  assert.doesNotMatch(shown, /\bframe\b/, shown);
  assert.equal(shown, 'Sal de la cabina para encuadrar contactos');
});

test('en: the voice nouns read as English sentences', () => {
  setLocale('en');
  assert.equal(cockpitToast('frame'), 'Exit cockpit to frame contacts');
  assert.equal(cockpitToast('aircraft'), 'Exit cockpit to fly to an aircraft');
  assert.equal(cockpitToast('satellite'), 'Exit cockpit to fly to a satellite');
});

// ── Every noun a caller passes ─────────────────────────────────────────────

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.js$/.test(entry.name) && !/\.test\./.test(entry.name)
      ? [path]
      : [];
  });
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// Calls whose first argument is the destination noun.
const NOUN_FIRST =
  /\b(runImmediateNavigation|_runExplicitNavigation|runOrientation|_beginDeferredNavigation|cockpitRefusal|runNavigation|navigation\??\.(?:run|begin))\s*\(\s*([^,)]*)/g;
// runManagedVoiceNavigation(styleManager, noun, action, …) in gevActions.js.
const VOICE_NOUN = /\brunManagedVoiceNavigation\s*\(\s*[\w.?]+\s*,\s*([^,)]*)/g;
// Parameter defaults: `noun = 'location'`.
const NOUN_DEFAULT = /\bnoun\s*=\s*'([^']+)'/g;
// A local noun picked by a condition: `const noun = … ? 'cyclone' : 'weather'`.
const NOUN_CHOICE = /\bconst noun\s*=\s*[^?;]*\?\s*'([^']+)'\s*:\s*'([^']+)'/g;

function trackableKinds() {
  const source = readFileSync(join(SRC, 'voice/gevActions.js'), 'utf8');
  const block = source.match(/const TRACKABLE_FAMILIES = \[([\s\S]*?)\];/);
  assert.ok(block, 'TRACKABLE_FAMILIES is still in gevActions.js');
  return [...block[1].matchAll(/kind:\s*'([^']+)'/g)].map((m) => m[1]);
}

// Non-literal first arguments the test knows how to expand. Anything else is
// a new dynamic noun: list its values here.
const DYNAMIC_NOUNS = new Map([
  ['family.kind', trackableKinds],
  [
    "detail?.kind || 'target'",
    () => [...Object.keys(WORLD_FOCUS_FRAMING), 'target'],
  ],
]);
// Wrappers that pass their own `noun` parameter (or all arguments) on.
const PASS_THROUGH = new Set(['noun', '...args', '...arguments']);

function collectNouns() {
  const nouns = new Map();
  const unknown = [];
  const add = (noun, where) => {
    if (!nouns.has(noun)) nouns.set(noun, where);
  };
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    const name = relative(SRC, file);
    const take = (raw, where, { closures = false } = {}) => {
      const arg = raw.trim();
      const literal = arg.match(/^'([^']*)'$/);
      if (literal) return add(literal[1], where);
      // A wrapper's own parameter; its default is collected by NOUN_DEFAULT.
      if (PASS_THROUGH.has(arg) || /^noun\s*=\s*'[^']+'$/.test(arg)) return;
      if (DYNAMIC_NOUNS.has(arg)) {
        for (const noun of DYNAMIC_NOUNS.get(arg)()) add(noun, where);
        return;
      }
      // The layer-side `runNavigation(fly)` seams take only the flight; their
      // noun is bound where the seam is built.
      if (closures) return;
      unknown.push(`${where}: ${arg}`);
    };
    for (const m of text.matchAll(NOUN_FIRST))
      take(m[2], `${name}:${lineOf(text, m.index)}`, {
        closures: m[1] === 'runNavigation',
      });
    for (const m of text.matchAll(VOICE_NOUN))
      take(m[1], `${name}:${lineOf(text, m.index)}`);
    for (const m of text.matchAll(NOUN_DEFAULT))
      add(m[1], `${name}:${lineOf(text, m.index)}`);
    for (const m of text.matchAll(NOUN_CHOICE)) {
      add(m[1], `${name}:${lineOf(text, m.index)}`);
      add(m[2], `${name}:${lineOf(text, m.index)}`);
    }
  }
  return { nouns, unknown };
}

test('every noun the callers pass has its own Cockpit refusal', () => {
  const { nouns, unknown } = collectNouns();
  assert.deepEqual(unknown, [], 'a new dynamic noun: add it to DYNAMIC_NOUNS');
  // The scan still sees the known callers (a guard against a broken regex).
  for (const noun of ['location', 'camera', 'photo', 'shared view', 'file'])
    assert.ok(nouns.has(noun), `found ${noun}`);
  for (const noun of ['scene', 'route', 'weather', 'cyclone', 'vessel', 'fire'])
    assert.ok(nouns.has(noun), `found ${noun}`);
  for (const noun of ['frame', 'aircraft', 'satellite', 'target'])
    assert.ok(nouns.has(noun), `found ${noun}`);

  const missing = [...nouns]
    .filter(([noun]) => !COCKPIT_REFUSAL_NOUNS.includes(noun))
    .map(([noun, where]) => `${noun} (${where})`);
  assert.deepEqual(missing, [], 'add these nouns to COCKPIT_REFUSALS');

  setLocale('es');
  for (const noun of nouns.keys()) {
    const shown = cockpitToast(noun);
    assert.notEqual(
      shown,
      `Sal de la cabina para volar a ${noun}`,
      `${noun}: the template with the English id`,
    );
  }
});
