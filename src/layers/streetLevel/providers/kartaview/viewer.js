import {
  createPanoramaRenderer,
  PANO_FOV_DEFAULT_DEG,
  wrapDegrees,
} from './panorama.js';
import {
  FLAT_FULL_SIZE,
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
 * @param {(imageId: string) => void} [options.onStepped]   A photo opened from ‹ ›, after its pose.
 * @param {object} [options.render]   Render governor.
 * @param {(url: string, options?: object) => Promise<HTMLImageElement>} [options.load]
 * @param {(canvas: HTMLCanvasElement) => object} [options.createRenderer]
 * @returns {import('../../registry.js').ViewerAdapter}
 */
export function createKartaViewViewer({
  getPhoto,
  step,
  onStepped = () => {},
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

  /** Step along the sequence from the open photo. */
  async function stepBy(delta) {
    const from = photo;
    if (!from?.sequenceId || !showing) return;
    const seq = openSeq;
    let nextId = null;
    try {
      nextId = await step(from, delta);
    } catch {
      nextId = null;
    }
    if (seq !== openSeq || photo !== from) return;
    if (!nextId) {
      const button = delta < 0 ? prevButton : nextButton;
      if (button) button.disabled = true;
      return;
    }
    try {
      await adapter.open(nextId, { keepView: true });
    } catch {
      return;
    }
    if (photo?.id === nextId) onStepped(nextId);
  }

  function onPointerDown(event) {
    if (showing !== 'pano' || event.button !== 0) return;
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      view: renderer.getView(),
    };
    canvas.setPointerCapture?.(event.pointerId);
    canvas.classList.add('sl-kv-dragging');
  }

  function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.id) return;
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
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    canvas.classList.remove('sl-kv-dragging');
  }

  function onWheel(event) {
    if (showing !== 'pano') return;
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
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      stepBy(event.key === 'ArrowLeft' ? -1 : 1);
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
    root = doc.createElement('div');
    root.className = 'sl-kv-viewer';
    root.tabIndex = 0;
    root.setAttribute('role', 'group');
    root.setAttribute(
      'aria-label',
      'KartaView photo. Drag to look around a 360° photo; ← and → step along the sequence',
    );
    picture = doc.createElement('img');
    picture.className = 'sl-kv-photo';
    picture.alt = 'KartaView street-level photo';
    picture.draggable = false;
    picture.hidden = true;
    canvas = doc.createElement('canvas');
    canvas.className = 'sl-kv-pano';
    canvas.hidden = true;
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
    listen(canvas, 'pointerdown', onPointerDown);
    listen(canvas, 'pointermove', onPointerMove);
    listen(canvas, 'pointerup', onPointerUp);
    listen(canvas, 'pointercancel', onPointerUp);
    listen(canvas, 'wheel', onWheel, { passive: false });
    listen(root, 'keydown', onKeyDown);
    applyRenderMode();
  }

  function teardown() {
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
    const preview = resizedImageUrl(target.urls.pano, PANO_PREVIEW_SIZE);
    let image;
    try {
      image = await load(preview, { crossOrigin: true });
    } catch {
      image = await load(resizedImageUrl(target.urls.pano, PANO_FULL_SIZE), {
        crossOrigin: true,
      });
    }
    if (seq !== openSeq) return false;
    if (!keepView || showing !== 'pano')
      renderer.setView({ yaw: 0, pitch: 0, fov: PANO_FOV_DEFAULT_DEG });
    renderer.setImage(image);
    photo = target;
    show('pano');
    return true;
  }

  async function showFlat(target, seq) {
    let image;
    try {
      image = await load(target.urls.view, { crossOrigin: false });
    } catch (error) {
      // No 1280 px rendition: the proxy can shrink the full-size photo.
      const fallback = resizedImageUrl(target.urls.full, FLAT_FULL_SIZE);
      if (target.isPano || !fallback || seq !== openSeq) throw error;
      image = await load(fallback, { crossOrigin: false });
    }
    if (seq !== openSeq) return false;
    picture.src = image.src;
    photo = target;
    show('flat');
    return true;
  }

  const adapter = {
    async mount(host) {
      if (!host) throw new Error('Street Level viewer has no host element');
      if (root && root.parentNode === host) return;
      teardown();
      build(host);
    },

    /** Resolves once the photo is on screen and its pose was emitted. */
    async open(imageId, { keepView = false } = {}) {
      if (!root) throw new Error('KartaView viewer is not mounted');
      const seq = ++openSeq;
      const target = await getPhoto(String(imageId));
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
      upgrade(target, seq, showing);
    },

    close() {
      openSeq++;
      photo = null;
      show(null);
      if (picture) picture.removeAttribute('src');
      renderer?.clear?.();
    },

    unmount() {
      openSeq++;
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
