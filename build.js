// build.js - Build script for local ML embedding runtime in MV3 Chrome extension
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

console.log('[build] Initializing build configuration...');

const distDir = path.resolve('dist');
const ortDistDir = path.join(distDir, 'ort');

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}
if (!fs.existsSync(ortDistDir)) {
  fs.mkdirSync(ortDistDir, { recursive: true });
}

// 1. Copy ONNX Runtime WASM & JSEP assets locally into dist/ort/
console.log('[build] Copying local ONNX runtime assets to dist/ort/...');
const ortSources = [
  path.resolve('node_modules/onnxruntime-web/dist'),
  path.resolve('node_modules/@huggingface/transformers/dist'),
];

let copiedCount = 0;
const copiedFiles = new Set();

for (const srcDir of ortSources) {
  if (fs.existsSync(srcDir)) {
    const files = fs.readdirSync(srcDir);
    for (const file of files) {
      if (file.startsWith('ort-wasm') && (file.endsWith('.wasm') || file.endsWith('.mjs'))) {
        const destPath = path.join(ortDistDir, file);
        if (!copiedFiles.has(file)) {
          fs.copyFileSync(path.join(srcDir, file), destPath);
          copiedFiles.add(file);
          copiedCount++;
          console.log(`[build]   -> Copied ${file}`);
        }
      }
    }
  }
}
console.log(`[build] Copied ${copiedCount} ONNX runtime assets.`);

// 2. Bundle offscreen embedding runtime
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
  console.log('[build] Warning: offscreen/offscreen.js not found.');
}
