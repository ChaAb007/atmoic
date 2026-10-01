import { Preferences } from '@capacitor/preferences';
import { DEFAULT_SETTINGS } from './settings-model.ts';
import type { Settings } from './settings-model.ts';

export { DEFAULT_SETTINGS };
export type { Settings };

const KEY = 'surface.settings.v1';

/** Settings live on the device only (Capacitor Preferences). The API key never leaves the phone except to Claude. */
/** Unreadable or blocked storage (a private window, a locked-down frame) means default settings, never a failed start. */
export async function loadSettings(): Promise<Settings> {
  try {
    const { value } = await Preferences.get({ key: KEY });
    if (!value) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(value) as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Returns false when the settings could not be stored; they still apply until the app closes. */
export async function saveSettings(settings: Settings): Promise<boolean> {
  try {
    await Preferences.set({ key: KEY, value: JSON.stringify(settings) });
    return true;
  } catch {
    return false;
  }
}
