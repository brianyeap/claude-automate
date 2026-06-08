(() => {
  if (window.__claudeLimitRunnerInstalled) return;
  window.__claudeLimitRunnerInstalled = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message).then(sendResponse).catch(error => {
      sendResponse({ error: error.message || String(error) });
    });
    return true;
  });

  async function handleMessage(message) {
    if (message.type === "GET_PAGE_STATUS") return readPageStatus(message.targetMode);
    if (message.type === "GET_USAGE") return readUsage();
    if (message.type === "GET_PROJECTS") return readProjects();
    if (message.type === "RUN_PROMPT") return runPrompt(message.prompt, message.project, { targetMode: message.targetMode, continueChat: message.continueChat });
    throw new Error(`Unknown content message: ${message.type}`);
  }

  function readPageStatus(targetMode = "code") {
    const mode = normalizeTargetMode(targetMode);
    return {
      isClaudeCodePage: location.href.startsWith("https://claude.ai/code"),
      isClaudeDesignPage: location.href.startsWith("https://claude.ai/design"),
      isTargetPage: isTargetPage(mode),
      hasPromptEditor: Boolean(findPromptEditor(mode)),
      isConversation: isConversationUrl(location.href),
      url: location.href,
      projectName: mode === "code" ? findProjectName() : "",
      checkedAt: Date.now()
    };
  }

  // A new-session launcher is bare "/code"; an open chat has a session id in the path.
  function isConversationUrl(url) {
    try {
      const path = new URL(url).pathname.replace(/^\/(code|design)\/?/, "");
      return path.length > 0;
    } catch {
      return false;
    }
  }

  function findProjectName() {
    const repoPattern = /(?:^|\s)([\w.-]+\/[\w.-]+)(?:\s|$)/;
    const allCandidates = [...document.querySelectorAll("body *")]
      .filter(isVisible)
      .map(el => compactText(el.textContent))
      .filter(isUsefulProjectText);

    const repoMatch = allCandidates
      .map(text => text.match(repoPattern)?.[1])
      .find(Boolean);
    if (repoMatch) return repoMatch.split("/").pop();

    const chipCandidates = [...document.querySelectorAll("main button, main a, main [role='button'], main [class*='chip'], main [class*='badge']")]
      .filter(isVisible)
      .map(el => compactText(el.textContent))
      .filter(isUsefulProjectText);

    const chipProject = chipCandidates
      .map(text => text.match(/^[\w.-]+$/)?.[0])
      .find(text => !isIgnoredProjectText(text));
    if (chipProject) return chipProject;

    const slashProject = allCandidates
      .map(text => text.match(repoPattern)?.[1]?.split("/").pop())
      .find(Boolean);
    if (slashProject) return slashProject;

    const compactTitle = document.title
      .replace(/\s*[|–-]\s*Claude.*$/i, "")
      .trim();
    return isUsefulProjectText(compactTitle) ? compactTitle : "";
  }

  async function readProjects() {
    const current = findProjectName();
    const trigger = findRepoTrigger();
    if (!trigger) {
      const repos = current ? [{ name: current, repo: "" }] : [];
      return { projects: repos, current, checkedAt: Date.now() };
    }

    trigger.click();
    await sleep(700);
    const repos = readRepoOptions();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(200);

    const seen = new Set();
    const projects = [];
    for (const repo of repos) {
      const name = repo.split("/").pop();
      if (seen.has(repo)) continue;
      seen.add(repo);
      projects.push({ name, repo });
    }
    if (current && !projects.some(project => project.name === current)) {
      projects.unshift({ name: current, repo: "" });
    }
    return { projects, current, checkedAt: Date.now() };
  }

  function findRepoTrigger() {
    const buttons = [...document.querySelectorAll("button, [role='button']")].filter(isVisible);

    // Fresh launcher: explicit "Select repo" label.
    const selectRepo = buttons.find(button => /Select repo/i.test(button.textContent || ""));
    if (selectRepo) return selectRepo;

    // Older UI: the trigger shows the full "owner/repo".
    const ownerRepo = buttons.find(button => /^[\w.-]+\/[\w.-]+$/.test(compactText(button.textContent)));
    if (ownerRepo) return ownerRepo;

    // Newer UI: the trigger is a short repo-name chip (e.g. "transcendence") that
    // opens a dialog. The branch picker next to it is also a dialog trigger, so
    // skip ignored tokens ("main", etc.) and prefer the chip matching the
    // detected project; otherwise fall back to the first such chip (repo comes
    // before branch in the toolbar).
    const dialogChips = buttons.filter(button =>
      button.getAttribute("aria-haspopup") === "dialog"
      && /^[\w.-]+$/.test(compactText(button.textContent))
      && !isIgnoredProjectText(compactText(button.textContent)));
    const current = findProjectName();
    return dialogChips.find(button => compactText(button.textContent) === current) || dialogChips[0];
  }

  function readRepoOptions() {
    const search = document.querySelector('input[placeholder="Search repos…"], input[aria-label="Search repos…"]');
    const popup = search?.closest("[role='dialog'], [role='listbox'], .epitaxy-popup") || document;
    return [...new Set(
      [...popup.querySelectorAll("button, [role='option'], [role='menuitem'], div")]
        .filter(isVisible)
        .map(el => compactText(el.textContent))
        .filter(text => /^[\w.-]+\/[\w.-]+$/.test(text))
    )];
  }

  async function readUsage() {
    if (!location.href.includes("#settings/usage")) {
      location.href = "https://claude.ai/code#settings/usage";
      await sleep(1600);
    }

    await waitForText(/Plan usage limits|Current session|Weekly limits/i, 10_000);
    const lines = document.body.innerText.split("\n").map(line => line.trim()).filter(Boolean);
    const currentIndex = lines.findIndex(line => line === "Current session");
    const weeklyIndex = lines.findIndex(line => line === "Weekly limits");

    const resetText = currentIndex >= 0 ? lines[currentIndex + 1] || "" : "";
    const sessionUsage = currentIndex >= 0 ? lines.slice(currentIndex, currentIndex + 6).find(line => /% used|Starts when/i.test(line)) || "" : "";
    const weeklyUsage = weeklyIndex >= 0 ? lines.slice(weeklyIndex, weeklyIndex + 8).find(line => /% used/i.test(line)) || "" : "";
    const resetAt = parseResetText(resetText);

    return {
      resetAt,
      resetText,
      sessionUsage,
      weeklyUsage,
      rawLines: lines.slice(Math.max(0, currentIndex), Math.max(0, currentIndex) + 16)
    };
  }

  async function runPrompt(prompt, project, options = {}) {
    const mode = normalizeTargetMode(options.targetMode);
    const continueChat = Boolean(options.continueChat);
    if (!prompt?.trim()) throw new Error("No prompt was provided.");
    // Only bounce to the launcher when starting fresh. When continuing a chat we
    // stay on whatever conversation URL we were sent to.
    if (!continueChat && !isTargetPage(mode)) {
      location.href = mode === "design" ? "https://claude.ai/design" : "https://claude.ai/code";
      await sleep(1800);
    }

    await waitForPromptEditor(mode, 15_000);
    // Continuing an existing chat: just drop into this thread's composer, no repo picking.
    if (mode === "code" && !continueChat) await ensureRepoSelected(project);

    const editor = findPromptEditor(mode);
    if (!editor) throw new Error("Could not find Claude prompt box.");

    await setPromptEditorText(editor, prompt.trim());
    await sleep(500);

    if (mode === "design") {
      await submitDesignPrompt(editor);
    } else {
      const send = findEnabledSendButton(editor);
      if (!send) throw new Error("Could not find enabled Send button.");
      send.click();
    }
    return { ok: true, sentAt: Date.now() };
  }

  async function ensureRepoSelected(project) {
    const target = compactText(typeof project === "string" ? project : project?.name || project?.repo || "");
    if (target) return selectRepo(target);

    const selectRepoButton = [...document.querySelectorAll("button")]
      .find(button => isVisible(button) && /Select repo/i.test(button.textContent || ""));

    if (!selectRepoButton) return;

    selectRepoButton.click();
    await sleep(700);

    const candidate = findRepoOption();
    if (!candidate) throw new Error("Claude asked for a repo, but no repo option was found.");
    candidate.click();
    await sleep(1000);
  }

  async function selectRepo(target) {
    const shortName = target.split("/").pop();

    // If the page already shows the wanted repo, there is nothing to switch.
    const trigger = findRepoTrigger();
    if (trigger && !/Select repo/i.test(trigger.textContent || "")) {
      const triggerText = compactText(trigger.textContent);
      if (triggerText === target || triggerText.split("/").pop() === shortName) return;
    }
    if (!trigger) throw new Error("Could not find the repo selector on the page.");

    trigger.click();
    await sleep(700);

    const search = document.querySelector('input[placeholder="Search repos…"], input[aria-label="Search repos…"]');
    if (search) {
      setInputValue(search, shortName);
      await sleep(500);
    }

    const option = findRepoOption(target);
    if (!option) throw new Error(`Could not find the "${shortName}" repo in Claude's repo list.`);
    option.click();
    await sleep(1000);
  }

  function findRepoOption(target) {
    const search = document.querySelector('input[placeholder="Search repos…"], input[aria-label="Search repos…"]');
    const popup = search?.closest("[role='dialog'], [role='listbox'], .epitaxy-popup")
      || search?.parentElement?.parentElement?.parentElement
      || document;
    const options = [...popup.querySelectorAll("button, [role='option'], [role='menuitem'], div")]
      .filter(isVisible)
      .filter(el => /^[\w.-]+\/[\w.-]+$/.test(compactText(el.textContent)));

    if (!target) return options[0];

    const wanted = target.toLowerCase();
    const shortName = wanted.split("/").pop();
    return options.find(el => compactText(el.textContent).toLowerCase() === wanted)
      || options.find(el => compactText(el.textContent).toLowerCase().split("/").pop() === shortName);
  }

  function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function setPromptEditorText(editor, text) {
    if (editor instanceof HTMLTextAreaElement) {
      setTextareaValue(editor, text);
      return;
    }

    await setEditorText(editor, text);
  }

  async function setEditorText(editor, text) {
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("delete");
    document.execCommand("insertText", false, text);
    editor.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text
    }));

    if (!editor.innerText.includes(text.slice(0, 20))) {
      editor.textContent = text;
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text
      }));
    }
  }

  function setTextareaValue(textarea, value) {
    textarea.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) setter.call(textarea, value);
    else textarea.value = value;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function pressEnter(el) {
    el.focus();
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      }));
      await sleep(50);
    }
  }

  async function submitDesignPrompt(editor) {
    await pressEnter(editor);
    await sleep(500);
    if (!editor.value.trim()) return;

    const send = findEnabledSendButton(editor);
    if (send) {
      send.click();
      return;
    }

    throw new Error("Could not submit Claude Design prompt with Enter or a Send button.");
  }

  function findPromptEditor(targetMode = "code") {
    if (normalizeTargetMode(targetMode) === "design") {
      return [...document.querySelectorAll('textarea[data-testid="chat-composer-input"], textarea[placeholder="Describe what you want to create..."]')]
        .filter(isVisible)
        .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
    }

    return [...document.querySelectorAll('div[aria-label="Prompt"][contenteditable="true"]')]
      .filter(isVisible)
      .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
  }

  async function waitForPromptEditor(targetMode, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const el = findPromptEditor(targetMode);
      if (el) return el;
      await sleep(150);
    }
    throw new Error("Timed out waiting for Claude prompt box.");
  }

  function findEnabledSendButton(editor) {
    const er = editor.getBoundingClientRect();
    return [...document.querySelectorAll('button[aria-label="Send"]')]
      .filter(button => isVisible(button) && !button.disabled)
      .map(button => {
        const r = button.getBoundingClientRect();
        const yDistance = Math.abs((r.top + r.bottom) / 2 - (er.top + er.bottom) / 2);
        return { button, score: yDistance + Math.max(0, er.left - r.right) };
      })
      .sort((a, b) => a.score - b.score)[0]?.button;
  }

  function parseResetText(text) {
    const now = Date.now();
    const relative = text.match(/Resets in\s+((\d+)\s*hr)?\s*((\d+)\s*min)?/i);
    if (relative) {
      const hours = Number(relative[2] || 0);
      const minutes = Number(relative[4] || 0);
      return now + ((hours * 60 + minutes) * 60_000);
    }

    const utc = text.match(/resets\s+(\d{1,2}):(\d{2})\s*(am|pm)?\s*\(UTC\)/i);
    if (utc) {
      let hour = Number(utc[1]);
      const minute = Number(utc[2]);
      const meridiem = utc[3]?.toLowerCase();
      if (meridiem === "pm" && hour < 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;
      const date = new Date();
      const reset = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute);
      return reset <= now ? reset + 24 * 60 * 60_000 : reset;
    }

    return null;
  }

  async function waitForSelector(selector, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const el = document.querySelector(selector);
      if (el && isVisible(el)) return el;
      await sleep(150);
    }
    throw new Error(`Timed out waiting for ${selector}`);
  }

  async function waitForText(pattern, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (pattern.test(document.body.innerText)) return;
      await sleep(200);
    }
    throw new Error("Timed out waiting for Claude usage text.");
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
  }

  function compactText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function isUsefulProjectText(text) {
    return Boolean(text) && text.length <= 100 && !isIgnoredProjectText(text);
  }

  function isIgnoredProjectText(text) {
    return /^(Claude|Claude Code|Research preview|New session|Sessions|Welcome|Needs input|Default|main|\+)$|Usage limit reached|Feature of the week|Describe a task|Accept edits|Sonnet|Low/i.test(text);
  }

  function isTargetPage(targetMode) {
    return normalizeTargetMode(targetMode) === "design"
      ? location.href.startsWith("https://claude.ai/design")
      : location.href.startsWith("https://claude.ai/code");
  }

  function normalizeTargetMode(targetMode) {
    return targetMode === "design" ? "design" : "code";
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
})();
