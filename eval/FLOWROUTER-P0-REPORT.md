# FlowRouter Portability P0 — receipts GREEN

GPT-authorized implementation of the adjudicated contract
(eval/FLOWROUTER-RECONCILIATION.md + amendments). Two clean RCOS homes,
local-directory transport only, **no networking**.

- **Home A** (:8412) — owns the promoted capability `csv-running-total`
  (acquired through the production M3 path in the productization receipt).
- **Home B** (:8414) — fresh DSH_HOME, its own registry starting EMPTY,
  no knowledge of the capability. Same Archon executor (one instance
  serves both in this P0 receipt; the shared executor workspace is
  disclosed in the harness).

## Acceptance matrix — 9/9 GREEN

| # | step | result |
|---|---|---|
| 1 | A export → canonical package | `mac-a/csv-running-total` · implementation digest + package digest (amendment-1 rule) |
| 2 | B stage (authentic package) | STAGED/UNVERIFIED/INELIGIBLE · schema ✓ integrity:implementation ✓ integrity:package ✓ compatibility ✓ collision ✓ |
| 3 | B local verification | fixture **authored B-locally and frozen before execution** (hash `fb32907c…`) · imported implementation executed on the local executor · grader: "all running totals match locally-authored truth" |
| 4 | operator admission | registry entry with `source_identity` + `provenance.source` (A's evidence) + `provenance.import` (B's verification) |
| 5 | B normal routing | route selected `csv-running-total` → ASK_BEFORE_ACTION authority gate (1 approval) → **SHIP** · checks: terminal-status, declared-expectation, objective-satisfaction — on the imported implementation's real RESULT evidence (`row=1 total=14 … row=7 total=148`, computed by B-local truth) |
| 6 | **NEGATIVE A — tamper** | one workflow byte changed → integrity:implementation FALSE + integrity:package FALSE → `INTEGRITY_FAIL` → **never executed** (no run id) → INELIGIBLE |
| 7 | **NEGATIVE B — authentic but unusable here** | crafted with the same digest rule + a tool this machine lacks → integrity BOTH TRUE → `COMPATIBILITY_FAIL` → never executed → INELIGIBLE (authentic ≠ usable proven separately) |
| 8 | **NEGATIVE C — collision** | B already owns the alias → `LOCAL_ID_COLLISION` refusal; existing intelligence never overwritten |
| 9 | re-export from B | identity stays `mac-a/csv-running-total`; import_chain length 1 with A's source package digest `f7c6c2bd…` recorded — provenance appended, authors never rewritten |

## What is now established

- The constitutional rule holds mechanically: **FlowRouter transported the
  evidence of trust; B's trust came only from B's own frozen-fixture
  verification and the operator admission click.** Source lifecycle state
  (PROMOTED) crossed only as `provenance.source.lifecycle`.
- Authenticity and usability are separately observable (integrity vs
  compatibility), and tampering is caught before any execution.
- The production M3 representation (384b303) reconciles with frozen
  Manifest v0.1 **without changing the manifest** — additive `x-rcos`
  fields bridge the four classified gaps.

## Scope honored

No manifest changes, no networking (transport = local directory), no
marketplace/reputation/global scores, no generalized cross-system
adapters. Publish/index/discover/fetch remain a later phase — local
reverification stays the trust boundary regardless.
