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
