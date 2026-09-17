# FlowRouter F1 — Transparency / Equivocation Detection (spec v2, for adjudication)

Status: spec-only. No code until frozen.
Predecessors: P0, P1, P2 (publisher identity), F0 (multi-repository
discovery/resolution — SEALED: spec 6093ce5, impl 3fb5ccd, receipt 93c29d8).

F0's seal names the boundary this phase approaches: *F0 does not solve
fresh-consumer global equivocation*. P2's seal names it too. F1 addresses that
boundary — and only that boundary.

v2 folds in the five amendments from the v1 adjudication (local witness rule,
proof_core/local_annotation split with a content address, canonical pair
selection + D-conflict precedence, the exact quarantine/acknowledgment state
machine, and the false-positive claim inheriting P2's key-compromise boundary).

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
   many repositories carry it. Repetition adds no trust.
4. **No global log, no consensus, no reputation, no slashing.** There is no
   registry of honest/bad publishers, and none may be derived from F1 evidence
   without an explicit, local, human decision.
5. **First-contact honesty is not provable.** A consumer with no prior state
   and a single source cannot distinguish an honest publisher from a liar.
6. **Key compromise is inherited, not upgraded.** F1 proves what a KEY did; see
   §7 for the precise claim.
7. **Consequences are local.** F1 produces evidence a consumer may act on. It
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
- **Equivocation**: the publisher's genesis key authorized two conflicting
  key-state histories. Only that key can sign key-state events, so two valid,
  conflicting chains sharing one genesis are cryptographic proof that the key
  authorized both. Nothing else in the system can manufacture that pair.
- **Equivocation proof**: the portable artifact of §4 — a container whose force
  comes entirely from the two publisher-signed branches inside it.
- **Proof digest**: the content address of the portable core (§4), used for
  deduplication and operator acknowledgment.
- **Identity witness**: the material required to reproduce one exact
  publisher-signed state: `genesis` + `events[0..head_sequence]`. Retained by
  the consumer's own task store whenever the sealed P2 stage creates or
  advances a pin (§3.2).
- **Observation**: one authenticated view of a publisher state obtained
  locally (a peer query under F0, or the consumer's own pinned witness).

## 3. What detection consumes (three inputs, no new authority)

1. **Multi-source resolution (F0, sealed).** When two or more F0 observations
   of the same P2 tuple are VALID but the observations contain conflicting
   (non-comparable) publisher-signed histories, F0 already fails closed with
   `CONFLICT`. F1 adds: such a resolve MUST also return an equivocation proof
   **core**.
   - **D-conflict precedence (frozen):** mere D disagreement with comparable
     identity histories is a *content conflict* and MUST NOT produce an F1
     proof. If the observations ALSO carry non-comparable identity histories,
     the identity fork is proven independently of the simultaneous D conflict,
     and F1 MUST emit the proof.
2. **Local pinned witness (§ new in v2).** Whenever the sealed P2 stage
   creates or advances a pin, the pin record MUST additionally retain the
   verified identity witness for that exact pinned state: `genesis` +
   `events[0..pinned_sequence]`.
   - evidence material only — it grants no authority and changes no
     verification outcome;
   - it lives in the existing task store (same two-file law as pins), not a
     new storage system;
   - `MATCHES_LOCAL_PIN` MUST NOT rewrite it (a lower-state observation does
     not degrade the witness);
   - local fork detection uses the pinned witness + the newly observed
     conflicting branch, so the proof is self-contained without any peer;
   - **legacy pins** written before F1 that lack a witness may still reject
     forks under P2's frozen rules, but MUST NOT claim a portable
     local-history proof unless the old branch material is otherwise
     available. Absent witness = no local-history proof, stated honestly.
3. **Transported evidence (optional, transport only).** A consumer MAY submit
   a proof core it verified to any repository, and MAY ask any repository for
   proof cores it holds. Carrying evidence grants a repository no authority: a
   repository can forward a proof, never author a valid one.

**F0's seal is preserved:** F0 `resolve` stays READ-ONLY. It may *return* a
proof core, but durable recording and quarantine activation happen only through
an explicit F1 verify/ingest operation (§6). An orchestration may invoke that
operation immediately after a resolve; it is still a distinct, state-changing
step.

## 4. The artifact (canonical shape)

Two objects, deliberately separated — only the first is evidence, only the
second is local bookkeeping:

```
proof_core = {
  "type": "flowrouter.f1.equivocation-proof.v1",
  "publisher_id": "<64-hex, self-certifying id of the shared genesis>",
  "genesis": <P2 genesis record (self-signed)>,
  "branches": [
    { "events": [<key-state events>], "head_sequence": <n>, "head_digest": "<64-hex>" },
    { "events": [<key-state events>], "head_sequence": <m>, "head_digest": "<64-hex>" }
  ],
  "relation": "SAME_SEQUENCE_DIVERGENT" | "NONEXTENDING_FORK"
}

local_annotation = { "observed_via": [ <opaque local note: repository_id | "local-pinned-witness"> ] }
```

Frozen rules:

- **No new cryptography.** Verification uses only P2 primitives already frozen:
  `verifyGenesis`, `replayChain`, and the record/chain digests. The core is
  unsigned — a container — and its entire force comes from the two
  publisher-signed branches inside it.
- **Exact schema.** `proof_core` accepts exactly the fields above; an unknown
  field makes the core INVALID. Two conforming implementations therefore
  produce identical bytes for the same contradiction.
- **Content address.**
  `proof_digest = SHA256(UTF8("flowrouter.f1.equivocation-proof.v1\n") || JCS(proof_core))`
  This is the proof's stable identity: deduplication and operator
  acknowledgment are by digest, and no signature is introduced.
- **Canonical pair selection (frozen).** From the set of conflicting
  publisher-signed states: dedupe by `(head_sequence, head_digest)`; sort the
  unique states by `(head_sequence ASC, head_digest ASC)`; consider the
  non-comparable pairs in lexicographic order; the **lexicographically first
  non-comparable pair** is the canonical proof pair. The branches array holds
  exactly that pair, in that order. The ordering is canonicalization only and
  carries **no temporal meaning**.
- **Portable.** `proof_core` alone is the unit of transport. Its canonical
  JSON is the JCS canonicalization already frozen in P2.
- **Annotations never bind.** `local_annotation` may differ freely between
  consumers and MUST NOT affect verification, `proof_digest`, or proof
  identity.

## 5. Verification rules (frozen)

A core VERIFIES iff all of the following hold; otherwise it is INVALID and MUST
be discarded whole (never partially believed):

1. `type` is exactly `flowrouter.f1.equivocation-proof.v1`, and the core has
   exactly the frozen fields (no unknown, no missing).
2. `genesis` passes `verifyGenesis`; its `publisher_id` equals the core's.
3. Each branch replays cleanly (`replayChain`) from that genesis; the replayed
   `head_sequence`/`head_digest` equal the branch's declared values.
4. `branches` holds exactly two entries, ordered as the canonical pair order of
   §4, and the two are NOT comparable (neither head an ancestor of the other).
5. The two branches are not byte-identical (a duplicated branch is not a fork).
6. The declared `relation` matches the derived one.

Consequences that MUST be stated in any UI or receipt that shows a verified
proof:

- The proof shows the genesis key authorized two conflicting states; it does
  **not** identify which (if either) is the "real" current state.
- The proof carries no time and MUST NOT be presented with an ordering it
  cannot support.

## 6. Consumer policy: quarantine and acknowledgment (frozen state machine)

**Dedicated refusal code: `PUBLISHER_EQUIVOCATION_UNACKNOWLEDGED`.**

- **Quarantine condition.** A publisher is locally quarantined iff at least one
  *verified, unacknowledged* proof record exists for it.
- **While quarantined:**
  - a new P2 import for that publisher refuses with
    `PUBLISHER_EQUIVOCATION_UNACKNOWLEDGED`, **before any pin mutation**;
  - no pin is created or advanced for that publisher;
  - capabilities already admitted remain admitted and routable under their
    existing authority rules — nothing is retroactively rewritten.
- **Acknowledgment** is by `proof_digest`, and:
  - records operator identity and time as metadata on that proof record;
  - does NOT delete or weaken the proof;
  - does NOT alter the pin;
  - does NOT select either fork;
  - does NOT override ordinary P2 rollback/fork verification.
- If another unacknowledged proof exists (or a new one arrives later), the
  publisher remains or becomes quarantined again.
- **Activation path.** Durable recording and quarantine activation happen only
  through an explicit F1 verify/ingest operation (verify + record + return the
  proof digest). F0 `resolve` never records anything.
- **Never auto-select.** Neither branch may be adopted, pinned, or preferred.
- **No broadcast obligation.** A consumer MAY share a proof it verified; it is
  never required to, and sharing has no effect other than delivery.

## 7. What a proof proves (precise claim)

Assuming the frozen P2 cryptographic assumptions and an **uncompromised genesis
key**:

- a verifying F1 proof cannot be fabricated by a carrier; and
- it cannot arise from one linear publisher history.

False-positive freedom is therefore retained in that exact form: an honest
publisher's states are always comparable and can never be packaged as a valid
proof. F1 does **not** prove which human operated the key, and does not
distinguish intentional equivocation from key compromise — P2 already froze
private-key compromise outside its guarantee, and F1 does not silently upgrade
it.

## 8. Bounded detection (honest limits)

- **Withholding**: a repository that never presents a branch hides the fork. A
  consumer detects equivocation only when it holds both branches as material
  (via observation or transported evidence).
- **First contact**: a fresh consumer querying a single source learns nothing
  about what other sources were shown.
- **Freshness of a single branch**: F1 cannot say a state is stale, only that
  two states contradict.
- **Evidence volume**: ten copies of one proof are exactly as strong as one —
  strength is in the signatures, not the carriers.
- **Legacy pins**: without retained witness material, the local-history proof
  cannot be constructed (P2 fork rejection still applies).

These limits are part of the frozen claim. F1 must never be described as
"detecting equivocation" without the qualifier *whenever two conflicting
publisher-signed states are observed*.

## 9. Frozen invariants (F1)

1. Evidence transport only — a repository can forward a proof, never author a
   valid one.
2. Verification is offline, self-contained, and trust-free with respect to
   carriers.
3. False-positive freedom in the §7 form.
4. No majority, popularity, availability, ordering, or timestamp authority.
5. Detection ≠ prevention; no global freshness; no global log; no reputation.
6. Consumers never auto-select a branch; consequences are local.
7. Existing admitted capabilities are never retroactively rewritten by
   evidence alone.
8. F1 adds exactly two pieces of durable state, both bounded: the **identity
   witness** on pin records (§3.2 — evidence material only) and the local
   **proof record** (§6). No new storage system.
9. F1 adds no authority to F0: `resolve` remains read-only; quarantine
   activates only through the explicit ingest step.
10. `proof_core` bytes and `proof_digest` are invariant under peer order,
    carrier identity, and annotation differences.

## 10. Acceptance topology (later implementation round)

Publisher P with a P2 identity. Repositories R1, R2 (independent), R3 as an
evidence carrier only. Consumer B pinned at state S1 for P. Clean consumer C.

1. **Honest publisher** — P extends its chain (S1 → S2); B resolves across R1,
   R2 → no proof; explicit false-positive check that comparable states never
   produce a core.
2. **Equivocating publisher, multi-source** — sibling states at the same
   sequence; R1 carries branch X, R2 branch Y; B resolves across both → F0
   `CONFLICT` plus a verified core (`SAME_SEQUENCE_DIVERGENT`) that verifies
   with the network off.
3. **Non-extending fork** — divergent branches at different sequences →
   `NONEXTENDING_FORK`; an ancestor branch (extended) never produces a proof.
4. **Local pinned witness** — B pinned at S1, later observes a conflicting S2 →
   proof built from B's retained witness, no peer involved; a legacy pin
   without a witness cannot claim this proof.
5. **Carrier cannot author** — R3 fabricates cores (tampered branch, foreign
   genesis, duplicated branch, wrong relation, non-fork packaged as a fork,
   unknown field in the core) → verification fails offline for each tamper
   independently.
6. **Carrier can only forward** — a core B verified and submitted to R3 comes
   back to C byte-identical, with an identical `proof_digest`, and verifies
   offline at C.
7. **Withholding** — P equivocates but only R1 holds a branch: no conflict, no
   proof, ordinary path proceeds. The limitation is demonstrated, not hidden.
8. **Content conflict vs identity fork** — two repositories carry the same
   authenticated tuple with different D and comparable histories → no F1
   proof; the same D disagreement with non-comparable histories → F1 proof
   still emitted.
9. **Three branches, permuted order** — three mutually conflicting states
   observed in different peer orders → identical canonical pair, identical
   `proof_core` bytes, identical `proof_digest`.
10. **Consumer policy** — with a verified unacknowledged proof: pin
    advancement refused, a fresh P2 import refused with
    `PUBLISHER_EQUIVOCATION_UNACKNOWLEDGED` before any pin mutation,
    previously admitted capabilities untouched and routable; acknowledgment by
    digest resumes work while keeping the evidence and altering neither the
    pin nor the branch selection; a second unacknowledged proof re-quarantines.
11. **Causality** — peer order, carrier identity, and `local_annotation` never
    change `proof_core` bytes, `proof_digest`, or the verdict; a core verified
    on machine A verifies identically on an independent machine B with no
    network.

## 11. Out of scope (explicitly deferred)

- Prevention of equivocation, and detection of single-source lies.
- Any global log, witness network protocol, or consensus over heads.
- Ordering/timestamps of branches, and therefore any "most recent" claim.
- Automatic consequences across machines (broadcast, revocation, blacklist).
- Replication of content (the phase after F1 in the frozen sequence).

## 12. Freeze request

Confirm or amend: (a) `proof_core`/`local_annotation` split, exact core schema,
`proof_digest` formula, and canonical pair selection (§4); (b) the offline
verification rules and the whole-or-nothing discard (§5); (c) the witness rule
on pin records and the legacy-pin honesty clause (§3.2); (d) the quarantine /
acknowledgment state machine with `PUBLISHER_EQUIVOCATION_UNACKNOWLEDGED` and
the distinct ingest step (§6); (e) the §7 precision of the false-positive
claim; (f) the acceptance cases (§10), now including the three-branch permuted
case and the D-conflict-plus-fork case. On freeze, F1 implementation and a raw
receipt follow the F0 pattern: implementation commit first, receipt-only child
commit second.
