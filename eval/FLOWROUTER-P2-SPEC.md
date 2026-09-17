# FlowRouter P2 — Publisher Identity / Ownership — SPEC v2 (amended per the rubric)

v1 (e1b5c73) was REFUSED with four protocol holes. This v2 incorporates
every amendment; spec-only until P2-SPEC-FROZEN. Invariant, permanently:

> **content integrity ≠ publisher authenticity ≠ local capability trust**

## 0. Change log vs v1

- **Explicit key-state event chain** replaces the vague key-auth chain
  (§3): append-only AUTHORIZE/REVOKE events, replay → active
  publication-key set; the genesis key signs ALL key-state events (no
  delegated identity authority in P2 — the v1 inconsistency removed).
- **Fork-resistant pinning** (§6): consumers pin
  `{publisher_id, highest_sequence, head_record_digest}`; same-sequence or
  alternate-branch histories are `IDENTITY_HISTORY_FORK`, not rollbacks.
- **Publications bound to a precise identity state** (§4):
  `identity_sequence` + `identity_head_digest` inside every signed
  assertion.
- **Cryptographic bytes frozen** (§2): RFC 8785 JCS canonicalization,
  exact per-record signed-byte rules, chain record digests, FULL-LENGTH
  ids (no truncation), unpadded canonical base64url only.
- **Namespace separation** (§7): `publisher_scheme` distinguishes
  `p1-configured-v1` from `p2-selfcert-v1`; no silent downgrade of P2
  publications.
- **Provenance presentation** (§8): `publisher_auth` and `freshness` are
  separate, unambiguous labels.

## 1. Identity

- **Algorithm**: Ed25519 only. Public keys 32-byte raw, signatures 64-byte,
  both as UNPADDED canonical base64url; any alternate encoding is rejected
  (`ALGORITHM_UNSUPPORTED` / `ENCODING_INVALID`). No negotiation.
- **publisher_id** = lowercase hex of the FULL
  `SHA256("flowrouter.p2.publisher-id.v1" || genesis_ed25519_public_key_raw)`
  → 64 hex chars. Self-certifying; no slug authority; survives machine
  changes and rotation.
- **key_id** = lowercase hex of the FULL
  `SHA256("flowrouter.p2.key-id.v1" || ed25519_public_key_raw)` → 64 hex.
- Display names remain metadata; no protocol decision may depend on them.

## 2. Canonical bytes (frozen — this is a signature protocol)

- **Serialization**: UTF-8 **RFC 8785 JCS** for every signed/ digested
  structure (sorted keys, JCS string escaping, JCS number rules — not
  "sorted keys, no whitespace").
- **Signed-bytes rules (exact, per record type)**:

```
genesis      UTF8("flowrouter.p2.genesis\n")     || JCS(genesis minus self_signature)
key-event    UTF8("flowrouter.p2.key-event\n")   || JCS(event minus signature)
publication  UTF8("flowrouter.p2.publication\n") || JCS(statement minus signature)
```

- **Chain digest**:

```
record_digest = SHA256( UTF8("flowrouter.p2.record-digest.v1\n") || JCS(full signed record) )
```

- The P0 package digest and its (separate) canonicalization are UNTOUCHED.

## 3. Identity state: the key-state event chain

```
record_type         "flowrouter.p2.key-event.v1"
publisher_id        <derived>
sequence            1, 2, 3 …                       (strictly monotonic, contiguous from 1)
prev_record_digest  digest of the PREVIOUS chain record (the genesis record for sequence 1 — never null)
action              "AUTHORIZE" | "REVOKE"
key_id              <derived key id>
public_key          <present iff AUTHORIZE>
permissions         ["publish"]                     (AUTHORIZE only)
issued_at           <ISO>
signature           Ed25519 by the GENESIS key, domain "flowrouter.p2.key-event"
```

- Deterministic replay of `[genesis, key-event 1..n]` produces the ACTIVE
  publication-key set. Rotation is explicit and revoking:

```
seq 4  AUTHORIZE  K2 [publish]
seq 5  REVOKE     K1 [publish]      → after seq 5, K1 is NOT authorized
```

- Genesis self-signature over the §2 rule proves possession; every chain
  record is signed by the genesis key (P2 has no delegated identity
  authority; that is future work if ever needed).

## 4. Publication assertion (detached; D untouched; bound to identity state)

```
statement_type        "flowrouter.p2.publication.v1"
publisher_scheme      "p2-selfcert-v1"
publisher_id          <derived>
name / version        <P1 canonical tokens>
D                     <P0 package digest>
key_id                <authorized publication key>
identity_sequence     <chain sequence whose active set includes key_id>
identity_head_digest  <record_digest of the chain head at that sequence>
issued_at             <ISO>
signature             Ed25519 by the publication key, domain "flowrouter.p2.publication"
```

Verification by any party: at state `(identity_sequence, identity_head_digest)`
(replayed from the carried chain), `key_id` must be in the ACTIVE
publication set, and the signature must verify under that key.

Precise old-key semantics:

- old K1 assertion bound to a PRE-rotation state, presented to a consumer
  that already pinned a newer state → `SEQUENCE_ROLLBACK`;
- K1 assertion CLAIMING the newer state (where K1 is revoked) →
  `KEY_NOT_AUTHORIZED`;
- a fresh consumer receiving the genuinely old state CAN authenticate the
  chain — freshness remains explicitly unproven (§6, §8).

## 5. Repository (R) behavior

- R may retain any raw blob. The P2 publication BINDING
  (`p2-selfcert-v1 + publisher_id + name + version → D`) is created only
  after: genesis self-check + chain replay + assertion verification at the
  asserted identity state.
- **No silent downgrade**: a p2-selfcert publication with missing/invalid
  publisher proof FAILS — R does not create a P2 binding for it (the raw
  blob may exist; it is not a publication).
- R carries the full verification material (genesis record, key-event
  chain bytes, publication assertion) in discovery/fetch responses; its
  own verdict is evidence, not proof.

## 6. Consumer (B) verification, pinning, forks

- B replays the carried chain, verifies derivation + genesis
  self-signature + every event signature + sequence contiguity +
  `prev_record_digest` links, then the assertion at its asserted state.
- **Pin**: B stores `{publisher_id, highest_sequence, head_record_digest}`.
  Enforcement on every served state:
  - served sequence < pinned → `SEQUENCE_ROLLBACK`;
  - same sequence + different head digest → `IDENTITY_HISTORY_FORK`;
  - greater sequence that does NOT extend the exact pinned head →
    `IDENTITY_HISTORY_FORK`;
  - greater sequence extending the pinned head → accept; then update
    the pin — **only after successful cryptographic verification**.
- Global equivocation (two fresh consumers, two internally valid
  histories) remains unsolved in P2 — deferred to a future
  transparency/gossip layer, and stated as such.
- **Zero eligibility authority**: no code path where any
  `publisher_auth` result promotes, admits, routes, or SHIPs anything.
  The chain remains: P0 integrity → compatibility/collision → B-local
  verification → operator admission.

## 7. Namespace separation (P1 legacy vs P2 authenticated)

- `publisher_scheme` ∈ {`"p1-configured-v1"`, `"p2-selfcert-v1"`}.
  Effective publication identity is
  `publisher_scheme + publisher_id + name + version`.
- The P1 conflict rule (same ref + different D → `PUBLISH_CONFLICT`) is
  unchanged WITHIN a scheme; schemes cannot collide with each other,
  closing the unsigned-first-writer occupancy hole.
- `p1-configured-v1` publications remain, truthfully labeled
  `publisher_auth = UNAUTHENTICATED`; never implicitly upgraded.
- `p2-selfcert-v1` publications require valid proof (§5) or they are not
  publications at all.

## 8. Provenance presentation (unambiguous labels)

```
publisher_auth = VERIFIED | UNAUTHENTICATED | INVALID
freshness      = FIRST_OBSERVATION_UNPROVEN | EXTENDS_LOCAL_PIN
```

Neither label means "globally current". `publisher_auth` reports
cryptographic validity only; `freshness` reports only the relationship to
this consumer's pin.

## 9. Honest limits (restated)

Private-key compromise is outside the guarantee (stolen-key signatures are
authentic until excluded by a rotation consumers have pinned past). P2 does
not solve global freshness, equivocation detection, WebPKI/legal identity,
or real-world identity claims.

## 10. Failure vocabulary (all fail-closed)

`IDENTITY_DERIVATION_MISMATCH` · `IDENTITY_RECORD_INVALID` ·
`KEY_NOT_AUTHORIZED` · `SIGNED_STATEMENT_MISMATCH` · `SEQUENCE_ROLLBACK` ·
`IDENTITY_HISTORY_FORK` · `ALGORITHM_UNSUPPORTED` · `ENCODING_INVALID` ·
`PUBLISHER_AUTH_INVALID` · status label `UNAUTHENTICATED`.

## 11. Acceptance experiment (for after the freeze)

Actors: publisher P (genesis → publication key K1 → rotation to K2),
repository R, clean consumer B.

Positive: P genesis → AUTHORIZE K1 → sign exact package_ref/D at the K1
identity state → R verifies → B independently replays the chain and
verifies the assertion → P0 stage → B-local verify → operator admit →
route → SHIP; freshness reads `FIRST_OBSERVATION_UNPROVEN` on B's first
observation.

Adversarial (all fail closed):
1. one byte / digest change after signing → `SIGNED_STATEMENT_MISMATCH`;
2. valid D but different name/version than signed → assertion mismatch;
3. valid attacker package + victim publisher claim → verification fails
   (the decisive repository-substitution negative);
4. victim identity key replaced → `IDENTITY_DERIVATION_MISMATCH`;
5. unauthorized signing key → `KEY_NOT_AUTHORIZED`;
6. **rotation, split into two**: (a) old chain below B's pinned state →
   `SEQUENCE_ROLLBACK`; (b) old/revoked K1 attempting to sign at the
   CURRENT state → `KEY_NOT_AUTHORIZED`;
7. **alternate history**: same-sequence different-head OR
   higher-sequence on another branch → `IDENTITY_HISTORY_FORK`;
8. stale identity state to a fresh consumer → accepted as first
   observation with freshness `FIRST_OBSERVATION_UNPROVEN` (never claimed
   globally fresh);
9. authenticated discovery/fetch alone leaves B's registry untouched;
10. authenticated publication still cannot bypass local verification or
    admission.

## 12. Out of scope (unchanged)

Marketplace, reputation, ratings, recommendations, WebPKI/legal identity,
payments, transparency log/gossip, algorithm negotiation, delegated
identity authority, revocation beyond §6. No real-world identity claims.
