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
import { playerStatus, type PlayerStatus } from '../../src/core/player-status';
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
import { needsPlaybackWindow, observePlaybackWindow } from '../../src/media/playback-window';
import { videoSamplePlan, videoSampleSlot } from '../../src/media/video-sampling';
import { canReadCorsVideo, readCorsVideoFrames } from '../../src/media/cors-video';
import { playingVideoCovers } from '../../src/media/video-cover';
import { visiblePlaybackArea } from '../../src/media/playback-order';
import { acquireVideoOriginal } from '../../src/media/video-original';
import { readSettings, SETTINGS_KEY } from '../../src/transport/settings';
import '../../src/styles/label.scss';

interface MediaEntry {
  element: Element;
  id: string;
  source: string;
  videoDuration?: number;
  backgroundLayout?: string;
  generation: number;
  binding?: Binding;
  decision?: LocalDecision;
  lastState?: GalleryState;
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
  stopWindow?: () => void;
  needsFreshScene?: boolean;
  nextWindowAt?: number;
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
    const queue = new BoundedQueue(1, 25, 1);
    const enqueuePlayback = (id: string, run: () => Promise<void>) =>
      queue.enqueue(id, run, 'playback');
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

    let fullscreen: Element | null;
    function updateFullscreenAnchor() {
      fullscreen = document.fullscreenElement;
      // The document retargets fullscreenElement to the outermost shadow host.
      while (fullscreen?.shadowRoot?.fullscreenElement)
        fullscreen = fullscreen.shadowRoot.fullscreenElement;
      ui.shadowHost.removeAttribute('popover');
      // Children of a native <video> do not render. For that case the badge
      // enters the top layer on a positive decision, with viewport coordinates.
      const anchor =
        fullscreen && !(fullscreen instanceof HTMLVideoElement)
          ? fullscreen
          : document.documentElement;
      if (ui.shadowHost.parentElement !== anchor) anchor.appendChild(ui.shadowHost);
    }
    updateFullscreenAnchor();

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
        (!(entry.element instanceof HTMLVideoElement) ||
          Object.is(entry.element.duration, entry.videoDuration) ||
          (entry.stopWindow !== undefined &&
            entry.element.duration >= (entry.videoDuration ?? Infinity))) &&
        (entry.backgroundLayout === undefined ||
          entry.backgroundLayout === backgroundLayoutKey(entry.element, entry.source))
      );
    }

    function currentPlayerStatus(): PlayerStatus {
      if (!eligible()) return 'inactive';
      let largest = 0;
      let result: PlayerStatus = 'missing';
      for (const entry of entries.values()) {
        const video = entry.element;
        if (!(video instanceof HTMLVideoElement) || !matchesVisibleMedia(entry)) continue;
        const rect = video.getBoundingClientRect();
        const area = visiblePlaybackArea(rect);
        if (area <= largest) continue;
        largest = area;
        result = playerStatus(video, entry.lastState, Boolean(entry.binding));
      }
      return result;
    }
    const reportPlayerStatus = (message: unknown, sender: { id?: string; url?: string }) => {
      if (
        sender.id === browser.runtime.id &&
        sender.url === browser.runtime.getURL('/popup.html') &&
        message &&
        typeof message === 'object' &&
        'type' in message &&
        message.type === 'label-ai:player-status'
      )
        return Promise.resolve(currentPlayerStatus());
    };
    browser.runtime.onMessage.addListener(reportPlayerStatus);
    ctx.onInvalidated(() => browser.runtime.onMessage.removeListener(reportPlayerStatus));

    function markState(entry: MediaEntry, state: GalleryState) {
      entry.lastState = state;
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
      if (entry.stopWindow) {
        entry.stopWindow();
        entry.stopWindow = undefined;
        entry.needsFreshScene = undefined;
        entry.decision = undefined;
        entry.attempted = false;
      }
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
        queue.has(entry.id) ||
        entry.binding ||
        entry.captureAbort ||
        entry.frameCallback != null ||
        entry.stopWindow;
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
        if (
          mayFinish &&
          (entry.binding || (entry.stopWindow && entry.decision)) &&
          matchesVisibleMedia(entry)
        ) {
          if (entry.stopWindow) entry.needsFreshScene = true;
          continue;
        }
        suspendEntry(entry);
      }
      queue.clear();
      render();
    }

    function reset(entry: MediaEntry) {
      cancel(entry);
      if (gallery()) entry.element.removeAttribute(galleryAttribute);
      entry.lastState = undefined;
      entry.nextWindowAt = undefined;
      entry.source = sourceFor(entry.element);
      if (entry.element instanceof HTMLVideoElement) entry.videoDuration = entry.element.duration;
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
      let insidePlayer = !fullscreen;
      for (let current: Element | null = element; current; ) {
        if (current === fullscreen) insidePlayer = true;
        const style = getComputedStyle(current);
        if (
          style.visibility === 'hidden' ||
          style.visibility === 'collapse' ||
          style.display === 'none' ||
          Number.parseFloat(style.opacity) === 0
        )
          return false;
        const root = current.getRootNode();
        current =
          current.assignedSlot ??
          current.parentElement ??
          (root instanceof ShadowRoot ? root.host : null);
      }
      return insidePlayer;
    }

    function place(entry: MediaEntry): LabelPlacement | null {
      if (
        entry.needsFreshScene ||
        !entry.decision?.shouldLabel ||
        !entry.visible ||
        !entry.element.isConnected ||
        !active()
      )
        return null;
      if (entry.decision.expiresAt <= Date.now() || !matchesCurrentMedia(entry)) return null;
      const bounds = badgeBounds(entry.element);
      if (!bounds || !shown(entry.element)) return null;
      if (
        !(entry.element instanceof HTMLVideoElement) &&
        playingVideoCovers(entry.element, entry.element.getBoundingClientRect())
      )
        return null;
      const placement: LabelPlacement = {
        kind: entry.element instanceof HTMLVideoElement ? 'video' : 'image',
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
      if (fullscreen instanceof HTMLVideoElement) {
        if (
          placements.length &&
          ui.shadowHost.isConnected &&
          typeof ui.shadowHost.showPopover === 'function'
        ) {
          if (!ui.shadowHost.hasAttribute('popover')) {
            ui.shadowHost.setAttribute('popover', 'manual');
            try {
              ui.shadowHost.showPopover();
            } catch {
              // The publisher may detach its player during a fullscreen transition.
              placements.length = 0;
            }
          }
        } else {
          ui.shadowHost.removeAttribute('popover');
          placements.length = 0;
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

    function startPlaybackWindow(entry: MediaEntry, video: HTMLVideoElement) {
      if (performance.now() < (entry.nextWindowAt ?? 0)) return;
      const lease = `${entry.id}:${entry.generation}:${newScanId()}`;
      if (!videoCaptures.acquire(lease)) return;
      entry.captureLease = lease;
      markState(entry, 'pending');
      const current = () => active() && matchesVisibleMedia(entry);
      const stop = observePlaybackWindow(
        video,
        current,
        (sample) => {
          entry.attempted = true;
          // Avoid resubmitting continuously on long feeds where the detector abstains.
          entry.nextWindowAt = performance.now() + 8000;
          const queued = enqueuePlayback(entry.id, async () => {
            try {
              if (entry.stopWindow === stop && current()) await submit(entry, sample);
            } finally {
              videoCaptures.release(lease);
              if (entry.captureLease === lease) entry.captureLease = undefined;
              if (entry.stopWindow === stop && !entry.decision?.shouldLabel) cancel(entry);
              schedule();
            }
          });
          if (!queued) {
            cancel(entry);
            schedule();
          }
        },
        (unreadable) => {
          cancel(entry);
          entry.attempted = unreadable;
          markState(entry, unreadable ? 'unsupported' : 'canceled');
          schedule();
        },
        {
          pending: () =>
            permission.lastAdmission &&
            eligible() &&
            matchesVisibleMedia(entry) &&
            Boolean(entry.binding || entry.decision),
          setSceneConfirmed: (confirmed) => {
            if (Boolean(entry.needsFreshScene) === !confirmed) return;
            entry.needsFreshScene = !confirmed;
            schedule();
          },
        },
      );
      entry.stopWindow = stop;
    }

    function startVideo(entry: MediaEntry) {
      const video = entry.element as HTMLVideoElement;
      if (
        entry.frameCallback != null ||
        entry.stopWindow ||
        entry.captureLease ||
        entry.attempted ||
        video.paused ||
        !video.requestVideoFrameCallback
      )
        return;
      const generation = entry.generation;
      const durationMs = video.duration * 1000;
      if (needsPlaybackWindow(durationMs, video.currentTime * 1000, entry.source)) {
        startPlaybackWindow(entry, video);
        return;
      }
      const plan = videoSamplePlan(durationMs);
      if (!plan) {
        if (video.readyState >= 1) {
          markState(entry, 'unsupported');
          entry.attempted = true;
        }
        return;
      }
      const captureLease = `${entry.id}:${generation}:${newScanId()}`;
      if (!videoCaptures.acquire(captureLease)) return;
      entry.captureLease = captureLease;
      markState(entry, 'pending');
      entry.captureTimer = setTimeout(
        () => {
          if (entry.generation !== generation) return;
          cancel(entry);
          markState(entry, 'canceled');
          entry.attempted = true;
          schedule();
        },
        Math.max(30_000, durationMs + 10_000),
      );
      const observedTimesMs: number[] = [];
      let needsCors = false;
      let previousFrame: VideoFrameCallbackMetadata | undefined;
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
        if (video.duration * 1000 !== durationMs) {
          cancel(entry);
          markState(entry, 'unsupported');
          entry.attempted = true;
          return;
        }
        const timestampMs = metadata.mediaTime * 1000;
        if (previousFrame && metadata.mediaTime < previousFrame.mediaTime) {
          // A looping player may present its next lap before delivering seeking.
          // Discard the partial lap instead of stitching two intervals together.
          observedTimesMs.length = 0;
          entry.frames = [];
          previousFrame = undefined;
        }
        const last = observedTimesMs.at(-1);
        const slot = videoSampleSlot(timestampMs, durationMs);
        const previousSlot = last === undefined ? -1 : videoSampleSlot(last, durationMs);
        const frameInterval = previousFrame
          ? (timestampMs - previousFrame.mediaTime * 1000) /
            Math.max(1, metadata.presentedFrames - previousFrame.presentedFrames)
          : 0;
        previousFrame = metadata;
        // A two-second 8fps clip ends at 1875ms. Its nominal last slot can
        // begin after the final displayable frame. Only credit real presentations.
        const lastPresentation =
          slot >= plan.frameLimit - 2 &&
          frameInterval > 0 &&
          frameInterval <= Math.min(250, durationMs / 8) &&
          timestampMs + frameInterval + 0.01 >= durationMs;
        try {
          if (
            slot > previousSlot ||
            (lastPresentation && last !== timestampMs && observedTimesMs.length < plan.frameLimit)
          ) {
            if (!needsCors) {
              try {
                entry.frames.push(captureVideoFrame(video, timestampMs, plan.maxSide));
              } catch (error) {
                if (
                  !(error instanceof DOMException) ||
                  error.name !== 'SecurityError' ||
                  !canReadCorsVideo(video, entry.source)
                )
                  throw error;
                // Decode every observed timestamp from the same representation.
                needsCors = true;
                entry.frames = [];
              }
            }
            observedTimesMs.push(timestampMs);
          }
          if (
            (slot === plan.frameLimit - 1 || lastPresentation) &&
            observedTimesMs.length >= 8 * plan.segments
          ) {
            entry.attempted = true;
            if (entry.captureTimer !== undefined) clearTimeout(entry.captureTimer);
            entry.captureTimer = undefined;
            const frames = entry.frames;
            entry.frames = [];
            const coverage = (observedTimesMs.at(-1)! - observedTimesMs[0]!) / durationMs;
            const queued = enqueuePlayback(entry.id, async () => {
              const current = () =>
                entry.generation === generation &&
                entry.captureLease === captureLease &&
                active() &&
                entry.visible &&
                shown(video) &&
                video.isConnected &&
                video.duration * 1000 === durationMs &&
                sourceFor(video) === entry.source;
              const controller = new AbortController();
              try {
                if (!current()) return;
                let captured: FramePayload[] | undefined = frames;
                if (needsCors) {
                  entry.captureAbort = controller;
                  captured = await readCorsVideoFrames(
                    video,
                    entry.source,
                    observedTimesMs,
                    controller.signal,
                  );
                }
                if (!current() || controller.signal.aborted) return;
                if (captured)
                  await submit(entry, { kind: 'video', frames: captured, durationMs, coverage });
                else markState(entry, 'unsupported');
              } catch {
                if (entry.generation === generation) markState(entry, 'failed');
              } finally {
                if (entry.captureAbort === controller) entry.captureAbort = undefined;
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
      // Virtualized feeds can leave the previous autoplaying card on screen by
      // a few pixels. Give the player actually in view the next capture lease.
      const areas = new Map<MediaEntry, number>();
      let largestPlayer = 0;
      for (const entry of entries.values()) {
        if (
          !entry.visible ||
          !(entry.element instanceof HTMLVideoElement) ||
          entry.element.paused ||
          !shown(entry.element)
        )
          continue;
        const area = visiblePlaybackArea(entry.element.getBoundingClientRect());
        areas.set(entry, area);
        largestPlayer = Math.max(largestPlayer, area);
      }
      const ordered = Array.from(entries.values()).sort(
        (a, b) => (areas.get(b) ?? 0) - (areas.get(a) ?? 0),
      );
      for (const entry of ordered) {
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
          entry.lastState = undefined;
          if (gallery()) entry.element.removeAttribute(galleryAttribute);
          entry.attempted = false;
          entry.originalAttempted = false;
        }
        if (entry.visible && !shown(entry.element)) {
          suspendEntry(entry);
          continue;
        }
        const area = areas.get(entry);
        if (area !== undefined && largestPlayer > 4 * area) {
          const rect = entry.element.getBoundingClientRect();
          if (area < rect.width * rect.height * 0.15) {
            suspendEntry(entry);
            continue;
          }
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
              const accepted = enqueuePlayback(entry.id, async () => {
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
        ...(element instanceof HTMLVideoElement && { videoDuration: element.duration }),
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
      attributeFilter: [
        'src',
        'srcset',
        'sizes',
        'style',
        'class',
        'poster',
        'hidden',
        'open',
        'type',
      ],
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

    for (const event of ['load', 'loadedmetadata', 'durationchange', 'emptied', 'seeking'])
      ctx.addEventListener(
        document,
        event,
        (ev) => {
          if (!(ev.target instanceof Element)) return;
          const entry = entries.get(ev.target);
          if (!entry) return;
          if (event === 'durationchange' && matchesCurrentMedia(entry)) {
            if (entry.stopWindow && entry.element instanceof HTMLVideoElement)
              entry.videoDuration = entry.element.duration;
            return;
          }
          // Looping and scrubbing change playback time, while completed whole-clip
          // evidence remains bound to the same loaded resource. Partial captures
          // still reset on a seek. Source replacement always invalidates a verdict.
          if (
            event === 'seeking' &&
            !entry.stopWindow &&
            (entry.binding || entry.decision || (entry.attempted && queue.has(entry.id))) &&
            matchesCurrentMedia(entry)
          )
            return;
          reset(entry);
        },
        { capture: true },
      );
    ctx.addEventListener(document, 'fullscreenchange', () => {
      updateFullscreenAnchor();
      schedule();
    });
    // Feed hydration can enqueue thousands of DOM nodes ahead of the active player.
    // Register it immediately, with normal viewport and permission checks downstream.
    for (const event of ['play', 'playing'])
      ctx.addEventListener(
        document,
        event,
        (ev) => {
          if (ev.target instanceof HTMLVideoElement) register(ev.target);
          schedule();
        },
        { capture: true },
      );
    for (const event of ['pause', 'ended'])
      ctx.addEventListener(
        document,
        event,
        (ev) => {
          if (ev.target instanceof HTMLVideoElement) {
            const entry = entries.get(ev.target);
            if (entry && (entry.frameCallback != null || entry.stopWindow)) {
              suspendEntry(entry);
              schedule();
            }
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
    for (const video of document.querySelectorAll('video')) register(video);
    scan(document.body);
  },
});
