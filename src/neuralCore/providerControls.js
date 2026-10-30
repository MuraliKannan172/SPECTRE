/**
 * SPECTRE Neural Core provider controls (ADR-002 D6, D7, D10, D11): the header
 * chip and quick switch, the provider-aware disclaimer, the settings view,
 * and what the panel offers when a turn cannot run. Nothing here switches
 * provider by itself: every switch is the user's, through the gated route.
 */
import { t } from '../i18n/index.js';
import { mountProviderSettings } from './providerSettings.js';
import {
  disclaimerText,
  kindBadge,
  pricePerMillion,
  usageText,
} from './providersView.js';

const SEPARATOR = '\u0000';

function node(document, tag, className = '', text = null) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== null) element.textContent = text;
  return element;
}

/**
 * @param {{document: Document, providers: ReturnType<
 *   import('./providersClient.js').createProvidersClient>, panel: HTMLElement,
 *   disclaimer: HTMLElement, historyLength: () => number,
 *   onChanged: () => void, openPowerUp?: () => void, storage?: Storage}} options
 */
export function mountProviderControls({
  document,
  providers,
  panel,
  disclaimer,
  historyLength,
  onChanged,
  openPowerUp = () => openPowerUpDialog(document),
  storage,
}) {
  const settings = mountProviderSettings({
    document,
    providers,
    storage,
    historyLength,
    openPowerUp,
    onSelected: () => onChanged(),
  });
  const chip = node(document, 'button', 'spectre-nc-chip');
  chip.type = 'button';
  chip.setAttribute('aria-haspopup', 'true');
  const switcher = node(document, 'select', 'spectre-nc-switch');
  switcher.setAttribute('aria-label', t('Switch model'));
  let status = null;

  const label = (id) =>
    settings.snapshot()?.providers.find((p) => p.id === id)?.label || id;

  function openSettings() {
    panel.dataset.view = 'settings';
    void settings.show();
  }
  chip.addEventListener('click', openSettings);
  settings.element.addEventListener('spectre-nc-settings-closed', () => {
    panel.dataset.view = 'chat';
    chip.focus();
  });

  switcher.addEventListener('change', async () => {
    const [providerId, model] = switcher.value.split(SEPARATOR);
    const changed = await settings.choose(providerId, model);
    if (!changed) renderSwitcher(); // cancelled: show the real selection again
  });

  function renderSwitcher() {
    const currentProvider = status?.provider || 'ollama';
    const currentModel = status?.model || '';
    const options = [[currentProvider, currentModel]];
    for (const [providerId, ids] of Object.entries(settings.favourites()))
      for (const id of ids)
        if (providerId !== currentProvider || id !== currentModel)
          options.push([providerId, id]);
    switcher.replaceChildren(
      ...options.map(([providerId, model]) => {
        const option = node(
          document,
          'option',
          '',
          `${label(providerId)} · ${model}`,
        );
        option.value = `${providerId}${SEPARATOR}${model}`;
        return option;
      }),
    );
    switcher.value = `${currentProvider}${SEPARATOR}${currentModel}`;
    switcher.hidden = options.length < 2; // nothing to switch to yet
  }

  /** From a /chat/status reply. */
  function update(next) {
    status = next;
    const providerId = next?.provider || 'ollama';
    const provider = settings
      .snapshot()
      ?.providers.find((p) => p.id === providerId);
    const kind = next?.kind || provider?.kind || 'local';
    const name = label(providerId);
    const price = provider ? pricePerMillion(null, provider.params) : null;
    const usage = usageText(next?.usage, price);
    chip.textContent = [kindBadge(kind, name), next?.model, usage]
      .filter(Boolean)
      .join(' · ');
    chip.title = t('Neural Core settings');
    chip.dataset.kind = kind;
    disclaimer.textContent = disclaimerText(kind, name);
    renderSwitcher();
  }

  /**
   * What the panel offers for a failed turn: never a silent switch (brief §4).
   * @returns {{label: string, run: (retry: () => void) => Promise<void>|void}[]}
   */
  function recovery(code) {
    const settingsAction = {
      label: t('Choose another model'),
      run: openSettings,
    };
    if (code === 'consent_required')
      return [
        {
          label: t('Allow and retry'),
          run: async (retry) => {
            if (await settings.askConsent(status?.provider || 'ollama'))
              retry();
          },
        },
        settingsAction,
      ];
    if (code === 'budget')
      return [
        {
          label: t('Continue'),
          run: async (retry) => {
            await providers.continueBudget();
            retry();
          },
        },
      ];
    if (code === 'auth_failed' || code === 'no_key')
      return [
        { label: t('Set the key in POWER UP'), run: openPowerUp },
        settingsAction,
      ];
    if (
      ['provider_unavailable', 'provider_rate_limited', 'network'].includes(
        code,
      )
    )
      return [{ label: t('Retry'), run: (retry) => retry() }, settingsAction];
    if (status?.provider && status.provider !== 'ollama')
      return [settingsAction];
    return [];
  }

  return {
    chip,
    switcher,
    settings: settings.element,
    update,
    recovery,
    openSettings,
    refresh: () => settings.refresh().then(() => update(status)),
  };
}

/** POWER UP lives on the dev server only; open it when it is there. */
function openPowerUpDialog(document) {
  const chip = document.getElementById('key-setup-chip');
  if (chip) {
    chip.hidden = false;
    chip.click();
  }
}
