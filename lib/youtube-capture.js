// lib/youtube-capture.js
// MULTI-FORMAT module: YouTube caption-track capture. Injected by
// background.js (chrome.scripting.executeScript) whenever a tab lands on
// a youtube.com/watch page — on initial load and on every in-page SPA
// navigation (YouTube swaps videos without a full page reload).
//
// Fetches the current video's own caption track directly from YouTube
// (same-origin data the browser already has access to — not a third-party
// call), chunks it by time window, and sends each chunk with its own
// startTimeSeconds so search results can deep-link to the exact moment.

async function getCaptionTrackUrl() {
  const scriptTag = [...document.scripts].find((s) => s.textContent.includes("ytInitialPlayerResponse"));
  if (!scriptTag) return null;

  const match = scriptTag.textContent.match(/ytInitialPlayerResponse\s*=\s*(\{.*?\});/s);
  if (!match) return null;

  try {
    const data = JSON.parse(match[1]);
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks || tracks.length === 0) return null;
    const track = tracks.find((t) => t.kind !== "asr") || tracks[0]; // prefer manual captions over auto-generated
    return track.baseUrl + "&fmt=json3";
  } catch {
    return null;
  }
}

function chunkCaptions(events, windowSeconds = 30) {
  const chunks = [];
  let current = { text: [], startTimeSeconds: 0 };
  let windowStart = 0;

  for (const ev of events || []) {
    if (!ev.segs) continue;
    const startSec = (ev.tStartMs || 0) / 1000;
    const text = ev.segs.map((s) => s.utf8).join("");

    if (startSec - windowStart > windowSeconds && current.text.length > 0) {
      chunks.push({ text: current.text.join(" ").trim(), startTimeSeconds: Math.floor(current.startTimeSeconds) });
      current = { text: [], startTimeSeconds: startSec };
      windowStart = startSec;
    }
    if (current.text.length === 0) current.startTimeSeconds = startSec;
    current.text.push(text);
  }
  if (current.text.length > 0) {
    chunks.push({ text: current.text.join(" ").trim(), startTimeSeconds: Math.floor(current.startTimeSeconds) });
  }
  return chunks.filter((c) => c.text.length > 0);
}

function getVideoTitle() {
  return document.querySelector("h1.ytd-watch-metadata yt-formatted-string")?.textContent?.trim()
    || document.title.replace(/\s*-\s*YouTube\s*$/, "")
    || document.title;
}

async function captureYoutubeTranscript() {
  const captionUrl = await getCaptionTrackUrl();
  if (!captionUrl) return; // no captions available on this video

  const res = await fetch(captionUrl);
  const data = await res.json();
  const chunks = chunkCaptions(data.events);
  if (chunks.length === 0) return;

  chrome.runtime.sendMessage({
    type: "CAPTURE_CHUNKS",
    payload: {
      url: location.href,
      title: getVideoTitle(),
      sourceType: "youtube",
      language: "unknown",
      // Rich chunks: { text, startTimeSeconds } — background.js reads
      // startTimeSeconds per-chunk for YouTube instead of the job-level field.
      chunks,
      timestamp: Date.now(),
    },
  });
}

// Debounce: background.js re-injects this script on every SPA nav, and the
// page itself may still be settling (captions script tag not updated yet).
clearTimeout(window.__vijayYtCaptureTimeout);
window.__vijayYtCaptureTimeout = setTimeout(captureYoutubeTranscript, 1500);