# FlowRouter P1 — Network Protocol Spec (for adjudication; NO implementation)

Per GPT's ruling (P0 sealed at 65d708e): freeze publish/index/discover/fetch
semantics and the P1 acceptance matrix before any code. The network's only
job is transport: it has **zero authority to make anything routable**.

```
PUBLISH → immutable package blob
INDEX   → metadata / evidence summary (derived)
DISCOVER→ candidate packages (evidence, not rankings)
FETCH   → exact package bytes
──────────── TRUST BOUNDARY (unchanged P0) ────────────
STAGE → integrity/compatibility/collision → LOCAL VERIFY → operator admission → ELIGIBLE
```

## 1. Core objects

**Package blob** — the P0 canonical package (capability.json + workflows/
+ evidence refs), content-addressed. Package digest `D` per the frozen P0
rule (OCI-like: SHA256 over the ordered [relpath, byte-length,
SHA256(bytes)] list, capability.json canonicalized with the digest fields
omitted). `D` is the network's only identifier of truth for bytes.

**Publication record** — the immutable binding
`identity (publisher/name@version) → D`. Written once; never mutated.

**Index entry** — derived metadata for discovery:
`{ identity, version, D, kind, task_signatures, compatibility,
publisher, evidence_summary (source-reported), published_at }`.
An index entry is a CACHE of a publication record, never authority.

**Discovery query** — filters over index fields only: identity
(prefix/exact), version (exact; no ranges in P1), kind, task_signatures
(token match), compatibility (declared list intersects query), publisher,
presence of evidence. Deterministic ordering: identity ascending. No
ranking, no score, no popularity.

## 2. Invariants (frozen — each must be testable)

| # | invariant | mechanism |
|---|---|---|
| I1 | **Publish is content-addressed and immutable.** Same identity@version + different digest = `PUBLISH_CONFLICT` (refusal), never overwrite. | publication records are append-only; conflict = compare existing D vs incoming D |
| I2 | **Fetch is digest-bound.** Discovery answers with identity/version/D; fetch returns bytes; the CLIENT recomputes D over the received bytes and refuses on mismatch (`FETCH_DIGEST_MISMATCH`) — P0 then recomputes again at stage. | fetch API takes D as a required parameter; never "latest" |
| I3 | **Index is derived, not authority.** Deleting/rebuilding the index must not alter any package; stale or forged index metadata must never change package truth or bypass P0. | index is rebuildable from publication records; stage/verify read only fetched bytes |
| I4 | **Discovery returns evidence, not rankings.** Only the fields in §1 are queryable; ordering is deterministic (identity asc); no score field exists anywhere in the protocol. | schema-level: no `score`/`rank`/`downloads` fields |
| I5 | **Remote evidence stays reported evidence.** Source lifecycle, source evaluations, counts — all cross as reported provenance; local eligibility is produced ONLY by P0 stage → local verify → operator admission. | nothing in the network response is read by eligibility code paths |
| I6 | **Integrity ≠ publisher authenticity.** Content addressing proves bytes-are-what-D-says; it proves nothing about WHO published. P1 uses configured publisher IDs; the protocol reserves (does not implement) a future signature/ownership layer. No signature claims in P1. | no signing; a `publisher_auth` field is RESERVED in the schema, absent in P1 |

## 3. Interface (minimal, transport-agnostic)

The P1 receipt uses a local HTTP service `R` (the smallest possible
network); the spec is transport-agnostic so the same verbs can sit behind
any transport later.

```
POST /publish    body: package bytes (multipart/tar or dir→bytes)
                 → { identity, version, D } | 409 PUBLISH_CONFLICT
GET  /package/:identity/:version
                 → { D, blob_ref }            (discovery by exact identity)
GET  /discover?identity=&version=&kind=&tag=&publisher=&has_evidence=
                 → { results: [index entries], order: identity asc }
GET  /fetch/:D   → exact package bytes | 404 FETCH_UNAVAILABLE
```

Notes:
- `/fetch` NEVER accepts identity — only D (I2).
- `/discover` results always carry D; the client fetches by D.
- `R` keeps: publication records (immutable), package blobs, a derived
  index (rebuildable). No auth in P1 (configured publisher IDs only, I6).

## 4. Failure vocabulary (all fail-closed, tested in the receipt)

`PUBLISH_CONFLICT` · `FETCH_DIGEST_MISMATCH` · `FETCH_UNAVAILABLE` ·
`INDEX_METADATA_STALE` (index disagrees with publication record — index
serves the record's truth or reports staleness; it never invents) ·
`PUBLISH_INVALID` (bytes not a canonical package / D mismatch at publish).

## 5. P1 acceptance matrix (the killer receipt)

Nodes: publisher **A** (owns promoted `csv-running-total`, P0-proven),
service **R**, clean consumer **B** (fresh home, empty registry).

**Positive chain**
1. A exports (P0) → publishes to R → publication `mac-a/csv-running-total@0.1.0 → D`.
2. R indexes; `DISCOVER identity=mac-a/csv-running-total` returns the
   entry with D + evidence summary.
3. B (knowing nothing) discovers → fetches by D → bytes hash to D →
   P0 stage (STAGED/INELIGIBLE) → B-local verification (frozen B-authored
   fixture) → operator admission → normal route → authority gate →
   execute → objective SHIP.

**Fail-closed network behaviors (same receipt)**
- N1 **Republish conflict**: A publishes identity@version with altered
  bytes → `PUBLISH_CONFLICT`; original D unchanged; B re-fetch still
  returns the original bytes.
- N2 **Corrupt fetch**: fetched bytes externally altered → client digest
  check fails (`FETCH_DIGEST_MISMATCH`) → P0 never stages them.
- N3 **Stale/forged index metadata**: R's index entry for the identity is
  edited (e.g. D swapped to another digest) → fetch by the edited D either
  404s or returns bytes that fail the digest recomputation; the ORIGINAL
  package flow is unaffected; nothing bypasses P0.
- N4 **Unavailable blob**: delete the blob for D → fetch returns
  `FETCH_UNAVAILABLE` (honest failure); no substitution of another
  version, no silent fallback.
- N5 **Discovery is inert**: B runs discovery (and only discovery) →
  B's registry and task store remain unchanged (no implicit install).
- N6 **Exact versions**: A publishes 0.1.1 (a genuinely different package)
  alongside 0.1.0 → exact-version fetch of each returns exactly the
  requested digest; no "latest" resolution exists in P1.

**Recorded limitation carried from P0**: the receipt runs A, R, B on one
machine with one executor; independent-machine repetition is required
before any cross-machine claim (per the sealed ruling). The claim P1
establishes is protocol-level: transport, immutability, digest binding,
index non-authority, and zero authority at the network layer.

## 6. Explicitly out of scope for P1 (per the sealed ruling)

Marketplace, ratings, leaderboards, payments, "best capability",
recommendations, global promoted state, automatic install, generalized
adapter ecosystems, signatures/ownership (reserved schema room only),
"latest" resolution.
