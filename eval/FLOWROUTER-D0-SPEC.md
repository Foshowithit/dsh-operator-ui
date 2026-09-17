# FlowRouter D0 — Untrusted Repository Possession Index (spec v3, for adjudication)

Status: spec-only. No code until frozen.

v3 fixes one off-by-one between §4 and acceptance case 13 (the truncation
boundary is now stated identically in both and tested at exactly 256 / 257).

v2 folds in the one v1 amendment: CANDIDATE IDENTITY IS THE EXACT P2 TUPLE
ONLY. `claimed_D` may not participate in identity, deduplication, ordering, the
candidate bound, peer multiplicity, downstream selection or trust weighting —
otherwise attacker-chosen D claims could consume the local result bound and
crowd out other candidates, giving `claimed_D` an indirect authority that §2
forbids. The bound itself is now frozen exactly (MAX_D0_CANDIDATES = 256 with a
deterministic algorithm) rather than left to the implementation.
Sealed predecessors: P0, P1, P1-X, P2, F0 (6093ce5), F1 (e9e7ef6), R0 (43ca378),
I0 (060aa90).

## 0. The one question

**Given a repository endpoint and only a canonical capability name, can a
consumer learn exact P2 tuple candidates that the endpoint claims to possess,
without granting that index any trust authority?**

D0 deliberately does NOT solve "I know neither the tuple nor an endpoint" —
that is the later directory phase (D1).

## 1. The object (frozen)

**A repository possession index**, answering exactly one thing:

> *"Which exact authenticated-publication tuples does this endpoint claim it
> currently holds for this name?"*

It does NOT answer: where on the federation to go, which is best, which is
newest, which publisher is trustworthy, or which copy is canonical.

- **R0's temporary indexing exclusion is reversed here** for P2 mirrored
  bindings: an R0 mirror may appear in this possession index because D0 is now
  defining the semantics that were deliberately deferred at R0.
- **P1's older discovery semantics are NOT retrofitted.** D0 is a separate
  possession-index contract; it neither redefines nor extends P1's
  discovery surface.

## 2. Entry semantics (frozen)

The minimal indexed claim is exactly:

```
publisher_scheme = "p2-selfcert-v1"
publisher_id     = <64-hex self-certifying publisher id>
name             = <canonical capability name>
version          = <exact version>
claimed_D        = <64-hex digest the endpoint associates with that tuple>
```

Semantically: *endpoint E claims to possess exact tuple T, associated in its
local index with D.*

- **The endpoint is observation provenance, NOT a globally meaningful
  repository identity.** No entry carries, implies, or references a durable
  repository identity.
- **`claimed_D` is NOT trusted input.** It may be useful as diagnostic or
  provenance, but the consumer must never turn it into the digest it expects
  F0/P2 to prove. The downstream exact lookup determines the authenticated
  `T → D`. In particular: *index says T → D1 while exact lookup authenticates
  T → D2* neither authorizes D1 nor casts doubt on D2 — the index was simply
  stale or false, and ordinary F0/P2 evidence owns the result.
- **No entry may contain or imply**: `publisher_auth=VERIFIED`, `trusted`,
  `fresh`, `recommended`, `score`, `rank`, `popularity`, `canonical`, `latest`.
  An endpoint may have independently verified material internally; D0 does not
  export that verification as authority.
- **Only P2 publication bindings belong in the index.** P1 bindings remain
  non-federatable; raw P0 blobs are not capability-index entries; F1 evidence
  is not capability-index content.

## 3. Query boundary (frozen)

- The consumer supplies a **canonical exact capability name**.
- The index may return **zero or more exact P2 tuples** matching that name,
  including several publishers and several versions.
- **D0 never chooses a version**: not `latest`, not `preferred`, not `current`,
  and it must not automatically feed only the numerically highest one
  downstream. Selecting one exact tuple is the caller's/operator's act.
- Fuzzy search, semantic search, tags and natural-language retrieval are out of
  scope.

## 4. Candidate identity, ordering, repetition, bounds (frozen)

- **CANDIDATE IDENTITY IS THE EXACT P2 TUPLE ONLY:**

  ```
  candidate_key = (publisher_scheme, publisher_id, name, version)
  ```

  `claimed_D` MUST NOT participate in: candidate identity; deduplication;
  canonical ordering; the candidate-count bound; peer multiplicity; downstream
  selection; or trust weighting. `T/D1`, `T/D2`, `T/D3` therefore normalize to
  exactly ONE candidate `T`. Contradictory D claims may be retained as
  non-authoritative diagnostic observations (or simply discarded after the
  receipt records that the source lied), but they may never alter the
  normalized candidate set.
- **Set semantics.** Response ordering carries ZERO meaning; the canonical sort
  below exists solely to make truncation independent of attacker-supplied
  ordering, and carries no preference semantics.
- **Deduplicate before anything downstream.** `1 occurrence = 100 occurrences
  = 10,000 occurrences` in trust weight. Repetition may consume bandwidth; it
  can never increase authority.
- **The local bound is frozen, not implementation-chosen:**

  ```
  MAX_D0_CANDIDATES = 256

  validate entries
    → normalize to exact tuple keys
    → dedupe BY TUPLE KEY
    → canonical bytewise sort: publisher_scheme, publisher_id, name, version
    → retain the first 256
    → truncated = true iff more than 256 UNIQUE tuple candidates existed
  ```

  Crossing 256 is a completeness/availability limitation and is never a trust
  signal.

## 5. What the consumer does with an answer (frozen flow)

```
consumer knows: canonical name N + configured endpoint E
query E's possession index for N
receive untrusted candidates: T1/claimed_D, T2/claimed_D, ...
normalize + dedupe        (no scoring, no version selection)
caller selects ONE exact tuple T
endpoints that claimed T become ordinary F0 peer candidates
F0 exact resolve(T) → P2 verification → exact-D fetch → P0 recomputation
stage → local verify → explicit admit → route → SHIP
```

**Key invariant:** a candidate learned through D0 is *indistinguishable, from
F0 onward, from the same endpoint and tuple having been typed by hand.*
Discovery provenance may be recorded (`learned_from_index: E`) but it cannot
affect F0 ranking, validity, pinning, admission or routing.

**D0 is read-only observation.** No D0 operation may mutate P2 pins/witnesses,
F1 quarantine/acknowledgments, the capability registry, admission, routing
state, or repository replication state.

## 6. Lies, staleness, poisoning (frozen posture)

The index is ALLOWED to lie. Safety comes from the lie having no authority.

- A false publisher entry costs queries/work; if it claims a victim tuple but
  the endpoint cannot produce valid victim P2 material, ordinary verification
  rejects it and nothing pins or admits.
- A false/stale `claimed_D` contributes zero authority (see §2).
- A listed tuple the endpoint does not possess surfaces as F0
  ABSENT/INVALID/UNAVAILABLE — a harmless candidate failure.
- **Withholding is undetectable in D0.** Absence proves nothing: an endpoint
  that omits a capability it really holds is indistinguishable from one that
  does not hold it. **D0 provides candidate discovery, not completeness.**
- D0 does not prove an endpoint remains available after answering.

These limits are part of the frozen claim and must be stated wherever D0 is
described.

## 7. Acceptance matrix (for the later implementation round)

Claim to be earned: *a consumer that knows only a canonical capability name and
a repository endpoint can discover exact P2 tuple candidates from that endpoint
and safely feed them into the already-sealed federation/trust path, while
false, stale, duplicated, reordered, omitted or subsequently unavailable index
observations affect only discovery completeness or cost — not publisher
authenticity, capability trust, or routing eligibility.*

The positive receipt uses a name with **one exact tuple** so that D0 cannot
quietly acquire a version-choice policy merely to reach SHIP.

1. **Positive mirrored discovery**: P publishes to R1, R2 mirrors it; the
   consumer knows only the name and R2's endpoint; R2's index returns the
   mirrored P2 tuple; the consumer F0-resolves → exact-fetches → stages →
   verifies → admits → SHIPs while authenticating the ORIGINAL publisher P.
2. **Origin/mirror equivalence**: learning T from an origin's index versus a
   mirror's index produces the same downstream trust result.
3. **False publisher entry**: the index claims a victim tuple but the endpoint
   cannot produce valid victim P2 material → no pin, no admission.
4. **False/stale D**: index reports `T → D_bad`, exact lookup authenticates
   `T → D_real`; D0's D contributed zero authority.
5. **Nonexistent tuple**: indexed T exact-looking returns ABSENT → harmless
   candidate failure.
6. **Malformed/invalid publication material**: the index may list it; F0/P2
   still reject it.
7. **Repetition**: the same tuple repeated with IDENTICAL or with DIFFERENT
   `claimed_D` values always yields exactly one candidate.
8. **Permutation**: arbitrary permutations — including differing D claims for
   the same tuple — produce the identical normalized candidate set.
9. **Multiple versions**: the index returns several exact versions and selects
   none; F0 is not invoked until an exact tuple is chosen externally.
10. **Withholding**: the index omits a publication the endpoint actually holds;
    the receipt states that this is undetectable and that no completeness claim
    is made.
11. **Index disappears after observation**: nothing is retroactively weakened
    or strengthened; if the publication endpoint remains available F0 proceeds
    from the already-observed candidate, and if the endpoint is gone it is
    simply unavailable.
12. **No trust-state mutation**: querying and normalizing leaves pins, task
    evidence, quarantine records, registry and admissions byte-identical.
13. **Flood bound, with the frozen edge conditions**: 10,000 different fake D
    claims for ONE tuple consume exactly one candidate slot; MORE THAN 256
    genuinely distinct tuple keys produce the same canonical first 256
    candidates under every tested input ordering with `truncated: true`; and the
    boundary is tested exactly —
    `256 unique tuple keys → 256 retained, truncated: false` and
    `257 unique tuple keys → the canonical first 256 retained, truncated: true`.
    No popularity or weight inference anywhere.
14. **Copy count adds nothing**: the same tuple appearing in 1, 2 or N known
    repository indexes yields no stronger authentication than one valid P2
    observation.

## 8. Explicitly deferred (not D0)

Shared/public endpoint directory; discovering an endpoint when none is
configured; globally meaningful or signed repository identity; directory
federation; crawling arbitrary peers; fuzzy/semantic or tag search;
popularity; ranking; recommendations; "latest" version selection; reputation;
search-result scoring; sync/watchers/subscriptions; backfill scheduling;
availability scoring; mirror freshness; automatic replication; trust from
index agreement; F1 evidence indexing.

**No signed index in D0.** Signing an index forces the question "who is this
repository cryptographically?" — creating the durable repository-identity
object explicitly deferred. HTTPS or similar transport authentication may be
operationally useful, but D0's trust model must remain safe even when index
content is malicious.

Roadmap: **D0 repository possession index** ("given an endpoint and a name,
what exact tuples does it claim to hold?") → **D1 untrusted endpoint directory**
("given a name and no endpoint, where might I ask?") → **S0
synchronization/backfill** ("how do I continuously copy observations without
turning time into global freshness?").

## 9. Freeze request

Confirm or amend: (a) the object and its single question, including the
explicit reversal of R0's indexing exclusion and the separation from P1's
discovery surface (§1); (b) the entry semantics and the untrusted-`claimed_D`
rule with the forbidden-field list (§2); (c) the exact-name query boundary and
the "never choose a version" rule (§3); (d) candidate identity as the exact
tuple only, dedupe by tuple key, and the frozen MAX_D0_CANDIDATES = 256
algorithm (§4); (e) the consumer flow with the
indistinguishability invariant and the read-only rule (§5); (f) the poisoning
posture and the stated limits — especially "candidate discovery, not
completeness" (§6); (g) the fourteen acceptance cases (§7); (h) the deferral
list, including no signed index (§8). On freeze, the D0 implementation and its
raw receipt follow the sealed pattern: implementation commit first, receipt-only
child second.
