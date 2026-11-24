import { browser } from 'wxt/browser';
import { createLocalDetector } from '@label-ai/detector';
import { isEligiblePage, type LocalSettings } from '../src/core/policy';
import { isAnalyzeRequest, decodeBase64, type AnalyzeRequest, type LocalDecision } from '../src/core/protocol';
import { BoundedQueue } from '../src/core/queue';
import { readSettings, SETTINGS_KEY } from '../src/transport/settings';
import { localProvenance, clearProvenance } from '../src/transport/provenance';

export default defineBackground(() => {
  const queue = new BoundedQueue(1, 8);
  let detector: ReturnType<typeof createLocalDetector> | undefined;
  const pending = new Map<string, { tabId: number; documentId: string; abort: AbortController; finish: (result: LocalDecision) => void; input: AnalyzeRequest }>();

  const noLabel = (input: AnalyzeRequest, status: LocalDecision['status'] = 'FAILED'): LocalDecision => ({ instanceId: input.instanceId, requestId: input.requestId, generation: input.generation, status, shouldLabel: false, policyVersion: 'local-v1', expiresAt: Date.now() });
  const scopedKey = (tabId: number, documentId: string, requestId: string) => `${tabId}:${documentId}:${requestId}`;

  async function updateRegistration() {
    const settings = await readSettings();
    const origins: string[] = [];
    if (settings.enabled) for (const origin of settings.approvedOrigins) if (await browser.permissions.contains({ origins: [`${origin}/*`] })) origins.push(`${origin}/*`);
    const scripts = await browser.scripting.getRegisteredContentScripts();
    if (scripts.some((script) => script.id === 'label-ai-media')) await browser.scripting.unregisterContentScripts({ ids: ['label-ai-media'] });
    if (origins.length) await browser.scripting.registerContentScripts([{ id: 'label-ai-media', js: ['content-scripts/media.js'], matches: origins, allFrames: true, runAt: 'document_idle', persistAcrossSessions: true }]);
  }
  let registration = Promise.resolve();
  const syncRegistration = () => { registration = registration.then(updateRegistration).catch(() => {}); };

  async function validSender(sender: Parameters<Parameters<typeof browser.runtime.onMessage.addListener>[0]>[1], settings: LocalSettings) {
    if (sender.id !== browser.runtime.id || !sender.tab?.id || sender.tab.incognito || !sender.url || !isEligiblePage(sender.url, settings)) return false;
    if (!await browser.permissions.contains({ origins: [`${new URL(sender.url).origin}/*`] })) return false;
    const tab = await browser.tabs.get(sender.tab.id);
    return tab.active && !tab.incognito;
  }

  async function analyze(input: AnalyzeRequest, sender: Parameters<Parameters<typeof browser.runtime.onMessage.addListener>[0]>[1]): Promise<LocalDecision> {
    if (!await validSender(sender, await readSettings())) return noLabel(input);
    const tabId = sender.tab!.id!;
    const documentId = sender.documentId ?? `${sender.frameId ?? 0}:${sender.url}`;
    const key = scopedKey(tabId, documentId, input.requestId);
    if (pending.has(key)) return noLabel(input);
    return new Promise((finish) => {
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 45_000);
      pending.set(key, { tabId, documentId, abort, finish, input });
      const accepted = queue.enqueue(key, async () => {
        try {
          if (abort.signal.aborted || !await validSender(sender, await readSettings())) { finish(noLabel(input, 'CANCELED')); return; }
          const original = input.original;
          if (original) {
            const provenance = await localProvenance(original);
            if (provenance?.shouldLabel === true && !abort.signal.aborted && await validSender(sender, await readSettings())) {
              finish({ ...noLabel(input, 'COMPLETED'), shouldLabel: true, policyVersion: provenance.policyVersion, expiresAt: Date.now() + 60_000 });
              return;
            }
          }
          if (abort.signal.aborted) { finish(noLabel(input, 'CANCELED')); return; }
          detector ??= createLocalDetector({ assetBaseUrl: new URL('models/', browser.runtime.getURL('/options.html')).href });
          const engine = await detector;
          const decode = (frame: NonNullable<AnalyzeRequest['frame']>) => {
            const rgba = decodeBase64(frame.rgba, frame.width * frame.height * 4);
            if (rgba.length !== frame.width * frame.height * 4) throw new Error('Invalid pixel buffer');
            return { ...frame, rgba };
          };
          const result = input.kind === 'image'
            ? await engine.analyzeRgba({ ...decode(input.frame!), signal: abort.signal })
            : await engine.analyzeVideoFrames({ frames: input.frames!.map(decode), durationMs: input.durationMs!, coverage: input.coverage, signal: abort.signal });
          const allowed = !abort.signal.aborted && await validSender(sender, await readSettings());
          finish({ ...noLabel(input, result.status), shouldLabel: allowed && result.shouldLabel, policyVersion: result.policyVersion, expiresAt: Date.now() + 60_000 });
        } catch { detector = undefined; finish(noLabel(input)); }
        finally { clearTimeout(timeout); pending.delete(key); }
      });
      if (!accepted) { clearTimeout(timeout); pending.delete(key); finish(noLabel(input, 'UNSUPPORTED')); }
    });
  }

  async function clear() {
    queue.clear();
    for (const job of pending.values()) { job.abort.abort(); job.finish(noLabel(job.input, 'CANCELED')); }
    pending.clear();
    if (detector) { try { (await detector).dispose(); } catch { /* Failed initialization owns no usable session. */ } detector = undefined; }
    await clearProvenance();
  }

  browser.runtime.onMessage.addListener((message, sender) => {
    if (isAnalyzeRequest(message)) return analyze(message, sender);
    if (message?.type === 'label-ai:cancel' && sender.id === browser.runtime.id && sender.tab?.id) {
      const documentId = sender.documentId ?? `${sender.frameId ?? 0}:${sender.url}`;
      const key = scopedKey(sender.tab.id, documentId, message.requestId);
      const job = pending.get(key);
      if (job) { job.abort.abort(); queue.cancel(key); job.finish(noLabel(job.input, 'CANCELED')); pending.delete(key); }
    }
    if (message?.type === 'label-ai:clear' && sender.url?.startsWith(browser.runtime.getURL('/options.html'))) return clear().then(() => ({ cleared: true }));
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) { void clear(); syncRegistration(); }
  });
  browser.permissions.onRemoved.addListener(() => { void clear(); syncRegistration(); });
  browser.runtime.onInstalled.addListener(syncRegistration);
  browser.runtime.onStartup.addListener(syncRegistration);
  browser.action.onClicked.addListener(() => { void browser.runtime.openOptionsPage(); });
  syncRegistration();
});
