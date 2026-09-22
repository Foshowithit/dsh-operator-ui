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
