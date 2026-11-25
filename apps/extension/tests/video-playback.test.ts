import { afterEach, expect, it, vi } from 'vitest';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  ui: vi.fn(),
  setLabels: vi.fn(),
  scene: vi.fn(),
}));
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
  createVideoSceneReader: () => mocks.scene,
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

async function playbackHarness(getDuration: () => number, start = 0) {
  const video = document.body.appendChild(document.createElement('video'));
  video.src = '/actual-clip.webm';
  Object.defineProperties(video, {
    readyState: { value: 4 },
    duration: { get: getDuration },
    currentSrc: { get: () => video.src },
  });
  video.currentTime = start;
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
  const { default: script } = await import('../entrypoints/media.content/index');
  return {
    video,
    tick,
    paused,
    advanceClock(ms: number) {
      clock += ms;
    },
    renew: () => renew(),
    presentFrame(time: number, count: number) {
      video.currentTime = time;
      const callback = present;
      present = undefined;
      callback?.(clock, { mediaTime: time, presentedFrames: count } as VideoFrameCallbackMetadata);
    },
    async start() {
      await script.main(ctx as unknown as ContentScriptContext);
      await tick();
      intersect([{ target: video, isIntersecting: true }]);
      await tick();
    },
    dispose() {
      listeners.abort();
      for (const cleanup of dispose) cleanup();
    },
  };
}

it.each([
  'natural end',
  '8fps end',
  'loop without seeking event',
  'loop rewind',
  'source replacement',
  'duration change',
  'same duration',
  'delayed renewal',
  'denied renewal',
])('binds the delayed inference result to the original clip after %s', async (outcome) => {
  const lowFps = outcome === '8fps end' || outcome === 'loop without seeking event';
  const duration = lowFps ? 2 : 4;
  let currentDuration = duration;
  const fps = lowFps ? 8 : 24;
  const h = await playbackHarness(() => currentDuration);
  const { video, paused, tick } = h;
  let completeInference: (() => void) | undefined;
  let nextRenewal: Promise<{ allowed: boolean }> | undefined;
  mocks.send.mockImplementation(async (msg) => {
    if (msg.type === 'label-ai:can-scan') return nextRenewal ?? { allowed: true };
    if (msg.type === 'label-ai:analyze') {
      if (lowFps) {
        expect(msg.frames.length).toBeGreaterThanOrEqual(8);
        expect(msg.frames.at(-1).timestampMs).toBe(1875);
      } else expect(msg.frames).toHaveLength(12);
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
  try {
    await h.start();
    if (outcome === 'loop without seeking event') {
      // First admitted near EOF. The next cycle arrives directly as presented frames.
      for (let frame = 12; frame < 16; frame++) {
        h.presentFrame(frame / fps, frame + 1);
      }
      expect(completeInference).toBeUndefined();
    }
    for (let frame = 0; frame < fps * duration; frame++) {
      h.presentFrame(frame / fps, frame + 1);
    }
    expect(completeInference).toBeTypeOf('function');
    paused.mockReturnValue(true);
    video.dispatchEvent(new Event('pause'));
    video.dispatchEvent(new Event('ended'));
    expect(mocks.send.mock.calls.some(([m]) => m.type === 'label-ai:cancel')).toBe(false);
    if (outcome === 'loop rewind') {
      video.loop = true;
      video.dispatchEvent(new Event('seeking'));
      expect(mocks.send.mock.calls.some(([m]) => m.type === 'label-ai:cancel')).toBe(false);
    }
    if (outcome === 'duration change' || outcome === 'same duration') {
      if (outcome === 'duration change') currentDuration += 30;
      video.dispatchEvent(new Event('durationchange'));
    }
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
      h.advanceClock(11_000);
      h.renew();
      await tick();
      expect(mocks.send.mock.calls.some(([m]) => m.type === 'label-ai:cancel')).toBe(false);
    } else if (outcome === 'denied renewal') {
      nextRenewal = Promise.resolve({ allowed: false });
      h.renew();
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
      outcome === 'natural end' ||
        lowFps ||
        outcome === 'same duration' ||
        outcome === 'loop rewind' ||
        outcome === 'delayed renewal'
        ? 1
        : 0,
    );
  } finally {
    h.dispose();
  }
});

it.each(['manually played file', 'autoplaying CORS-readable CDN file'])(
  'keeps the complete-clip route for a %s',
  async (scenario) => {
    const h = await playbackHarness(() => 25);
    if (scenario === 'autoplaying CORS-readable CDN file') {
      h.video.src = 'https://media.example.org/clip.mp4';
      h.video.autoplay = true;
      Object.defineProperties(h.video, { videoWidth: { value: 320 }, videoHeight: { value: 240 } });
    }
    mocks.send.mockImplementation(async (message) =>
      message.type === 'label-ai:can-scan' ? { allowed: true } : undefined,
    );
    try {
      await h.start();
      for (let n = 0; n < 25 * 8; n++) h.presentFrame(n / 8, n + 1);
      const submissions = mocks.send.mock.calls
        .map(([message]) => message)
        .filter((message) => message.type === 'label-ai:analyze');
      expect(submissions).toHaveLength(1);
      expect(submissions[0].scope).toBeUndefined();
      expect(submissions[0].durationMs).toBe(25_000);
      expect(mocks.scene).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  },
);

it('can complete a whole direct file on replay when the loop outruns scene inference', async () => {
  const h = await playbackHarness(() => 16);
  h.video.loop = true;
  mocks.scene.mockImplementation(() => new Uint8ClampedArray(8 * 8 * 4));
  let finish!: () => void;
  mocks.send.mockImplementation(async (message) => {
    if (message.type === 'label-ai:can-scan') return { allowed: true };
    if (message.type !== 'label-ai:analyze') return;
    if (message.scope === 'playback-window')
      await new Promise<void>((resolve) => (finish = resolve));
    return {
      ...message,
      status: 'COMPLETED',
      shouldLabel: true,
      expiresAt: Date.now() + 60_000,
      policyVersion: 'test',
    };
  });
  try {
    await h.start();
    for (let n = 0; n < 16 * 8; n++) h.presentFrame(n / 8, n + 1);
    expect(finish).toBeTypeOf('function');
    h.video.currentTime = 0;
    h.video.dispatchEvent(new Event('seeking'));
    finish();
    await h.tick();
    await h.tick();
    expect(mocks.setLabels.mock.calls.at(-1)![0]).toHaveLength(0);
    for (let n = 0; n < 16 * 8; n++) h.presentFrame(n / 8, n + 1);
    await h.tick();
    const requests = mocks.send.mock.calls
      .map(([m]) => m)
      .filter((m) => m.type === 'label-ai:analyze');
    expect(requests.map((m) => m.scope)).toEqual(['playback-window', undefined]);
    expect(requests[1].durationMs).toBe(16_000);
    expect(mocks.setLabels.mock.calls.at(-1)![0]).toHaveLength(1);
  } finally {
    h.dispose();
  }
});

it.each([
  ['long clip', 300],
  ['buffered short from the start', 25],
  ['direct autoplay from the start', 25],
  ['direct loop from the start', 16],
  ['three presentations per second', 300],
  ['source change during inference', 300],
  ['seek without an event', 300],
  ['negative retry', 300],
  ['delayed renewal', 300],
  ['cut during renewal', 300],
  ['denied renewal', 300],
  ['DVR rewind', 300],
  ['growing DVR duration', 300],
  ['late short', 22],
  ['live stream', Infinity],
  ['seek during inference', 300],
  ['cut after verdict', 300],
  ['cut during inference', 300],
  ['pause after verdict', 300],
  ['insufficient watch time', 300],
] as const)('samples only the observed scene on %s', async (scenario, duration) => {
  const start = scenario.endsWith('from the start') ? 0 : duration === 22 ? 9 : 72;
  let currentDuration: number = duration;
  const h = await playbackHarness(() => currentDuration, start);
  if (scenario === 'buffered short from the start') {
    class Handle {}
    vi.stubGlobal('MediaSourceHandle', Handle);
    Object.defineProperty(h.video, 'srcObject', { value: new Handle() });
  }
  h.video.autoplay = scenario === 'direct autoplay from the start';
  h.video.loop = scenario === 'direct loop from the start';
  let finish: (() => void) | undefined;
  let color = 30;
  let renewal: Promise<{ allowed: boolean }> | undefined;
  mocks.scene.mockImplementation(() => new Uint8Array(8 * 8 * 4).fill(color));
  mocks.send.mockImplementation(async (message) => {
    if (message.type === 'label-ai:can-scan') return renewal ?? { allowed: true };
    if (message.type === 'label-ai:analyze') {
      expect(message.scope).toBe('playback-window');
      expect(message.frames.length).toBeGreaterThanOrEqual(8);
      expect(message.frames[0].timestampMs).toBe(0);
      expect(message.durationMs).toBeGreaterThanOrEqual(4000);
      expect(message.durationMs).toBeLessThan(4500);
      expect(message.frames.at(-1).timestampMs).toBe(message.durationMs);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return {
        ...message,
        status: 'COMPLETED',
        shouldLabel: scenario !== 'negative retry',
        policyVersion: 'test',
        expiresAt: Date.now() + 60000,
      };
    }
  });
  try {
    await h.start();
    const present = (n: number) => {
      h.advanceClock(125);
      h.presentFrame(start + n / 8, n + 1);
    };
    if (scenario === 'three presentations per second') {
      for (let n = 0; n <= 12; n++) {
        h.advanceClock(1000 / 3);
        h.presentFrame(start + n / 3, n + 1);
      }
    } else {
      for (let n = 0; n <= (scenario === 'insufficient watch time' ? 16 : 34); n++) present(n);
    }
    if (scenario === 'insufficient watch time') {
      expect(finish).toBeUndefined();
      return;
    }
    expect(finish).toBeTypeOf('function');
    if (scenario.includes('renewal')) {
      let resolve!: (grant: { allowed: boolean }) => void;
      renewal = new Promise((done) => {
        resolve = done;
      });
      h.advanceClock(6000);
      h.renew();
      const reads = mocks.scene.mock.calls.length;
      for (let n = 35; n <= 42; n++) present(n);
      expect(mocks.scene.mock.calls).toHaveLength(reads);
      expect(mocks.send.mock.calls.some(([m]) => m.type === 'label-ai:cancel')).toBe(false);
      finish!();
      await h.tick();
      const labels = () => mocks.setLabels.mock.calls.at(-1)![0];
      expect(labels()).toHaveLength(0);
      resolve({ allowed: scenario !== 'denied renewal' });
      await h.tick();
      await h.tick();
      expect(labels()).toHaveLength(0);
      if (scenario === 'cut during renewal') color = 220;
      for (let n = 43; n < 47; n++) present(n);
      await h.tick();
      expect(labels()).toHaveLength(scenario === 'delayed renewal' ? 1 : 0);
      return;
    }
    if (scenario === 'growing DVR duration') {
      currentDuration += 10;
      h.video.dispatchEvent(new Event('durationchange'));
    }
    if (scenario === 'source change during inference') {
      h.video.src = '/other-video.webm';
      h.video.dispatchEvent(new Event('emptied'));
    }
    if (scenario === 'DVR rewind') {
      currentDuration -= 10;
      h.video.dispatchEvent(new Event('durationchange'));
    }
    if (scenario === 'seek without an event') h.presentFrame(start + 20, 36);
    if (scenario === 'seek during inference') h.video.dispatchEvent(new Event('seeking'));
    if (scenario === 'cut during inference') color = 220;
    for (let n = 35; n <= 38; n++) present(n);
    finish!();
    await h.tick();
    const labels = () => mocks.setLabels.mock.calls.at(-1)![0];
    expect(labels()).toHaveLength(
      [
        'seek during inference',
        'cut during inference',
        'source change during inference',
        'seek without an event',
        'DVR rewind',
        'negative retry',
      ].includes(scenario)
        ? 0
        : 1,
    );
    if (scenario === 'negative retry') {
      const submissions = () =>
        mocks.send.mock.calls.filter(([m]) => m.type === 'label-ai:analyze').length;
      expect(submissions()).toBe(1);
      h.renew();
      await h.tick();
      for (let n = 39; n < 74; n++) present(n);
      expect(submissions()).toBe(1);
      h.advanceClock(8000);
      h.renew();
      await h.tick();
      await h.tick();
      for (let n = 74; n <= 112; n++) present(n);
      expect(submissions()).toBe(2);
      finish!();
      await h.tick();
    }
    if (scenario === 'cut after verdict' || scenario === 'pause after verdict') {
      if (scenario === 'cut after verdict') {
        color = 220;
        for (let n = 39; n < 44; n++) present(n);
      } else {
        h.paused.mockReturnValue(true);
        h.video.dispatchEvent(new Event('pause'));
      }
      await h.tick();
      expect(labels()).toHaveLength(0);
    }
  } finally {
    h.dispose();
  }
});

it('keeps a positive badge above direct video fullscreen and hides it behind another player', async () => {
  const h = await playbackHarness(() => 4);
  const other = document.body.appendChild(document.createElement('section'));
  let fullscreen: Element | null = null;
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => fullscreen,
  });
  mocks.send.mockImplementation(async (message) => {
    if (message.type === 'label-ai:can-scan') return { allowed: true };
    if (message.type === 'label-ai:analyze')
      return {
        ...message,
        status: 'COMPLETED',
        shouldLabel: true,
        policyVersion: 'test',
        expiresAt: Date.now() + 60000,
      };
  });
  try {
    await h.start();
    const { shadowHost } = await mocks.ui.mock.results.at(-1)!.value;
    const showPopover = vi.fn();
    shadowHost.showPopover = showPopover;
    fullscreen = h.video;
    document.dispatchEvent(new Event('fullscreenchange'));
    await h.tick();
    expect(showPopover).not.toHaveBeenCalled();
    for (let frame = 0; frame < 96; frame++) h.presentFrame(frame / 24, frame + 1);
    await h.tick();
    expect(showPopover).toHaveBeenCalledTimes(1);
    expect(shadowHost.getAttribute('popover')).toBe('manual');
    expect(mocks.setLabels.mock.lastCall![0]).toHaveLength(1);
    const player = document.body.appendChild(document.createElement('section'));
    player.append(h.video);
    fullscreen = player;
    document.dispatchEvent(new Event('fullscreenchange'));
    await h.tick();
    expect(showPopover).toHaveBeenCalledTimes(2);
    expect(mocks.setLabels.mock.lastCall![0]).toHaveLength(1);
    fullscreen = other;
    document.dispatchEvent(new Event('fullscreenchange'));
    await h.tick();
    expect(shadowHost.hasAttribute('popover')).toBe(false);
    expect(mocks.setLabels.mock.lastCall![0]).toHaveLength(0);
    fullscreen = null;
    document.dispatchEvent(new Event('fullscreenchange'));
    await h.tick();
    expect(mocks.setLabels.mock.lastCall![0]).toHaveLength(1);
  } finally {
    h.dispose();
    Reflect.deleteProperty(document, 'fullscreenElement');
  }
});
