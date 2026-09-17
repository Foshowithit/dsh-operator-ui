# FlowRouter — one readable end-to-end trace (I1)

Generated from `eval/receipts/FLOWROUTER-I1-RECEIPT.json` (sealed at spec 8fb55a4 / impl f39b095 / receipt 303bae9).
Every value below is the value the receipt recorded for that seam.

## The path

```
[ok ] topology: origin R1, mirror R2, destination R3, consumer, configured directory
[ok ] lane 1. P0/P2 — publisher authenticates the publication into origin R1
[ok ] lane 2. R0 — the mirror independently verified and now holds the ORIGINAL publisher material
[ok ] lane 3. D1 — one endpoint candidate from the configured directory, with no capability claim and no authority
[ok ] lane 4. D0 — exactly one exact P2 tuple candidate; the candidate carries no digest and no version selection
[ok ] lane 5. explicit selection — the caller picks the exact tuple (no rank, no latest, no scoring anywhere)
[ok ] lane 6. S0 — the exact named object is backfilled into the destination through ordinary R0 (one object, additive)
[ok ] lane 7. F0 — exact resolution over the destination resolves the exact tuple with the canonical proof material
[ok ] lane 8/9. P2 authenticates the ORIGINAL publisher and P0 recomputation confirms the artifact bytes
[ok ] lane 10. stage → B-local verify → explicit admission → route → SHIP, with the admitted LOCAL capability
[ok ] lane 10b. exactly one owned mutation per seam: the sealed stage moved the pin, explicit admission moved the registry, nothing else did
[ok ] branch 1. F0 sees NON-COMPARABLE observations across two independent repositories and F1 constructs the proof core
[ok ] branch 2. the proof crosses untrusted transport AND optional S0 evidence custody byte-identically, verifying at the destination — and custody alone quarantines NOBODY
[ok ] branch 3. explicit ingest quarantines; the next import refuses BEFORE any pin mutation, and the earlier admission stays untouched
[ok ] branch 4. acknowledgment preserves the evidence and the pin while lifting the quarantine
[ok ] seams. the object leaving each phase IS the object entering the next: canonical endpoint, exact tuple, publisher_id, D and material digest all continuous
[ok ] authority. I1 introduces no trust object, status, ranking, selector, freshness or identity field, and every consumer-local mutation is owned by a sealed step
```

## What each phase owns, and what it knows

| handoff | owned by | what crosses |
|---|---|---|
| origin R1 → mirror R2 | R0 | custody of one exact validated object (blob + immutable binding) |
| directory Q → consumer | D1 | endpoint candidates only — no publisher, tuple, digest, freshness or ranking |
| endpoint R2 → consumer | D0 | exact tuple claims with a non-authoritative claimed_D |
| mirror R2 → destination R3 | S0 | an exact named object, copied additively through ordinary R0 |
| destination R3 → consumer | F0 | the resolved exact tuple + canonical proof material (read-only) |
| consumer → consumer-local stage | P2 + P0 | publisher identity bound to the exact tuple and a locally recomputed artifact digest |
| stage → route | sealed P2 stage + explicit admission | the ONLY pin mutation is the stage; the ONLY routability change is explicit admission |

## The values crossing the seams (machine-checked continuity)

```
P0/P2_publish:
  {"D": "f7c6c2bd44e4a766e9bb13c632e9b00d288090ee78e904680cc3365e36d2895c", "publisher_id": "5762ade14b72dc9a51c907a236700a454a116b624663f6771eace6fcd78807cf", "tuple": {"publisher_id": "5762ade14b72dc9a51c907a236700a454a116b624663f6771eace6fcd78807cf", "name": "csv-running-total", "version": "0.1.0"}, "material_digest": "5b66db6b0b4dd9512db6d8158d762366034857936ef1b3de1a9a534ff0d510ba"}
R0_mirror:
  {"D": "f7c6c2bd44e4a766e9bb13c632e9b00d288090ee78e904680cc3365e36d2895c", "material_digest": "5b66db6b0b4dd9512db6d8158d762366034857936ef1b3de1a9a534ff0d510ba"}
D1_endpoint:
  {"endpoints": ["http://127.0.0.1:13182"], "count": 1}
D0_tuple:
  {"candidates": [{"publisher_scheme": "p2-selfcert-v1", "publisher_id": "5762ade14b72dc9a51c907a236700a454a116b624663f6771eace6fcd78807cf", "name": "csv-running-total", "version": "0.1.0"}], "count": 1}
explicit_selection:
  {"selected_tuple": {"publisher_scheme": "p2-selfcert-v1", "publisher_id": "5762ade14b72dc9a51c907a236700a454a116b624663f6771eace6fcd78807cf", "name": "csv-running-total", "version": "0.1.0"}, "decided_by": "caller/operator"}
S0_backfill:
  {"outcome": {"COPIED": 1}, "observed_D": "f7c6c2bd44e4a766e9bb13c632e9b00d288090ee78e904680cc3365e36d2895c", "destination_D": "f7c6c2bd44e4a766e9bb13c632e9b00d288090ee78e904680cc3365e36d2895c"}
F0_resolution:
  {"state": "CONSISTENT", "authenticated_D": "f7c6c2bd44e4a766e9bb13c632e9b00d288090ee78e904680cc3365e36d2895c", "selected_state": {"head_sequence": 1, "head_digest": "a32ff97a003e085a6c0bee17bc46e60c0df51094ee7bf3fd8928afb800cd116e", "proof_source": "dest", "globally_fresh": false, "note": "most advanced mutually compatible state observed in this query \u2014 not globally fresh"}}
P2_authenticated:
  {"publisher_id": "5762ade14b72dc9a51c907a236700a454a116b624663f6771eace6fcd78807cf", "material_digest": "5b66db6b0b4dd9512db6d8158d762366034857936ef1b3de1a9a534ff0d510ba"}
P0_recomputed:
  {"recomputed_D": "f7c6c2bd44e4a766e9bb13c632e9b00d288090ee78e904680cc3365e36d2895c"}
consumer_local:
  {"pin_before_use": null, "pin_after_stage": {"publisher_id": "5762ade14b72dc9a51c907a236700a454a116b624663f6771eace6fcd78807cf", "sequence": 1, "head_digest": "a32ff97a003e085a6c0bee17bc46e60c0df51094ee7bf3fd8928afb800cd116e"}, "pin_witness_sha": "352c665027f45d7b9416822df8cc3fd5eb6d10588ca830554b8dc9ef5267df12", "registry_before_admit": "45a8d752d2707c70d432aedcd6fe03b014683d99dccc05ca77a8032cc8a
F1_fork:
  {"state": "CONFLICT", "relation": "SAME_SEQUENCE_DIVERGENT", "proof_digest": "53c51a2e4a3714dc0871e104acd72e4a28a55c60a665ec215250cae9ac7a41ee"}
F1_carriage:
  {"proof_digest": "53c51a2e4a3714dc0871e104acd72e4a28a55c60a665ec215250cae9ac7a41ee", "identical": true, "verifies": true, "custody_outcome": {"COPIED": 1}}
F1_ingest:
  {"quarantined": true, "refusal": "PUBLISHER_EQUIVOCATION_UNACKNOWLEDGED"}
```

## Phase coverage

| phase | role | I1 coverage |
|---|---|---|
| P0 | exact artifact integrity | exercised |
| P1 | repository transport foundation | inherited sealed prerequisite |
| P1-X | real-network physical portability | inherited sealed prerequisite |
| P2 | publisher authentication | exercised |
| F0 | exact multi-repository resolution | exercised |
| F1 | equivocation evidence (branch) | exercised (separate branch) |
| R0 | authenticated custody replication | exercised |
| I0 | prior federation composition | inherited sealed prerequisite |
| D0 | tuple discovery | exercised |
| D1 | endpoint discovery | exercised |
| S0 | exact-scope custody backfill | exercised |

## The claim this trace earns

> The completed FlowRouter federation can take a consumer from only a canonical capability name and a configured untrusted directory to a consumer-local SHIP through untrusted discovery, authenticated custody transfer, exact federation resolution and local verification/admission — while repositories, directories, mirrors, sync bookkeeping, transport and orchestration acquire no authority beyond their already-sealed roles.
