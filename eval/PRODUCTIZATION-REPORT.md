# Productization — the sealed Acquisition v2 mechanism on the M3 product path

Per GPT's ruling on Eval v2 (checkpoint 7b5c9cc): "merge the proven v2
acquisition mechanism into the actual M3 product path, rather than leaving
it as an eval harness." Done, and proven live.

## What was built

- **lib/acquire.js** — the production acquisition engine: compose (the
  configured cognition backend; 'endpoint' proven model lane, or 'dsh'
  headless per M3-SPEC §2.1) → static validation (dialect, output
  contract, artifact-location, forbidden content) → execute on the
  ORIGINATING task's real workspace (Archon) → marker + **independent
  objective evaluation** (the M1 adjudicator — never the acquisition's own
  opinion) → on failure: redacted diagnosis → material revision (≤3) →
  re-execute → CANDIDATE | REFUSED. Frozen budgets (≤3 revisions / ≤4
  calls / 50k out tokens / 10 min; config may only tighten). Fail-closed:
  no cognition configured → honest refusal, never a fabricated candidate.
  No third store: the acquisition envelope lives in tasks.json exactly
  like every other RCOS task; the registry is written ONLY by the explicit
  operator promotion click (teach.js machinery, unchanged).
- **Wiring**: `/acquire` route (index.js) + the gap affordance now calls
  the production engine (client.js) + the gap next-action reads
  "Acquire capability" (goal.js) + `acquisition` config section with
  validation (env-var NAME credentials only — never values; budgets
  tighten-only) + a contract check in scripts/check.js (fail-closed
  config, bounded ceilings, static-before-execute order, promotion
  separation, hygiene).

## Live receipt (dev lane, real Archon v0.10.1)

`eval/records/productization/PRODUCT-PATH-RECEIPT.json` — the complete
chain, executed against the running product:

1. **GAP**: an unfamiliar objective → no-route, next action "Acquire
   capability".
2. **ACQUISITION**: candidate `csv-running-total-v0-1-0` composed,
   static-validated, executed on the real workspace, passed the marker +
   objective-evaluation gates → CANDIDATE (revision 0), full attempts
   trail + routing vocabulary in the envelope.
3. **PROMOTION**: explicit operator click → registry entry with permanent
   provenance (engine id, evaluation run id).
4. **REROUTE**: the same objective → route selected
   `csv-running-total v0.1.0` → the ASK_BEFORE_ACTION authority gate held
   dispatch for approval (fail-closed surface working) → approve →
   **SHIP** with all three checks green and trust ladder at
   "Objective satisfied", on real RESULT evidence produced by the learned
   capability.

## What this establishes

The mechanism proven under the frozen Eval v2 program now operates inside
RCOS itself: gaps encountered in normal work are converted into
bounded-evaluated, operator-promoted, provenance-carrying capabilities
that routing subsequently reuses. The eval harness remains for future
evaluation; production no longer depends on it.

Next (per the ruling's sequence): reconcile the production M3
representation with Capability Manifest v0.1 and build the
RCOS↔FlowRouter portability layer (learn locally → prove locally →
promote → export evidence-bearing capability → import elsewhere →
reverify locally → reuse).
