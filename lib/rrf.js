// lib/rrf.js
// HYBRID SEARCH module: Reciprocal Rank Fusion (Cormack et al.) — merges the
// BM25 ranked list and the vector ranked list into one ranking, using rank
// position rather than raw scores (which live on incomparable scales).

/**
 * @param {Array<Array<{id: any, score: number}>>} rankedLists - e.g. [bm25Results, vectorResults]
 * @param {number} k - RRF damping constant (60 is the standard default)
 * @returns {Array<{id: any, rrfScore: number}>} sorted descending
 */
export function reciprocalRankFusion(rankedLists, k = 60) {
  const fused = new Map(); // id -> accumulated score

  for (const list of rankedLists) {
    list.forEach((item, rank) => {
      const contribution = 1 / (k + rank + 1); // rank is 0-indexed
      fused.set(item.id, (fused.get(item.id) || 0) + contribution);
    });
  }

  return [...fused.entries()]
    .map(([id, rrfScore]) => ({ id, rrfScore }))
    .sort((a, b) => b.rrfScore - a.rrfScore);
}

/**
 * Very small time-expression parser, e.g. "notes from last week about X".
 * Returns { cleanedQuery, sinceMs } or { cleanedQuery, sinceMs: null } if none found.
 * Extend this with a proper chrono-style library if you need more coverage.
 */
export function extractTimeFilter(query) {
  const now = Date.now();
  const DAY = 86_400_000;
  const patterns = [
    { re: /\btoday\b/i, ms: DAY },
    { re: /\byesterday\b/i, ms: 2 * DAY },
    { re: /\blast\s+week\b/i, ms: 7 * DAY },
    { re: /\blast\s+month\b/i, ms: 30 * DAY },
    { re: /\bpast\s+(\d+)\s+days?\b/i, ms: null }, // dynamic, handled below
  ];

  for (const p of patterns) {
    const match = query.match(p.re);
    if (match) {
      const ms = p.ms ?? Number(match[1]) * DAY;
      return { cleanedQuery: query.replace(p.re, "").trim(), sinceMs: now - ms };
    }
  }
  return { cleanedQuery: query, sinceMs: null };
}
