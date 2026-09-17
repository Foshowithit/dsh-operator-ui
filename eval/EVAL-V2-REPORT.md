# Eval Protocol v2 — scored run results (GPT-approved protocol, executed as frozen)

Status: FINAL, reported as-is per the protocol. Architecture frozen at
`d8c543a`; suite frozen at `11c7320`; executor = real Archon v0.10.1
(equivalence receipt `bc31ac2`). No mid-run changes; everything below is
what the frozen system did.

## Headline

| metric | value |
|---|---|
| families acquired (staged gates + dual sacred terminals passed) | **8 / 12** |
| families refused | 4 / 12 |
| scored objectives satisfied (external graders, 72 total) | **48 / 72** |
| **false promotions** | **0** |
| false SHIPs / false BLOCKs | 0 / 0 |
| model calls / output tokens (whole program) | 19 / 147,947 |

**Every acquired capability passed all six scored encounters of its family
— acquisition trigger, reuse, reuse-under-variation, both contested cases,
and the untouched generalization case.** The distribution is all-or-nothing:
an acquisition either generalizes cleanly or is refused before promotion.

## The amortization curve (the hypothesis)

Cumulative output tokens per satisfied objective, by encounter:

| encounter | role | satisfied | cumulative satisfied | tokens / satisfied |
|---|---|---|---|---|
| S1 | acquisition (all learning cost lands here) | 8/12 | 8 | 18,493 |
| S2 | reuse | 8/12 | 16 | 9,247 |
| S3 | reuse under variation | 8/12 | 24 | 6,164 |
| S4 | contested-a | 8/12 | 32 | 4,623 |
| S5 | contested-b | 8/12 | 40 | 3,699 |
| S6 | untouched generalization | 8/12 | 48 | 3,082 |

**Resources per satisfied objective fall 6.0× across the program with zero
additional model calls after acquisition** — each acquired capability was
pure reuse from S2 onward. All costs of failed acquisitions are retained in
the cumulative economics (they land on their families' S1).

## Per-family outcomes (merged valid data)

| family | acquisition terminal | calls | scored |
|---|---|---|---|
| E01 inventory-reconcile | PROMOTED | 2 | 6/6 |
| E02 interval-overlaps | REFUSED — terminal | 2 | 0/6 |
| E03 column-sums | PROMOTED | 2 | 6/6 |
| E04 hourly-counts | PROMOTED | 1 | 6/6 |
| E05 category-shares | REFUSED — terminal | 1 | 0/6 |
| E06 longest-streak | REFUSED — terminal | 1 | 0/6 |
| E07 code-mapping | PROMOTED | 1 | 6/6 |
| E08 template-render | REFUSED — budget | 4 | 0/6 |
| E09 top-n-ties | PROMOTED | 1 | 6/6 |
| E10 line-length-policy | PROMOTED | 1 | 6/6 |
| E11 radius-count | PROMOTED | 2 | 6/6 |
| E12 running-totals | PROMOTED | 1 | 6/6 |

**Terminal rejections after a learning-gate pass (E02, E05, E06)** —
reported descriptively, per the ruling: in each, the candidate passed the
learning gates (admission/diagnostic/regression) and the first sacred
terminal prevented promotion. Whether that gate was correct or
over-conservative is not asserted; the scored encounters were never
reached, so they cannot adjudicate it. E08 exhausted its revision budget
failing the regression gate.

## Invalidated executions (disclosed in full)

1. `eval-v2-run`: a transient model-lane error storm aborted 11/12
   families at compose (2 calls total). Discarded; records retained
   (`INVALIDATED.json`).
2. `eval-v2-run2`, families E01/E02/E03/E06/E08: same lane-flake class
   (0 completed calls). Recovered under the protocol's infrastructure
   clause via `eval-v2-recovery` with inter-family pacing; the family
   results above for those five come from the recovery run.
3. Recovery measure recorded: the harness retries transient lane errors
   with spacing (labeled; the frozen acquisition architecture was not
   touched).

## Provenance

- Suite: 12 new families E01–E12 (none of D01–D16, none of F01–F10),
  132 fixtures (5 internal per family for learning + 6 scored), frozen
  with hashes (`SCORED-SUITE-FREEZE.json`); controls 396/396; consistency
  all-132; generation-phase repairs documented (E02/E11 empty-expectation,
  E06 key clash, E10 line-number offset — all before the freeze, per the
  generation-time law).
- Every acquisition episode's attempts trail, candidates, parent hashes,
  run IDs and grader results are in `eval/records/`; merged result in
  `eval/EVAL-V2-RESULT.json`.

## What this establishes

Under the frozen architecture, on families generated after the freeze, on
real Archon v0.10.1, with every cost retained: unfamiliar objectives were
converted into reusable capabilities in 8 of 12 families; all 8 generalized
through five further encounters including an untouched case; 4 were
refused without leaking a wrong capability into the stream; no promotion
was ever falsified; and the resource curve amortized 6× across the
program's encounters.
