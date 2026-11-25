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
