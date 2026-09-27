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

- [ ] Review the combined diff and fix material defects.
- [ ] Run targeted tests and contract checks, commit one coherent slice, then run the frozen full gate bound to that commit.
- [ ] Record exact verification and limitations; do not label a synthetic test as a live WM dispatch.
- [ ] Keep the recurring execution prompt aligned to the next source-backed milestone.

Transport verification: `node --test test/wm-bridge.test.mjs`; explicit optional installed-runtime probe `node scripts/wm-runtime-smoke.mjs /absolute/runtime/node_modules`. No installed file is edited by that probe.

## Next milestones

1. Add explicit callId/runId/seatSessionId lifecycle correlation through a supported dispatcher event seam; verify with a real isolated WM dispatch.
2. Consume live workers and existing Archon graph/detail through authorized, source-backed bindings.
3. Generalize working inspector primitives to browser, files/diff/tests, terminal and evaluator evidence.
4. Integrate typed execution objects into Creative Canvas's closed PanelDoc vocabulary; verify focus, approvals, snapshots and fault states.
5. Repeat real visual interaction review across loading, failure, mobile and completed-history states before any release claim.
