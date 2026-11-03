import { cp, rm } from 'node:fs/promises';
import { build } from 'esbuild';

await rm('dist', { recursive: true, force: true });

await build({
  entryPoints: ['src/offscreen.js', 'src/overlay.js', 'src/options.js'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome116',
  outdir: 'dist',
});

for (const file of [
  'manifest.json',
  'background.js',
  'pcm-worklet.js',
  'offscreen.html',
  'options.html',
  '_locales',
  'icons',
]) {
  await cp(`src/${file}`, `dist/${file}`, { recursive: true });
}
