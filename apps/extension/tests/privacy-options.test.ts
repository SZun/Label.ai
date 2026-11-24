import { mount, unmount, flushSync } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Privacy from '../src/components/Privacy.svelte';
import { readSettings, writeSettings } from '../src/transport/settings';
import { CONSENT_VERSION } from '../src/core/policy';

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
  vi.mocked(readSettings).mockResolvedValue({ enabled: true, consentVersion: CONSENT_VERSION });
  api.sendMessage.mockImplementation(async (message) =>
    message.type === 'label-ai:clear' ? { cleared: true } : { registered: true },
  );
  app = mount(Privacy, { target: document.body });
  flushSync();
});
afterEach(async () => {
  if (app) await unmount(app);
  document.body.innerHTML = '';
});

const button = (text: string) =>
  Array.from(document.querySelectorAll('button')).find(
    (element) => element.textContent?.trim() === text,
  );
const status = () => document.querySelector('[role="status"]')?.textContent;

it('shows automatic scanning without requiring a site address or an optional permission request', async () => {
  await vi.waitFor(() => expect(button('Pause scanning')?.disabled).toBe(false));
  expect(document.querySelector('#site-heading')?.textContent).toBe('Automatic scanning');
  expect(status()).toContain('Automatic scanning is on.');
  expect(document.querySelector('input')).toBeNull();
  expect(api.request).not.toHaveBeenCalled();
  expect(writeSettings).not.toHaveBeenCalled();
});

it('pauses and resumes globally without adding or removing host permission', async () => {
  await vi.waitFor(() => expect(button('Pause scanning')?.disabled).toBe(false));
  button('Pause scanning')!.click();
  await vi.waitFor(() => expect(status()).toContain('Scanning paused.'));
  expect(writeSettings).toHaveBeenLastCalledWith({
    enabled: false,
    consentVersion: CONSENT_VERSION,
  });
  expect(api.remove).not.toHaveBeenCalled();

  button('Resume scanning')!.click();
  await vi.waitFor(() => expect(status()).toContain('Scanning resumed.'));
  expect(writeSettings).toHaveBeenLastCalledWith({
    enabled: true,
    consentVersion: CONSENT_VERSION,
  });
  expect(api.request).not.toHaveBeenCalled();
  expect(api.sendMessage).toHaveBeenCalledWith({ type: 'label-ai:sync' });
});

it('clears analysis state and leaves scanning paused', async () => {
  await vi.waitFor(() => expect(button('Clear local data')?.disabled).toBe(false));
  button('Clear local data')!.click();
  await vi.waitFor(() =>
    expect(status()).toContain('Local data cleared. Scanning remains paused.'),
  );
  expect(writeSettings).toHaveBeenLastCalledWith({
    enabled: false,
    consentVersion: CONSENT_VERSION,
  });
  expect(api.sendMessage).toHaveBeenCalledWith({ type: 'label-ai:clear' });
  expect(button('Resume scanning')).toBeTruthy();
});

it('shows registration failure without claiming scanning has resumed', async () => {
  await vi.waitFor(() => expect(button('Pause scanning')?.disabled).toBe(false));
  button('Pause scanning')!.click();
  await vi.waitFor(() => expect(status()).toContain('Scanning paused.'));
  api.sendMessage.mockRejectedValue(new Error('registration unavailable'));
  button('Resume scanning')!.click();
  await vi.waitFor(() => expect(status()).toContain('Could not resume scanning.'));
  expect(status()).not.toContain('Scanning resumed.');
});
