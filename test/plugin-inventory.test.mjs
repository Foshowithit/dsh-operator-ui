import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInventory, validateDispositionCoverage, normalizeRepositoryUrl } from '../scripts/plugin-inventory.mjs';

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
