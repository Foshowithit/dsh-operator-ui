# Breadth Experiment — 12 structurally new families (GPT directive)

Status: SUBMITTED for adjudication. Architecture frozen as ruled: staged
gates (ADMIT → DIAGNOSTIC/LEARNING → REGRESSION → SACRED TERMINALS), ≤3
global revisions, redacted diagnostic evidence, immutable provenance,
**two sacred terminals per family, both required for promotion, neither
feeds revision.**

## Headline

| result | count |
|---|---|
| **ACQUIRED (E1–E3 + E4a + E4b all PASS in one candidate version)** | **9 / 12** |
| refused — sacred terminal caught a remaining weakness | 1 (D07) |
| refused — budget exhausted (never passed E1 / never cleared E2) | 2 (D08, D14) |
| **false promotions** | **0** |
| model calls / output tokens / wall | 21 / 181.8k / ~29 min |

Against the ruled threshold: nontrivial acquisition across structurally
different families ✓ · zero false promotions ✓ · bounded revision/cost ✓ ·
untouched terminal generalization ✓ · understandable failure classes ✓.

## Per-family chains (typed)

| family | structure | chain |
|---|---|---|
| D05 order-join | multi-file join | 1st-shot sweep E1–E3 + E4a + E4b ✓ |
| D06 outline-counts | hierarchical data | 1st-shot sweep ✓ |
| D07 ledger-fold | stateful fold | E1 FAIL→revision→E1–E3 PASS → **E4a FAIL → REFUSED** (sacred gate caught what E1–E3 missed; E4b left untouched per no-revision rule) |
| D08 cross-validation | cross-file validation | BUDGET_EXHAUSTED — result-substance mismatch at E1 ×2 + static rejection; 3 calls |
| D09 daily-report | deterministic report | E1 PASS, E2 FAIL → revision → full re-earn E1–E3 + both terminals ✓ |
| D10 file-selection | filesystem selection | 1st-shot sweep ✓ (grader cross-checks reported sizes against the execution workspace) |
| D11 normalize | normalization | 1st-shot sweep ✓ |
| D12 dep-graph | small dependency graph | static FAIL ×2 + E1 FAIL → 2 revisions → full sweep + both terminals ✓ |
| D13 patch-plan | structured patching | 1st-shot sweep ✓ |
| D14 region-totals | aggregation w/ exclusions | E1 PASS each cycle, E2 FAIL ×3 revisions → BUDGET_EXHAUSTED (reuse-variation handling) |
| D15 version-audit | semver comparison | 1st-shot sweep ✓ |
| D16 duration-binning | bucketing | 1st-shot sweep ✓ |

Learning-loops fired in 3 of 12 episodes (D07 corrected E1 from redacted
evidence; D09 corrected a generalization case; D12 recovered from static
AND execution failures across 2 revisions). The sacred gates refused a
candidate that had passed everything else (D07) — the dual-terminal design
doing exactly its job.

## Infrastructure incident (disclosed)

Mid-experiment, macOS /tmp cleanup destroyed the opui-rc0 Archon home —
binary, database, workflows dir — while its process kept running (API
500s). Restoration attempts: reinstall from the real binary at
~/.bun/bin/archon; the rebuilt instance created a database and accepted
run POSTs but its execution engine never materialized runs (no worker).
**Substitution:** the breadth run executes on `eval/lib/local-dag-runner.mjs`
(:13092) — a minimal Archon-compatible runner providing exactly the API
surface the harness uses (hot-reload YAML from the workflows dir, bash
nodes in dependency order with cwd = registered workspace,
`USER_MESSAGE` env = run message, runs list, run detail with node_output
events, non-zero exit → run failed). Same YAML dialect, same workspace and
artifact contract, same run/event semantics as the sealed v2/v3 runs;
what changed is only the process hosting bash. All v2/v3/v4 results were
produced on real Archon and remain as sealed.

## Provenance

Every candidate persisted (22 yaml files incl. all revisions); per-attempt
trail: parent hash, candidate hash, prompt hash, model usage, static
result, run ID, grader category (model-visible) + full detail (record).
Suite: devsuite-v5, seed 17320508, frozen pre-run (generator v3.0.0 hash,
manifest, graders, controls 486/486 across 162 fixtures, fixture-
consistency verified for all 60 v5 fixtures after the checker caught and
fixed three generator defects pre-freeze).

## Requested ruling

1. Accept/seal the breadth result (9/12, zero false promotions) as the
   Capability Acquisition v2 mechanism's frozen checkpoint.
2. If accepted, per your stated threshold, freeze the v2 architecture and
   authorize Eval Protocol v2 on families generated only after that
   freeze.
3. Note for the record: D08 and D14 failure classes are composition-robustness
   (E1 correctness for cross-file status sets; E2 reuse-variation for
   column-order + exclusions) — analysis available before any architecture
   change, as ruled.
