import { mount, unmount } from 'svelte';
import { browser } from 'wxt/browser';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import OverlayRoot, { type LabelPlacement } from '../../src/components/OverlayRoot.svelte';
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type LocalSettings,
  eligibleDocumentChain,
} from '../../src/core/policy';
import {
  acceptsDecision,
  type Binding,
  type FramePayload,
  type LocalDecision,
} from '../../src/core/protocol';
import { BoundedQueue } from '../../src/core/queue';
import { CaptureSlots } from '../../src/core/capture-slots';
import { ScanningPermission } from '../../src/core/scanning-permission';
import { RetryBudget, retryableReply } from '../../src/core/retry';
import { captureImage, captureVideoFrame, sourceFor } from '../../src/media/capture';
import { acquireVideoOriginal } from '../../src/media/video-original';
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
  retry: RetryBudget;
  originalAttempted: boolean;
  frames: FramePayload[];
  frameCallback?: number;
  captureAbort?: AbortController;
  captureTimer?: ReturnType<typeof setTimeout>;
  captureLease?: string;
}

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  registration: 'runtime',
  cssInjectionMode: 'ui',
  runAt: 'document_idle',
  async main(ctx) {
    if (browser.extension?.inIncognitoContext !== false) return;
    const scannerPresent = (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'label-ai:scanner-present'
      )
        return Promise.resolve({ present: true });
    };
    browser.runtime.onMessage.addListener(scannerPresent);
    ctx.onInvalidated(() => browser.runtime.onMessage.removeListener(scannerPresent));

    let settings: LocalSettings = { ...DEFAULT_SETTINGS, enabled: false };
    const permission = new ScanningPermission(() =>
      browser.runtime.sendMessage({ type: 'label-ai:can-scan' }),
    );
    let ended = false;
    const entries = new Map<Element, MediaEntry>();
    const roots = new WeakSet<Node>();
    const observed = new WeakSet<Element>();
    const animatedSources = new WeakMap<Element, string>();
    const queue = new BoundedQueue(1, 25);
    const videoCaptures = new CaptureSlots(1);
    let scheduled = false;
    let pendingScans: Element[] = [];
    const ui = await createShadowRootUi(ctx, {
      name: 'label-ai-overlay',
      position: 'inline',
      anchor: document.body,
      onMount: (container) => mount(OverlayRoot, { target: container }),
      onRemove: (app) => {
        if (app) void unmount(app);
      },
    });
    if (ctx.isInvalid) {
      ui.remove();
      return;
    }
    ui.mount();
    ui.shadowHost.style.cssText =
      'position:fixed;inset:0;width:0;height:0;pointer-events:none;z-index:2147483646;';

    const eligible = () =>
      !ended && !document.hidden && document.hasFocus() && eligibleDocumentChain(window, settings);
    const active = () => eligible() && permission.allowed;

    function refreshPermission() {
      if (!eligible()) {
        permission.invalidate();
        return;
      }
      void permission.refresh().then(() => {
        if (!active()) suspend();
        schedule();
      });
    }

    function cancel(entry: MediaEntry) {
      queue.cancel(entry.id);
      // Keep the capture lease until a running inference releases its frame buffers.
      if (!queue.has(entry.id) && entry.captureLease) {
        videoCaptures.release(entry.captureLease);
        entry.captureLease = undefined;
      }
      if (entry.captureTimer !== undefined) clearTimeout(entry.captureTimer);
      entry.captureTimer = undefined;
      entry.captureAbort?.abort();
      entry.captureAbort = undefined;
      if (entry.binding)
        void browser.runtime
          .sendMessage({ type: 'label-ai:cancel', requestId: entry.binding.requestId })
          .catch(() => {});
      if (
        entry.frameCallback != null &&
        entry.element instanceof HTMLVideoElement &&
        entry.element.cancelVideoFrameCallback
      )
        entry.element.cancelVideoFrameCallback(entry.frameCallback);
      entry.frameCallback = undefined;
      entry.binding = undefined;
      entry.frames = [];
    }

    function suspendEntry(entry: MediaEntry) {
      const pending =
        queue.has(entry.id) || entry.binding || entry.captureAbort || entry.frameCallback != null;
      cancel(entry);
      if (pending && !entry.decision) {
        entry.attempted = false;
        entry.originalAttempted = false;
      }
    }

    function suspend() {
      for (const entry of entries.values()) suspendEntry(entry);
      queue.clear();
      render();
    }

    function reset(entry: MediaEntry) {
      cancel(entry);
      entry.source = sourceFor(entry.element);
      entry.generation += 1;
      entry.attempted = false;
      entry.originalAttempted = false;
      entry.decision = undefined;
      entry.retry.reset();
      entry.animated = animatedSources.get(entry.element) === entry.source;
      schedule();
    }

    function shown(element: Element): boolean {
      // IntersectionObserver alone may report transparent or hidden media as intersecting.
      for (let current: Element | null = element; current; ) {
        const style = getComputedStyle(current);
        if (
          style.visibility === 'hidden' ||
          style.visibility === 'collapse' ||
          style.display === 'none' ||
          Number.parseFloat(style.opacity) === 0
        )
          return false;
        const root = current.getRootNode();
        current = current.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
      }
      return true;
    }

    function place(entry: MediaEntry): LabelPlacement | null {
      if (!entry.decision || !entry.visible || !entry.element.isConnected || !active()) return null;
      if (entry.decision.expiresAt <= Date.now() || sourceFor(entry.element) !== entry.source)
        return null;
      const rect = entry.element.getBoundingClientRect();
      let left = Math.max(0, rect.left),
        top = Math.max(0, rect.top),
        right = Math.min(innerWidth, rect.right),
        bottom = Math.min(innerHeight, rect.bottom);
      for (
        let ancestor = entry.element.parentElement;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        const style = getComputedStyle(ancestor);
        if (
          /(hidden|clip|scroll|auto)/.test(
            `${style.overflow} ${style.overflowX} ${style.overflowY}`,
          )
        ) {
          const clip = ancestor.getBoundingClientRect();
          left = Math.max(left, clip.left);
          right = Math.min(right, clip.right);
          top = Math.max(top, clip.top);
          bottom = Math.min(bottom, clip.bottom);
        }
      }
      if (right - left < 182 || bottom - top < 44 || !shown(entry.element)) return null;
      if (document.fullscreenElement && !document.fullscreenElement.contains(ui.shadowHost))
        return null;
      const placement = {
        key: `${entry.id}:${entry.generation}`,
        x: left + 8,
        y: top + 8,
        animate: !entry.animated,
      };
      entry.animated = true;
      animatedSources.set(entry.element, entry.source);
      return placement;
    }

    function render() {
      const placements: LabelPlacement[] = [];
      for (const entry of entries.values()) {
        const placement = place(entry);
        if (placement) {
          if (placements.filter((p) => p.animate).length >= 2) placement.animate = false;
          placements.push(placement);
        }
      }
      ui.mounted?.setLabels(placements);
    }

    function bound(entry: MediaEntry): Binding {
      return { instanceId: entry.id, generation: entry.generation, requestId: crypto.randomUUID() };
    }

    async function submit(entry: MediaEntry, payload: object) {
      const binding = bound(entry);
      entry.binding = binding;
      let result: unknown;
      let interrupted = false;
      try {
        result = await browser.runtime.sendMessage({
          type: 'label-ai:analyze',
          ...binding,
          ...payload,
        });
      } catch {
        // A browser can suspend or restart the extension worker mid-message.
        interrupted = true;
      }
      if (entry.binding?.requestId !== binding.requestId) return;
      entry.binding = undefined;
      if (
        !active() ||
        !entry.visible ||
        !shown(entry.element) ||
        !entry.element.isConnected ||
        sourceFor(entry.element) !== entry.source
      )
        return;
      if (acceptsDecision(binding, result)) entry.decision = result;
      else if (interrupted || result === undefined || retryableReply(binding, result)) retry(entry);
      render();
    }

    function retry(entry: MediaEntry) {
      if (entry.retry.defer()) {
        entry.attempted = false;
        entry.originalAttempted = false;
      }
    }

    function startVideo(entry: MediaEntry) {
      const video = entry.element as HTMLVideoElement;
      if (
        entry.frameCallback != null ||
        entry.captureLease ||
        entry.attempted ||
        video.paused ||
        !video.requestVideoFrameCallback
      )
        return;
      const generation = entry.generation;
      const captureLease = `${entry.id}:${generation}:${crypto.randomUUID()}`;
      if (!videoCaptures.acquire(captureLease)) return;
      entry.captureLease = captureLease;
      entry.captureTimer = setTimeout(() => {
        if (entry.generation !== generation) return;
        cancel(entry);
        entry.attempted = true;
        schedule();
      }, 20_000);
      const sample = (_now: number, metadata: VideoFrameCallbackMetadata) => {
        entry.frameCallback = undefined;
        if (entry.generation !== generation || entry.captureLease !== captureLease) return;
        if (
          !active() ||
          !entry.visible ||
          !shown(video) ||
          !video.isConnected ||
          video.paused ||
          entry.attempted
        ) {
          suspendEntry(entry);
          return;
        }
        const durationMs = video.duration * 1000;
        if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 300_000) {
          cancel(entry);
          entry.attempted = true;
          return;
        }
        const timestampMs = metadata.mediaTime * 1000;
        const last = entry.frames.at(-1);
        const interval = Math.min(1000, Math.max(200, durationMs / 12));
        try {
          if (!last || timestampMs - last.timestampMs >= interval)
            entry.frames.push(captureVideoFrame(video, timestampMs));
          if (
            entry.frames.length >= 12 ||
            (entry.frames.length >= 3 && timestampMs >= durationMs - interval)
          ) {
            entry.attempted = true;
            if (entry.captureTimer !== undefined) clearTimeout(entry.captureTimer);
            entry.captureTimer = undefined;
            const frames = entry.frames;
            entry.frames = [];
            const coverage = Math.min(
              1,
              ((frames.at(-1)?.timestampMs ?? 0) - (frames[0]?.timestampMs ?? 0) + interval) /
                durationMs,
            );
            const queued = queue.enqueue(entry.id, async () => {
              try {
                if (
                  entry.generation === generation &&
                  entry.captureLease === captureLease &&
                  active() &&
                  entry.visible &&
                  shown(entry.element) &&
                  sourceFor(entry.element) === entry.source
                )
                  await submit(entry, { kind: 'video', frames, durationMs, coverage });
              } catch {
                /* Failure renders no label. */
              } finally {
                videoCaptures.release(captureLease);
                if (entry.captureLease === captureLease) entry.captureLease = undefined;
                schedule();
              }
            });
            if (!queued) {
              retry(entry);
              videoCaptures.release(captureLease);
              if (entry.captureLease === captureLease) entry.captureLease = undefined;
            }
          }
        } catch {
          cancel(entry);
          entry.attempted = true;
        }
        if (!entry.attempted) entry.frameCallback = video.requestVideoFrameCallback(sample);
      };
      entry.frameCallback = video.requestVideoFrameCallback(sample);
    }

    function process() {
      scheduled = false;
      if (ended) return;
      if (!active()) {
        suspend();
        return;
      }
      for (const entry of entries.values()) {
        if (!entry.element.isConnected) {
          cancel(entry);
          intersection.unobserve(entry.element);
          observed.delete(entry.element);
          resize.unobserve(entry.element);
          entries.delete(entry.element);
          continue;
        }
        if (sourceFor(entry.element) !== entry.source) {
          reset(entry);
          continue;
        }
        if (entry.decision && entry.decision.expiresAt <= Date.now()) {
          entry.decision = undefined;
          entry.attempted = false;
          entry.originalAttempted = false;
        }
        if (entry.visible && !shown(entry.element)) {
          suspendEntry(entry);
          continue;
        }
        if (!active() || !entry.visible || entry.attempted || !entry.source || !entry.retry.ready())
          continue;
        const rect = entry.element.getBoundingClientRect();
        if (
          rect.width < 128 ||
          rect.height < (entry.element instanceof HTMLVideoElement ? 90 : 128)
        )
          continue;
        if (entry.element instanceof HTMLVideoElement) {
          if (!entry.originalAttempted && entry.element.readyState >= 1) {
            entry.originalAttempted = true;
            if (
              entry.source.startsWith('data:video/mp4;base64,') ||
              entry.source.startsWith('blob:')
            ) {
              const generation = entry.generation;
              const accepted = queue.enqueue(entry.id, async () => {
                try {
                  if (
                    active() &&
                    entry.visible &&
                    shown(entry.element) &&
                    generation === entry.generation
                  ) {
                    const controller = new AbortController();
                    entry.captureAbort = controller;
                    const original = await acquireVideoOriginal(
                      entry.element as HTMLVideoElement,
                      entry.source,
                      controller.signal,
                    );
                    if (entry.captureAbort === controller) entry.captureAbort = undefined;
                    if (
                      original &&
                      !controller.signal.aborted &&
                      active() &&
                      entry.visible &&
                      shown(entry.element) &&
                      entry.generation === generation &&
                      sourceFor(entry.element) === entry.source
                    )
                      await submit(entry, { kind: 'video', original });
                  }
                } catch {
                  /* Failed credentials remain unlabeled. */
                } finally {
                  if (generation === entry.generation && !entry.decision) {
                    entry.attempted = false;
                    schedule();
                  }
                }
              });
              if (accepted) {
                entry.attempted = true;
                continue;
              }
              entry.originalAttempted = false;
            }
          }
          startVideo(entry);
          continue;
        }
        if (
          entry.element instanceof HTMLImageElement &&
          (!entry.element.complete || !entry.element.naturalWidth)
        )
          continue;
        const accepted = queue.enqueue(entry.id, async () => {
          if (!active() || !entry.visible || !shown(entry.element)) {
            entry.attempted = false;
            return;
          }
          const generation = entry.generation;
          const controller = new AbortController();
          try {
            entry.captureAbort = controller;
            const payload = await captureImage(entry.element, entry.source, controller.signal);
            if (
              !controller.signal.aborted &&
              generation === entry.generation &&
              active() &&
              entry.visible &&
              shown(entry.element) &&
              sourceFor(entry.element) === entry.source
            )
              await submit(entry, { kind: 'image', ...payload });
          } catch {
            /* Tainted canvas, unsupported media and errors remain unlabeled. */
          } finally {
            if (entry.captureAbort === controller) entry.captureAbort = undefined;
            schedule();
          }
        });
        if (accepted) entry.attempted = true;
      }
      render();
    }

    function schedule() {
      if (!scheduled && !ended) {
        scheduled = true;
        ctx.requestAnimationFrame(process);
      }
    }

    const intersection = new IntersectionObserver(
      (changes) => {
        // A target can cross the threshold more than once before this callback.
        const visibility = new Map(
          changes.map(({ target, isIntersecting }) => [target, isIntersecting]),
        );
        // Process exits first so a visible item can reclaim a slot in the same batch.
        for (const [target, visible] of visibility) {
          const entry = entries.get(target);
          if (!entry) continue;
          entry.visible = visible;
          if (!entry.visible) suspendEntry(entry);
        }
        for (const [target, visible] of visibility) {
          if (visible && target.isConnected && !entries.has(target)) admitVisible(target);
        }
        schedule();
      },
      { threshold: 0.05 },
    );
    const resize = new ResizeObserver(schedule);

    function register(element: Element) {
      if (observed.has(element)) return;
      if (
        !(element instanceof HTMLImageElement || element instanceof HTMLVideoElement) &&
        !sourceFor(element).startsWith('data:image/')
      )
        return;
      observed.add(element);
      intersection.observe(element);
    }

    function admitVisible(element: Element) {
      if (entries.size >= 200) {
        const oldestHidden = Array.from(entries.values()).find((entry) => !entry.visible);
        if (!oldestHidden) return;
        cancel(oldestHidden);
        resize.unobserve(oldestHidden.element);
        entries.delete(oldestHidden.element);
      }
      const source = sourceFor(element);
      const entry: MediaEntry = {
        element,
        id: crypto.randomUUID(),
        source,
        generation: 0,
        visible: true,
        animated: animatedSources.get(element) === source,
        attempted: false,
        retry: new RetryBudget(),
        originalAttempted: false,
        frames: [],
      };
      entries.set(element, entry);
      resize.observe(element);
    }

    function scanNext() {
      if (ended) return;
      const batch = pendingScans.splice(0, 150);
      for (const node of batch) {
        if (node.closest('label-ai-overlay')) continue;
        if (!node.isConnected) {
          intersection.unobserve(node);
          observed.delete(node);
          if (node.shadowRoot) pendingScans.push(...node.shadowRoot.children);
          pendingScans.push(...node.children);
          continue;
        }
        register(node);
        if (node.shadowRoot) {
          if (!roots.has(node.shadowRoot)) {
            roots.add(node.shadowRoot);
            mutation.observe(node.shadowRoot, observerOptions);
          }
          pendingScans.push(...node.shadowRoot.children);
        }
        pendingScans.push(...node.children);
      }
      if (pendingScans.length) ctx.requestAnimationFrame(scanNext);
      schedule();
    }
    function scan(node: Element) {
      const empty = pendingScans.length === 0;
      pendingScans.push(node);
      if (empty) ctx.requestAnimationFrame(scanNext);
    }

    const observerOptions: MutationObserverInit = {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'sizes', 'style', 'class', 'poster'],
    };
    const mutation = new MutationObserver((changes) => {
      for (const change of changes) {
        if (change.target instanceof Element && change.target.closest('label-ai-overlay')) continue;
        if (change.type === 'attributes' && change.target instanceof Element) {
          const entry = entries.get(change.target);
          if (entry && sourceFor(change.target) !== entry.source) reset(entry);
          else register(change.target);
        }
        for (const node of change.removedNodes)
          if (node instanceof Element && !node.isConnected) scan(node);
        for (const node of change.addedNodes) if (node instanceof Element) scan(node);
      }
      schedule();
    });
    mutation.observe(document.body, observerOptions);
    roots.add(document.body);

    for (const event of ['load', 'loadedmetadata', 'emptied', 'seeking'])
      ctx.addEventListener(
        document,
        event,
        (ev) => {
          if (!(ev.target instanceof Element)) return;
          const entry = entries.get(ev.target);
          if (entry) reset(entry);
        },
        { capture: true },
      );
    ctx.addEventListener(document, 'play', schedule, { capture: true });
    for (const event of ['pause', 'ended'])
      ctx.addEventListener(
        document,
        event,
        (ev) => {
          if (ev.target instanceof HTMLVideoElement) {
            const entry = entries.get(ev.target);
            if (entry && entry.frameCallback != null) suspendEntry(entry);
          }
        },
        { capture: true },
      );
    ctx.addEventListener(document, 'visibilitychange', () => {
      permission.invalidate();
      suspend();
      refreshPermission();
      schedule();
    });
    ctx.addEventListener(window, 'focus', () => {
      refreshPermission();
      schedule();
    });
    ctx.addEventListener(window, 'blur', () => {
      permission.invalidate();
      suspend();
      schedule();
    });
    ctx.addEventListener(window, 'scroll', schedule, { passive: true, capture: true });
    ctx.addEventListener(window, 'resize', schedule, { passive: true });
    for (const event of ['popstate', 'hashchange'])
      ctx.addEventListener(window, event, () => {
        permission.invalidate();
        suspend();
        refreshPermission();
        schedule();
      });
    ctx.setInterval(() => {
      refreshPermission();
      schedule();
    }, 1000); // Renew the browser grant and check expiry; no whole-document rescans.
    let settingsChangedDuringLoad = false;
    const settingsChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'local' || !changes[SETTINGS_KEY]) return;
      settingsChangedDuringLoad = true;
      settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
      permission.invalidate();
      for (const entry of entries.values()) {
        cancel(entry);
        entry.decision = undefined;
        entry.retry.reset();
        entry.attempted = false;
        entry.originalAttempted = false;
      }
      refreshPermission();
      schedule();
    };
    browser.storage.onChanged.addListener(settingsChanged);
    ctx.onInvalidated(() => {
      ended = true;
      permission.invalidate();
      queue.clear();
      for (const entry of entries.values()) cancel(entry);
      entries.clear();
      pendingScans = [];
      mutation.disconnect();
      intersection.disconnect();
      resize.disconnect();
      browser.storage.onChanged.removeListener(settingsChanged);
      ui.remove();
    });
    try {
      const stored = await readSettings();
      if (!settingsChangedDuringLoad) settings = stored;
    } catch {
      // If settings cannot be read, do not grant capture until a change arrives.
    }
    if (ctx.isInvalid) return;
    refreshPermission();
    scan(document.body);
  },
});
