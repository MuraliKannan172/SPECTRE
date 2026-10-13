import {
  createPanoramaRenderer,
  PANO_FOV_DEFAULT_DEG,
  wrapDegrees,
} from './panorama.js';
import {
  FLAT_FULL_SIZE,
  FLAT_VIEW_SIZE,
  IMAGE_TIMEOUT_MS,
  KARTAVIEW_PROVIDER_ID,
  PANO_FULL_SIZE,
  PANO_PREVIEW_SIZE,
  kartaViewPhotoUrl,
  resizedImageUrl,
} from './policy.js';

const LOAD_FAILED = 'The KartaView photo could not be loaded';

/** Load an image (CORS-clean, for WebGL) within the timeout. */
export function loadImage(
  url,
  { crossOrigin = true, timeoutMs = IMAGE_TIMEOUT_MS } = {},
) {
  return new Promise((resolve, reject) => {
    if (!url) return reject(new Error(LOAD_FAILED));
    const image = new Image();
    if (crossOrigin) image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    const timer = setTimeout(() => {
      image.src = '';
      reject(new Error(LOAD_FAILED));
    }, timeoutMs);
    image.onload = () => {
      clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      clearTimeout(timer);
      reject(new Error(LOAD_FAILED));
    };
    image.src = url;
  });
}

/**
 * Viewer adapter for KartaView photos: a flat photo in an <img>, a 360°
 * photo on a WebGL panorama (drag to look, wheel to zoom), and ‹ › to step
 * along the sequence (also ← →). Poses follow the view direction.
 *
 * @param {object} options
 * @param {(photoId: string) => Promise<object>} options.getPhoto   A normalized photo (policy.js normalizePhoto).
 * @param {(photo: object, delta: -1|1) => Promise<string|null>} options.step   The photo `delta` along the sequence, or null at its end.
 * @param {(imageId: string) => void} options.onStep   Open the photo ‹ › chose (through the core, so loading and errors show).
 * @param {(photo: object) => void} [options.onShown]   A photo is on screen.
 * @param {object} [options.render]   Render governor.
 * @param {(url: string, options?: object) => Promise<HTMLImageElement>} [options.load]
 * @param {(canvas: HTMLCanvasElement) => object} [options.createRenderer]
 * @returns {import('../../registry.js').ViewerAdapter}
 */
export function createKartaViewViewer({
  getPhoto,
  step,
  onStep,
  onShown = () => {},
  render,
  load = loadImage,
  createRenderer = createPanoramaRenderer,
}) {
  const listeners = new Set();
  let root = null;
  let picture = null;
  let canvas = null;
  let prevButton = null;
  let nextButton = null;
  let renderer = null;
  /** WebGL failed once: 360° photos show their front view instead. */
  let rendererFailed = false;
  let photo = null;
  /** What shows: 'flat', 'pano' or null. */
  let showing = null;
  let openSeq = 0;
  let renderMode = 'letterbox';
  let drag = null;
  let poseFrame = 0;
  let removeListeners = [];
  /** The document the viewer was built in (new canvases come from it). */
  let documentOf = null;
  /** The photo an open is fetching: ‹ › step on from it, not the old one. */
  let openingId = null;
  /** ‹ › chose this photo: keep the panorama's look direction for it. */
  let keepViewFor = null;
  /** ‹ › presses run one after another, each from where the last one went. */
  let steps = Promise.resolve();

  function requestRender() {
    render?.governorRequestRender?.('kartaview-viewer');
  }

  function emit() {
    if (!photo || !showing) return;
    const view = showing === 'pano' ? renderer.getView() : null;
    const heading = photo.heading;
    const pose = {
      providerId: KARTAVIEW_PROVIDER_ID,
      imageId: photo.id,
      position: { lon: photo.lon, lat: photo.lat },
      bearing:
        heading === null
          ? null
          : view
            ? wrapDegrees(heading + view.yaw)
            : heading,
      tilt: view ? view.pitch : 0,
      altitude: null,
      isPano: showing === 'pano',
      capturedAt: photo.capturedAt,
      capturedAtPrecision: 'day',
      // KartaView's only place name is the sequence's, where the drive began.
      title: null,
      creator: null,
      sequenceId: photo.sequenceId,
      externalUrl: kartaViewPhotoUrl(photo),
    };
    for (const listener of [...listeners]) {
      try {
        listener(pose);
      } catch {
        /* listener errors are the core's to log */
      }
    }
    requestRender();
  }

  /** Re-emit on the next frame: a drag moves the view many times a frame. */
  function emitSoon() {
    if (poseFrame) return;
    poseFrame = requestAnimationFrame(() => {
      poseFrame = 0;
      emit();
    });
  }

  function syncButtons() {
    const enabled = Boolean(photo?.sequenceId) && showing !== null;
    if (prevButton) prevButton.disabled = !enabled;
    if (nextButton) nextButton.disabled = !enabled;
    if (enabled) checkEnds(photo);
  }

  /** Disable ‹ or › at once where the sequence ends (it also warms the neighbours). */
  function checkEnds(target) {
    for (const [delta, button] of [
      [-1, prevButton],
      [1, nextButton],
    ])
      step(target, delta).then(
        (id) => {
          if (photo === target && button && !id) disable(button);
        },
        () => {},
      );
  }

  /** Disable a step button, keeping keyboard focus in the viewer. */
  function disable(button) {
    if (button.ownerDocument?.activeElement === button) root?.focus?.();
    button.disabled = true;
  }

  function show(kind) {
    showing = kind;
    if (picture) picture.hidden = kind !== 'flat';
    if (canvas) canvas.hidden = kind !== 'pano';
    if (root) root.dataset.kind = kind || '';
    syncButtons();
  }

  function applyRenderMode() {
    if (picture)
      picture.style.objectFit = renderMode === 'fill' ? 'cover' : 'contain';
  }

  function ensureRenderer() {
    if (renderer || rendererFailed || !canvas) return renderer;
    try {
      renderer = createRenderer(canvas);
    } catch {
      rendererFailed = true;
      renderer = null;
    }
    return renderer;
  }

  /**
   * A lost WebGL context (GPU reset, memory pressure) takes the panorama
   * with it: drop the renderer, and show the photo again on a new one.
   */
  function onContextLost(event) {
    event.preventDefault?.();
    const lost = renderer;
    renderer = null;
    try {
      lost?.destroy();
    } catch {
      /* already gone */
    }
    // A lost canvas hands back its lost context: draw on a new element.
    const fresh = makeCanvas(documentOf);
    fresh.hidden = canvas.hidden;
    canvas.replaceWith?.(fresh);
    canvas = fresh;
    // Show the photo again through the core, unless a newer one is opening.
    if (showing === 'pano' && photo && openingId === null) {
      const again = photo.id;
      show(null);
      keepViewFor = again;
      openingId = again;
      onStep(again);
    }
  }

  /** The panorama canvas, wired for drag, pinch, wheel and context loss. */
  function makeCanvas(doc) {
    const element = doc.createElement('canvas');
    element.className = 'sl-kv-pano';
    element.hidden = true;
    listen(element, 'pointerdown', onPointerDown);
    listen(element, 'pointermove', onPointerMove);
    listen(element, 'pointerup', onPointerUp);
    listen(element, 'pointercancel', onPointerUp);
    listen(element, 'wheel', onWheel, { passive: false });
    listen(element, 'webglcontextlost', onContextLost);
    return element;
  }

  /**
   * Step along the sequence from the photo showing, or from the one on its
   * way after an earlier press, and open it through the core.
   */
  function stepBy(delta) {
    steps = steps.then(async () => {
      const fromId = openingId ?? photo?.id;
      if (!fromId || !root) return;
      let from;
      let nextId = null;
      try {
        from = await getPhoto(fromId);
        if (from.sequenceId) nextId = await step(from, delta);
      } catch {
        // Not the end of the sequence, just no answer: the press is lost.
        return;
      }
      // Closed, or another photo was opened meanwhile.
      if ((openingId ?? photo?.id) !== fromId) return;
      if (!nextId) {
        const button = delta < 0 ? prevButton : nextButton;
        if (button && photo?.id === fromId) disable(button);
        return;
      }
      openingId = nextId;
      keepViewFor = nextId;
      onStep(nextId);
    });
  }

  /** Pointers on the panorama: one drags the view, two pinch the zoom. */
  const pointers = new Map();
  let pinch = null;

  function pinchSpan() {
    const [a, b] = [...pointers.values()];
    return Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
  }

  function onPointerDown(event) {
    if (showing !== 'pano' || !renderer) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    canvas.setPointerCapture?.(event.pointerId);
    if (pointers.size === 2) {
      drag = null;
      pinch = { span: pinchSpan(), fov: renderer.getView().fov };
      return;
    }
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      view: renderer.getView(),
    };
    canvas.classList.add('sl-kv-dragging');
  }

  function onPointerMove(event) {
    if (pointers.has(event.pointerId))
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && pointers.size === 2 && renderer) {
      renderer.setView({ fov: pinch.fov * (pinch.span / pinchSpan()) });
      return;
    }
    if (!drag || event.pointerId !== drag.id || !renderer) return;
    const { fov } = drag.view;
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    const vertical = fov;
    const horizontal = fov * (width / height);
    renderer.setView({
      yaw: drag.view.yaw - ((event.clientX - drag.x) / width) * horizontal,
      pitch: drag.view.pitch + ((event.clientY - drag.y) / height) * vertical,
    });
    emitSoon();
  }

  function onPointerUp(event) {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    canvas.classList.remove('sl-kv-dragging');
  }

  function onWheel(event) {
    if (showing !== 'pano' || !renderer) return;
    event.preventDefault();
    const { fov } = renderer.getView();
    renderer.setView({ fov: fov * Math.exp(event.deltaY * 0.001) });
  }

  function onKeyDown(event) {
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    const pano = showing === 'pano' && renderer;
    const turn = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    // Shift+← → look around a panorama; ← → step along the sequence.
    if (turn && event.shiftKey && pano) {
      event.preventDefault();
      const { yaw, fov } = renderer.getView();
      renderer.setView({ yaw: yaw + (turn * fov) / 4 });
      emitSoon();
    } else if (turn) {
      event.preventDefault();
      stepBy(turn);
    } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && pano) {
      event.preventDefault();
      const { pitch, fov } = renderer.getView();
      renderer.setView({
        pitch: pitch + ((event.key === 'ArrowUp' ? 1 : -1) * fov) / 6,
      });
      emitSoon();
    } else if (['+', '=', '-', '_'].includes(event.key) && pano) {
      event.preventDefault();
      const { fov } = renderer.getView();
      renderer.setView({
        fov: fov * (event.key === '+' || event.key === '=' ? 0.85 : 1 / 0.85),
      });
    }
  }

  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    removeListeners.push(() =>
      target.removeEventListener(type, handler, options),
    );
  }

  function build(host) {
    const doc = host.ownerDocument;
    documentOf = doc;
    root = doc.createElement('div');
    root.className = 'sl-kv-viewer';
    root.tabIndex = 0;
    root.setAttribute('role', 'group');
    root.setAttribute(
      'aria-label',
      'KartaView photo. ← and → step along the sequence. On a 360° photo, drag or use Shift+← →, ↑ ↓ to look around, and + − to zoom',
    );
    picture = doc.createElement('img');
    picture.className = 'sl-kv-photo';
    picture.alt = 'KartaView street-level photo';
    picture.draggable = false;
    picture.hidden = true;
    canvas = makeCanvas(doc);
    const nav = (label, glyph, delta) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = `sl-kv-step sl-kv-step-${delta < 0 ? 'prev' : 'next'}`;
      button.textContent = glyph;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.disabled = true;
      listen(button, 'click', (event) => {
        event.stopPropagation();
        stepBy(delta);
      });
      return button;
    };
    prevButton = nav('Previous photo in this sequence (←)', '‹', -1);
    nextButton = nav('Next photo in this sequence (→)', '›', 1);
    root.append(picture, canvas, prevButton, nextButton);
    host.append(root);
    listen(root, 'keydown', onKeyDown);
    applyRenderMode();
  }

  function teardown() {
    pointers.clear();
    pinch = null;
    for (const remove of removeListeners) remove();
    removeListeners = [];
    if (poseFrame) cancelAnimationFrame(poseFrame);
    poseFrame = 0;
    drag = null;
    renderer?.destroy();
    renderer = null;
    root?.remove();
    root = picture = canvas = prevButton = nextButton = null;
    showing = null;
    photo = null;
  }

  /** A sharper version once the first is on screen, if nothing replaced it. */
  async function upgrade(target, seq, kind) {
    // A 360° photo shown flat (no WebGL) keeps its front view.
    if (kind === 'flat' && target.isPano) return;
    const url =
      kind === 'pano'
        ? resizedImageUrl(target.urls.pano, PANO_FULL_SIZE)
        : resizedImageUrl(target.urls.full, FLAT_FULL_SIZE);
    if (!url) return;
    try {
      const image = await load(url, { crossOrigin: kind === 'pano' });
      if (seq !== openSeq || photo !== target || showing !== kind) return;
      if (kind === 'pano') renderer.setImage(image);
      else picture.src = image.src;
      requestRender();
    } catch {
      /* the first version stays */
    }
  }

  async function showPano(target, seq, keepView) {
    // Only the proxy can shrink a 13,000 px panorama: if it fails, the
    // caller shows the front view rather than waiting on it twice.
    const image = await load(
      resizedImageUrl(target.urls.pano, PANO_PREVIEW_SIZE),
      { crossOrigin: true },
    );
    if (seq !== openSeq || !renderer) return false;
    if (!keepView || showing !== 'pano')
      renderer.setView({ yaw: 0, pitch: 0, fov: PANO_FOV_DEFAULT_DEG });
    photo = target;
    // Shown first: a hidden canvas measures 0 and would be sized 1×1.
    show('pano');
    renderer.setImage(image);
    return true;
  }

  async function showFlat(target, seq) {
    // The proxy's 1,280 px version is a few hundred kB; KartaView's own
    // "large thumbnail" can be 1.7 MB. Either serves when the other fails.
    // A 360° photo's front view is only on storage.
    const proxied = target.isPano
      ? null
      : resizedImageUrl(target.urls.full, FLAT_VIEW_SIZE);
    const sources = [proxied, target.urls.view].filter(Boolean);
    let image;
    let failure = null;
    for (const url of sources) {
      try {
        image = await load(url, { crossOrigin: false });
        break;
      } catch (error) {
        failure = error;
        if (seq !== openSeq) return false;
      }
    }
    if (!image) throw failure || new Error(LOAD_FAILED);
    if (seq !== openSeq) return false;
    picture.src = image.src;
    photo = target;
    show('flat');
    return true;
  }

  async function openPhoto(id, seq, keepView) {
    const target = await getPhoto(id);
    if (seq !== openSeq) return;
    let shown = false;
    if (target.isPano && target.urls.pano && ensureRenderer()) {
      try {
        shown = await showPano(target, seq, keepView);
      } catch {
        // The panorama failed: its front view is better than nothing.
        if (seq !== openSeq) return;
        shown = await showFlat(target, seq);
      }
    } else shown = await showFlat(target, seq);
    if (!shown) return;
    emit();
    onShown(target);
    upgrade(target, seq, showing);
  }

  const adapter = {
    async mount(host) {
      if (!host) throw new Error('Street Level viewer has no host element');
      if (root && root.parentNode === host) return;
      teardown();
      rendererFailed = false;
      build(host);
    },

    /** Resolves once the photo is on screen and its pose was emitted. */
    async open(imageId) {
      if (!root) throw new Error('KartaView viewer is not mounted');
      const id = String(imageId);
      const seq = ++openSeq;
      const keepView = keepViewFor === id;
      keepViewFor = null;
      openingId = id;
      try {
        await openPhoto(id, seq, keepView);
      } finally {
        if (openingId === id && seq === openSeq) openingId = null;
      }
    },

    close() {
      openSeq++;
      openingId = null;
      keepViewFor = null;
      photo = null;
      show(null);
      if (picture) picture.removeAttribute('src');
      renderer?.clear?.();
    },

    unmount() {
      openSeq++;
      openingId = null;
      keepViewFor = null;
      teardown();
    },

    resize() {
      renderer?.resize();
    },

    /** FIT / FILL frame a flat photo; a panorama has no frame to fit. */
    supportsRenderModes: () => showing !== 'pano',

    setRenderMode(mode) {
      renderMode = mode === 'fill' ? 'fill' : 'letterbox';
      applyRenderMode();
    },

    onPose(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return adapter;
}
