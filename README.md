# dsh-operator-ui

An operator panel for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) (DSH): a **Runs** tab in the existing web UI that shows every session at once — live status, background jobs, queue, and context pressure — with a detail pane for the selected run.

It is a side-loaded DSH plugin (a Cordis bundle patch), not a fork:

- **No upstream changes.** One package, installed into a profile; removing it restores stock DSH exactly.
- **No duplicate state.** Every rendered fact is authoritative Host state, read through the services the web profile already mounts (`ctx.sessions` list + projections + jobs). Nothing is polled from the renderer, nothing is inferred from chat text, and the plugin persists nothing.
- **Additive seat.** It registers into the `conversation.view` list beside Conversation and Trajectory. It never replaces shipped UI.

## What you see

- **Runs grid** — one row per session: status dot (running / needs-attention / done / idle / blank), title + preset + cwd, last update, context-pressure meter (warns ≥80%, critical ≥95%), session token total, and badges for live background jobs and pending inbox input. Needs-attention and running sessions sort to the top.
- **Detail pane** (click a row) — session facts, context and token usage, the session's live inbox (queued vs steering placements), running tool calls, background jobs, plus **Open** (jump to the conversation) and **Cancel turn**.

## Install

Requires DSH `0.1.0-rc.6` (the version this was built and verified against).

From a clone of this repository:

```sh
git clone https://github.com/Foshowithit/dsh-operator-ui.git
cd dsh-operator-ui
dsh plugin --profile web add "$PWD"
```

No manual `cordis.patch.yml` edit is needed — the plugin's bundle patch self-inserts its row (`- insert:` form). Restart (or live-reload) the web profile and open the UI. You get:

- a **Runs** tab beside Conversation / Trajectory,
- a **Git** tab (read-only workspace git status / diff / log),
- a **⌘K / Ctrl+K command palette** (jump to any session, new session, toggle sidebar, switch views),
- a **Browser** tab — a supervised on-screen browser the agent drives through `browser_navigate` / `browser_snapshot` / `browser_click` / `browser_type` tools while you watch every action live. One owned instance with a 10-minute idle auto-stop (never a headless sprawl). Requires Chrome/Chromium on the host (`DSH_OPERATOR_UI_CHROME` env to point at a specific binary).

## Uninstall / disable

```sh
dsh plugin --profile web remove dsh-operator-ui
```

Slot entries, the style tag, and the host-half service are all fiber-owned effects — removing the plugin reverts everything. Sessions and settings are untouched (the plugin never writes either).

## Compatibility notes

- Verified against DSH `0.1.0-rc.6` (Cordis 4.x, web profile). The client half targets the `conversation.view` slot contract as served by that version.
- Styling is scoped under `.opui-*` classes and keyed off DSH design tokens (`--dsw-*`) with fallbacks — it does not depend on build-specific CSS-module hashes.
- Unknown projection fields degrade to blanks, never crashes: the grid guards every field it reads.

## Layout

```
lib/index.js    host half  — intentionally passive today; later phases (workflow
                            bridges, resource summaries) grow here
lib/client.js   client half — Runs tab (grid + detail), ModuleLoader format
cordis.patch.yml bundle patch — one self-insert row
```

## License

MIT
