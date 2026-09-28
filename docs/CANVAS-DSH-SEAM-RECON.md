# DSH Desktop / Canvas seam reconnaissance

Read-only source inspection, 2026-09-28. Operator baseline: `59fb3ce`
(implementation `6c8af01`). This records integration limits; it does not claim
a working Canvas bridge, desktop compatibility, visual QA, or live execution.

## Product direction

The user wants development centered on DSH Desktop, with an open canvas and
a capabilities library. The proposed consolidation target is the existing
Operator product repository. No repository migration or upstream fork has
occurred. Runtime truth remains with DSH, Archon, and the canonical registry.

## Sources inspected

Canvas donor: the existing Tauri desktop source checkout referenced by the
local desktop-harvest plan; paths below are relative to its source root.
Its HEAD was `ed552f78d94430d25b8ebd558ff79506b147c8b5`, but the files below
were **untracked** in a dirty working tree. That commit does not identify
their bytes. Do not copy the donor wholesale or describe it as a sealed release.

SHA-256 fingerprints of the inspected files (relative to donor root):

| File | SHA-256 |
| --- | --- |
| `packages/web/src/panels/schema.ts` | `0692fe84b4e1aad9357fe3ea32e580096da1db1c19e84aad6f8fab813a521333` |
| `packages/web/src/panels/binding.ts` | `3f9a88a75d8c53dd179c992b46589c60f7f38a5e49e375c34b69de68e6d6817f` |
| `packages/web/src/panels/registry.tsx` | `0e28587e3e2c67a85ebed1650bcbd90b07880373e9107bf3d7a32aedae712174` |
| `packages/web/src/canvas/PanelNode.tsx` | `3861fad0e029ba0459d3727b1b156f0aee8d89456fa4b1dfb999e2c56d992038` |

DSH contract inspected:
`<dsh-runtime>/node_modules/@deepseek-ai/dsh-client-ui-tool/lib/types/client/contract/slots.d.ts`.
This is the existing rc.6 source baseline, not a compatibility proof for the
active Desktop release.

## What exists

- DSH's session-scoped `tool.call.toolview` supplies `callId`, the frozen
  running/settled `block`, `openFile`, and optional `inspect`. A keyed entry
  replaces any existing owner of that key; it is not a shared renderer.
- Operator already projects WM results and `job_list` snapshots from those
  exact blocks. These are call-bound observations. A job snapshot has no
  corresponding workflow-run identity in its envelope.
- PanelDoc has twelve closed primitive kinds. `BindingSources` accepts
  scalar values in host-supplied `runs` and `artifacts` dictionaries.
  `resolveBinding` resolves `run:ID/streams/NAME` or `artifact:ID` without
  fetching. Missing entries return explicit unknown reasons.
- `PanelRenderer` accepts a supplied runtime; its default contains empty
  sources and a no-op verb emitter. This is a reusable rendering seam, not
  a DSH integration.
- `PanelNode` gets React content through `PanelContentContext`. The inspected
  `CanvasShell` supplies `workspace` content. A search of production web
  source found no caller wiring `PanelRenderer` into this shell; its other
  references were tests and recursive rendering.

## Missing contracts

1. **Identity and authorization:** the binding grammar accepts strings but
   does not establish ownership of a run. The host must provide only sources
   authorized for the current context. A DSH call ID must not be relabeled as
   an Archon run ID. WM's settled dispatcher identity does not establish a
   live worker stream; `job_list` must remain a call snapshot.
2. **Mount and lifetime:** the current Operator package does not import the
   donor's React/TypeScript Canvas modules. There is no existing DSH-to-Canvas
   provider, selected-call handoff, or source teardown on session changes.
3. **Authority presentation:** approvals and trusted verification belong to
   the host. Keep the closed vocabulary. Its restrictions on primitive kinds,
   action verbs, binding names and panel-node keys are not a provenance check
   for plain text values. The key check does not recursively inspect arbitrary
   nested payloads such as table row objects. Seat-reported verdicts must stay
   labeled as reported data.
4. **Evidence:** donor `panelDocHash` uses a non-cryptographic djb2 hash. It is
   a stable UI digest, not a tamper-resistant receipt or verification result.

## Next bounded slice

Before importing UI, define the host-owned execution source contract and
its DSH adapter in this repository: an explicit source namespace, exact
session/call selection, scalar projections, unavailable states, and teardown
when the selected context changes. Preserve native `openFile`/`inspect`
callbacks and keep approval controls outside agent-authored panels.

Acceptance must cover colliding IDs across contexts, mismatched calls,
missing results, downstream refusal, snapshot-vs-live labeling, session
switch/unmount, and absence of automatic focus changes. A grammar-valid
reference alone must never authorize a source read. Pin and review donor
bytes and licensing before migration; verify the target Desktop contract
before claiming compatibility.

No runtime files changed during this reconnaissance. No donor edits,
installs, dispatches, servers, package publication, or heavy jobs were run.
