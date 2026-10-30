/**
 * SPECTRE: Neural Core chat keys as rows in POWER UP (ADR-002 Q1: one key UI).
 *
 * They store through the intel service, in the OS keyring, never through
 * POWER UP's own Save, which writes .env and restarts the dev server. So the
 * inputs carry their own attribute (`data-nc-key`), never `data-env-var`, and
 * the Remove buttons never `data-key-setup-remove`: POWER UP's collectors and
 * click handler cannot pick them up. A typed key leaves its field as soon as
 * it is saved; the service never sends a key, a prefix or a suffix back.
 */
import { msg, registerUnsavedWork, t } from '../i18n/index.js';
import { createProvidersClient } from './providersClient.js';
import { keySourceText } from './providersView.js';

const SAVE_ERRORS = Object.freeze({
  bad_key: msg(
    'That does not look like an API key (8 to 512 characters, no spaces).',
  ),
  external: msg('This key is set in the environment; change it there.'),
  key_over_http: msg(
    'This server is on plain http on another machine; a key would travel unencrypted.',
  ),
  keyring_failed: msg('The OS keyring refused the key.'),
  session_required: msg('The intel service restarted; try again.'),
});

function node(documentRef, tag, className = '', text = null) {
  const element = documentRef.createElement(tag);
  if (className) element.className = className;
  if (text !== null) element.textContent = text;
  return element;
}

/**
 * @param {{documentRef: Document, host: Element | null,
 *   providers?: ReturnType<typeof createProvidersClient>, signal?: AbortSignal}} options
 */
export function mountNeuralCoreKeyRows({
  documentRef,
  host,
  providers = createProvidersClient(),
  signal,
}) {
  if (!host) return null;
  const unregister = registerUnsavedWork(() =>
    [...host.querySelectorAll('input[data-nc-key]')].some((input) =>
      input.value.trim(),
    )
      ? msg('unsaved Neural Core keys')
      : null,
  );
  signal?.addEventListener(
    'abort',
    () => {
      unregister();
      host.replaceChildren();
    },
    { once: true },
  );
  const status = node(documentRef, 'p', 'key-setup-note');
  status.setAttribute('role', 'status');

  function row(provider) {
    const item = node(documentRef, 'div', 'key-setup-row');
    item.dataset.set = String(provider.key.configured);
    const head = node(documentRef, 'div', 'key-setup-row-head');
    head.append(node(documentRef, 'strong', '', provider.label));
    // Inside POWER UP, "add it in POWER UP" would point at itself.
    let source = keySourceText(provider.key);
    if (!provider.key.configured)
      source =
        provider.id === 'custom'
          ? t('Optional: only if your server asks for one.')
          : t('No key yet.');
    item.append(head, node(documentRef, 'p', 'key-setup-unlocks', source));
    if (provider.id === 'openai' && provider.key.source === 'env_file')
      item.append(
        node(
          documentRef,
          'p',
          'key-setup-unlocks',
          t(
            'This is the OPENAI_API_KEY from .env that voice uses. A key saved here is used for chat only.',
          ),
        ),
      );
    if (provider.key.source === 'environment') return item; // read-only (D5)
    const fields = node(documentRef, 'div', 'key-setup-fields');
    const input = node(documentRef, 'input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.dataset.ncKey = provider.id;
    input.setAttribute(
      'aria-label',
      t('{provider} API key', { provider: provider.label }),
    );
    input.placeholder = provider.key.configured
      ? t('saved: paste to replace')
      : t('paste the {provider} key', { provider: provider.label });
    const save = node(documentRef, 'button', 'key-setup-apply', t('SAVE'));
    save.type = 'button';
    save.addEventListener('click', () => void store(provider, input));
    fields.append(input, save);
    if (provider.key.source === 'keyring') {
      const remove = node(
        documentRef,
        'button',
        'key-setup-remove',
        t('REMOVE'),
      );
      remove.type = 'button';
      remove.addEventListener('click', () => void forget(provider));
      fields.append(remove);
    }
    item.append(fields);
    return item;
  }

  async function store(provider, input) {
    const key = input.value.trim();
    if (!key) return;
    try {
      await providers.setKey(provider.id, key);
      input.value = '';
      status.textContent = t(
        'Saved {provider} to the OS keyring. No restart needed.',
        {
          provider: provider.label,
        },
      );
      await render();
    } catch (error) {
      const known = SAVE_ERRORS[error?.code];
      status.textContent = known
        ? t(known)
        : t('Could not save the key ({code}).', { code: error?.code || '?' });
    }
  }

  async function forget(provider) {
    try {
      const left = await providers.removeKey(provider.id);
      status.textContent = left?.configured
        ? t('Removed from the keyring; {provider} still has a key from .env.', {
            provider: provider.label,
          })
        : t('Removed {provider} from the keyring.', {
            provider: provider.label,
          });
      await render();
    } catch (error) {
      status.textContent = t('Could not remove the key ({code}).', {
        code: error?.code || '?',
      });
    }
  }

  async function render() {
    let snapshot;
    try {
      snapshot = await providers.list();
    } catch {
      host.hidden = true; // intel service not running, or not this machine
      return;
    }
    if (signal?.aborted) return;
    host.hidden = false;
    const keyed = snapshot.providers.filter((p) => p.key.required);
    host.replaceChildren(
      node(documentRef, 'h3', 'key-setup-kicker', t('NEURAL CORE CHAT KEYS')),
      node(
        documentRef,
        'p',
        'key-setup-unlocks',
        t(
          'Saved in your OS keyring by the intel service, not in .env. Saving here does not restart anything.',
        ),
      ),
      ...keyed.map(row),
      status,
    );
  }

  // Ask the intel service only when POWER UP opens (it adds `visible`), not
  // on every page load: no request, and no console error, while it is closed.
  const dialog = host.closest('#key-setup');
  const isOpen = () => Boolean(dialog?.classList.contains('visible'));
  let wasOpen = false;
  const watch = new MutationObserver(() => {
    const open = isOpen();
    if (open && !wasOpen) void render();
    wasOpen = open;
  });
  if (dialog)
    watch.observe(dialog, { attributes: true, attributeFilter: ['class'] });
  signal?.addEventListener('abort', () => watch.disconnect(), { once: true });
  if (!dialog || isOpen()) void render();
  return { render };
}
