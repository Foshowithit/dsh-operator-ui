# Desktop source audit: daily-use polish and capability path

Source audit at `b49559c` on `rcos-dsh-reconcile`, 2026-09-28. This is a
sequencing plan, not a runtime, visual, or compatibility claim. It reads
alongside [DESKTOP.md](../DESKTOP.md), the [roadmap](PUBLIC-DESKTOP-ROADMAP.md),
the [release plan](superpowers/plans/2026-09-28-public-desktop-release.md),
[Desktop compatibility evidence](DESKTOP-COMPATIBILITY.md), and the
[Canvas seam recon](CANVAS-DSH-SEAM-RECON.md).

## What the source already gives us

- `lib/client.js` has additive System/Work/Intelligence surfaces and legacy
  tabs. System reads shared `/verify?op=receipt` and `/status`; the gate is
  freshness-based. `lib/cli.js` provides read-only `doctor`, transactional
  `install`, and `verify`. `test/cli-doctor.test.mjs` and
  `test/cli-install.test.mjs` already cover prerequisites, idempotence,
  rollback and receipt recovery. The package tests include seed assets, but
  Desktop compatibility and isolated installation of the advertised
  `0.2.0-rc.1` target remain unproved; current local archive evidence is
  `0.1.7-rc.2` only.
- There are two catalog UIs. `CapabilitiesTab` shows canonical registry
  lifecycle and eval history. `IntelligenceSurface` adds current
  `deriveEligibility` reasons using status and Archon catalog. The pure
  `lib/capability-view.js` projection separates present/installed/verified/
  executable/eligible facts, but no client observation producer or UI consumer
  is wired yet (`docs/CAPABILITY-VIEW-EVIDENCE.md`). `GoalComposer` posts an
  objective to `/goal`; it does not expose explicit capability selection.
- `lib/execution-source.js` is a pure, tested, exact-context source store for
  `(workspaceId, sessionId, callId, toolName)` and scalar WM/job observations.
  It clears on selection changes and rejects delayed or mismatched observations.
  It is not imported by `lib/client.js` and has no live DSH observation
  producer.
- `WmDispatchRow` and `JobListInspector` are real client components registered
  under keyed tool views. They label WM output as seat-reported and job data as
  a call snapshot; artifact buttons use DSH's `openFile`, and `inspect` is
  invoked only from an explicit button. DSH's pinned `ToolDetails.tsx` describes
  `openFile` as opening a recorded file location in the session workspace, but
  `ToolCallOwnerProps` types it only as `(path: string, options?) => void` and
  `ToolCallTree.tsx` forwards that callback unchanged. This source contract does
  not prove that arbitrary receipt-provided paths are confined to that workspace;
  the current Operator passes the reported path unchanged. Keep such paths inert
  until the host implementation's containment behavior is proven. Their component harness is
  `test/wm-ui.test.mjs`; bridge contracts have focused tests. Current
  compatibility evidence confirms the keyed slot only in the archived RC.2
  source, not that this plugin rendered there.
- Work already has run detail, task spines and an `EvidenceDrawer`; Files has a
  host-backed file viewer. These are separate surfaces. No existing Canvas
  module/mount combines a selected task, inspector, artifact and evidence.
  The donor PanelDoc has twelve primitives, but its inspected files were
  untracked in the donor checkout; provenance/licensing and build import still
  precede use. `docs/CANVAS-DSH-SEAM-RECON.md` records that no shell caller
  currently wires `PanelRenderer`.
- The palette is keyboard-openable (`⌘K`/`Ctrl+K`) and focuses its input on
  open. Result inspectors expose accessible expand/collapse labels and bounded
  scroll regions. `SessionlessWork` uses a fixed 32% task-list column beside a
  detail column, and several cards use 300–320px minimum grid columns; narrow
  viewport behavior is not established by source tests.
- Recovery is split across CLI and DSH: the CLI has no `remove` command;
  `docs/VERIFICATION.md` and `CONTRIBUTING.md` use DSH's `plugin remove` and
  require existing sessions to survive. Existing CLI tests prove transaction
  rollback, not a full Desktop install/use/remove journey.

## Recommended sequence and exact proof

| Slice | Files and work | Meaningful tests / acceptance |
|---|---|---|
| Daily setup and health | A2 owns `lib/cli.js`, compatibility/package wiring, and setup docs. Keep `doctor` read-only; show missing prerequisites separately from an unverified version. Prove a disposable profile for the exact target before writing a Desktop recipe. | Extend `test/cli-doctor.test.mjs`, `test/cli-install.test.mjs`, `test/desktop-package.test.mjs` for fresh profile, partial prerequisite, install rollback, verify after restart, and removal with sessions intact. Then do a separate isolated Desktop acceptance; source tests cannot prove it. |
| Capabilities: discover then select | Finish B1a's source/terms boundary and the parallel directory inventory. Keep dshfind/awesome/dshmarket entries visibly third-party and link-out unless a stable, documented, licensed interface is proven. A DSH plugin listing is not an Operator capability. Consume `lib/capability-view.js` only after its observation producer is defined; use B2 to make a chosen canonical record an explicit, identity-bound selection into the existing admission path. No lexical fallback. | `test/capability-view.test.mjs` covers honest unknown/refusal states. Add B2 tests for no binding, missing dependency, stale registry version, selected-ID change, and no fallback to another capability; prove an explicit user choice reaches the existing approval/admission flow. Candidate research can continue while Canvas work proceeds. |
| Development fixture preview | Before a Canvas UI migration, add a development-only fixture page/harness that loads the actual client ModuleLoader factory and renders its registered components against synthetic status, capability, WM, job and artifact fixtures. The source resolver is now concrete: official `deepseek-ai/deepseek-harness` tag `dsh-v0.2.0-rc.1` (tag target `4878cdabd87d4041bdaff61d04c966883b9fd07a`) declares React/ReactDOM `^18.2.0` in `apps/web`, `apps/desktop`, and `packages/client/web`; its `pnpm-lock.yaml` resolves both to `18.3.1`. `packages/client/web/src/platform.ts` names `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client` as platform modules; `src/seed.ts` imports those actual packages into `getStaticModules()`, and `src/boot.ts` uses that table before `mountClient`. `apps/web/src/main.ts` starts `AppWebEntry`, while `apps/web/index.html` serves that entry at `#root`. First P1 step: parent adds React and ReactDOM 18.3.1 as preview-only development dependencies; the harness supplies those actual modules in `require('react')` and mounts captured slot components with `react-dom/client`, while all host services/fetch responses remain explicit fixtures. This enables browser screenshots without app navigation or dispatch. Do not present the fixture host as Desktop mount proof. | Add resolver tests asserting the four React module names map to the pinned 18.3.1 exports and unknown imports fail closed; then render pending, complete, failed, missing and long-text fixtures in a browser from actual client components. Prove no unmocked network calls, task dispatch, profile writes, focus theft or escape from the named fixture set. Reuse component contracts from `test/wm-ui.test.mjs` and `test/system-receipt-ui.test.mjs`; VM React stubs alone do not verify layout or keyboard behavior. Keep screenshot evidence labeled synthetic and separate from A2 host proof. |
| Minimal Canvas mount | C2 depends on A1+C1. Review/pin/attribute donor bytes, then add a minimal host adapter and mount only the selected call inspector in the existing DSH shell. Namespace DSH calls separately from Archon runs; feed C1 exact workspace/session/call identity and tear it down on selection/context change. Preserve `openFile`, `inspect`, native tabs, and host-owned approvals. | `test/canvas-host.test.mjs` plus `test/execution-source.test.mjs`: ID collision across sessions, mismatch, pending/missing/refused result, delayed result, unmount/context switch, and no auto-focus. Minimal success is one exact call rendered; live progress remains unsupported. |
| Inspector, artifact and evidence together | C3 depends on C2; compose existing WM/job inspectors and evidence view in one manually opened/closed panel. Keep reported receipt, call snapshot and independently verified evidence visibly distinct. Layout remains ephemeral. Enable artifact opening only after source inspection proves DSH's callback enforces the intended workspace/path scope; until then render the artifact path as inert text. | `test/canvas-interaction.test.mjs`: open/close, multiple evidence states, long/adversarial text stays inert and bounded, authorized artifact callback uses exact resolved path (or unproven paths remain noninteractive), keyboard close/selection, session change and disposal. |
| Daily-use accessibility and recovery | Update `lib/client.js` styles/components only after component composition is settled. Replace fixed 32% work split at narrow widths; retain scroll containers, reachable focus, Escape/close behavior and focus return. Update setup/removal docs after exact Desktop recipe is proven. | In fixture preview, inspect wide and narrow viewports, keyboard-only navigation, focus before/after open/close, loading/error/empty states and overflow. Then isolated install → use → restart → recover → DSH remove; assert stock DSH and prior sessions remain. |

## Cutline

For a daily-use internal build, first finish A2 for the actual Desktop version,
wire existing canonical readiness facts into one capability list, and support
one explicitly selected capability through approval and the existing execution
authority. In parallel, build the synthetic component preview and C2's minimal
call-bound inspector mount. Do not wait for a full community catalog or a
general-purpose canvas: third-party directory inventory can continue in
parallel, with link-out discovery until B1a identifies a permitted data seam.
The first practical loop should use one capability whose real workflow binding,
dependencies and evidence are proven in D1.

Public alpha is a later gate: A1/A2 exact-host proof, reviewed Canvas import and
visual/accessibility QA, a useful artifact capability plus bounded code pack,
complete rerun/recovery journey, publication/CI audit and two fresh-profile
testers following published instructions. Community-derived candidates need
their own source/license/provenance, contract, execution binding and negative
evals before they become selectable capabilities. Neither this audit, passing
unit tests, nor a synthetic preview establishes a working Desktop install or
visual acceptance.

## Evidence limits

Findings above are from repository code/tests/docs and the source captures
already recorded in `docs/DESKTOP-COMPATIBILITY.md` and
`docs/CANVAS-DSH-SEAM-RECON.md`. No app navigation, browser render, installation,
server, dispatch, provider operation or runtime/visual QA was performed for
this audit. Directory coverage and DSH-marketplace source/terms findings are
owned by the parallel survey and B1a audit; this document does not infer their
contents or permissions.
