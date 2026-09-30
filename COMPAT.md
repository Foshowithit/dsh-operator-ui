# COMPAT.md — the RCOS-tested compatibility pin

**Who owns this file:** RCOS owns the tested compatibility pin at the distribution
level. This file defines the exact known-good DSH + plugin + Archon combination.
Upgrades move through verification before the known-good pin changes.

The plugin's `peerDependencies` range in `package.json` stays truthful (what the
plugin code imports against), but it is NOT the support claim — this file is.

## Known-good pin (DSH + peers verified 2026-09-15; plugin 0.11.0 against Archon 0.10.1 re-verified 2026-09-22)

| Component | Version | Source of truth |
|---|---|---|
| DSH (`@deepseek-ai/dsh`) | `0.1.0-rc.6` | `npx --yes @deepseek-ai/dsh@0.1.0-rc.6 web` |
| dsh-operator-ui (this repo) | `0.11.0` | `package.json` |
| `@deepseek-ai/dsh-tools` (peer, OPTIONAL) | `0.1.0-rc.8` | resolved from the DSH rc.6 install tree |
| `@deepseek-ai/cordis` (peer) | `4.0.2` | resolved from the DSH rc.6 install tree |
| Archon | v0.10.1 API shape + `env@1` transport admission | workflow YAML + `/api/workflows*` routes |
| Node | ≥ 22 (dev box: v24.15.0) | `engines` field; native WebSocket in `lib/browser.js` |

## The pin is a hard requirement, not a preference (resolved 2026-09-29)

`@deepseek-ai/dsh@0.1.0-rc.6` declares **floating caret ranges** on its Cordis
stack:

```text
@deepseek-ai/cordis                  ^4.0.1
@deepseek-ai/cordis-plugin-hmr       ^1.0.16
@deepseek-ai/cordis-plugin-timer     ^1.1.3
@deepseek-ai/cordis-plugin-loader    ^1.0.2
@deepseek-ai/cordis-plugin-include   ^1.0.6
```

So a fresh install resolves whatever is newest at install time. The rc.6
launcher still consumes the older Cordis contract, and the newer packages have
dropped it, so the host installs cleanly and then dies at boot.

### Measured A/B — 2026-09-29, Node 24.15.0, macOS arm64

| Component | Drifted (fresh install) | Locked (`host/`) |
|---|---|---|
| `@deepseek-ai/dsh` | `0.1.0-rc.6` | `0.1.0-rc.6` |
| `@deepseek-ai/cordis` | `4.0.4` | `4.0.2` |
| `@deepseek-ai/cordis-plugin-hmr` | `1.0.19` | `1.0.17` |
| `@deepseek-ai/cordis-plugin-timer` | `1.1.6` | `1.1.4` |
| `@deepseek-ai/cordis-plugin-loader` | `1.0.5` | `1.0.3` |
| `@deepseek-ai/cordis-plugin-include` | `1.0.9` | `1.0.7` |
| `@deepseek-ai/dsh-app-boot` | `0.1.0-rc.8` | `0.1.0-rc.8` |
| **boot** | **FAIL** — `rc=1` | **PASS** — HTTP 200 in 3.0 s |

The DSH version is identical on both sides. The Cordis peer stack is the only
variable, and it is exactly what the caret ranges let float.

### Where it breaks

`dsh-app-boot`'s `watchUserPatches()`:

```js
if (hmr === void 0) throw new Error(`${binName}: user patch-layer watching requires the Cordis HMR service`);
```

`cordis-plugin-hmr@1.0.17` still exposes the config surface the rc.6 launcher
consumes; `1.0.19` no longer does. Cordis `4.0.4` also changes the service-start
ordering `1.0.17` relied on. The launcher's contract and the newer packages'
contracts have diverged; only the pin holds them together.

### The executable form of this section

`host/package.json` pins the stack with npm `overrides`:

```sh
npm install --prefix host
node scripts/boot-smoke.mjs --with-plugin
```

`scripts/boot-smoke.mjs` spawns the real CLI in a disposable `HOME`/`DSH_HOME`,
waits for a real HTTP answer, and fails on the exact error above.
`.github/workflows/host-boot-smoke.yml` runs it on every pull request, so this
drift cannot return unnoticed. A version list that matches this table while the
host fails to boot is precisely the failure mode being guarded against, which
is why the gate observes a boot rather than comparing versions.

### Also required: pnpm ≥ 10

`dsh plugin` forwards to pnpm. Without pnpm on PATH, plugin installation cannot
run at all — `dsh: pnpm not found on PATH`. `corepack enable pnpm` suffices.

**The version matters, and pnpm 9 is below the floor.** `dsh` marks the profile
directory as a pnpm workspace root and then runs the plugin install there; pnpm
9 refuses that without an explicit `-w` and aborts with
`ERR_PNPM_ADDING_TO_ROOT`, so the plugin never lands in the profile. The host
still boots, which makes this failure easy to miss — it presents as a working
boot with a silently absent plugin. Measured 2026-09-30:

| pnpm | plugin install |
|---|---|
| 9.15.9 | **FAIL** — `ERR_PNPM_ADDING_TO_ROOT` |
| 10.34.6 | PASS |
| 11.28.2 | PASS |
| 12.8.1 | PASS |

The boot smoke therefore treats a failed plugin install as a failure even when
the host answers HTTP, and pins pnpm 10 so CI tests the floor the README states.

### Still open

The plugin installs into a disposable profile and the host boots. The complete
DeepSeek Desktop (`0.2.0-rc.1`) journey — request → Workflow Manager → Archon →
independently verified artifact — remains unproven. Do not widen Desktop
compatibility or edit an existing user's profile as a workaround.

## What OPTIONAL means here

`@deepseek-ai/dsh-tools` is an OPTIONAL peer: it backs only the four
`browser_*` agent tools (`browser_navigate`, `browser_snapshot`, `browser_click`,
`browser_type`). Verified by repo-wide grep — `defineTool` appears only in
`lib/index.js` (the four registrations) and the `package.json` peer block; zero
use in `lib/browser.js`, `lib/client.js`, `scripts/`, or `cordis.patch.yml`.

- **INSTALLED** — the package resolves from the plugin tree.
- **AVAILABLE** — the integration can initialize (import + register succeed).
- **VERIFIED** — the tools were actually exercised against a live browser.

AVAILABLE must never substitute for VERIFIED. When the peer is absent, the plugin
boots and serves every tab; the four agent tools stay unregistered and the
Browser tab says so honestly (`toolsAvailable:false` + `toolsError` on
`GET /plugins/operator-ui/browser/status`).

## Verified contract facts (re-check on every pin bump)

- Slot seats: `conversation.view` (list), `shell.overlay` (list, root scope).
- Sessions feed shape: `{ids, byId}` keyed by `id` — not `items`, not `sessionId`.
- ModuleLoader id === package name; client bundle cache-busted with `?rev=` at boot
  (editing `lib/client.js` requires a full server restart to reach browsers).
- `SchemaJson` rejects `required:false` — optional tool params OMIT `required`.
- Third-party plugins cannot add RPC methods — webServer routes + `fetch()` only.
- `git diff` pathspecs are CWD-relative; `status --porcelain` paths are
  repo-root-relative. Anchor diffs at `git rev-parse --show-toplevel`.

## Upgrade policy

1. A pin change is proposed (new DSH, new peer, new Archon shape).
2. The contract facts above are re-verified against the new version's source.
3. `node scripts/check.js` passes; clean-env boot evidence is re-captured.
4. Only then does this file's pin change. Until then the old pin stands.
