# Shakedown summary (non-scored) — exp-7431352f (DSH) / exp-b10cec61 (RCOS)

Pipeline proof only. NOT performance data (protocol §8).

| objective | DSH: satisfied | RCOS: satisfied | notes |
|---|---|---|---|
| F08-format-conversion/encounter-1 | True | False | DSH graded PASS on result state; RCOS honest no-route (seed registry has no such capability) |
| F08-format-conversion/encounter-2 | True | False | DSH graded PASS on result state; RCOS honest no-route (seed registry has no such capability) |
| F09-log-analysis/encounter-1 | True | False | DSH graded PASS on result state; RCOS honest no-route (seed registry has no such capability) |
| F09-log-analysis/encounter-2 | True | False | DSH graded PASS on result state; RCOS honest no-route (seed registry has no such capability) |

## Defects found and fixed during shakedown (instrumentation only)
1. Fixture staging targeted a records dir instead of the lane execution workspace (RCOS lane) — fixed.
2. Lane home recreation wiped provider settings → instant MISSING_CREDENTIAL (DSH lane) — fixed with a committed settings template.
3. Baseline freshness refusal fired on HEAD movement — expected behavior; re-froze once at 1e61d86.

## Lane notes for the parity report
- DSH lane model: zai coding-plan GLM-5.3 via anthropic-messages endpoint (owner-authorized at shakedown scale; scored run re-confirms).
- RCOS lane ran on the development home (dirty snapshot recorded as a defect, records marked non-scored); the scored run uses --prepare-lane clean homes.
- RCOS honest-refusal records demonstrate the no-route failure path; DSH demonstrates execution + external grading of real artifacts.
