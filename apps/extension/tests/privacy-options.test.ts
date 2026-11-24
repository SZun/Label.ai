import { mount, unmount, flushSync } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Privacy from '../src/components/Privacy.svelte';
import { readSettings, writeSettings } from '../src/transport/settings';

const api = vi.hoisted(() => ({
  request: vi.fn(),
  contains: vi.fn(),
  remove: vi.fn(),
  sendMessage: vi.fn(),
}));
vi.mock('wxt/browser', () => ({
  browser: { permissions: api, runtime: api },
}));
vi.mock('../src/transport/settings', () => ({
  readSettings: vi.fn(),
  writeSettings: vi.fn(),
}));

let app: ReturnType<typeof mount> | undefined;
beforeEach(async () => {
  vi.resetAllMocks();
  vi.mocked(readSettings).mockResolvedValue({
    enabled: false,
    consentVersion: 0,
    approvedOrigins: [],
  });
  api.sendMessage.mockResolvedValue({ registered: true });
  app = mount(Privacy, { target: document.body });
  flushSync();
  await vi.waitFor(() => {
    const input = document.querySelector('#site') as HTMLInputElement;
    expect(input.disabled).toBe(false);
  });
  const input = document.querySelector('#site') as HTMLInputElement;
  input.value = 'https://news.example';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
});
afterEach(async () => {
  if (app) await unmount(app);
  document.body.innerHTML = '';
});
function enable() {
  const button = Array.from(document.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('Enable on this site'),
  );
  button!.click();
}
const status = () => document.querySelector('[role="status"]')?.textContent;

it('retains a browser grant when Safari rejects a redundant permission request', async () => {
  api.request.mockRejectedValue(new Error('permission already granted'));
  api.contains.mockResolvedValue(true);
  enable();
  await vi.waitFor(() => expect(status()).toContain('Local analysis enabled.'));
  expect(writeSettings).toHaveBeenCalledWith({
    enabled: true,
    consentVersion: 1,
    approvedOrigins: ['https://news.example'],
  });
  expect(api.request).toHaveBeenCalledOnce();
  expect(api.contains).toHaveBeenCalledWith({ origins: ['https://news.example/*'] });
});
it('shows actionable permission denial and leaves local consent disabled', async () => {
  api.request.mockResolvedValue(false);
  api.contains.mockResolvedValue(false);
  enable();
  await vi.waitFor(() => expect(status()).toContain('Site access was not granted.'));
  expect(writeSettings).not.toHaveBeenCalled();
});
it('reports registration failure without claiming analysis has started', async () => {
  api.request.mockResolvedValue(true);
  api.sendMessage.mockRejectedValue(new Error('registration unavailable'));
  enable();
  await vi.waitFor(() => expect(status()).toContain('could not activate'));
  expect(status()).not.toContain('Local analysis enabled.');
});

it('does not wait indefinitely for a redundant native permission prompt when access is already confirmed', async () => {
  api.request.mockReturnValue(new Promise(() => {}));
  api.contains.mockResolvedValue(true);
  enable();
  await vi.waitFor(() => expect(status()).toContain('Local analysis enabled.'));
  expect(writeSettings).toHaveBeenCalledOnce();
});
