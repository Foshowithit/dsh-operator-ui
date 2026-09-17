# Eval Protocol v2 — design for review (GPT directive)

Status: DESIGN SUBMITTED before any scored generation or execution, per the
ruling. Architecture frozen at `d8c543a`; no further acquisition
prompt/gate/revision changes.

## 1. Scientific question (verbatim, focused)

> Does frozen Acquisition v2 convert unfamiliar objectives into reusable
> capabilities that reduce cumulative resources on subsequent related
> objectives while maintaining objective correctness and avoiding false
> promotion?

## 2. What is frozen

- Acquisition v2 staged architecture (ADMIT → DIAGNOSTIC/LEARNING →
  REGRESSION → DUAL SACRED TERMINALS → PROMOTE/REFUSE), ≤3 global
  revisions, redacted diagnostic evidence, immutable per-attempt
  provenance — frozen at `d8c543a`.
- Executor equivalence receipt: frozen acquired workflows execute
  identically on local-dag-runner and real Archon v0.10.1 (all five axes
  agree: terminal, node order, grading-relevant outputs, workspace delta,
  grader result). `eval/records/executor-equivalence.json`.
- Known limitations frozen as observed (never fixed inside this program):
  cross-file status-set composition (D08 class) and reuse variation with
  column order + exclusions (D14 class).

## 3. Scored suite — generated only after the freeze

- **New families only**: none of D01–D16, none of F01–F10. A new generator
  (v4) with a fresh public seed produces the scored families AFTER the
  freeze commit; manifest + fixture hashes + grader hashes + control
  results frozen before any scored execution. Whatever happens next is the
  result.
- Shape: **12 families × 6 encounters = 72 scored objectives**, each with
  an independent expected-state grader (extending the canonical
  `grader(expected, evidence, wsFiles)` interface) and adversarial
  positive/subtle-wrong/empty controls, plus the fixture-consistency
  checker (expected recomputed from workspace) — all run pre-freeze.
- Encounter roles per family:
  - **E1 — acquisition**: the unfamiliar objective; a routing gap triggers
    the frozen staged acquisition. Promotion (internal dual sacred
    terminals both passing) makes the capability routable for later
    encounters.
  - **E2 — reuse**: ordinary variation (same contract, different data).
  - **E3 — reuse under variation**: format perturbation.
  - **E4–E5 — contested reuse**: mixed perturbation (noise, ordering,
    extra data) exercising the promoted capability's generalization.
  - **E6 — untouched generalization**: a fresh contract-valid variant
    never referenced by any learning evidence. Graded identically to every
    other encounter (all scored encounters are externally graded; none
    feeds back — the learning-fired flag makes the curve honest).

## 4. Metrics — acquisition economics + trust economics

Per objective: objective_satisfied (external grader, authoritative),
system verdict, four-state class (correct-success / false-BLOCK /
correct-refusal / **false-SHIP**), route, capability_reused (id+version),
acquisition_attempts, revisions, model calls / input+output tokens / wall,
cost per satisfied objective, human problem-solving interventions,
approval interventions.

Per family: the **encounter curve** — resources per satisfied objective by
encounter index, expected to amortize (E1 expensive → E6 cheap):

```
E1 acquisition (expensive) → E2 reuse → E3 reuse-variation → E4–E5 contested
→ E6 untouched generalization → cumulative resources / satisfied objective ↓
```

Program-level trust metrics (GPT additions, first-class):
- **False promotion**: a capability promoted after passing both sacred
  terminals that then FAILS any later scored encounter of its family.
  Every instance is enumerated with its provenance chain.
- **Terminal rejection of an otherwise learning-pass candidate**: episodes
  where E1–E3 all passed but a sacred terminal refused — counted and
  listed (the D07 class), as positive evidence the gate does work.
- False-SHIP / false-BLOCK rates against the external grader.

## 5. Procedure

1. Generate scored families (new generator v4, fresh seed) → freeze
   manifest/graders/controls/consistency BEFORE execution.
2. Run the frozen 72-objective interleaved stream on the RCOS lane
   (same lane configuration as the sealed v1 run; executor = real Archon
   v0.10.1, equivalence-proven against the shim). Budgets unchanged
   (≤3 revisions/episode; conjunctive ceilings).
3. Records: canonical record.mjs schema + the v2 additions above; every
   acquisition episode carries its full attempts trail and provenance.
4. Report: headline table, the encounter curve, per-family progression
   chains, false-promotion enumeration, terminal-rejection list, resource
   accounting. No mid-run changes; defects are recorded, not repaired
   (the v1 discipline that this program has kept throughout).

## 6. Requested ruling

Approve this protocol (shape 12×6, roles, metrics incl. false-promotion
and terminal-rejection accounting, new-families-only, freeze-before-run)?
On approval, generation and execution proceed without further design
input; the result is reported as-is.
