/**
 * SKYNET: the News drawer (search, filters, every outlet's link) and the
 * headline ticker. Self-contained DOM owned by SKYNET — deliberately outside
 * GEV's rail panels, share-link panel state and voice panel list — mounted
 * once by the application. Text is only ever set with textContent; links are
 * real anchors to validated http(s) URLs, opened with noopener.
 */
import { t, tn } from '../../i18n/index.js';
import { newsFreshness } from './freshness.js';
import { INTEL_OFFLINE, NEWS_UNAVAILABLE } from './source.js';
import {
  gdeltCitation,
  newsDrawerItems,
  newsFilterOptions,
  newsSourceOptions,
  newsTickerEntries,
} from './view.js';

const QUERY_DELAY_MS = 300;
const LIVE_REQUERY_MS = 2_000;
const TICKER_STEP_MS = 8_000;

function element(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function fillSelect(select, options, value) {
  select.replaceChildren(
    ...options.map((option) => {
      const node = select.ownerDocument.createElement('option');
      node.value = option.value;
      node.textContent = option.label;
      return node;
    }),
  );
  select.value = value;
}

function outletLink(document, name, url) {
  const link = element(document, 'a', 'skynet-news-outlet', `${name} ↗`);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

/**
 * @param {{document: Document, layer: object, now?: () => number,
 *   reduceMotion?: () => boolean, setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout}} options
 * @returns {{open: () => void, close: () => void, destroy: () => void}}
 */
export function mountNewsPanel({
  document,
  layer,
  now = () => Date.now(),
  reduceMotion = () =>
    globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ??
    false,
  setTimer = (...args) => setTimeout(...args),
  clearTimer = (id) => clearTimeout(id),
}) {
  const body = document.body;

  // -- the toggle (the ticker bar's first control) ----------------------
  const toggle = element(document, 'button', 'skynet-news-toggle');
  toggle.id = 'skynet-news-toggle';
  toggle.type = 'button';
  toggle.title = t(
    'Search all stories, filter by region and source, and open every outlet',
  );
  toggle.setAttribute('aria-controls', 'skynet-news-drawer');
  toggle.setAttribute('aria-expanded', 'false');
  const toggleLabel = element(document, 'span', '', t('NEWS'));
  const toggleCount = element(document, 'span', 'skynet-news-toggle-count');
  toggle.append(toggleLabel, toggleCount);

  // -- the drawer --------------------------------------------------------
  const drawer = element(document, 'aside', 'skynet-news-drawer');
  drawer.id = 'skynet-news-drawer';
  drawer.hidden = true;
  drawer.setAttribute('aria-label', t('News'));
  const header = element(document, 'header', 'skynet-news-header');
  const title = element(document, 'h2', 'skynet-news-title', t('NEWS'));
  const badge = element(document, 'span', 'skynet-news-badge');
  const close = element(document, 'button', 'skynet-news-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', t('Close the News panel'));
  header.append(title, badge, close);

  const form = element(document, 'form', 'skynet-news-filters');
  form.setAttribute('role', 'search');
  const search = element(document, 'input', 'skynet-news-search');
  search.type = 'search';
  search.maxLength = 200;
  search.placeholder = t('Search headlines');
  search.setAttribute('aria-label', t('Search headlines'));
  const labelled = (label, control) => {
    const wrap = element(document, 'label', 'skynet-news-field');
    wrap.append(element(document, 'span', '', label), control);
    return wrap;
  };
  const windowSelect = element(document, 'select');
  const categorySelect = element(document, 'select');
  const regionSelect = element(document, 'select');
  const sourceSelect = element(document, 'select');
  const options = newsFilterOptions();
  fillSelect(windowSelect, options.windows, '24');
  fillSelect(categorySelect, options.categories, '');
  fillSelect(regionSelect, options.regions, '');
  fillSelect(sourceSelect, newsSourceOptions([]), '');
  form.append(
    search,
    labelled(t('Time'), windowSelect),
    labelled(t('Category'), categorySelect),
    labelled(t('Region'), regionSelect),
    labelled(t('Source'), sourceSelect),
  );

  const status = element(document, 'p', 'skynet-news-status');
  status.setAttribute('role', 'status');
  const list = element(document, 'ol', 'skynet-news-list');
  list.setAttribute('aria-label', t('News stories'));
  const footer = element(document, 'footer', 'skynet-news-footer');
  const footnote = element(
    document,
    'p',
    '',
    t('From the local intel service: headline, short summary and link only.'),
  );
  const citation = element(document, 'p', 'skynet-news-citation');
  footer.append(footnote, citation);
  drawer.append(header, form, status, list, footer);

  // -- the ticker bar: toggle, freshness, newest headline ---------------
  const ticker = element(document, 'div', 'skynet-news-ticker');
  ticker.id = 'skynet-news-ticker';
  ticker.hidden = true;
  ticker.setAttribute('role', 'region');
  ticker.setAttribute('aria-live', 'off');
  ticker.setAttribute('aria-label', t('Latest headlines'));
  const tickerBadge = element(document, 'span', 'skynet-news-ticker-badge');
  const tickerAge = element(document, 'span', 'skynet-news-ticker-age');
  const tickerHeadline = element(
    document,
    'button',
    'skynet-news-ticker-headline',
  );
  tickerHeadline.type = 'button';
  ticker.append(toggle, tickerBadge, tickerAge, tickerHeadline);

  body.append(ticker, drawer);

  // -- state -------------------------------------------------------------
  let destroyed = false;
  let queryTimer = null;
  let liveTimer = null;
  let tickerTimer = null;
  let request = null;
  let results = [];
  let resultFreshness = null;
  let resultError = null;
  let tickerIndex = 0;
  let tickerPaused = false;

  const isOpen = () => !drawer.hidden;

  function renderList() {
    const model = layer.getModel();
    const items = newsDrawerItems(results, {
      now: now(),
      selectedId: model.selectedId,
    });
    list.replaceChildren(
      ...items.map((item) => {
        const row = element(document, 'li', 'skynet-news-item');
        row.dataset.storyId = String(item.id);
        if (item.selected) row.classList.add('is-selected');
        row.style.setProperty('--skynet-news-color', item.color);
        const heading = element(document, 'button', 'skynet-news-headline');
        heading.type = 'button';
        heading.textContent = item.alert
          ? `${t('ALERT')} · ${item.title}`
          : item.title;
        heading.disabled = !item.located;
        heading.title = item.located
          ? t('Show this story on the globe')
          : t('Not placed on the globe');
        const meta = element(
          document,
          'p',
          'skynet-news-meta',
          `${item.category} · ${item.meta}`,
        );
        row.append(heading, meta);
        if (item.summary)
          row.append(
            element(document, 'p', 'skynet-news-summary', item.summary),
          );
        const outlets = element(document, 'p', 'skynet-news-outlets');
        for (const outlet of item.outlets)
          outlets.append(outletLink(document, outlet.name, outlet.url));
        if (item.gdelt) {
          const cite = gdeltCitation();
          outlets.append(outletLink(document, 'GDELT', cite.url));
        }
        row.append(outlets);
        return row;
      }),
    );
    const anyGdelt = items.some((item) => item.gdelt);
    citation.replaceChildren();
    if (anyGdelt) {
      const cite = gdeltCitation();
      citation.append(outletLink(document, cite.text, cite.url));
    }
    const selected = list.querySelector?.('.is-selected');
    selected?.scrollIntoView?.({ block: 'nearest' });
  }

  function renderStatus() {
    const fresh = newsFreshness({
      freshness: resultFreshness ?? layer.getModel().freshness,
      error: resultError,
      loading: Boolean(request),
    });
    badge.textContent = fresh.badge ?? '';
    badge.hidden = !fresh.badge;
    badge.dataset.tone = fresh.tone;
    const count = results.length
      ? tn(results.length, '{count} story', '{count} stories', {
          count: results.length,
        })
      : request
        ? null
        : resultError
          ? null
          : t('No stories match these filters');
    status.textContent = [fresh.text, count].filter(Boolean).join(' · ');
  }

  async function runQuery() {
    queryTimer = null;
    if (destroyed || !isOpen()) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    renderStatus();
    try {
      const page = await layer.searchStories(
        {
          q: search.value,
          windowHours: Number(windowSelect.value),
          categories: categorySelect.value ? [categorySelect.value] : [],
          region: regionSelect.value,
          source: sourceSelect.value,
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || destroyed) return;
      results = page.records;
      resultFreshness = page.freshness;
      resultError = null;
      fillSelect(
        sourceSelect,
        newsSourceOptions(results, sourceSelect.value),
        sourceSelect.value,
      );
    } catch (error) {
      if (controller.signal.aborted || destroyed) return;
      results = [];
      resultError =
        error?.code === 'intel_offline' ? INTEL_OFFLINE : NEWS_UNAVAILABLE;
    } finally {
      if (request === controller) request = null;
    }
    renderList();
    renderStatus();
  }

  function scheduleQuery(delay = QUERY_DELAY_MS) {
    if (queryTimer !== null) clearTimer(queryTimer);
    queryTimer = setTimer(runQuery, delay);
  }

  function open() {
    if (destroyed || !layer.getModel().enabled) return;
    drawer.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    body.classList.add('skynet-news-open');
    search.focus();
    void runQuery();
  }

  function closeDrawer({ restoreFocus = false } = {}) {
    if (drawer.hidden) return;
    drawer.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    body.classList.remove('skynet-news-open');
    request?.abort();
    if (restoreFocus && !ticker.hidden) toggle.focus();
  }

  function renderTicker() {
    const model = layer.getModel();
    const entries = newsTickerEntries(model.records, { now: now() });
    ticker.hidden = !model.enabled;
    if (ticker.hidden) return;
    const fresh = newsFreshness(model);
    tickerBadge.textContent =
      fresh.badge ?? (fresh.tone === 'live' ? t('LIVE') : '');
    tickerBadge.hidden = !tickerBadge.textContent;
    tickerBadge.dataset.tone = fresh.tone;
    tickerBadge.title = fresh.text ?? '';
    const entry = entries.length
      ? entries[(tickerIndex %= entries.length)]
      : null;
    tickerAge.hidden = !entry;
    tickerHeadline.hidden = !entry;
    if (!entry) return;
    tickerAge.textContent = entry.age;
    tickerHeadline.textContent = entry.alert
      ? `${t('ALERT')} · ${entry.title}`
      : entry.title;
    tickerHeadline.dataset.storyId = String(entry.id);
    tickerHeadline.style.setProperty('--skynet-news-color', entry.color);
    tickerHeadline.title = entry.gdelt ? gdeltCitation().text : '';
  }

  function scheduleTicker() {
    if (tickerTimer !== null) clearTimer(tickerTimer);
    tickerTimer = null;
    // Reduced motion: the newest headline stays; it changes only when news does.
    if (reduceMotion() || destroyed) return;
    tickerTimer = setTimer(() => {
      tickerTimer = null;
      if (!tickerPaused) tickerIndex += 1;
      renderTicker();
      scheduleTicker();
    }, TICKER_STEP_MS);
  }

  function onModel(model, extra) {
    toggleCount.textContent = model.records.length
      ? String(model.records.length)
      : '';
    if (!model.enabled) {
      closeDrawer();
      ticker.hidden = true;
      return;
    }
    if (extra?.live) tickerIndex = 0;
    renderTicker();
    if (isOpen()) {
      if (extra?.live) {
        if (liveTimer !== null) clearTimer(liveTimer);
        liveTimer = setTimer(() => {
          liveTimer = null;
          scheduleQuery(0);
        }, LIVE_REQUERY_MS);
      } else {
        renderList();
        renderStatus();
      }
    }
  }

  // -- events ------------------------------------------------------------
  const listeners = [];
  const on = (target, type, handler) => {
    target.addEventListener(type, handler);
    listeners.push(() => target.removeEventListener(type, handler));
  };
  on(toggle, 'click', () =>
    isOpen() ? closeDrawer({ restoreFocus: true }) : open(),
  );
  on(close, 'click', () => closeDrawer({ restoreFocus: true }));
  on(drawer, 'keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeDrawer({ restoreFocus: true });
    }
  });
  on(form, 'submit', (event) => {
    event.preventDefault();
    scheduleQuery(0);
  });
  on(search, 'input', () => scheduleQuery());
  for (const select of [
    windowSelect,
    categorySelect,
    regionSelect,
    sourceSelect,
  ])
    on(select, 'change', () => scheduleQuery(0));
  on(list, 'click', (event) => {
    const button = event.target?.closest?.('.skynet-news-headline');
    if (!button || button.disabled) return;
    const id = Number(button.closest('.skynet-news-item')?.dataset.storyId);
    if (Number.isSafeInteger(id)) layer.setParams({ storyId: id, focus: true });
  });
  on(tickerHeadline, 'click', () => {
    const id = Number(tickerHeadline.dataset.storyId);
    if (Number.isSafeInteger(id)) layer.setParams({ storyId: id, focus: true });
  });
  for (const type of ['mouseenter', 'focusin'])
    on(ticker, type, () => (tickerPaused = true));
  for (const type of ['mouseleave', 'focusout'])
    on(ticker, type, () => (tickerPaused = false));

  const unsubscribe = layer.subscribe(onModel);
  layer.setPanelOpener?.(open);
  onModel(layer.getModel());
  scheduleTicker();

  return {
    open,
    close: () => closeDrawer(),
    destroy() {
      destroyed = true;
      unsubscribe();
      layer.setPanelOpener?.(null);
      for (const remove of listeners) remove();
      for (const timer of [queryTimer, liveTimer, tickerTimer])
        if (timer !== null) clearTimer(timer);
      request?.abort();
      body.classList.remove('skynet-news-open');
      drawer.remove();
      ticker.remove();
    },
  };
}
