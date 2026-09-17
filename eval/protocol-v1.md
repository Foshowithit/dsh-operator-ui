# Eval Protocol v1 — DeepSeek RCOS longitudinal capability experiment

Status: DRAFT for GPT adjudication (frozen+hashed before any scored run).
Owner: this repo. Adjudicator: the DeepSeek RCOS design thread.

## 1. The one hypothesis

> Does evaluated reusable capability acquisition reduce the resources
> required to satisfy recurring objectives while maintaining or improving
> objective-satisfaction reliability?

Not "is RCOS smarter." Whether converting successful problem-solving into
evaluated, reusable capabilities makes the system operationally better AS
WORK ACCUMULATES.

## 2. The two comparisons

1. **Cold-start** — DSH and RCOS each see a task family for the first time.
   Measures whether the RCOS machinery itself adds overhead or benefit when
   there is nothing to reuse.
2. **Longitudinal** — both systems receive the same evolving stream; RCOS
   may accumulate, promote, and reuse capabilities through its NORMAL
   mechanisms ( Teach Mode M2 rules: build → held-out evaluate → operator
   promote). This tests the recursive thesis.

## 3. Fairness constraints (all hard)

- Same model(s), same hardware, same initial tools, same files, same
  objectives, same external access, same maximum budgets.
- DSH gets DSH. RCOS gets its architecture. DSH is not crippled.
- No benchmark variant may be seen by Teach Mode's build/evaluation before
  its scored encounter (contamination = disqualification of the run).
- No tuning RCOS against the final benchmark after seeing comparative
  results. Protocol + variants are hash-frozen BEFORE the shakedown; the
  scored run runs on the frozen set.

## 4. Corpus: 10 task families × 5 encounters = 50 objectives

Families (deterministic, zero-credential unless noted; browser/research
families deferred until reproducibility is controllable):

| # | family | reusable structure |
|---|--------|--------------------|
| F01 | text-stats-workspace | per-file + totals measurement |
| F02 | repository-inspection | inventory a tree (counts by type, largest file, TODO scan) |
| F03 | structured-extraction | pull all `key: value` fields into a summary |
| F04 | line-transform | normalize line endings/trailing space/sort |
| F05 | validation-gate | check invariants (required files, manifest matches contents) |
| F06 | release-prep | assemble changelog + version bump evidence |
| F07 | duplicate-report | report duplicate logical records across files |
| F08 | format-conversion | CSV↔JSON↔TSV small structured sets |
| F09 | log-analysis | counts by level/window from an app log |
| F10 | dependency-audit | list declared deps + detect version mismatches |

Encounter shape: encounter 1 establishes the family pattern; encounters 2-5
vary filenames, directory layout, quantities, wording, irrelevant files,
and edge cases (unicode, empty inputs, large inputs). Variant generators
are deterministic (seeded) and their EXPECTED outputs are computable.

Interleaving: the 50 objectives are shuffled with a fixed public seed so
the stream is `A D B F A C D …`, never `AAAAA BBBBB …`. The shuffle seed is
part of the frozen manifest.

Hidden variants: encounters 3-5 of each family live behind a hash manifest
(`corpus-manifest.json` records sha256 of each objective folder). The RCOS
teaching path never receives those folders before their scored encounter.

## 5. Measurements — one canonical record per objective

```json
{
  "system": "dsh | rcos",
  "task_family": "F03",
  "encounter": 4,
  "objective": "…",
  "objective_satisfied": true,
  "false_ship": false,
  "wall_time_ms": 0,
  "model_calls": 0,
  "tokens": { "input": 0, "output": 0, "cache_read": 0 },
  "human_interventions": 0,
  "approval_interventions": 0,
  "capability_built": null,
  "capability_reused": null,
  "route": "…",
  "attempts": 1,
  "failure_codes": [],
  "evidence_refs": ["runId", "taskId"],
  "cost_usd": null
}
```

- `false_ship` is FIRST-CLASS: a SHIP whose claimed outcome does not hold
  under post-hoc verification of the evidence against the expected result.
- `approval_interventions` (authority gates, by policy) are counted
  SEPARATELY from `human_interventions` (problem-solving help). ASK_BEFORE_
  ACTION must never make RCOS look artificially human-intensive.
- `cost_usd` only where pricing is actually known; null otherwise.

## 6. The two headline metrics (plotted vs encounter number)

1. **cost per satisfied objective** (tokens + wall time + model calls as
   separate axes, plus cost_usd where known).
2. **human problem-solving interventions per satisfied objective**.

Expected shape (if the thesis holds): RCOS may be MORE expensive early
(evaluating and packaging intelligence is an investment) and cheaper later
— the curve crosses. DSH stays flat. False SHIPs are plotted on the same
chart; an RCOS win with hidden false SHIPs is not a win.

## 7. Checkpoints and tracing

Report at objectives 1 / 10 / 25 / 50; retain EVERY individual record.
Each checkpoint reports: capabilities acquired, capabilities reused,
objectives satisfied, false SHIPs, cumulative inference, cumulative wall
time, cumulative human problem-solving interventions, cost per satisfied
objective, reuse contribution.

RCOS-only trace (proves M2.5 connection): any later success must be
traceable objective → capability → version → teaching task → evaluation
evidence → promotion → previous uses.

## 8. Run procedure

1. Freeze this protocol + corpus generators + variant hashes →
   `corpus-manifest.json` (sha256 recorded, committed).
2. Non-scored SHAKEDOWN: a small subset (2 families × 2 encounters, both
   systems) purely to prove instrumentation works. Shakedown records are
   marked non-scored and excluded.
3. Scored run: 50 objectives × 2 systems on the frozen stream. If something
   breaks mid-run: RECORD IT in the run log. No quiet repair-and-replay of
   only one system.
4. Bring results + full record store (not just checkpoints) to the design
   thread.

## 9. Where things live

- `eval/protocol-v1.md` — this file (hash-frozen at freeze time)
- `eval/corpus/` — generated fixture workspaces (deterministic, seeded)
- `eval/corpus-manifest.json` — sha256 per objective folder + shuffle seed
- `eval/records/` — canonical records (JSONL, one per objective, gitignored
  for scored runs; committed for shakedowns)
- `eval/lib/` — corpus generator + recorder + runner scripts
