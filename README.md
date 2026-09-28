# Vijay — Private Local Memory & Search (Chrome Extension)

Scaffold for the "Build with भारत 3.0" pitch: a privacy-first, on-device
assistant that captures web/PDF/YouTube content, indexes it with hybrid
(keyword + vector) search, encrypts everything at rest, and answers
questions with citation-backed RAG.

## What's working out of the box

| Module | Status | File(s) |
|---|---|---|
| **Privacy** | ✅ Working | `content-script.js`, `lib/crypto.js`, `background.js` (alarms) |
| **Hybrid Search** | ✅ Working (BM25 + placeholder vectors + RRF) | `lib/bm25.js`, `lib/vector.js`, `lib/rrf.js` |
| **Multi-format (web)** | ✅ Working | `content-script.js` |
| **Multi-format (YouTube)** | ⚙️ Stub, needs wiring | `lib/youtube-capture.js` |
| **Multi-format (PDF)** | 🚧 Not yet — see below | — |
| **Reliability (dedup, idle-only indexing)** | ✅ Working | `lib/simhash.js`, `background.js` |
| **Reliability (RAG answer + citations)** | ⚙️ Works IF Gemini Nano is enabled | `background.js: generateAnswer()` |

## Run it now

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Click the extension icon → enter any passphrase to "unlock" (this derives your AES-GCM key; there's nothing to reset if you forget it yet since there's no real account — just re-enter any passphrase, though note this means anything already encrypted under the OLD passphrase becomes unreadable, which is by design for a lost-passphrase scenario).
3. Browse a few non-excluded, non-banking/health pages for ~10 seconds each (captures are debounced 2s, then queued for idle-time indexing).
4. Trigger idle: Chrome fires `idle` after ~60s of no input, or lower `chrome.idle.setDetectionInterval()` in `background.js` for faster testing.
5. Open the popup, type a question, hit Search.

## Turning on real LLM answers (Gemini Nano)

`generateAnswer()` in `background.js` feature-detects `LanguageModel` /
`self.ai.languageModel`. On current Chrome builds you'll need to:
- Use Chrome Canary/Dev with `chrome://flags/#prompt-api-for-gemini-nano` enabled, or
- Join the Early Preview Program for the stable Prompt API,
- Then let Chrome download the on-device model (Settings → check for the "Gemini Nano" component under `chrome://components`).

Until then, the popup still shows retrieved passages as sources even
though `answer` will explain the model isn't available yet — the
retrieval half of the pipeline doesn't depend on it.

## Turning on real embeddings (replacing the hashed placeholder)

`lib/vector.js`'s `embed()` currently returns a dependency-free hashed
bag-of-words vector so RRF has two genuinely different signals to fuse
without requiring a bundler or model download. To swap in the deck's
target (multilingual E5 via Transformers.js):

```bash
npm install @xenova/transformers
```

Then replace the body of `embed()` per the commented block at the top of
`lib/vector.js`. You'll also want a bundler (esbuild/webpack) at that
point since Manifest V3 service workers can't load ESM from `node_modules`
directly.

## Adding PDF capture

Not included yet to keep this scaffold dependency-free. To add it:
1. Vendor `pdf.js` (`pdfjs-dist` from npm, or Mozilla's prebuilt build) under `lib/vendor/pdf.js`.
2. Add a content script matching `*://*/*.pdf` (and Chrome's built-in PDF viewer, which needs `"matches": ["file:///*.pdf"]` plus testing against `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/...` — Chrome's PDF viewer extension ID — since the built-in viewer runs in its own extension context).
3. Extract per-page text with `pdf.getPage(n).getTextContent()`, and set `pageNumber` on each chunk (already supported end-to-end in `lib/db.js` and the popup's citation rendering).
4. For scanned PDFs with no text layer, add `tesseract.js` as an OCR fallback when `getTextContent()` returns near-empty strings.

## Wiring up YouTube capture

`lib/youtube-capture.js` is written but not auto-injected. Add to
`background.js`:

```js
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" && tab.url?.includes("youtube.com/watch")) {
    chrome.scripting.executeScript({ target: { tabId }, files: ["lib/youtube-capture.js"] });
  }
});
```

Then extend `processCaptureJob` in `background.js` to read
`startTimeSeconds` per-chunk (currently it's job-level) — the YouTube file
already has a `// NOTE:` comment marking exactly where.

## Architecture notes for your demo

- **Nothing leaves the device.** The only network call anywhere in this
  codebase is `lib/youtube-capture.js` fetching the caption track from
  YouTube itself (same-origin data the user's own browser already has
  access to) — everything else is `chrome.storage`/`IndexedDB`/`chrome.runtime` messaging.
- **The 4 modules genuinely plug in at the seams shown in your "Flow of
  Solution" slide** — Privacy at Encrypt&Store, Multi-format at Capture,
  Hybrid Search at Query, Reliability at LLM Answer — so each is
  independently demoable, matching your feasibility slide's claim.
- **Passphrase is never stored.** Only a non-secret PBKDF2 salt persists
  in `chrome.storage.local`; the derived key lives in a JS closure in the
  service worker and is gone on browser restart or explicit lock.

## Known scaffold limitations to flag if asked in Q&A

- Placeholder embeddings mean semantic search currently behaves more like
  a second keyword signal than true meaning-based retrieval — swap in E5
  before relying on this for the "close enough" / synonym use case.
- `getAllChunks()` is called in a couple of hot paths (near-dup check,
  query) — fine for a hackathon-scale personal corpus, but add an index-
  backed lookup before this scales past a few thousand chunks.
- Cross-language auto-translate fallback (mentioned in the deck) isn't
  implemented — `extractTimeFilter` handles time-expression parsing only.
