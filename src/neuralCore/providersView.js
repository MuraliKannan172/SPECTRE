/**
 * SPECTRE Neural Core providers (ADR-002 D6, D10, D11): what the provider
 * controls show, as plain data. Pure (no DOM), tested in Node.
 */
import { formatNumber, msg, t } from '../i18n/index.js';

const KIND_LABELS = Object.freeze({
  local: msg('LOCAL'),
  remote: msg('REMOTE'),
  cloud: msg('CLOUD'),
});

/** The text badge for where a model runs; never colour alone (D6). */
export function kindBadge(kind, providerLabel = '') {
  if (kind === 'cloud')
    return providerLabel
      ? `${t(KIND_LABELS.cloud)} · ${providerLabel}`
      : t(KIND_LABELS.cloud);
  return t(KIND_LABELS[kind] || KIND_LABELS.local);
}

/** The footer disclaimer, naming where the model runs (D6). */
export function disclaimerText(kind, providerLabel = '') {
  if (kind === 'cloud')
    return t(
      'Cloud model ({provider}): the conversation is sent to it. Answers can be wrong. Not for navigation or emergencies. It will not locate or track people.',
      { provider: providerLabel || '?' },
    );
  if (kind === 'remote')
    return t(
      'Model on your network; answers can be wrong. Not for navigation or emergencies. It will not locate or track people.',
    );
  return t(
    'Local model; answers can be wrong. Not for navigation or emergencies. It will not locate or track people.',
  );
}

/** What a non-local provider receives, for the consent dialog (D6). */
export function consentItems({ mapContext = true } = {}) {
  const items = [
    t('The conversation text: your questions and the answers.'),
    t('Tool results: news snippets and text fetched from the web.'),
  ];
  items.push(
    mapContext
      ? t('Map context: the viewport and the layers that are on.')
      : t('Not the map: map context is off in Neural Core settings.'),
  );
  return items;
}

/** The provider's line in the provider list. */
export function providerState(provider, test = null) {
  if (test?.ok === true) return { code: 'connected', text: t('Connected') };
  if (test?.ok === false) return { code: 'error', text: t('Error') };
  if (provider?.key?.required && !provider.key.configured)
    return provider.id === 'custom'
      ? { code: 'ready', text: t('No key (optional)') }
      : { code: 'not_configured', text: t('Not configured') };
  if (provider?.kind === 'local') return { code: 'local', text: t('Local') };
  return { code: 'ready', text: t('Key set') };
}

/** Where a configured key came from, in words. */
export function keySourceText(key) {
  if (!key?.required) return t('Takes no API key');
  if (!key.configured) return t('No key yet: add it in POWER UP');
  if (key.source === 'environment')
    return t('Key from the environment (read-only)');
  if (key.source === 'env_file')
    return t('Key from .env (shared with POWER UP)');
  return t('Key in the OS keyring');
}

/** 131072 → "128K", 1048576 → "1M". */
export function formatContext(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  if (tokens >= 1_000_000)
    return `${formatNumber(Math.round(tokens / 104_857.6) / 10)}M`;
  return `${formatNumber(Math.round(tokens / 1024))}K`;
}

/**
 * USD per 1M tokens, in and out: OpenRouter's list gives USD per token (D10),
 * otherwise the user's own price; null when no price is known.
 */
export function pricePerMillion(model, params = {}) {
  const listed = model?.details?.pricing;
  const fromList = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number * 1_000_000 : null;
  };
  const input = listed ? fromList(listed.prompt) : Number(params.price_in);
  const output = listed
    ? fromList(listed.completion)
    : Number(params.price_out);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { input, output };
}

function money(value) {
  return `$${formatNumber(value, { maximumFractionDigits: value < 1 ? 3 : 2 })}`;
}

/** The capability chips of a model in the picker (D11). */
export function modelChips(model, params = {}) {
  const caps = new Set(model?.capabilities || []);
  const chips = [];
  if (model?.supports_tools === 'yes' || caps.has('tools'))
    chips.push(t('TOOLS'));
  else if (model?.supports_tools === 'unknown') chips.push(t('TOOLS ?'));
  if (caps.has('vision')) chips.push(t('VISION'));
  if (caps.has('reasoning') || caps.has('thinking')) chips.push(t('REASONING'));
  const context = formatContext(model?.context_window);
  if (context) chips.push(context);
  if (model?.kind === 'local') return chips; // a model on this machine costs nothing per token
  const price = pricePerMillion(model, params);
  chips.push(
    price
      ? t('{input} / {output} per 1M', {
          input: money(price.input),
          output: money(price.output),
        })
      : '?',
  );
  return chips;
}

/** Favourites first, then by label; the query matches id or label. */
export function filterModels(models, query = '', favourites = []) {
  const wanted = String(query).trim().toLowerCase();
  const starred = new Set(favourites);
  return models
    .filter(
      (m) =>
        !wanted ||
        m.id.toLowerCase().includes(wanted) ||
        String(m.label || '')
          .toLowerCase()
          .includes(wanted),
    )
    .sort(
      (a, b) =>
        Number(starred.has(b.id)) - Number(starred.has(a.id)) ||
        String(a.label || a.id).localeCompare(String(b.label || b.id)),
    );
}

/**
 * Whether an Ollama model's weights fit the VRAM budget: an estimate (file
 * size plus a fifth for the context), never a promise (D11).
 */
export function vramFit(sizeBytes, budgetGb) {
  if (
    !Number.isFinite(sizeBytes) ||
    !Number.isFinite(budgetGb) ||
    budgetGb <= 0
  )
    return null;
  const neededGb = (sizeBytes * 1.2) / 1e9;
  return {
    fits: neededGb <= budgetGb,
    text: t('~{needed} GB of {budget} GB VRAM (estimate)', {
      needed: formatNumber(Math.round(neededGb * 10) / 10),
      budget: formatNumber(budgetGb),
    }),
  };
}

/** Session tokens for the header, with a cost when a price is known. */
export function usageText(usage, price = null) {
  const tokens = (usage?.input || 0) + (usage?.output || 0);
  if (!tokens) return null;
  const count =
    tokens >= 1000
      ? `${formatNumber(Math.round(tokens / 100) / 10)}K`
      : formatNumber(tokens);
  if (!price) return t('{count} tokens', { count });
  const cost =
    ((usage.input || 0) * price.input + (usage.output || 0) * price.output) /
    1_000_000;
  return t('{count} tokens · {cost}', { count, cost: money(cost) });
}

/** The budget-reached line (D10). */
export function budgetText(budget) {
  return t(
    'This conversation used {spent} cloud tokens, its budget of {allowance}. Continue to allow {budget} more.',
    {
      spent: formatNumber(budget?.spent || 0),
      allowance: formatNumber(budget?.allowance || 0),
      budget: formatNumber(budget?.budget || 0),
    },
  );
}
