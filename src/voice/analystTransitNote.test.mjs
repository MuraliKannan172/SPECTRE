// The analyst card shows a layer's "empty" note (Transit's English
// getStats().coverage text) in the UI language.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../i18n/index.js';
import { attachVoiceResult } from './speech.js';
import {
  initialVoiceCardState,
  reduceVoiceCard,
  voiceCardView,
} from './voiceCardPresentation.js';

function viewFor(result) {
  const shaped = attachVoiceResult('analyst_query', result, {});
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
  );
}

// The caveat analystEngine.js:1026 builds from getEmptyNote (gevActions.js:4740)
// for Transit (transit/queries.js:249–251).
const notes = [
  'transit: Fly below 3,000 km to a covered region',
  'transit: No feed here yet · 12 regions available',
];

for (const locale of ['es', 'ru']) {
  test(`${locale}: Transit's empty note is translated on the analyst card`, () => {
    setLocale(locale);
    try {
      for (const caveat of notes) {
        const view = viewFor({
          ok: true,
          count: 0,
          complete: true,
          scopeLabel: 'in view',
          feedState: 'nominal',
          unanswered: [],
          coverage: {
            layersQueried: [
              { layerKey: 'transit', source: 'GTFS-RT', status: 'empty' },
            ],
          },
          display: { scope: 'in view', caveat },
          items: [],
        });
        const text = JSON.stringify(view.result);
        assert.doesNotMatch(
          text,
          /Fly below|No feed here yet|regions available/,
          text,
        );
      }
    } finally {
      setLocale('en');
    }
  });
}
