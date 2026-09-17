# FlowRouter F1 — Transparency / Equivocation Detection (spec v1, for adjudication)

Status: spec-only. No code until frozen.
Predecessors: P0 (`FLOWROUTER-P0`), P1 (`FLOWROUTER-P1`), P2 (publisher identity),
F0 (multi-repository discovery/resolution — SEALED: spec 6093ce5, impl 3fb5ccd, receipt 93c29d8).

F0's own seal text names the boundary this phase approaches: *F0 does not solve
fresh-consumer global equivocation*. P2's seal text names it too: global
freshness and equivocation were explicitly left open. F1 addresses that
boundary — and only that boundary.

## 0. The one question

Given independent repositories, a self-certifying publisher identity, and a
consumer that may see more than one authenticated state for the same
publisher, **can a consumer turn a contradiction into portable, offline-
verifiable evidence — without any repository, majority, or global log ever
gaining the authority to declare who is honest?**

This phase is about DETECTION and EVIDENCE. It is not about prevention, and it
does not create a global view of truth.

## 1. Non-claims (frozen boundaries, stated up front)

1. **Detection ≠ prevention.** A publisher that shows one consistent history to
   everyone remains undetectable by any mechanism here.
2. **No global freshness.** F1 never establishes "the current" head; it only
   establishes "these two publisher-signed states cannot both be true".
3. **No authority from agreement or volume.** A proof is not stronger because
   many repositories carry it. Repetition adds no trust (F0 invariant,
   restated).
4. **No global log, no consensus, no reputation, no slashing.** There is no
   registry of honest/bad publishers, and none may be derived from F1
   evidence without an explicit, local, human decision.
5. **First-contact honesty is not provable.** A consumer with no prior state
   and a single source cannot distinguish an honest publisher from a liar.
   F1 does not pretend otherwise; it makes that limit explicit.
6. **Consequences are local.** F1 produces evidence a consumer may act on. It
   never produces an action a consumer must broadcast.

## 2. Definitions

- **Publisher-signed state**: a genesis record plus an ordered key-state event
  chain (P2). Two states are *comparable* when one chain's head is an ancestor
  of the other's (strict extension). They are **conflicting** when they share a
  genesis and are not comparable: either
  - `SAME_SEQUENCE_DIVERGENT` — equal `identity_sequence`, different
    `identity_head_digest`; or
  - `NONEXTENDING_FORK` — different sequences where neither head is an
    ancestor of the other.
- **Equivocation**: the publisher produced two conflicting publisher-signed
  states. Only the genesis key can sign key-state events, so two valid,
  conflicting chains sharing one genesis are cryptographic proof that the
  publisher signed both. Nothing else in the system can manufacture that pair.
- **Equivocation proof (the artifact)**: the self-contained, portable record
  below. It is *evidence*, never an instruction.
- **Observation**: one authenticated view of a publisher state obtained
  locally (a peer query under F0, or the consumer's own prior import).

## 3. What detection consumes (three inputs, no new authority)

1. **Multi-source resolution (F0, already sealed).** When two or more F0
   observations of the same P2 tuple are VALID but conflicting, F0 already
   fails closed with `CONFLICT`. F1 adds: that condition MUST also yield an
   equivocation proof when the conflict is a genuine fork (equal-sequence
   divergent or non-extending). A D-disagreement is *not* a fork (different
   bytes for one tuple is a content conflict, not identity equivocation) and
   MUST NOT produce an equivocation proof.
2. **Local history.** The consumer's own prior observations. If B advanced a
   pin for the publisher at state S1 and later observes a conflicting state S2,
   the contradiction is already detectable locally (P2's
   `IDENTITY_HISTORY_FORK`); F1 requires the same proof artifact be produced
   from local material. The material is already retained: import tasks carry
   the publisher material of every observation that advanced a pin. No new
   durable store is introduced by F1.
3. **Transported evidence (optional, transport only).** A consumer MAY submit
   a proof it verified to any repository, and MAY ask any repository for
   proofs it holds. Repositories MAY carry this evidence. Carrying it grants a
   repository no authority: **a repository can forward a proof, but it can
   never author one** (see §5).

## 4. The artifact (canonical shape)

```
{
  "type": "flowrouter.equivocation-proof.v1",
  "publisher_id": "<64-hex, self-certifying id of the shared genesis>",
  "genesis": <P2 genesis record (self-signed)>,
  "branches": [
    { "events": [<key-state events>], "head_sequence": <n>, "head_digest": "<64-hex>" },
    { "events": [<key-state events>], "head_sequence": <m>, "head_digest": "<64-hex>" }
  ],
  "relation": "SAME_SEQUENCE_DIVERGENT" | "NONEXTENDING_FORK",
  "observed_via": [ <opaque local note: repository_id | "local-pin-history"> ]
}
```

Frozen rules:

- **No new cryptography.** Verification uses only P2 primitives already frozen:
  `verifyGenesis`, `replayChain`, and the record/chain digests. The proof
  carries no signature of its own — it is a container, and its entire force
  comes from the two publisher-signed branches inside it.
- **Deterministic order.** `branches` is ordered by `(head_sequence ASC,
  head_digest ASC)`; `relation` is derived, not asserted by the reporter.
- **Self-contained.** A proof MUST verify with the network off, with no peer
  configured, and with no access to any repository or pin. `observed_via` is a
  local annotation and MUST NOT affect verification.
- **Portable.** The artifact is the unit of transport. Its canonical JSON is
  the JCS canonicalization already frozen in P2.

## 5. Verification rules (frozen)

A proof VERIFIES iff all of the following hold; otherwise it is INVALID and
MUST be discarded (never partially believed):

1. `type` is exactly `flowrouter.equivocation-proof.v1`.
2. `genesis` passes `verifyGenesis`; its `publisher_id` equals the proof's
   `publisher_id`.
3. Each branch replays cleanly (`replayChain`) from that genesis; the replayed
   `head_sequence`/`head_digest` equal the branch's declared values.
4. The two branches are NOT comparable: neither head is an ancestor of the
   other.
5. The declared `relation` matches the derived one.
6. The two branches are not byte-identical (a duplicated branch is not a fork).

Consequences that MUST be stated in any UI/receipt that shows a verified proof:

- The proof shows the publisher signed two conflicting states; it does **not**
  identify which (if either) is the publisher's "real" current state.
- The proof does not say when either state was created, and MUST NOT be
  presented with an ordering it cannot support.

## 6. Consumer policy on a verified proof (local, frozen as a default)

1. **Never auto-select.** Neither branch may be adopted, pinned, or preferred.
2. **Halt advancement.** The consumer MUST refuse to advance (or create) a pin
   for that publisher while a verified proof stands unacknowledged, and MUST
   refuse further P2 imports for that publisher's tuples with a dedicated,
   non-generic refusal code.
3. **Record locally, durably.** The proof is stored as local evidence
   (task-store record, same two-file law as pins) with `publisher_id`, the
   derived relation, and the observed-via note. Storage of evidence is not a
   verdict about a capability.
4. **No retroactive rewrite.** Capabilities already admitted remain admitted;
   F1 never silently removes, degrades, or re-evaluates them. Reversal is an
   explicit operator action with the proof in hand.
5. **Acknowledgment is explicit.** An operator may acknowledge a proof to
   resume work with that publisher; acknowledgment is recorded (who/when/which
   proof digest) and never deletes the evidence.
6. **No broadcast obligation.** A consumer MAY share a proof it verified; it is
   never required to, and sharing has no effect other than delivery.

## 7. Bounded detection (honest limits)

- **Withholding**: a repository that never presents a branch hides the fork. A
  consumer detects equivocation only when it (or evidence it trusts *as
  material*) has seen both branches.
- **First contact**: a fresh consumer querying a single source learns nothing
  about whether other sources were shown something else.
- **Freshness of a single branch**: F1 cannot say a state is stale, only that
  two states contradict.
- **Evidence volume**: ten copies of one proof are exactly as strong as one —
  the strength is in the signatures, not the carriers.

These limits are part of the frozen claim. F1 must never be described as
"detecting equivocation" without the qualifier *whenever two conflicting
publisher-signed states are observed*.

## 8. Frozen invariants (F1)

1. Evidence transport only — no repository may assert equivocation on the
   publisher's behalf; a repository can forward a proof, never author a valid
   one.
2. Verification is offline, self-contained, and trust-free with respect to
   carriers.
3. False-positive freedom: any proof that verifies implies two genuine,
   publisher-signed, conflicting states. An honest publisher's states (all
   comparable) can never be packaged as a valid proof. This is the one thing
   F1 guarantees absolutely.
4. No majority, popularity, availability, ordering, or timestamp authority.
5. Detection ≠ prevention; no global freshness; no global log; no reputation.
6. Consumers never auto-select a branch; consequences are local.
7. Existing admitted capabilities are never retroactively rewritten by
   evidence alone.
8. F1 introduces no new durable state beyond: the proof artifact (transport)
   and the local contradiction record (§6.3).
9. F1 adds no authority to F0: resolution stays read-only, and a proof never
   changes a pin by itself.

## 9. Acceptance topology (for the later implementation round)

Publisher P with a P2 identity. Repositories R1, R2 (independent), a third
repository R3 used only as an evidence carrier. Consumer B with an existing
pin at state S1 for P, plus a clean consumer C with no prior state.

Positive and adversarial cases:

1. **Honest publisher** — P extends its chain (S1 → S2); B resolves across R1,
   R2 → no proof; explicit false-positive check that comparable states never
   produce an artifact.
2. **Equivocating publisher, multi-source** — P signs sibling states at the
   same sequence; R1 carries branch X, R2 branch Y; B resolves across both →
   F0 `CONFLICT` plus a proof with relation `SAME_SEQUENCE_DIVERGENT`, which
   verifies with the network off.
3. **Non-extending fork** — divergent branches at different sequences →
   relation `NONEXTENDING_FORK`; an ancestor branch (extended) never produces
   a proof.
4. **Local-history fork** — B pinned at S1, later observes a conflicting S2 →
   proof assembled from B's own retained material, no peer involved.
5. **Carrier cannot author** — R3 fabricates a proof (tampered branch, foreign
   genesis, duplicated branch, wrong relation, non-fork packaged as a fork) →
   verification fails offline for each tamper independently.
6. **Carrier can only forward** — a proof B verified and submitted to R3 is
   returned to C byte-identical and verifies offline at C.
7. **Withholding** — P equivocates but only R1 holds a branch; resolve returns
   no conflict, no proof, and the consumer's ordinary path proceeds: the
   limitation is demonstrated, not hidden.
8. **Content conflict is not identity equivocation** — two repositories carry
   the same authenticated tuple with different D (F0's `CONFLICT`) and produce
   no equivocation proof.
9. **Consumer policy** — with a verified proof standing: pin advancement for
   that publisher is refused, a fresh P2 import of that publisher is refused
   with the dedicated code, previously admitted capabilities remain untouched,
   and an explicit operator acknowledgment resumes work while keeping the
   evidence.
10. **Causality** — peer-order permutation and carrier identity never change
    proof bytes or the verification verdict; a proof verified on machine A
    verifies identically on an independent machine B with no network.

## 10. Out of scope (explicitly deferred)

- Prevention of equivocation, and detection of single-source lies.
- Any global log, witness network protocol, or consensus over heads.
- Ordering/timestamps of branches, and therefore any "most recent" claim.
- Automatic consequences across machines (broadcast, revocation, blacklist).
- Replication of content (the phase after F1 in the frozen sequence).

## 11. Freeze request

Confirm or amend: (a) the artifact shape in §4 and the offline verification
rules in §5; (b) the local-only consumer policy in §6, in particular that a
verified proof halts pin advancement while leaving admitted capabilities
untouched; (c) the bounded-detection language in §7 as part of the claim;
(d) the acceptance cases in §9. On freeze, F1 implementation and a raw receipt
follow the F0 pattern: implementation commit first, receipt-only child commit
second.
