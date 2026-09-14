# AGENTS.md — for humans AND AI agents working on this repo

This is `dsh-operator-ui`: a side-loaded plugin for **DeepSeek Harness (DSH)** that adds a Runs grid, a ⌘K command palette, and a read-only Git tab to the existing DSH web UI. It is NOT a fork. Everything here rides DSH's public extension seams.

If you are an AI agent picking this up: this file contains the contract knowledge that is NOT in the DSH docs — hard-won from source-level verification against DSH `0.1.0-rc.6`. Read it fully before editing.

## Iron rules

1. **Additive slots only.** Never register into `single`-kind slots this plugin doesn't own (`sidebar`, `rightbar`, `sidebar.workspaces`, `details`) — that replaces shipped UI. Use `list`/`keyed` seats (`conversation.view`, `shell.overlay`, `tool.call.toolview`).
2. **No new persistence.** The plugin stores nothing. Every rendered fact comes from DSH's own services (sessions feed, projections, jobs) or the plugin's read-only host routes. Never poll from the renderer; never parse chat text to infer state.
3. **Host routes are read-only and fixed-argv.** Anything in `lib/index.js` that spawns a process must use an argv array (no shell), whitelist the subcommand, validate every user-controlled argument, and cap output/time. The Git route is the worked example.
4. **No secrets, ever.** Not in code, not in screenshots, not in the dev-home (which is gitignored anyway). Before any push: `node scripts/check.js` must pass and you must eyeball `git status`.
5. **Verify before pushing.** Minimum bar: `node scripts/check.js` passes AND the manual verification in CONTRIBUTING.md (install → features render → remove → clean revert with sessions intact).

## Dev environment (isolated — never point this at a user's real `~/.dsh`)

```sh
# one-time: create an isolated DSH home
mkdir -p dev-home
# install this plugin into the isolated profile
DSH_HOME="$PWD/dev-home" npx --yes @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add "$PWD"
# run the web UI (detached; plain background jobs get reaped by some harnesses)
nohup env DSH_HOME="$PWD/dev-home" npx --yes @deepseek-ai/dsh@0.1.0-rc.6 web --host 127.0.0.1 --port 8377 --no-open > dev-home/boot.log 2>&1 &
# → http://127.0.0.1:8377
```

- The plugin loads from a **link:** dependency (editable in place).
- **Editing `lib/client.js` requires a full server restart** to reach browsers: the boot graph cache-busts client modules with a `?rev=` computed at boot. Symptom of forgetting: your changes silently don't appear while the tab still works.
- Fixture data for screenshots/verification: `workspace.create {path}` → `session.create {workspaceId}` (a session created with `cwd` alone does NOT join the workspace sidebar group) → `session.prompt` to un-blank it (blank sessions are hidden in the sidebar tree).

## rc.6 contract cheat-sheet (verified in source; re-verify if you bump the DSH pin)

### Slots in use
| Slot | Kind | Used for |
|---|---|---|
| `conversation.view` | list | `runs` (order 20) and `git` (order 30) tabs beside Chat/Trajectory |
| `shell.overlay` | list, root scope | the ⌘K palette overlay |

Registration pattern (from the shipped trajectory plugin): `ctx.slots.inject(name, () => ctx.slots.register({name, id, order, label, inject}, Component))` inside `ctx.effect()`. The component receives standard kit props plus whatever `inject` returned (we pass `__opuiCtx: ctx`).

### Data access
- `ctx.sessions.list` — ObservableSnapshot of `{ids, byId, current, phase, jobsBySession}`. **Not `items`.** Rows (`SessionSummary`) are keyed `id`, not `sessionId`.
- `ctx.sessions.binding(id)?.session` — the `ISession` face: `prompt(content, 'queue'|'steer')`, `updateQueue(id, action)`, `cancel()`, `command(line)`, `loadOlder()`, plus the conversation snapshot observable (`queue`, `runningCalls`, `running`, …).
- Queue facts: `QueuedMessage {id, placement: 'queued'|'steering'|'context', preview, text}`; `QueueAction = {kind:'edit', content} | {kind:'remove'} | {kind:'steer'}`. **Only `placement==='queued'` rows accept mutations.**
- `ctx.workspaces.startSession(workspaceId?)`, `ctx.layout.toggleSidebar()` — palette verbs.
- Projections arrive inside list rows as `row.projectionValues.contextPressure {projectedTokens?, pressureTokens?, contextWindow?}` and `.tokenUsage`.

### Traps that cost us hours
- **React error #185 (infinite re-render) = silent slot-entry abdication.** `useSyncExternalStore`'s `getSnapshot` must return a *cached reference*; deriving a fresh object per call crashes the entry and DSH replaces it with an empty `data-slot-error` div — the tab still shows, no visible error. Debug by patching `console.error` in your module factory (it loads before React).
- **Third-party plugins cannot add RPC methods.** The client's response-schema table is compiled in. The escape hatch — which we use for Git — is a **webServer route** (`ctx.webServer.register({kind:'prefix', path, handler})`) + same-origin `fetch()`.
- **Git asymmetry:** `status --porcelain` paths are repo-ROOT-relative, but `diff` pathspecs are CWD-relative. Anchor diff at `git rev-parse --show-toplevel` and pass the root-relative path as-is. Use `diff HEAD` (covers staged; plain `git diff` shows nothing for staged-only changes).
- DSH **persists the selected view tab per session** across reloads — don't mistake a persisted tab for your command having worked when testing view switching.
- The in-app-browser automation backend cannot deliver real key events (`press`, `cua.keypress` no-op). Test keyboard flows via `dispatchEvent(new KeyboardEvent(...))`.

## Layout

```
lib/index.js      host half  — Cordis service; webServer routes (read-only). Currently: git.
lib/client.js     client half — ModuleLoader module; slot registrations, RunsTab/GitTab/Palette.
cordis.patch.yml  one self-insert row (top-level `- id:` rows REPLACE objects; only `- insert:` creates).
scripts/check.js  contract test — run before every push.
docs/             screenshots (must show only fixture content, never a real workspace).
dev-home/         isolated DSH home for dev. GITIGNORED. Never commit.
```
