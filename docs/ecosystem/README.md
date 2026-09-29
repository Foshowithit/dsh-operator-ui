# Offline ecosystem inventory (K1)

Frozen 2026-09-28. These files are research artifacts outside the runtime;
they are never imported by `lib/`, shipped in the package, or treated as a
registry. A directory listing never becomes execution authority.

## Files and provenance

- `sources.json` records `awesome-curated` as a digest-bound static snapshot,
  `dshfind-api` as link-only while catalog-data rights remain unresolved, and
  `dshmarket-view` as a downstream view of the same awesome catalog.
- `snapshots/awesome-dsh-plugin-2026-09-28.json.gz` is a deterministic gzip
  of the exact export bytes. SHA-256 of the decompressed bytes is
  `80c4bc9efbeb9a894aca4ccfc89391275449ff9b4b3b0cafaf45f4b145f218c5`
  (5,267,051 bytes; observed `2026-09-28T21:37:28Z`); the export reports
  4,382 plugin rows. Attribution and license context: `awesome-dsh-plugin/awesome-dsh-plugin`
  at `4c4167fa0dc992395f8d9c56cfb27e1f812ddb33`, which declares CC0-1.0.
  The website export has no schema version or stable record IDs. Its license
  does not establish the licenses of listed repositories.
- `inventory.json` contains 4,382 awesome catalog rows plus 12 link-only
  references, with per-source coverage. The 4,382 rows are collected listings,
  not reviewed capabilities: existing K2 dispositions cover the 13-row starter
  sample only; the rest await disjoint review batches of at most 25.

## Projection and safety boundary

`normalizeInventory({ sources, listings })` returns
`{ schema: 'operator-plugin-inventory/1', entries, conflicts, coverage }`.
The ordinary operator input path remains capped at 100 rows. The separate
`normalizeAwesomeSnapshot` path accepts the exact decompressed bytes only after
SHA-256, source, envelope count, and output count validation. The pinned static
artifact is the only snapshot input; normalizer/runtime code performs no
network fetch.

Snapshot rows project only owner/name identity, URL, and publisher. Feed
descriptions, capabilities, verification timestamps, install commands,
compatibility claims, download/star values, and package metadata are inert and
omitted. Duplicate identities and malformed rows stay distinct and surface as
conflicts. Per-repository code licenses remain unknown. `entryId` is an
inventory-row reference, not a canonical capability ID.

`dshfind-api` stays link-only until catalog-data rights are resolved.
`dshmarket-view` remains in the same lineage and contributes no independent
rows. Listing, compatibility, review, host evidence, and capability readiness
are separate facts.

## Reproduction

From the repository root, this offline command rebuilds the inventory from the
compressed snapshot and the embedded link-only input rows:

```sh
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { normalizeAwesomeSnapshot, normalizeInventory } from './scripts/plugin-inventory.mjs';
const doc = JSON.parse(readFileSync('docs/ecosystem/inventory.json', 'utf8'));
const raw = gunzipSync(readFileSync(`docs/ecosystem/${doc.snapshot.file}`));
const awesome = normalizeAwesomeSnapshot(raw, {
  sourceDigest: doc.snapshot.sourceDigest.slice('sha256:'.length),
  declaredCount: doc.snapshot.declaredCount,
  observedAt: doc.snapshot.observedAt,
});
const links = normalizeInventory(doc.inputs);
const entries = [...awesome.entries, ...links.entries].sort((a, b) => a.entryId.localeCompare(b.entryId));
const conflicts = [...awesome.conflicts, ...links.conflicts].sort((a, b) => String(a.type).localeCompare(String(b.type)) || String(a.entryId ?? a.sourceId ?? '').localeCompare(String(b.entryId ?? b.sourceId ?? '')));
const coverage = [...awesome.coverage, ...links.coverage].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
const result = { schema: 'operator-plugin-inventory/1', entries, conflicts, coverage };
writeFileSync('docs/ecosystem/inventory.json', JSON.stringify({ ...doc, result }, null, 2) + '\n');
NODE
node --test test/plugin-inventory.test.mjs
```

The feed is treated only as untrusted listing metadata. Never execute or copy
its install commands, capability assertions, compatibility claims, or
verification timestamps into authority or readiness records.
