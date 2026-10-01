import './styles.css';
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { startApp } from './app.ts';
import { HashEmbedder } from './embed/hash.ts';
import { loadModelEmbedder } from './embed/model.ts';
import { describeError, streamReply } from './llm/claude.ts';
import { createMemoryStore } from './memory/stores.ts';
import type { EmbedderChoice, Platform } from './platform.ts';
import { createVoice } from './voice/voice.ts';

/** The Android app (and `npm run dev` in a browser): your Claude API key, the microphone, a memory file on the device. */
const platform: Platform = {
  needsApiKey: true,
  voice: createVoice(),
  store: createMemoryStore(),
  noMicrophoneText: 'Speech recognition is not available here. Type instead.',
  startReply: ({ settings, system, messages, onText }) =>
    streamReply({ apiKey: settings.apiKey, model: settings.model, effort: settings.effort, system, messages, onText }),
  async chooseEmbedder(ui): Promise<EmbedderChoice> {
    ui.setText('Loading the on-device language model for memory (about 120 MB, downloaded once).');
    const model = loadModelEmbedder(({ loaded, total }) => {
      if (total > 0) ui.setProgress(loaded / total);
      ui.setText(`Downloading the memory model once: ${(loaded / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB.`);
    });
    try {
      const winner = await Promise.race([model, ui.offerSkip(4000).then(() => 'skip' as const)]);
      if (winner !== 'skip') return { embedder: winner, note: 'on-device multilingual model' };
      model.catch(() => undefined);
      return { embedder: new HashEmbedder(), note: 'basic memory (spelling only) until the model loads' };
    } catch (error) {
      return {
        embedder: new HashEmbedder(),
        note: 'basic memory (spelling only): the model could not load',
        warning: `Basic memory mode: ${error instanceof Error ? error.message : String(error)}. Memory upgrades itself when the model loads next time.`,
      };
    }
  },
  async exportMemory(json) {
    const name = `surface-memory-${new Date().toISOString().slice(0, 10)}.json`;
    if (Capacitor.isNativePlatform()) {
      const { uri } = await Filesystem.writeFile({ path: name, data: json, directory: Directory.Cache, encoding: Encoding.UTF8 });
      await Share.share({ title: 'Atomic memory', files: [uri] });
      return;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    link.download = name;
    link.click();
    URL.revokeObjectURL(link.href);
  },
};

startApp(platform, { describeError });
