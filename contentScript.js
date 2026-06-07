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
    if (message.type === "GET_PAGE_STATUS") return readPageStatus();
    if (message.type === "GET_USAGE") return readUsage();
    if (message.type === "TEST_PROMPT") return testPrompt(message.prompt);
    if (message.type === "RUN_PROMPT") return runPrompt(message.prompt);
    throw new Error(`Unknown content message: ${message.type}`);
  }

  function readPageStatus() {
    return {
      isClaudeCodePage: location.href.startsWith("https://claude.ai/code"),
      hasPromptEditor: Boolean(findPromptEditor()),
      projectName: findProjectName(),
      checkedAt: Date.now()
    };
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

  async function runPrompt(prompt) {
    if (!prompt?.trim()) throw new Error("No prompt was provided.");
    if (!location.href.startsWith("https://claude.ai/code")) {
      location.href = "https://claude.ai/code";
      await sleep(1800);
    }

    await waitForSelector('div[aria-label="Prompt"][contenteditable="true"]', 15_000);
    await ensureRepoSelected();

    const editor = findPromptEditor();
    if (!editor) throw new Error("Could not find Claude prompt box.");

    await setEditorText(editor, prompt.trim());
    await sleep(500);

    const send = findEnabledSendButton(editor);
    if (!send) throw new Error("Could not find enabled Send button.");
    send.click();
    return { ok: true, sentAt: Date.now() };
  }

  async function testPrompt(prompt) {
    if (!prompt?.trim()) throw new Error("No prompt was provided.");
    if (!location.href.startsWith("https://claude.ai/code")) {
      location.href = "https://claude.ai/code";
      await sleep(1800);
    }

    await waitForSelector('div[aria-label="Prompt"][contenteditable="true"]', 15_000);
    await ensureRepoSelected();

    const editor = findPromptEditor();
    if (!editor) throw new Error("Could not find Claude prompt box.");

    const expected = prompt.trim();
    const normalizedExpected = compactText(expected);
    await setEditorText(editor, expected);
    await sleep(300);
    if (!getEditorText(editor).includes(normalizedExpected.slice(0, 40))) {
      throw new Error("Prompt paste could not be verified.");
    }

    await clearEditorText(editor);
    await sleep(200);
    if (getEditorText(editor)) {
      throw new Error("Prompt pasted, but the prompt box could not be cleared.");
    }

    return { ok: true, testedAt: Date.now() };
  }

  async function ensureRepoSelected() {
    const selectRepoButton = [...document.querySelectorAll("button")]
      .find(button => isVisible(button) && /Select repo/i.test(button.textContent || ""));

    if (!selectRepoButton) return;

    selectRepoButton.click();
    await sleep(700);

    const search = document.querySelector('input[placeholder="Search repos…"], input[aria-label="Search repos…"]');
    const popup = search?.closest("[role='dialog'], [role='listbox']") || search?.parentElement?.parentElement?.parentElement;
    const candidate = [...(popup || document).querySelectorAll("button, [role='option'], [role='menuitem'], div")]
      .filter(isVisible)
      .find(el => /^[\w.-]+\/[\w.-]+$/.test((el.textContent || "").trim()));

    if (!candidate) throw new Error("Claude asked for a repo, but no repo option was found.");
    candidate.click();
    await sleep(1000);
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

  async function clearEditorText(editor) {
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("delete");
    editor.textContent = "";
    editor.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "deleteContentBackward"
    }));
  }

  function findPromptEditor() {
    return [...document.querySelectorAll('div[aria-label="Prompt"][contenteditable="true"]')]
      .filter(isVisible)
      .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
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

  function getEditorText(editor) {
    return compactText(editor.innerText || editor.textContent);
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

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
})();
