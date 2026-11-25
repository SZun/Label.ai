import { afterEach, expect, it, vi } from 'vitest';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';

const state = vi.hoisted(() => ({
  send: vi.fn(async () => ({ allowed: true })),
  ui: vi.fn(),
}));
vi.mock('wxt/browser', () => ({
  browser: {
    extension: { inIncognitoContext: false },
    runtime: {
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      sendMessage: state.send,
    },
    storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
  },
}));
vi.mock('wxt/utils/content-script-ui/shadow-root', () => ({ createShadowRootUi: state.ui }));
vi.mock('../src/transport/settings', () => ({
  SETTINGS_KEY: 'localSettings',
  readSettings: async () => ({ enabled: true, consentVersion: 2 }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('requests native admission for a visible document when keyboard focus is in the browser UI', async () => {
  vi.stubGlobal('defineContentScript', (script: unknown) => script);
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      disconnect() {}
    },
  );
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  state.ui.mockResolvedValue({
    shadowHost: document.createElement('div'),
    mount() {},
    remove() {},
  });
  const dispose: Array<() => void> = [];
  const context = {
    onInvalidated: (listener: () => void) => dispose.push(listener),
    addEventListener: vi.fn(),
    setInterval: vi.fn(),
    requestAnimationFrame: vi.fn(),
  };
  const { default: script } = await import('../entrypoints/media.content/index');
  try {
    await script.main(context as unknown as ContentScriptContext);
    expect(state.send).toHaveBeenCalledWith({ type: 'label-ai:can-scan' });
  } finally {
    for (const cleanup of dispose) cleanup();
  }
});

it('waits for a CSS card to enter view and attempts an unreadable source only once', async () => {
  const source = 'https://public-cdn.example/cover.jpg';
  const card = document.body.appendChild(document.createElement('article'));
  card.style.backgroundImage = `url("${source}")`;
  vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200));
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  const fetchImage = vi.fn().mockRejectedValue(new TypeError('CORS denied'));
  vi.stubGlobal('fetch', fetchImage);
  vi.stubGlobal('defineContentScript', (script: unknown) => script);
  const observed = new Set<Element>();
  let intersect!: (batch: { target: Element; isIntersecting: boolean }[]) => void;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: typeof intersect) {
        intersect = callback;
      }
      observe(target: Element) {
        observed.add(target);
      }
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
  state.ui.mockResolvedValue({
    shadowHost: document.createElement('div'),
    mount() {},
    remove() {},
  });
  const dispose: Array<() => void> = [];
  const pendingFrames: Array<() => void> = [];
  const flush = async () => {
    while (pendingFrames.length) pendingFrames.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const context = {
    onInvalidated: (listener: () => void) => dispose.push(listener),
    addEventListener: vi.fn(),
    setInterval: vi.fn(),
    requestAnimationFrame: (callback: () => void) => pendingFrames.push(callback),
  };
  const { default: script } = await import('../entrypoints/media.content/index');
  try {
    await script.main(context as unknown as ContentScriptContext);
    await flush();
    expect(observed.has(card)).toBe(true);
    expect(fetchImage).not.toHaveBeenCalled();
    intersect([{ target: card, isIntersecting: true }]);
    await flush();
    expect(fetchImage).toHaveBeenCalledTimes(1);
    for (const visible of [false, true, true]) {
      intersect([{ target: card, isIntersecting: visible }]);
      await flush();
    }
    expect(fetchImage).toHaveBeenCalledTimes(1);
    // A successful read of a new photo can be reclassified when the publisher changes the crop.
    const next = 'https://public-cdn.example/new-cover.jpg';
    const jpeg = Uint8Array.of(255, 216, 255, 192, 0, 11, 8, 0, 20, 0, 30, 1, 1, 17, 0, 255, 217);
    const response = new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } });
    Object.defineProperties(response, { url: { value: next }, type: { value: 'cors' } });
    fetchImage.mockResolvedValueOnce(response);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 30, height: 20, close() {} })),
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage() {},
      getImageData: () => ({ data: new Uint8ClampedArray(30 * 20 * 4) }),
    } as unknown as CanvasRenderingContext2D);
    Object.defineProperties(card, { clientWidth: { value: 200 }, clientHeight: { value: 200 } });
    card.style.backgroundImage = `url("${next}")`;
    card.style.backgroundSize = 'cover';
    await flush();
    await flush();
    expect(fetchImage).toHaveBeenCalledTimes(2);
    card.style.backgroundSize = 'cover';
    card.style.backgroundPosition = '100% 50%';
    await flush();
    await flush();
    expect(fetchImage).toHaveBeenCalledTimes(3);
  } finally {
    for (const cleanup of dispose) cleanup();
    card.remove();
  }
});
