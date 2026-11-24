import { browser } from 'wxt/browser';
import { createLocalDetector } from '@label-ai/detector';
import { PROVENANCE_TRUST_EXPIRES_AT } from '@label-ai/provenance';
import {
  hostPermissionPattern,
  isEligiblePage,
  SCAN_MATCHES,
  type LocalSettings,
} from '../src/core/policy';
import {
  LOCAL_TEST_BUILD,
  LOCAL_TEST_POLICY_VERSION,
  localTestDecision,
} from '../src/core/local-test';
import {
  isAnalyzeRequest,
  decodeBase64,
  type AnalyzeRequest,
  type LocalDecision,
} from '../src/core/protocol';
import { BoundedQueue } from '../src/core/queue';
import { BROWSING_MODEL_POLICY_VERSION, browsingModelLabel } from '../src/core/model-label';
import { migrateSettings, readSettings, SETTINGS_KEY } from '../src/transport/settings';
import { localProvenance, clearProvenance } from '../src/transport/provenance';

export default defineBackground(() => {
  const queue = new BoundedQueue(1, 8);
  let detector: ReturnType<typeof createLocalDetector> | undefined;
  const injectingTabs = new Set<number>();
  const pending = new Map<
    string,
    {
      tabId: number;
      windowId: number;
      documentId: string;
      abort: AbortController;
      finish: (result: LocalDecision) => void;
      input: AnalyzeRequest;
    }
  >();

  const noLabel = (
    input: AnalyzeRequest,
    status: LocalDecision['status'] = 'FAILED',
  ): LocalDecision => ({
    instanceId: input.instanceId,
    requestId: input.requestId,
    generation: input.generation,
    status,
    shouldLabel: false,
    policyVersion: 'local-v1',
    expiresAt: Date.now(),
  });
  const scopedKey = (tabId: number, documentId: string, requestId: string) =>
    `${tabId}:${documentId}:${requestId}`;

  async function updateRegistration() {
    const settings = await readSettings();
    // Browser native site controls enforce withheld host grants at injection
    // time. Register the broad declared scope once, even if the user chooses
    // to restrict this extension to a subset of those hosts in browser settings.
    const origins = settings.enabled ? SCAN_MATCHES : [];
    const scripts = await browser.scripting.getRegisteredContentScripts();
    const existing = scripts.find((script) => script.id === 'label-ai-media');
    // MV3 workers wake on ordinary messages. Keep an equivalent persistent registration
    // instead of briefly leaving all permitted sites unregistered on every wake.
    if (
      existing &&
      origins.length > 0 &&
      existing.matches?.length === origins.length &&
      origins.every((origin) => existing.matches?.includes(origin)) &&
      existing.js?.length === 1 &&
      existing.js[0].replace(/^\//, '') === 'content-scripts/media.js' &&
      existing.allFrames === true &&
      existing.runAt === 'document_idle' &&
      existing.persistAcrossSessions !== false
    )
      return;
    if (existing) await browser.scripting.unregisterContentScripts({ ids: ['label-ai-media'] });
    if (origins.length) {
      await browser.scripting.registerContentScripts([
        {
          id: 'label-ai-media',
          js: ['content-scripts/media.js'],
          matches: origins,
          allFrames: true,
          runAt: 'document_idle',
          persistAcrossSessions: true,
        },
      ]);
      // Registration takes effect on subsequent navigations. Give the current
      // completed, eligible, granted tab a scanner immediately as well.
      await injectActiveTab(settings);
    }
  }

  async function injectActiveTab(settings: LocalSettings, expectedTabId?: number) {
    if (!settings.enabled) return;
    let ownedTabId: number | undefined;
    try {
      const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      if (
        tab?.id === undefined ||
        (expectedTabId !== undefined && tab.id !== expectedTabId) ||
        tab.status !== 'complete' ||
        !tab.url ||
        tab.incognito !== false ||
        !isEligiblePage(tab.url, settings) ||
        injectingTabs.has(tab.id)
      )
        return;
      ownedTabId = tab.id;
      injectingTabs.add(tab.id);
      const pattern = hostPermissionPattern(tab.url);
      if (
        !pattern ||
        !(await browser.permissions.contains({ origins: [pattern] })) ||
        !(await browser.windows.get(tab.windowId)).focused
      )
        return;
      try {
        // Existing scripts resume through the storage listener. Only missing
        // scanners, including tabs opened during a pause, need reinjection.
        const reply = await browser.tabs.sendMessage(
          tab.id,
          { type: 'label-ai:scanner-present' },
          { frameId: 0 },
        );
        if (reply?.present === true) return;
      } catch {
        // No receiving end is expected if the tab has never been injected.
      }
      if (!(await readSettings()).enabled) return;
      await browser.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['/content-scripts/media.js'],
      });
    } catch {
      // Browser-controlled site restrictions can forbid injection. Native
      // registration still covers subsequent permitted navigations.
    } finally {
      if (ownedTabId !== undefined) injectingTabs.delete(ownedTabId);
    }
  }
  let registration = Promise.resolve();
  const syncRegistration = () => {
    registration = registration.catch(() => {}).then(updateRegistration);
    return registration;
  };

  async function validSender(
    sender: Parameters<Parameters<typeof browser.runtime.onMessage.addListener>[0]>[1],
    settings: LocalSettings,
  ) {
    if (
      sender.id !== browser.runtime.id ||
      typeof sender.tab?.id !== 'number' ||
      sender.tab.incognito !== false ||
      !sender.url ||
      !isEligiblePage(sender.url, settings)
    )
      return false;
    if (!(await browser.permissions.contains({ origins: [hostPermissionPattern(sender.url)!] })))
      return false;
    const tab = await browser.tabs.get(sender.tab.id);
    if (!tab.active || tab.incognito !== false) return false;
    if (
      sender.frameId !== undefined &&
      sender.frameId > 0 &&
      (!tab.url ||
        !isEligiblePage(tab.url, settings) ||
        new URL(tab.url).origin !== new URL(sender.url).origin)
    )
      return false;
    return (await browser.windows.get(tab.windowId)).focused;
  }

  async function analyze(
    input: AnalyzeRequest,
    sender: Parameters<Parameters<typeof browser.runtime.onMessage.addListener>[0]>[1],
  ): Promise<LocalDecision> {
    if (!(await validSender(sender, await readSettings()))) return noLabel(input);
    const tabId = sender.tab!.id!;
    const documentId = sender.documentId ?? `${sender.frameId ?? 0}:${sender.url}`;
    const key = scopedKey(tabId, documentId, input.requestId);
    if (pending.has(key)) return noLabel(input);
    return new Promise((resolve) => {
      const abort = new AbortController();
      let settled = false;
      const finish = (result: LocalDecision) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        queue.cancel(key);
        pending.delete(key);
        resolve(result);
      };
      const timeout = setTimeout(() => {
        abort.abort();
        finish(noLabel(input, 'CANCELED'));
      }, 45_000);
      pending.set(key, { tabId, windowId: sender.tab!.windowId, documentId, abort, finish, input });
      const accepted = queue.enqueue(key, async () => {
        try {
          if (abort.signal.aborted || !(await validSender(sender, await readSettings()))) {
            finish(noLabel(input, 'CANCELED'));
            return;
          }
          const original = input.original;
          if (original) {
            const provenance = await localProvenance(original, abort.signal);
            if (
              (provenance?.shouldLabel === true || provenance?.status === 'verified-other') &&
              !abort.signal.aborted &&
              (await validSender(sender, await readSettings()))
            ) {
              finish({
                ...noLabel(input, 'COMPLETED'),
                shouldLabel: provenance.shouldLabel,
                verifiedOriginal: true,
                policyVersion: provenance.policyVersion,
                expiresAt: Math.min(Date.now() + 60_000, Date.parse(PROVENANCE_TRUST_EXPIRES_AT)),
              });
              return;
            }
          }
          if (abort.signal.aborted) {
            finish(noLabel(input, 'CANCELED'));
            return;
          }
          if (input.kind === 'video' && !input.frames) {
            finish(noLabel(input, 'UNSUPPORTED'));
            return;
          }
          detector ??= createLocalDetector({
            assetBaseUrl: new URL('models/', browser.runtime.getURL('/options.html')).href,
          });
          const engine = await detector;
          const decode = (frame: NonNullable<AnalyzeRequest['frame']>) => {
            const rgba = decodeBase64(frame.rgba, frame.width * frame.height * 4);
            if (rgba.length !== frame.width * frame.height * 4)
              throw new Error('Invalid pixel buffer');
            return { ...frame, rgba };
          };
          const result =
            input.kind === 'image'
              ? await engine.analyzeRgba({ ...decode(input.frame!), signal: abort.signal })
              : await engine.analyzeVideoFrames({
                  frames: input.frames!.map(decode),
                  durationMs: input.durationMs!,
                  coverage: input.coverage,
                  signal: abort.signal,
                });
          const allowed =
            !abort.signal.aborted && (await validSender(sender, await readSettings()));
          const estimated = LOCAL_TEST_BUILD
            ? localTestDecision(true, sender.url, input.kind, result)
            : browsingModelLabel(input.kind, result);
          const estimateVersion = LOCAL_TEST_BUILD
            ? LOCAL_TEST_POLICY_VERSION
            : BROWSING_MODEL_POLICY_VERSION;
          finish({
            ...noLabel(input, result.status),
            shouldLabel:
              allowed && result.status === 'COMPLETED' && (result.shouldLabel || estimated),
            policyVersion:
              result.shouldLabel || !estimated ? result.policyVersion : estimateVersion,
            expiresAt: Date.now() + 60_000,
          });
        } catch {
          detector = undefined;
          finish(noLabel(input));
        } finally {
          clearTimeout(timeout);
          pending.delete(key);
        }
      });
      if (!accepted) {
        clearTimeout(timeout);
        pending.delete(key);
        finish(noLabel(input, 'BUSY'));
      }
    });
  }

  async function clear() {
    queue.clear();
    for (const job of pending.values()) {
      job.abort.abort();
      job.finish(noLabel(job.input, 'CANCELED'));
    }
    pending.clear();
    const previous = detector;
    detector = undefined;
    if (previous) {
      try {
        await (await previous).dispose();
      } catch {
        /* Failed initialization owns no usable session. */
      }
    }
    await clearProvenance();
  }

  browser.runtime.onMessage.addListener((message, sender) => {
    if (isAnalyzeRequest(message)) return analyze(message, sender);
    if (message?.type === 'label-ai:can-scan')
      return readSettings()
        .then((settings) => validSender(sender, settings))
        .then(
          (allowed) => ({ allowed }),
          () => ({ allowed: false }),
        );
    if (message?.type === 'label-ai:cancel' && sender.id === browser.runtime.id && sender.tab?.id) {
      const documentId = sender.documentId ?? `${sender.frameId ?? 0}:${sender.url}`;
      const key = scopedKey(sender.tab.id, documentId, message.requestId);
      const job = pending.get(key);
      if (job) {
        job.abort.abort();
        queue.cancel(key);
        job.finish(noLabel(job.input, 'CANCELED'));
        pending.delete(key);
      }
    }
    if (
      message?.type === 'label-ai:clear' &&
      sender.url?.startsWith(browser.runtime.getURL('/options.html'))
    )
      return clear().then(() => ({ cleared: true }));
    if (
      message?.type === 'label-ai:sync' &&
      sender.id === browser.runtime.id &&
      sender.url?.startsWith(browser.runtime.getURL('/options.html'))
    )
      return syncRegistration().then(() => ({ registered: true }));
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) {
      void clear();
      void syncRegistration().catch(() => {});
    }
  });
  browser.permissions.onRemoved.addListener(() => {
    void clear();
  });
  browser.permissions.onAdded.addListener(() => {
    void syncRegistration()
      .then(readSettings)
      .then((settings) => injectActiveTab(settings))
      .catch(() => {});
  });
  browser.tabs.onActivated.addListener(({ tabId }) => {
    for (const [key, job] of pending)
      if (job.tabId !== tabId) {
        job.abort.abort();
        queue.cancel(key);
        job.finish(noLabel(job.input, 'CANCELED'));
      }
    void readSettings()
      .then((settings) => injectActiveTab(settings, tabId))
      .catch(() => {});
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    for (const [key, job] of pending)
      if (job.tabId === tabId) {
        job.abort.abort();
        queue.cancel(key);
        job.finish(noLabel(job.input, 'CANCELED'));
      }
  });
  browser.windows.onFocusChanged.addListener((windowId) => {
    for (const job of pending.values())
      if (job.windowId !== windowId) {
        job.abort.abort();
        job.finish(noLabel(job.input, 'CANCELED'));
      }
  });
  browser.runtime.onInstalled.addListener(() => {
    void migrateSettings()
      .then(syncRegistration)
      .catch(() => {});
  });
  browser.runtime.onStartup.addListener(() => {
    void syncRegistration().catch(() => {});
  });
  browser.action.onClicked.addListener(() => {
    void browser.runtime.openOptionsPage();
  });
  void syncRegistration().catch(() => {});
});
