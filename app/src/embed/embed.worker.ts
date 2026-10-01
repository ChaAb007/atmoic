/// <reference lib="webworker" />
import { env, pipeline } from '@huggingface/transformers';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';

/**
 * Runs the multilingual sentence model off the main thread, so the face keeps animating while memory works.
 * Messages: {type:'load', model, wasmPaths} -> progress..., ready | error; {type:'embed', id, texts} -> vectors | error.
 */

export type WorkerRequest =
  | { type: 'load'; model: string; wasmPaths: string }
  | { type: 'embed'; id: number; texts: string[] };

export type WorkerResponse =
  | { type: 'progress'; file: string; loaded: number; total: number }
  | { type: 'ready' }
  | { type: 'vectors'; id: number; vectors: number[][] }
  | { type: 'error'; id?: number; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let extractor: FeatureExtractionPipeline | undefined;
const BATCH = 16;

function post(message: WorkerResponse) {
  scope.postMessage(message);
}

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'load') {
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      const onnx = env.backends.onnx;
      if (onnx.wasm) {
        onnx.wasm.wasmPaths = request.wasmPaths;
        onnx.wasm.numThreads = 1;
      }
      extractor = await pipeline('feature-extraction', request.model, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: (info: { status?: string; file?: string; loaded?: number; total?: number }) => {
          if (info.status === 'progress' && info.file) {
            post({ type: 'progress', file: info.file, loaded: info.loaded ?? 0, total: info.total ?? 0 });
          }
        },
      });
      post({ type: 'ready' });
      return;
    }
    if (!extractor) throw new Error('model not loaded');
    const vectors: number[][] = [];
    for (let start = 0; start < request.texts.length; start += BATCH) {
      const output = await extractor(request.texts.slice(start, start + BATCH), { pooling: 'mean', normalize: true });
      vectors.push(...(output.tolist() as number[][]));
    }
    post({ type: 'vectors', id: request.id, vectors });
  } catch (error) {
    post({ type: 'error', id: request.type === 'embed' ? request.id : undefined, message: error instanceof Error ? error.message : String(error) });
  }
};
