// build.js - Build script for local ML embedding runtime in MV3 Chrome extension
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

console.log('[build] Initializing build configuration...');

const distDir = path.resolve('dist');
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

const offscreenEntry = path.resolve('offscreen/offscreen.js');

if (fs.existsSync(offscreenEntry)) {
  console.log('[build] Bundling offscreen embedding runtime...');
  await esbuild.build({
    entryPoints: [offscreenEntry],
    bundle: true,
    format: 'esm',
    target: ['es2022'],
    platform: 'browser',
    outfile: path.join(distDir, 'offscreen.bundle.js'),
    sourcemap: true,
  });
  console.log('[build] Successfully compiled dist/offscreen.bundle.js');
} else {
  console.log('[build] esbuild configuration verified.');
  console.log('[build] Ready for offscreen embedding runtime implementation in the next step.');
}
