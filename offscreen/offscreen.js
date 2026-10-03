// offscreen/offscreen.js - Local multilingual-e5-small embedding runtime
import { pipeline, env } from '@huggingface/transformers';

// Configure environment for Chrome Extension Offscreen Document
env.useBrowserCache = true;
env.allowLocalModels = false;

if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.numThreads = 1;
}

let extractorPromise = null;

export async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      console.log('[offscreen-embedder] Initializing multilingual-e5-small pipeline...');
      const pipe = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', {
        dtype: 'q8',
      });
      console.log('[offscreen-embedder] Model loaded successfully.');
      return pipe;
    })();
  }
  return extractorPromise;
}

export async function embedWithE5(text, isQuery = false) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Input text must be a non-empty string.');
  }

  const prefix = isQuery ? 'query: ' : 'passage: ';
  const formattedText = prefix + text.trim();

  const extractor = await getExtractor();
  const output = await extractor(formattedText, {
    pooling: 'mean',
    normalize: true,
  });

  const embedding = Array.from(output.data);

  if (embedding.length !== 384) {
    throw new Error(`Unexpected embedding dimension: ${embedding.length} (expected 384)`);
  }

  return embedding;
}

// Chrome runtime message listener for offscreen document
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== 'offscreen-embedder') return;

    if (message.action === 'EMBED') {
      embedWithE5(message.text, Boolean(message.isQuery))
        .then((embedding) => {
          sendResponse({ success: true, embedding });
        })
        .catch((err) => {
          console.error('[offscreen-embedder] Inference error:', err);
          sendResponse({ success: false, error: err.message || String(err) });
        });
      return true; // Keep message channel open for async response
    }
  });
}
