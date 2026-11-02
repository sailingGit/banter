import { cp, rm } from 'node:fs/promises';
import { build } from 'esbuild';

await rm('dist', { recursive: true, force: true });

await build({
  entryPoints: ['src/offscreen.js'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome116',
  outfile: 'dist/offscreen.js',
});

for (const file of [
  'manifest.json',
  'background.js',
  'overlay.js',
  'pcm-worklet.js',
  'offscreen.html',
  'options.html',
  'options.js',
]) {
  await cp(`src/${file}`, `dist/${file}`);
}
