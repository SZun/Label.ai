import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LocalDecision } from '../src/core/protocol';

const state = vi.hoisted(() => ({
  focused: true,
  storedSettings: undefined as unknown,
  hostAllowed: true,
  activeTab: undefined as
    | undefined
    | { id: number; url: string; status: string; incognito: boolean; windowId: number },
  register: vi.fn(),
  unregister: vi.fn(),
  inject: vi.fn(),
  ping: vi.fn(),
  hooks: {} as Record<string, ((...args: any[]) => any)[]>,
  verify: vi.fn(),
  registered: vi.fn(),
  detector: vi.fn(),
  inference: vi.fn(),
  videoInference: vi.fn(),
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
            localSettings: state.storedSettings,
          })),
          set: vi.fn(async ({ localSettings }) => {
            state.storedSettings = localSettings;
          }),
        },
        onChanged: event('storage'),
      },
      permissions: {
        contains: vi.fn(async () => state.hostAllowed),
        onAdded: event('added'),
        onRemoved: event('revoked'),
      },
      scripting: {
        getRegisteredContentScripts: state.registered,
        registerContentScripts: state.register,
        unregisterContentScripts: state.unregister,
        executeScript: state.inject,
      },
      tabs: {
        query: vi.fn(async () => (state.activeTab ? [state.activeTab] : [])),
        sendMessage: state.ping,
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
vi.mock('@label-ai/detector', () => ({ createLocalDetector: state.detector }));
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
async function sendImage(url: string, includeOriginal = false): Promise<LocalDecision> {
  return state.hooks.message[0](
    {
      type: 'label-ai:analyze',
      kind: 'image',
      instanceId: 'test-image',
      generation: 0,
      requestId: 'test-image-request',
      frame: { width: 1, height: 1, timestampMs: 0, rgba: 'AAAA/w==' },
      ...(includeOriginal && { original: { mime: 'image/png', base64: 'AQID' } }),
    },
    {
      id: 'test',
      url,
      documentId: 'test-document',
      tab: { id: 1, windowId: 7, incognito: false },
    },
  );
}
async function startWorker() {
  state.hooks = {};
  vi.resetModules();
  const { default: start } = await import('../entrypoints/background');
  (start as unknown as () => void)();
  await flush();
}
beforeEach(async () => {
  vi.useFakeTimers();
  state.focused = true;
  state.storedSettings = undefined;
  state.hostAllowed = true;
  state.activeTab = undefined;
  state.register.mockReset().mockResolvedValue(undefined);
  state.unregister.mockReset().mockResolvedValue(undefined);
  state.inject.mockReset().mockResolvedValue([]);
  state.ping.mockReset().mockRejectedValue(new Error('No content scanner'));
  state.verify.mockReset();
  state.registered.mockReset().mockResolvedValue([]);
  state.inference.mockReset();
  state.videoInference.mockReset();
  state.detector.mockReset().mockResolvedValue({
    analyzeRgba: state.inference,
    analyzeVideoFrames: state.videoInference,
    dispose: vi.fn(),
  });
  vi.stubGlobal('defineBackground', (main: () => void) => main);
  await startWorker();
});

it('keeps the permissive local-test threshold confined to the loopback build', async () => {
  const loopback = 'http://127.0.0.1:8765';
  state.inference.mockResolvedValue({
    status: 'COMPLETED',
    shouldLabel: false,
    policyVersion: 'local-v1-unvalidated',
    rawScore: 0.25,
  });
  expect((await sendImage(loopback)).shouldLabel).toBe(false);
  vi.stubGlobal('__LABEL_AI_LOCAL_TEST__', true);
  await startWorker();
  const positive = await sendImage(loopback);
  expect(positive.shouldLabel).toBe(true);
  expect(positive.policyVersion).toBe('local-test-raw-v1');
  expect((await sendImage('https://news.example')).shouldLabel).toBe(false);
  expect((await sendImage('http://127.0.0.1:8766')).shouldLabel).toBe(true);
  state.focused = false;
  expect((await sendImage(loopback)).shouldLabel).toBe(false);
  expect(state.inference).toHaveBeenCalledTimes(3);
});
it('labels unsigned media on an ordinary website using the regular browsing policy', async () => {
  const url = 'https://news.example/story';
  state.inference.mockResolvedValue({
    status: 'COMPLETED',
    shouldLabel: false,
    policyVersion: 'local-v1-unvalidated',
    rawScore: 0.65,
  });
  const result = await sendImage(url);
  expect(result.shouldLabel).toBe(true);
  expect(result.policyVersion).toBe('browsing-model-estimate-v1');
  state.hostAllowed = false;
  expect((await sendImage(url)).shouldLabel).toBe(false);
  expect(state.inference).toHaveBeenCalledTimes(1);
});

it('respects a verified non-generation or ambiguous credential on a high-scoring original', async () => {
  state.verify.mockResolvedValue({
    shouldLabel: false,
    status: 'verified-other',
    policyVersion: 'verified',
  });
  state.inference.mockResolvedValue({ status: 'COMPLETED', shouldLabel: false, rawScore: 0.999 });
  const result = await sendImage('https://news.example/story', true);
  expect(result.status).toBe('COMPLETED');
  expect(result.shouldLabel).toBe(false);
  expect(result.verifiedOriginal).toBe(true);
  const videoOriginal = await send('verified-mp4', 1);
  expect(videoOriginal.shouldLabel).toBe(false);
  expect(videoOriginal.verifiedOriginal).toBe(true);
  expect(state.inference).not.toHaveBeenCalled();
});

it('uses multiple eligible video frames in the regular browsing policy', async () => {
  const frames = Array.from({ length: 8 }, (_, index) => ({
    width: 1,
    height: 1,
    rgba: 'AAAA/w==',
    timestampMs: index * 500,
  }));
  state.videoInference.mockResolvedValue({
    status: 'COMPLETED',
    shouldLabel: false,
    rawScore: 0.93,
    temporal: { eligible: true },
  });
  const response = await state.hooks.message[0](
    {
      type: 'label-ai:analyze',
      kind: 'video',
      instanceId: 'clip',
      generation: 0,
      requestId: 'clip',
      frames,
      durationMs: 3500,
      coverage: 1,
    },
    {
      id: 'test',
      url: 'https://film.example/watch',
      tab: { id: 1, windowId: 7, incognito: false },
    },
  );
  expect(response.shouldLabel).toBe(true);
  expect(response.policyVersion).toBe('browsing-model-estimate-v1');
  expect(state.videoInference.mock.calls[0][0].frames).toHaveLength(8);
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

it('returns retryable backpressure when the local background queue is full', async () => {
  state.verify.mockReturnValue(new Promise(() => {}));
  const pending = Array.from({ length: 8 }, (_, index) => send('pending-' + index, 1));
  await flush();
  const full = await send('full', 1);
  expect(full.status).toBe('BUSY');
  expect(full.shouldLabel).toBe(false);
  state.hooks.removed[0](1);
  expect((await Promise.all(pending)).every((result) => result.status === 'CANCELED')).toBe(true);
});

it('does not analyze when the sending tab private state is not known', async () => {
  state.verify.mockResolvedValue({ shouldLabel: true, policyVersion: 'verified' });
  const reply = await state.hooks.message[0](
    {
      type: 'label-ai:analyze',
      kind: 'video',
      instanceId: 'video',
      generation: 0,
      requestId: 'unknown-private',
      original: { mime: 'video/mp4', base64: 'AQID' },
    },
    { id: 'test', url: 'https://news.example/story', tab: { id: 1, windowId: 7 } },
  );
  expect(reply.shouldLabel).toBe(false);
  expect(state.verify).not.toHaveBeenCalled();
});

it('preserves an equivalent persistent content registration when a worker restarts', async () => {
  const { browser } = await import('wxt/browser');
  const getRegistered = state.registered;
  const register = vi.mocked(browser.scripting.registerContentScripts);
  const unregister = vi.mocked(browser.scripting.unregisterContentScripts);
  register.mockClear();
  unregister.mockClear();
  getRegistered.mockResolvedValueOnce([
    {
      id: 'label-ai-media',
      js: ['content-scripts/media.js'],
      matches: ['http://*/*', 'https://*/*'],
      allFrames: true,
      runAt: 'document_idle',
      persistAcrossSessions: true,
    },
  ]);
  state.hooks.startup[0]();
  await flush();
  expect(unregister).not.toHaveBeenCalled();
  expect(register).not.toHaveBeenCalled();
});

it('registers all eligible sites at startup without opening options, and injects the active tab', async () => {
  state.register.mockClear();
  state.inject.mockClear();
  state.activeTab = {
    id: 1,
    url: 'https://elsewhere.example/story',
    status: 'complete',
    incognito: false,
    windowId: 7,
  };
  await startWorker();
  expect(state.register).toHaveBeenCalledWith([
    expect.objectContaining({ id: 'label-ai-media', matches: ['http://*/*', 'https://*/*'] }),
  ]);
  expect(state.inject).toHaveBeenCalledWith({
    target: { tabId: 1, allFrames: true },
    files: ['/content-scripts/media.js'],
  });
});

it('native withheld access fails closed for both capture admission and inference', async () => {
  state.hostAllowed = false;
  state.verify.mockResolvedValue({ shouldLabel: true, policyVersion: 'verified' });
  state.activeTab = {
    id: 1,
    url: 'https://elsewhere.example/story',
    status: 'complete',
    incognito: false,
    windowId: 7,
  };
  state.inject.mockClear();
  await startWorker();
  expect(state.inject).not.toHaveBeenCalled();
  expect(
    await state.hooks.message[0](
      { type: 'label-ai:can-scan' },
      {
        id: 'test',
        url: 'https://elsewhere.example/story',
        tab: { id: 1, windowId: 7, incognito: false },
      },
    ),
  ).toEqual({ allowed: false });
  expect((await send('no-site-access', 1)).shouldLabel).toBe(false);
  expect(state.verify).not.toHaveBeenCalled();
});

it('a migrated global pause persists, prevents registration, and permits global resume', async () => {
  state.storedSettings = {
    enabled: false,
    consentVersion: 1,
    approvedOrigins: ['https://news.example'],
  };
  state.register.mockClear();
  state.hooks.install[0]();
  await flush();
  expect(state.storedSettings).toEqual({ enabled: false, consentVersion: 2 });
  expect(state.register).not.toHaveBeenCalled();
  expect(
    await state.hooks.message[0](
      { type: 'label-ai:can-scan' },
      {
        id: 'test',
        url: 'https://elsewhere.example/story',
        tab: { id: 1, windowId: 7, incognito: false },
      },
    ),
  ).toEqual({ allowed: false });
  state.storedSettings = { enabled: true, consentVersion: 2 };
  state.hooks.storage[0]({ localSettings: { newValue: state.storedSettings } }, 'local');
  await flush();
  expect(state.register).toHaveBeenCalledWith([
    expect.objectContaining({ matches: ['http://*/*', 'https://*/*'] }),
  ]);
  expect(
    await state.hooks.message[0](
      { type: 'label-ai:can-scan' },
      {
        id: 'test',
        url: 'https://elsewhere.example/story',
        tab: { id: 1, windowId: 7, incognito: false },
      },
    ),
  ).toEqual({ allowed: true });
});

it('injects on activation when the active site was opened during pause or while its grant was withheld', async () => {
  state.activeTab = {
    id: 1,
    url: 'https://elsewhere.example/story',
    status: 'complete',
    incognito: false,
    windowId: 7,
  };
  state.inject.mockClear();
  state.hooks.activated[0]({ tabId: 1, windowId: 7 });
  await flush();
  expect(state.ping).toHaveBeenCalledWith(1, { type: 'label-ai:scanner-present' }, { frameId: 0 });
  expect(state.inject).toHaveBeenCalledOnce();
  state.ping.mockResolvedValue({ present: true });
  state.hooks.activated[0]({ tabId: 1, windowId: 7 });
  await flush();
  expect(state.inject).toHaveBeenCalledOnce();
});

it('injects the active page after restored native permission, without duplicate scanners', async () => {
  state.activeTab = {
    id: 1,
    url: 'https://elsewhere.example/story',
    status: 'complete',
    incognito: false,
    windowId: 7,
  };
  state.registered.mockResolvedValue([
    {
      id: 'label-ai-media',
      js: ['content-scripts/media.js'],
      matches: ['http://*/*', 'https://*/*'],
      allFrames: true,
      runAt: 'document_idle',
      persistAcrossSessions: true,
    },
  ]);
  state.inject.mockClear();
  state.hooks.added[0]();
  await flush();
  expect(state.inject).toHaveBeenCalledOnce();
});
