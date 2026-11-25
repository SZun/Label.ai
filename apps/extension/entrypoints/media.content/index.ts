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
  newScanId,
  type Binding,
  type FramePayload,
  type LocalDecision,
} from '../../src/core/protocol';
import { badgeBounds, hasImageBadgeSpace } from '../../src/core/label-bounds';
import { BoundedQueue } from '../../src/core/queue';
import { CaptureSlots } from '../../src/core/capture-slots';
import { ScanningPermission } from '../../src/core/scanning-permission';
import { LOCAL_TEST_BUILD } from '../../src/core/local-test';
import {
  galleryDiagnosticPage,
  galleryReplyState,
  type GalleryState,
} from '../../src/core/gallery-diagnostics';
import { RetryBudget, retryableReply } from '../../src/core/retry';
import { backgroundLayoutKey } from '../../src/media/background-image';
import { captureImage, captureVideoFrame, sourceFor } from '../../src/media/capture';
import { MAX_SAMPLED_DURATION_MS, videoSampleSlot } from '../../src/media/video-sampling';
import { acquireVideoOriginal } from '../../src/media/video-original';
import { readSettings, SETTINGS_KEY } from '../../src/transport/settings';
import '../../src/styles/label.scss';

interface MediaEntry {
  element: Element;
  id: string;
  source: string;
  backgroundLayout?: string;
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
      // Badge coordinates come from getBoundingClientRect, even on pages
      // that transform the body into a containing block for fixed children.
      anchor: document.documentElement,
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

    const gallery = () => galleryDiagnosticPage(location.href, document, window.top === window);
    let settingsStatus: 'starting' | 'ready' | 'settings-error' = 'starting';
    const galleryAttribute = 'data-label-ai-test-state';
    if (gallery()) {
      ui.shadowHost.setAttribute('data-label-ai-version', browser.runtime.getManifest().version);
      ui.shadowHost.setAttribute('data-label-ai-scanner-state', 'starting');
      ui.shadowHost.setAttribute(
        'data-label-ai-build',
        LOCAL_TEST_BUILD ? 'local-test' : 'production',
      );
    }

    // A visible tab can lose DOM focus to the address bar, DevTools or an
    // embedded frame. The worker verifies the active tab and focused window.
    const eligible = () => !ended && !document.hidden && eligibleDocumentChain(window, settings);
    const active = () => eligible() && permission.allowed;

    function matchesCurrentMedia(entry: MediaEntry) {
      return (
        sourceFor(entry.element) === entry.source &&
        (entry.backgroundLayout === undefined ||
          entry.backgroundLayout === backgroundLayoutKey(entry.element, entry.source))
      );
    }

    function markState(entry: MediaEntry, state: GalleryState) {
      if (gallery() && entry.element.isConnected && sourceFor(entry.element) === entry.source)
        entry.element.setAttribute(galleryAttribute, state);
    }

    function refreshPermission() {
      if (!eligible()) {
        permission.invalidate();
        return;
      }
      void permission.refresh().then(() => {
        if (!active()) suspend(true);
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
        markState(entry, 'canceled');
        entry.attempted = false;
        entry.originalAttempted = false;
      }
    }

    function matchesVisibleMedia(entry: MediaEntry) {
      return (
        entry.visible &&
        entry.element.isConnected &&
        shown(entry.element) &&
        matchesCurrentMedia(entry)
      );
    }

    function suspend(awaitingPermission = false) {
      const mayFinish = awaitingPermission && eligible() && permission.lastAdmission;
      for (const entry of entries.values()) {
        // A blocked renewal can outlast the capture grant during WASM inference.
        // The worker owns already submitted pixels and independently rechecks the sender.
        if (mayFinish && entry.binding && matchesVisibleMedia(entry)) continue;
        suspendEntry(entry);
      }
      queue.clear();
      render();
    }

    function reset(entry: MediaEntry) {
      cancel(entry);
      if (gallery()) entry.element.removeAttribute(galleryAttribute);
      entry.source = sourceFor(entry.element);
      entry.backgroundLayout = undefined;
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
      if (!entry.decision?.shouldLabel || !entry.visible || !entry.element.isConnected || !active())
        return null;
      if (entry.decision.expiresAt <= Date.now() || !matchesCurrentMedia(entry)) return null;
      const bounds = badgeBounds(entry.element);
      if (!bounds || !shown(entry.element)) return null;
      if (document.fullscreenElement && !document.fullscreenElement.contains(ui.shadowHost))
        return null;
      const placement = {
        key: `${entry.id}:${entry.generation}`,
        ...bounds,
        animate: !entry.animated,
      };
      entry.animated = true;
      animatedSources.set(entry.element, entry.source);
      return placement;
    }

    function updateGalleryScannerStatus() {
      if (!gallery()) return;
      let state: string = settingsStatus;
      if (settingsStatus === 'ready') {
        if (!settings.enabled) state = 'paused';
        else if (!eligible()) state = 'inactive';
        else state = permission.allowed ? 'active' : 'awaiting-access';
      }
      if (ui.shadowHost.getAttribute('data-label-ai-scanner-state') !== state)
        ui.shadowHost.setAttribute('data-label-ai-scanner-state', state);
    }

    function render() {
      updateGalleryScannerStatus();
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
      return { instanceId: entry.id, generation: entry.generation, requestId: newScanId() };
    }

    async function submit(entry: MediaEntry, payload: object) {
      const binding = bound(entry);
      entry.binding = binding;
      markState(entry, 'pending');
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
      if (!eligible() || !permission.lastAdmission || !matchesVisibleMedia(entry)) {
        markState(entry, 'canceled');
        entry.attempted = false;
        entry.originalAttempted = false;
        return;
      }
      markState(entry, galleryReplyState(binding, result));
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
      const captureLease = `${entry.id}:${generation}:${newScanId()}`;
      if (!videoCaptures.acquire(captureLease)) return;
      entry.captureLease = captureLease;
      markState(entry, 'pending');
      entry.captureTimer = setTimeout(() => {
        if (entry.generation !== generation) return;
        cancel(entry);
        markState(entry, 'canceled');
        entry.attempted = true;
        schedule();
      }, 30_000);
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
        if (
          !Number.isFinite(durationMs) ||
          durationMs <= 0 ||
          durationMs > MAX_SAMPLED_DURATION_MS
        ) {
          cancel(entry);
          markState(entry, 'unsupported');
          entry.attempted = true;
          return;
        }
        const timestampMs = metadata.mediaTime * 1000;
        const last = entry.frames.at(-1);
        const slot = videoSampleSlot(timestampMs, durationMs);
        const previousSlot = last ? videoSampleSlot(last.timestampMs, durationMs) : -1;
        try {
          if (slot > previousSlot) entry.frames.push(captureVideoFrame(video, timestampMs));
          if (slot === 11 && entry.frames.length >= 3) {
            entry.attempted = true;
            if (entry.captureTimer !== undefined) clearTimeout(entry.captureTimer);
            entry.captureTimer = undefined;
            const frames = entry.frames;
            entry.frames = [];
            const coverage = Math.min(
              1,
              ((frames.at(-1)?.timestampMs ?? 0) - (frames[0]?.timestampMs ?? 0)) / durationMs,
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
                if (entry.generation === generation) markState(entry, 'failed');
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
        } catch (error) {
          cancel(entry);
          markState(
            entry,
            error instanceof DOMException && error.name === 'SecurityError'
              ? 'unsupported'
              : 'failed',
          );
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
        suspend(true);
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
        if (!matchesCurrentMedia(entry)) {
          reset(entry);
          continue;
        }
        if (entry.decision && entry.decision.expiresAt <= Date.now()) {
          entry.decision = undefined;
          if (gallery()) entry.element.removeAttribute(galleryAttribute);
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
        if (!hasImageBadgeSpace(rect.width, rect.height)) continue;
        if (entry.element instanceof HTMLVideoElement) {
          if (rect.width < 128 || rect.height < 90) continue;
          if (!entry.originalAttempted) {
            if (entry.element.readyState < 1) continue;
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
                    ) {
                      await submit(entry, { kind: 'video', original });
                    } else if (generation === entry.generation) {
                      markState(
                        entry,
                        controller.signal.aborted || !active() ? 'canceled' : 'unsupported',
                      );
                    }
                  } else if (generation === entry.generation) {
                    markState(entry, 'canceled');
                  }
                } catch {
                  if (generation === entry.generation) markState(entry, 'failed');
                } finally {
                  if (generation === entry.generation && !entry.decision) {
                    entry.attempted = false;
                    schedule();
                  }
                }
              });
              if (accepted) {
                markState(entry, 'pending');
                entry.attempted = true;
                continue;
              }
              entry.originalAttempted = false;
              // A full queue cannot bypass the credential check by starting frame sampling.
              continue;
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
            markState(entry, 'canceled');
            entry.attempted = false;
            return;
          }
          const generation = entry.generation;
          const controller = new AbortController();
          try {
            entry.captureAbort = controller;
            const layout = backgroundLayoutKey(entry.element, entry.source);
            const payload = await captureImage(entry.element, entry.source, controller.signal);
            if (
              !controller.signal.aborted &&
              generation === entry.generation &&
              active() &&
              entry.visible &&
              shown(entry.element) &&
              sourceFor(entry.element) === entry.source &&
              layout === backgroundLayoutKey(entry.element, entry.source)
            ) {
              entry.backgroundLayout = layout;
              await submit(entry, { kind: 'image', ...payload });
            } else if (entry.generation === generation) {
              markState(entry, 'canceled');
              entry.attempted = false;
            }
          } catch (error) {
            if (entry.generation === generation) {
              markState(
                entry,
                controller.signal.aborted
                  ? 'canceled'
                  : error instanceof DOMException && error.name === 'SecurityError'
                    ? 'unsupported'
                    : 'failed',
              );
            }
          } finally {
            if (entry.captureAbort === controller) entry.captureAbort = undefined;
            schedule();
          }
        });
        if (accepted) {
          markState(entry, 'pending');
          entry.attempted = true;
        }
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
        !sourceFor(element)
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
        id: newScanId(),
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
    for (const event of ['focus', 'blur']) {
      ctx.addEventListener(window, event, refreshPermission);
    }
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
      settingsStatus = 'ready';
      settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
      permission.invalidate();
      for (const entry of entries.values()) {
        cancel(entry);
        if (gallery()) entry.element.removeAttribute(galleryAttribute);
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
      for (const entry of entries.values()) {
        cancel(entry);
        if (gallery()) entry.element.removeAttribute(galleryAttribute);
      }
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
      if (!settingsChangedDuringLoad) {
        settings = stored;
        settingsStatus = 'ready';
      }
    } catch {
      if (!settingsChangedDuringLoad) settingsStatus = 'settings-error';
      // If settings cannot be read, do not grant capture until a change arrives.
    }
    if (ctx.isInvalid) return;
    refreshPermission();
    scan(document.body);
  },
});
