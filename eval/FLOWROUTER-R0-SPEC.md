# FlowRouter R0 — Authenticated Mirror Replication (spec v2, for adjudication)

Status: spec-only. No code until frozen.

v2 folds in the two amendments from the v1 adjudication: R0 claims no
cross-repository discovery (the positive case is exact lookup plus exact-D
fetch), and the material-conflict rule is restated as immutability / no silent
replacement — NEVER as an equivocation judgment, because non-identical valid
material can be an assertion reissue or a compatible extension just as easily
as a fork. The v1 index-surface decision was approved and is unchanged.
Sealed predecessors: P0 (canonical digest), P1 (publish/index/discover/fetch),
P1-X (independent machine), P2 (publisher identity), F0 (multi-repository
discovery/resolution — spec 6093ce5, impl 3fb5ccd, receipt 93c29d8), F1
(equivocation evidence — spec e9e7ef6, impl 1626d9a, receipt caa06a5).

## 0. The one question

**Can one FlowRouter repository persistently mirror an authenticated P2
publication from another repository, without ever becoming the publisher,
without inheriting trust from the source repository, and without changing any
consumer-local trust state?**

That is R0. Public federation beyond it stays deferred.

## 1. Non-claims (frozen boundaries)

1. **Replication copies possession, never authority.** A mirror may persist and
   retransmit the publisher's immutable bytes and evidence; it cannot become
   the publisher, strengthen the evidence, declare freshness, or transfer
   consumer-local trust state.
2. **Custody provenance is not authentication provenance.** `R1 → R2 → R3`
   describes where bytes traveled. It never replaces the publisher's
   cryptographic binding of tuple → D.
3. **No re-attestation.** A mirror MUST NOT sign, countersign, or otherwise
   re-issue the mirrored publication under any identity of its own. If a
   repository signs the same bytes under its own publisher identity, that is a
   NEW publication with a different publisher tuple — not replication.
4. **No possession-derived signals.** Copy count, agreement, availability,
   recency of custody, or "how many repositories carry it" grant nothing.
5. **Staleness is observed, never asserted.** A mirror that holds state 4 while
   the publisher is at state 8 holds state 4. The ordinary P2/F0 rules classify
   that when a consumer observes it.
6. **No freshness claims, ever** — and no alteration of a P2 chain to appear
   fresher.

## 2. What replicates (exactly three objects)

- **Content object** — immutable P0 artifact bytes, addressed only by `D`.
- **P2 publication object** — the exact structured tuple
  `(p2-selfcert-v1, publisher_id, name, version) → D` together with the complete
  P2 verification material that authenticates that binding: `genesis` +
  `events` + the publication `assertion`.
- **F1 evidence object** — optionally, a `proof_core`, addressed by its frozen
  `proof_digest`.

Rules:

- **No separate identity-chain replication protocol in R0.** Identity history
  travels only as the P2 material attached to an authenticated publication.
- **P1 bindings are NOT replication-capable in R0.** F0 made P1 identity
  origin-scoped (`(R-local repository_id, p1-configured-v1, publisher_id, name,
  version)`); copying such a binding to another repository would silently change
  its origin component. A raw P0 blob referenced by a P1 publication MAY be
  cached by immutable `D`, but the P1 binding itself does not federate.
- **Never replicated (consumer-local, stays local):** pins, pin witnesses as
  consumer state, quarantine records and acknowledgments, admissions, registry
  entries, local verification results, routing state, authority grants.

## 3. Who may replicate (permissionless trust, local storage)

- R0 is **pull replication**. The destination initiates; the source is never
  trusted and never needs to authorize anything.
- **Permissionless at the trust layer**: no cryptographic relationship with the
  source is required, and the source gets ZERO authority from being configured.
- **Locally initiated at the storage layer**: the destination's operator decides
  what source endpoint it is willing to pull from and what storage it spends.
  The configured unit is an exact P2 tuple: *replicate tuple T from source S*.
- **No unsolicited remote push** in R0.
- **Mirror provenance may exist as local, non-authoritative metadata only**
  (`source_repository`, `replicated_at`). It must never alter the replicated
  binding, the P2 material, the P0 `D`, or an F1 proof core.

## 4. What a mirror may and may not claim

A mirror may truthfully say only: *"I currently possess these exact bytes and
this exact portable evidence."*

It MAY serve: the artifact by `D`; the original P2 tuple/D/material; an F1
`proof_core` it holds.

It MUST NOT convert possession into: publisher authenticity of its own,
recommendation, ranking, freshness, "current version", popularity, trust score,
endorsement, eligibility, availability-derived confidence, admission, or
routing authority.

**Index surface decision (for adjudication):** a mirrored binding is served on
the EXACT-LOOKUP surface (a consumer asking for that exact tuple receives the
original material) and by exact-`D` fetch, but is NOT merged into the mirror's
own discovery index in R0. Rationale: discovery exists so that a consumer can
find candidates; a mirror listing another publisher's bindings in its own index
invites reading possession as recommendation, and the frozen consumer path
already reaches mirrors through F0's explicit peer set. Mirror indexing policy
is deferred (see §9), not silently invented.

## 5. The replication transaction (frozen)

```
R2 requests exact P2 tuple T from source R1
R1 returns T → D plus the complete P2 material (genesis + events + assertion)
R2 INDEPENDENTLY verifies the material binds exactly T → D
R2 exact-D fetches the artifact bytes from R1
R2 INDEPENDENTLY recomputes the P0 digest over the received bytes
   require recomputed_D == signed_D == requested_D
R2 commits the blob
R2 commits the immutable mirrored publication binding
```

Frozen rules:

- **Commit order: blob first, binding second.** No verified binding may ever
  point at bytes the mirror did not successfully persist (the P1 crash rule,
  restated at the mirror boundary).
- **Independent verification at the destination** is the same discipline a
  consumer applies: the source's own verdicts are not inputs.
- **Idempotence**: replicating the exact same `(T, D, valid material)` again is
  a no-op. It creates no additional semantic object and no additional trust.
- **Conflict fails closed**: if the destination already holds the same P2 tuple
  with a DIFFERENT `D`, replication MUST fail without touching the existing
  binding — never overwrite, never pick one, never majority-resolve.
- **Material conflict fails closed — as immutability, not as adjudication.**
  If the destination already holds the same tuple and `D` with BYTE-IDENTICAL
  material, the request is idempotent. If the material differs, replication
  refuses (`REPLICATION_MATERIAL_CONFLICT`) and the stored object remains
  byte-identical. The reason is immutability and the prohibition on silent
  replacement — **not** an equivocation finding. Non-identical valid material
  can equally be a newly issued assertion, or the same tuple/D authenticated
  against a later COMPATIBLE extension of the identity history. R0 draws no
  conclusion from the difference alone about equivocation, freshness, or which
  state is preferable:
  - if the two histories are compatible, ordinary P2/F0 semantics say they are
    compatible;
  - if they are non-comparable, ordinary F0/F1 semantics establish the fork
    when both observations are actually observed.
  **Replication never becomes a history adjudicator.**
- **No version fallback**: a request for `name@1.2.3` must never silently yield
  1.2.4, 1.2.2, or "latest". Exact match or refuse.
- **`requested_D` means**: the `D` obtained from — and authenticated by — the
  exact tuple lookup, and then used as the target of the subsequent exact-D
  fetch. The operator requests a tuple, never a digest; R0 does not require the
  operator to know `D` in advance.

## 6. Evidence carriage

An F1 `proof_core` may be carried by a mirror through the already-frozen dumb
evidence path (`POST`/`GET` by `proof_digest`), byte-identically.

- Merely STORING a proof at a mirror quarantines nobody anywhere.
- Quarantine and acknowledgment remain consumer-local and happen only through
  the explicit F1 ingest step.
- A mirror's custody of evidence changes no other repository's or consumer's
  state.

## 7. Frozen invariants (R0)

1. A mirrored publication's authentication is always the ORIGINAL publisher's;
   nothing of the mirror's identity appears in the signed material.
2. Destination-side verification is independent: P2 material binding, P0
   recomputation over received bytes, and the tuple equality
   (`recomputed_D == signed_D == requested_D`) are all re-established locally.
3. Possession grants no authority: no ranking, freshness, recommendation,
   eligibility, admission, or routing effect — at the mirror or anywhere else.
4. Replication is idempotent per exact `(T, D, byte-identical material)` and
   fail-closed on any conflict, with no fallback and no overwrite; a material
   difference is treated as immutability, never as an equivocation finding.
5. Consumer-local trust state (pins, witnesses, quarantine, acknowledgments,
   admissions, registry, routing, authority) is untouched by replication —
   storage changing is not trust-state change.
6. Custody hops are irrelevant to authenticity: `P → R1 → R2 → R3` still
   authenticates `P` with identical `T`/`D`/material.
7. P1 bindings do not federate; only P0 blobs may be cached by immutable `D`.
8. Mirror provenance (`source_repository`, `replicated_at`) is local metadata
   and never alters any replicated object.
9. R0 introduces no discovery, no directory, no subscription, and no
   synchronization protocol.

## 8. Acceptance topology and required causal properties (later round)

```
Publisher P → R1
                ↓ replicate
               R2
                ↓ replicate (second hop)
               R3
Consumer B knows only R2 (and then R3)
```

1. **Positive mirror**: P publishes an authenticated capability to R1 only. R2
   never communicates with P. R2 replicates from R1. B knows the exact P2 tuple
   and has ONLY R2 configured/reachable for that publication: B performs an
   exact lookup against R2, exact-D fetches from R2, independently authenticates
   the ORIGINAL publisher P, then follows the sealed local
   stage → verify → admit → route → SHIP path. **R0 provides no cross-repository
   discovery** — the tuple is known to B in advance (an F0 resolve against an
   explicit peer set is the consumer's own business and is not R0's claim).
2. **No mirror authorship**: the publisher remains P everywhere; nothing in
   R2's identity appears in the signed publication.
3. **Byte substitution**: R1 advertises valid signed `T`/`D` but serves altered
   artifact bytes during replication → R2's recomputation rejects it and no
   mirrored binding commits.
4. **Binding substitution**: a malicious source rewrites name/version/
   publisher/`D`, or supplies unrelated valid P2 material → rejected before any
   commit.
5. **Invalid history/assertion**: malformed genesis/events, an unauthorized key,
   a bad assertion, or a wrong chain head → replication rejects.
6. **Destination conflict**: R2 already holds the same exact tuple at a
   different `D` → replication refuses and the existing binding is byte-identical
   afterwards.
7. **Material conflict — immutability, not adjudication**: R2 holds T+D with
   material A; a source offers T+D with material B.
   - R0 refuses the replacement and keeps A byte-identical
     (`REPLICATION_MATERIAL_CONFLICT`), and repeats of the exact B do not
     accumulate extra copies or trust;
   - a COMPATIBLE B must NOT generate an F1 equivocation claim merely because
     its bytes differ (the mirror would be adjudicating if it did);
   - a genuinely NON-COMPARABLE B remains independently detectable as a fork
     when A and B are observed across repositories under the sealed F0/F1
     rules — the mirror neither creates nor suppresses that evidence.
   - byte-identical material is idempotent, never a conflict.
8. **Idempotence**: exact repeat replication adds no second object and no extra
   trust.
9. **Consumer-local-state invariant**: replication changes none of R2-as-
   consumer's pins, witnesses, quarantine, registry, admissions, or routing.
10. **Copy count adds zero authority**: one mirror and several mirrors yield the
    same publisher-authentication result for B — three copies are not stronger
    than one.
11. **Staleness**: R2 carries a genuine older branch while R1 carries a
    compatible extension; the F0/P2 classification (not R2) determines the
    consumer-visible result, and R2 asserts nothing about freshness.
12. **F1 carriage**: a mirrored `proof_core` is byte-identical and independently
    verifies; storing it at R2 quarantines nobody; only B's explicit ingest can
    quarantine, and its pin/witness behavior stays exactly as sealed.
13. **Multi-hop custody**: `P → R1 → R2 → R3 → B` — B authenticates P with
    identical `T`/`D`/material, proving the architecture is content/evidence-
    addressed rather than accidentally trusting whoever is closest to the
    publisher.
14. **P1 boundary**: an attempt to replicate a P1 publication binding is refused
    as non-federatable, while raw P0 blob caching by `D` still works.

## 9. Explicitly deferred (not R0)

Public repository directory; automatic peer discovery; ranking/search
marketplace; replication subscriptions/watchers; continuous synchronization;
remote push replication; bulk publisher-history synchronization; global
"latest"; mirror freshness attestations; mirror signatures/re-attestations;
reputation; quorum/consensus; automatic conflict healing; storage
quotas/accounting/billing; garbage-collection policy; a global cross-repository
dedup protocol; delta replication/compression negotiation; P1 binding
federation; automatic replication of consumer F1 quarantine/acknowledgment
state; mirror indexing policy (§4).

Local blob deduplication by immutable `D` is fine as an implementation detail.
A global dedup protocol is not R0.

## 10. Freeze request

Confirm or amend: (a) the three transport objects and the never-replicated list
(§2); (b) the pull/permissionless-trust/local-storage model and the
provenance-metadata rule (§3); (c) the index-surface decision — mirrors serve
exact lookups but do not list mirrored bindings in their own discovery index
(§4); (d) the transaction, its commit order, idempotence, the `requested_D`
interpretation, and the three fail-closed conflict rules — with the material
conflict stated as immutability rather than adjudication (§5);
(e) the evidence-carriage rule that storing a proof quarantines nobody (§6);
(f) the acceptance properties, especially the multi-hop custody case (§8). On
freeze, R0 implementation and a raw receipt follow the sealed pattern:
implementation commit first, receipt-only child second.
