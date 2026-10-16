// The analyst card's empty notes can be a layer's status line: Local ADS-B
// with every decoder feed stale, Transit with a quiet feed ("(95s old)"). The
// card shows them in the UI language; the model gets the English.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../i18n/index.js';
import { attachVoiceResult } from './speech.js';
import {
  initialVoiceCardState,
  reduceVoiceCard,
  voiceCardView,
} from './voiceCardPresentation.js';

function notesFor(layerKey, caveat) {
  const shaped = attachVoiceResult(
    'analyst_query',
    {
      ok: true,
      count: 0,
      complete: true,
      scopeLabel: 'in view',
      feedState: 'nominal',
      unanswered: [],
      coverage: { layersQueried: [{ layerKey, status: 'empty' }] },
      display: { scope: 'in view', caveat },
      items: [],
    },
    {},
  );
  return voiceCardView(
    [
      {
        type: 'action-call',
        callId: 'c1',
        name: 'analyst_query',
        arguments: {},
      },
      {
        type: 'action-result',
        callId: 'c1',
        name: 'analyst_query',
        result: shaped,
      },
    ].reduce(reduceVoiceCard, initialVoiceCardState()),
  ).result.notes;
}

// Caveat = `${layerKey}: ${getEmptyNote(layerKey)}` (analystEngine.js:1026,
// gevActions.js getEmptyNote → stats.coverage || stats.statusMessage).
const cases = [
  ['local-adsb', 'local-adsb: feeds 1090, 978 stale · 0 heard'],
  ['local-adsb', 'local-adsb: feed 1090 stale · 0 heard'],
  ['transit', 'transit: TTC 0 (95s old)'],
  ['transit', 'transit: TTC 0 · GO Transit 0 (95s old)'],
];

for (const locale of ['es', 'ru']) {
  for (const [layerKey, caveat] of cases) {
    test(`${locale}: analyst note "${caveat}" is translated`, () => {
      setLocale(locale);
      try {
        const notes = notesFor(layerKey, caveat);
        assert.ok(notes.length > 0, 'the note is shown');
        assert.doesNotMatch(notes.join(' | '), /\b(stale|heard|old)\b/);
      } finally {
        setLocale('en');
      }
    });
  }
}

for (const [layerKey, caveat] of cases) {
  test(`en: analyst note "${caveat}" keeps its status line`, () => {
    setLocale('en');
    const line = caveat.slice(caveat.indexOf(': ') + 2);
    assert.ok(
      notesFor(layerKey, caveat).some((note) => note.endsWith(`: ${line}`)),
    );
  });
}
