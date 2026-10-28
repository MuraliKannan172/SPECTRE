/**
 * SPECTRE: the running boot overlay, shared by the boot entry (which starts
 * it) and the application (which reports the globe and layer rows). Both
 * import this module, so they share one instance.
 */
let handle = null;

/** @param {{mark: (id: string, state: string, detail?: string) => void} | null} next */
export function setBootHandle(next) {
  handle = next;
}

/** Report one boot row; a no-op when no overlay is running. */
export function markBoot(id, state, detail = '') {
  try {
    handle?.mark(id, state, detail);
  } catch (error) {
    console.warn('[Boot] could not report', id, error);
  }
}
