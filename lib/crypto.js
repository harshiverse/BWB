// lib/crypto.js
// PRIVACY module: AES-GCM encryption via Web Crypto API, PBKDF2 key derivation.
// The derived key is kept ONLY in memory (this module-level variable). It is
// never written to chrome.storage or IndexedDB. If the service worker is
// killed/reloaded, the user has to re-enter their passphrase — this is
// intentional (matches the "memory-only key" requirement in the deck).

let cachedKey = null;       // CryptoKey, memory-only
let cachedSalt = null;      // base64 salt, safe to persist (not secret)

const PBKDF2_ITERATIONS = 250_000;
const SALT_STORAGE_KEY = "vijay_kdf_salt";

function bufToB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function b64ToBuf(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
}

async function getOrCreateSalt() {
  if (cachedSalt) return cachedSalt;
  const stored = await chrome.storage.local.get(SALT_STORAGE_KEY);
  if (stored[SALT_STORAGE_KEY]) {
    cachedSalt = stored[SALT_STORAGE_KEY];
    return cachedSalt;
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltB64 = bufToB64(salt);
  await chrome.storage.local.set({ [SALT_STORAGE_KEY]: saltB64 });
  cachedSalt = saltB64;
  return saltB64;
}

/**
 * Derive (or re-derive) the AES-GCM key from a user passphrase.
 * Call this once per session, e.g. when the popup opens and the user
 * types their passphrase. The result is cached in memory only.
 */
const CANARY_KEY = "vijay_passphrase_canary";
const CANARY_VALUE = "vijay-ok";

/**
 * Derives the key, then checks it against a small encrypted "canary" value
 * stored in chrome.storage.local. First unlock ever: no canary exists yet,
 * so we trust this passphrase and create one. Every later unlock: if the
 * canary fails to decrypt, the passphrase is wrong and we refuse to proceed
 * (instead of silently "unlocking" with a key that can't read your data).
 *
 * Returns { ok: true } or { ok: false, reason: "WRONG_PASSPHRASE" }.
 */
export async function unlockWithPassphrase(passphrase) {
  const saltB64 = await getOrCreateSalt();
  const salt = b64ToBuf(saltB64);

  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  const candidateKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );

  const stored = await chrome.storage.local.get(CANARY_KEY);
  const canary = stored[CANARY_KEY];

  if (!canary) {
    // First unlock ever: trust it, and record a canary for future checks.
    cachedKey = candidateKey;
    const encryptedCanary = await encrypt(CANARY_VALUE);
    await chrome.storage.local.set({ [CANARY_KEY]: encryptedCanary });
    return { ok: true };
  }

  try {
    cachedKey = candidateKey;
    const decoded = await decrypt(canary);
    if (decoded !== CANARY_VALUE) throw new Error("canary mismatch");
    return { ok: true };
  } catch {
    cachedKey = null;
    return { ok: false, reason: "WRONG_PASSPHRASE" };
  }
}

export function isUnlocked() {
  return cachedKey !== null;
}

/** Wipe the in-memory key (e.g. on lock / browser close / idle timeout). */
export function lock() {
  cachedKey = null;
}

/**
 * Encrypt a JS value (will be JSON-stringified). Returns
 * { iv: base64, ciphertext: base64 } — safe to store in IndexedDB.
 */
export async function encrypt(value) {
  if (!cachedKey) throw new Error("Vault is locked — call unlockWithPassphrase() first.");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cachedKey,
    plaintext
  );
  return { iv: bufToB64(iv), ciphertext: bufToB64(ciphertext) };
}

/** Decrypt the { iv, ciphertext } shape produced by encrypt(). */
export async function decrypt({ iv, ciphertext }) {
  if (!cachedKey) throw new Error("Vault is locked — call unlockWithPassphrase() first.");
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBuf(iv) },
    cachedKey,
    b64ToBuf(ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

/** SHA-256 hex digest — used for exact-duplicate detection on captured pages. */
export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}