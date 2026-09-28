# Desktop compatibility contract and evidence

This note records what was checked for the desktop-facing contracts used by
`dsh-operator-ui`. It separates published source evidence and repository
consumer evidence from proof about a particular running Desktop installation.

## Scope and versions

The RCOS compatibility pin in [COMPAT.md](../COMPAT.md) is DSH
`@deepseek-ai/dsh@0.1.0-rc.6`, dsh-tools `0.1.0-rc.8`, and Cordis `4.0.2`.
That is the declared known-good host combination. `package.json` identifies
this source tree as plugin version `0.11.0`; COMPAT.md's `0.7.0` is the
historical plugin version attached to its 2026-09-15 verification. These values
describe different things and do not establish that plugin 0.11.0 was runtime
verified against the old host pin.

## Local installed Desktop capture (2026-09-28)

The following is one read-only capture of the installed
`/Applications/DeepSeek Harness.app`; it describes this local install and is not
a public compatibility certification or evidence that this plugin was run by
it. `Contents/Info.plist` identifies bundle `com.deepseek.dsh` and version
`0.1.7-rc.2`; `Contents/Resources/app-update.yml` labels its update channel
`nightly`; `Contents/Resources/runtime/versions.json` records Node `24.18.1`
and pnpm `11.7.0`. The captured `Contents/Resources/app.asar` SHA-256 is
`afb3958a1a10e1abb2f48083ffec0d270eddec668a393c59e20db4f56ade6fde`.

The metadata extracted from that archive identifies
`@deepseek-ai/dsh-desktop@0.1.7-rc.2`,
`@deepseek-ai/dsh-desktop-runtime@0.1.7-rc.2`,
`@deepseek-ai/dsh@0.1.7-rc.2`, `@deepseek-ai/dsh-tools@0.1.7-rc.2`,
Cordis `4.0.4`, and the `dsh-client-ui-{tool,conversation,layout,slots}`
packages at `0.1.7-rc.2`. This is the exact package
metadata observed in this app archive; it does not replace or update the
RCOS-owned version pin in COMPAT.md.

## Update feed observation (2026-09-28)

The installed app's `app-update.yml` points to the production macOS Apple
silicon feed
[`nightly-mac.yml`](https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml)
with channel `nightly`. A read-only fetch of that feed advertised Desktop
version `0.2.0-rc.1`, release date `2026-09-28T12:20:41.472Z`, and archive
`deepseek-harness-0.2.0-rc.1-mac-arm64.zip` (373,093,684 bytes; SHA-512
`P+z6DVyJCSc3hKBgpKYE6rzmV82Za7SeUnohPJb6vxDQk2dAd2LSRjXF255EvGUwC2Dd3cH3rURGHffyfI2UdA==`).
The upstream [Desktop release contract at tag `dsh-v0.2.0-rc.1`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.1/apps/desktop/README.md)
says Electron and `@deepseek-ai/dsh` always share the exact version; the
[matching upstream release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1)
is listed as a prerelease. Thus `0.2.0-rc.1` is the expected DSH runtime
version for this Desktop build. A read-only `HEAD` request to the feed's ZIP
URL returned HTTP 200 and a `Content-Length` matching the feed's 373,093,684
bytes. The archive still needs inspection to verify its exact package
inventory, including dsh-tools, Cordis, and UI packages, and to establish
plugin compatibility. The archive was not downloaded, so its published
SHA-512 has not been independently checked. The feed does not show that the
update was applied; the app was not opened or updated. Because this is a
mutable nightly feed, treat these values as a dated observation.

## A2 archive inspection (2026-09-28; active app untouched)

The advertised `deepseek-harness-0.2.0-rc.1-mac-arm64.zip` was fetched to
scratch (`bin/mac-arm64/` path from the live feed — the earlier guessed
`feeds/mac-arm64/` artifact path 404s and must not be used). Size
373,093,684 bytes matches the feed, and the computed SHA-512 matches the
feed value `P+z6DVy...GUwC2...` exactly, closing the unchecked-hash item
above. The zip was listed and its `app.asar` read with a local read-only
header parser; nothing was installed, booted, or written to any profile,
and the installed `/Applications/DeepSeek Harness.app` was only ever read.

Exact inventory inside the 0.2.0-rc.1 `app.asar` (13,011 files;
`app.asar` SHA-256 `cf92b07a...8ef53865`):

| Package / file | Version |
|---|---|
| asar-root package (`dsh/package.json` is `@deepseek-ai/dsh-desktop-runtime`) | `0.2.0-rc.1` |
| `@deepseek-ai/dsh` | `0.2.0-rc.1` (MIT) |
| `@deepseek-ai/dsh-tools` | `0.2.0-rc.1` (MIT) |
| `@deepseek-ai/cordis` | `4.0.4` (MIT, unchanged from 0.1.7-rc.2) |
| `runtime/versions.json` (outside asar) | Node `24.18.1`, pnpm `11.7.0` (unchanged) |
| `Contents/Info.plist` | `0.2.0-rc.1` |
| `app-update.yml` | channel `nightly`, feed `.../dsh-desk/feeds/mac-arm64/` |

Layout differences from the 0.1.7-rc.2 capture: no `dsh-desktop` or
`dsh-desktop-runtime` package under `dsh/node_modules`, no
`dsh-client-ui-*` packages, and no `react`/`react-dom`/`electron`
`package.json` files anywhere in the archive — client React is bundled,
not shipped as a separate package, so no standalone React version is
recoverable from this archive. The loader seams are present by string
evidence in the bundle (`__ModuleLoader__` x88, `tool.call.toolview`,
`tools/post-execute`), which confirms the mechanism names survived the
build, not that this plugin loaded, rendered, or received a dispatch.

Compatibility consequence: the plugin's `@deepseek-ai/dsh-tools` peer
range `^0.1.0-rc.8` against embedded `0.2.0-rc.1` keeps the earlier
`judgeTools` MISMATCH expectation; no pin was widened. Isolated
install/boot/remove with a disposable profile was NOT executed in this
pass — that, plus stock-surface survival and the exact resolution path,
remains the open A2 runtime item with the active app left untouched.

Relevant files inside `Contents/Resources/app.asar` and their SHA-256 hashes:

| Archive-relative source path | SHA-256 |
|---|---|
| `dsh/node_modules/@deepseek-ai/dsh-client-ui-tool/lib/client.js` | `9a7f3685a0da3d61ed8bf919ded47ece9561a589bdbf134088855f4ff4f9f44d` |
| `dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js` | `b24d167e9167006fdba87602c66bdcb0daeb853d2b21eb237a6ab623c878bc96` |
| `dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js` | `47028ec5c0d067c88a58f02e4a98b892d80d3dfee0dbae396ff765fbf61fa333` |
| `dsh/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js` | `57e1314e31a2015f30231e1e7596da658f1bb5cb64c103c4cf13381647412c99` |
| `dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js` | `6fa57df9f12225ea0644ed22bc149eadf7c21e5b0b43a8683c4081567b96374f` |
| `dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js` | `40f47709337c3c205d4e09e647f8588f4977e66f6d52f019b3cc7ef81159d84f` |
| `package.json` | `b7e5fdd2ca2c29acc8def0f49732a5abb58efd4a41624f6ae077a78675adef33` |
| `dsh/package.json` | `6d6d1198374a110c0be72765b9b9a1ea76c6b28ca901c2bf03aad6e34c847df7` |
| `dsh/node_modules/@deepseek-ai/dsh/package.json` | `84981905be639ad5cff01e44b8bfd63cf630cdb8b5835450f96a14f7ae521678` |
| `dsh/node_modules/@deepseek-ai/dsh-tools/package.json` | `ca77881311107cb64c21f25bd9c2c73ebe601606801c0df07c6dee160e898328` |
| `dsh/node_modules/@deepseek-ai/dsh-client-ui-tool/package.json` | `fc85c858ddc4d92810e72215056a56193a2c666b989b9addfbef63f0ac856718` |
| `dsh/node_modules/@deepseek-ai/dsh-client-ui-slots/package.json` | `b65d740f69b5172291f8ff13b0f312a61064e95c5db3856314684fc59ec17a2a` |

The hash above is the whole `app.asar` SHA-256 from this capture, not the
separate Electron integrity field in the app metadata.

The following older package archives were retrieved from the public npm
registry for read-only inspection. SHA-256 identifies each inspected tarball;
none is a repository dependency.

| Package | Version | SHA-256 |
|---|---|---|
| `@deepseek-ai/dsh` | `0.1.0-rc.6` | `1b8a9a0ad3c7feaece47926e0bd37ca151c7ccfa997953afa5fd01261784eadc` |
| `@deepseek-ai/dsh-client-runtime` | `0.1.0-rc.6` | `5be0aea454fbfe157fefc66784d105b1543177a8b05f2ffb1bf74f0e97617e2b` |
| `@deepseek-ai/dsh-client-ui-conversation` | `0.1.0-rc.6` | `52dae8382702c6417e351f8288cfb7908d66fcfcdc89341ae68d29994385cd16` |
| `@deepseek-ai/dsh-client-ui-layout` | `0.1.0-rc.6` | `e61a16f80513b76519401a316668465b76f099d62594c9014a01c584e833fcc4` |
| `@deepseek-ai/dsh-client-ui-slots` | `0.1.0-rc.6` | `a8f7179341a1280a0290cca86d0ba2b9a7b84020da3abc88557910c05caa418d` |
| `@deepseek-ai/dsh-web-app` | `0.1.0-rc.6` | `313b052f527a64c71fcad9c03c14026e45f2bcf72f5cdbd996e37f9ced86c40b` |
| `@deepseek-ai/dsh-tools` | `0.1.0-rc.8` | `79be78ae791e2e921efd8d172b3eaa66678d846a7ca2545a136f689def9e22f6` |

For the captured Desktop's `@deepseek-ai/dsh-tools@0.1.7-rc.2`, the published
tarball SHA-256 is
`1ed94fb52cc9106ec30f9a999e1262deef9cb514b9d745e968f1f6ec9c995f80`; the
`package/lib/types/index.d.ts` file SHA-256 is
`3536b173ec22361dcda85c05281921fc850db49984813b138d05395c4fe4510f`.
The package's JavaScript implementation is also present in the captured app
archive and listed above.

## Compatibility target and install boundary

The installed Desktop capture is still `0.1.7-rc.2`; its nightly feed now
advertises `0.2.0-rc.1` as the next A2 inspection target. The feed does not
identify the package inventory inside that archive. Upstream release source
sets the expected bundled DSH version to `0.2.0-rc.1`, but the source capture
below applies only to installed `0.1.7-rc.2` and cannot establish compatibility
for the new artifact. Neither Desktop target is **supported or certified yet**.
`COMPAT.md` still names the older web-host pin, and the current Operator source
is newer than the plugin version recorded by that historical verification.
The app's nightly channel does not define a public Desktop release channel.

The only install recipe established by the repository runbook is the isolated
web-profile command for the old RC.6 pin; it was not run during this source
audit:

```sh
DSH_HOME="$PWD/dev-home" npx --yes @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add "$PWD"
```

No Desktop-specific isolated install procedure has been confirmed here. A2
must establish it from the actual Desktop/CLI source before doing a disposable
profile install. Do not test against the active Desktop profile.

## Contracts supported by published source

- **`conversation.view`:** the RC.6 conversation slot declaration is a
  session-scoped `list` in
  `@deepseek-ai/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts`.
  The shipped conversation client renders the selected entry from that ring
  (`lib/client.js`, around line 7038). The plugin registers additive view
  entries through `ctx.slots.inject` in `lib/client.js`. The captured RC.2
  bundle independently declares `conversation.view` as a session-scoped `list`
  under `conversation.session` (`dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js`,
  around lines 18132-18137) and renders the selected entry around line 16338.
- **`shell.overlay`:** the RC.6 layout slot declaration is a root-scoped
  `list` in `@deepseek-ai/dsh-client-ui-layout/lib/types/client/index.d.ts`.
  The shipped frame renders it in that package's `lib/client.js` (around line
  237). The plugin uses the injected list seat for its palette and launcher.
  The captured RC.2 layout source declares it as a root-scoped `list` around
  lines 617-620 and renders it around line 312 in
  `dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js`.
- **`tool.call.toolview`:** RC.6 conversation source mentions the keyed
  per-tool view as the appropriate seat in
  `@deepseek-ai/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts`
  (around line 139), but the RC.6 published declarations inspected here do not
  declare that slot. The plugin currently registers `job_list` and
  `dispatch_seat` consumers in `lib/client.js` around lines 3627-3637, and
  repository tests exercise keyed matching and component disposal. This is
  repository consumer/test evidence, not confirmation that the RC.6 host
  exposes that keyed slot at runtime. The newer independently published
  `dsh-client-ui-conversation@0.0.1-rc.1` also does not define this key in its
  contract declaration; a changelog or Desktop runtime proof for this slot was
  not found in this inspection. Keep it explicitly unverified for the pinned
  host. By contrast, the captured `0.1.7-rc.2` bundle directly confirms this
  seam: `dsh/node_modules/@deepseek-ai/dsh-client-ui-tool/lib/client.js` renders
  `renderSlot("tool.call.toolview", owner, { entryKey: toolName, ... })` and
  the tool package declares the child slot as `kind: "keyed", scope:
  "session"` under the `conversation.chat.node` tool-call entry (around lines
  4315-4320). Shipped tool renderers register keyed names into that slot. The
  owner carries the exact `callId`, `toolName`, current call phase/block,
  `openFile`, `loadImage`, and `useDisclosure`; its optional `inspect` callback
  invokes the host's `inspectCall(callId)` (around lines 1827-1875). That host
  callback may open the declared view/focus target, so the plugin must preserve
  it and invoke it only from an explicit user action. This is source
  confirmation for the captured current bundle, not proof that the plugin's
  entries rendered in the running app.
- **ModuleLoader and client imports:** the RC.6 runtime browser bundle begins
  with `window.__ModuleLoader__.load(...)` at
  `@deepseek-ai/dsh-client-runtime/lib/client.js`; the conversation and layout
  bundles use the same entry form. The plugin's `lib/client.js` follows that
  shape, declares id `dsh-operator-ui`, and calls `require('react')` only. This
  establishes the bundle/import shape visible in published source, not that a
  Desktop's own loader accepted this exact plugin build. In the captured
  bundle, `dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js` also begins with
  `window.__ModuleLoader__.load(...)` and documents `load({id, factory})`; the
  conversation, layout, and tool client bundles use that same
  registration shape. This confirms the loader mechanism in the captured
  bundle, not successful loading of this plugin into that app.
- **Slot registration and teardown:** the client runtime's slot registry
  declaration in `@deepseek-ai/dsh-client-runtime/lib/types/client/slots.d.ts`
  describes `ctx.slots.inject` as a synchronous callback that returns a
  disposer (or iterable of disposers), with an idempotent disposer that cancels
  a pending wait/removes the active contribution. In this repository, the
  injected callbacks register their slot entries and the ModuleLoader factory
  returns its module through the host-facing bundle. This is source contract and
  repository test evidence; native callback execution inside Desktop is not
  proven here. The captured slot implementation is
  `dsh/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js`: `register`
  returns a disposer and releasing an entry clears its declared children and
  contributions (around lines 163-237 and 488-515). No plugin render was
  observed.
- **`tools/post-execute` identity:** the historical dsh-tools RC.8 source
  declares the waterfall as
  `tools/post-execute(exec: ToolExecution, result, next)` in
  `@deepseek-ai/dsh-tools/lib/types/index.d.ts` (around line 61), and
  `ToolExecutionInput` carries `callId` (around line 196). The repository
  listener in `lib/index.js` receives `exec` and `result`; `lib/wm-bridge.js`
  accepts only `dispatch_seat` with a nonempty `exec.callId` and echoes that
  canonical call ID in the bounded result envelope. For the captured Desktop,
  dsh-tools `0.1.7-rc.2` declares the same waterfall signature and
  `ToolExecutionInput.callId` in its published `lib/types/index.d.ts` (around
  lines 70 and 216-217). Its bundled implementation copies the execution
  callId into the pipeline object, then passes that object to the waterfall
  (`dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`, around lines
  3131-3150 and 3503-3505). The waterfall receives the normalized result after
  dispatch; source allows a listener to accept, replace, enrich, or block that
  result before final materialization. This is a settled tool-call result seam,
  not a live worker-progress feed. The Operator bridge consumes this seam and
  preserves DSH's result/policy path. This establishes the identity linkage by
  source and local tests; it does not establish delivery by a running Desktop
  or a live dispatch.
- **Session disposal:** the RC.6 slot registry source says slot contribution
  effects are owned by the caller's Cordis fiber and that plugin unload removes
  the active contribution. The plugin explicitly invokes returned slot
  disposers in its registration cleanup (`lib/client.js` around lines
  3749-3762). Repository tests assert deregistration on harness disposal.
  Published source and those tests do not prove that unloading the plugin from
  a specific Desktop session was exercised. The captured slot source in
  `dsh/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js` likewise
  implements registration disposal and scope teardown; the archive evidence
  establishes the mechanism, while runtime removal of this plugin was not
  tested.
- **Compatibility guard:** `detectDshVersion` searches the CLI entry ancestry,
  current directory and then a valid `DSH_VERSION`; failure remains unknown.
  `judgeDsh` returns `VERIFIED` only for the exact RC.6 pin, `UNVERIFIED` for a
  detected mismatch, and `UNKNOWN` when no version is available; it does not
  refuse plugin loading. The local Desktop's embedded `0.1.7-rc.2` is not the
  RC.6 pin. Separately, the plugin's current `@deepseek-ai/dsh-tools` peer
  range is `^0.1.0-rc.8`; under the existing prerelease comparator,
  `0.1.7-rc.2` does not satisfy it. If a Desktop install resolves the plugin
  against that embedded package, `judgeTools` reports `MISMATCH`. The exact
  resolution path has not been exercised, so neither package pin nor peer
  range is changed by this source audit.

## Compatibility matrix

| Target | Evidence | Status |
|---|---|---|
| Historical web tuple: DSH `0.1.0-rc.6`, dsh-tools `0.1.0-rc.8`, Cordis `4.0.2`, plugin `0.7.0` | `COMPAT.md` records verification on 2026-09-15; the current source package is plugin `0.11.0` | Previously verified tuple; current package still needs an isolated recheck |
| Installed Desktop capture: app/runtime `0.1.7-rc.2`, bundled DSH/dsh-tools `0.1.7-rc.2`, Cordis `4.0.4` | Local bundle source confirms the needed slots, ModuleLoader shape, callback, and call identity | Source-confirmed for this archived install only; no runtime plugin proof |
| Advertised Desktop/DSH update: `0.2.0-rc.1` | Production macOS nightly feed (re-fetched 2026-09-28, unchanged); archive downloaded to scratch with size + SHA-512 verified; package inventory above; loader seams present by string evidence | Archive source-confirmed; isolated install/boot/remove and plugin compatibility still unverified |
| Other Desktop/app or prerelease versions | No matching source capture or runtime result in this record | Unknown / unsupported by this evidence |

## Evidence boundary

The RC.6 claims above are source-confirmed for the named public npm packages;
the `0.1.7-rc.2` claims are source-confirmed for the single local app archive.
The latter confirms the keyed tool view declaration and render site for that
captured build. The `0.2.0-rc.1` version identity is supported by the
production update feed and upstream versioning contract, and its archive
hash and package inventory are now inspected per the A2 section above
(seams by string evidence only). Neither source set proves this
plugin rendered in the installed Desktop or that a live `tools/post-execute`
dispatch reached it. No plugin rendering, live dispatch, or app UI interaction
was performed. No profiles were changed, packages installed into profiles,
services started, or provider/runtime state altered for this review.
