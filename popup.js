const CREDIT_LIMIT = 5000;
const DEFAULT_PERSONALITY = {
  name: "Memo",
  tone: "professional",
  length: "concise",
  creativity: 50,
  emoji: true,
  proactive: true
};

const usageSummary = document.querySelector("#usageSummary");
const promptInput = document.querySelector("#promptInput");
const manualTime = document.querySelector("#manualTime");
const useResetButton = document.querySelector("#useResetButton");
const scheduleButton = document.querySelector("#scheduleButton");
const scheduledText = document.querySelector("#scheduledText");
const cancelButton = document.querySelector("#cancelButton");
const refreshButton = document.querySelector("#refreshButton");
const sendButton = document.querySelector("#sendButton");
const toast = document.querySelector("#toast");
const thread = document.querySelector("#thread");
const suggestions = document.querySelector("#suggestions");
const onlinePill = document.querySelector("#onlinePill");
const scrim = document.querySelector("#scrim");
const usageSheet = document.querySelector("#usageSheet");
const personalitySheet = document.querySelector("#personalitySheet");

let latestUsage = null;
let latestPageStatus = null;
let scheduleTimer = null;
let usageTimer = null;
let currentSchedule = null;
let currentState = null;
let busy = false;

init();

async function init() {
  document.querySelector("#greetingTime").textContent = formatDate(Date.now());
  const { memoPersonality = DEFAULT_PERSONALITY } = await chrome.storage.local.get("memoPersonality");
  applyPersonality({ ...DEFAULT_PERSONALITY, ...memoPersonality });

  currentState = await sendRuntimeMessage({ type: "GET_STATE" });
  promptInput.value = currentState.prompt || "";
  renderSchedule(currentState.schedule);
  autosize();

  wireEvents();
  await Promise.all([refreshPageStatus(), refreshUsage()]);
  usageTimer = setInterval(renderUsageLive, 1000);
}

function wireEvents() {
  window.addEventListener("pagehide", () => {
    if (scheduleTimer) clearInterval(scheduleTimer);
    if (usageTimer) clearInterval(usageTimer);
  });

  refreshButton.addEventListener("click", async () => {
    clearMessage();
    await Promise.all([refreshPageStatus(), refreshUsage(true)]);
  });

  promptInput.addEventListener("input", () => {
    autosize();
    saveDraft();
  });
  promptInput.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendNow();
    }
  });
  sendButton.addEventListener("click", sendNow);

  document.querySelectorAll("[data-fill]").forEach(button => {
    button.addEventListener("click", () => {
      promptInput.value = button.dataset.fill;
      autosize();
      saveDraft();
      promptInput.focus();
    });
  });

  useResetButton.addEventListener("click", scheduleForReset);
  scheduleButton.addEventListener("click", scheduleManual);
  cancelButton.addEventListener("click", cancelSchedule);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !("schedule" in changes)) return;
    renderSchedule(changes.schedule.newValue || null);
    if (!changes.schedule.newValue) addAiMessage("Scheduled run fired or was cleared.");
  });

  document.querySelector("#usageButton").addEventListener("click", () => openSheet(usageSheet));
  document.querySelector("#personalityButton").addEventListener("click", () => openSheet(personalitySheet));
  scrim.addEventListener("click", closeSheets);
  document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", closeSheets));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeSheets();
  });

  wirePersonality();
}

function wirePersonality() {
  document.querySelectorAll("#lengthSegment button").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll("#lengthSegment button").forEach(item => item.classList.toggle("active", item === button));
    });
  });

  const range = document.querySelector("#creativityRange");
  range.addEventListener("input", syncCreativityLabel);
  document.querySelector("#resetPersonality").addEventListener("click", () => {
    applyPersonality(DEFAULT_PERSONALITY, true);
  });
  document.querySelector("#savePersonality").addEventListener("click", async () => {
    const personality = readPersonalityForm();
    await chrome.storage.local.set({ memoPersonality: personality });
    applyPersonality(personality);
    showMessage("Personality saved.");
    closeSheets();
  });
}

async function sendNow() {
  const text = promptInput.value.trim();
  if (!text || busy) return;
  clearMessage();
  busy = true;
  suggestions.classList.add("hide");
  addUserMessage(text);
  promptInput.value = "";
  autosize();
  await saveDraft("");

  const thinking = addThinking();
  try {
    const result = await sendRuntimeMessage({ type: "SEND_PROMPT_NOW", prompt: text });
    thinking.finish(`Sent to ${targetLabel(result.targetMode)}. I will keep the current Claude tab in focus so you can watch it run.`);
    bumpCredits(12);
  } catch (error) {
    thinking.finish(`I could not send that yet: ${error.message || "Claude was not ready"}. You can still schedule it for the next reset.`);
    showMessage(error.message || "Could not send prompt.", true);
  } finally {
    busy = false;
  }
}

async function scheduleForReset() {
  clearMessage();
  await saveDraft();
  if (!promptInput.value.trim()) return showMessage("Type the prompt first.", true);
  const usage = latestUsage || await refreshUsage();
  if (!usage?.resetAt) return showMessage("Claude did not expose a session reset time yet.", true);
  await scheduleAt(usage.resetAt + 60_000, "next limit reset +1 min");
}

async function scheduleManual() {
  clearMessage();
  await saveDraft();
  if (!promptInput.value.trim()) return showMessage("Type the prompt first.", true);
  if (!manualTime.value) return showMessage("Choose a manual time.", true);
  const runAt = new Date(manualTime.value).getTime();
  if (!Number.isFinite(runAt) || runAt <= Date.now()) return showMessage("Choose a future time.", true);
  await scheduleAt(runAt, "manual time");
}

async function cancelSchedule() {
  const state = await sendRuntimeMessage({ type: "CANCEL_SCHEDULE" });
  renderSchedule(state.schedule);
  showMessage("Scheduled run cancelled.");
}

async function saveDraft(prompt = promptInput.value) {
  const targetMode = currentState?.targetMode || "code";
  currentState = await sendRuntimeMessage({ type: "SAVE_DRAFT", prompt, targetMode });
}

async function scheduleAt(runAt, source) {
  const targetMode = currentState?.targetMode || "code";
  const state = await sendRuntimeMessage({
    type: "SCHEDULE_PROMPT",
    runAt,
    source,
    prompt: promptInput.value,
    targetMode
  });
  currentState = state;
  renderSchedule(state.schedule);
  addAiMessage(`Done. I scheduled that for ${formatDate(runAt)}.`);
}

async function refreshUsage(force = false) {
  try {
    setLoading(true);
    latestUsage = await sendRuntimeMessage({ type: "GET_USAGE", force });
    renderUsage(latestUsage);
    return latestUsage;
  } catch (error) {
    usageSummary.textContent = "Open Claude to read usage";
    renderCredits(1240, CREDIT_LIMIT);
    return null;
  } finally {
    setLoading(false);
  }
}

async function refreshPageStatus() {
  try {
    latestPageStatus = await sendRuntimeMessage({ type: "GET_PAGE_STATUS" });
  } catch {
    latestPageStatus = null;
  }
  renderPageStatus(latestPageStatus);
  return latestPageStatus;
}

function renderPageStatus(status) {
  const ready = status?.isTargetPage && status?.hasPromptEditor;
  onlinePill.classList.toggle("offline", !ready);
  onlinePill.lastChild.textContent = ready ? " Online" : " Offline";
}

function renderUsage(usage) {
  const used = creditsFromUsage(usage);
  renderCredits(used, CREDIT_LIMIT);
  renderUsageLive();
}

function renderUsageLive() {
  if (!latestUsage) return;
  const reset = latestUsage.resetAt
    ? `${formatDate(latestUsage.resetAt)} (${timeUntil(latestUsage.resetAt)})`
    : latestUsage.resetText || "No reset time found";
  usageSummary.textContent = latestUsage.sessionUsage || "Usage checked";
  document.querySelector("#usageResetText").textContent = `Reset: ${reset}`;
}

function creditsFromUsage(usage) {
  const percent = Number((usage?.sessionUsage || "").match(/(\d+(?:\.\d+)?)\s*%/)?.[1]);
  if (Number.isFinite(percent)) return Math.min(CREDIT_LIMIT, Math.round(CREDIT_LIMIT * percent / 100));
  return 1240;
}

function renderCredits(used, limit) {
  const left = Math.max(0, limit - used);
  const remainingPct = Math.max(0, Math.min(100, left / limit * 100));
  document.querySelector("#creditUsed").textContent = used.toLocaleString();
  document.querySelector("#creditLimit").textContent = limit.toLocaleString();
  document.querySelector("#creditUsedMeta").textContent = used.toLocaleString();
  document.querySelector("#creditLimitMeta").textContent = limit.toLocaleString();
  document.querySelector("#creditLeft").textContent = left.toLocaleString();
  document.querySelector(".creditRing").style.setProperty("--credit-progress", `${remainingPct}%`);
  document.querySelector("#scheduleUsage").textContent = `${Math.min(100, Math.round(used / limit * 26))}%`;
  document.querySelector("#responseUsage").textContent = `${Math.min(100, Math.round(used / limit * 88))}%`;
  document.querySelector("#statusUsage").textContent = `${Math.min(100, Math.round(used / limit * 12))}%`;
}

function bumpCredits(amount) {
  const current = Number(document.querySelector("#creditUsed").textContent.replace(/,/g, "")) || creditsFromUsage(latestUsage);
  renderCredits(Math.min(CREDIT_LIMIT, current + amount), CREDIT_LIMIT);
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

function addUserMessage(text) {
  const article = document.createElement("article");
  article.className = "message user animIn";
  article.innerHTML = `
    <div class="avatar meAvatar" aria-hidden="true">You</div>
    <div>
      <div class="bubble"><p>${escapeHtml(text)}</p></div>
      <time>${formatDate(Date.now())}</time>
    </div>`;
  thread.appendChild(article);
  scrollDown();
}

function addAiMessage(text) {
  const article = document.createElement("article");
  article.className = "message ai animIn";
  article.innerHTML = `
    <div class="avatar aiAvatar" aria-hidden="true">✦</div>
    <div>
      <div class="bubble"><p>${escapeHtml(text)}</p></div>
      <time>${formatDate(Date.now())}</time>
    </div>`;
  thread.appendChild(article);
  scrollDown();
}

function addThinking() {
  const statuses = [
    "Reading your request...",
    "Checking Claude page status...",
    "Preparing the handoff..."
  ];
  const article = document.createElement("article");
  article.className = "thinking animIn";
  article.innerHTML = `
    <div class="avatar aiAvatar" aria-hidden="true">✦</div>
    <div class="thinkCard">
      <div class="thinkRow">
        <span class="orbit" aria-hidden="true"></span>
        <span class="thinkText">${statuses[0]}</span>
        <span class="thinkElapsed">0.0s</span>
      </div>
    </div>`;
  thread.appendChild(article);
  scrollDown();

  const text = article.querySelector(".thinkText");
  const elapsed = article.querySelector(".thinkElapsed");
  const started = performance.now();
  let index = 0;
  const statusTimer = setInterval(() => {
    index = Math.min(statuses.length - 1, index + 1);
    text.textContent = statuses[index];
  }, 650);
  const elapsedTimer = setInterval(() => {
    elapsed.textContent = `${((performance.now() - started) / 1000).toFixed(1)}s`;
  }, 100);

  return {
    finish(message) {
      clearInterval(statusTimer);
      clearInterval(elapsedTimer);
      const total = ((performance.now() - started) / 1000).toFixed(1);
      article.className = "aiGroup animIn";
      article.innerHTML = `
        <div class="avatar aiAvatar" aria-hidden="true">✦</div>
        <div class="aiStack">
          <div class="bubble"><p><span class="streamTarget"></span><span class="streamCursor"></span></p></div>
          <time>Thought for ${total}s · ${formatDate(Date.now())}</time>
        </div>`;
      streamText(article.querySelector(".streamTarget"), article.querySelector(".streamCursor"), message);
    }
  };
}

function streamText(target, cursor, full) {
  let index = 0;
  const timer = setInterval(() => {
    index += Math.max(1, Math.round(Math.random() * 3));
    target.textContent = full.slice(0, index);
    scrollDown();
    if (index >= full.length) {
      clearInterval(timer);
      cursor.remove();
    }
  }, 18);
}

function autosize() {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 120)}px`;
  sendButton.classList.toggle("armed", promptInput.value.trim().length > 0);
}

function openSheet(sheet) {
  scrim.classList.add("show");
  sheet.classList.add("show");
}

function closeSheets() {
  scrim.classList.remove("show");
  usageSheet.classList.remove("show");
  personalitySheet.classList.remove("show");
}

function applyPersonality(personality, syncForm = false) {
  document.querySelector("#assistantName").textContent = personality.name || "Memo";
  if (!syncForm) {
    document.querySelector("#agentNameInput").value = personality.name || "Memo";
    document.querySelector("#toneSelect").value = personality.tone || "professional";
    document.querySelector("#creativityRange").value = personality.creativity ?? 50;
    document.querySelector("#emojiToggle").checked = personality.emoji !== false;
    document.querySelector("#proactiveToggle").checked = personality.proactive !== false;
  }
  document.querySelectorAll("#lengthSegment button").forEach(button => {
    button.classList.toggle("active", button.dataset.value === (personality.length || "concise"));
  });
  if (syncForm) {
    document.querySelector("#agentNameInput").value = personality.name;
    document.querySelector("#toneSelect").value = personality.tone;
    document.querySelector("#creativityRange").value = personality.creativity;
    document.querySelector("#emojiToggle").checked = personality.emoji;
    document.querySelector("#proactiveToggle").checked = personality.proactive;
  }
  syncCreativityLabel();
}

function readPersonalityForm() {
  return {
    name: document.querySelector("#agentNameInput").value.trim() || "Memo",
    tone: document.querySelector("#toneSelect").value,
    length: document.querySelector("#lengthSegment button.active")?.dataset.value || "concise",
    creativity: Number(document.querySelector("#creativityRange").value),
    emoji: document.querySelector("#emojiToggle").checked,
    proactive: document.querySelector("#proactiveToggle").checked
  };
}

function syncCreativityLabel() {
  const value = Number(document.querySelector("#creativityRange").value);
  const label = value < 20 ? "Precise" : value < 40 ? "Grounded" : value <= 60 ? "Balanced" : value < 80 ? "Expressive" : "Creative";
  document.querySelector("#creativityLabel").textContent = label;
}

async function sendRuntimeMessage(payload) {
  const response = await chrome.runtime.sendMessage(payload);
  if (response?.error) throw new Error(response.error);
  return response;
}

function setLoading(loading) {
  refreshButton.disabled = loading;
  refreshButton.classList.toggle("spinning", loading);
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

function scrollDown() {
  requestAnimationFrame(() => {
    thread.scrollTop = thread.scrollHeight;
  });
}

function targetLabel(targetMode) {
  return targetMode === "design" ? "Claude Design" : "Claude Code";
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
