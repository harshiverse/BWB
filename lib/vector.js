import { tokenize } from "./text.js";
// lib/vector.js
// HYBRID SEARCH module (semantic half).
//
// embed() is intentionally pluggable. The deck's target stack is
// Transformers.js running a multilingual E5 model — that needs a ~50-100MB
// model download and a bundler step, which is more than fits a single-file
// scaffold. To get you running immediately, embed() below ships with a
// dependency-light hashed bag-of-words vector (deterministic, no download,
// captures token overlap). Swap the body of embed() for the Transformers.js
// call below when you're ready — nothing else in the pipeline needs to change,
// since everything downstream just consumes a number[] vector.
//
// --- Swap-in when ready (npm i @xenova/transformers) ---
// import { pipeline } from '@xenova/transformers';
// let extractor;
// export async function embed(text) {
//   extractor ??= await pipeline('feature-extraction', 'Xenova/multilingual-e5-small');
//   const output = await extractor(text, { pooling: 'mean', normalize: true });
//   return Array.from(output.data);
// }
// ---------------------------------------------------------

const VECTOR_DIM = 256;


function hashToken(token) {
  let h = 5381;
  for (let i = 0; i < token.length; i++) h = (h * 33) ^ token.charCodeAt(i);
  return (h >>> 0) % VECTOR_DIM;
}

/** Placeholder embedding: hashed bag-of-words, L2-normalized. Swap for E5 later. */
export async function embed(text) {
  const vec = new Array(VECTOR_DIM).fill(0);
  for (const token of tokenize(text)) {
    vec[hashToken(token)] += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

export function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // both are already L2-normalized, so dot product == cosine similarity
}

/** Returns [{ id, score }] sorted descending, top `k`, against a set of { id, embedding }. */
export async function vectorSearch(items, query, k = 10) {
  const queryVec = await embed(query);
  const scores = items
    .filter((item) => item.embedding)
    .map((item) => ({ id: item.id, score: cosineSimilarity(queryVec, item.embedding) }));
  return scores.sort((a, b) => b.score - a.score).slice(0, k);
}