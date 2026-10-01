import { Preferences } from '@capacitor/preferences';
import type { Effort } from './llm/claude.ts';

export interface Settings {
  apiKey: string;
  model: string;
  effort: Effort;
  /** Speech recognition and voice language, e.g. en-IN or hi-IN. */
  language: string;
  speechRate: number;
  userName: string;
  speakReplies: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  model: 'claude-opus-5-5',
  effort: 'low',
  language: 'en-IN',
  speechRate: 1,
  userName: '',
  speakReplies: true,
};

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
