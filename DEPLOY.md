# Deploying dsh-operator-ui

This runbook installs the **DSH web plugin**. It does not install or configure
DeepSeek Desktop, Archon, an RCOS registry, a provider, or a working RCOS
execution environment. A successful plugin install proves only that the web
extension is installed; use the status and verification steps below to see
which execution prerequisites are actually available. Everything here is
reversible — the last section is the uninstall.

## Requirements

- DSH `0.1.0-rc.6` (the verified pin — see COMPAT.md for the full tested matrix)
  with the `web` profile in use.
- Node ≥ 22; macOS or Linux (Windows unsupported).
- For the Git/Files tabs: `git` on PATH (read-only usage only).
- For the Browser tab: Chrome/Chromium on the host. Override the binary with
  `DSH_OPERATOR_UI_CHROME=/path/to/chrome` if it's not in a default location.
  Without the `@deepseek-ai/dsh-tools` peer installed, the tab still serves
  human driving but agent driving is honestly disabled (see COMPAT.md).
- For the Workflows tab: an Archon API. Default `http://127.0.0.1:3090`;
  override with `DSH_OPERATOR_UI_ARCHON`. For sandbox checks, the mock runs on
  `:13090` (deliberately NOT the real default) — see below.
- For the Capabilities tab: a `capability-registry.json`. Point
  `DSH_OPERATOR_UI_REGISTRY` at `fixtures/capability-registry.example.json`
  for a first-run proof, or at your own registry path.

## Install

```sh
git clone https://github.com/Foshowithit/dsh-operator-ui.git
cd dsh-operator-ui
node scripts/check.js                 # must PASS before proceeding
dsh plugin --profile web add "$PWD"
```

The plugin self-inserts its bundle row; no manual `cordis.patch.yml` edit.

## Configure the host integration (optional for the UI; required for RCOS execution)

The plugin UI can boot with defaults, but the defaults do not configure a
working RCOS environment: the capability registry path is empty and the
agent-triggered `workflow_run` tool is disabled (`allowRun: false`). Configure
the host integration in one portable file: `operator-ui.config.json` in
`$DSH_HOME` (see `fixtures/operator-ui.config.example.json` — it is valid
as JSON, but still requires host configuration). Precedence per key: explicit
env var > config file > default; every
value's origin is reported on the status surface. `~` in paths means the
operator's home; relative paths are rejected. The file holds endpoint URLs,
paths, and caps — never secrets: `archon.tokenVar` names the ENV VAR holding a
bearer token (name only; the value stays in your environment). The full
contract (components, ports, status vocabulary) lives in
`system-manifest.json`; the env vars below are the same knobs in back-compat
form. Set the registry path to a registry you operate, configure a reachable
Archon and its required workflow/workspace, and explicitly enable workflow
dispatch only when that host is ready. The status route reports missing and
unavailable prerequisites; it does not provision them.

Query one authoritative surface to see what is configured, available, missing,
invalid, or not yet verified:

```sh
curl -s http://127.0.0.1:3080/plugins/operator-ui/status | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.stringify(JSON.parse(d).components,null,1)))'
```

Browser settings (`browser.*`) apply at plugin start; everything else
re-resolves per request.

If your `dsh` runs under systemd, add the env vars to the unit (or its
drop-in) and restart it once:

```ini
# ~/.config/systemd/user/dsh-web.service.d/30-operator-ui.conf
[Service]
Environment=DSH_OPERATOR_UI_ARCHON=http://127.0.0.1:3090
Environment=DSH_OPERATOR_UI_REGISTRY=/path/to/your/capability-registry.json
# First-run proof instead of a real registry:
# Environment=DSH_OPERATOR_UI_REGISTRY=<this-repo>/fixtures/capability-registry.example.json
# Environment=DSH_OPERATOR_UI_CHROME=/usr/bin/chromium
# Operator preset over the authority scope contract (PLAN_ONLY / ASK_BEFORE_ACTION / AUTO_WITHIN_POLICY / FULL_ACCESS):
# Environment=DSH_OPERATOR_UI_AUTHORITY_PRESET=ASK_BEFORE_ACTION
# Teach Mode (M2) — where RCOS may write LEARNED-workflow artifacts (empty = teaching reports NOT_CONFIGURED):
# Environment=DSH_OPERATOR_UI_TEACH_WORKFLOWS=/path/to/archon-home/workflows
# Environment=DSH_OPERATOR_UI_TEACH_WORKSPACE=/path/to/archon-registered-workspace
```

```sh
systemctl --user restart dsh-web
```

## Verify (seeded, zero-credential)

System verification turns "the pieces appear healthy" into a sealed receipt.
Two probes run in order:

- **Probe A — verify-machinery** (zero-credential, deterministic): exercises
  the local machinery itself — manifest load, seed hashing, config resolution,
  and an evaluator self-test.
- **Probe B — rcos-execution-path**: the real RCOS path. The verifier routes
  through YOUR configured capability registry (seeded capability
  `rcos-verify-echo` → its `workflow` binding — the name is read from the
  registry, never hardcoded), executes that workflow on YOUR configured Archon
  via its normal run API, polls the run to a terminal state, and evaluates the
  evidence against the seeded expectation.

Levels: `NOT_VERIFIED` → `SYSTEM_VERIFIED` (Probe A only — never stretched) →
`RCOS_VERIFIED` (A + B). The receipt is written to
`$DSH_HOME/operator-ui/receipt.json` on explicit `POST /verify` and sealed: a
modified body reads **TAMPERED**, a changed manifest/registry/config/seed
reads **STALE** with reasons — an old receipt never blesses a different
installation. Other RCOS operations persist task envelopes in
`$DSH_HOME/operator-ui/tasks.json`. Teach/acquisition can also write the
operator-configured workflow and evaluation-fixture paths shown above; the
plugin does not guess these paths.

Seed install (once, before Probe B can pass):

```sh
mkdir -p ~/.archon/workflows/                           # fresh installs lack the dir
cp fixtures/verify-echo-v1.yaml ~/.archon/workflows/    # teach Archon the seed
# your registry must contain the seeded capability `rcos-verify-echo`
# (fixtures/capability-registry.example.json already ships it)
```

Real-Archon prerequisite: a run needs a workspace to execute in. Register
one folder workspace with Archon (any empty directory you own — runs execute
there, in place, no git needed):

```sh
curl -X POST http://127.0.0.1:3090/api/codebases \
  -H 'content-type: application/json' \
  -d '{"path": "/absolute/path/to/empty/workspace", "name": "rcos-workspace"}'
```

(Repo checkouts with a git remote work too; a remote-less git repo is
refused by Archon's worktree isolation — use a plain folder.)

Run it:

```sh
curl -X POST http://127.0.0.1:3080/plugins/operator-ui/verify
curl -s "http://127.0.0.1:3080/plugins/operator-ui/verify?op=receipt" | head -40
```

Or click **Run verification** in the Summary tab's System verification cards —
they show what RCOS actually tested (probes, routed capability, run id, seal)
and the fresh VALID / STALE / TAMPERED verdict. Sandbox rehearsal without a
real Archon: `node scripts/mock-archon.mjs` (`:13090`) +
`DSH_OPERATOR_UI_ARCHON=http://127.0.0.1:13090` — the mock serves the same
run API, including dispatch of the seeded workflow.



1. Open the web UI → tabs read: Chat · Trajectory · Runs · Summary · Git ·
   Browser · Files · Workflows.
2. **Runs**: every session listed with status/context; blanks hidden unless
   you toggle the `blanks` chip.
3. **Git**: open a session in a git repo — branch, changes, and per-file
   diffs render.
4. **Browser**: type a URL → a live view appears within a few seconds; stop
   it with the button; it also self-stops after 10 idle minutes.
5. **Workflows**: with Archon reachable you see catalog + runs + decisions;
   with it down you see the honest "not reachable" panel (that's correct).
   Sandbox check without a real Archon: `node scripts/mock-archon.mjs`
   (listens on `:13090`) + `DSH_OPERATOR_UI_ARCHON=http://127.0.0.1:13090`.
6. `⌘K` / `Ctrl+K` opens the palette.

## Uninstall

```sh
dsh plugin --profile web remove dsh-operator-ui
systemctl --user restart dsh-web   # if applicable
```

DSH sessions, settings, and conversation history are untouched. Uninstalling
the plugin does not remove RCOS task records, verification receipts, teaching
files, registry changes, or exported/staged FlowRouter artifacts; review and
remove those separately if desired. The supervised browser process is torn
down with the plugin, while its host-owned browser profile remains under
`$DSH_HOME/operator-ui-browser`.

## Safety notes for shared hosts

- The plugin's host half runs read-only `git` (fixed argv), reads workspace
  files under the session's root, drives its own single supervised browser
  (dedicated profile, idle-reaped), and makes bounded Archon API reads. Some
  explicit operations also write or dispatch: `POST /verify` dispatches the
  seeded verification workflow; task/goal routes can dispatch workflows under
  their authority gates; acquisition and teaching can create candidate or
  evaluation files at the configured teaching paths; explicit promotion can
  update the configured registry. Explicit FlowRouter operations can also
  export or stage package files. These operations are not GET-only; check the
  selected operation and its paths before running it.
- It never writes to git or touches other processes' browsers. Durable task
  records live at `$DSH_HOME/operator-ui/tasks.json`; the sealed verification
  receipt lives at `$DSH_HOME/operator-ui/receipt.json`; the supervised
  browser uses `$DSH_HOME/operator-ui-browser`; teaching writes only to the
  operator-configured workflow and workspace paths. Review these host paths
  and the status surface before enabling operations on a shared host.
