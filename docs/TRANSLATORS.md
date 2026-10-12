# Translating God's Eye View

Shipped languages: **English** (source and fallback) and **Russian** (`ru`).

## How it works

The English text is the key. There is no English catalog: the code is the source.

```js
t('Save keys'); // plain text
t('Saved to {store}', { store }); // named placeholders
tn(count, '{count} camera', '{count} cameras'); // count-dependent text
msg('Live Flights'); // text kept in data, translated later by t()
```

```html
<span data-i18n>Normal</span>
<button title="Pin visual presets" data-i18n-title>…</button>
```

`data-i18n` translates the element's own text (put it on the element that holds the text, not on a parent with children). `data-i18n-title`, `data-i18n-aria-label` and `data-i18n-placeholder` translate that attribute's English value.

Every other language is one flat JSON file, `src/i18n/locales/<code>.json`, keyed by the English text:

```json
{
  "Save keys": "Сохранить ключи",
  "{count} cameras": {
    "one": "{count} камера",
    "few": "{count} камеры",
    "many": "{count} камер",
    "other": "{count} камеры"
  }
}
```

A `tn()` entry is keyed by the English plural form and holds one string per `Intl.PluralRules` category of that language. A missing entry falls back to English.

The page picks its language from `?lang=`, then the choice stored by the EN/RU switch in the Visual Presets dock, then the browser languages, then English. Switching reloads the page.

## The check

```sh
npm run i18n                      # what is missing, unused or broken, per language
npm run i18n -- --missing ru      # missing ru entries as JSON, ready to translate
npm run i18n -- --prune           # drop entries the code no longer uses
```

`npm test` runs the same check (`src/i18n/catalog.test.mjs`). It fails when a translation is missing, when an entry is no longer used, when placeholders differ from the English, or when a plural entry lacks a form.

Changing English text changes its key: the old translation becomes unused and the new text shows as missing. Translate it and prune.

## Fixing a translation

Edit `src/i18n/locales/<code>.json` and run `npm run i18n`. To see your change, open the app with `?lang=<code>`.

## Adding a language

1. Create `src/i18n/locales/<code>.json`, fill it from `npm run i18n -- --missing <code>` (start from `{}`), and translate every entry.
2. Import it in `src/i18n/index.js` and add it to `CATALOGS`.
3. Add the code to `LOCALES` and its own-language name to `LOCALE_NAMES` in `src/i18n/locale.js`. Right-to-left languages also go in `RTL_LOCALES`.
4. Add `src/i18n/locales/<code>.json` next to `ru.json` in `scripts/package-boundaries.json`.
5. Run `npm run i18n` and `npm test`, then check the panels in the app at narrow widths.

## Rules

- Keep every `{placeholder}` exactly as in the English; you may move it.
- UPPERCASE English stays UPPERCASE. Short labels, chips and HUD readouts should stay short; prefer an abbreviation over a wrapped line.
- Keep the separators `·`, `—`, `→`, `↗`, `…`.
- Leave product, provider and data names in their original form: Google Maps, Cesium ion, OpenAI, ChatGPT, NASA FIRMS, USGS, OpenSky, ADS-B, AIS, CCTV, HUD, TomTom, OpenStreetMap, Mapillary, and keyboard keys (Space, Esc, H, 1–9).
- Units follow the language's convention (Russian: км, м/с, уз, фт).

## Never translated

These are contracts, not copy: layer ids and registry keys, status enums and other machine values (translate only the label shown for them), share-link and hash parameters, `?lang=`, storage schemas, API fields, voice tool names and schemas, provider and dataset names, data from feeds (callsigns, vessel, satellite, station and place names, headlines), attribution, console diagnostics, and user-authored content.

## Russian glossary

| English                         | Русский                            |
| ------------------------------- | ---------------------------------- |
| layer / data layer              | слой / слой данных                 |
| feed                            | поток данных (short: поток)        |
| source                          | источник                           |
| LIVE (status) / live data       | ОНЛАЙН / в реальном времени        |
| SIMULATED                       | СИМУЛЯЦИЯ                          |
| stale / degraded / unavailable  | устарел / с перебоями / недоступен |
| key (API key) / POWER UP        | ключ / ЗАПУСК                      |
| aircraft / flight / vessel      | самолёт / рейс / судно             |
| launch (rocket) / space mission | пуск / космическая миссия          |
| contact / tracking              | контакт / отслеживание             |
| installation                    | объект                             |
| scene / shot / recipe           | сцена / кадр / рецепт              |
| HDG / BRG / CRS / FOV / DEST    | КУРС / ПЕЛ. / ПУТЬ / ОБЗОР / НАЗН. |
| PREV / NEXT                     | ПРЕД. / СЛЕД.                      |
