import { visiblePlaybackArea } from './playback-order';

export function rendered(element: Element, within?: Element | null): boolean {
  let inScope = !within;
  for (let current: Element | null = element; current; ) {
    if (current === within) inScope = true;
    const style = getComputedStyle(current);
    if (
      style.display === 'none' ||
      (current === element && (style.visibility === 'hidden' || style.visibility === 'collapse')) ||
      Number.parseFloat(style.opacity) === 0
    )
      return false;
    const root = current.getRootNode();
    current =
      current.assignedSlot ??
      current.parentElement ??
      (root instanceof ShadowRoot ? root.host : null);
  }
  return inScope;
}

function sameBounds(a: DOMRectReadOnly, b: DOMRectReadOnly) {
  // Permit subpixel rounding between the decoder and its display surface.
  return (
    Math.abs(a.left - b.left) <= 2 &&
    Math.abs(a.top - b.top) <= 2 &&
    Math.abs(a.right - b.right) <= 2 &&
    Math.abs(a.bottom - b.bottom) <= 2
  );
}

function couldCoverCanvas(layer: Element, rect: DOMRectReadOnly) {
  // elementsFromPoint omits click-through cover art even when it is painted.
  const box = layer.getBoundingClientRect();
  return (
    box.left <= rect.left + 2 &&
    box.top <= rect.top + 2 &&
    box.right >= rect.right - 2 &&
    box.bottom >= rect.bottom - 2 &&
    getComputedStyle(layer).pointerEvents === 'none' &&
    rendered(layer)
  );
}

function hasCoveringContent(canvas: HTMLCanvasElement, hit: Element) {
  // Pseudo-elements or a negative stacking level can put paint in front of the bitmap.
  for (let layer: Element | null = canvas; layer; layer = layer.parentElement) {
    if (Number.parseFloat(getComputedStyle(layer).zIndex) < 0) return true;
    for (const pseudo of ['::before', '::after']) {
      const style = getComputedStyle(layer, pseudo);
      if (
        style.content &&
        style.content !== 'none' &&
        style.content !== 'normal' &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) !== 0
      )
        return true;
    }
    if (layer === hit) break;
  }
  return false;
}

function exposedCanvas(
  canvas: HTMLCanvasElement,
  rect: DOMRectReadOnly,
  decoder: HTMLVideoElement,
) {
  const left = Math.max(0, rect.left),
    right = Math.min(innerWidth, rect.right);
  const top = Math.max(0, rect.top),
    bottom = Math.min(innerHeight, rect.bottom);
  // Hit-test through any open shadow hosts, starting at the document so an
  // opaque sibling outside the player's shadow root also blocks the scan.
  const scopes: { root: Document | ShadowRoot; target: Element }[] = [];
  let target: Element = canvas;
  for (;;) {
    const root = target.getRootNode();
    if (!(root instanceof Document || root instanceof ShadowRoot)) return false;
    scopes.push({ root, target });
    if (root instanceof Document) break;
    target = root.host;
  }
  const clickThrough = getComputedStyle(canvas).pointerEvents === 'none';
  let hits = 0;
  for (const fraction of [0.25, 0.5, 0.75]) {
    const x = left + (right - left) * fraction,
      y = top + (bottom - top) / 2;
    if (
      scopes.every(({ root, target }) => {
        const stack = root.elementsFromPoint?.(x, y);
        // Invisible gesture controls and their descendants can still receive hits.
        const hit = stack?.find((item) => item !== decoder && (item === target || rendered(item)));
        if (hit === target) return true;
        // A canvas with pointer-events:none does not appear in the hit stack.
        // Its own player can receive clicks without painting over the child.
        return Boolean(
          target === canvas &&
            clickThrough &&
            hit &&
            hit !== document.body &&
            hit !== document.documentElement &&
            hit.contains(canvas) &&
            sameBounds(hit.getBoundingClientRect(), rect) &&
            !hasCoveringContent(canvas, hit),
        );
      })
    )
      hits++;
  }
  return hits >= 2;
}

export function playbackSurfaceFor(
  video: HTMLVideoElement,
): HTMLVideoElement | HTMLCanvasElement | undefined {
  if (!video.isConnected) return;
  const rect = video.getBoundingClientRect();
  if (visiblePlaybackArea(rect) <= 0) return;
  if (rendered(video)) return video;
  if (!(video.videoWidth && video.videoHeight)) return;

  // Search a small local player subtree, never the page or a whole feed.
  let scope = video.parentElement;
  for (let depth = 0; scope && depth < 8; depth++, scope = scope.parentElement) {
    if (scope === document.body || scope === document.documentElement) return;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
    let canvas: HTMLCanvasElement | undefined;
    const layers: Element[] = [];
    let visited = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (++visited > 96) return;
      if (node instanceof Element && node !== video) layers.push(node);
      if (
        node === video ||
        !(node instanceof HTMLCanvasElement || node instanceof HTMLVideoElement)
      )
        continue;
      if (!sameBounds(rect, node.getBoundingClientRect())) continue;
      // Even an idle decoder can be the one driving a different painted surface.
      if (node instanceof HTMLVideoElement || canvas) return;
      canvas = node;
    }
    if (canvas) {
      if (!rendered(canvas) || !canvas.width || !canvas.height) return;
      const aspectRatio = canvas.width / canvas.height / (video.videoWidth / video.videoHeight);
      if (
        Math.abs(aspectRatio - 1) > 0.05 ||
        layers.some((layer) => !layer.contains(canvas!) && couldCoverCanvas(layer, rect))
      )
        return;
      return exposedCanvas(canvas, rect, video) ? canvas : undefined;
    }
    if (scope.matches('article, [role="article"]')) return;
  }
}
