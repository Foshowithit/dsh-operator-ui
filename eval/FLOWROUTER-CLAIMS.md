# FlowRouter — claims document

What has been **proven**, what is **inherited and assumed**, what is
**explicitly unproven or deferred**, and what is **out of scope**. Every proven
claim cites the receipt that carries its raw evidence. Nothing here is claimed
more strongly than the evidence supports.

## 1. Proven (each with its receipt)

| # | Claim | Evidence |
|---|---|---|
| 1 | Artifact integrity is exact: a package digest is recomputed from bytes at every destination, never taken from a source. | `FLOWROUTER-P0-RECEIPT.json` |
| 2 | A repository can publish, index, discover and serve exact objects by digest over the network, with immutable records authoritative over any derived index. | `FLOWROUTER-P1-RECEIPT.json` |
| 3 | It works across a **second physical machine** with the artifact transported over the network only. | `FLOWROUTER-P1X-RECEIPT.json` |
| 4 | Publisher identity is self-certifying: Ed25519 genesis, genesis-signed key-state chains, revocation, rotation, assertions bound to identity state, consumer sequence pinning with rollback and fork detection. A malicious repository cannot substitute publisher namespace, package binding, identity history or authenticated outer metadata without detection by the repository *and independently by the consumer*. | `FLOWROUTER-P2-RECEIPT.json` |
| 5 | A consumer can deterministically resolve a capability across independent repositories without granting consensus, popularity, ordering or availability any authority, and can fetch from any already-validated mirror for the exact digest while the consumer-selected identity state stays invariant. | `FLOWROUTER-F0-RECEIPT.json` |
| 6 | Whenever two conflicting publisher-signed identity states are observed, portable evidence of the contradiction can be constructed; it verifies offline, survives transport through untrusted carriers, and drives explicit consumer-local policy. | `FLOWROUTER-F1-RECEIPT.json` |
| 7 | A repository can persistently mirror an authenticated publication while preserving the original publisher's binding and granting no authority to custody, mirror count, availability or repository identity — including under concurrent conflicting replication, where the mirror converges to one immutable object. | `FLOWROUTER-R0-RECEIPT.json` |
| 8 | The sealed phases **compose**, across two physical machines, into one continuous lifecycle without collapsing their trust boundaries. | `FLOWROUTER-I0-RECEIPT.json` |
| 9 | A consumer knowing only a name and a repository endpoint can obtain exact tuple candidates from an untrusted possession index and enter the trust path, while false/stale/duplicated/reordered/wrong-name/omitted/flooded index observations affect only completeness or cost. | `FLOWROUTER-D0-RECEIPT.json` |
| 10 | A consumer knowing only a name and an untrusted directory endpoint can learn endpoint candidates, while membership, repetition, ordering, malformed locators, availability and operator behaviour affect only completeness or cost. | `FLOWROUTER-D1-RECEIPT.json` |
| 11 | A destination can backfill an explicit finite set of exact objects from a configured source by independently applying the sealed rules to each, while scheduling, repetition, interruption, bookkeeping, source availability and source omission grant no authority. | `FLOWROUTER-S0-RECEIPT.json` |
| 12 | The complete federation is **traceable** from a name and a directory to a consumer-local SHIP, with machine-checked value continuity across every seam and no authority introduced by orchestration. | `FLOWROUTER-I1-RECEIPT.json` |
| 13 | Across a pre-frozen cross-phase adversarial matrix, hostile composition reduces availability, causes refusal or increases work — it does not manufacture publisher authenticity, trust weight, freshness, admission, routing authority, quarantine or consumer-local trust state. | `FLOWROUTER-A0-RECEIPT.json` |

## 2. Inherited / assumed (not re-proven here)

- **Cryptographic assumptions** of Ed25519 and SHA-256.
- **Transport authentication** (HTTPS etc.) is operationally useful but is NOT
  part of any trust claim: every phase's trust model holds even when all
  carried content is malicious.
- **P1 and P1-X**, and the earlier **I0** composition, are treated as sealed
  prerequisites by I1 rather than re-run — I1's coverage table says so
  explicitly in its receipt.
- The operator's own environment (local process integrity, disk durability of
  the host) is assumed, not proven.

## 3. Explicitly unproven / deferred (stated as limits, not gaps to hide)

- **Global freshness does not exist.** FlowRouter never establishes "the
  current" version of anything. It resolves exact states and proves
  contradictions; it does not order time.
- **Withholding is undetectable.** A repository that omits an object it holds,
  a directory that omits an endpoint, or a peer that keeps one branch of a fork
  to itself cannot be detected by these mechanisms.
- **First-contact honesty is not provable.** A consumer with no prior state and
  a single source cannot distinguish an honest publisher from a liar.
- **Equivocation evidence proves what a KEY did**, not which human operated it,
  and does not distinguish intentional equivocation from key compromise.
- **Custody is not authority**: possession, replication count and custody paths
  grant nothing, by construction — but this also means a mirror cannot vouch for
  freshness or completeness, ever.
- **Directories and indexes may lie**: they are permitted to be wrong, stale or
  malicious; only the cost of a failed query changes.
- **Deferred phases** (each would create a new trust object and requires its own
  scope ruling): continuous sync daemons, push/subscriptions, multi-directory
  federation and agreement-derived trust, signed directories, durable
  repository identity, reputation/ranking, garbage collection, retention and
  quotas, mutable snapshots, automatic conflict healing, and any "latest".

## 4. Out of scope (deliberately never attempted)

- Publisher-facing product experience (authoring, publishing UI, key
  management workflows) — deferred until this presentation pass, and explicitly
  not part of the protocol claims above.
- Any global consensus, ledger or ordering mechanism.
- Any mechanism that turns availability, popularity, agreement or custody
  history into trust.

## 5. How to check any of this yourself

1. Each receipt in `eval/receipts/` is raw JSON from the exact implementation
   commit named in its parent commit message.
2. The harnesses that produced them are in `eval/lib/` and can be re-run.
3. `scripts/check.js` asserts the invariants structurally (no signing primitive
   in a mirror, no writes in discovery, blob-before-binding, exact schemas,
   absence of authority vocabulary) on every run.
