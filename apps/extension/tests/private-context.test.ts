import { afterEach, expect, it, vi } from 'vitest';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';

const ui = vi.hoisted(() =>
  vi.fn().mockRejectedValue(new Error('Overlay attempted in private tab')),
);
vi.mock('wxt/browser', () => ({ browser: { extension: { inIncognitoContext: true } } }));
vi.mock('wxt/utils/content-script-ui/shadow-root', () => ({ createShadowRootUi: ui }));
afterEach(() => vi.unstubAllGlobals());

it('leaves a private document before mounting an overlay or observing its media', async () => {
  vi.stubGlobal('defineContentScript', (script: unknown) => script);
  const { default: script } = await import('../entrypoints/media.content/index');
  await script.main({} as ContentScriptContext);
  expect(ui).not.toHaveBeenCalled();
});
