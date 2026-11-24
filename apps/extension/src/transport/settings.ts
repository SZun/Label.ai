import { browser } from 'wxt/browser';
import { normalizeSettings, type LocalSettings } from '../core/policy';

export const SETTINGS_KEY = 'localSettings';
export async function readSettings(): Promise<LocalSettings> {
  const data = await browser.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(data[SETTINGS_KEY]);
}

export async function writeSettings(value: LocalSettings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: normalizeSettings(value) });
}
