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
  const { prompt = "", project = "", schedule } = await chrome.storage.local.get(["prompt", "schedule", "project"]);
  if (!prompt.trim()) return;

  try {
    const targetUrl = schedule?.targetUrl || "";
    const continueChat = Boolean(targetUrl);
    const tab = await getOrOpenClaudeTab(targetUrl);
    await waitForTabReady(tab.id);
    await sendToContent(tab.id, { type: "RUN_PROMPT", prompt, project, continueChat });
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
    const update = { prompt: message.prompt || "" };
    if (typeof message.project === "string") update.project = message.project;
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
    if (!message.project) {
      const tab = await findActiveTab();
      const url = tab?.url || "";
      if (url.startsWith("https://claude.ai/code") && isConversationUrl(url)) targetUrl = url;
    }
    const schedule = { runAt, source: message.source || "manual time", createdAt: Date.now(), targetUrl };
    const update = { prompt: message.prompt || "", schedule };
    if (typeof message.project === "string") update.project = message.project;
    await chrome.storage.local.set(update);
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
  const { prompt = "", project = "", schedule = null } = await chrome.storage.local.get(["prompt", "schedule", "project"]);
  return { prompt, project, schedule };
}

async function getUsage(force = false) {
  const { usageCache } = await chrome.storage.local.get("usageCache");
  if (!force && usageCache?.lastPulledAt && Date.now() - usageCache.lastPulledAt < CACHE_TTL_MS) {
    return usageCache;
  }

  const tab = await getUsageTab();
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
  if (onUsage?.id) return onUsage;
  return chrome.tabs.create({ url: "https://claude.ai/code#settings/usage", active: false });
}

async function getPageStatus() {
  const tab = await findActiveTab();
  if (!tab?.id || !tab.url?.startsWith("https://claude.ai/code")) {
    return {
      isClaudeCodePage: false,
      hasPromptEditor: false,
      projectName: "",
      checkedAt: Date.now()
    };
  }

  try {
    return await sendToContent(tab.id, { type: "GET_PAGE_STATUS" });
  } catch (error) {
    return {
      isClaudeCodePage: true,
      hasPromptEditor: false,
      projectName: "",
      checkedAt: Date.now()
    };
  }
}

async function getProjects() {
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

async function getOrOpenClaudeTab(targetUrl = "") {
  const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });

  // Continue a specific chat: reuse the exact tab if it's still on that URL,
  // otherwise navigate a Claude tab (or a new one) back to that conversation.
  if (targetUrl) {
    const onUrl = tabs.find(tab => tab.url === targetUrl);
    if (onUrl?.id) {
      await chrome.tabs.update(onUrl.id, { active: true });
      return onUrl;
    }
    const reusable = tabs.find(tab => tab.url?.startsWith("https://claude.ai/code"));
    if (reusable?.id) {
      await chrome.tabs.update(reusable.id, { url: targetUrl, active: true });
      return chrome.tabs.get(reusable.id);
    }
    return chrome.tabs.create({ url: targetUrl, active: true });
  }

  const existing = tabs.find(tab => tab.url?.startsWith("https://claude.ai/code"));
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    return existing;
  }
  return chrome.tabs.create({ url: "https://claude.ai/code#settings/usage", active: true });
}

function isConversationUrl(url) {
  try {
    const path = new URL(url).pathname.replace(/^\/code\/?/, "");
    return path.length > 0;
  } catch {
    return false;
  }
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
