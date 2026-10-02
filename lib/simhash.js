// lib/simhash.js
// RELIABILITY module: lightweight SimHash for near-duplicate detection,
// so re-visiting a barely-changed page doesn't re-embed and bloat the index.
// Pure vanilla JS, no dependency.

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// 32-bit string hash (djb2) — good enough for a 64-bit-ish simhash built
// from two 32-bit hashes concatenated.
function hash32(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h * 33) ^ str.charCodeAt(i);
  }
  return h >>> 0;
}

/** Compute a 64-bit SimHash (returned as a hex string) for a text blob. */
export function simhash(text) {
  const tokens = tokenize(text);
  const weights = new Array(64).fill(0);

  for (const token of tokens) {
    const h1 = hash32(token);
    const h2 = hash32(token + "\u0001"); // salt for the second 32 bits
    const bits = (BigInt(h1) << 32n) | BigInt(h2);
    for (let i = 0; i < 64; i++) {
      const bit = (bits >> BigInt(i)) & 1n;
      weights[i] += bit === 1n ? 1 : -1;
    }
  }

  let fingerprint = 0n;
  for (let i = 0; i < 64; i++) {
    if (weights[i] > 0) fingerprint |= 1n << BigInt(i);
  }
  return fingerprint.toString(16).padStart(16, "0");
}

/** Hamming distance between two hex simhashes. <=3 is a good "near-duplicate" cutoff. */
export function hammingDistance(hexA, hexB) {
  let a = BigInt("0x" + hexA);
  let b = BigInt("0x" + hexB);
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}
