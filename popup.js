const usageSummary = document.querySelector("#usageSummary");
const sessionUsage = document.querySelector("#sessionUsage");
const resetTime = document.querySelector("#resetTime");
const promptInput = document.querySelector("#promptInput");
const manualTime = document.querySelector("#manualTime");
const useResetButton = document.querySelector("#useResetButton");
const scheduleButton = document.querySelector("#scheduleButton");
const scheduledText = document.querySelector("#scheduledText");
const cancelButton = document.querySelector("#cancelButton");
const message = document.querySelector("#message");

let latestUsage = null;

init();

async function init() {
  const state = await sendRuntimeMessage({ type: "GET_STATE" });
  promptInput.value = state.prompt || "";
  renderSchedule(state.schedule);
  await refreshUsage();
}

promptInput.addEventListener("input", saveDraft);

useResetButton.addEventListener("click", async () => {
  clearMessage();
  await saveDraft();
  if (!promptInput.value.trim()) return showMessage("Paste a prompt first.", true);
  const usage = latestUsage || await refreshUsage();
  if (!usage?.resetAt) return showMessage("Claude did not expose a session reset time yet.", true);
  await scheduleAt(usage.resetAt, "next limit reset");
});

scheduleButton.addEventListener("click", async () => {
  clearMessage();
  await saveDraft();
  if (!promptInput.value.trim()) return showMessage("Paste a prompt first.", true);
  if (!manualTime.value) return showMessage("Choose a manual time.", true);
  const runAt = new Date(manualTime.value).getTime();
  if (!Number.isFinite(runAt) || runAt <= Date.now()) return showMessage("Choose a future time.", true);
  await scheduleAt(runAt, "manual time");
});

cancelButton.addEventListener("click", async () => {
  const state = await sendRuntimeMessage({ type: "CANCEL_SCHEDULE" });
  renderSchedule(state.schedule);
  showMessage("Scheduled run cancelled.");
});

async function saveDraft() {
  await sendRuntimeMessage({
    type: "SAVE_DRAFT",
    prompt: promptInput.value
  });
}

async function refreshUsage() {
  try {
    setLoading(true);
    latestUsage = await sendRuntimeMessage({ type: "GET_USAGE" });
    renderUsage(latestUsage);
    return latestUsage;
  } catch (error) {
    showMessage(error.message || "Could not read Claude usage.", true);
    usageSummary.textContent = "Open Claude Code and try again";
    return null;
  } finally {
    setLoading(false);
  }
}

async function scheduleAt(runAt, source) {
  const state = await sendRuntimeMessage({
    type: "SCHEDULE_PROMPT",
    runAt,
    source,
    prompt: promptInput.value
  });
  renderSchedule(state.schedule);
  showMessage(`Scheduled for ${formatDate(runAt)}.`);
}

function renderUsage(usage) {
  if (!usage) return;
  sessionUsage.textContent = usage.sessionUsage || "-";
  resetTime.textContent = usage.resetAt ? formatDate(usage.resetAt) : usage.resetText || "-";
  usageSummary.textContent = usage.lastPulledAt
    ? `Usage checked ${relativeTime(usage.lastPulledAt)}`
    : "Usage checked";
}

function renderSchedule(schedule) {
  if (!schedule?.runAt) {
    scheduledText.textContent = "Nothing scheduled";
    cancelButton.disabled = true;
    return;
  }
  scheduledText.textContent = `${formatDate(schedule.runAt)} (${minutesUntil(schedule.runAt)})`;
  cancelButton.disabled = false;
}

async function sendRuntimeMessage(payload) {
  const response = await chrome.runtime.sendMessage(payload);
  if (response?.error) throw new Error(response.error);
  return response;
}

function setLoading(loading) {
  useResetButton.disabled = loading;
  scheduleButton.disabled = loading;
  if (loading) usageSummary.textContent = "Checking Claude usage…";
}

function showMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("error", isError);
}

function clearMessage() {
  showMessage("");
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function minutesUntil(value) {
  const minutes = Math.max(0, Math.round((value - Date.now()) / 60000));
  if (minutes < 1) return "under 1 min";
  if (minutes === 1) return "1 min";
  return `${minutes} min`;
}

function relativeTime(value) {
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  return `${minutes} min ago`;
}
