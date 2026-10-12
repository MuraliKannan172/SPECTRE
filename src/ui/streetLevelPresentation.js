import { keySetupRequirementEnvVars } from '../keySetupCore.mjs';
import { formatNumber, msg, t, tn } from '../i18n/index.js';

// Street Level UI state to panel strings and flags. Pure, so it is testable.

const DAY_MS = 86_400_000;

/** SINCE slider stops, in relative days so a share link keeps its meaning. */
export const SINCE_STOPS = Object.freeze([
  Object.freeze({ days: 0, label: msg('ANY DATE') }),
  Object.freeze({ days: 3652, label: msg('LAST 10 YEARS') }),
  Object.freeze({ days: 1826, label: msg('LAST 5 YEARS') }),
  Object.freeze({ days: 1095, label: msg('LAST 3 YEARS') }),
  Object.freeze({ days: 730, label: msg('LAST 2 YEARS') }),
  Object.freeze({ days: 365, label: msg('LAST YEAR') }),
  Object.freeze({ days: 182, label: msg('LAST 6 MONTHS') }),
  Object.freeze({ days: 91, label: msg('LAST 3 MONTHS') }),
  Object.freeze({ days: 30, label: msg('LAST MONTH') }),
]);

/** The exact stop for a day count, else the nearest one. */
export function sinceStopIndex(days) {
  const value = Number(days) || 0;
  if (value <= 0) return 0;
  let best = 1;
  for (let i = 1; i < SINCE_STOPS.length; i++)
    if (
      Math.abs(SINCE_STOPS[i].days - value) <
      Math.abs(SINCE_STOPS[best].days - value)
    )
      best = i;
  return best;
}

function presentSince(days, now) {
  const value = Number(days) || 0;
  const index = sinceStopIndex(value);
  if (value <= 0) return { index, days: 0, label: t('ANY DATE') };
  const stop = SINCE_STOPS[index];
  const window =
    stop.days === value
      ? t(stop.label)
      : tn(value, 'LAST {count} DAY', 'LAST {count} DAYS');
  return {
    index,
    days: value,
    label: t('{window} · SINCE {date}', {
      window,
      date: formatDate(now - value * DAY_MS),
    }),
  };
}

function formatDate(ms) {
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toISOString().slice(0, 10);
  } catch {
    return '';
  }
}

/** The Provider Settings hint for a missing key, or '' for a hidden key. */
function keyRequirement(id) {
  const envVars = keySetupRequirementEnvVars(id);
  return envVars
    ? t('Needs {envVars} — add it in Provider Settings', { envVars })
    : '';
}

function presentStatus(state) {
  const pressed = state.enabled === true;
  const title = pressed
    ? t('Turn Street Level off')
    : t('Turn Street Level on');
  if (state.keyRejected)
    return { text: t('KEY REJECTED'), tone: 'warn', pressed, title };
  if (state.keyRequired)
    return { text: t('KEY REQUIRED'), tone: 'warn', pressed, title };
  if (state.coverage.loading)
    return { text: t('LOADING'), tone: 'busy', pressed, title };
  return pressed
    ? { text: t('ON'), tone: 'on', pressed, title }
    : { text: t('OFF'), tone: '', pressed, title };
}

/** A chip is lit only while the layer and its provider are both on. */
function presentProviders(state) {
  const enabled = state.enabled === true;
  return (state.providers || []).map((provider) => {
    const keyRequired = provider.keyRequired === true;
    const on = enabled && provider.on === true;
    let title = on
      ? t('{name} imagery on', { name: provider.name })
      : t('{name} imagery off', { name: provider.name });
    if (provider.keyRejected && provider.error)
      title = `${provider.name}: ${provider.error}`;
    else if (keyRequired && provider.requiresKeyId)
      title = `${provider.name}: ${keyRequirement(provider.requiresKeyId)}`;
    else if (provider.error) title = `${provider.name}: ${provider.error}`;
    return {
      id: provider.id,
      label: provider.label,
      color: provider.color || null,
      title,
      active: on,
      disabled: false,
      state: keyRequired
        ? 'error'
        : on && provider.loading
          ? 'loading'
          : on
            ? 'active'
            : 'idle',
      busy: on && provider.loading === true,
    };
  });
}

function presentViewer(state) {
  const { street } = state;
  const right = [];
  if (street.isPano) right.push('360°');
  if (Number.isFinite(street.bearing))
    right.push(`${Math.round(street.bearing)}°`);
  if (street.capturedAt) right.push(formatDate(street.capturedAt));
  return {
    open: street.open === true,
    loading: street.loading === true && !street.imageId,
    renderMode: street.renderMode === 'fill' ? 'fill' : 'letterbox',
    captionLeft: street.creator
      ? t('Image by {creator}', { creator: street.creator })
      : '',
    captionRight: right.join(' · '),
    link: street.externalUrl || null,
    linkLabel: street.providerLabel ? `${street.providerLabel} ↗` : '',
    follow: {
      pressed: street.follow === true,
      disabled: street.open !== true || street.followAvailable !== true,
      title:
        street.followAvailable === true
          ? t(
              'Camera follows view: move the globe camera wherever the street-level view looks',
            )
          : t(
              'Camera follow needs the Google 3D map: choose Google 3D under MAP SOURCE',
            ),
    },
  };
}

function presentMeta(state) {
  if (state.providers.length === 0)
    return state.coverage.hint ? t(state.coverage.hint) : '';
  if (!state.enabled) return t('Switch a provider on to draw its coverage.');
  if (state.sequence.selectedId)
    return state.sequence.loading
      ? t('Loading this sequence…')
      : tn(
          state.sequence.images,
          '{n} image in this sequence · Esc clears',
          '{n} images in this sequence · Esc clears',
          { n: formatNumber(state.sequence.images) },
        );
  if (state.coverage.count > 0)
    return tn(
      state.coverage.count,
      '{n} sequence in view · click a line for its photos',
      '{n} sequences in view · click a line for its photos',
      { n: formatNumber(state.coverage.count) },
    );
  return state.coverage.hint ? t(state.coverage.hint) : '';
}

/** @param {{now?: number}} [options] Clock for the SINCE readout. */
export function presentStreetLevelPanel(state, { now = Date.now() } = {}) {
  const enabled = state.enabled === true;
  const keyRequired = state.keyRequired === true;
  const filter = state.filter || { pano: 'all', sinceDays: 0 };
  // A missing key is already shown by the status and chip tooltip; only a
  // rejected key keeps its error line, since that message names the fix.
  const keyMissing = keyRequired && state.keyRejected !== true;
  return {
    enabled,
    keyRequired,
    status: presentStatus(state),
    controlsDisabled: keyRequired || state.providers.length === 0,
    providers: presentProviders(state),
    error: keyMissing
      ? null
      : state.street.error || state.coverage.error || null,
    filter: { pano: filter.pano, sinceDays: Number(filter.sinceDays) || 0 },
    since: presentSince(filter.sinceDays, now),
    legend: state.legend || [],
    viewer: presentViewer(state),
    meta: presentMeta(state),
    wantsOpen: state.street.open === true,
  };
}
