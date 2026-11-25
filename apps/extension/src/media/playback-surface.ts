import { visiblePlaybackArea } from './playback-order';

function rendered(element: Element): boolean {
  for (let current: Element | null = element; current; ) {
    const style = getComputedStyle(current);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      Number.parseFloat(style.opacity) === 0
    )
      return false;
    const root = current.getRootNode();
    current =
      current.assignedSlot ??
      current.parentElement ??
      (root instanceof ShadowRoot ? root.host : null);
  }
  return true;
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
  let hits = 0;
  for (const fraction of [0.25, 0.5, 0.75]) {
    const x = left + (right - left) * fraction,
      y = top + (bottom - top) / 2;
    if (
      scopes.every(({ root, target }) => {
        const stack = root.elementsFromPoint?.(x, y);
        // The zero-opacity decoder itself often receives the player's clicks.
        return stack?.find((item) => item !== decoder) === target;
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
  for (let depth = 0; scope && depth < 4; depth++, scope = scope.parentElement) {
    if (scope === document.body || scope === document.documentElement) return;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
    let canvas: HTMLCanvasElement | undefined;
    const artwork: Element[] = [];
    let visited = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (++visited > 96) return;
      if (node instanceof HTMLImageElement || node instanceof SVGSVGElement) artwork.push(node);
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
        artwork.some((layer) => couldCoverCanvas(layer, rect))
      )
        return;
      return exposedCanvas(canvas, rect, video) ? canvas : undefined;
    }
    if (scope.matches('article, [role="article"]')) return;
  }
}
