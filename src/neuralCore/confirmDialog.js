/**
 * SPECTRE Neural Core: a small modal confirmation, used for consent to a
 * non-local provider and for sending the history to a newly chosen one
 * (ADR-002 D6). Keyboard-first: focus starts on Cancel, Tab stays inside,
 * Escape cancels, and focus returns where it was.
 */
import { t } from '../i18n/index.js';

let opened = 0;

/**
 * @param {{document: Document, title: string, intro?: string, items?: string[],
 *   confirmLabel: string, host?: Element}} options
 * @returns {Promise<boolean>} true when confirmed
 */
export function confirmDialog({
  document,
  title,
  intro = '',
  items = [],
  confirmLabel,
  host = document.body,
}) {
  const previous = document.activeElement;
  opened += 1;
  const id = `spectre-nc-dialog-${opened}`;
  const backdrop = document.createElement('div');
  backdrop.className = 'spectre-nc-dialog-backdrop';
  const dialog = document.createElement('div');
  dialog.className = 'spectre-nc-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', `${id}-title`);
  const heading = document.createElement('h2');
  heading.id = `${id}-title`;
  heading.textContent = title;
  dialog.append(heading);
  if (intro) {
    const text = document.createElement('p');
    text.textContent = intro;
    dialog.append(text);
  }
  if (items.length) {
    const list = document.createElement('ul');
    for (const item of items) {
      const entry = document.createElement('li');
      entry.textContent = item;
      list.append(entry);
    }
    dialog.append(list);
  }
  const actions = document.createElement('div');
  actions.className = 'spectre-nc-dialog-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = t('Cancel');
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'spectre-nc-dialog-confirm';
  confirm.textContent = confirmLabel;
  actions.append(cancel, confirm);
  dialog.append(actions);
  backdrop.append(dialog);
  host.append(backdrop);
  cancel.focus();

  return new Promise((resolve) => {
    const done = (answer) => {
      backdrop.remove();
      if (previous && typeof previous.focus === 'function') previous.focus();
      resolve(answer);
    };
    cancel.addEventListener('click', () => done(false));
    confirm.addEventListener('click', () => done(true));
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) done(false);
    });
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        done(false);
      } else if (event.key === 'Tab') {
        // Two buttons: Tab and Shift+Tab move between them, never out.
        event.preventDefault();
        (document.activeElement === cancel ? confirm : cancel).focus();
      }
    });
  });
}
