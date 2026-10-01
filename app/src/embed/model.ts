import type { Embedder } from '@atomic-v2';
import type { WorkerRequest, WorkerResponse } from './embed.worker.ts';

/** Multilingual sentence model (50+ languages incl. Hindi); ~120 MB once, then cached on the device. */
export const MODEL_ID = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

export interface ModelProgress {
  loaded: number;
  total: number;
}

/** Loads the on-device model in a worker. Rejects if it cannot load (offline on first run, no WASM, ...). */
export async function loadModelEmbedder(onProgress: (progress: ModelProgress) => void, timeoutMs = 10 * 60_000): Promise<Embedder> {
  const worker = new Worker(new URL('./embed.worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, { resolve(vectors: number[][]): void; reject(error: Error): void }>();
  const files = new Map<string, ModelProgress>();
  let nextId = 1;

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('model download timed out')), timeoutMs);
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === 'progress') {
        files.set(message.file, { loaded: message.loaded, total: message.total });
        let loaded = 0;
        let total = 0;
        for (const file of files.values()) {
          loaded += file.loaded;
          total += file.total;
        }
        onProgress({ loaded, total });
      } else if (message.type === 'ready') {
        clearTimeout(timer);
        resolve();
      } else if (message.type === 'vectors') {
        pending.get(message.id)?.resolve(message.vectors);
        pending.delete(message.id);
      } else if (message.id !== undefined) {
        pending.get(message.id)?.reject(new Error(message.message));
        pending.delete(message.id);
      } else {
        clearTimeout(timer);
        reject(new Error(message.message));
      }
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(event.message || 'embedding worker failed'));
    };
  });

  const send = (request: WorkerRequest) => worker.postMessage(request);
  send({ type: 'load', model: MODEL_ID, wasmPaths: new URL('./ort/', document.baseURI).href });
  try {
    await ready;
  } catch (error) {
    worker.terminate();
    throw error;
  }

  return {
    id: `${MODEL_ID}@q8`,
    embed(texts: string[]) {
      if (!texts.length) return Promise.resolve([]);
      const id = nextId++;
      return new Promise<number[][]>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ type: 'embed', id, texts });
      });
    },
  };
}
