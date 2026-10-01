/** Builds the bust once per page, in a worker when possible, on the main thread otherwise. */

import { buildBust, type BustData } from './geometry.ts';

let pending: Promise<BustData> | null = null;

export function loadBust(): Promise<BustData> {
  pending ??= buildInWorker().catch(buildOnMainThread);
  return pending;
}

function buildInWorker(): Promise<BustData> {
  return new Promise((resolve, reject) => {
    if (typeof Worker === 'undefined') {
      reject(new Error('Web workers are not available'));
      return;
    }
    const worker = new Worker(new URL('./bust.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<BustData>) => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'bust worker failed'));
    };
  });
}

function buildOnMainThread(): Promise<BustData> {
  return new Promise((resolve) => setTimeout(() => resolve(buildBust()), 0));
}
