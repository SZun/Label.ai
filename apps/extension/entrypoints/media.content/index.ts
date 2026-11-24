import { mount, unmount } from 'svelte';
import { browser } from 'wxt/browser';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import OverlayRoot, { type LabelPlacement } from '../../src/components/OverlayRoot.svelte';
import { isEligiblePage, DEFAULT_SETTINGS, normalizeSettings, type LocalSettings } from '../../src/core/policy';
import { acceptsDecision, type Binding, type FramePayload, type LocalDecision } from '../../src/core/protocol';
import { BoundedQueue } from '../../src/core/queue';
import { captureImage, captureVideoFrame, sourceFor } from '../../src/media/capture';
import { readSettings, SETTINGS_KEY } from '../../src/transport/settings';
import '../../src/styles/label.scss';

interface MediaEntry {
  element: Element;
  id: string;
  source: string;
  generation: number;
  binding?: Binding;
  decision?: LocalDecision;
  visible: boolean;
  animated: boolean;
  attempted: boolean;
  frames: FramePayload[];
  frameCallback?: number;
  captureAbort?: AbortController;
}

export default defineContentScript({
  matches: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
  registration: 'runtime',
  cssInjectionMode: 'ui',
  runAt: 'document_idle',
  async main(ctx) {
    let settings: LocalSettings = { ...DEFAULT_SETTINGS };
    let ended = false;
    const entries = new Map<Element, MediaEntry>();
    const roots = new Set<Node>();
    const queue = new BoundedQueue(1, 25);
    let scheduled = false;
    let pendingScans: Element[] = [];
    const ui = await createShadowRootUi(ctx, {
      name: 'label-ai-overlay',
      position: 'inline',
      anchor: document.body,
      onMount: (container) => mount(OverlayRoot, { target: container }),
      onRemove: (app) => { if (app) void unmount(app); },
    });
    ui.mount();
    ui.shadowHost.style.cssText = 'position:fixed;inset:0;width:0;height:0;pointer-events:none;z-index:2147483646;';

    const active = () => !ended && !document.hidden && document.hasFocus()
      && isEligiblePage(location.href, settings, Boolean(document.querySelector('input[type="password"]')));

    function cancel(entry: MediaEntry) {
      queue.cancel(entry.id);
      entry.captureAbort?.abort();
      entry.captureAbort = undefined;
      if (entry.binding) void browser.runtime.sendMessage({ type: 'label-ai:cancel', requestId: entry.binding.requestId }).catch(() => {});
      if (entry.frameCallback != null && entry.element instanceof HTMLVideoElement && entry.element.cancelVideoFrameCallback) entry.element.cancelVideoFrameCallback(entry.frameCallback);
      entry.frameCallback = undefined;
      entry.binding = undefined;
      entry.frames = [];
    }

    function reset(entry: MediaEntry) {
      cancel(entry);
      entry.source = sourceFor(entry.element);
      entry.generation += 1;
      entry.attempted = false;
      entry.decision = undefined;
      entry.animated = false;
      schedule();
    }

    function place(entry: MediaEntry): LabelPlacement | null {
      if (!entry.decision || !entry.visible || !entry.element.isConnected || !active()) return null;
      if (entry.decision.expiresAt <= Date.now() || sourceFor(entry.element) !== entry.source) return null;
      const rect = entry.element.getBoundingClientRect();
      let left = Math.max(0, rect.left), top = Math.max(0, rect.top), right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
      for (let ancestor = entry.element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (/(hidden|clip|scroll|auto)/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)) {
          const clip = ancestor.getBoundingClientRect();
          left = Math.max(left, clip.left); right = Math.min(right, clip.right);
          top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom);
        }
      }
      if (right - left < 182 || bottom - top < 44 || getComputedStyle(entry.element).visibility === 'hidden') return null;
      if (document.fullscreenElement && !document.fullscreenElement.contains(ui.shadowHost)) return null;
      const placement = { key: `${entry.id}:${entry.generation}`, x: left + 8, y: top + 8, animate: !entry.animated };
      entry.animated = true;
      return placement;
    }

    function render() {
      const placements: LabelPlacement[] = [];
      for (const entry of entries.values()) {
        const placement = place(entry);
        if (placement) { if (placements.filter((p) => p.animate).length >= 2) placement.animate = false; placements.push(placement); }
      }
      ui.mounted?.setLabels(placements);
    }

    function bound(entry: MediaEntry): Binding {
      return { instanceId: entry.id, generation: entry.generation, requestId: crypto.randomUUID() };
    }

    async function submit(entry: MediaEntry, payload: object) {
      const binding = bound(entry);
      entry.binding = binding;
      const result: unknown = await browser.runtime.sendMessage({ type: 'label-ai:analyze', ...binding, ...payload });
      if (entry.binding?.requestId !== binding.requestId || !active() || !entry.element.isConnected || sourceFor(entry.element) !== entry.source) return;
      if (acceptsDecision(binding, result)) entry.decision = result;
      render();
    }

    function startVideo(entry: MediaEntry) {
      const video = entry.element as HTMLVideoElement;
      if (entry.frameCallback != null || entry.attempted || video.paused || !video.requestVideoFrameCallback) return;
      const sample = (_now: number, metadata: VideoFrameCallbackMetadata) => {
        entry.frameCallback = undefined;
        if (!active() || !entry.visible || !video.isConnected || video.paused || entry.attempted) return;
        const durationMs = video.duration * 1000;
        if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 300_000) return;
        const timestampMs = metadata.mediaTime * 1000;
        const last = entry.frames.at(-1);
        const interval = Math.max(200, durationMs / 12);
        try {
          if (!last || timestampMs - last.timestampMs >= interval) entry.frames.push(captureVideoFrame(video, timestampMs));
          if (entry.frames.length >= 12 || (entry.frames.length >= 3 && timestampMs >= durationMs - interval)) {
            entry.attempted = true;
            const frames = entry.frames;
            entry.frames = [];
            const coverage = Math.min(1, ((frames.at(-1)?.timestampMs ?? 0) - (frames[0]?.timestampMs ?? 0) + interval) / durationMs);
            queue.enqueue(entry.id, async () => { try { await submit(entry, { kind: 'video', frames, durationMs, coverage }); } catch { /* Failure renders no label. */ } });
          }
        } catch { entry.attempted = true; entry.frames = []; }
        if (!entry.attempted) entry.frameCallback = video.requestVideoFrameCallback(sample);
      };
      entry.frameCallback = video.requestVideoFrameCallback(sample);
    }

    function process() {
      scheduled = false;
      if (ended) return;
      for (const entry of entries.values()) {
        if (!entry.element.isConnected) { cancel(entry); intersection.unobserve(entry.element); resize.unobserve(entry.element); entries.delete(entry.element); continue; }
        if (sourceFor(entry.element) !== entry.source) { reset(entry); continue; }
        if (!active() || !entry.visible || entry.attempted || !entry.source) continue;
        const rect = entry.element.getBoundingClientRect();
        if (rect.width < 128 || rect.height < (entry.element instanceof HTMLVideoElement ? 90 : 128)) continue;
        if (entry.element instanceof HTMLVideoElement) { startVideo(entry); continue; }
        if (entry.element instanceof HTMLImageElement && (!entry.element.complete || !entry.element.naturalWidth)) continue;
        const accepted = queue.enqueue(entry.id, async () => {
          if (!active() || !entry.visible) { entry.attempted = false; return; }
          const generation = entry.generation;
          try {
            entry.captureAbort = new AbortController();
            const payload = await captureImage(entry.element, entry.source, entry.captureAbort.signal);
            if (generation === entry.generation && active()) await submit(entry, { kind: 'image', ...payload });
          } catch { /* Tainted canvas, unsupported media and errors remain unlabeled. */ }
          finally { entry.captureAbort = undefined; }
        });
        if (accepted) entry.attempted = true;
      }
      render();
    }

    function schedule() { if (!scheduled && !ended) { scheduled = true; ctx.requestAnimationFrame(process); } }

    const intersection = new IntersectionObserver((changes) => {
      for (const change of changes) {
        const entry = entries.get(change.target); if (!entry) continue;
        entry.visible = change.isIntersecting;
        if (!entry.visible && entry.element instanceof HTMLVideoElement) { cancel(entry); }
      }
      schedule();
    }, { threshold: 0.05 });
    const resize = new ResizeObserver(schedule);

    function register(element: Element) {
      if (entries.has(element) || entries.size >= 200 || element.closest('label-ai-overlay')) return;
      const source = sourceFor(element);
      if (!(element instanceof HTMLImageElement || element instanceof HTMLVideoElement) && !source.startsWith('data:image/')) return;
      const entry: MediaEntry = { element, id: crypto.randomUUID(), source, generation: 0, visible: false, animated: false, attempted: false, frames: [] };
      entries.set(element, entry);
      intersection.observe(element); resize.observe(element);
    }

    function scanNext() {
      if (ended) return;
      const batch = pendingScans.splice(0, 150);
      for (const node of batch) {
        if (node.closest('label-ai-overlay')) continue;
        register(node);
        if (node.shadowRoot && !roots.has(node.shadowRoot)) { roots.add(node.shadowRoot); mutation.observe(node.shadowRoot, observerOptions); pendingScans.push(...node.shadowRoot.children); }
        pendingScans.push(...node.children);
      }
      if (pendingScans.length) ctx.requestAnimationFrame(scanNext);
      schedule();
    }
    function scan(node: Element) { const empty = pendingScans.length === 0; pendingScans.push(node); if (empty) ctx.requestAnimationFrame(scanNext); }

    const observerOptions: MutationObserverInit = { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'sizes', 'style', 'class', 'poster'] };
    const mutation = new MutationObserver((changes) => {
      for (const change of changes) {
        if (change.target instanceof Element && change.target.closest('label-ai-overlay')) continue;
        if (change.type === 'attributes' && change.target instanceof Element) {
          const entry = entries.get(change.target);
          if (entry && sourceFor(change.target) !== entry.source) reset(entry);
          else register(change.target);
        }
        for (const node of change.addedNodes) if (node instanceof Element) scan(node);
      }
      schedule();
    });
    mutation.observe(document.body, observerOptions);
    roots.add(document.body);

    for (const event of ['load', 'loadedmetadata', 'emptied', 'seeking']) ctx.addEventListener(document, event, (ev) => {
      if (!(ev.target instanceof Element)) return;
      const entry = entries.get(ev.target); if (entry) reset(entry);
    }, { capture: true });
    ctx.addEventListener(document, 'play', schedule, { capture: true });
    ctx.addEventListener(document, 'visibilitychange', () => {
      if (!active()) { queue.clear(); for (const entry of entries.values()) { cancel(entry); if (!entry.decision) entry.attempted = false; } }
      schedule();
    });
    ctx.addEventListener(window, 'focus', schedule);
    ctx.addEventListener(window, 'blur', schedule);
    ctx.addEventListener(window, 'scroll', schedule, { passive: true, capture: true });
    ctx.addEventListener(window, 'resize', schedule, { passive: true });
    ctx.addEventListener(window, 'popstate', schedule);
    ctx.addEventListener(window, 'hashchange', schedule);
    ctx.setInterval(schedule, 1000); // Expiry and SPA URL admission only; no whole-document rescans.
    const settingsChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'local' || !changes[SETTINGS_KEY]) return;
      settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
      for (const entry of entries.values()) { cancel(entry); entry.decision = undefined; entry.attempted = false; }
      schedule();
    };
    browser.storage.onChanged.addListener(settingsChanged);
    settings = await readSettings();
    scan(document.body);
    ctx.onInvalidated(() => {
      ended = true;
      queue.clear(); for (const entry of entries.values()) cancel(entry);
      entries.clear(); roots.clear(); pendingScans = [];
      mutation.disconnect(); intersection.disconnect(); resize.disconnect();
      browser.storage.onChanged.removeListener(settingsChanged);
      ui.remove();
    });
  },
});
