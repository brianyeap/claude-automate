const GITHUB_REPO = "brianyeap/claude-automate";
const UPDATE_CHECK_TTL = 60 * 60 * 1000;

const usageSummary = document.querySelector("#usageSummary");
const sessionUsage = document.querySelector("#sessionUsage");
const resetTime = document.querySelector("#resetTime");
const pageStatusDot = document.querySelector("#pageStatusDot");
const pageStatusText = document.querySelector("#pageStatusText");
const projectText = document.querySelector("#projectText");
const projectSelect = document.querySelector("#projectSelect");
const targetHint = document.querySelector("#targetHint");
const promptInput = document.querySelector("#promptInput");
const manualTime = document.querySelector("#manualTime");
const useResetButton = document.querySelector("#useResetButton");
const scheduleButton = document.querySelector("#scheduleButton");
const scheduledText = document.querySelector("#scheduledText");
const cancelButton = document.querySelector("#cancelButton");
const refreshButton = document.querySelector("#refreshButton");
const toast = document.querySelector("#toast");

let latestUsage = null;
let latestPageStatus = null;
let pageStatusTimer = null;
let scheduleTimer = null;
let usageTimer = null;
let currentSchedule = null;

init();

async function init() {
  const state = await sendRuntimeMessage({ type: "GET_STATE" });
  promptInput.value = state.prompt || "";
  renderSchedule(state.schedule);
  const status = await refreshPageStatus();
  pageStatusTimer = setInterval(refreshPageStatus, 1000);
  await refreshProjects(state.project);
  checkForUpdates();
  if (!status?.isClaudeCodePage) {
    usageSummary.textContent = "Open Claude Code to read usage";
    return;
  }
  await refreshUsage();
}

async function checkForUpdates() {
  const local = chrome.runtime.getManifest().version;
  const { updateCache } = await chrome.storage.local.get("updateCache");
  if (updateCache?.checkedAt && Date.now() - updateCache.checkedAt < UPDATE_CHECK_TTL) {
    renderUpdateBanner(updateCache);
    return;
  }

  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${GITHUB_REPO}/main/manifest.json`,
      { cache: "no-store" }
    );
    if (!res.ok) return;
    const { version: remote } = await res.json();
    if (!isNewerVersion(remote, local)) {
      await chrome.storage.local.set({ updateCache: { upToDate: true, checkedAt: Date.now() } });
      return;
    }

    let commitsBehind = 0;
    try {
      const { installedAt } = await chrome.storage.local.get("installedAt");
      const since = installedAt ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const apiRes = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/commits?sha=main&since=${since}&per_page=100`
      );
      if (apiRes.ok) {
        const commits = await apiRes.json();
        commitsBehind = Array.isArray(commits) ? commits.length : 0;
      }
    } catch {}

    const cache = { upToDate: false, remote, local, commitsBehind, checkedAt: Date.now() };
    await chrome.storage.local.set({ updateCache: cache });
    renderUpdateBanner(cache);
  } catch {}
}

function isNewerVersion(remote, local) {
  const parse = v => v.split(".").map(Number);
  const [rA, rB, rC] = parse(remote);
  const [lA, lB, lC] = parse(local);
  return rA !== lA ? rA > lA : rB !== lB ? rB > lB : rC > lC;
}

function renderUpdateBanner({ upToDate, remote, commitsBehind }) {
  const banner = document.querySelector("#updateBanner");
  if (!banner || upToDate || !remote) return;
  const behind = commitsBehind > 0
    ? ` · ${commitsBehind} commit${commitsBehind === 1 ? "" : "s"} behind`
    : "";
  banner.querySelector("#updateBannerText").textContent = `v${remote} available${behind}`;
  banner.hidden = false;
}

async function refreshProjects(savedProject) {
  let result = { projects: [], current: "" };
  try {
    result = await sendRuntimeMessage({ type: "GET_PROJECTS" });
  } catch (error) {
    // Keep the bare "Auto" option if the project list can't be read.
  }

  const autoLabel = result.current ? `Auto (current page: ${result.current})` : "Auto (current page)";
  const options = [`<option value="">${escapeHtml(autoLabel)}</option>`];
  for (const project of result.projects || []) {
    const value = project.repo || project.name;
    options.push(`<option value="${escapeHtml(value)}">${escapeHtml(project.name)}</option>`);
  }
  projectSelect.innerHTML = options.join("");

  // Default to the saved project if it still exists, otherwise auto-detect.
  const values = [...projectSelect.options].map(option => option.value);
  projectSelect.value = savedProject && values.includes(savedProject) ? savedProject : "";
}

window.addEventListener("pagehide", () => {
  if (pageStatusTimer) clearInterval(pageStatusTimer);
  stopScheduleTimer();
  stopUsageTimer();
});

refreshButton.addEventListener("click", async () => {
  clearMessage();
  await refreshUsage(true);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !("schedule" in changes)) return;
  const schedule = changes.schedule.newValue || null;
  renderSchedule(schedule);
  if (!schedule) showMessage("Scheduled run fired.");
});

promptInput.addEventListener("input", saveDraft);

projectSelect.addEventListener("change", () => {
  renderTargetHint();
  saveDraft();
});

useResetButton.addEventListener("click", async () => {
  clearMessage();
  await saveDraft();
  if (!promptInput.value.trim()) return showMessage("Paste a prompt first.", true);
  const usage = latestUsage || await refreshUsage();
  if (!usage?.resetAt) return showMessage("Claude did not expose a session reset time yet.", true);
  // Fire 1 minute after the reset so the new session window is definitely open.
  await scheduleAt(usage.resetAt + 60_000, "next limit reset +1 min");
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
    prompt: promptInput.value,
    project: projectSelect.value
  });
}

async function refreshUsage(force = false) {
  try {
    setLoading(true);
    latestUsage = await sendRuntimeMessage({ type: "GET_USAGE", force });
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
    prompt: promptInput.value,
    project: projectSelect.value
  });
  renderSchedule(state.schedule);
  showMessage(`Scheduled for ${formatDate(runAt)}.`);
}

function renderUsage(usage) {
  if (!usage) return;
  sessionUsage.textContent = usage.sessionUsage || "-";
  renderUsageLive();
  startUsageTimer();
}

function renderUsageLive() {
  const usage = latestUsage;
  if (!usage) return;
  resetTime.textContent = usage.resetAt
    ? `${formatDate(usage.resetAt)} (${timeUntil(usage.resetAt)})`
    : usage.resetText || "-";
  usageSummary.textContent = usage.lastPulledAt
    ? `Usage checked ${relativeTime(usage.lastPulledAt)}`
    : "Usage checked";
}

function startUsageTimer() {
  if (usageTimer) return;
  usageTimer = setInterval(renderUsageLive, 1000);
}

function stopUsageTimer() {
  if (usageTimer) clearInterval(usageTimer);
  usageTimer = null;
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

  latestPageStatus = status;
  renderTargetHint();
}

// Show whether an Auto run will continue this exact chat or open a new session.
function renderTargetHint() {
  if (!targetHint) return;
  const isAuto = !projectSelect.value;
  if (isAuto && latestPageStatus?.isConversation) {
    targetHint.textContent = "↳ Will continue this chat";
  } else if (isAuto) {
    targetHint.textContent = "↳ Will start a new session on the current page";
  } else {
    targetHint.textContent = "↳ Will start a new session in the selected project";
  }
}

function renderSchedule(schedule) {
  currentSchedule = schedule?.runAt ? schedule : null;
  if (!currentSchedule) {
    scheduledText.textContent = "Nothing scheduled";
    cancelButton.disabled = true;
    stopScheduleTimer();
    return;
  }
  scheduledText.textContent = `${formatDate(currentSchedule.runAt)} (${timeUntil(currentSchedule.runAt)})`;
  cancelButton.disabled = false;
  startScheduleTimer();
}

function startScheduleTimer() {
  if (scheduleTimer) return;
  scheduleTimer = setInterval(() => {
    if (!currentSchedule) return stopScheduleTimer();
    scheduledText.textContent = `${formatDate(currentSchedule.runAt)} (${timeUntil(currentSchedule.runAt)})`;
  }, 1000);
}

function stopScheduleTimer() {
  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleTimer = null;
}

async function sendRuntimeMessage(payload) {
  const response = await chrome.runtime.sendMessage(payload);
  if (response?.error) throw new Error(response.error);
  return response;
}

function setLoading(loading) {
  useResetButton.disabled = loading;
  scheduleButton.disabled = loading;
  refreshButton.disabled = loading;
  refreshButton.classList.toggle("spinning", loading);
  if (loading) usageSummary.textContent = "Checking Claude usage…";
}

let toastTimer = null;

function showMessage(text, isError = false) {
  if (!text) return clearMessage();
  if (toastTimer) clearTimeout(toastTimer);
  toast.textContent = text;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  toastTimer = setTimeout(clearMessage, 3200);
}

function clearMessage() {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  toast.classList.remove("show");
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(new Date(value));
}

function timeUntil(value) {
  const totalMinutes = Math.max(0, Math.round((value - Date.now()) / 60000));
  if (totalMinutes < 1) return "under 1M";

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes}M`;
  if (!minutes) return `${hours}H`;
  return `${hours}H ${minutes}M`;
}

function relativeTime(value) {
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return minutes === 1 ? "1 min ago" : `${minutes} min ago`;
}
