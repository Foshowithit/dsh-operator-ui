# FlowRouter — cross-phase adversarial campaign (A0)

Generated from `eval/receipts/FLOWROUTER-A0-RECEIPT.json` (matrix frozen at aef3efd BEFORE execution; sealed at receipt 09fb7e7).

**Governing rule**: Composition may reduce availability or increase work. It must not manufacture authority.

| attack | criterion (frozen in advance) | observed | verdict |
|---|---|---|---|
| A0-1 | discovery yields candidates; downstream resolves honest or refuses; no trust-state change | `{"lying_directory_endpoint": ["http://127.0.0.1:19999"], "poisoned_candidate": {"publisher_scheme": "p2-selfcert-v1", "publisher_id": "9999999999999999999999999999999999999999999999999999999999999999"` | **PASS** |
| A0-2 | F0 observation ABSENT/UNAVAILABLE; no consumer trust change; availability loss only | `{"observation": "UNAVAILABLE", "fetch_permitted": false, "state": "EMPTY"}` | **PASS** |
| A0-3 | committed object survives, rest UNAVAILABLE/REFUSED, no rollback, custody outcomes only | `{"first": {"COPIED": 1}, "rest": {"UNAVAILABLE": 2}, "publications": 1}` | **PASS** |
| A0-4 | S0 refuses the conflict with state byte-identical AND the consumer still obtains a verifying F1 core | `{"s0": {"REFUSED": 1}, "consumer_state": "CONFLICT", "core_verifies": true}` | **PASS** |
| A0-5 | authenticated D from F0/P2 (never the index); failover serves the SAME exact T/D; only availability changes | `{"index_claim_dropped": true, "fetched_from": "m2", "recomputed_D": "f7c6c2bd44e4"}` | **PASS** |
| A0-6 | 10,000 endpoint copies → one endpoint; 10,000 differing-D claims → one tuple; no weight vocabulary | `{"endpoints": 1, "candidates": 1, "observations": 1}` | **PASS** |
| A0-7 | evidence survives restarts byte-identical and verifies; quarantine unchanged by custody; explicit ingest still activates it | `{"custody": {"COPIED": 1}, "quarantine_before": 0, "quarantine_after": 0, "ingest_quarantined": true}` | **PASS** |
| A0-8 | custody unaffected by consumer state; the pin is never rewound; consumer-side use follows ordinary P2 rules | `{"pin_after_ahead_stage": 2, "backfill": {"ALREADY_PRESENT": 1}, "pin_after_sync": 2, "use_verdict": "REFUSED", "use_refusal": "SEQUENCE_ROLLBACK"}` | **PASS** |
| A0-9 | exactly the valid intent is processed; every malformed record is rejected with a reason; nothing silently normalized | `{"processed": 1, "rejected": 4, "reasons": ["unknown scope record fields \"D,name,publishe", "version must be canonical x.y.z", "unknown scope record fields \"name,publisher_", "D must be 64-hex"]}` | **PASS** |
| A0-10 | the consumer path succeeds from durable state and the custody outcome is unchanged across a restart | `{"consumer": "fresh consumer (A0-8 advanced the pin; the rollback rule correctly rejects the earlier state for it)", "custody": {"COPIED": 1}, "bytes_identical": true, "resolution": "CONSISTENT"}` | **PASS** |
| A0-11 | REFUSE or UNAVAILABLE with trust state unchanged — not successful availability | `{"resolution": "EMPTY", "fetch_permitted": false, "stage": "REFUSED", "trust_state_unchanged": true, "refusal_record_only": true, "pin_before": null, "pin_after": null}` | **PASS** |

## What the campaign establishes

Across the frozen matrix, hostile composition can reduce availability, cause refusal, or increase work — but it does not manufacture publisher authenticity, trust weight, freshness, admission, routing authority, quarantine, or consumer-local trust state.

No sealed phase was contradicted, so no phase was patched or re-run. Two executable criteria were corrected to match the frozen matrix text before the seal (A0-9 scope shape, A0-11 trust-state equality), with the matrix unchanged.
