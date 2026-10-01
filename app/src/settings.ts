import { Preferences } from '@capacitor/preferences';
import { DEFAULT_SETTINGS } from './settings-model.ts';
import type { Settings } from './settings-model.ts';

export { DEFAULT_SETTINGS };
export type { Settings };

const KEY = 'surface.settings.v1';

/** Settings live on the device only (Capacitor Preferences). The API key never leaves the phone except to Claude. */
export async function loadSettings(): Promise<Settings> {
  const { value } = await Preferences.get({ key: KEY });
  if (!value) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(value) as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await Preferences.set({ key: KEY, value: JSON.stringify(settings) });
}
