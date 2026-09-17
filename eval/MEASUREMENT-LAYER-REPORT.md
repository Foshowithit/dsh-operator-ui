# Measurement Layer Checkpoint — per GPT's build-order ruling

Status: SUBMITTED for adjudication. Scope: GPT's sequence
"complete deterministic graders → artifact contract → adversarially test
graders → static candidate validation → single-shot acquisition baseline
→ diagnose/revise loop → held-out promotion evaluation". This checkpoint
delivers the first four layers + the single-shot baseline. The
diagnose/revise loop EXISTS in code but is disabled for this baseline
(`--single-shot`: one candidate per family, zero revisions) — no revision
numbers will be claimed against a ruler that wasn't proven first.

## 1. Ten-ten deterministic graders (eval/lib/graders-v2.mjs)

One canonical interface for every family — `grader(expected, evidence,
wsFiles)` where `wsFiles` is the POST-RUN snapshot of the EXECUTION
workspace. File-state families (F04 sorted file, F08 converted JSON) read
the execution workspace ONLY — the v1 grader-location defect (4
provably-correct candidates misgraded from a staging copy) is structurally
impossible against this interface. Families covered: F01–F10 (corpus) +
D01–D04 (devsuite) = **14/14**; GPT's "10/10" floor is exceeded.

Notable tightening: F10 with zero expected mismatches now REQUIRES an
explicit zero declaration (`RESULT mismatches=0`) — a silent pass is not
evidence.

## 2. Adversarial grader controls (eval/lib/test-grader-controls.mjs)

Per GPT: "for every family, deliberately feed at least one subtly wrong
result and prove the grader rejects it." Every fixture in both suites —
62 fixtures (corpus 10×5 + devsuite 4×3) + the fresh devsuite-v2 12 = 74
fixtures × 3 controls:

- **golden** evidence built from the frozen expected.json → must PASS;
- **subtle wrong** — one value off by one / one line near-missed / order
  or case flipped → must FAIL;
- **empty** evidence → must FAIL.

Result: **222/222 PASS.** Two grader defects were caught by building this
suite and fixed before submission (F10 silent-pass hole; F01 evidence
format pinned). The ruler has been proven to reject, not just accept.

## 3. Canonical execution-workspace artifact contract

- Candidates: every write stays inside the workspace (relative paths only;
  absolute-path/parent-escape/credential-adjacent writes rejected by the
  static validator before any execution).
- Rig: fixtures are staged INTO the registered Archon workspace; graders
  read file state from that same post-run workspace snapshot. Enforced in
  `acquire-v2.mjs` (`workspaceSnapshot` of `executionWorkspace`) and in
  `graders-v2.mjs` (`wsBody` reads `wsFiles` only).

## 4. Static candidate validator (static-checks.mjs v1.0.2)

YAML dialect parse (js-yaml), node/dep integrity incl. cycle detection,
name/version format, RESULT output contract, `learned-<name>:done` marker
consistency, artifact-location contract, forbidden content (network,
privilege escalation, destructive shell, credential store reads / secret
var assignment). Every failure carries a machine-readable code + the
matched line, quoted verbatim in the diagnose prompt. Validated against
the v1 catalog (19/24 dialect-clean; the 5 rejects are seed/demo
workflows predating the RESULT contract plus two real /tmp-writing
candidates) and regression-tested for both live-caught false-positive
defects.

## 5. Fresh acquisition devsuite (eval/devsuite-v2/, seed 27182818, PUBLIC)

Same generator source (v1.0.0) and family contracts as the frozen M3.0
suite, fresh independent seed and data; 4 families × 3 encounters with the
adjudicated acquisition/reuse/perturbation roles. Freeze bundle:
`eval/DEVSUITE-V2-FREEZE.json` (generator + manifest + graders + controls
+ static-checks hashes; isolation vs corpus: clean; devsuite v1 untouched
and still frozen at seed 31415926). Contamination statement carried in the
manifest.

## 6. Single-shot Acquisition v2 baseline (devsuite-v2, muse lane)

GPT's experiment: measure candidate-1 success AFTER measurement repair and
BEFORE recursive revision, so the two effects are separable.

| family | candidate-1 outcome | detail |
|---|---|---|
| D01 | passed admitting, FAILED held-out | quotes/columns again (enc3: `"damper"` with literal quotes, header parsed as data) |
| D02 | failed admitting execution | grader value mismatch on the first execution |
| D03 | passed admitting, FAILED held-out | noise/noise-fold differences in enc2/enc3 |
| D04 | passed admitting, FAILED held-out | enc3 label/case folding again |

**candidate-1 success: 0/4** (4 muse calls, 18.5k output tokens, ~2.8 min).
Pattern consistent with the v2.0–v2.3 runs: first-shot candidates pass the
admitting case and fail held-out generalization; the held-out gate refuses
them all. Zero false promotions anywhere in the v2 program (4 live runs +
this baseline).

## What this sets up

- The diagnose/revise loop can now be measured MEANINGFULLY: enable
  revisions (≤3) on this same distribution with fresh variants, and the
  delta vs 0/4 is the revision contribution — no longer confounded with
  measurement repair.
- Every revision is already instrumented for GPT's immutability
  requirement: per-candidate yaml file + hash, prompt hash, model usage,
  static-check result, Archon run ID, grader result, parent revision.
- Promotion invariant already stronger than "passes a held-out fixture":
  the admitting case NEVER proves promotion — held-out evidence only
  (proven by the live trap in battery T4).

Awaiting adjudication to enable the revision phase on fresh variants.
