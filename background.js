const CACHE_TTL_MS = 60_000;
const ALARM_NAME = "claude-limit-runner";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(error => {
    sendResponse({ error: error.message || String(error) });
  });
  return true;
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ALARM_NAME) return;
  const { prompt = "", repo = "", schedule } = await chrome.storage.local.get(["prompt", "repo", "schedule"]);
  if (!prompt.trim()) return;

  try {
    const tab = await getOrOpenClaudeTab();
    await waitForTabReady(tab.id);
    await sendToContent(tab.id, { type: "RUN_PROMPT", prompt, repo });
    await chrome.storage.local.remove("schedule");
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
    await chrome.storage.local.set({ prompt: message.prompt || "", repo: message.repo || "" });
    return getState();
  }

  if (message.type === "GET_USAGE") {
    return getUsage();
  }

  if (message.type === "SCHEDULE_PROMPT") {
    const runAt = Number(message.runAt);
    if (!Number.isFinite(runAt) || runAt <= Date.now()) throw new Error("Schedule time must be in the future.");
    const schedule = { runAt, source: message.source || "manual time", createdAt: Date.now() };
    await chrome.storage.local.set({
      prompt: message.prompt || "",
      repo: message.repo || "",
      schedule
    });
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.create(ALARM_NAME, { when: runAt });
    return getState();
  }

  if (message.type === "CANCEL_SCHEDULE") {
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.storage.local.remove("schedule");
    return getState();
  }

  throw new Error(`Unknown message type: ${message.type}`);
}

async function getState() {
  const { prompt = "", repo = "", schedule = null } = await chrome.storage.local.get(["prompt", "repo", "schedule"]);
  return { prompt, repo, schedule };
}

async function getUsage() {
  const { usageCache } = await chrome.storage.local.get("usageCache");
  if (usageCache?.lastPulledAt && Date.now() - usageCache.lastPulledAt < CACHE_TTL_MS) {
    return usageCache;
  }

  const tab = await getOrOpenClaudeTab();
  await waitForTabReady(tab.id);
  const usage = await sendToContent(tab.id, { type: "GET_USAGE" });
  const cache = { ...usage, lastPulledAt: Date.now() };
  await chrome.storage.local.set({ usageCache: cache });
  return cache;
}

async function getOrOpenClaudeTab() {
  const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
  const existing = tabs.find(tab => tab.url?.startsWith("https://claude.ai/code"));
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    return existing;
  }
  return chrome.tabs.create({ url: "https://claude.ai/code#settings/usage", active: true });
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
