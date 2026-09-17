# Staged-Gate Revision Experiment — result (GPT's authorized option (b))

Status: SUBMITTED for adjudication. Suite: eval/devsuite-v4 (frozen
pre-run, 4 encounters per family per the adjudicated chain). Machinery
frozen: graders, static validator, contracts, promotion criteria —
untouched; controls re-verified 306/306 before the run.

## Headline

| experiment | acquired | false promotions |
|---|---|---|
| single-shot baseline (no revisions) | 0/4 | 0 |
| **staged gates + ≤3 revisions (this run)** | **2/4** | **0** |

**Answer to the experiment's question — can RCOS use observed failure
evidence to autonomously revise a failed candidate into reusable
intelligence that passes independent held-out evaluation? — YES,
demonstrated end-to-end twice**, with the development-set rule working
exactly as ruled: failures that fed learning never counted as promotion
evidence; promotion came only from the sacred terminal case.

## Progression chains (typed attempt trail)

- **D01 ACQUIRED** (1 revision): E1 PASS first-shot → E2 FAIL
  (result-substance mismatch) → revision r1 from E2's redacted evidence →
  regression: E1 PASS, E2 PASS, E3 PASS → **E4 sacred terminal PASS →
  PROMOTED**.
- **D02 ACQUIRED** (1 revision): compose rejected by static validator →
  revision r1 composed a valid candidate → E1/E2/E3 all PASS → **E4 PASS →
  PROMOTED**.
- **D03 REFUSED — TERMINAL_FAILED** (1 revision): E1 FAIL → r1 fixed it →
  E1/E2/E3 all PASS → **E4 terminal FAIL → honest refusal**. The learning
  loop generalized through three gates; the sacred case caught the gap.
  No revision from E4, per the rule.
- **D04 REFUSED — budget** (3 revisions): never passed E1; the muse lane
  still cannot compose a robust shift-duration parser. Budget refused,
  full trail preserved.

## First attempt invalidated by a rig defect — recorded, fixed, rerun

The first staged run (exp-612462ae) returned 0/4 and is INVALIDATED by an
acquirer-side evidence defect: candidates that both print RESULT lines AND
write them to a workspace file had every pair counted twice by the
evidence join (`node outputs + workspace bodies`), so ordered-list graders
saw double and misgraded correct candidates — D03's rev0 candidate was
substantively CORRECT (its output matched the expected tally exactly) and
was refused anyway. Same defect class as v1's grader-location bug, one
layer up. Fix: evidence for output-contract grading is the run's node
outputs; the workspace snapshot remains for file-state graders and
provenance. Graders untouched; controls 306/306 after the fix; battery
18/18. The defect, the misgraded-correct case, and the rerun are all
committed for audit.

## Cost

10 muse calls, 83.9k output tokens, ~16.5 min wall for four teaching
episodes. Revisions-to-promotion: 1 for both acquired families. Ceiling
headroom: the token ceiling (50k/episode) never bound; D04 hit the
revision count.

## Framing (per the ruling)

Architecture experiment, tiny sample (4 families × 1 terminal case): this
demonstrates the staged learning edge works and the promotion gate holds
— it does not establish a general acquisition rate.
