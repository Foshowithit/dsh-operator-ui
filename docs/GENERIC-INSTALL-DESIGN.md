# Generic-Install Design — dsh-operator-ui as the RCOS operator surface

**Status: DESIGN ONLY — nothing in this document is built. No feature round has started.**
Date: 2026-09-14 · Follows v0.7.0 (Capabilities tab)

## 0. Purpose and acceptance test

dsh-operator-ui is intended to become the **general operator/control surface for RCOS** — not a UI
for any particular machine, agent, or private deployment.

**The acceptance test (eventual):**

> A competent stranger clones/installs RCOS on a fresh supported machine, opens this interface,
> configures what requires credentials or human choices, passes system verification, and executes
> one real routed task — without needing private knowledge from the developers.

Product shape: three lifecycle stages — **Setup → Operate → Admin**.

- **Setup** — environment detection, prerequisites, provider/model configuration, DSH/Archon/RCOS
  initialization, health checks, capability discovery/import, reproducible verification receipt.
- **Operate** — the active task is the center; the real chain is exposed:
  request → route → capability/workflow → execution → evidence → verification → SHIP/FIX/BLOCK.
- **Admin** — capabilities, workflows, routing policy, runtime/model bindings, workers, health,
  configuration, upgrades.

Standing principles (unchanged):

1. **DSH remains the harness.** Archon provides workflow/orchestration. The RCOS capability
   registry provides reusable accumulated capabilities. **The UI exposes and connects these
   systems; it never duplicates them.**
2. No feature-count growth. Setup is a lifecycle *state*, not "tab #10" (see §5.3).
3. Zero-dependency, read-only-by-default host half, honest degradation — all preserved.

---

## 1. Layer model — what the system IS

Four components, each with a public install path and its OWN configuration authority:

| Component | Role | Public install | Config authority (owner) | Port | Own verify command |
|---|---|---|---|---|---|
| DSH (`@deepseek-ai/dsh`) | Harness: sessions, plugins, web profile, providers | `npx @deepseek-ai/dsh@<pin> web` (npm, MIT, github.com/deepseek-ai/deepseek-harness) | `$DSH_HOME/settings.yaml` + `.env` + `.credentials.yaml` | 3080 (127.0.0.1-only by design) | `dsh --version` + web UI 200 |
| dsh-operator-ui (this repo) | Operator surface (plugin) | `git clone` + `dsh plugin --profile web add` | `$DSH_HOME/operator-ui.config.json` (NEW, §3.3) | — (rides DSH) | `node scripts/check.js` + `/status` route |
| Archon | Workflow orchestrator, runs, receipts | `curl -fsSL https://archon.diy/install \| bash` (v0.10.x binary; brew/docker also) | `~/.archon/config.yaml` + `~/.archon/.env` | 3090 | `archon version`, `archon doctor --full`, health JSON |
| RCOS registry | Capability ledger + promotion gate | `git clone https://github.com/Foshowithit/rcos` | repo `.env` + one registry JSON file (path is machine-local) | none (no daemon) | `python3 benchmarks/schema_check.py` |

**The UI is the connective read/write surface over these four authorities — never a fifth store.**
When Setup "configures providers," it writes DSH's `settings.yaml` (with backup, exactly as
documented hand-editing does today), not a parallel provider DB. When Setup checks Archon, it
calls Archon's health endpoint, not a reimplementation.

---

## 2. Architecture gap analysis

Findings classified P0 (blocks the acceptance test at install time) / P1 (blocks it at
configuration/verification time) / P2 (product shape, later stages). File:line references are to
this repo at v0.7.0 unless noted.

### 2.1 P0 — The plugin is not installable by a stranger today

1. **`@deepseek-ai/dsh-tools` does not resolve on a clean clone.** The host half imports it
   (`lib/index.js:16`); the documented install (`dsh plugin --profile web add "$PWD"`) creates a
   `link:` dependency that does NOT install peers, and the module load fails outright — proven by
   `dev-home/boot-v020.log`: `plugin tree failed to load … Cannot find package
   '@deepseek-ai/dsh-tools'`. It only works on the dev machine via an npx-cache symlink inside
   `node_modules/` (untracked). **This is the #1 generic-install breaker.**
2. **Version contract contradiction.** `package.json` peerDependencies declare
   `@deepseek-ai/dsh-tools ^0.1.0-rc.8` while everything is verified against DSH `0.1.0-rc.6`
   (README/AGENTS). npm `latest` is already 0.1.5-rc.1. A stranger following "install DSH, then
   this plugin" hits an unmet-peer warning at best and untested contract drift at worst.
3. **Node ≥ 22 is required but never declared.** The Browser tab uses Node's native WebSocket
   (`lib/browser.js:120`); Node 18/20 (common LTS) crash at first browser use. No `engines` field,
   no requirements line in README/DEPLOY.
4. **`scripts/check.js` requires a git clone** (`git ls-files`); a GitHub zip download fails the
   hygiene gate. Also checks nothing about node version, env defaults, or peer resolution.
5. **Registry fixture is untracked.** The only `capability-registry.json` example lives in
   gitignored `dev-home/`; DEPLOY.md points `DSH_OPERATOR_UI_REGISTRY` at a placeholder private
   checkout layout. A stranger gets a dead Capabilities tab and no example file.
6. **Mock Archon defaults to port 3090** — collides with the real Archon default (both documented).

### 2.2 P0 — No portable configuration contract

7. Three env vars (`DSH_OPERATOR_UI_ARCHON`, `_REGISTRY`, `_CHROME`), read **once at module
   load** (restart-coupled, only implied in docs), with no file-based config, no status exposure,
   and no auth support for Archon (the proxy sends bare fetches — any authenticated Archon shows
   as "not reachable").
8. **Client copy hardcodes the default** — the unreachable panel tells the operator to look at
   ":3090" even when `DSH_OPERATOR_UI_ARCHON` points elsewhere. The client cannot see host env
   at all; there is no status route.
9. Hardcoded knobs with no slots: git binary/timeouts/caps, files caps, browser idle/viewport
   (viewport is duplicated host/client and must be manually kept in sync —
   `lib/browser.js:25-26` vs `lib/client.js:810-811`), chrome discovery path list (no PATH
   search, no homebrew arm64 chromium), registry size cap, archon timeout.
10. **Platform assumptions undeclared**: absolute-path validation is POSIX-only
    (`lib/index.js:102` rejects non-`/`-prefixed cwd; `\` rejected in args), `pkill`/`pgrep`
    required. Windows breaks silently. Cheaper to DECLARE supported platforms (macOS + Linux,
    Node ≥22) than to fix Windows now.

### 2.3 P1 — Ecosystem wiring: the private-knowledge core

These gaps are not in this repo; they are why "clone + install RCOS" does not currently exist as
a concept. The UI's Setup stage cannot be honest until they have answers (§6).

11. **Provider wiring is private.** DSH provider rows (`settings.yaml`) + 14–19 `.env` slots +
    Archon's 27+ `~/.archon/.env` slots + alias/tier routing mesh (`config.yaml`) — the mapping
    "which env var feeds which provider row" exists only on the developers' machines. A stock
    `npx dsh web` boots with zero configured providers and no map to fix it.
12. **Version-pin policy is private.** Fleet runs 0.1.0-rc.6 deliberately ("the version
    everything was built against"); npm latest is 0.1.5-rc.1. "Which DSH version does RCOS
    support" has no public answer.
13. **Live registry schema ≠ public schema.** The public `rcos` repo defines a draft-07 schema
    (status/admitted_after/evals/reuse_count); the live production registry uses a different v1
    shape (family/inputs/artifact_path/eval_score/use_count/routing). The Capabilities tab
    currently renders the *public* schema — pointed at a real install it would show the wrong
    thing or nothing.
14. **The workflow library is not exportable.** 300+ workflow YAMLs + registry index live on one
    box, some with machine-absolute paths embedded. Fresh installs must treat an EMPTY catalog as
    valid (principle below), but "capability discovery/import" needs a seed/export story.
15. **No composite verification.** Each system has its own verify command (table §1) but nothing
    composes them into one pass/fail + receipt, and no canned no-credential task exists to prove
    the chain end-to-end.

### 2.4 P2 — Product/IA

16. Nine tabs are all Operate-stage surfaces; Setup and Admin stages do not exist. Growth by tab
    has hit its ceiling — the lifecycle model replaces it (Setup = pre-operate landing state;
    Admin = later consolidation of Workflows/Capabilities admin verbs).
17. The routing chain (request → route → … → SHIP/FIX/BLOCK) is only partially visible today
    (Workflows tab shows runs + receipt decisions; Runs shows DSH sessions). No unified task
    object yet — deliberately deferred to the Operate-stage round.

### 2.5 What the repo already does right (keep, don't rebuild)

- Honest degradation everywhere (unreachable panels, config-error strings, never fake data).
- All external points already env-overridable; defaults documented.
- Zero runtime dependencies; read-only fixed-argv host routes with timeouts and caps.
- Self-inserting bundle patch; clean one-command remove; dev/prod isolation (`dev-home/`
  gitignored, hygiene-gated).
- Portable git plumbing (repo-root anchoring, no remote assumptions).

---

## 3. Portable configuration & installation contract

### 3.1 Supported machine (declare, don't guess)

- **Supported:** macOS (arm64/x64) and Linux (x64/arm64); Node.js **≥ 22**; git ≥ 2.30;
  bash; python3 ≥ 3.10 (RCOS checkers). Chrome/Chromium optional (Browser tab; PATH search +
  env override). Claude Code/gh optional (Archon assistants; not needed to serve workflows).
- **Unsupported (stated):** Windows (POSIX path validation + pkill/pgrep), Node < 22.
- Enforced by: `package.json` `engines` field, README requirements section, `check.js` node
  check, and the Setup preflight report.

### 3.2 The four config authorities

Each system owns exactly its own files; the plugin never forks state:

| Authority | File | Who writes it |
|---|---|---|
| Harness + providers + presets | `$DSH_HOME/settings.yaml`, `.env`, `.credentials.yaml` | DSH docs pattern; Setup writes WITH backup, same semantics as documented hand-editing |
| Plugin + ecosystem endpoints | `$DSH_HOME/operator-ui.config.json` (NEW) | Setup / operator |
| Archon routing + tiers | `~/.archon/config.yaml`, `~/.archon/.env` | `archon` CLI; Setup only reads/links |
| Capability ledger | machine-local registry JSON (path in plugin config) + rcos repo `.env` | RCOS promotion tooling; Setup only discovers/validates |

### 3.3 `operator-ui.config.json` v1

One file, additive-only evolution, JSON (native parse — keeps zero-dep). Resolution order per
key: **explicit env var (back-compat, wins) → config file → default → runtime discovery**.
Env vars keep working unchanged; the file is the portable, self-documenting layer.

```jsonc
{
  "configVersion": 1,
  "archon":  { "baseUrl": "http://127.0.0.1:3090", "tokenVar": null, "timeoutMs": 5000 },
  "registry":{ "path": "~/.archon/rcos-v1/capability-registry.json",
               "schema": "rcos-public-v1", "maxBytes": 262144 },
  "browser": { "chromePath": null, "userDataDir": null, "idleMs": 600000,
               "viewport": [1280, 800] },
  "git":     { "bin": "git", "timeoutMs": 6000, "maxDiffBytes": 307200 },
  "files":   { "maxEntries": 2000, "maxReadBytes": 204800 }
}
```

Rules:
- `~` expansion; relative paths rejected (portability).
- `archon.tokenVar` names an ENV VAR holding a bearer token — **names, never values, in the
  config** (§3.5). If set, the proxy sends `Authorization: Bearer ${tokenVar}`.
- `browser.viewport` becomes the single source (client fetches it via status; kills the
  host/client duplication trap).
- **Status route**: `GET /plugins/operator-ui/status` returns the RESOLVED config (secrets
  redacted to slot names) + live reachability per component (archon health, registry
  present/schema-valid, git present, chrome found, node version). The client's unreachable
  panels read this instead of hardcoding ":3090". One route, host-side, reuses existing probe
  code.

### 3.4 Installation contract — `system-manifest.json` (tracked in this repo)

Setup is data-driven from one tracked manifest so the UI, README, and DEPLOY.md can never drift
apart (docs generate from it or are checked against it):

```jsonc
{
  "manifestVersion": 1,
  "components": {
    "dsh":    { "install": "npx --yes @deepseek-ai/dsh@${pin} web",
                "pin": "0.1.0-rc.6", "pinPolicy": "verified-pin (see COMPAT.md)",
                "configPaths": ["$DSH_HOME/settings.yaml"], "port": 3080,
                "health": "http GET 127.0.0.1:3080", "verify": ["dsh --version"] },
    "archon": { "install": "curl -fsSL https://archon.diy/install | bash",
                "configPaths": ["~/.archon/config.yaml"], "port": 3090,
                "health": "http GET :3090/health (status==ok)",
                "verify": ["archon version"] },
    "rcos":   { "install": "git clone https://github.com/Foshowithit/rcos",
                "configPaths": ["<rcos>/.env"], "port": null,
                "health": null,
                "verify": ["python3 benchmarks/schema_check.py"] },
    "operator-ui": { "install": "dsh plugin --profile web add <this-repo>",
                "configPaths": ["$DSH_HOME/operator-ui.config.json"],
                "verify": ["node scripts/check.js"] }
  }
}
```

`COMPAT.md` (tracked) owns the version matrix: DSH pin ↔ verified dsh-tools/cordis peers ↔
known contract facts (slots shape, feed `{ids,byId}`, ModuleLoader `?rev=`), re-verified on pin
bumps.

### 3.5 Credential contract

- The plugin **never sees, stores, or proxies secret values.** Config carries slot NAMES only.
- Presence checks only: "env var X set in `$DSH_HOME/.env`? y/n" — rendered in Setup as a
  checklist, values never echoed.
- Writes go to the OWNING system's store (`.env` append with backup, or instruct `archon ai key
  set <provider>`), through the same file-layer semantics DSH/Archon already document.
- `scripts/check.js` gains a lint: no secret-looking literals in tracked files (extends the
  existing hygiene gate).

### 3.6 Verification receipt contract

`receipt.json` — the artifact that gates Setup → Operate. Reproducible (same machine + same
steps ⇒ same fields), hash-sealed:

```jsonc
{
  "receiptVersion": 1,
  "createdAt": "<iso8601>",
  "machine": { "platform": "darwin", "arch": "arm64", "node": "24.15.0", "runtimeUser": "<name>" },
  "components": {
    "dsh":    { "version": "0.1.0-rc.6", "port": 3080, "health": "ok" },
    "archon": { "version": "0.10.1", "port": 3090, "health": "ok", "workflows": 0 },
    "rcos":   { "registrySchema": "rcos-public-v1", "capabilities": 0 },
    "operator-ui": { "version": "<pkg>", "configHash": "sha256:…" }
  },
  "checks": [ { "id": "node>=22", "pass": true }, { "id": "archon-health", "pass": true }, … ],
  "probeTask": { "kind": "seeded-echo-workflow", "runId": "<archon run id>",
                 "verdict": "ship", "routing": "direct-to-archon" },
  "verdict": "SYSTEM-VERIFIED"   // only when every check passes AND probeTask.verdict == ship
}
```

`probeTask.routing` records honestly how the task was routed **today** ("direct-to-archon");
the acceptance test tightens it to a real router-mediated dispatch in the Operate round — the
receipt schema is already shaped for that.

---

## 4. Bootstrap sequence (Setup stage design)

Fresh-machine flow, in order. v1 automation level is deliberately **Guided, not auto-installing**:
the UI runs detection/checks/receipts (read-only host half stays read-only; installs stay in
runbooks) — automation of installs is a later, separately-reviewed step (trust boundary: no
remote-code-execution-by-checklist).

| # | Step | What happens | v1 level |
|---|---|---|---|
| 0 | **Preflight / detect** | OS/arch, node, git, python3, bash, chrome, port availability (3080/3090), existing `$DSH_HOME`/`~/.archon` detected (fresh vs adopt) | Automated (status route) |
| 1 | **Prerequisites** | Missing items surfaced with exact install commands from `system-manifest.json` | Guided (copy-paste) |
| 2 | **Install components** | DSH at the manifest pin; Archon via official installer; RCOS clone; this plugin via `dsh plugin add` | Guided (runbook per OS) |
| 3 | **Configure** — *the only human-decision step* | (a) credentials: slot checklist per provider row (presence only); (b) model bindings: which provider/model per role/tier; (c) registry path. Setup writes `operator-ui.config.json` + (with backup) DSH provider rows from a TRACKED template (`fixtures/providers.example.yaml`) | Guided forms → reviewed writes |
| 4 | **Initialize** | Start DSH web (127.0.0.1:3080), `archon serve` (:3090); seed `fixtures/verify-echo-v1.yaml` into `~/.archon/workflows/` (the receipt probe); registry initialized EMPTY if absent — **empty catalog is a valid state** | Guided |
| 5 | **Health checks** | Per-component probes (§1 table) composed into one report | Automated |
| 6 | **Capability discovery/import** | Registry path wired + schema-validated; workflow catalog listed (0 is valid); later: import/export bundles | Automated (read-only) |
| 7 | **Verify + receipt** | Run the seeded echo workflow end-to-end (dispatch → execution → receipt → verdict), capture everything, write `receipt.json` | Automated |

**Gate:** no valid receipt (absent, or stale: component versions/config hash changed) ⇒ the UI
lands in Setup state. Valid receipt ⇒ Operate. This replaces today's empty states — it is not a
new content tab.

---

## 5. Smallest implementation slice

Ordered so each slice is independently shippable, independently verifiable, and none is a
feature-count tab. Slices 0–2 are the whole proposal for the next build rounds; everything else
in this document is explicitly deferred.

### Slice 0 — "A stranger can install it" (packaging only, no UI)

1. Fix `dsh-tools` resolution: graceful-degrade the import (try/catch → browser agent tools
   disabled with honest panel) AND/OR a documented one-line install step; `check.js` gains a
   peer-resolution check so this class can't regress silently.
2. `package.json`: `engines: { node: ">=22" }`; peer range aligned to the verified matrix;
   `COMPAT.md` with the pin↔peers↔contract-facts table (RCOS-owned known-good pin).
3. Track `fixtures/capability-registry.example.json` (promote the dev-home mock, clearly
   marked seeded/example — never mistaken for production intelligence) +
   `fixtures/providers.example.yaml` (slots only, no secrets; REQUIRED/OPTIONAL/
   CONFIGURED/VERIFIED states); DEPLOY.md placeholder path replaced by the fixture.
4. Mock Archon default port → 13090 (no collision with real Archon).
5. README requirements section (supported platforms, Node ≥22, git, optional Chrome/python3).
   - *Acceptance:* fresh clone on a clean macOS/Linux box with Node ≥22 + DSH rc.6 → plugin
     loads, all 9 tabs render, zero private-knowledge steps; zip-download also passes check.js
     (or check.js says exactly why not).

### Slice 1 — Portable config contract + status route (foundation, minimal UI delta)

1. `operator-ui.config.json` v1 (§3.3) with env>file>default resolution; defaults unchanged.
2. `GET /plugins/operator-ui/status` (resolved config, redacted; reachability + versions).
3. Client: unreachable panels + Settings copy read status (kills hardcoded ":3090");
   viewport single-source.
4. `system-manifest.json` tracked (§3.4); DEPLOY.md env table generated/checked against it.
   - *Acceptance:* same box, set archon.baseUrl to a non-default host in the file (no env) →
     Workflows tab follows it; restart-free where feasible (config re-read per request, or
     documented restart semantics); status route shows redacted truth.

### Slice 2 — Setup state + verification receipt (the acceptance-test mover)

1. Setup landing state when no valid receipt: preflight report from status (step 0),
   guided checklist (steps 1–4) from `system-manifest.json`, credential-presence checklist
   (slot names only).
2. "Run system verification" → host route composes checks (read-only: versions, health,
   registry schema) + dispatches the seeded echo workflow → renders pass/fail per check →
   writes `receipt.json` (§3.6). Verdict banner: SYSTEM-VERIFIED / what failed / stale reason.
   The receipt proves components actually communicated and executed the verification
   path — never merely that the UI loaded (receipt gate, §6).
3. Seeded probe: `fixtures/verify-echo-v1.yaml` (pure-shell echo workflow, no credentials,
   deterministic receipt → verdict `ship`) + a second seed exercising the actual RCOS
   execution path (two-workflow minimum, §6 ruling 4) + mock-archon support for
   sandbox verification.
   - *Acceptance:* on the dev sandbox (mock archon), a wiped `$DSH_HOME` reaches
     SYSTEM-VERIFIED through the UI alone; receipt validates against a tracked schema; stale
     detection (bump a version → Setup re-lands) works.

### Explicitly deferred (needs its own rounds/decisions — do NOT build now)

- Provider credential ENTRY UI (paste flows; security design required — presence checks only in
  Slice 2).
- Operate-stage task chain (unified task object, router-mediated dispatch, evidence viewer) and
  the Admin stage (routing policy, workers, bindings, upgrades).
- Registry schema unification (public draft-07 vs live v1 — §6.3) beyond dual-tolerant parsing.
- Workflow library export/import bundles; Windows support; remote/browserless hosts.

---

## 6. Ecosystem decisions needed (not solvable in this repo)

Owner rulings recorded 2026-09-15 (Slice 0–2 authorization). The plugin adapts:

1. **DSH version ownership — RCOS owns the tested pin at the distribution level.**
   Do not pretend the plugin independently supports whatever DSH happens to be
   installed. The plugin's peer range stays truthful, but the RCOS system
   manifest defines the exact known-good DSH + plugin + Archon combination.
   Upgrades move through verification before the known-good pin changes.
   (`COMPAT.md` in this repo is the public answer: "verified pin", bumped only
   with a re-verification pass — AGENTS.md contract facts re-checked.)
2. **Portable provider/model-binding contract first — no private-machine wiring
   as the default.** Ship the smallest useful template needed to prove the
   architecture, with explicit slots and no secrets
   (`fixtures/providers.example.yaml`); provider-specific adapters/templates
   accumulate afterward. A fresh install distinguishes REQUIRED, OPTIONAL,
   CONFIGURED, and VERIFIED rather than assuming credentials exist.
3. **The public RCOS schema wins.** The production divergence is migration debt,
   not a second supported truth. The delta is documented (§2.3 item 13), a
   migration path is defined (live registry migrates or a declared adapter is
   added), and the generic system targets the public canonical contract. Two
   schemas are never silently supported forever.
4. **Tiny deterministic seed bundle — not the 300+ private workflow library.**
   Seed only enough to prove routing/execution/verification end-to-end: at
   minimum a zero-credential deterministic/system workflow PLUS one workflow
   that exercises the actual RCOS execution path. Seeded/example capabilities
   are clearly identified so they cannot be mistaken for accumulated production
   intelligence (see the `_fixture_note` in
   `fixtures/capability-registry.example.json`).

**Receipt gate:** SYSTEM-VERIFIED cannot merely mean the UI loaded. The receipt
must prove the relevant components actually communicated and executed the
verification path — versions, configuration authorities/paths (no secrets),
health results, execution/result identity, timestamps, and hashes/provenance
sufficient to reproduce what was tested (§3.6).

**God-config rule:** `operator-ui.config.json` contains operator-UI
integration/configuration and REFERENCES to authorities — not copied
DSH/Archon/RCOS state. Each subsystem keeps owning its own truth (§3.2–3.3).

---

## 7. Round summary (for review)

- **Gap analysis:** the plugin fails stranger-install on packaging (dsh-tools resolution, peer
  version contradiction, undeclared Node ≥22) and has no portable config contract; the
  ecosystem's private knowledge (provider wiring, pin policy, registry schema divergence,
  unexportable workflow library) blocks the Setup stage from being honest.
- **Bootstrap:** 8-step Guided sequence, receipt-gated Setup→Operate, empty-catalog-is-valid.
- **Contract:** four config authorities (no state forking), one plugin config file (env>file>
  default), one tracked system manifest, names-never-values credentials, hash-sealed receipt.
- **Smallest slice:** 0 = installable (packaging), 1 = configurable (config+status), 2 =
  verifiable (Setup state + receipt + seeded probe). No new content tabs.
