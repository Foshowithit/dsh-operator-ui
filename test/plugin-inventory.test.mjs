import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInventory, validateDispositionCoverage, normalizeRepositoryUrl, normalizeAwesomeSnapshot } from '../scripts/plugin-inventory.mjs';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const src = (over = {}) => ({
  sourceId: 'awesome',
  sourceUrl: 'https://example.com/feed.json',
  observedAt: '2026-09-28T00:00:00.000Z',
  accessBasis: 'licensed-snapshot',
  advertisedTotal: null,
  collectedRows: null,
  traversalComplete: false,
  unresolvedReason: 'bounded manual survey',
  ...over,
});

const listing = (over = {}) => ({
  sourceId: 'awesome',
  sourceKey: 'owner/repo',
  url: 'https://example.com/listing/owner/repo',
  repositoryUrl: 'https://github.com/owner/repo',
  ...over,
});

test('overlapping sources keep both rows and surface the ambiguity', () => {
  const result = normalizeInventory({
    sources: [
      src({ sourceId: 'awesome', accessBasis: 'licensed-snapshot' }),
      src({ sourceId: 'finder', sourceUrl: 'https://example.com/api', accessBasis: 'link-only' }),
    ],
    listings: [
      listing({ sourceId: 'awesome', sourceKey: 'owner/repo' }),
      listing({ sourceId: 'finder', sourceKey: 'owner/repo', url: 'https://example.com/other/owner/repo' }),
    ],
  });
  assert.equal(result.entries.length, 2);
  assert.ok(result.conflicts.some((c) => c.type === 'overlap'));
});

test('scoped package names are preserved verbatim', () => {
  const result = normalizeInventory({
    sources: [src()],
    listings: [listing({ packageName: '@scope/name', packageVersion: '1.2.3' })],
  });
  assert.equal(result.entries[0].packageName, '@scope/name');
  assert.equal(result.entries[0].packageVersion, '1.2.3');
});

test('multiple packages per repository stay distinct', () => {
  const result = normalizeInventory({
    sources: [src()],
    listings: [
      listing({ sourceKey: 'repo#pkg-a', packageName: 'pkg-a', repositorySubpath: 'packages/a' }),
      listing({ sourceKey: 'repo#pkg-b', packageName: 'pkg-b', repositorySubpath: 'packages/b' }),
    ],
  });
  assert.equal(result.entries.length, 2);
  assert.notEqual(result.entries[0].entryId, result.entries[1].entryId);
});

test('same package at two versions stays distinct', () => {
  const result = normalizeInventory({
    sources: [src()],
    listings: [
      listing({ sourceKey: 'pkg@1.0.0', packageName: 'pkg', packageVersion: '1.0.0' }),
      listing({ sourceKey: 'pkg@2.0.0', packageName: 'pkg', packageVersion: '2.0.0' }),
    ],
  });
  assert.equal(result.entries.length, 2);
});

test('missing identity is a conflict, not a silent drop', () => {
  const result = normalizeInventory({
    sources: [src()],
    listings: [{ sourceId: 'awesome', url: 'https://example.com/nowhere' }],
  });
  assert.equal(result.entries.length, 1);
  assert.ok(result.conflicts.some((c) => c.type === 'missing-identity'));
});

test('repeated sourceKey is a duplicate-key conflict with stable disambiguation', () => {
  const result = normalizeInventory({
    sources: [src()],
    listings: [
      listing({ sourceKey: 'same' }),
      listing({ sourceKey: 'same', url: 'https://example.com/other' }),
    ],
  });
  assert.equal(result.entries.length, 2);
  assert.ok(result.conflicts.some((c) => c.type === 'duplicate-key'));
  assert.notEqual(result.entries[0].entryId, result.entries[1].entryId);
});

test('interrupted traversal cannot read as complete', () => {
  const result = normalizeInventory({
    sources: [src({ advertisedTotal: 4382, collectedRows: 2, traversalComplete: true, unresolvedReason: null })],
    listings: [listing({ sourceKey: 'a' }), listing({ sourceKey: 'b' })],
  });
  const row = result.coverage.find((c) => c.sourceId === 'awesome');
  assert.equal(row.traversalComplete, false);
  assert.ok(result.conflicts.some((c) => c.type === 'coverage-mismatch'));
});

test('malformed and accessor-bearing metadata is refused, never executed', () => {
  const evil = { sourceId: 'awesome', sourceKey: 'evil' };
  Object.defineProperty(evil, 'repositoryUrl', { enumerable: true, get: () => 'https://github.com/evil/x' });
  const result = normalizeInventory({ sources: [src()], listings: [evil] });
  assert.equal(result.entries.length, 0);
  assert.ok(result.conflicts.some((c) => c.type === 'malformed-listing'));
  const badUrl = normalizeInventory({
    sources: [src()],
    listings: [listing({ sourceKey: 'bad', url: 'not a url' })],
  });
  assert.ok(badUrl.conflicts.some((c) => c.type === 'malformed-listing'));
});

test('operator batch caps at 100 rows with continuation recorded', () => {
  const listings = Array.from({ length: 120 }, (_, i) => listing({ sourceKey: `r-${i}` }));
  const result = normalizeInventory({ sources: [src()], listings });
  assert.equal(result.entries.length, 100);
  assert.ok(result.conflicts.some((c) => c.type === 'batch-capped'));
  assert.equal(result.coverage[0].traversalComplete, false);
});

test('entries sort stably by entryId regardless of input order', () => {
  const result = normalizeInventory({
    sources: [src()],
    listings: [listing({ sourceKey: 'z' }), listing({ sourceKey: 'a' }), listing({ sourceKey: 'm' })],
  });
  assert.deepEqual(result.entries.map((e) => e.entryId), ['awesome:a', 'awesome:m', 'awesome:z']);
});

test('repository normalization strips case, trailing slash, and .git', () => {
  assert.equal(
    normalizeRepositoryUrl('https://github.com/Owner/Repo.git/'),
    normalizeRepositoryUrl('https://github.com/owner/repo'),
  );
});

test('coverage validator separates missing, duplicates, and unknowns', () => {
  const inv = normalizeInventory({
    sources: [src()],
    listings: [listing({ sourceKey: 'a' }), listing({ sourceKey: 'b' })],
  });
  const partial = validateDispositionCoverage(inv, [{ entryId: 'awesome:a', disposition: 'defer', reason: 'x' }]);
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.missing, ['awesome:b']);
  const dup = validateDispositionCoverage(inv, [
    { entryId: 'awesome:a', disposition: 'defer', reason: 'x' },
    { entryId: 'awesome:a', disposition: 'reject', reason: 'y' },
    { entryId: 'awesome:b', disposition: 'defer', reason: 'z' },
  ]);
  assert.deepEqual(dup.duplicateDecisions, ['awesome:a']);
  const unknown = validateDispositionCoverage(inv, [
    { entryId: 'awesome:a', disposition: 'defer', reason: 'x' },
    { entryId: 'awesome:b', disposition: 'defer', reason: 'y' },
    { entryId: 'awesome:ghost', disposition: 'defer', reason: 'z' },
  ]);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.unknownEntries.length, 1);
  const full = validateDispositionCoverage(inv, [
    { entryId: 'awesome:a', disposition: 'task-pack', reason: 'x' },
    { entryId: 'awesome:b', disposition: 'defer', reason: 'y' },
  ]);
  assert.equal(full.ok, true);
});

test('unknown disposition vocabulary cannot satisfy coverage', () => {
  const inv = normalizeInventory({ sources: [src()], listings: [listing({ sourceKey: 'a' })] });
  const result = validateDispositionCoverage(inv, [{ entryId: 'awesome:a', disposition: 'maybe-later', reason: 'x' }]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['awesome:a']);
});

test('published awesome snapshot validates its digest and count and projects metadata as inert identity', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const compressed = readFileSync(resolve(here, '../docs/ecosystem/snapshots/awesome-dsh-plugin-2026-09-28.json.gz'));
  const raw = gunzipSync(compressed);
  const result = normalizeAwesomeSnapshot(raw, {
    sourceDigest: '80c4bc9efbeb9a894aca4ccfc89391275449ff9b4b3b0cafaf45f4b145f218c5',
    declaredCount: 4382,
    observedAt: '2026-09-28T21:37:28Z',
  });
  assert.equal(result.entries.length, 4382);
  assert.equal(result.coverage[0].collectedRows, 4382);
  assert.equal(result.coverage[0].traversalComplete, true);
  assert.ok(result.entries.every((entry) => !('capabilities' in entry) && !('install' in entry) && !('stars' in entry)));
  const advertised = result.entries.find((entry) => entry.sourceKey === 'AnonyJcy/dsh-j-space');
  assert.ok(advertised);
  assert.equal(advertised.licenseEvidence, null);
  assert.equal(advertised.declaredDshRange, null);
  assert.throws(() => normalizeAwesomeSnapshot(raw, {
    sourceDigest: '0'.repeat(64), declaredCount: 4382, observedAt: '2026-09-28T21:37:28Z',
  }), /digest/);
  assert.throws(() => normalizeAwesomeSnapshot(raw, {
    sourceDigest: '80c4bc9efbeb9a894aca4ccfc89391275449ff9b4b3b0cafaf45f4b145f218c5', declaredCount: 4381, observedAt: '2026-09-28T21:37:28Z',
  }), /count/);
});

test('snapshot identity collisions and malformed rows remain visible without name merging', () => {
  const bytes = Buffer.from(JSON.stringify({
    source: 'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin',
    count: 3,
    plugins: [
      { owner: 'same', name: 'entry', url: 'https://github.com/same/entry' },
      { owner: 'same', name: 'entry', url: 'https://github.com/same/entry' },
      { name: '', url: 'not a URL', install: 'must remain inert' },
    ],
  }));
  const result = normalizeAwesomeSnapshot(bytes, {
    sourceDigest: createHash('sha256').update(bytes).digest('hex'),
    declaredCount: 3,
    observedAt: '2026-09-28T21:37:28Z',
  });
  assert.equal(result.entries.length, 3);
  assert.ok(result.conflicts.some((conflict) => conflict.type === 'duplicate-key'));
  assert.ok(result.conflicts.some((conflict) => conflict.type === 'malformed-listing'));
  assert.equal(result.entries.filter((entry) => entry.sourceKey === 'same/entry').length, 2);
  assert.equal(result.entries.some((entry) => entry.entryId === 'awesome-curated:same/entry#dup2'), true);
});
