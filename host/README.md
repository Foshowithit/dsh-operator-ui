# `host/` — the locked DeepSeek Harness host

This directory is **not the plugin**. The plugin is the repository root. This is
the *host the plugin runs inside*: a pinned, reproducible install of DeepSeek
Harness `0.1.0-rc.6`.

## Why it exists

`@deepseek-ai/dsh@0.1.0-rc.6` declares **floating caret ranges** on its Cordis
stack:

```text
@deepseek-ai/cordis                  ^4.0.1
@deepseek-ai/cordis-plugin-hmr       ^1.0.16
@deepseek-ai/cordis-plugin-timer     ^1.1.3
@deepseek-ai/cordis-plugin-loader    ^1.0.2
@deepseek-ai/cordis-plugin-include   ^1.0.6
```

A fresh install therefore resolves whatever is newest. The rc.6 launcher still
consumes the older Cordis contract; newer releases dropped it. The result is a
host that installs cleanly and then dies at boot:

```text
dsh: user patch-layer watching requires the Cordis HMR service
```

Measured 2026-09-29: a fresh install resolved Cordis `4.0.4` / HMR `1.0.19` and
failed; the pinned tree resolves Cordis `4.0.2` / HMR `1.0.17` and boots with
HTTP 200 in 3.0 s. The DSH version is identical on both sides — the Cordis peer
stack is the only variable.

## Use it

```sh
npm install --prefix host                         # from the repository root
export PATH="$PWD/host/node_modules/.bin:$PATH"   # `dsh` -> the locked host
dsh plugin --profile web add "$PWD"               # install the plugin (needs pnpm)
dsh web
```

`package.json` pins the stack with npm `overrides`, so the pin applies even on a
fresh install. The first run writes `package-lock.json` — commit it, and later
installs can use `npm ci --prefix host` to replay the tree exactly.

## Prove it

```sh
node scripts/boot-smoke.mjs                # locked host boot only
node scripts/boot-smoke.mjs --with-plugin  # also install + probe the plugin
```

Exit code 0 means a real spawned host answered a real HTTP request. The gate is
deliberately an end-to-end observation rather than a version comparison: a
version list that matches the pin while the host fails to boot is exactly the
failure mode this guards against. `.github/workflows/host-boot-smoke.yml` runs
it on every pull request.

## Prerequisites

- Node ≥ 22
- pnpm on PATH — `dsh plugin` forwards to pnpm (`corepack enable pnpm` suffices)

## Upgrade policy

Do not bump anything here casually. A pin change means: re-verify the contract
facts in [`../COMPAT.md`](../COMPAT.md) against the new version's source, get
`node scripts/boot-smoke.mjs --with-plugin` to PASS, and only then move the pin.
