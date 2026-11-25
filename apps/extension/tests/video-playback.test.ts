import { afterEach, expect, it, vi } from 'vitest';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';

const mocks = vi.hoisted(() => ({ send: vi.fn(), ui: vi.fn(), setLabels: vi.fn() }));
vi.mock('wxt/browser', () => ({
  browser: {
    extension: { inIncognitoContext: false },
    runtime: {
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      sendMessage: mocks.send,
    },
    storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
  },
}));
vi.mock('wxt/utils/content-script-ui/shadow-root', () => ({ createShadowRootUi: mocks.ui }));
vi.mock('../src/transport/settings', () => ({
  SETTINGS_KEY: 'settings',
  readSettings: async () => ({ enabled: true, consentVersion: 2 }),
}));
vi.mock('../src/media/capture', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/media/capture')>()),
  captureVideoFrame: (_: HTMLVideoElement, timestampMs: number) => ({
    width: 128,
    height: 128,
    rgba: '',
    timestampMs,
  }),
}));

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it.each(['natural end', 'source replacement', 'delayed renewal', 'denied renewal'])(
  'binds the delayed inference result to the original clip after %s',
  async (outcome) => {
    const video = document.body.appendChild(document.createElement('video'));
    video.src = '/actual-clip.webm';
    Object.defineProperties(video, {
      readyState: { value: 4 },
      duration: { value: 4 },
      currentSrc: { get: () => video.src },
    });
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const paused = vi.spyOn(video, 'paused', 'get').mockReturnValue(false);
    vi.spyOn(video, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 480, 480));
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.stubGlobal('defineContentScript', (value: unknown) => value);
    let intersect!: (entries: { target: Element; isIntersecting: boolean }[]) => void;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: typeof intersect) {
          intersect = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const animationTasks: (() => void)[] = [];
    const dispose: (() => void)[] = [];
    const listeners = new AbortController();
    let renew!: () => void;
    const ctx = {
      requestAnimationFrame: (f: () => void) => animationTasks.push(f),
      onInvalidated: (f: () => void) => dispose.push(f),
      setInterval: (callback: () => void) => {
        renew = callback;
      },
      addEventListener(t: EventTarget, name: string, cb: EventListener, options = {}) {
        t.addEventListener(name, cb, { ...options, signal: listeners.signal });
      },
    };
    const tick = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const work = animationTasks.splice(0);
      for (const task of work) task();
    };
    let present: VideoFrameRequestCallback | undefined;
    video.requestVideoFrameCallback = (cb) => {
      present = cb;
      return 42;
    };
    video.cancelVideoFrameCallback = () => {
      present = undefined;
    };
    mocks.ui.mockResolvedValue({
      shadowHost: document.createElement('div'),
      mount() {},
      remove() {},
      mounted: { setLabels: mocks.setLabels },
    });
    let completeInference: (() => void) | undefined;
    let nextRenewal: Promise<{ allowed: boolean }> | undefined;
    mocks.send.mockImplementation(async (msg) => {
      if (msg.type === 'label-ai:can-scan') return nextRenewal ?? { allowed: true };
      if (msg.type === 'label-ai:analyze') {
        expect(msg.frames).toHaveLength(12);
        await new Promise<void>((resolve) => {
          completeInference = resolve;
        });
        return {
          ...msg,
          status: 'COMPLETED',
          shouldLabel: true,
          policyVersion: 'test',
          expiresAt: Date.now() + 60000,
        };
      }
    });
    const { default: script } = await import('../entrypoints/media.content/index');
    try {
      await script.main(ctx as unknown as ContentScriptContext);
      await tick();
      intersect([{ target: video, isIntersecting: true }]);
      await tick();
      for (let frame = 0; frame < 96; frame++) {
        const callback = present;
        present = undefined;
        callback?.(0, { mediaTime: frame / 24 } as VideoFrameCallbackMetadata);
      }
      expect(completeInference).toBeTypeOf('function');
      paused.mockReturnValue(true);
      video.dispatchEvent(new Event('pause'));
      video.dispatchEvent(new Event('ended'));
      expect(mocks.send.mock.calls.some(([m]) => m.type === 'label-ai:cancel')).toBe(false);
      if (outcome === 'source replacement') {
        video.src = '/different-clip.webm';
        video.dispatchEvent(new Event('emptied'));
      }
      let finishRenewal: (() => void) | undefined;
      if (outcome === 'delayed renewal') {
        nextRenewal = new Promise((resolve) => {
          finishRenewal = () => resolve({ allowed: true });
        });
        // The grant expires on the content side while the worker is evaluating the 12 frames.
        clock += 11_000;
        renew();
        await tick();
        expect(mocks.send.mock.calls.some(([m]) => m.type === 'label-ai:cancel')).toBe(false);
      } else if (outcome === 'denied renewal') {
        nextRenewal = Promise.resolve({ allowed: false });
        renew();
        await tick();
        expect(mocks.send.mock.calls.some(([m]) => m.type === 'label-ai:cancel')).toBe(true);
      }
      completeInference!();
      await tick();
      if (finishRenewal) {
        expect(mocks.setLabels.mock.calls.at(-1)![0]).toHaveLength(0);
        finishRenewal();
        await tick();
      }
      const latestLabels = mocks.setLabels.mock.calls.at(-1)![0];
      expect(latestLabels).toHaveLength(
        outcome === 'natural end' || outcome === 'delayed renewal' ? 1 : 0,
      );
    } finally {
      listeners.abort();
      for (const cleanup of dispose) cleanup();
    }
  },
);
