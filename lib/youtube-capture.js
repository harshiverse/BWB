// lib/youtube-capture.js
// MULTI-FORMAT module: YouTube caption-track capture.
//
// Not wired into manifest.json's content_scripts by default — inject it
// conditionally (e.g. from background.js via chrome.scripting.executeScript
// when a youtube.com/watch tab is detected) since it needs a different
// extraction strategy than plain DOM text.
//
// Approach: fetch the video's timedtext caption track (no YouTube Data API
// key needed for videos with captions the current user can already see),
// then chunk by timestamp so each chunk carries a startTimeSeconds anchor
// for deep-linking back to the exact moment.

async function getCaptionTrackUrl() {
  const player = document.querySelector("video");
  if (!player) return null;

  // ytInitialPlayerResponse is populated by YouTube's own page script.
  const scriptTag = [...document.scripts].find((s) => s.textContent.includes("ytInitialPlayerResponse"));
  if (!scriptTag) return null;

  const match = scriptTag.textContent.match(/ytInitialPlayerResponse\s*=\s*(\{.*?\});/s);
  if (!match) return null;

  try {
    const data = JSON.parse(match[1]);
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks || tracks.length === 0) return null;
    // Prefer the manually-created track if present, else first available.
    const track = tracks.find((t) => t.kind !== "asr") || tracks[0];
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
      chunks.push({ text: current.text.join(" "), startTimeSeconds: current.startTimeSeconds });
      current = { text: [], startTimeSeconds: startSec };
      windowStart = startSec;
    }
    if (current.text.length === 0) current.startTimeSeconds = startSec;
    current.text.push(text);
  }
  if (current.text.length > 0) {
    chunks.push({ text: current.text.join(" "), startTimeSeconds: current.startTimeSeconds });
  }
  return chunks;
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
      title: document.title,
      sourceType: "youtube",
      language: "unknown",
      chunks: chunks.map((c) => c.text),
      // NOTE: background.js's processCaptureJob currently attaches one
      // pageNumber/startTimeSeconds per *job*, not per chunk. For YouTube,
      // extend that loop to take startTimeSeconds from chunks[i] — see
      // README "Next steps" for the exact one-line change.
      timestamp: Date.now(),
    },
  });
}

captureYoutubeTranscript();
