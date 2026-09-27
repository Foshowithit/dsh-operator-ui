# WM receipt inspector implementation plan

**Goal:** Expand a DSH seat dispatch into an honest execution/result card with receipt evidence and usable artifact actions.

**Architecture:** Use the native `tool.call.toolview` keyed slot and its live `block` prop. Project the exact structured tool result in the existing client module. No additional host route or renderer polling is necessary for this first slice.

**Transport ruling:** The installed dispatcher renders prose only, so its canonical value is not otherwise present in the UI block. `lib/wm-bridge.js` uses DSH's supported `tools/post-execute` waterfall to preserve that prose and append a bounded, versioned JSON content block with the canonical value and exact callId. It delegates downstream first and never overrides a block or content/value replacement. The original value and verdict stay unchanged; the extra content is model-visible for native calls. Existing history without this bridge stays explicitly unavailable. The real-runtime smoke uses the installed dispatcher schema/renderer with a synthetic body; it is not a live WM dispatch.

**Tech stack:** DSH rc.6 ModuleLoader, React, Node test runner, existing frozen gate.

**Spec:** `../specs/2026-09-26-wm-execution-inspector-design.md`, amended below.

## Authorized execution and rulings

The user approved execution with Luna subagents on 2026-09-26. Three Luna workers own disjoint files; the parent owns integration, documentation and git. No second team may write this worktree concurrently.

Source review uncovered two constraints in the proposal: the dispatcher disposes its seat before returning, and its child headers/audit do not carry caller callId. A same-parent child is therefore not safe to attach to an individual call. Missing result also does not prove running. Ruling: the first slice displays native call updates and the exact dispatch result; pending means awaiting result. Live worker/graph inspection is deferred until explicit correlation and authorized access exist. This costs narrower initial coverage and prevents incorrect execution claims.

The proposed host route would need session authorization beyond the existing authentication chokepoint. Ruling: consume only the tool block DSH already supplies to the authorized conversation. Do not introduce a route that exposes arbitrary sessions.

## Constraints

- Additive keyed slot `dispatch_seat`; preserve the stock workflow renderer.
- No new persistence, dependencies, polling, live installs, publishing or pushes.
- Parse only the exact JSON tool return, never chat prose or model summaries.
- Receipt verdict/evidence/artifacts remain seat-reported claims; no independent verification label.
- Unknown facts stay unknown; no fabricated progress or worker association.
- Artifact actions use DSH's supplied `openFile(path)`; inspection uses `inspect()`.

## Review focus

Malformed and contradictory receipt envelopes must not produce success. Pending or historical incomplete calls must not imply running. Other seats must not be labeled WM. Untrusted artifact/evidence strings must remain inert text. Slot registration and removal must preserve the native UI lifecycle.

## Task 1: Contract and receipt projection

Owner: Luna `wm_data`, test/wm-inspector.test.mjs; implementation owner Luna `wm_ui`, lib/client.js.

- [x] Load the actual ModuleLoader factory with a minimal React harness and test exported `projectWmToolBlock(block)`.
- [x] Exercise actual running/result block shapes with sanitized dispatcher envelopes: accepted ship/fix/blocked, timeout, receipt-missing, aborted, malformed and contradictory values, non-WM seat, absent Archon and disposed child.
- [x] Confirm red, then implement projection; scalar absence is null and collection absence is an empty array.
- [x] Run `node --test test/wm-inspector.test.mjs` and review the result.

## Task 2: Native expandable result card

Owner: Luna `wm_ui`, lib/client.js only.

- [x] Register WmDispatchRow under tool.call.toolview / dispatch_seat and dispose with the plugin effect.
- [x] Render compact seat/objective/state, then expanded reported result, artifacts, evidence, blockers, warnings and actual Archon identity.
- [x] Preserve secondary raw data and DSH inspection; use semantic disclosure controls and existing theme tokens.
- [x] Consume updated block props directly; no timers, alternate trackers or child guesses.
- [x] Check syntax and targeted behavioral tests.

## Task 3: Behavioral UI review

Owner: Luna `wm_review`, test/wm-ui.test.mjs only.

- [x] Exercise real slot registration/disposal and rendering with a minimal React harness.
- [x] Invoke artifact/inspection callbacks, assert literal values and receipt provenance labels, pending/malformed/non-WM behavior.
- [x] Review implementation for security, spec and API contract defects; parent assigns fixes to the file owner.

## Task 4: Integration and evidence

Owner: parent.

- [x] Review the combined diff and fix material defects.
- [x] Run targeted tests and contract checks, commit one coherent slice, then run the frozen full gate bound to that commit.
- [x] Record exact verification and limitations; do not label a synthetic test as a live WM dispatch.
- [x] Keep the recurring execution prompt aligned to the next source-backed milestone.

### Verified checkpoint

The implementation is commit `f6ad2a3b2fffc5f251085b0deca0cc5c17b1db00` on `rcos-dsh-reconcile`.

- Focused receipt, bridge and UI tests: 27/27 passed; `node scripts/check.js` passed.
- Installed-runtime probe passed through the real DSH ToolRuntime, dispatcher schema/renderer, bridge and client projector. Its receipt body is synthetic; this is not a live WM dispatch.
- Frozen-provenance gate: PASS on the exact implementation commit; 514/514 tests, contract check exit 0, source tree unchanged. Receipt: `/tmp/rcos-wm-inspector-gate.json`.
- Two independent deterministic packages matched; SHA-256 `87276ccc2916a61839c4f132e3c40eeece31f99c247688fb316a5053f0b72b63`.
- Independent review found no blocker. No live WM dispatch, install, publish, promotion or visual QA was performed. Worker/graph correlation and interactive visual review remain open.

The follow-up documentation commit records this evidence for the implementation commit above; it does not change the code measured by that gate.

### Follow-up source review and audit details

Read-only source review of DSH's `ToolRunContext` declaration and the RCOS vendored `dsh-seat-dispatch/lib/index.js` found a supported **post-result** join, but no live lifecycle join:

- DSH provides the tool execution's exact `callId`. The dispatcher receives that execution context, but does not copy `callId` into its dispatch state, child-session metadata, or append-only audit record. It disposes the child before returning its canonical result.
- The existing `tools/post-execute` bridge receives that same call ID and the canonical result. The UI can therefore bind the returned `dispatch.run_id` and `dispatch.seat_session_id` to the exact completed DSH card, without guessing from parent sessions or task IDs.
- Existing dispatcher records cannot support live worker updates or safely associate a global audit-log row with a DSH call. The card renders only the dispatcher's reported audit path and error as inert text; it does not open or independently read the audit file.

The follow-up UI commit is `4ddf74805303225e520c56ce36c548ad8a844b50`.

- Focused bridge, receipt-projection and UI tests: 30/30 passed, including mismatched call IDs and missing or whitespace-only run/session IDs.
- `node scripts/check.js`: PASS. The installed-runtime probe: PASS with a synthetic receipt only.
- Frozen-provenance gate: PASS on the exact commit above; 517/517 tests, contract leg exit 0, 46 named test entrypoints, unchanged read-only snapshot. Receipt: `/tmp/rcos-wm-inspector-audit-gate.json`.
- Deterministic package: PASS from that commit. Two independent packs matched at SHA-256 `d7d8aabd06bef686a8bbf8ce290b9795005ece55891f7467556e34a75e848d9c`.
- Independent review found no blocker. No live WM dispatch, install, or visual QA was performed.

The next live-correlation step requires an upstream dispatcher change to persist the caller call ID alongside its run and seat-session identities, plus an authorized read path for live updates. Until then, this plugin only presents settled call-bound receipts and must leave live worker state unknown.

Transport verification: `node --test test/wm-bridge.test.mjs`; explicit optional installed-runtime probe `node scripts/wm-runtime-smoke.mjs /absolute/runtime/node_modules`. No installed file is edited by that probe.

## Next milestones

1. Visually review the settled receipt card in an isolated DSH profile using synthetic data; cover compact, expanded, pending, missing-result and failure states. Do not run a live WM dispatch or install into an operator profile.
2. Keep worker/live-progress state unavailable until the upstream dispatcher persists caller `callId` with `run_id` and `seat_session_id` and exposes an explicitly authorized lifecycle read seam. Do not infer children from parent/task IDs or add an arbitrary-session route.
3. Generalize working inspector primitives to browser, files/diff/tests, terminal and evaluator evidence.
4. Integrate typed execution objects into Creative Canvas's closed PanelDoc vocabulary; verify focus, approvals, snapshots and fault states.
5. Repeat visual interaction review across loading, failure, mobile and completed-history states before any release claim.
