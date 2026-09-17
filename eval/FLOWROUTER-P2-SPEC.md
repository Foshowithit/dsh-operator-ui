# FlowRouter P2 — Publisher Identity / Ownership (spec for adjudication; NO CODE)

GPT ruling: cryptographic signatures ARE warranted for P2 (P1 deliberately
left "malicious repository" outside its publisher-authenticity guarantee).
Spec-only until frozen. Invariant, permanently:

> **content integrity ≠ publisher authenticity ≠ local capability trust**

A valid signature never implies a good capability; a locally trusted
capability never implies a verified real-world person; a correct package
digest never implies authorship.

## 1. Publisher identity (durable, self-certifying, machine-independent)

Machine nicknames (`mac-a`) disappear as security identities.

- **Key material**: Ed25519, one algorithm, no negotiation. Public keys:
  32-byte raw, base64url. Signatures: 64-byte, base64url. Canonical
  serialization: the P0 canonical JSON (sorted keys, no whitespace).
- **publisher_id** = lowercase hex of
  `SHA256("flowrouter.p2.publisher-id.v1" || genesis_public_key_raw)` first
  20 bytes. Deterministic, self-certifying: no central slug authority.
  (This adapts the P1 token grammar to `^[0-9a-f]{40}$` — explicitly, as
  the one grammar change; the old nickname grammar is retired for protocol
  identity.)
- **Display names** (`optimized-workflow`, `operator`, …) are METADATA carried
  outside protocol identity; no protocol decision may depend on them.
- Identity survives machine changes and key rotation because it is derived
  from the genesis key, never from configuration.

## 2. Genesis record (immutable, self-signed, proof of possession)

```
record_type      "flowrouter.publisher.genesis.v1"
protocol         "p2"
publisher_id     <derived from genesis_public_key as in §1>
genesis_key      { alg: "ed25519", key: <base64url> }
display_name     <optional metadata>
created_at       <ISO date — metadata>
self_signature   Ed25519(domain "flowrouter.p2.genesis" || canonical(record minus self_signature))
```

Verification (B, independently): derivation(publisher_id) matches the key
AND the self-signature verifies under that key. Possession is proven by
the self-signature; nothing else in P2 asserts possession.

## 3. Publication-key authorization (root authority ≠ routine keys)

The genesis key does NOT sign every publication. Identity authority
authorizes publication keys via append-only records:

```
record_type         "flowrouter.publisher.key-auth.v1"
publisher_id        <same>
authorized_key      { alg: "ed25519", key: <base64url> }
key_id              hex(SHA256("flowrouter.p2.key-id.v1" || key_raw))[0:32]
permissions         ["publish"]        // EXACTLY: sign publication statements for this publisher_id only
sequence            1, 2, 3 …           // monotonic per publisher identity
prev_record_digest  digest of the previous identity record (genesis or key-auth); null only for the first
issued_at           <ISO>
signature           Ed25519 by the genesis key OR a currently-authorized identity-authority key,
                    domain "flowrouter.p2.key-auth"
```

**What an authorized key may sign**: publication statements (§4) for its
own `publisher_id` — nothing else. It cannot authorize further keys, cannot
sign genesis records, cannot sign rotations, cannot act for other
publishers. Identity-authority signatures remain with the genesis key (or
keys it has explicitly authorized with `permissions: ["identity"]`).

## 4. Publication assertion (detached; D is untouched)

Signatures NEVER enter the package or the P0 digest. `D` remains exactly
the frozen P0 package digest.

```
statement_type  "flowrouter.publication.v1"
publisher_id    <derived identity>
name            <P1 canonical token>
version         <P1 canonical version>
D               <P0 package digest>
key_id          <authorized publication key>
issued_at       <ISO>
signature       Ed25519 by the authorized key,
                domain "flowrouter.p2.publication"
```

Canonical signed message (domain separation, frozen):
`"flowrouter.p2.publication\n" + canonicalJson(statement minus signature)`.
Distinct domain strings per record type make a signature unusable in any
other protocol context (replay across types/domains is a verification
failure).

## 5. Repository (R) behavior

- R may store bytes for any package. The **authenticated binding**
  `publisher_id/name@version → D` may be published ONLY after the
  publication assertion verifies under a key authorized by that publisher
  identity (genesis self-check + key-auth chain + assertion, §1–§4).
- A valid package with no valid assertion is stored and served with
  `publisher_auth: UNAUTHENTICATED`. It is never labeled authenticated.
- Discovery/fetch responses carry the VERIFICATION MATERIAL — genesis
  record, the key-auth chain, the publication assertion (canonical bytes)
  — not just a verdict string.
- R's own verdict (`publisher_auth: VERIFIED`) is **evidence, not proof**.

## 6. Consumer (B) behavior

- B verifies INDEPENDENTLY from the carried material: genesis
  self-signature + derivation, each key-auth record's signature and
  sequence continuity, then the publication assertion against the
  authorized key. Result recorded as **remote provenance**.
- **Zero eligibility authority**: there is no code path where
  `publisher_auth: VERIFIED` (or any signature result) promotes, admits,
  routes, or SHIPs anything. The authenticated publication proceeds
  through the unchanged chain: P0 integrity → compatibility/collision →
  B-local verification → operator admission.

## 7. Rotation, rollback, and the honest limits of revocation

- **Rotation**: a publisher authorizes a successor publication key with a
  new key-auth record: `sequence = prev + 1`, `prev_record_digest` = prior
  record's digest, signed by a currently-authorized identity-authority key.
  `publisher_id` never changes.
- **Rollback rule (what consumers enforce)**: each consumer pins the
  highest `sequence` state it has observed per publisher. A served state
  with `sequence` lower than the pinned state is refused
  (`SEQUENCE_ROLLBACK`), regardless of internal validity.
- **Fresh-consumer rule**: a consumer with no pinned state authenticates
  the full chain back to genesis and accepts it as a first observation.
- **Explicitly NOT guaranteed (P2)**: global freshness and equivocation
  detection. A malicious repository can serve a stale-but-once-valid
  identity/key state to a FRESH consumer; P2 requires that this state be
  LABELED within these limits, never claimed as globally fresh. A
  transparency/gossip layer is future work.
- **Private-key compromise is outside the guarantee**: signatures made
  with a stolen authorized key are cryptographically authentic until a
  rotation can exclude the key for consumers who have pinned past it. The
  spec states this; P2 does not solve key compromise.

## 8. Failure vocabulary (all fail-closed)

`IDENTITY_DERIVATION_MISMATCH` · `IDENTITY_RECORD_INVALID` ·
`KEY_NOT_AUTHORIZED` · `SIGNED_STATEMENT_MISMATCH` ·
`SEQUENCE_ROLLBACK` · `ALGORITHM_UNSUPPORTED` · `PUBLISHER_AUTH_INVALID` ·
status value `UNAUTHENTICATED` (not an error — a truthful label).

## 9. P1 compatibility (explicit)

Unsigned legacy P1 publications remain REPRESENTABLE and serveable as
`publisher_auth: UNAUTHENTICATED`. They are never treated as authenticated
and never upgraded implicitly. The P1 conflict rule (same
`package_ref` + different D → PUBLISH_CONFLICT) is unchanged.

## 10. Acceptance experiment (P2 receipt — for after the freeze)

Actors: publisher P (genesis → authorized publication key), repository R,
clean consumer B. Positive: P creates identity → authorizes publication key
→ signs the exact package_ref/D → R verifies before accepting the
authenticated binding → B discovers, INDEPENDENTLY verifies chain +
assertion from carried material → P0 stage → B-local verify → operator
admission → route → SHIP.

Adversarial (all must fail closed):
1. one byte / digest change after signing → content-vs-auth binding fails;
2. valid D but different name/version than signed → assertion fails for
   the requested publication;
3. valid attacker package + victim publisher claim → publisher-auth fails
   (victim never signed that statement) — the decisive repo-substitution
   negative;
4. victim identity key replaced → derivation/chain failure;
5. unauthorized signing key → KEY_NOT_AUTHORIZED;
6. old publication key after a locally pinned rotation state → refusal
   (SEQUENCE_ROLLBACK per the frozen rules);
7. stale identity state to a fresh B → accepted as first observation AND
   labeled within the §7 limitation (never claimed globally fresh);
8. authenticated discovery/fetch alone leaves B's registry untouched;
9. authenticated publication still cannot bypass local verification or
   admission.

## 11. Out of scope for P2

Marketplace, reputation, ratings, recommendations, WebPKI/legal identity
binding, payments, global transparency log/gossip, algorithm negotiation,
revocation beyond §7, real-world identity claims ("this is OpenAI",
"this is operator") — cryptographic identity proves CONTROL of the protocol
key chain, nothing social or legal.

## 12. What does NOT change

The P0 package digest and the P0/P1 trust path; the P1 protocol surface
(§9 compatibility); the acquisition/eligibility chain at B. P2 adds
authentication as provenance, never as authority.
