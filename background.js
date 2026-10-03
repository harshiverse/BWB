// background.js (Manifest V3 service worker, type: module)
// Orchestrates the full pipeline described in the deck:
// Capture -> Filter&Classify -> Chunk+Embed -> Encrypt&Store -> Query(Hybrid+RRF) -> Retrieve&Rerank -> LLM Answer+Citations

import { encrypt, decrypt, sha256Hex, isUnlocked, unlockWithPassphrase, lock } from "./lib/crypto.js";
import { addChunk, getAllChunks, findByContentHash, deleteChunk, deleteSince, deleteOlderThan, wipeAll } from "./lib/db.js";
import { isExcludedUrl } from "./lib/privacy.js";
import { tokenize } from "./lib/text.js";
import { simhash, hammingDistance } from "./lib/simhash.js";
import { embed } from "./lib/vector.js";
import { buildBm25Index, bm25Search } from "./lib/bm25.js";
import { vectorSearch } from "./lib/vector.js";
import { reciprocalRankFusion, extractTimeFilter } from "./lib/rrf.js";

const NEAR_DUP_HAMMING_THRESHOLD = 3;
const DEFAULT_RETENTION_DAYS = 30;

// ---------------------------------------------------------------------
// RELIABILITY: idle-triggered indexing queue.
// Captured chunks are queued here and only embedded when the device is
// idle, so indexing never costs the user a battery/perf hit mid-browsing.
// ---------------------------------------------------------------------
const QUEUE_KEY = "vijay_pending_queue";
const SESSION_PASS_KEY = "vijay_session_pass";

// chrome.storage.session is memory-only (never written to disk, cleared when
// the browser closes) but survives the MV3 service worker being killed.
async function readQueue() {
  const r = await chrome.storage.session.get(QUEUE_KEY);
  return r[QUEUE_KEY] || [];
}
async function writeQueue(q) {
  await chrome.storage.session.set({ [QUEUE_KEY]: q });
}
async function enqueue(job) {
  const q = await readQueue();
  q.push(job);
  await writeQueue(q);
}

// After a worker restart the in-memory key is gone; re-derive it from the
// session-only copy of the passphrase (also memory-only, cleared on browser close).
async function restoreSession() {
  if (isUnlocked()) return;
  const r = await chrome.storage.session.get(SESSION_PASS_KEY);
  if (r[SESSION_PASS_KEY]) {
    const result = await unlockWithPassphrase(r[SESSION_PASS_KEY]);
    if (!result.ok) await chrome.storage.session.remove(SESSION_PASS_KEY); // stale/garbage, drop it
  }
}

chrome.idle.setDetectionInterval(60); // seconds
chrome.idle.onStateChanged.addListener(async (state) => {
  if (state === "idle") {
    await restoreSession();
    drainQueue();
  }
});

let draining = false;
async function drainQueue() {
  if (draining || !isUnlocked()) return;
  draining = true;
  try {
    let q = await readQueue();
    while (q.length > 0) {
      const job = q.shift();
      await writeQueue(q);
      await processCaptureJob(job).catch((err) => console.error("[vijay] index job failed", err));
      q = await readQueue();
    }
  } finally {
    draining = false;
  }
}

// ---------------------------------------------------------------------
// PRIVACY: auto-expiry alarm (chrome.alarms), configurable retention window.
// ---------------------------------------------------------------------
chrome.alarms.create("vijay_auto_expire", { periodInMinutes: 60 * 6 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "vijay_auto_expire") {
    const { retentionDays = DEFAULT_RETENTION_DAYS } = await chrome.storage.sync.get("retentionDays");
    const deleted = await deleteOlderThan(retentionDays * 24 * 60 * 60 * 1000);
    if (deleted > 0) console.log(`[vijay] auto-expired ${deleted} chunks older than ${retentionDays}d`);
  }
});

// ---------------------------------------------------------------------
// Capture pipeline: dedupe (exact + near) -> embed -> encrypt -> store
// ---------------------------------------------------------------------
// Remove anything already stored from sensitive domains (e.g. captured before the
// exclusion list was expanded). Metadata only, no decryption needed.
async function purgeExcluded() {
  const all = await getAllChunks();
  let n = 0;
  for (const c of all) {
    if (isExcludedUrl(c.url)) { await deleteChunk(c.id); n++; }
  }
  if (n) console.log(`[vijay] purged ${n} chunks from excluded domains`);
}
purgeExcluded().catch(() => {});

async function processCaptureJob(job) {
  if (isExcludedUrl(job.url)) return; // never store sensitive domains
  if (!isUnlocked()) {
    // Vault locked: queue stays empty and we drop the capture. A more
    // complete build could hold ciphertext-pending-encryption in
    // chrome.storage.session and flush once unlocked.
    return;
  }

  for (let i = 0; i < job.chunks.length; i++) {
    const rawText = job.chunks[i];
    const contentHash = await sha256Hex(rawText);

    const exactDupes = await findByContentHash(contentHash);
    if (exactDupes.length > 0) continue; // exact duplicate, skip

    const sim = simhash(rawText);
    const allChunks = await getAllChunks(); // fine at personal scale; index this if it grows large
    const isNearDup = allChunks.some(
      (c) => c.simhash && hammingDistance(c.simhash, sim) <= NEAR_DUP_HAMMING_THRESHOLD
    );
    if (isNearDup) continue;

    const embedding = await embed(rawText);
    const encrypted = await encrypt(rawText);

    await addChunk({
      url: job.url,
      title: job.title,
      sourceType: job.sourceType, // 'web' | 'pdf' | 'youtube'
      pageNumber: job.pageNumber ?? null,
      startTimeSeconds: job.startTimeSeconds ?? null,
      chunkIndex: i,
      timestamp: job.timestamp,
      contentHash,
      simhash: sim,
      language: job.language || "unknown",
      encrypted,
      embedding,
    });
  }
}

// ---------------------------------------------------------------------
// Query pipeline: decrypt corpus in memory -> BM25 + vector -> RRF -> RAG
// ---------------------------------------------------------------------
// Pick the few sentences that actually answer the question (used when no LLM is available).
function extractBestSentences(retrieved, query, max = 3) {
  const q = new Set(tokenize(query));
  const candidates = [];
  retrieved.forEach((r, idx) => {
    r.text.split(/(?<=[.!?])\s+/).forEach((sent) => {
      const toks = tokenize(sent);
      if (toks.length < 4) return;
      const hits = toks.filter((t) => q.has(t)).length;
      if (hits === 0) return;
      candidates.push({ n: idx + 1, text: sent.trim().slice(0, 300), score: hits / Math.sqrt(toks.length) });
    });
  });
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, max);
  if (top.length === 0 && retrieved[0]) return [{ n: 1, text: retrieved[0].text.slice(0, 250) }];
  return top.map(({ n, text }) => ({ n, text }));
}

async function runQuery(rawQuery, { topK = 6 } = {}) {
  if (!isUnlocked()) throw new Error("Vault is locked. Unlock with your passphrase first.");

  const { cleanedQuery, sinceMs } = extractTimeFilter(rawQuery);

  let chunks = await getAllChunks();
  if (sinceMs) chunks = chunks.filter((c) => c.timestamp >= sinceMs);
  if (chunks.length === 0) return { answer: null, sources: [], reason: "NO_DATA" };

  // Decrypt just-in-time, kept only in this function's memory. A chunk
  // encrypted under an earlier/different passphrase will fail to decrypt —
  // skip it rather than letting one bad chunk fail the whole search.
  const decryptAttempts = await Promise.allSettled(
    chunks.map(async (c) => ({ id: c.id, text: await decrypt(c.encrypted), meta: c }))
  );
  const decrypted = decryptAttempts.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const skipped = decryptAttempts.length - decrypted.length;
  if (skipped > 0) console.warn(`[vijay] skipped ${skipped} chunk(s) that failed to decrypt (likely old passphrase)`);

  if (decrypted.length === 0 && chunks.length > 0) {
    return { answer: null, sources: [], reason: "ALL_UNDECRYPTABLE" };
  }

  const bm25Index = buildBm25Index(decrypted.map((d) => ({ id: d.id, text: d.text })));
  const bm25Results = bm25Search(bm25Index, cleanedQuery, topK * 2);
  // Ignore weak vector matches so unrelated pages don't sneak in as "close enough".
  const vecResults = (await vectorSearch(
    decrypted.map((d) => ({ id: d.id, embedding: d.meta.embedding })),
    cleanedQuery,
    topK * 2
  )).filter((r) => r.score >= 0.35);

  const fused = reciprocalRankFusion([bm25Results, vecResults]).slice(0, topK);

  // RELIABILITY: low-confidence guard — nothing fused in with a real signal.
  if (fused.length === 0) return { answer: null, sources: [], reason: "NO_MATCH" };

  const byId = new Map(decrypted.map((d) => [d.id, d]));
  const retrieved = fused.map((f) => byId.get(f.id)).filter(Boolean);

  return {
    query: cleanedQuery,
    extract: extractBestSentences(retrieved, cleanedQuery),
    // Passages for the popup to feed into Gemini Nano (LLM runs in the popup, see popup.js)
    passages: retrieved.map((r, idx) => ({ n: idx + 1, text: r.text.slice(0, 800) })),
    sources: retrieved.map((r, idx) => ({
      n: idx + 1,
      url: r.meta.url,
      title: r.meta.title,
      sourceType: r.meta.sourceType,
      pageNumber: r.meta.pageNumber,
      startTimeSeconds: r.meta.startTimeSeconds,
      snippet: r.text.slice(0, 300),
    })),
  };
}

// ---------------------------------------------------------------------
// Message router — content script + popup talk to the service worker
// exclusively through chrome.runtime messages. Nothing here ever calls
// fetch() to a remote host with page content or query text.
// ---------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    await restoreSession();
    switch (message.type) {
      case "CAPTURE_CHUNKS": {
        await enqueue(message.payload);
        const { idleOnly = false } = await chrome.storage.sync.get("idleOnly");
        if (!idleOnly) drainQueue(); // index right away unless user opted for idle-only
        sendResponse({ queued: true });
        break;
      }

      case "UNLOCK_VAULT": {
        const result = await unlockWithPassphrase(message.passphrase);
        if (!result.ok) {
          sendResponse({ unlocked: false, reason: result.reason });
          break;
        }
        await chrome.storage.session.set({ [SESSION_PASS_KEY]: message.passphrase });
        sendResponse({ unlocked: true });
        drainQueue(); // flush anything captured while locked
        break;
      }

      case "LOCK_VAULT":
        lock();
        await chrome.storage.session.remove(SESSION_PASS_KEY);
        sendResponse({ locked: true });
        break;

      case "STATUS": {
        const chunks = await getAllChunks();
        const queue = await readQueue();
        sendResponse({ indexed: chunks.length, pending: queue.length });
        break;
      }

      case "IS_UNLOCKED":
        sendResponse({ unlocked: isUnlocked() });
        break;

      case "SEARCH_QUERY": {
        const result = await runQuery(message.query, message.options);
        sendResponse(result);
        break;
      }

      case "FORGET_LAST_HOUR": {
        const deleted = await deleteSince(Date.now() - 60 * 60 * 1000);
        sendResponse({ deleted });
        break;
      }

      case "WIPE_ALL":
        await wipeAll();
        sendResponse({ wiped: true });
        break;

      default:
        sendResponse({ error: "Unknown message type: " + message.type });
    }
  })();
  return true; // keep the message channel open for the async response
});