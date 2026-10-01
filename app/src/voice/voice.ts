import { Capacitor } from '@capacitor/core';
import { SpeechRecognition } from '@capacitor-community/speech-recognition';
import { TextToSpeech } from '@capacitor-community/text-to-speech';
import type { Voice } from '../contracts.ts';
import { NativeVoice } from './native-voice.ts';
import { WebVoice, browserSpeechEnv } from './web-voice.ts';

/**
 * The device's voice: Android's speech recognizer and text-to-speech engine inside the app,
 * the Web Speech API in a browser. Call init() before the first listen().
 */
export function createVoice(): Voice {
  if (Capacitor.isNativePlatform()) {
    return new NativeVoice({ speech: SpeechRecognition, tts: TextToSpeech });
  }
  return new WebVoice(browserSpeechEnv());
}
