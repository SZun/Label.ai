import { mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PlayerPopup from '../src/components/PlayerPopup.svelte';

const api = vi.hoisted(() => ({ query: vi.fn(), sendMessage: vi.fn(), openOptionsPage: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: { tabs: api, runtime: api } }));
let app: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  vi.resetAllMocks();
  api.query.mockResolvedValue([{ id: 8, incognito: false }]);
});
afterEach(async () => {
  if (app) await unmount(app);
});

it('reports a completed scan for the active tab and offers settings', async () => {
  api.sendMessage.mockResolvedValue('below-threshold');
  app = mount(PlayerPopup, { target: document.body });
  await vi.waitFor(() =>
    expect(document.querySelector('[role=status]')?.textContent).toContain('insufficient evidence'),
  );
  expect(api.sendMessage).toHaveBeenCalledWith(
    8,
    { type: 'label-ai:player-status' },
    { frameId: 0 },
  );
  document.querySelector('button')!.click();
  expect(api.openOptionsPage).toHaveBeenCalledOnce();
});
it('never queries private players and handles missing permissions', async () => {
  api.query.mockResolvedValue([{ id: 9, incognito: true }]);
  app = mount(PlayerPopup, { target: document.body });
  await vi.waitFor(() =>
    expect(document.querySelector('[role=status]')?.textContent).toContain('unavailable'),
  );
  expect(api.sendMessage).not.toHaveBeenCalled();
});
