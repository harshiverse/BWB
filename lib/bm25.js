import { tokenize } from "./text.js";
// lib/bm25.js
// HYBRID SEARCH module (keyword half): a from-scratch BM25 implementation
// so we don't need to bundle MiniSearch. Works over an array of
// { id, text } documents (already-decrypted text, held only in memory
// for the duration of a query).

const K1 = 1.5;
const B = 0.75;


/**
 * Build a BM25 index in memory. Cheap enough to rebuild per-query for a
 * personal-scale corpus; for large corpora, cache this and update
 * incrementally as chunks are added.
 */
export function buildBm25Index(documents) {
  const docTokens = documents.map((d) => tokenize(d.text));
  const docLengths = docTokens.map((t) => t.length);
  const avgDocLength = docLengths.reduce((a, b) => a + b, 0) / (docLengths.length || 1);

  const df = new Map(); // term -> number of docs containing it
  docTokens.forEach((tokens) => {
    const seen = new Set(tokens);
    seen.forEach((term) => df.set(term, (df.get(term) || 0) + 1));
  });

  const N = documents.length;
  const idf = new Map();
  for (const [term, freq] of df.entries()) {
    idf.set(term, Math.log(1 + (N - freq + 0.5) / (freq + 0.5)));
  }

  return { documents, docTokens, docLengths, avgDocLength, idf };
}

/** Returns [{ id, score }] sorted descending, top `k`. */
export function bm25Search(index, query, k = 10) {
  const { documents, docTokens, docLengths, avgDocLength, idf } = index;
  const qTokens = tokenize(query);
  const scores = documents.map((doc, i) => {
    const tokens = docTokens[i];
    const termFreq = new Map();
    tokens.forEach((t) => termFreq.set(t, (termFreq.get(t) || 0) + 1));

    let score = 0;
    for (const qt of qTokens) {
      const f = termFreq.get(qt) || 0;
      if (f === 0) continue;
      const idfVal = idf.get(qt) || 0;
      const denom = f + K1 * (1 - B + (B * docLengths[i]) / avgDocLength);
      score += idfVal * ((f * (K1 + 1)) / denom);
    }
    return { id: doc.id, score };
  });

  return scores
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}