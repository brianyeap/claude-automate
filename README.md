# Claude Limit Runner

A local Chrome extension that reads Claude Code usage from the authenticated Claude page, schedules a prompt for either a manual time or the next session reset, then sends the prompt into Claude Code.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder:

   `/Users/brianNew/Documents/Codex/2026-06-08/can-you-see-my-browser-taht/claude-limit-runner`

## Notes

- The extension does not read cookies or session tokens.
- It pulls usage from `https://claude.ai/code#settings/usage` and caches the result for one minute.
- If Claude asks for a repo before sending, the extension uses the optional repo fallback field. If that is empty, it picks the first visible repo option.
- Keep Chrome running for the scheduled alarm to fire.
