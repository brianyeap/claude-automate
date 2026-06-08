# Agent Instructions

When modifying this repository:

1. Summarize the work completed, including the files changed and the intent of the change.
2. Bump `"version"` in `manifest.json` whenever you change shippable source
   (`popup.*`, `background.js`, `contentScript.js`, `manifest.json`). The in-app
   update banner detects releases solely by comparing this version against GitHub,
   so an unbumped version ships as "no update".
3. Commit the completed modifications with a clear, descriptive commit message.
4. Push the commit to the active remote branch.

Before committing, review the working tree and stage only files that belong to the current task.

## Version-bump guard

A `pre-push` hook (in `hooks/`, wired via `git config core.hooksPath hooks`) blocks
pushes that change source without bumping `manifest.json`. After a fresh clone, run
`git config core.hooksPath hooks` once to enable it. Bypass a single push with
`git push --no-verify`.
