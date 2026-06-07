const usageSummary = document.querySelector("#usageSummary");
const sessionUsage = document.querySelector("#sessionUsage");
const resetTime = document.querySelector("#resetTime");
const pageStatusDot = document.querySelector("#pageStatusDot");
const pageStatusText = document.querySelector("#pageStatusText");
const projectText = document.querySelector("#projectText");
const promptInput = document.querySelector("#promptInput");
const testPromptButton = document.querySelector("#testPromptButton");
const manualTime = document.querySelector("#manualTime");
const useResetButton = document.querySelector("#useResetButton");
const scheduleButton = document.querySelector("#scheduleButton");
const scheduledText = document.querySelector("#scheduledText");
const cancelButton = document.querySelector("#cancelButton");
const message = document.querySelector("#message");

let latestUsage = null;
let pageStatusTimer = null;

init();

async function init() {
  const state = await sendRuntimeMessage({ type: "GET_STATE" });
  promptInput.value = state.prompt || "";
  renderSchedule(state.schedule);
  const status = await refreshPageStatus();
  pageStatusTimer = setInterval(refreshPageStatus, 1000);
  if (!status?.isClaudeCodePage) {
    usageSummary.textContent = "Open Claude Code to read usage";
    return;
  }
  await refreshUsage();
}

window.addEventListener("pagehide", () => {
  if (pageStatusTimer) clearInterval(pageStatusTimer);
});

promptInput.addEventListener("input", saveDraft);

testPromptButton.addEventListener("click", async () => {
  clearMessage();
  await saveDraft();
  if (!promptInput.value.trim()) return showMessage("Paste a prompt first.", true);

  try {
    setTesting(true);
    await sendRuntimeMessage({ type: "TEST_PROMPT", prompt: promptInput.value });
    showMessage("Prompt pasted, verified, and cleared.");
    await refreshPageStatus();
  } catch (error) {
    showMessage(error.message || "Could not test the prompt.", true);
  } finally {
    setTesting(false);
  }
});

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

async function refreshPageStatus() {
  try {
    const status = await sendRuntimeMessage({ type: "GET_PAGE_STATUS" });
    renderPageStatus(status);
    return status;
  } catch (error) {
    const status = { isClaudeCodePage: false, hasPromptEditor: false, projectName: "" };
    renderPageStatus(status);
    return status;
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
  resetTime.textContent = usage.resetAt ? `${formatDate(usage.resetAt)} (${timeUntil(usage.resetAt)})` : usage.resetText || "-";
  usageSummary.textContent = usage.lastPulledAt
    ? `Usage checked ${relativeTime(usage.lastPulledAt)}`
    : "Usage checked";
}

function renderPageStatus(status) {
  const isReady = status?.isClaudeCodePage && status?.hasPromptEditor;
  const isClaudeCodePage = status?.isClaudeCodePage;

  pageStatusDot.classList.toggle("ready", isReady);
  pageStatusDot.classList.toggle("warning", isClaudeCodePage && !isReady);
  pageStatusDot.classList.toggle("offline", !isClaudeCodePage);

  if (isReady) {
    pageStatusText.textContent = "Claude Code input box detected";
  } else if (isClaudeCodePage) {
    pageStatusText.textContent = "Claude Code page detected, input box missing";
  } else {
    pageStatusText.textContent = "No Claude Code page detected";
  }

  if (isClaudeCodePage && status?.projectName) {
    projectText.textContent = `Project: ${status.projectName}`;
  } else if (isClaudeCodePage) {
    projectText.textContent = "Project unavailable";
  } else {
    projectText.textContent = "Open Claude Code to show project";
  }
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
  testPromptButton.disabled = loading;
  if (loading) usageSummary.textContent = "Checking Claude usage…";
}

function setTesting(testing) {
  testPromptButton.disabled = testing;
  useResetButton.disabled = testing;
  scheduleButton.disabled = testing;
  if (testing) showMessage("Testing prompt paste…");
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

function timeUntil(value) {
  const totalMinutes = Math.max(0, Math.round((value - Date.now()) / 60000));
  if (totalMinutes < 1) return "under 1 min";

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return minutes === 1 ? "1 min" : `${minutes} min`;
  if (!minutes) return hours === 1 ? "1 hr" : `${hours} hr`;

  const hourText = hours === 1 ? "1 hr" : `${hours} hr`;
  const minuteText = minutes === 1 ? "1 min" : `${minutes} min`;
  return `${hourText} ${minuteText}`;
}

function relativeTime(value) {
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  return `${minutes} min ago`;
}
