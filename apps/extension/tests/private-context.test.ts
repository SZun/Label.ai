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

it('checks every accessible frame ancestor before acquiring pixels and rejects an inaccessible parent', async () => {
  const { eligibleDocumentChain, DEFAULT_SETTINGS } = await import('../src/core/policy');
  const settings = DEFAULT_SETTINGS;
  function frame(url: string, password = false, parent?: Window) {
    const result = {
      location: new URL(url),
      document: { querySelectorAll: () => (password ? [{ closest: () => null }] : []) },
    } as unknown as Window;
    Object.defineProperty(result, 'parent', { value: parent ?? result });
    return result;
  }
  const top = frame('https://public.example/news');
  expect(eligibleDocumentChain(top, settings)).toBe(true);
  expect(eligibleDocumentChain(frame('https://public.example/embed', false, top), settings)).toBe(
    true,
  );
  const privateParent = frame('https://public.example/messages');
  expect(
    eligibleDocumentChain(frame('https://public.example/embed', false, privateParent), settings),
  ).toBe(false);
  const loginParent = frame('https://public.example/news', true);
  expect(
    eligibleDocumentChain(frame('https://public.example/embed', false, loginParent), settings),
  ).toBe(false);
  const inaccessible = Object.defineProperty({}, 'location', {
    get() {
      throw new DOMException('cross-origin');
    },
  }) as Window;
  expect(
    eligibleDocumentChain(frame('https://public.example/embed', false, inaccessible), settings),
  ).toBe(false);
});

it('allows a public player with a closed login dialog and stops when the form opens', async () => {
  const { eligibleDocumentChain, DEFAULT_SETTINGS } = await import('../src/core/policy');
  const frame = {
    location: new URL('https://public.example/watch'),
    document,
  } as unknown as Window;
  Object.defineProperty(frame, 'parent', { value: frame });
  document.body.innerHTML = '<video></video><dialog><form><input type="password"></form></dialog>';
  try {
    const dialog = document.querySelector('dialog')!;
    expect(eligibleDocumentChain(frame, DEFAULT_SETTINGS)).toBe(true);
    dialog.open = true;
    expect(eligibleDocumentChain(frame, DEFAULT_SETTINGS)).toBe(false);
    dialog.remove();
    document.body.innerHTML = '<div hidden><input type="password"></div><input type="password">';
    expect(eligibleDocumentChain(frame, DEFAULT_SETTINGS)).toBe(false);
    document.body.lastElementChild!.remove();
    expect(eligibleDocumentChain(frame, DEFAULT_SETTINGS)).toBe(true);
    document.body.firstElementChild!.removeAttribute('hidden');
    expect(eligibleDocumentChain(frame, DEFAULT_SETTINGS)).toBe(false);
  } finally {
    document.body.replaceChildren();
  }
});

it('scans a feed with a CSS-unmounted sign-in form and stops as soon as it is displayed', async () => {
  const { eligibleDocumentChain, DEFAULT_SETTINGS } = await import('../src/core/policy');
  const frame = { location: new URL('https://public.example/feed'), document } as unknown as Window;
  Object.defineProperty(frame, 'parent', { value: frame });
  document.body.innerHTML =
    '<style>.dormant { display: none }</style><div class="dormant"><form><input type="password"></form></div>';
  try {
    const layer = document.querySelector('div')!;
    expect(eligibleDocumentChain(frame, DEFAULT_SETTINGS)).toBe(true);
    layer.classList.remove('dormant');
    expect(eligibleDocumentChain(frame, DEFAULT_SETTINGS)).toBe(false);
    layer.style.opacity = '0';
    expect(eligibleDocumentChain(frame, DEFAULT_SETTINGS)).toBe(false);
  } finally {
    document.body.replaceChildren();
  }
});
