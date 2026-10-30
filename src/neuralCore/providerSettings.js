/**
 * SPECTRE Neural Core settings (ADR-002 D6, D10, D11): providers, models,
 * parameters and the privacy switches, as a view inside the Neural Core panel.
 *
 * Keys are typed in POWER UP (ADR-002 Q1); this view only says where a key
 * comes from. Favourites and the VRAM budget are per-browser conveniences in
 * localStorage; nothing secret is ever stored in the browser.
 */
import { t } from '../i18n/index.js';
import { confirmDialog } from './confirmDialog.js';
import {
  consentItems,
  filterModels,
  keySourceText,
  kindBadge,
  modelChips,
  providerState,
  vramFit,
} from './providersView.js';
import { errorText } from './view.js';

const FAVOURITES_KEY = 'spectre.neuralCore.favourites';
const VRAM_KEY = 'spectre.neuralCore.vramGb';
const DEFAULT_VRAM_GB = 8;
// The service's accepted range for the API models' context ceiling (ADR-002 D9).
const CONTEXT_CEILING = [4096, 1_048_576];
// Where the service accepts the reasoning switch (REASONING_PROVIDERS, D11).
const REASONING_PROVIDERS = new Set([
  'ollama',
  'deepseek',
  'openrouter',
  'openai',
]);

function load(storage, key, fallback) {
  try {
    const value = storage?.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function store(storage, key, value) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    /* private window or blocked storage: the convenience is lost, nothing else */
  }
}

function node(document, tag, className = '', text = null) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== null) element.textContent = text;
  return element;
}

function action(document, label, onClick, className = 'spectre-nc-action') {
  const button = node(document, 'button', className, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function field(document, label, input) {
  const wrap = node(document, 'label', 'spectre-nc-field');
  wrap.append(node(document, 'span', '', label), input);
  return wrap;
}

function numberInput(document, value, { min, max, step = 'any' }) {
  const input = node(document, 'input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = value ?? '';
  return input;
}

function failureText(error) {
  return errorText(error?.code || 'network');
}

/** One pull progress line: Ollama's own status, with a percent while a layer downloads. */
export function pullProgress({ status, total, completed } = {}) {
  const text = String(status || '');
  if (!(total > 0) || !Number.isFinite(completed)) return text;
  const percent = Math.min(100, Math.floor((completed / total) * 100));
  return t('{status} · {percent}%', { status: text, percent });
}

/**
 * @param {{document: Document, providers: ReturnType<
 *   import('./providersClient.js').createProvidersClient>, storage?: Storage,
 *   onSelected: () => void, openPowerUp: () => void,
 *   historyLength: () => number}} options
 */
export function mountProviderSettings({
  document,
  providers,
  storage = globalThis.localStorage,
  onSelected,
  openPowerUp,
  historyLength,
}) {
  const view = node(document, 'section', 'spectre-nc-settings');
  view.hidden = true;
  view.setAttribute('aria-label', t('Neural Core settings'));
  const heading = node(document, 'h2', '', t('Neural Core settings'));
  const back = action(document, t('Back to the chat'), () => hide());
  back.classList.add('spectre-nc-back');
  const message = node(document, 'p', 'spectre-nc-settings-message');
  message.setAttribute('role', 'status');
  const policyBox = node(document, 'fieldset', 'spectre-nc-policy');
  const list = node(document, 'div', 'spectre-nc-provider-list');
  list.setAttribute('role', 'list');
  const detail = node(document, 'div', 'spectre-nc-provider-detail');
  view.append(back, heading, message, policyBox, list, detail);

  let snapshot = null; // GET /providers
  let current = null; // provider id shown in the detail
  const tests = new Map();
  const models = new Map();
  let favourites = load(storage, FAVOURITES_KEY, {});

  const say = (text) => {
    message.textContent = text || '';
  };
  const byId = (id) => snapshot?.providers.find((p) => p.id === id) || null;

  async function refresh() {
    try {
      snapshot = await providers.list();
      say('');
    } catch (error) {
      snapshot = null;
      say(
        error?.code?.startsWith?.('providers_')
          ? t('Provider settings answer only on the computer running SPECTRE.')
          : failureText(error),
      );
    }
    render();
    return snapshot;
  }

  // -- privacy switches and the budget ----------------------------------------
  function renderPolicy() {
    policyBox.replaceChildren(
      node(document, 'legend', '', t('Privacy and cost')),
    );
    if (!snapshot) return;
    const { policy } = snapshot;
    const toggle = (label, key) => {
      const input = node(document, 'input');
      input.type = 'checkbox';
      input.checked = Boolean(policy[key]);
      input.addEventListener(
        'change',
        () => void savePolicy({ [key]: input.checked }),
      );
      const wrap = node(document, 'label', 'spectre-nc-toggle');
      wrap.append(input, node(document, 'span', '', label));
      return wrap;
    };
    const budget = numberInput(document, policy.session_budget, {
      min: 0,
      max: 10_000_000,
      step: 1000,
    });
    budget.addEventListener('change', () => {
      const value = Math.round(Number(budget.value));
      if (Number.isFinite(value) && value >= 0)
        void savePolicy({ session_budget: value });
    });
    const ceiling = numberInput(document, policy.context_ceiling, {
      min: CONTEXT_CEILING[0],
      max: CONTEXT_CEILING[1],
      step: 1024,
    });
    ceiling.addEventListener('change', () => {
      const value = Math.round(Number(ceiling.value));
      if (value >= CONTEXT_CEILING[0] && value <= CONTEXT_CEILING[1])
        void savePolicy({ context_ceiling: value });
    });
    policyBox.append(
      toggle(t('Local-only mode: block every cloud model'), 'local_only'),
      toggle(
        t('Send map context (viewport, layers) to non-local models'),
        'map_context',
      ),
      field(
        document,
        t('Cloud tokens per conversation before asking (0 is off)'),
        budget,
      ),
      field(
        document,
        t(
          'Context ceiling for API models, in tokens (16384 by default; more sends more history and web text, all billed)',
        ),
        ceiling,
      ),
    );
  }

  async function savePolicy(change) {
    try {
      await providers.setPolicy(change);
      await refresh();
      onSelected();
    } catch (error) {
      say(failureText(error));
    }
  }

  // -- the provider list ---------------------------------------------------------
  function renderList() {
    list.replaceChildren();
    for (const provider of snapshot?.providers || []) {
      const state = providerState(provider, tests.get(provider.id));
      const button = node(document, 'button', 'spectre-nc-provider');
      button.type = 'button';
      button.setAttribute('role', 'listitem');
      button.setAttribute('aria-current', String(provider.id === current));
      button.dataset.state = state.code;
      button.append(
        node(document, 'span', 'spectre-nc-provider-name', provider.label),
        // The name is right beside it, so the list badge is the kind alone.
        node(document, 'span', 'spectre-nc-badge', kindBadge(provider.kind)),
        node(document, 'span', 'spectre-nc-provider-state', state.text),
      );
      button.addEventListener('click', () => {
        current = provider.id;
        render();
        void loadModels(provider);
      });
      list.append(button);
    }
  }

  // -- one provider ------------------------------------------------------------
  function renderDetail() {
    detail.replaceChildren();
    const provider = byId(current);
    if (!provider) {
      detail.append(
        node(
          document,
          'p',
          'spectre-nc-hint',
          t('Pick a provider to see its models and settings.'),
        ),
      );
      return;
    }
    detail.append(
      node(document, 'h3', '', provider.label),
      node(
        document,
        'p',
        'spectre-nc-badge',
        kindBadge(provider.kind, provider.label),
      ),
      node(document, 'p', 'spectre-nc-hint', keySourceText(provider.key)),
    );
    // The service sends a key only to the address it was saved for.
    if (provider.key.configured && provider.key_reaches_address === false)
      detail.append(
        node(
          document,
          'p',
          'spectre-nc-hint',
          t(
            'The key was saved for another address, so it is not sent to this one. Save it again in POWER UP to use it here.',
          ),
        ),
      );
    const buttons = node(document, 'div', 'spectre-nc-actions');
    if (provider.key.required && provider.key.source !== 'environment')
      buttons.append(
        action(document, t('Set the key in POWER UP'), () => openPowerUp()),
      );
    const testLine = node(document, 'p', 'spectre-nc-hint');
    testLine.setAttribute('role', 'status');
    buttons.append(
      action(document, t('Test connection'), async () => {
        testLine.textContent = t('Testing…');
        try {
          const result = await providers.test(provider.id);
          tests.set(provider.id, result);
          testLine.textContent = result.ok
            ? t('Connected')
            : `${t('Error')}: ${errorText(result.code)}`;
        } catch (error) {
          tests.set(provider.id, { ok: false });
          testLine.textContent = failureText(error);
        }
        renderList();
      }),
    );
    // Ollama is local, but consent given for its :cloud models must stay revocable.
    const asksConsent = provider.kind !== 'local' || provider.consent;
    if (asksConsent)
      buttons.append(
        action(
          document,
          provider.consent ? t('Revoke consent') : t('Allow this provider'),
          () => void setConsent(provider, !provider.consent),
        ),
      );
    detail.append(buttons, testLine);
    if (asksConsent)
      detail.append(
        node(
          document,
          'p',
          'spectre-nc-hint',
          provider.consent
            ? t('Allowed to receive conversations.')
            : t('Not allowed to receive conversations yet.'),
        ),
      );
    detail.append(settingsForm(provider), modelPicker(provider));
  }

  async function setConsent(provider, granted) {
    if (granted && !(await askConsent(provider))) return;
    try {
      await providers.setConsent(provider.id, granted);
      await refresh();
      onSelected();
    } catch (error) {
      say(failureText(error));
    }
  }

  function askConsent(provider) {
    return confirmDialog({
      document,
      title: t('Allow {provider} to receive conversations?', {
        provider: provider.label,
      }),
      // Ollama runs here; its :cloud models (and a remote Ollama) do not.
      intro:
        provider.id === 'ollama'
          ? t(
              'Ollama’s :cloud models run on ollama.com, and a remote Ollama on another machine. With each question they receive:',
            )
          : t(
              '{provider} runs outside this computer. With each question it receives:',
              { provider: provider.label },
            ),
      items: consentItems({ mapContext: snapshot?.policy?.map_context }),
      confirmLabel: t('Allow'),
      host: view.ownerDocument.body,
    });
  }

  function settingsForm(provider) {
    const form = node(document, 'details', 'spectre-nc-advanced');
    form.append(node(document, 'summary', '', t('Settings')));
    const params = provider.params || {};
    const inputs = {};
    if (provider.base_url_editable) {
      inputs.base_url = node(document, 'input');
      inputs.base_url.type = 'url';
      inputs.base_url.value = provider.base_url || '';
      form.append(
        field(document, t('Base URL (it receives the key)'), inputs.base_url),
      );
    }
    if (provider.adapter === 'anthropic') {
      inputs.workspace_id = node(document, 'input');
      inputs.workspace_id.value = provider.workspace_id || '';
      form.append(
        field(document, t('Anthropic workspace ID'), inputs.workspace_id),
      );
    }
    if (provider.adapter === 'openai') {
      inputs.chat = node(document, 'input');
      inputs.chat.value = (provider.chat_completions_models || []).join(', ');
      form.append(
        field(
          document,
          t('Models to run on Chat Completions (comma-separated)'),
          inputs.chat,
        ),
      );
    }
    if (provider.adapter !== 'anthropic') {
      inputs.temperature = numberInput(document, params.temperature, {
        min: 0,
        max: 2,
        step: 0.1,
      });
      form.append(field(document, t('Temperature'), inputs.temperature));
    }
    inputs.max_output_tokens = numberInput(document, params.max_output_tokens, {
      min: 64,
      max: 32768,
      step: 1,
    });
    form.append(
      field(document, t('Max output tokens'), inputs.max_output_tokens),
    );
    form.append(...reasoningSwitch(provider, params, inputs));
    if (provider.id === 'ollama') {
      inputs.num_ctx = numberInput(document, params.num_ctx, {
        min: 2048,
        max: 262144,
        step: 1024,
      });
      inputs.keep_alive = node(document, 'input');
      inputs.keep_alive.value = params.keep_alive || '';
      inputs.keep_alive.placeholder = '5m';
      form.append(
        field(document, t('Context window (num_ctx)'), inputs.num_ctx),
        field(
          document,
          t('Keep the model loaded for (keep_alive)'),
          inputs.keep_alive,
        ),
      );
    } else {
      inputs.price_in = numberInput(document, params.price_in, {
        min: 0,
        max: 10000,
      });
      inputs.price_out = numberInput(document, params.price_out, {
        min: 0,
        max: 10000,
      });
      form.append(
        field(
          document,
          t('Your price per 1M input tokens (USD)'),
          inputs.price_in,
        ),
        field(
          document,
          t('Your price per 1M output tokens (USD)'),
          inputs.price_out,
        ),
      );
    }
    form.append(
      action(
        document,
        t('Save settings'),
        () => void saveSettings(provider, inputs),
      ),
    );
    return form;
  }

  /** The reasoning switch (D11): off unless turned on, and offered only where
   * the service has a verified way to ask for it; elsewhere it shows why not. */
  function reasoningSwitch(provider, params, inputs) {
    const offered = REASONING_PROVIDERS.has(provider.id);
    const box = node(document, 'input');
    box.type = 'checkbox';
    box.checked = offered && params.reasoning === true;
    box.disabled = !offered;
    if (offered) inputs.reasoning = box;
    const label = node(document, 'label', 'spectre-nc-toggle');
    label.append(
      box,
      node(
        document,
        'span',
        '',
        t('Reasoning: the model thinks first (more tokens, slower)'),
      ),
    );
    if (offered) return [label];
    const why =
      provider.adapter === 'anthropic'
        ? t(
            'Not in this version for Claude: thinking with tools needs its blocks kept across turns, which is not verified yet.',
          )
        : t('Not offered: this provider has no common switch for reasoning.');
    return [label, node(document, 'p', 'spectre-nc-hint', why)];
  }

  async function saveSettings(provider, inputs) {
    const number = (input) =>
      input && input.value !== '' ? Number(input.value) : undefined;
    const saved = provider.params?.reasoning;
    const params = {
      temperature: number(inputs.temperature),
      max_output_tokens: number(inputs.max_output_tokens),
      num_ctx: number(inputs.num_ctx),
      keep_alive: inputs.keep_alive?.value.trim() || undefined,
      price_in: number(inputs.price_in),
      price_out: number(inputs.price_out),
      // Sent once it was ever on; never sent otherwise, so OLLAMA_THINK still applies.
      reasoning: inputs.reasoning?.checked
        ? true
        : saved !== undefined
          ? false
          : undefined,
    };
    for (const key of Object.keys(params))
      if (params[key] === undefined) delete params[key];
    try {
      await providers.saveSettings(provider.id, {
        base_url: inputs.base_url ? inputs.base_url.value.trim() || null : null,
        // An emptied field clears the workspace; no field keeps the saved one.
        workspace_id: inputs.workspace_id
          ? inputs.workspace_id.value.trim() || null
          : provider.workspace_id || null,
        chat_completions_models: inputs.chat
          ? inputs.chat.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : provider.chat_completions_models || [],
        params,
      });
      say(t('Saved.'));
      await refresh();
    } catch (error) {
      say(
        error?.code === 'unsupported_param' || error?.status === 422
          ? t('Some values are out of range; nothing was saved.')
          : failureText(error),
      );
    }
  }

  // -- models ---------------------------------------------------------------------
  async function loadModels(provider) {
    models.set(provider.id, { loading: true, list: [] });
    renderDetail();
    try {
      const { models: listed } = await providers.models(provider.id);
      models.set(provider.id, { list: listed || [] });
    } catch (error) {
      models.set(provider.id, { error: failureText(error), list: [] });
    }
    if (current === provider.id) renderDetail();
  }

  /** The list, plus a field for a model id the list does not show (a custom
   * server, a NIM model, or a list that failed). The server validates it. */
  function modelPicker(provider) {
    const box = pickerList(provider);
    const typed = node(document, 'input', 'spectre-nc-model-search');
    typed.placeholder = t('Or type a model id');
    typed.setAttribute('aria-label', t('Model id'));
    const manual = node(document, 'div', 'spectre-nc-actions');
    manual.append(
      typed,
      action(document, t('Use this model id'), () => {
        const id = typed.value.trim();
        if (id) void choose(provider, id);
      }),
    );
    box.append(manual);
    if (provider.id === 'ollama') box.append(...pullRow(provider));
    return box;
  }

  /** Pull model (D11): Ollama downloads a model by name and reports progress.
   * Stopping only stops watching; Ollama may finish the download anyway. */
  function pullRow(provider) {
    const row = node(document, 'div', 'spectre-nc-actions spectre-nc-pull');
    const name = node(document, 'input', 'spectre-nc-model-search');
    name.placeholder = t('Model to pull, such as qwen3:0.6b');
    name.setAttribute('aria-label', t('Model to pull'));
    const line = node(document, 'p', 'spectre-nc-hint');
    line.setAttribute('role', 'status');
    let watching = null;
    const stop = action(document, t('Stop watching'), () => watching?.abort());
    stop.hidden = true;
    const start = action(document, t('Pull model'), async () => {
      const model = name.value.trim();
      if (!model || watching) return;
      watching = new AbortController();
      start.disabled = true;
      stop.hidden = false;
      line.textContent = t('Starting…');
      let finished = null;
      try {
        await providers.pull(
          model,
          (event, data) => {
            if (event === 'progress') line.textContent = pullProgress(data);
            else if (event === 'done')
              finished = t('Pulled {model}.', { model });
            else if (event === 'error')
              finished = t('Ollama could not pull it: {message}', {
                message: data.message || data.code,
              });
          },
          watching.signal,
        );
      } catch (error) {
        finished =
          error?.name === 'AbortError'
            ? t('Stopped watching. Ollama may finish the download on its own.')
            : failureText(error);
      } finally {
        watching = null;
        start.disabled = false;
        stop.hidden = true;
      }
      await loadModels(provider); // redraws the list (and this row)
      say(finished || '');
    });
    row.append(name, start, stop);
    return [row, line];
  }

  function pickerList(provider) {
    const box = node(document, 'div', 'spectre-nc-models');
    box.append(node(document, 'h4', '', t('Models')));
    const state = models.get(provider.id);
    if (!state) {
      box.append(
        action(document, t('Load models'), () => void loadModels(provider)),
      );
      return box;
    }
    if (state.loading) {
      box.append(node(document, 'p', 'spectre-nc-hint', t('Loading models…')));
      return box;
    }
    if (state.error) {
      box.append(node(document, 'p', 'spectre-nc-error', state.error));
      return box;
    }
    if (!state.list.length) {
      box.append(
        node(
          document,
          'p',
          'spectre-nc-hint',
          t('This provider lists no chat models.'),
        ),
      );
      return box;
    }
    let vram = null;
    if (provider.id === 'ollama') {
      vram = numberInput(document, load(storage, VRAM_KEY, DEFAULT_VRAM_GB), {
        min: 1,
        max: 512,
        step: 1,
      });
      vram.addEventListener('change', () => {
        store(storage, VRAM_KEY, Number(vram.value) || DEFAULT_VRAM_GB);
        renderDetail();
      });
      box.append(
        field(document, t('GPU memory for the fit estimate (GB)'), vram),
      );
      void providers.gpu().then(
        ({ gpu }) => {
          if (gpu && vram.isConnected)
            vram.title = t('{name}: {gb} GB', {
              name: gpu.name,
              gb: Math.round(gpu.memory_mb / 102.4) / 10,
            });
        },
        () => {},
      );
    }
    const search = node(document, 'input', 'spectre-nc-model-search');
    search.type = 'search';
    search.placeholder = t('Search models');
    search.setAttribute('aria-label', t('Search models'));
    const rows = node(document, 'ul', 'spectre-nc-model-list');
    const draw = () => {
      rows.replaceChildren();
      const starred = favourites[provider.id] || [];
      for (const model of filterModels(state.list, search.value, starred)) {
        rows.append(
          modelRow(provider, model, starred.includes(model.id), vram),
        );
      }
    };
    search.addEventListener('input', draw);
    box.append(search, rows);
    draw();
    return box;
  }

  function modelRow(provider, model, starred, vram) {
    const row = node(document, 'li', 'spectre-nc-model');
    const star = action(
      document,
      starred ? '★' : '☆',
      () => {
        const list = new Set(favourites[provider.id] || []);
        if (list.has(model.id)) list.delete(model.id);
        else list.add(model.id);
        favourites = { ...favourites, [provider.id]: [...list] };
        store(storage, FAVOURITES_KEY, favourites);
        renderDetail();
      },
      'spectre-nc-star',
    );
    star.setAttribute('aria-pressed', String(starred));
    star.setAttribute(
      'aria-label',
      t('Favourite {model}', { model: model.label || model.id }),
    );
    const name = node(
      document,
      'span',
      'spectre-nc-model-name',
      model.label || model.id,
    );
    name.title = model.id;
    const chips = node(document, 'span', 'spectre-nc-chips');
    for (const chip of modelChips(model, provider.params))
      chips.append(node(document, 'span', 'spectre-nc-chip-cap', chip));
    if (model.kind === 'cloud' && provider.id === 'ollama')
      chips.append(
        node(
          document,
          'span',
          'spectre-nc-badge',
          kindBadge('cloud', 'Ollama'),
        ),
      );
    row.append(star, name, chips);
    // A :cloud model runs on ollama.com, not on this GPU.
    const fit =
      vram && model.kind !== 'cloud'
        ? vramFit(Number(model.details?.size), Number(vram.value))
        : null;
    if (fit) {
      const hint = node(document, 'span', 'spectre-nc-hint', fit.text);
      hint.dataset.fits = String(fit.fits);
      row.append(hint);
    }
    if (provider.id !== 'ollama' && model.supports_tools === 'unknown') {
      const probe = action(document, t('Test tool calling'), async () => {
        probe.disabled = true;
        probe.textContent = t('Testing…');
        try {
          const result = await providers.probe(provider.id, model.id);
          probe.textContent = result.ok
            ? t('Tools: {answer}', { answer: result.supports_tools })
            : errorText(result.code);
        } catch (error) {
          probe.textContent = failureText(error);
        }
      });
      row.append(probe);
    }
    row.append(
      action(
        document,
        t('Use'),
        () => void choose(provider, model.id, model.kind),
      ),
    );
    return row;
  }

  /**
   * Choose a provider and model (D6): consent first for a non-local provider,
   * and a confirmation before an existing history goes to a new provider.
   */
  /** A model's kind from its provider's list (loaded once for Ollama, which
   * is local and cheap to ask); an API provider's own kind otherwise. */
  async function kindOf(provider, modelId) {
    if (provider.id === 'ollama' && !models.get(provider.id)?.list?.length)
      await loadModels(provider);
    const listed = models.get(provider.id)?.list?.find((m) => m.id === modelId);
    return listed?.kind || provider.kind;
  }

  async function choose(provider, modelId, modelKind = null) {
    const selected = snapshot?.selection?.provider || 'ollama';
    // The model decides: an Ollama provider is local, its :cloud models are not.
    const kind = modelKind || (await kindOf(provider, modelId));
    // The conversation already goes there only when the same provider is
    // selected and, for Ollama, the current model is not a local one.
    const current = snapshot?.selection?.model;
    const sameDestination =
      provider.id === selected &&
      (provider.id !== 'ollama' ||
        (Boolean(current) && (await kindOf(provider, current)) !== 'local'));
    if (kind !== 'local' && !provider.consent) {
      if (!(await askConsent(provider))) return false;
      try {
        await providers.setConsent(provider.id, true);
      } catch (error) {
        say(failureText(error));
        return false;
      }
    } else if (kind !== 'local' && !sameDestination && historyLength() > 0) {
      const sure = await confirmDialog({
        document,
        title: t('Send this conversation to {provider}?', {
          provider: provider.label,
        }),
        intro: t(
          'The conversation so far goes to {provider} with your next question.',
          {
            provider: provider.label,
          },
        ),
        confirmLabel: t('Switch'),
        host: view.ownerDocument.body,
      });
      if (!sure) return false;
    }
    try {
      await providers.select(provider.id, modelId);
      await refresh(); // clears the message line, so say it afterwards
      say(
        t('Now using {model} on {provider}.', {
          model: modelId,
          provider: provider.label,
        }),
      );
      onSelected();
      return true;
    } catch (error) {
      say(failureText(error));
      return false;
    }
  }

  function render() {
    if (!current && snapshot)
      current = snapshot.selection?.provider || 'ollama';
    renderPolicy();
    renderList();
    renderDetail();
  }

  async function show() {
    view.hidden = false;
    await refresh();
    const provider = byId(current);
    if (provider && !models.has(provider.id)) void loadModels(provider);
    back.focus();
  }

  function hide() {
    view.hidden = true;
    view.dispatchEvent(
      new CustomEvent('spectre-nc-settings-closed', { bubbles: true }),
    );
  }

  return {
    element: view,
    show,
    hide,
    refresh,
    choose: async (providerId, modelId) => {
      if (!snapshot) await refresh();
      const provider = byId(providerId);
      return provider ? choose(provider, modelId) : false;
    },
    askConsent: async (providerId) => {
      if (!snapshot) await refresh();
      const provider = byId(providerId);
      if (!provider || !(await askConsent(provider))) return false;
      await providers.setConsent(provider.id, true);
      await refresh();
      return true;
    },
    favourites: () => favourites,
    snapshot: () => snapshot,
  };
}
