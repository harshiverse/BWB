const retentionInput = document.getElementById("retentionDays");
const saveBtn = document.getElementById("saveBtn");
const savedMsg = document.getElementById("savedMsg");
const wipeBtn = document.getElementById("wipeBtn");

async function load() {
  const { retentionDays = 30 } = await chrome.storage.sync.get("retentionDays");
  retentionInput.value = retentionDays;
}

saveBtn.addEventListener("click", async () => {
  const retentionDays = Number(retentionInput.value) || 30;
  await chrome.storage.sync.set({ retentionDays });
  savedMsg.style.display = "inline";
  setTimeout(() => (savedMsg.style.display = "none"), 1500);
});

wipeBtn.addEventListener("click", async () => {
  if (!confirm("This deletes all locally stored memory. Continue?")) return;
  await chrome.runtime.sendMessage({ type: "WIPE_ALL" });
  alert("All local memory wiped.");
});

load();
