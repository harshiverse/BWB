// lib/db.js
// DATA & STORAGE module: IndexedDB wrapper. Every chunk's *content* is
// encrypted (see lib/crypto.js) before it reaches this layer; only
// non-sensitive metadata (url, timestamp, sourceType, contentHash, simhash)
// is stored in the clear so we can query/expire/deduplicate without
// decrypting everything.

const DB_NAME = "vijay_memory";
const DB_VERSION = 1;
const STORE = "chunks";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex("url", "url", { unique: false });
        store.createIndex("contentHash", "contentHash", { unique: false });
        store.createIndex("simhash", "simhash", { unique: false });
        store.createIndex("timestamp", "timestamp", { unique: false });
        store.createIndex("sourceType", "sourceType", { unique: false }); // 'web' | 'pdf' | 'youtube'
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * chunk shape:
 * {
 *   url, title, sourceType: 'web'|'pdf'|'youtube',
 *   pageNumber?, startTimeSeconds?,   // citation anchors
 *   timestamp: number (ms epoch),
 *   contentHash: string (sha256 of raw chunk text, for exact-dup check),
 *   simhash: string (for near-dup check),
 *   language: string,
 *   encrypted: { iv, ciphertext },    // the actual text, encrypted
 *   embedding: number[] | null,       // vector, filled in by embed step
 * }
 */
export async function addChunk(chunk) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).add(chunk);
    req.onsuccess = () => resolve(req.result); // new id
    req.onerror = () => reject(req.error);
  });
}

export async function getAllChunks() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function findByContentHash(contentHash) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const idx = tx.objectStore(STORE).index("contentHash");
    const req = idx.getAll(contentHash);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteChunk(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Delete every chunk newer than `sinceMs` epoch — powers "forget last hour". */
export async function deleteSince(sinceMs) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const idx = store.index("timestamp");
    const range = IDBKeyRange.lowerBound(sinceMs);
    const req = idx.openCursor(range);
    let deleted = 0;
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        deleted++;
        cursor.continue();
      } else {
        resolve(deleted);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/** Delete every chunk older than `maxAgeMs` — powers chrome.alarms auto-expiry. */
export async function deleteOlderThan(maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const idx = store.index("timestamp");
    const range = IDBKeyRange.upperBound(cutoff);
    const req = idx.openCursor(range);
    let deleted = 0;
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        deleted++;
        cursor.continue();
      } else {
        resolve(deleted);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function wipeAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
