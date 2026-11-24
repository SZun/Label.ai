import { mount, unmount, flushSync } from 'svelte';
import { afterEach, expect, it } from 'vitest';
import SlopLabel from '../src/components/SlopLabel.svelte';

const mounted: ReturnType<typeof mount>[] = [];
afterEach(async () => {
  for (const app of mounted.splice(0)) await unmount(app);
  document.body.innerHTML = '';
});
it('UX-01, UX-04, UX-05 renders the exact static noninteractive SMUI label', () => {
  mounted.push(mount(SlopLabel, { target: document.body, props: { animate: false } }));
  flushSync();
  expect(document.body.textContent?.trim()).toBe('AI Slop Detected 🤮');
  expect(document.querySelector('.smui-paper')).not.toBeNull();
  expect(
    document.querySelector('button,[role="button"],[tabindex],[title],[role="tooltip"]'),
  ).toBeNull();
  expect(document.querySelector('[aria-hidden="true"]')?.textContent).toBe('🤮');
  expect(document.querySelector('.label--new')).toBeNull();
});

it('keeps the arrival animation attached across layout updates of the same badge', async () => {
  const { default: Overlay } = await import('../src/components/OverlayRoot.svelte');
  const overlay = mount(Overlay, { target: document.body });
  mounted.push(overlay);
  overlay.setLabels([{ key: 'media', x: 1, y: 1, animate: true }]);
  flushSync();
  const badge = document.querySelector('.label--new');
  expect(badge).not.toBeNull();
  overlay.setLabels([{ key: 'media', x: 4, y: 5, animate: false }]);
  flushSync();
  expect(document.querySelector('.label--new')).toBe(badge);
  overlay.setLabels([]);
  flushSync();
  overlay.setLabels([{ key: 'media', x: 4, y: 5, animate: false }]);
  flushSync();
  expect(document.querySelector('.slop-label')).not.toBeNull();
  expect(document.querySelector('.label--new')).toBeNull();
});
