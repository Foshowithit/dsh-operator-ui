# Capability Acquisition v2 — build + first live measurements

Status: SUBMITTED for adjudication (M3.1). Scope: the acquisition loop GPT
prescribed — MODEL → candidate → static checks → execute → inspect failure
evidence → diagnose → revise → re-execute → independent evaluation →
promote, with bounded budget and per-revision provenance.

## What was built

| module | role |
|---|---|
| `eval/lib/static-checks.mjs` v1.0.1 | pre-execution rejection: YAML dialect, node/dep integrity incl. cycle detection, output contract (RESULT lines + `learned-<name>:done` marker), artifact-location contract (no absolute/parent writes), forbidden content (network, privilege, destructive, credential store reads / secret-var assignment). Every failure carries a machine-readable code + the matched line, quoted verbatim in the revise prompt. |
| `eval/lib/acquire-v2.mjs` | the bounded loop. Conjunctive hard ceilings (M3-SPEC §2.2): attempts ≥ 4 OR output_tokens ≥ 50,000 OR wall ≥ 10 min → `REFUSED/BUDGET_EXHAUSTED`. Byte-identical revision → `REFUSED/REVISION_LOOP`. Held-out gate: the surviving candidate re-executes on the frozen held-out fixtures before CANDIDATE_READY; any failure → `REFUSED/HELD_OUT_FAILED` (zero false promotions by construction). Pluggable `think` backend (muse responses API or headless DSH session — same interface). Every candidate is persisted (yaml + hash + failure trail) so every refusal is replayable. |
| `eval/lib/run-acq-v2-battery.mjs` | negative-test battery, stub model (zero model spend), real Archon execution. |
| `eval/lib/run-acq-v2-live.mjs` | live run on the frozen devsuite (D01–D04), muse lane metered as teaching cost, records via `record.mjs`, promotion as recorded operator action into the run's registry copy. |

## Two rig discoveries (recorded because they changed what the rig measures)

1. **Archon exposes the run message to nodes as `$USER_MESSAGE`.** This is
   the generalization mechanism the suite demands: thresholds, file names,
   and column orders vary across a family's encounters, so a reusable
   capability must read the objective at run time. The acquisition prompt
   now says so; candidates that hardcode encounter-specific values are
   caught by the held-out gate (proven live, below). The v1 loop never had
   this — v1 candidates physically could not generalize across varying
   parameters.
2. **The harness must stage into the workspace Archon actually executes in.**
   The battery initially staged fixtures elsewhere and candidates starved
   (grader got []). Same class as the v1 grader-location defect — the
   artifact-location contract applies to the rig itself.

## Negative battery: 18/18 PASS

- T1 first-attempt candidate violating location + network rules is
  rejected STATICALLY (zero Archon runs spent); a legitimately generic
  canary (parses threshold + file name from `$USER_MESSAGE`, header-driven
  column detection, ignores comments/quotes) then acquires end-to-end:
  admitting PASS + held-out 2/2 PASS (thresholds 10/25/18, three file
  shapes).
- T2 byte-identical revision → `REFUSED/REVISION_LOOP` after one spent run.
- T3 persistently static-failing candidates → `REFUSED/BUDGET_EXHAUSTED`
  at the attempt ceiling with zero executions and a full provenance trail.
- T4 hardcoded candidate (passes admitting by memorizing expected rows) →
  refused `HELD_OUT_FAILED`. The false-promotion trap is armed and caught.
- T5 prose-only replies → bounded termination, zero executions.

## Live run 1 (exp-cc66c852): 0 acquired / 4 refused — and what the refusals were

10 metered muse calls, 47,376 output tokens. Every refusal decomposed:

| family | terminal | decomposition |
|---|---|---|
| D01 | HELD_OUT_FAILED | REAL gap: candidate passed the admitting case, failed held-out (qty-first column order → no pairs; quoted fields + header-as-data misparsed). The perturbation design caught exactly what it was built to catch. |
| D02 | BUDGET_EXHAUSTED | CHECKER DEFECT: 3 of 4 attempts rejected pre-execution by a `FORBIDDEN_CREDENTIAL` false positive (bare `KEY=`/`password` pattern matching the family's legitimate key/value-diff logic); 4th attempt unparseable. D02 never got a real chance. |
| D03 | BUDGET_EXHAUSTED | 2 real execution-grader failures (tally mismatch), then the last 2 revisions hit the same credential false positive. Budget burned on the instrument. |
| D04 | HELD_OUT_FAILED | REAL gap: held-out 1 PASS, held-out 2 failed on case-folding (FARID ≠ farid) + comment row included as a shift. |

So: 2 refusals were genuine, evidence-backed generalization failures; 2
were caused by measurement infrastructure — the same dominant class the
v1 forensic replay found. Recorded, fixed, regression-tested:

### Static-checks v1.0.1 (defect record)

`FORBIDDEN_CREDENTIAL` now matches only contextual reads/assignments:
credential STORES (`~/.ssh`, `~/.aws`, `.netrc`, `id_rsa`, `.env`) and
bash assignments whose variable NAME ends in a secret word (`API_SECRET=`
trips; `KEY_VALUE_PAIRS=` does not). Data text inside comparisons no
longer trips it. Failure details quote the matched line. Regression
verified: a legit env-diff candidate PASSES; a credential-stealing
candidate is rejected on STORE + assignment axes; battery re-run 18/18.

## Live runs 2–4 (v2.1–v2.3): results and the cross-run picture

Three more live runs (each all four families, fresh muse calls):

- **v2.1 (exp-075ac248)** — 1 acquired / 3 refused, 9 calls, 43.3k out tokens.
  D03 **acquired end-to-end first-shot** (admitting + held-out 2/2, promoted
  `tally-bookmark-domains` with routing tags). D02 executed for real for the
  first time and failed held-out on a real gap (keys present in only ONE
  file, which the contract says to ignore). D04 hit the attempt ceiling on
  real execution-grader failures.
- **v2.2 (exp-9f93805d)** — 0/4, 10 calls, 52.5k out tokens. D02's revisions
  now execute (scanner fix holding); D03 died as `MODEL_ERROR` — the reply
  consumed the whole 8192-token ceiling on reasoning and returned no text.
  Harness limitation, not model refusal: fixed in v2.3 (16384 → 32768 retry).
  One D02 revision tripped FORBIDDEN_CREDENTIAL on `find . -name "*.env"` —
  judged CORRECT behavior (glob-scanning for credential-shaped files stays
  flagged; the objective needs only the two named files), disclosed here.
- **v2.3 (exp-7f1c3390)** — 1 acquired / 3 refused, **4 calls** (one per
  family; every first-shot candidate reached the held-out gate), 20.6k out
  tokens. D03 acquired again — **reproducible**. D01, D02, D04 all passed
  the admitting case first-shot and failed held-out on their stable gaps.

| family | across 4 live runs | verdict |
|---|---|---|
| D01 threshold-inventory | HELD_OUT_FAILED ×4 (always: qty-first columns, quoted fields, comments) | stable real generalization gap |
| D02 config-diff | v2.0 instrument-strangled → v2.1/v2.3 HELD_OUT_FAILED (one-file noise keys) | real gap, exposed once the instrument stopped strangling it |
| D03 domain-tally | ACQUIRED ×2 (v2.1, v2.3), instrument-caused otherwise | reproducible acquisition |
| D04 shift-handoff | HELD_OUT_FAILED ×2 (case folding, comment rows), admitting non-convergence ×1 | real gap |

**Zero false promotions across all runs.** Every refusal is evidence-backed
(persisted candidates + matched lines + run outputs), and both instrument
defects in the loop's own tooling (credential regex, token truncation)
were caught by exactly the evidence-first mechanism the loop prescribes.

## Design decision disclosed for ruling

**Held-out failure does NOT trigger revision.** The revise loop consumes
failure evidence from static checks and admitting-case execution only.
If the held-out gate fails, the acquisition is refused rather than revised,
because revising against held-out evidence would contaminate the very
generalization measurement the suite performs. Conservative default; GPT
may prefer one bounded revision round (better capabilities, devsuite-only
contamination) — the code is structured to allow either.

## Cost

Live run 1: 10 muse calls, 47.4k output tokens, ~8.4 min wall for all four
families (budget ceilings never approached except D02/D03 attempt counts).
Model cost is effectively a non-constraint on the contributor lane
(owner-directed: go endpoint, free-tier era).
