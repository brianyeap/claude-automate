const CACHE_TTL_MS = 60_000;
const ALARM_NAME = "claude-limit-runner";
const ACTIVE_REFRESH_ALARM_NAME = "claude-limit-runner-active-refresh";
const ACTIVE_REFRESH_PERIOD_MINUTES = 3;
const TARGET_URLS = {
  code: "https://claude.ai/code",
  design: "https://claude.ai/design"
};

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install" || reason === "update") {
    chrome.storage.local.set({ installedAt: new Date().toISOString() });
    chrome.storage.local.remove("updateCache");
  }
  syncActiveRefreshAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  syncActiveRefreshAlarm();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(error => {
    sendResponse({ error: error.message || String(error) });
  });
  return true;
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === ACTIVE_REFRESH_ALARM_NAME) {
    await refreshActiveClaudeTab();
    return;
  }

  if (alarm.name !== ALARM_NAME) return;
  const { prompt = "", project = "", schedule, targetMode = "code" } = await chrome.storage.local.get(["prompt", "schedule", "project", "targetMode"]);
  if (!prompt.trim()) return;

  try {
    const targetUrl = schedule?.targetUrl || "";
    const scheduledMode = normalizeTargetMode(schedule?.targetMode || targetMode);
    const continueChat = Boolean(targetUrl);
    const tab = await getOrOpenClaudeTab(scheduledMode, targetUrl);
    await waitForTabReady(tab.id);
    await sendToContent(tab.id, { type: "RUN_PROMPT", prompt, project, targetMode: scheduledMode, continueChat });
    await chrome.storage.local.remove("schedule");
    await chrome.alarms.clear(ACTIVE_REFRESH_ALARM_NAME);
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "icon.png",
      title: "Claude prompt sent",
      message: schedule?.source ? `Ran scheduled prompt from ${schedule.source}.` : "Ran scheduled prompt."
    });
  } catch (error) {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "icon.png",
      title: "Claude prompt failed",
      message: error.message || String(error)
    });
  }
});

async function handleMessage(message) {
  if (message.type === "GET_STATE") {
    return getState();
  }

  if (message.type === "SAVE_DRAFT") {
    const update = { prompt: message.prompt || "" };
    if (typeof message.project === "string") update.project = message.project;
    if (typeof message.targetMode === "string") update.targetMode = normalizeTargetMode(message.targetMode);
    await chrome.storage.local.set(update);
    return getState();
  }

  if (message.type === "GET_USAGE") {
    return getUsage(Boolean(message.force));
  }

  if (message.type === "GET_PAGE_STATUS") {
    return getPageStatus();
  }

  if (message.type === "GET_PROJECTS") {
    return getProjects();
  }

  if (message.type === "SCHEDULE_PROMPT") {
    const runAt = Number(message.runAt);
    if (!Number.isFinite(runAt) || runAt <= Date.now()) throw new Error("Schedule time must be in the future.");
    // "Auto" (no explicit project) means "continue whatever chat I'm in" — pin the
    // exact conversation URL so the run returns to this thread instead of the launcher.
    let targetUrl = "";
    const targetMode = normalizeTargetMode(message.targetMode);
    if (targetMode === "code" && !message.project) {
      const tab = await findActiveTab();
      const url = tab?.url || "";
      if (url.startsWith("https://claude.ai/code") && isConversationUrl(url)) targetUrl = url;
    } else if (targetMode === "design") {
      const tab = await findActiveTab();
      const url = tab?.url || "";
      if (url.startsWith(TARGET_URLS.design) && isConversationUrl(url)) targetUrl = url;
    }
    const schedule = { runAt, source: message.source || "manual time", createdAt: Date.now(), targetMode, targetUrl };
    const update = { prompt: message.prompt || "", schedule };
    if (typeof message.project === "string") update.project = message.project;
    update.targetMode = targetMode;
    await chrome.storage.local.set(update);
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.create(ALARM_NAME, { when: runAt });
    await startActiveRefreshAlarm();
    return getState();
  }

  if (message.type === "CANCEL_SCHEDULE") {
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.clear(ACTIVE_REFRESH_ALARM_NAME);
    await chrome.storage.local.remove("schedule");
    return getState();
  }

  throw new Error(`Unknown message type: ${message.type}`);
}

async function getState() {
  const { prompt = "", project = "", schedule = null, targetMode = "code" } = await chrome.storage.local.get(["prompt", "schedule", "project", "targetMode"]);
  return { prompt, project, schedule, targetMode: normalizeTargetMode(targetMode) };
}

async function getUsage(force = false) {
  const { usageCache } = await chrome.storage.local.get("usageCache");
  if (!force && usageCache?.lastPulledAt && Date.now() - usageCache.lastPulledAt < CACHE_TTL_MS) {
    return usageCache;
  }

  const { tab, reused } = await getUsageTab();
  // A reused usage tab may have been sitting open for hours showing stale numbers —
  // the SPA won't re-fetch usage on its own, so reload it before scraping. A freshly
  // created tab already loads current data and needs no reload.
  if (reused) {
    await chrome.tabs.reload(tab.id);
  }
  await waitForTabReady(tab.id);
  const usage = await sendToContent(tab.id, { type: "GET_USAGE" });
  const cache = { ...usage, lastPulledAt: Date.now() };
  await chrome.storage.local.set({ usageCache: cache });
  return cache;
}

// Read usage without hijacking the user's current chat. Reuse a tab that's already
// on the usage page if one exists; otherwise open the usage page in a background tab
// so the active conversation tab is left untouched.
async function getUsageTab() {
  const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
  const onUsage = tabs.find(tab => tab.url?.includes("#settings/usage"));
  if (onUsage?.id) return { tab: onUsage, reused: true };
  const tab = await chrome.tabs.create({ url: "https://claude.ai/code#settings/usage", active: false });
  return { tab, reused: false };
}

async function syncActiveRefreshAlarm() {
  const { schedule = null } = await chrome.storage.local.get("schedule");
  if (schedule?.runAt && schedule.runAt > Date.now()) {
    await startActiveRefreshAlarm();
    return;
  }
  await chrome.alarms.clear(ACTIVE_REFRESH_ALARM_NAME);
}

async function startActiveRefreshAlarm() {
  await chrome.alarms.create(ACTIVE_REFRESH_ALARM_NAME, {
    delayInMinutes: ACTIVE_REFRESH_PERIOD_MINUTES,
    periodInMinutes: ACTIVE_REFRESH_PERIOD_MINUTES
  });
}

async function refreshActiveClaudeTab() {
  const { schedule = null, targetMode = "code" } = await chrome.storage.local.get(["schedule", "targetMode"]);
  if (!schedule?.runAt || schedule.runAt <= Date.now()) {
    await chrome.alarms.clear(ACTIVE_REFRESH_ALARM_NAME);
    return;
  }

  const mode = normalizeTargetMode(schedule.targetMode || targetMode);
  const targetUrl = schedule.targetUrl || "";
  const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
  const tab = targetUrl
    ? tabs.find(candidate => candidate.url === targetUrl)
    : tabs.find(candidate => candidate.url?.startsWith(TARGET_URLS[mode]));

  if (tab?.id) await chrome.tabs.reload(tab.id);
}

async function getPageStatus() {
  const { targetMode = "code" } = await chrome.storage.local.get("targetMode");
  const mode = normalizeTargetMode(targetMode);
  const tab = await findActiveTab();
  if (!tab?.id || !tab.url?.startsWith(TARGET_URLS[mode])) {
    return {
      isClaudeCodePage: false,
      isClaudeDesignPage: false,
      isTargetPage: false,
      hasPromptEditor: false,
      projectName: "",
      checkedAt: Date.now()
    };
  }

  try {
    return await sendToContent(tab.id, { type: "GET_PAGE_STATUS", targetMode: mode });
  } catch (error) {
    return {
      isClaudeCodePage: mode === "code",
      isClaudeDesignPage: mode === "design",
      isTargetPage: true,
      hasPromptEditor: false,
      projectName: "",
      checkedAt: Date.now()
    };
  }
}

async function getProjects() {
  const { targetMode = "code" } = await chrome.storage.local.get("targetMode");
  if (normalizeTargetMode(targetMode) !== "code") {
    return { projects: [], current: "", checkedAt: Date.now() };
  }

  const tab = await findActiveTab();
  if (!tab?.id || !tab.url?.startsWith("https://claude.ai/code")) {
    return { projects: [], current: "", checkedAt: Date.now() };
  }

  try {
    return await sendToContent(tab.id, { type: "GET_PROJECTS" });
  } catch (error) {
    return { projects: [], current: "", checkedAt: Date.now() };
  }
}

async function findActiveTab() {
  const [lastFocusedTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (lastFocusedTab) return lastFocusedTab;

  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const focusedWindow = windows.find(window => window.focused);
  return focusedWindow?.tabs?.find(tab => tab.active) || null;
}

async function getOrOpenClaudeTab(targetMode = "code", targetUrl = "") {
  const mode = normalizeTargetMode(targetMode);
  const launcherUrl = TARGET_URLS[mode];
  const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });

  // Continue a specific chat: reuse the exact tab if it's still on that URL,
  // otherwise navigate a Claude tab (or a new one) back to that conversation.
  if (targetUrl) {
    const onUrl = tabs.find(tab => tab.url === targetUrl);
    if (onUrl?.id) {
      await chrome.tabs.update(onUrl.id, { active: true });
      return onUrl;
    }
    const reusable = tabs.find(tab => tab.url?.startsWith(launcherUrl));
    if (reusable?.id) {
      await chrome.tabs.update(reusable.id, { url: targetUrl, active: true });
      return chrome.tabs.get(reusable.id);
    }
    return chrome.tabs.create({ url: targetUrl, active: true });
  }

  const existing = tabs.find(tab => tab.url?.startsWith(launcherUrl));
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    return existing;
  }
  return chrome.tabs.create({ url: launcherUrl, active: true });
}

function isConversationUrl(url) {
  try {
    const path = new URL(url).pathname.replace(/^\/code\/?/, "");
    return path.length > 0;
  } catch {
    return false;
  }
}

function normalizeTargetMode(targetMode) {
  return targetMode === "design" ? "design" : "code";
}

async function waitForTabReady(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") return;
  await new Promise(resolve => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function sendToContent(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    if (response?.error) throw new Error(response.error);
    return response;
  } catch (error) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["contentScript.js"] });
    const response = await chrome.tabs.sendMessage(tabId, message);
    if (response?.error) throw new Error(response.error);
    return response;
  }
}
