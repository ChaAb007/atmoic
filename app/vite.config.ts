import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

// The ONNX runtime's WASM file is bundled by Vite itself (embed.worker.ts clears the CDN path), so no copy step.
export default defineConfig({
  base: './',
  resolve: { alias: { '@atomic-v2': resolve(here, '../src/atomic-v2/index.ts') } },
  server: { fs: { allow: [resolve(here, '..')] } },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  build: { outDir: 'dist', target: 'es2022', chunkSizeWarningLimit: 4000 },
});
