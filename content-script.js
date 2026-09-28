// content-script.js
// PRIVACY + MULTI-FORMAT (capture stage). Runs on every page (document_idle).
// Decides locally whether this tab should be captured at all, then extracts
// text and hands it to the background service worker for chunking/storage.
// No page content leaves the device — this only messages the extension's
// own service worker (chrome.runtime.sendMessage), never a remote server.

// --- 1. Sensitive-site auto-exclude -----------------------------------
// Extend this list freely; consider loading it from chrome.storage so users
// can add their own domains from the options page.
const EXCLUDED_DOMAIN_PATTERNS = [
  /bank/i, /chase\.com/i, /wellsfargo\.com/i, /paypal\.com/i,
  /health/i, /mychart/i, /webmd\.com/i, /login\./i, /accounts\.google\.com/i,
];

function isExcludedDomain(hostname) {
  return EXCLUDED_DOMAIN_PATTERNS.some((re) => re.test(hostname));
}

// --- 2. Incognito detection --------------------------------------------
function isIncognito() {
  return chrome.extension && chrome.extension.inIncognitoContext === true;
}

// --- 3. Password-field guard --------------------------------------------
// If the page currently has a visible password input, treat it as a
// sensitive form (login/checkout) and skip capture entirely this pass.
function pageHasPasswordField() {
  return document.querySelectorAll('input[type="password"]').length > 0;
}

// --- 4. Lightweight readability-style extraction -------------------------
// Not as thorough as Mozilla's Readability.js, but dependency-free. Swap in
// Readability.js (bundle it under lib/) if you want better article extraction.
function extractMainText() {
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll("script, style, nav, footer, header, noscript, svg, iframe").forEach((el) => el.remove());
  const text = clone.innerText || "";
  return text.replace(/\s+/g, " ").trim();
}

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

// --- 5. Main capture routine ---------------------------------------------
async function captureIfAllowed() {
  const hostname = location.hostname;

  if (isIncognito()) return;
  if (isExcludedDomain(hostname)) return;
  if (pageHasPasswordField()) return;
  if (document.visibilityState !== "visible") return; // foreground tabs only

  const text = extractMainText();
  if (text.length < 200) return; // skip near-empty pages

  const chunks = chunkText(text);

  chrome.runtime.sendMessage({
    type: "CAPTURE_CHUNKS",
    payload: {
      url: location.href,
      title: document.title,
      sourceType: "web",
      language: document.documentElement.lang || "unknown",
      chunks,
      timestamp: Date.now(),
    },
  });
}

// Debounce so SPA route changes don't spam captures.
let captureTimeout = null;
function scheduleCapture() {
  clearTimeout(captureTimeout);
  captureTimeout = setTimeout(captureIfAllowed, 2000);
}

scheduleCapture();
document.addEventListener("visibilitychange", scheduleCapture);

// Basic SPA navigation detection (pushState/popState) so single-page apps
// (React/Vue/etc.) get re-captured on route change.
const originalPushState = history.pushState;
history.pushState = function (...args) {
  originalPushState.apply(this, args);
  scheduleCapture();
};
window.addEventListener("popstate", scheduleCapture);
