import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkCatalog,
  extractMessages,
  missingTemplate,
} from '../../scripts/i18n.mjs';

// A plural entry whose every form is still the English text must be reported
// the same way a string entry is ("is still English"). Today the plural
// branch of checkCatalog never compares forms with the English.
const fixture = new Map([
  ['{count} cameras', { plural: true, one: '{count} camera' }],
  ['Save keys', { plural: false }],
]);

test('string entry left in English is reported (control)', () => {
  const { errors } = checkCatalog(
    'de',
    {
      'Save keys': 'Save keys',
      '{count} cameras': { one: 'x {count}', other: 'y {count}' },
    },
    fixture,
    new Set(),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /is still English/);
});

for (const [locale, entry] of [
  ['de', { one: '{count} camera', other: '{count} cameras' }],
  ['ja', { other: '{count} cameras' }],
  ['zh-CN', { other: '{count} cameras' }],
  [
    'es',
    {
      one: '{count} camera',
      many: '{count} cámaras',
      other: '{count} cameras',
    },
  ],
  [
    'ru',
    {
      one: '{count} camera',
      few: '{count} камеры',
      many: '{count} камер',
      other: '{count} cameras',
    },
  ],
]) {
  test(`${locale}: plural entry with English forms is reported`, () => {
    const { errors } = checkCatalog(
      locale,
      { 'Save keys': 'Schlüssel', '{count} cameras': entry },
      fixture,
      new Set(),
    );
    assert.ok(
      errors.some((e) => /is still English/.test(e)),
      `expected an "is still English" error, got ${JSON.stringify(errors)}`,
    );
  });
}

// `npm run i18n -- --missing <code>` prints a template; pasted without edits,
// none of its entries may pass as a translation (K-21, K-52), and a plural
// entry carries every form the language needs (K-97).
const messages = extractMessages();
for (const locale of ['de', 'ja', 'es', 'ru']) {
  test(`${locale}: an untouched --missing template fails the check entry by entry`, () => {
    const template = missingTemplate(locale, {}, messages);
    assert.equal(Object.keys(template).length, messages.size);
    const categories = new Intl.PluralRules(locale).resolvedOptions()
      .pluralCategories;
    for (const [text, info] of messages)
      if (info.plural)
        assert.deepEqual(Object.keys(template[text]), categories, text);
    const { missing, errors } = checkCatalog(
      locale,
      template,
      messages,
      new Set(),
    );
    assert.deepEqual(missing, []);
    const accepted = [...messages.keys()].filter(
      (text) => !errors.some((error) => error.startsWith(`"${text}" `)),
    );
    assert.deepEqual(accepted, []);
  });
}
