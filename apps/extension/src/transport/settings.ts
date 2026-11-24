import { browser } from 'wxt/browser';
import { normalizeSettings, type LocalSettings } from '../core/policy';

export const SETTINGS_KEY = 'localSettings';
export async function readSettings(): Promise<LocalSettings> {
  const data = await browser.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(data[SETTINGS_KEY]);
}

/** Replace stored v1 site lists with the new, global settings on extension update. */
export async function migrateSettings(): Promise<void> {
  const data = await browser.storage.local.get(SETTINGS_KEY);
  const previous = data[SETTINGS_KEY];
  if (previous === undefined) return;
  const normalized = normalizeSettings(previous);
  if (JSON.stringify(previous) !== JSON.stringify(normalized)) {
    const latest = await browser.storage.local.get(SETTINGS_KEY);
    if (JSON.stringify(latest[SETTINGS_KEY]) === JSON.stringify(previous))
      await browser.storage.local.set({ [SETTINGS_KEY]: normalized });
  }
}

export async function writeSettings(value: LocalSettings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: normalizeSettings(value) });
}
