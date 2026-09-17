# FlowRouter S0 — Exact-Scope Custody Backfill (spec v1, for adjudication)

Status: spec-only. No code until frozen.
Sealed predecessors: P0, P1, P1-X, P2, F0 (6093ce5), F1 (e9e7ef6), R0 (43ca378),
I0 (060aa90), D0 (d0e935d), D1 (ac80256).

## 0. The one question

**Can a destination backfill an explicit finite set of exact FlowRouter objects
from one configured source by independently applying the already-sealed object
verification and custody rules to each item — while sync scheduling, repetition,
interruption, bookkeeping, source availability and source omission grant no
authority over freshness, completeness, publisher identity, consumer trust,
admission or routing?**

The narrowings that make this answerable:

- **S0 does NOT enumerate "whatever the source currently has."** That would
  introduce a new repository-inventory object and immediately reopen
  completeness/freshness semantics.
- **S0 reconciles an explicit finite LOCAL SCOPE of exact object intents against
  one configured source.**

Frozen line: **backfill is custody; global freshness is not.**

## 1. What S0 is (frozen)

A **one-shot, destination-side pull reconciler**. Its only job:

> *for each exact object my local scope asks for, attempt to obtain and
> independently verify that object from configured source S using the
> already-sealed transaction that owns that object.*

The transportable object classes are exactly the already-established ones:

```
P2 publication   exact tuple T = (p2-selfcert-v1, publisher_id, name, version)
P0 content-only  exact D
F1 evidence      exact proof_digest
```

The local scope therefore looks conceptually like:

```
publications: [ exact P2 tuple T1, exact P2 tuple T2, ... ]
blobs:        [ exact D1, ... ]
proofs:       [ exact proof_digest P1, ... ]
```

- A **publication intent deliberately does NOT specify a guessed D**: the
  configured source supplies its authenticated `T → D`, and ordinary R0
  independently verifies that binding and the bytes.
- A standalone **blob intent is content custody only**;
- a **proof intent is evidence custody only**.

**Core invariant: S0 schedules existing custody transactions; it never weakens
them.**

## 2. No discovery, no version enumeration, no source inventory (frozen)

S0 may NOT accept: "all versions of foo", "latest foo", "everything publisher P
has", "everything source S has", "everything I'm missing" — each requires an
authoritative inventory or comparison model that has never been sealed.

The lawful composition, when discovery has already happened elsewhere:

```
D1 → endpoint candidate
D0 → exact tuple candidates
operator/caller selects exact T
S0 receives exact T
```

**S0 re-verifies everything through R0 and inherits no trust from D0 or D1.**
If the source holds `foo@1.0.0`, `foo@1.1.0`, `foo@2.0.0` while the scope names
only `foo@1.0.0`, only that exact tuple is an S0 subject and S0 never infers
that the others are "newer".

## 3. Scope identity, ordering and limits (frozen)

```
publication key = pub   | publisher_scheme | publisher_id | name | version
blob key        = blob  | D
proof key       = proof | proof_digest
```

- Exact duplicates collapse into one custody operation.
- Canonical ordering MAY be used for deterministic execution and receipts, and
  carries **no priority or trust semantics**.
- **No fixed security bound is frozen here** (unlike D0/D1): this scope is local
  operator intent, not attacker-controlled remote output. Operational resource
  limits may exist but are not a protocol or trust property.

## 4. Publication backfill is ordinary R0 (frozen)

```
configured source S → exact P2 tuple lookup T → independent P2 verification
→ authenticated T → D → exact-D fetch → independent P0 recomputation
→ require recomputed_D == authenticated_D → ordinary R0 commit
```

Every sealed R0 rule remains intact: blob before binding; immutable binding;
identical material → idempotent; same `T`/different `D` → R0 D conflict; same
`T+D`/different material → R0 material conflict; source custody grants no
authority; the destination verifies independently.

**There is no batch trust mode. A 100-object S0 run is 100 independently
justified custody decisions, not one trusted batch.**

## 5. Content-only and F1 objects (frozen)

- **Exact P0 `D`**: fetch by exact D → independently recompute the P0 digest →
  commit content-only custody iff equal. **No publication binding is invented.**
- **Exact F1 `proof_digest`**: fetch the proof core → recompute the digest →
  independently verify it under the sealed F1 rules → store the exact evidence
  bytes. **Syncing an F1 proof does NOT ingest it**: storage/transport must not
  automatically quarantine, acknowledge, mutate pins, or affect admission or
  routing. Possessing equivocation evidence is not the same operation as
  activating consumer-local quarantine.

## 6. Additive custody, never source-authoritative reconciliation (frozen)

**Source absence never causes destination deletion.** If S served X yesterday
and does not serve X today, S0 may report
`requested X → source currently unavailable/absent`; it may NOT conclude that X
was revoked, that X is obsolete, that the destination should delete X, or that
the destination is stale. Existing destination objects remain untouched.

S0 is a backfill, **not a mirror-state synchronizer in the filesystem sense**: it
may add independently verified custody; it never subtracts custody because a
source omitted something. Deletion, pruning, GC and retention remain separate
policy.

## 7. Interruption and partial runs (frozen)

**S0 is not batch-atomic.** Each object already has an atomic sealed
transaction; S0 must not wrap them in a new cross-object transaction.

```
object A → committed
object B → committed
source dies
object C → unavailable
```

leaves A and B committed; S0 does not roll them back merely because the run did
not finish. A run may end with a mixture of `COPIED`, `ALREADY_PRESENT`,
`REFUSED`, `UNAVAILABLE` — custody outcomes, not trust ranks.

## 8. Journal semantics (frozen)

S0 may persist a LOCAL journal; it is not a network trust object. Allowed
fields include `run_id`, `source_endpoint`, `requested_object_key`,
`attempted_at`, `outcome`, `observed_D`, `error_code`. Operational timestamps
are permitted and mean only *when a local action occurred*.

The journal may say: "at 08:42, source S served exact publication T whose
authenticated D was X"; "exact requested object X has not been copied"; and,
for an explicit finite scope, "all 7 objects requested by this local run are
present" — meaning only those seven named objects.

It must NEVER say or imply `UP_TO_DATE`, `LATEST`, `BEHIND`, `STALE`,
`CURRENT`, `SOURCE_AHEAD`, `DESTINATION_BEHIND`, `FULLY_SYNCED_WITH_SOURCE` or
`COMPLETE_REPLICA`, because none of those propositions are established. **The
sync journal must never be consumed as an input to** P2 pinning, F1 quarantine,
registry admission, routing, D0 ordering, D1 ordering, F0 validity, or
repository authenticity.

## 9. No rollback concept; S0 is not a history adjudicator (frozen)

If a source serves material that cryptographically verifies but represents an
earlier publisher history than some consumer has seen elsewhere, S0 does not
call it stale. Consumer-local P2 pin semantics stay consumer-local: at
repository custody level an empty destination plus a valid source object is
ordinary R0's decision, an existing binding with conflicting D/material is
ordinary R0's refusal, and consumer pins elsewhere are neither read nor mutated
by S0.

## 10. Source and destination identity (frozen)

For S0 v0: **one configured source endpoint + one configured destination per
run.** The source locator is not a repository identity; repeated successful runs
add no trust. No source ranking, best/fastest/preferred source, multi-source
voting or source reputation. If a source was learned through D1, the
operator/caller already selected it — S0 treats it identically to a manually
configured locator.

## 11. Interface shape (frozen)

No new federation protocol and no new public S0 network object. Prefer a local
coordinator/library/CLI operation that invokes the existing sealed repository
functions:

```
syncExact({ source_endpoint, destination, explicit_scope })
```

The source need not implement `/sync`; S0 itself needs no persistent network
API. Continuous daemon operation is deferred.

## 12. Acceptance cases (for the later implementation round)

Claim to be earned as in §0. The positive campaign uses a MIRROR as source —
proving publisher → origin → mirror/source → S0 destination without custody ever
becoming publisher authority.

1. **Positive publication backfill**: the destination never contacts publisher
   P; the configured source is a mirror; the exact tuple is backfilled through
   ordinary R0; the destination re-serves the original P2 publication with
   unchanged publisher, material and D.
2. **Consumer usability**: a consumer subsequently uses the destination's copy
   through ordinary F0/P2 → local verify → admit → SHIP.
3. **Exact scope only**: source holds T1 and T2, scope names T1 only → T2 is not
   copied and no "newer version" observation is produced.
4. **Out-of-scope objects** remain untouched.
5. **Content-only D** independently recomputes and is cached without inventing a
   publication.
6. **F1 evidence**: the exact proof_digest copies byte-identically and verifies,
   while quarantine remains unchanged until explicit F1 ingest.
7. **Idempotent repeat**: re-running the same scope adds no duplicate binding,
   trust or authority.
8. **Same T / different D conflict**: ordinary R0 refusal with the destination
   state byte-identical.
9. **Same T+D / different material conflict**: ordinary R0 material refusal with
   the existing state byte-identical.
10. **Missing requested object**: recorded as unavailable; no destination trust
    mutation.
11. **Interrupted run**: object A commits, the source disappears before B → A
    remains, B does not appear, no batch rollback.
12. **Source absence never deletes**: an object already held survives even if
    the source stops serving it.
13. **No consumer-trust mutation**: pins, witnesses, F1 activation, registry,
    admission and routing stay byte-identical during S0 custody work.
14. **No discovery authority**: the S0 journal/results do not alter D0/D1
    ordering, candidate multiplicity or F0 validity.
15. **Scope duplicate neutrality**: duplicate intents normalize to one custody
    operation.
16. **Mirror-to-mirror**: the source itself acquired T through R0; the
    destination receives the same ORIGINAL publisher material, not a source
    re-attestation.
17. **Restart durability**: restart the destination after backfill and prove the
    exact object custody survives the disk reload.
18. **Journal semantics**: timestamps and outcomes exist only as local
    operational facts; the receipt asserts the ABSENCE of freshness vocabulary
    and fields.
19. **No publisher contact**: the positive path demonstrates the destination
    never needed network contact with the original publisher.
20. **No global-completeness claim**: the source may hold additional unknown
    objects while S0 still reports only facts about the explicit local scope.

## 13. Explicitly deferred (not S0)

Continuous background daemon; periodic scheduled watcher; push subscription;
source→destination notifications; repository-wide enumeration; "sync
everything"; automatic new-version detection; latest; freshness comparisons;
source/destination lag; global completeness; multi-source voting; source
ranking or failover policy; deletion; pruning; garbage collection; retention
policy; quotas; automatic conflict resolution; cross-repository dedup protocols
beyond exact immutable objects; mutable repository snapshots; custody-derived
reputation.

**No absence-driven deletion. No time-derived trust. No custody-derived
freshness.**

## 14. Freeze request

Confirm or amend: (a) the one-shot explicit-scope framing and the three object
classes, with the no-inventory rule (§0, §1, §2); (b) the scope keys, duplicate
collapse and the deliberate absence of a frozen bound (§3); (c) publication
backfill as ordinary R0 with no batch trust mode (§4); (d) the content-only and
F1 rules, including "syncing a proof does not ingest it" (§5); (e) additive
custody with no absence-driven deletion (§6); (f) non-batch-atomic runs and the
four custody outcomes (§7); (g) the journal's allowed fields, its forbidden
vocabulary and the never-consumed-as-input list (§8); (h) the no-rollback and
not-a-history-adjudicator rules (§9); (i) one source + one destination per run
with no ranking or reputation (§10); (j) the local-coordinator interface shape
(§11); (k) the twenty acceptance cases, including the mirror-as-source positive
campaign (§12); (l) the deferral list and the three closing prohibitions (§13).
On freeze, the S0 implementation and its raw receipt follow the sealed pattern:
implementation commit first, receipt-only child second.
