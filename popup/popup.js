// popup/popup.js
// The LLM (Gemini Nano via Chrome's Prompt API) runs HERE in the popup, not in
// the service worker: the model download needs a user gesture (the Search click),
// and extension pages are the safest place the API is exposed.

const $ = (id) => document.getElementById(id);
const unlockView = $("unlockView"), mainView = $("mainView"), unlockStatus = $("unlockStatus");
const passphraseInput = $("passphraseInput"), unlockBtn = $("unlockBtn"), lockBtn = $("lockBtn");
const queryInput = $("queryInput"), searchBtn = $("searchBtn"), statusLine = $("statusLine");
const answerBox = $("answerBox"), answerText = $("answerText"), sourcesList = $("sourcesList");
const forgetHourBtn = $("forgetHourBtn");

const send = (message) => chrome.runtime.sendMessage(message);

const SYSTEM_PROMPT =
  "You answer using ONLY the numbered passages provided. End every factual sentence with its [n] citation. " +
  "If the passages do not contain the answer, reply exactly: I couldn't find that in your saved pages.";

async function refreshLockState() {
  const { unlocked } = await send({ type: "IS_UNLOCKED" });
  unlockView.classList.toggle("hidden", unlocked);
  mainView.classList.toggle("hidden", !unlocked);
  if (unlocked) {
    const { indexed, pending } = await send({ type: "STATUS" });
    statusLine.textContent = `Indexed: ${indexed} chunks · Pending: ${pending}`;
  }
}

unlockBtn.addEventListener("click", async () => {
  if (!passphraseInput.value) return;
  const result = await send({ type: "UNLOCK_VAULT", passphrase: passphraseInput.value });
  passphraseInput.value = "";
  if (!result.unlocked) {
    unlockStatus.textContent = "Wrong passphrase — try the one you used originally.";
    return;
  }
  unlockStatus.textContent = "";
  await refreshLockState();
});

lockBtn.addEventListener("click", async () => {
  await send({ type: "LOCK_VAULT" });
  await refreshLockState();
});

// ---------- Gemini Nano session ----------
async function createSession(onProgress) {
  if (typeof LanguageModel === "undefined") return { state: "missing" };
  const langs = {
    expectedInputs: [{ type: "text", languages: ["en"] }],
    expectedOutputs: [{ type: "text", languages: ["en"] }],
  };
  const monitor = (m) =>
    m.addEventListener("downloadprogress", (e) => onProgress(Math.round(e.loaded * 100)));

  for (const extra of [langs, {}]) { // retry without language hints on older Chrome builds
    try {
      const availability = await LanguageModel.availability(extra);
      if (availability === "unavailable") return { state: "unavailable" };
      const session = await LanguageModel.create({
        ...extra,
        initialPrompts: [{ role: "system", content: SYSTEM_PROMPT }],
        monitor,
      });
      return { state: "ready", session };
    } catch (err) {
      if (extra === langs) continue;
      return { state: "error", error: err };
    }
  }
}

function fallbackReason(r) {
  if (r.state === "missing") return "Prompt API not found — needs desktop Chrome 138+.";
  if (r.state === "unavailable") return "This device can't run Gemini Nano — check chrome://on-device-internals.";
  return "Gemini Nano error: " + (r.error?.message || "unknown");
}

// ---------- Search ----------
searchBtn.addEventListener("click", runSearch);
queryInput.addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });

async function runSearch() {
  const query = queryInput.value.trim();
  if (!query) return;

  answerBox.classList.add("hidden");
  statusLine.textContent = "Searching your local memory…";

  // Start the model session NOW, while the click's user activation is fresh
  // (needed if Chrome has to download the model on first use).
  const sessionPromise = createSession((pct) => {
    statusLine.textContent = `Downloading Gemini Nano… ${pct}%`;
  });

  const result = await send({ type: "SEARCH_QUERY", query });

  if (result.reason === "NO_DATA") {
    statusLine.textContent = "Nothing indexed yet — browse a bit, then try again.";
    return;
  }
  if (result.reason === "NO_MATCH") {
    statusLine.textContent = "No confident match found for that query.";
    return;
  }
  if (result.reason === "ALL_UNDECRYPTABLE") {
    statusLine.textContent = "Your saved data was encrypted with a different passphrase and can't be read. Wipe it from Settings and start fresh.";
    return;
  }

  let answer = null;
  const model = await sessionPromise;
  if (model.state === "ready") {
    statusLine.textContent = "Generating answer on-device…";
    try {
      const context = result.passages.map((p) => `[${p.n}] ${p.text}`).join("\n\n");
      answer = await model.session.prompt(`Passages:\n${context}\n\nQuestion: ${result.query}`);
    } catch (err) {
      model.state = "error";
      model.error = err;
    } finally {
      model.session.destroy?.();
    }
  }

  const grounded = answer !== null;
  statusLine.textContent = grounded ? "" : fallbackReason(model);

  let primary; // which sources to show up front
  if (grounded) {
    answerText.textContent = answer;
    primary = new Set(result.sources.map((s) => s.n));
  } else {
    // No LLM: show only the sentences that best match the question.
    answerText.textContent = result.extract.map((e) => `${e.text} [${e.n}]`).join("\n\n");
    primary = new Set(result.extract.map((e) => e.n));
  }
  renderSources(result.sources, primary);
  answerBox.classList.remove("hidden");
}

function makeSourceItem(s) {
  const li = document.createElement("li");
  const anchor = s.pageNumber
    ? ` (p.${s.pageNumber})`
    : s.startTimeSeconds
    ? ` (${Math.floor(s.startTimeSeconds / 60)}:${String(s.startTimeSeconds % 60).padStart(2, "0")})`
    : "";
  li.append(`[${s.n}] `);
  const a = document.createElement("a");
  a.href = /^https?:/i.test(s.url) ? s.url : "#";
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = s.title || s.url;
  li.append(a, anchor);
  return li;
}

function renderSources(sources, primary) {
  sourcesList.replaceChildren();
  const rest = sources.filter((s) => !primary.has(s.n));
  sources.filter((s) => primary.has(s.n)).forEach((s) => sourcesList.appendChild(makeSourceItem(s)));

  if (rest.length > 0) {
    const label = (open) => open ? "Hide other sources" : `Show ${rest.length} more source${rest.length > 1 ? "s" : ""}`;
    const toggle = document.createElement("button");
    toggle.className = "linkBtn";
    toggle.textContent = label(false);
    const moreList = document.createElement("ul");
    moreList.className = "sources hidden";
    rest.forEach((s) => moreList.appendChild(makeSourceItem(s)));
    toggle.addEventListener("click", () => {
      moreList.classList.toggle("hidden");
      toggle.textContent = label(!moreList.classList.contains("hidden"));
    });
    sourcesList.append(toggle, moreList);
  }
}

forgetHourBtn.addEventListener("click", async () => {
  const { deleted } = await send({ type: "FORGET_LAST_HOUR" });
  statusLine.textContent = `Forgot ${deleted} item(s) from the last hour.`;
});

refreshLockState();