# K1b — Full licensed awesome catalog snapshot

This is one source-inventory slice from the [ecosystem/Desktop plan](2026-09-28-ecosystem-capabilities-desktop-polish.md).

## Task 1: Freeze and normalize the permitted awesome feed

The current K1 inventory is a 13-row starter sample. The captured
`https://awesome-dsh-plugin.com/plugins.json` payload is 5,267,051 bytes with
4,382 rows and SHA-256
`80c4bc9efbeb9a894aca4ccfc89391275449ff9b4b3b0cafaf45f4b145f218c5`;
its filesystem observation time is `2026-09-28T21:37:28Z`. Its `source` field
names `awesome-dsh-plugin/awesome-dsh-plugin`. At repository commit
`4c4167fa0dc992395f8d9c56cfb27e1f812ddb33`, the repository declares CC0-1.0
and contains 4,382 `data/plugins/` YAML records. Record the export digest and
repository/license context separately; the site export itself has no schema
version or stable record ID.

**Owner/files:** Luna implementer owns
`scripts/plugin-inventory.mjs`, `test/plugin-inventory.test.mjs`,
`docs/ecosystem/sources.json`, `docs/ecosystem/inventory.json`,
`docs/ecosystem/README.md`, and `docs/ecosystem/snapshots/`. The integrator owns
`docs/AGENT-QUEUE.md` and both plan files.

**Depends on:** B1a's permitted-source/license boundary and the existing K1
normalizer contract.

- [ ] Preserve the exact licensed static export as a deterministic compressed
  snapshot. Record the raw-byte digest, observed time, row count, endpoint,
  repository/license context, and attribution. Normalizer/runtime code performs
  no network fetch.
- [ ] Add a snapshot-only normalization path while keeping the generic operator
  acquisition limit at 100 listings. Validate digest, declared count, row
  identities and output counts. Retain duplicate or malformed rows as visible
  conflicts instead of merging by display name.
- [ ] Project only inert listing identity fields. Do not treat feed
  `capabilities`, verification timestamps, install commands, compatibility
  claims or download/star values as host evidence, permissions or task
  capability bindings. Per-repository code licenses remain unknown.
- [ ] Tests prove the full snapshot normalizes to 4,382 catalog rows, identity
  collisions remain distinct and visible, metadata claims stay inert, changed
  digest/count fails closed, and ordinary operator batches still cap at 100.
- [ ] Expand collection coverage for `awesome-curated` only. Keep dshfind
  link-only until catalog-data rights are resolved and dshmarket in the same
  catalog lineage. Existing K2 dispositions cover the 13-row sample only; the
  remaining entries await disjoint batches of at most 25.

**Done:** the permitted export is represented by one digest-bound offline
snapshot; collection coverage remains separate from plugin review,
compatibility and capability readiness.
