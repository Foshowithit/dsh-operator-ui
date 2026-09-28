# Candidate: bounded-research (from liustack/modsearch)

- Entry: `dshfind-api:liustack/modsearch` (MIT, stars 566, fresh 2026-09-28).
- User outcome: research with citations — query in, cited passages out.
- Proposed contract: inputs (query ≤280 chars, scope allowlist, result cap),
  outputs (passages with source URL + fetched date), evidence (fetched URLs,
  byte digests, query record), refusal cases (empty query, scope outside
  allowlist, fetch failure, no citable passages).
- Why not native reuse: models without native web access have no built-in
  search bridge; this is the K4 lead candidate on daily-use value and setup
  burden (free, no signup per upstream description — to be verified, not assumed).
- Binding: pending B2 (archon-workflow is the only supported binding today).
- Prerequisites: network egress allowlist entry, citation format contract.
- Status: proposal. No code copied; no install, runtime, or compatibility claim.
