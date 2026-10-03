// lib/text.js
// Shared tokenizer with stopword removal. Without this, questions like
// "What's happening in X?" match every page on "what/in/the" instead of X.

const STOPWORDS = new Set((
  // English
  "a an the and or but if then else of in on at to for from by with about as into over after before " +
  "is are was were be been being am do does did done have has had having will would can could should may might must " +
  "i me my we our you your he him his she her it its they them their this that these those there here " +
  "what whats whos which who whom whose when where why how not no yes so than too very just also " +
  "happening happen going tell show give find get " +
  // Hinglish / Hindi (romanized)
  "kya hai h hain tha thi the ka ki ke ko se me mein mai par pe aur ya bhi to toh ho hoga kaise kyun kyu kab kahan"
).split(/\s+/).filter(Boolean));

export function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t));
}