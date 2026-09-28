# Offline ecosystem inventory (K1)

Frozen 2026-09-28. Research artifact only: these files are outside the
runtime and are never imported by `lib/`, shipped in the package, or treated
as a registry. A directory listing never becomes execution authority.

## Files

- `sources.json` — the three frozen source snapshots (`operator-plugin-inventory-sources/1`):
  `awesome-curated` (licensed feed snapshot basis), `dshfind-api`
  (link-only; bulk rights unresolved), `dshmarket-view` (downstream view of
  the awesome feed, no independent count). Each records `accessBasis`,
  `advertisedTotal`, `collectedRows`, and why traversal is incomplete.
- `inventory.json` — the normalized output of
  `scripts/plugin-inventory.mjs` over the 13 manually reviewed survey rows
  (12 link-only refs + 1 licensed-feed row). Self-contained: `inputs` holds
  the exact sources+listings fed to the normalizer, `result` holds
  `entries`, `conflicts`, and `coverage`. Current result: 13 entries,
  0 conflicts, all three sources `traversalComplete: false`.
- `README.md` — this file (schema + reproduction).

## Schema (frozen)

`normalizeInventory({ sources, listings })` returns
`{ schema: 'operator-plugin-inventory/1', entries, conflicts, coverage }`.

- Source record: `sourceId`, `sourceUrl`, `observedAt`,
  `sourceRef`/`sourceDigest` when available, `accessBasis` (one of
  `licensed-snapshot`, `link-only`, `downstream-view`, `manual-review`),
  `advertisedTotal` (int or null), `collectedRows`,
  `traversalComplete`, `unresolvedReason`.
- Listing record: `sourceId`, `sourceKey` (stable `owner/repo` where the
  source documents one; otherwise an inventory-local `row-<index>` key),
  `url`, `packageName`/`packageVersion` when explicit (scoped names kept
  verbatim), `repositoryUrl`/`repositorySubpath`/`repositoryRef`,
  `publisher`, `declaredDshRange`, `licenseEvidence`, `updatedAt`.
- `entryId` is an inventory-row reference only (`sourceId:sourceKey`, or a
  `row-<index>#<digest>` derivation). It is not a canonical capability ID.
- `conflicts` surfaces overlaps, duplicate keys, missing identity,
  coverage mismatches, batch caps, and malformed/accessor-bearing rows —
  rows are kept distinct and ambiguity is recorded, never merged.
- `coverage` is per-source and measurable: incomplete coverage can never
  read as complete. `validateDispositionCoverage(inventory, decisions)`
  returns `{ ok, missing, duplicateDecisions, unknownEntries }` for the K2
  disjoint-range review; valid dispositions are `native-reuse`,
  `optional-host-plugin`, `task-pack`, `ui-enhancement`, `duplicate`,
  `defer`, `reject`.

## Rights boundary (from the B1a contract)

Only the awesome feed has both a documented machine-readable dataset and a
repository-level reuse license, so only `awesome-curated` rows may feed a
future read-only adapter (pinned/validated projection, with attribution).
`dshfind-api` rows stay link-out references until catalog-data rights are
clarified. `dshmarket-view` contributes provenance context, not rows.

## Reproduction

The normalizer is pure with no I/O on import and caps operator batches at
100 rows (or one published snapshot); overflow pauses with a `batch-capped`
conflict and a recorded continuation. To regenerate `inventory.json` from
its own embedded inputs:

```sh
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeInventory } from './scripts/plugin-inventory.mjs';
const doc = JSON.parse(readFileSync('docs/ecosystem/inventory.json', 'utf8'));
const result = normalizeInventory(doc.inputs);
writeFileSync('docs/ecosystem/inventory.json', JSON.stringify({ generatedBy: 'scripts/plugin-inventory.mjs', generatedAt: doc.generatedAt, inputs: doc.inputs, result }, null, 2) + '\n');
"
node --test test/plugin-inventory.test.mjs
```

Counts must reconcile: entries by source equal each source's `collectedRows`
in `coverage`, and any gap keeps `traversalComplete: false`.
