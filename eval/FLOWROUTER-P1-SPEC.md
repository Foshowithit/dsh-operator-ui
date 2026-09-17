# FlowRouter P1 — Network Protocol Spec v2 (amended per the pre-committed rubric)

v1 (cd2eb69) was REFUSED with a 12-criterion rubric: 8 amendments required.
This v2 incorporates every clause verbatim-in-substance. Spec-only; no code
until this freezes.

## 0. Change log vs v1

- **Identity vocabulary frozen** (§1): `publisher_id` / `name` / `version` as
  three components; `identity = publisher_id/name`; `package_ref =
  publisher_id/name@version`. Canonical lowercase ASCII; **reject**
  noncanonical input, never normalize. Route exposes components:
  `/publication/:publisher/:name/:version`.
- **Publication made transactional in the safe direction** (§2): R
  recomputes the frozen P0 digest itself; blob-first, binding-second;
  same-D idempotent; published_at created once in the record.
- **Publication records AUTHORITATIVE at discovery** (§3, the material
  hole): an index binding is validated against the immutable record before
  it is ever returned; forged/stale index metadata can never serve a
  substituted (even valid) digest as package truth.
- **N3 strengthened** to a valid-object substitution test (§7).
- **Fetch semantics clarified** (§4): D is the P0 package digest — never a
  raw-body SHA; the expected tuple is retained through retrieval; in-package
  identity must agree with it.
- **Threat model frozen** (§6): explicit protected / not-protected lists.
- **Failure vocabulary expanded** (§5): + PACKAGE_MALFORMED,
  IDENTITY_VERSION_MISMATCH, NETWORK_FAILURE / SERVICE_UNAVAILABLE.
- **Receipt isolation/nonmutation strengthened** (§8): separate actor
  stores, HTTP-only A/R→B transport, registry provably unchanged after
  discover / fetch / stage.
- **N6 phrasing** per the ruling (§7).
- `tags` added to the index-entry schema (§1).
- Positive path unchanged; the B-local verification fixture is frozen and
  hashed before execution (P0 discipline).
- One-machine/one-executor disclosure accepted; it supports a protocol-level
  claim only.

## 1. Objects and vocabulary (frozen)

**Canonical tokens.** `publisher_id`, `name`: `^[a-z0-9][a-z0-9-]{0,63}$`.
`version`: canonical exact version string `^\d+\.\d+\.\d+$` (P1 semantics:
exact string identity; no ranges, no ordering claims, no `latest`).
Noncanonical input (uppercase, whitespace, URL-escapes, aliases) is
**rejected** (`IDENTITY_NONCANONICAL`), never normalized.

- `identity` = `publisher_id/name`
- `package_ref` = `publisher_id/name@version`
- **Package blob**: the P0 canonical package; its content identity `D` is
  the **frozen P0 package digest** (OCI-like rule; capability.json
  canonicalized with digest fields omitted). D is the only byte-truth.
- **Publication record** (immutable, append-once): `{package_ref, D,
  published_at}`. Never mutated.
- **Index entry** (derived, rebuildable cache): `{publisher_id, name,
  version, D, kind, task_signatures, tags, compatibility, publisher,
  evidence_summary (source-reported), published_at}`. `tags` is present
  because `tag=` is a discovery filter.
- **Discovery query**: identity (publisher/name), version (exact), kind,
  task_signatures (token), tags (token), compatibility (intersection),
  presence of evidence. Deterministic ordering: publisher_id asc, then
  name asc, then version asc. No score/rank/downloads field exists.

## 2. Publish (transactional, safe direction)

1. R receives bytes; R **recomputes the frozen P0 digest itself** → D.
   Recompute failure → `PACKAGE_MALFORMED`.
2. Identity/version inside the package (if present) must equal the
   requested `package_ref` → else `IDENTITY_VERSION_MISMATCH`.
3. If `package_ref` unbound: **store blob D first**, then commit the
   binding `package_ref → D`. A crash may leave an orphan blob; it MUST
   never leave a committed binding to absent bytes.
4. Existing binding to the SAME D: **idempotent success** (no new
   published_at).
5. Existing binding to a DIFFERENT D: `PUBLISH_CONFLICT` — never overwrite.
6. `published_at` is created once, in the immutable record. Index rebuilds
   COPY it; they never invent a timestamp.

## 3. Discovery (records authoritative over the index)

The index is search/candidate metadata only. Before R returns any
`{publisher_id, name, version, D}` as a discovery result, the binding is
**validated against the immutable publication record**:

- `D_index === D_publication` → return the entry.
- `D_index !== D_publication` → R either repairs the entry from the record
  and returns record truth, or reports `INDEX_METADATA_STALE`. It may
  **never** return the forged binding as package truth.
- No publication record at all → the entry is returned only flagged
  `INDEX_METADATA_STALE` (or omitted); it is never promoted to truth.

## 4. Fetch (digest-bound; D is the P0 digest)

`GET /fetch/:D` returns the stored package artifact whose **P0 canonical
digest recomputation equals D**. D is never a raw HTTP-body hash. The
client (B) retains the expected `{publisher_id, name, version, D}` tuple
through retrieval; where the package itself carries identity/version
fields, they MUST agree with the expected tuple or the client fails closed
(`IDENTITY_VERSION_MISMATCH`). Fetch takes D only — never identity, never
`latest`.

## 5. Failure vocabulary (all fail-closed; no substitution, ever)

`PUBLISH_CONFLICT` · `PUBLISH_INVALID` (API umbrella; the log records the
actual reason) · `PACKAGE_MALFORMED` · `IDENTITY_NONCANONICAL` ·
`IDENTITY_VERSION_MISMATCH` · `FETCH_DIGEST_MISMATCH` ·
`FETCH_UNAVAILABLE` · `INDEX_METADATA_STALE` · `NETWORK_FAILURE` ·
`SERVICE_UNAVAILABLE`.

No error path may substitute another version or another digest.

## 6. Threat model (frozen — protected vs not)

**P1 protects:** post-discovery byte substitution (digest binding),
transport corruption (client recomputation), immutable-version overwrite
(PUBLISH_CONFLICT), stale/forged derived index metadata
(records-authoritative discovery), missing blobs (honest
FETCH_UNAVAILABLE), accidental version replay once an exact binding is
known (exact-version addressing, no `latest`).

**P1 does NOT establish:** authenticated publisher ownership; defense
against an attacker who can rewrite the immutable publication-record store
itself; any claim that a configured `publisher_id` corresponds to an
external person/entity. No auth, signatures, ownership, confidentiality,
or Byzantine-repository claim exists in P1. First-write namespace
squatting/impersonation is consequently **outside** the P1 guarantee.
A `publisher_auth` field is RESERVED in the schema and ABSENT in P1.

## 7. Interface (transport-agnostic; R = smallest local HTTP service)

```
POST /publish                                bytes → {publisher_id, name, version, D} | 409/400 per §5
GET  /publication/:publisher/:name/:version  → {publisher_id, name, version, D} (validated per §3)
GET  /discover?publisher=&name=&version=&kind=&tag=&task_signature=&has_evidence=
                                             → {results:[index entries], order: publisher,name,version asc}
GET  /fetch/:D                               → exact package artifact | 404 FETCH_UNAVAILABLE
```

## 8. P1 acceptance matrix (final)

Actors use **separate stores/homes**; B obtains the remote artifact **only**
through the P1 service interface (never by reading A's export directory or
R's blob directory). Even on one machine: separate actor stores and
HTTP-only A/R→B transport are required.

**Positive chain**
1. A exports (P0) → publishes → publication `mac-a/csv-running-total@0.1.0 → D0`
   (R recomputed D0 itself).
2. Discovery (`publisher=mac-a, name=csv-running-total`) returns the entry
   with D0 + source-reported evidence summary, validated against the record.
3. B — knowing nothing — discovers → fetches by D0 → B recomputes D0 →
   P0 stage (STAGED/INELIGIBLE) → B-local verification against a fixture
   **frozen and hashed before execution** → operator admission → normal
   route → authority gate → execute → objective SHIP.

**Fail-closed behaviors in the same receipt**
- **N1 republish conflict**: same `package_ref` + altered bytes →
  `PUBLISH_CONFLICT`; record and D0 unchanged; B re-fetch returns the
  original artifact.
- **N2 corrupt fetch**: fetched bytes altered in transit store → B's
  recomputation fails (`FETCH_DIGEST_MISMATCH`) → never staged.
- **N3 valid-object substitution (the decisive one)**: publish a second
  real package (D_other, a genuinely different artifact). Corrupt R's
  index for `csv-running-total@0.1.0` to point at D_other. D_other fetches
  perfectly — neither 404 nor digest mismatch can help. Required result:
  discovery validates against the immutable publication binding and either
  returns D0 (record truth) or reports `INDEX_METADATA_STALE`; B never
  treats D_other as the digest for 0.1.0. (The nonexistent-D corruption
  test is kept as a lesser companion case.)
- **N4 unavailable blob**: remove D0's blob → `FETCH_UNAVAILABLE`, honest
  failure, no substitution.
- **N5 discovery is inert (strengthened)**: record B's registry + task
  store before discovery and prove them **unchanged after discovery, after
  fetch, and after P0 stage**; only the explicit admission click mutates
  the registry. (Staging artifacts may exist after stage — capability
  registry/routing state may not change.)
- **N6 exact-version semantics (rephrased per ruling)**: resolve/discover
  exact 0.1.0 → D0 → fetch(D0) → P0 digest D0; resolve/discover exact
  0.1.1 → D1 → fetch(D1) → P0 digest D1; D0 ≠ D1, both immutable, and no
  `latest` operation exists.

**Recorded limitation**: one machine / one executor; supports a
protocol-level claim only — not independent-machine execution.

## 9. Out of scope (unchanged)

Marketplace, ratings, leaderboards, payments, best-capability,
recommendations, global promoted state, automatic install, generalized
adapters, signatures/ownership (reserved room only), `latest`.
