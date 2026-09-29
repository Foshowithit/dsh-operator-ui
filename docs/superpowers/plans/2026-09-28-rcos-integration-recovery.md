# RCOS integration recovery — implementation plan

Implements the design at
`/Users/adam26/Documents/Codex/2026-09-28/im/outputs/rcos-integration-recovery-design.md`
(GPT session, Sept 28). Adam's takeover directive ("continue the gpt session
here", plus the pasted "get shit right" directive) counts as design approval;
the design's own rule stands: **no success claim until runtime acceptance
evidence exists.**

Baseline: reconcile commit `4315452`. Other agents' uncommitted documentation
is left untouched. One integrator owns shared entrypoints.

## Seam inventory (verified 2026-09-28 late, ZCode pass)

Facts re-confirmed independently after the GPT audit, before this plan:

1. **Preset seam.** `@deepseek-ai/dsh-agent-preset-registry` (0.2.0-rc.1
   source): definitions are ordinary plugin rows; the registry "neither scans
   directories nor accepts preset paths". A new preset is a bundle patch —
   an `insert` of a `@deepseek-ai/dsh-agent-preset` row — installed into the
   profile. Live proof already in the Desktop patch: `preset-standard`,
   `preset-ptc`, `preset-cordis` rows at `cordis.patch.yml:1230+`.
2. **Bundle load seam.** `~/.dsh/profiles/desktop/package.json` carries
   `dsh.profile.bundles: [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app]`
   and a `file:` dependency `dsh-operator-ui` that is NOT in the bundle list
   (installed ≠ loaded — GPT's finding, confirmed). `cordis.yml` documents
   composition order: bundles, then `cordis.patch.yml`, then `--patch`
   overlays.
3. **Plugin API symbols.** `defineTool` (dsh-tools), `createUserMessage`
   (dsh-llm), `SessionId` (dsh-session) all exist in the 0.2.0-rc.1 runtime
   extraction. seat-dispatch's peer range says `^0.1.0-rc.8` — signature-level
   diff still required (A1 first task), but no missing-symbol risk.
4. **Isolated testbed recipe.** Proven by A2 boot: asar copy + same-length
   `name` byte-patch (redirects userData + single-instance lock),
   `env -u ELECTRON_RUN_AS_NODE`, scratch `DSH_HOME`, port override via
   `cordis.patch.yml` `id: webserver` row. Raw logs `~/dsh-a2-boot/`.
5. **Governed-dispatch mechanism.** `dsh-seat-dispatch` (rc6) mounts the WM
   preset's standing composition onto a fresh-root child seat
   (`agentPresets.mount`), one envelope turn, receipt with
   `archon_run_id`/`archon_status`/`archon_artifact_dir`, JSONL audit at
   `~/.dsh/runs/seat-dispatch/seat-dispatch.jsonl`. Dead since Sep 26 (last
   entries receipt-missing / timeout / receipt-missing).
6. **A2 execution stack (Dell).** `chow@100.111.182.5:/home/chow/zcode-rcos`
   has `lib/{adapter,admission,eligibility,selection,invocation}.js`,
   `registry/`, `capabilities/`, `evidence/`. IR spec local:
   `~/rcos/ir-v0.1.md`. Dell remains the one canonical writer.

## A0 — isolated wiring reproduction (testbed)

Owner: integrator. No active-app writes.

Rebuild the isolated 0.2 runtime from the A2 recipe (fresh scratch dirs, new
port) and prove the two unproven seams at runtime:

- **A0-a preset row loads.** Insert a probe `@deepseek-ai/dsh-agent-preset`
  row into the scratch profile's `cordis.patch.yml`; prove it appears as a
  selectable preset for a NEW session (HTTP probe / session log preset id).
- **A0-b local bundle loads.** Install `dsh-seat-dispatch` into the scratch
  profile's node_modules and test BOTH load paths: (1) add to
  `dsh.profile.bundles`; (2) plugin row referencing the package name inside
  the probe preset. Whichever mounts `dispatch_seat` is the A1 path; record
  the other as rejected with evidence.
- **A0-c negative controls.** `.agent-presets` directories still ignored;
  probe preset absent from bundle ⇒ no composition change; `default:` change
  affects new sessions only, `selectedDefault` behavior recorded.
- **A0-d signature diff.** Diff `defineTool` / `createUserMessage` /
  `SessionId` / `agentPresets.mount` shapes rc6→0.2 from the extractions;
  list every seat-dispatch call site needing change.

Gate: boot logs + HTTP probes + session logs from the scratch DSH_HOME only;
active app's sessions/credentials/userData mtimes identical before/after.

## A1 — modern General/WM presets + dispatcher port

Owner: integrator. Files: new local package `dsh-seat-dispatch-2` (port; or
in-place new major of the rc6 package), Desktop profile `package.json` +
`cordis.patch.yml` (staged via scratch profile first), refusal tests in the
reconcile repo `test/`.

- **A1-a port.** Apply the A0-d diff. Keep receipt.js contract unchanged
  (it is the audit surface). Keep caller-preset/scope-chain eligibility
  checks — they read composition, not model claims.
- **A1-b General preset** (`general-idea` id, preserving the rc6 name so the
  dispatcher's callerPreset contract carries over): persona,
  agent-instructions, conversation, research/read tools (mount-verified
  list; audit host-wide tools too), clarification, `tool-ask-user`,
  `tool-todo`, `tool-web`, compaction (100k thresholds), and exactly one
  execution interface: `tool-seat-dispatch`. NO tool-bash / tool-pwsh /
  tool-fs write / delegation / subagent spawn / tool-goal / command-goal
  (lexical GoalComposer retired from General per design).
- **A1-c WM preset** (`workflow-manager`): execution admission tools,
  capability-decision recording, Archon adapter access, receipt submission
  (`code`-mode presentation preserved). NO `tool-seat-dispatch` (seats
  cannot dispatch seats).
- **A1-d boundary tests** (runtime, in the A0 testbed): direct
  shell/write/spawn attempts from General fail at composition level
  (UNKNOWN_TOOL, not prompt refusal); dispatch_seat from wrong preset
  refused; receipt schema violations refused without consuming the receipt;
  existing `standard` sessions keep their identity when the deployment
  default flips.

Gate: refusal + eligibility evidence from the isolated runtime; unit tests
green on the port; no default flip on the active profile yet.

## A2 — WM capability/IR/Archon path + one real request

Owner: integrator + Dell-side canonical writer. Files: Dell
`zcode-rcos` adapter boundary only where a contract is missing; reconcile
repo for the Desktop-side wiring.

- **A2-a contracts.** Read `~/rcos/ir-v0.1.md` + Dell `lib/adapter.js`,
  `lib/admission.js`, `lib/selection.js`; write the supported-contract notes
  before wiring. No invented workflow bindings in the canonical registry.
- **A2-b routing record.** Model-interprets-intent typed record
  (conversational / read-only inquiry / clarification / procedural handoff +
  reason + session/turn). Code validates eligibility and authority AFTER the
  model decision; no token matcher selects capabilities.
- **A2-c real request.** One ordinary-conversation procedural request in the
  testbed: brainstorm stays conversational (zero dispatch), procedural
  request → routing record → WM dispatch → find/reuse/compose/improve/build
  decision → capability revision → IR revision → Archon run → artifacts →
  independent evaluation. Missing capability ⇒ explicit blocked/build
  outcome, never silent substitution.
- **A2-d correlation.** One chain with distinct IDs: Desktop session/turn →
  routing decision → WM dispatch (jsonl) → capability/IR revision → Archon
  run id → artifact dir → evaluator verdict.

Gate: the full chain captured from a real run; failure paths (missing
capability, invalid identity, permission denied, backend down) each show
explicit refusal/recovery.

## B1/B2 — Canvas Alpha (independent of A2)

- **B1 host mount.** Free-form canvas inside DSH Desktop via additive
  extension points; objects: conversation/session, file/artifact, live
  preview, workflow/run, browser/terminal, evidence; pan/zoom/move/resize/
  group. C2's donor-wait is superseded by design B: an unusable donor is
  not a reason to abandon the feature; implement missing integration
  ourselves. Donor code may still be reused IF license + review pass.
- **B2 PanelDocs + shared mutation.** Agents create layouts through
  validated PanelDocs (agreed primitive vocabulary; no agent-supplied
  privileged UI). Same object IDs/revisions for human and agent edits;
  human wins conflicts (agent receives conflict result); layout changes
  never steal focus; approvals/verification labels stay in trusted chrome.
  Versioned storage contract separate from task authority; stale/
  unauthorized bindings cleared; restart restores layout.

Gate (design §Canvas): recorded real Desktop use, no canned run data;
stale-binding and conflicting-edit tests included.

## AB — bind + recovery in the installed Desktop

Bind the real governed visual/SWE request to Canvas; demonstrate quit→
relaunch workspace recovery in the INSTALLED Desktop. Release rules from
design §Release apply: exact profile backup, credentials/model routes
preserved, clean launch env (`env -u` pattern), staged rollback, session
preservation verified, 100k compaction + DeepSeek≥4.1 floor intact, local27B
and rc6 web stay dead. **Any restart of the active app is Adam-gated**
(unsent draft lives there).

## Queue supersession notes

- New critical path: A0 → A1 → A2 → AB, with B1 → B2 parallel after A1.
- C2 "mount BLOCKED on donor provenance" → superseded by B1 (build it
  ourselves); the pure resolver `lib/canvas-binding.js` remains reusable.
- D1/D2 BLOCKED rows stand: no structured media/patch contract exists yet;
  the A2 capability decision must refuse them honestly.
- P1 preview harness remains a debug view (design: fixed-pane inspector is
  debugging/briefing only), not on the critical path.
