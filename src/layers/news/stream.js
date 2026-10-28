/**
 * SPECTRE: the one live connection to /api/intel/news/stream.
 *
 * Owned by the News layer and open only while the layer is on, so turning
 * the layer off leaves no background connection. A browser EventSource does
 * not retry after a non-200 answer, and the proxy answers 503 whenever the
 * intel service is down, so reconnection is ours: back off from 5 s to 60 s
 * and resume with ?last_event_id= so the server replays the gap.
 */

const MIN_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;

/**
 * @param {{
 *   url: string,
 *   eventSourceFactory?: (url: string) => EventSource,
 *   onStory: (story: object) => void,
 *   onStoryUpdate?: (story: object) => void,
 *   onState?: (state: 'connecting'|'open'|'retrying') => void,
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout,
 * }} options
 */
export function createNewsStream({
  url,
  eventSourceFactory = (target) => new EventSource(target),
  onStory,
  onStoryUpdate = () => {},
  onState = () => {},
  setTimer = (...args) => setTimeout(...args),
  clearTimer = (id) => clearTimeout(id),
}) {
  let source = null;
  let timer = null;
  let lastId = null;
  let retryMs = MIN_RETRY_MS;
  let running = false;

  const parse = (event) => {
    try {
      return JSON.parse(event.data);
    } catch {
      return null;
    }
  };

  function connect() {
    if (!running) return;
    const target =
      lastId === null
        ? url
        : `${url}?last_event_id=${encodeURIComponent(lastId)}`;
    onState('connecting');
    try {
      source = eventSourceFactory(target);
    } catch {
      scheduleRetry();
      return;
    }
    source.addEventListener('open', () => {
      retryMs = MIN_RETRY_MS;
      onState('open');
    });
    source.addEventListener('story', (event) => {
      const story = parse(event);
      if (event.lastEventId && /^\d{1,12}$/.test(event.lastEventId))
        lastId = event.lastEventId;
      if (story) onStory(story);
    });
    source.addEventListener('story_update', (event) => {
      const story = parse(event);
      if (story) onStoryUpdate(story);
    });
    source.addEventListener('ready', (event) => {
      const ready = parse(event);
      if (lastId === null && Number.isSafeInteger(ready?.latest_id))
        lastId = String(ready.latest_id);
    });
    source.addEventListener('error', () => {
      // Closed by the server, refused (503), or the network dropped: retry
      // ourselves rather than trusting EventSource's own reconnect.
      close();
      scheduleRetry();
    });
  }

  function close() {
    source?.close();
    source = null;
  }

  function scheduleRetry() {
    if (!running || timer !== null) return;
    onState('retrying');
    const delay = retryMs;
    retryMs = Math.min(MAX_RETRY_MS, retryMs * 2);
    timer = setTimer(() => {
      timer = null;
      connect();
    }, delay);
  }

  return {
    start() {
      if (running) return;
      running = true;
      retryMs = MIN_RETRY_MS;
      connect();
    },
    stop() {
      running = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
      close();
    },
    get connected() {
      return source !== null;
    },
    get lastEventId() {
      return lastId;
    },
  };
}
