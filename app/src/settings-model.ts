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
  // Medium: enough thought to discuss and push back, still quick enough for speech.
  effort: 'medium',
  language: 'en-IN',
  speechRate: 1,
  userName: '',
  speakReplies: true,
};
