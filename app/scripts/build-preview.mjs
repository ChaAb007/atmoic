// Builds the in-chat preview (preview.html -> src/preview.ts) into one artifact page plus its worker files:
// dist-preview/artifact/surface-ai.html holds the CSS and the app script inline; every other file the script
// loads at run time (the face's geometry worker) sits next to it under the same relative path.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(appDir, 'dist-preview');
const artifactDir = join(outDir, 'artifact');

await build({
  root: appDir,
  configFile: join(appDir, 'vite.config.ts'),
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: { input: join(appDir, 'preview.html'), output: { codeSplitting: false } },
  },
});

const html = readFileSync(join(outDir, 'preview.html'), 'utf8');
const scriptSrc = html.match(/<script type="module"[^>]*src="\.\/([^"]+)"/)?.[1];
const styleHref = html.match(/<link rel="stylesheet"[^>]*href="\.\/([^"]+)"/)?.[1];
if (!scriptSrc || !styleHref) throw new Error('preview build: script or stylesheet not found in preview.html');

// Inline code runs with the page as its base URL, so chunk-relative URLs (new URL('x.js', import.meta.url))
// now resolve next to the page: publish those files at the page level.
const scriptDir = dirname(scriptSrc);
let script = readFileSync(join(outDir, scriptSrc), 'utf8');
const css = readFileSync(join(outDir, styleHref), 'utf8');
const assets = readdirSync(join(outDir, scriptDir)).filter((name) => name !== scriptSrc.slice(scriptDir.length + 1) && name !== styleHref.slice(scriptDir.length + 1));
const referenced = assets.filter((name) => script.includes(name));

script = script.replaceAll('</script', '<\\/script').replaceAll('<!--', '<\\!--');
const page = `<title>Surface AI</title>
<meta name="theme-color" content="#060b1a">
<style>${css.replaceAll('</style', '<\\/style')}</style>
<div id="app"></div>
<script type="module">${script}</script>
`;

rmSync(artifactDir, { recursive: true, force: true });
mkdirSync(artifactDir, { recursive: true });
writeFileSync(join(artifactDir, 'surface-ai.html'), page);
for (const name of referenced) copyFileSync(join(outDir, scriptDir, name), join(artifactDir, name));
console.log(JSON.stringify({ page: `${(page.length / 1024).toFixed(0)} KB`, files: referenced, unreferenced: assets.filter((n) => !referenced.includes(n)) }));
