// test-e2e-pipeline.mjs
// Minimal end-to-end verification of the capture -> chunk -> E5 embedding -> IndexedDB -> vector search pipeline
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

// 1. Mock browser & extension globals for Node environment
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

const localStorageMap = new Map();
const sessionStorageMap = new Map();

// Import the offscreen runtime embedder to handle messages
const offscreenModule = await import('./offscreen/offscreen.js');

globalThis.chrome = {
  runtime: {
    getURL: (path) => `chrome-extension://test-extension-id/${path}`,
    getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }],
    sendMessage: async (msg) => {
      if (msg?.target === 'offscreen-embedder' && msg?.action === 'EMBED') {
        try {
          const embedding = await offscreenModule.embedWithE5(msg.text, Boolean(msg.isQuery));
          return { success: true, embedding };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }
      return { error: 'Unknown message' };
    }
  },
  offscreen: {
    createDocument: async () => {},
    Reason: { WORKERS: 'WORKERS' }
  },
  storage: {
    local: {
      get: async (key) => {
        if (typeof key === 'string') return { [key]: localStorageMap.get(key) };
        const res = {};
        for (const k of key) res[k] = localStorageMap.get(k);
        return res;
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) localStorageMap.set(k, v);
      }
    },
    session: {
      get: async (key) => {
        if (typeof key === 'string') return { [key]: sessionStorageMap.get(key) };
        const res = {};
        for (const k of key) res[k] = sessionStorageMap.get(k);
        return res;
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) sessionStorageMap.set(k, v);
      },
      remove: async (key) => {
        sessionStorageMap.delete(key);
      }
    },
    sync: {
      get: async () => ({ retentionDays: 30, idleOnly: false })
    }
  },
  idle: {
    setDetectionInterval: () => {},
    onStateChanged: { addListener: () => {} }
  },
  alarms: {
    create: () => {},
    onAlarm: { addListener: () => {} }
  }
};

// 2. Import pipeline modules
const { unlockWithPassphrase } = await import('./lib/crypto.js');
const { getAllChunks, wipeAll } = await import('./lib/db.js');
const { embed, vectorSearch } = await import('./lib/vector.js');
const { buildBm25Index, bm25Search } = await import('./lib/bm25.js');
const { reciprocalRankFusion, extractTimeFilter } = await import('./lib/rrf.js');
const { decrypt, encrypt, sha256Hex } = await import('./lib/crypto.js');
const { simhash, hammingDistance } = await import('./lib/simhash.js');

console.log('====================================================');
console.log('   STARTING END-TO-END PIPELINE VERIFICATION TEST   ');
console.log('====================================================\n');

// Clear any existing test data
await wipeAll();

// Unlock Vault
console.log('[Step 1] Unlocking Vault with passphrase...');
const unlockResult = await unlockWithPassphrase('SuperSecretPassphrase123!');
if (!unlockResult.ok) throw new Error('Vault unlock failed: ' + unlockResult.reason);
console.log('  -> Vault successfully unlocked.\n');

// 3. Simulate Webpage Content Extraction & Chunking
console.log('[Step 2] Simulating Webpage Extraction & Chunking...');
const sampleWebpageText = 
  "React improves UI performance by reducing unnecessary renders. " +
  "By utilizing memoization techniques such as useMemo, useCallback, and React.memo, " +
  "developers can avoid expensive recalculations and re-rendering of child components when props remain unchanged. " +
  "Virtual DOM diffing ensures only modified elements update in the actual browser DOM.";

function chunkText(text, chunkSize = 800, overlap = 100) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    start += chunkSize - overlap;
  }
  return chunks;
}

const chunks = chunkText(sampleWebpageText);
console.log(`  -> Page extracted (${sampleWebpageText.length} chars), generated ${chunks.length} chunk(s).\n`);

// 4. Ingestion / Indexing Pipeline
console.log('[Step 3] Running Ingestion / Indexing Pipeline...');
const job = {
  url: 'https://react.dev/learn/render-and-commit',
  title: 'React Performance Optimization Guide',
  sourceType: 'web',
  language: 'en',
  chunks,
  timestamp: Date.now(),
};

// Execute indexing process as in background.js
const { addChunk } = await import('./lib/db.js');

for (let i = 0; i < job.chunks.length; i++) {
  const rawText = job.chunks[i];
  const contentHash = await sha256Hex(rawText);
  const sim = simhash(rawText);

  console.log(`  -> Generating local E5 embedding for chunk ${i}...`);
  const embedding = await embed(rawText); // Defaults to type="passage" ("passage: <text>")
  const encrypted = await encrypt(rawText);

  await addChunk({
    url: job.url,
    title: job.title,
    sourceType: job.sourceType,
    pageNumber: null,
    startTimeSeconds: null,
    chunkIndex: i,
    timestamp: job.timestamp,
    contentHash,
    simhash: sim,
    language: job.language,
    encrypted,
    embedding,
  });
}
console.log('  -> Chunk indexed and stored into IndexedDB.\n');

// 5. Verify IndexedDB Storage
console.log('[Step 4] Verifying IndexedDB Storage Contents...');
const storedChunks = await getAllChunks();
console.log(`  -> Total stored records in IndexedDB: ${storedChunks.length}`);
if (storedChunks.length === 0) throw new Error('No chunks found in IndexedDB!');

const record = storedChunks[0];
console.log('  -> Record URL:', record.url);
console.log('  -> Record Title:', record.title);
console.log('  -> Content encrypted ciphertext exists:', Boolean(record.encrypted?.ciphertext));
console.log('  -> Embedding stored:', Boolean(record.embedding));
console.log('  -> Embedding dimension:', record.embedding.length);
console.log('  -> Embedding is Array of finite numbers:', Array.isArray(record.embedding) && record.embedding.every(Number.isFinite));

const l2Norm = Math.sqrt(record.embedding.reduce((sum, v) => sum + v * v, 0));
console.log('  -> Embedding L2 norm:', l2Norm.toFixed(6));
if (record.embedding.length !== 384) {
  throw new Error(`Expected dimension 384, but got ${record.embedding.length}`);
}
console.log('  -> Storage verification PASSED!\n');

// 6. Query / Semantic Retrieval Pipeline
console.log('[Step 5] Testing Semantic Retrieval Pipeline...');

async function executeSearch(queryText, topK = 6) {
  const { cleanedQuery, sinceMs } = extractTimeFilter(queryText);
  let all = await getAllChunks();
  if (sinceMs) all = all.filter((c) => c.timestamp >= sinceMs);

  const decrypted = await Promise.all(
    all.map(async (c) => ({ id: c.id, text: await decrypt(c.encrypted), meta: c }))
  );

  const bm25Index = buildBm25Index(decrypted.map((d) => ({ id: d.id, text: d.text })));
  const bm25Results = bm25Search(bm25Index, cleanedQuery, topK * 2);

  // Vector search uses embed(query, "query") under the hood
  const rawVecResults = await vectorSearch(
    decrypted.map((d) => ({ id: d.id, embedding: d.meta.embedding })),
    cleanedQuery,
    topK * 2
  );

  const vecResults = rawVecResults.filter((r) => r.score >= 0.35);
  const fused = reciprocalRankFusion([bm25Results, vecResults]).slice(0, topK);

  const byId = new Map(decrypted.map((d) => [d.id, d]));
  const retrieved = fused.map((f) => byId.get(f.id)).filter(Boolean);

  return {
    query: cleanedQuery,
    bm25Results,
    rawVecResults,
    fusedResults: fused,
    retrieved
  };
}

// Test Queries
const testQueries = [
  {
    type: 'Hindi (Devanagari)',
    query: 'React में unnecessary renders को कैसे कम करें?'
  },
  {
    type: 'Hinglish (Romanized Hindi)',
    query: 'React me unnecessary renders rokne se performance improve kaise hoti hai?'
  },
  {
    type: 'English Semantic',
    query: 'How does memoization reduce component recalculations?'
  }
];

for (const t of testQueries) {
  console.log(`--- Running Query [${t.type}]: "${t.query}" ---`);
  const result = await executeSearch(t.query);

  const topVectorScore = result.rawVecResults[0]?.score;
  const topVectorId = result.rawVecResults[0]?.id;
  const isRetrieved = result.retrieved.length > 0;
  const retrievedTitle = result.retrieved[0]?.meta.title;

  console.log('  -> Vector Search Top Match ID:', topVectorId);
  console.log('  -> Vector Cosine Similarity Score:', topVectorScore?.toFixed(4));
  console.log('  -> BM25 Matches count:', result.bm25Results.length);
  console.log('  -> RRF Fused Top Match:', result.fusedResults[0]);
  console.log('  -> Retrieved Document Title:', retrievedTitle);
  console.log('  -> Semantic Retrieval Success:', isRetrieved && topVectorScore > 0.70);
  console.log('');

  if (!isRetrieved) {
    throw new Error(`Retrieval failed for query: ${t.query}`);
  }
}

console.log('====================================================');
console.log('  ALL END-TO-END PIPELINE TESTS PASSED SUCCESSFULLY! ');
console.log('====================================================');
