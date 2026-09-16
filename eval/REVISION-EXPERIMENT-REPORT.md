# Revision Experiment Report — GPT's prescribed loop, executed literally

Status: SUBMITTED for adjudication. Machinery frozen for the duration per
the GO ruling: graders, static validator, family contracts, artifact
contract, promotion criteria unchanged (hashes in DEVSUITE-V3-FREEZE.json;
controls re-verified 222/222 before the run; battery 18/18).

## Setup

- Fresh independently generated variants: `eval/devsuite-v3`, public seed
  16180339, same generator source v1.0.0, isolation vs corpus clean.
- Loop: candidate₀ → static check → execute (real Archon, staged
  registered workspace) → grade (frozen graders) → diagnose → revision ≤3
  → independent held-out evaluation (encounter-2, encounter-3) →
  PROMOTE / REFUSE.
- No-leak rule enforced at the diagnose boundary: the revision channel
  receives static failure codes + the candidate's own matched line, Archon
  run status, node outputs, and produced artifact paths — and a
  grader-failure CATEGORY only (want/got values from grader details are
  redacted before they reach the model). Expected answers are never in the
  prompt.
- Provenance per attempt: yaml file + hash, parent hash, prompt hash,
  model usage, static result, Archon run ID, grader result.

## The comparison GPT asked for

| metric | value |
|---|---|
| single-shot baseline (devsuite-v2) | 0/4 |
| with ≤3 revisions (devsuite-v3) | **0/4** |
| revisions actually consumed | **0 of 12 possible** |
| false promotions | 0 |
| tokens / wall | 18,039 output tokens / ~2.3 min |

## Why the revise loop never engaged — the structural finding

All four families passed the admitting case on their FIRST candidate. The
prescribed chain places diagnose/revise on the admitting execute→grade
edge, with held-out evaluation as the independent terminal gate. So there
was nothing to diagnose: every candidate sailed through admitting and then
failed held-out, which is terminal REFUSE (held-out evidence may not feed
revision — it would contaminate the generalization measurement).

Per-family progression (generated → admitting → held-out #1 → held-out #2
→ terminal):

| family | admitting | held-out #1 | held-out #2 | terminal |
|---|---|---|---|---|
| D01 threshold-inventory | PASS (1st shot) | FAIL | FAIL | REFUSED |
| D02 config-diff | PASS (1st shot) | FAIL | PASS | REFUSED |
| D03 domain-tally | PASS (1st shot) | FAIL | PASS | REFUSED |
| D04 shift-handoff | PASS (1st shot) | PASS | FAIL | REFUSED |

Failure classes of the 4 refusals: **all generalization-class** — quoted
CSV fields / threshold-boundary handling (D01), single-file noise keys
(D02), subdomain/tally folding (D03), label case-folding (D04). Zero
admitting-case failures occurred, so zero revisions were legal under the
frozen policy.

## What this experiment establishes

1. The prescribed revision channel (admitting-driven repair) is
   **structurally unable to engage** on this distribution: the dominant
   failure class is generalization, and candidates that pass admitting
   first-shot never enter the revise loop. The 0/4 → 0/4 delta is real
   but degenerate — not because revision failed, but because revision was
   never reachable.
2. The held-out gate is doing exactly its job: it refused 4/4
   generalization-weak candidates, zero false promotions across the entire
   v2 program (5 live runs + this experiment).
3. First-shot admitting competence has improved with the no-leak diagnose
   prompt and the artifact contract (4/4 admitting passes here vs 3/4 in
   the single-shot baseline) — though n=4 and a stochastic lane, so this
   is anecdotal, not a claim.

## Requested ruling (design ambiguity, not a mid-run tune)

The experiment's blockquote asks whether RCOS can "use observed failure
evidence to autonomously revise a failed candidate into reusable
intelligence that passes independent held-out evaluation." Under the
literal chain, the only revisable failure is admitting failure — but the
dominant failure class fails at held-out, so the revisable case never
occurs. Two options:

- **(a) Keep the literal policy** — report that revision cannot engage the
  dominant class, and treat upfront generalization (better acquisition
  prompts/contracts) as the lever.
- **(b) Authorize held-out-failure-driven revision as a distinct,
  labeled experiment** — held-out failure evidence (category + the
  candidate's own outputs, never expected values) drives ≤3 revisions,
  with the FINAL candidate required to pass BOTH held-out cases in one
  clean terminal pass for promotion; earlier held-out failures stay in the
  provenance trail and are reported as non-independent. This weakens the
  independence of the first held-out case but tests the actual question.

Awaiting the ruling; nothing was tuned during the frozen experiment.
