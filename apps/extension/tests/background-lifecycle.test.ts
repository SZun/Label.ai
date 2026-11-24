import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LocalDecision } from '../src/core/protocol';

const state = vi.hoisted(() => ({
  focused: true,
  hooks: {} as Record<string, ((...args: any[]) => any)[]>,
  verify: vi.fn(),
}));
vi.mock('wxt/browser', () => {
  const event = (name: string) => ({
    addListener: (listener: (...args: any[]) => any) => (state.hooks[name] ??= []).push(listener),
  });
  return {
    browser: {
      runtime: {
        id: 'test',
        getURL: (path: string) => `chrome-extension://test/${path.replace(/^\//, '')}`,
        onMessage: event('message'),
        onInstalled: event('install'),
        onStartup: event('startup'),
        openOptionsPage: vi.fn(),
      },
      storage: {
        local: {
          get: vi.fn(async () => ({
            localSettings: {
              enabled: true,
              consentVersion: 1,
              approvedOrigins: ['https://news.example'],
            },
          })),
          set: vi.fn(),
        },
        onChanged: event('storage'),
      },
      permissions: {
        contains: vi.fn(async () => true),
        onAdded: event('added'),
        onRemoved: event('revoked'),
      },
      scripting: {
        getRegisteredContentScripts: vi.fn(async () => []),
        registerContentScripts: vi.fn(),
        unregisterContentScripts: vi.fn(),
      },
      tabs: {
        get: vi.fn(async () => ({ active: true, incognito: false, windowId: 7 })),
        onActivated: event('activated'),
        onRemoved: event('removed'),
      },
      windows: {
        get: vi.fn(async () => ({ focused: state.focused })),
        onFocusChanged: event('focus'),
      },
      action: { onClicked: event('action') },
    },
  };
});
vi.mock('@label-ai/detector', () => ({ createLocalDetector: vi.fn() }));
vi.mock('@label-ai/provenance', () => ({ PROVENANCE_TRUST_EXPIRES_AT: '2027-12-31T00:00:00Z' }));
vi.mock('../src/transport/provenance', () => ({
  localProvenance: state.verify,
  clearProvenance: vi.fn(),
}));

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
async function send(requestId: string, tabId: number): Promise<LocalDecision> {
  return state.hooks.message[0](
    {
      type: 'label-ai:analyze',
      kind: 'video',
      instanceId: 'video',
      generation: 0,
      requestId,
      original: { mime: 'video/mp4', base64: 'AQID' },
    },
    {
      id: 'test',
      url: 'https://news.example/story',
      documentId: `document-${tabId}`,
      tab: { id: tabId, windowId: 7, incognito: false },
    },
  );
}
beforeEach(async () => {
  vi.useFakeTimers();
  state.focused = true;
  state.hooks = {};
  state.verify.mockReset();
  vi.stubGlobal('defineBackground', (main: () => void) => main);
  const { default: start } = await import('../entrypoints/background');
  (start as unknown as () => void)();
  await flush();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('immediately settles a canceled queued job and releases its deadline', async () => {
  let complete!: (value: { shouldLabel: boolean; policyVersion: string }) => void;
  state.verify.mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const a = send('a', 1);
  await flush();
  const b = send('b', 2);
  await flush();
  expect(state.verify).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(2);
  state.hooks.removed[0](2);
  await flush();
  expect((await b).status).toBe('CANCELED');
  expect(vi.getTimerCount()).toBe(1);
  complete({ shouldLabel: true, policyVersion: 'verified' });
  expect((await a).shouldLabel).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not analyze an active tab in an unfocused window', async () => {
  state.focused = false;
  state.verify.mockResolvedValue({ shouldLabel: true, policyVersion: 'verified' });
  const result = await send('hidden-window', 1);
  expect(result.shouldLabel).toBe(false);
  expect(state.verify).not.toHaveBeenCalled();
});

it('cancels running work immediately when its window loses focus', async () => {
  state.verify.mockReturnValue(new Promise(() => {}));
  const result = send('background-window', 1);
  await flush();
  expect(state.hooks.focus).toHaveLength(1);
  state.hooks.focus[0](-1);
  await flush();
  expect((await result).status).toBe('CANCELED');
  expect(vi.getTimerCount()).toBe(0);
});
