import { copyFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

/** Ships the ONNX runtime WASM files with the app, so embeddings work without a CDN. */
function copyOrtWasm(): Plugin {
  const source = join(here, 'node_modules/onnxruntime-web/dist');
  const files = () => readdirSync(source).filter((name) => /^ort-wasm-simd-threaded.*\.(wasm|mjs)$/.test(name));
  return {
    name: 'copy-ort-wasm',
    configureServer(server) {
      server.middlewares.use('/ort/', (req, res, next) => {
        const name = (req.url ?? '').replace(/^\//, '').split('?')[0];
        if (!files().includes(name)) return next();
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.end(readFileSync(join(source, name)));
      });
    },
    writeBundle(options) {
      const out = join(options.dir ?? join(here, 'dist'), 'ort');
      mkdirSync(out, { recursive: true });
      for (const name of files()) copyFileSync(join(source, name), join(out, name));
    },
  };
}

export default defineConfig({
  base: './',
  resolve: { alias: { '@atomic-v2': resolve(here, '../src/atomic-v2/index.ts') } },
  server: { fs: { allow: [resolve(here, '..')] } },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  build: { outDir: 'dist', target: 'es2022', chunkSizeWarningLimit: 4000 },
  plugins: [copyOrtWasm()],
});
