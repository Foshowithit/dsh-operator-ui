// P4 marketplace — the UNIT half.
//
// Pure-function coverage for the three matrices the design doc names:
// security policy, static content checks, and visibility scoping — plus the
// capability-detection ladder against real local HTTP shapes (404, openapi
// without the namespace, advertised, unreachable, silent). Everything here is
// in-process: no child, no mock archon, no config file. The behavioral ladder
// (import/refusal/write-deltas) lives in marketplace-negative.test.mjs, which
// is where the E2E claims belong; a passing row here proves a DECISION
// function, never a live Archon marketplace.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  evaluateSecurity,
  marketStaticChecks,
  entryVisibleToPrincipal,
  scopeEntriesForPrincipal,
  detectMarketplaceSupport,
} from '../lib/marketplace.js';

// ------------------------------------------------------ security policy matrix
// GPT policy: critical/high BLOCK; medium requires explicit human approval;
// low waives nothing; failed/missing/incomplete evidence fails closed; an AI
// review alone is not proof of safety.

test('security: missing or non-object review fails closed', () => {
  for (const review of [undefined, null, 'complete-ish', 42]) {
    const r = evaluateSecurity(review);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'security-evidence-incomplete');
    assert.equal(r.status, 403);
    assert.equal(r.reason, 'no security review is present for this entry');
    assert.deepEqual(r.counts, { critical: 0, high: 0, medium: 0, low: 0 });
  }
});

test('security: a status other than complete fails closed, quoting the status', () => {
  for (const status of ['failed', 'running', 'partial', undefined]) {
    const r = evaluateSecurity({ kind: 'deterministic-scan', status, findings: [] });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'security-evidence-incomplete');
    assert.equal(r.status, 403);
    assert.ok(String(r.reason).includes(String(status)), r.reason);
    assert.ok(/fails closed/.test(r.reason), r.reason);
  }
});

test('security: an AI review alone is never sufficient evidence', () => {
  const r = evaluateSecurity({ kind: 'ai-review', status: 'complete', findings: [] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'security-evidence-insufficient');
  assert.equal(r.status, 403);
  assert.ok(/AI review alone/.test(r.reason), r.reason);
});

test('security: complete status with no findings array fails closed', () => {
  const r = evaluateSecurity({ kind: 'deterministic-scan', status: 'complete' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'security-evidence-incomplete');
  assert.equal(r.status, 403);
  assert.ok(/no findings array/.test(r.reason), r.reason);
});

test('security: critical or high findings block, with counts riding the refusal', () => {
  const scan = (findings) => ({ kind: 'deterministic-scan', status: 'complete', findings });
  const both = evaluateSecurity(scan([{ severity: 'critical', summary: 'exfil' }, { severity: 'high', summary: 'fetch' }]));
  assert.equal(both.ok, false);
  assert.equal(both.code, 'security-blocking-findings');
  assert.equal(both.status, 403);
  assert.deepEqual(both.counts, { critical: 1, high: 1, medium: 0, low: 0 });
  // severity is case-insensitive on the way IN
  const shout = evaluateSecurity(scan([{ severity: 'CRITICAL', summary: 'louder' }]));
  assert.equal(shout.ok, false);
  assert.equal(shout.code, 'security-blocking-findings');
  assert.equal(shout.counts.critical, 1);
  // high alone blocks too
  const highOnly = evaluateSecurity(scan([{ severity: 'high', summary: 'still blocks' }]));
  assert.equal(highOnly.ok, false);
  assert.equal(highOnly.code, 'security-blocking-findings');
  assert.equal(highOnly.counts.high, 1);
});

test('security: medium findings demand explicit human approval — not a block, not a pass', () => {
  const r = evaluateSecurity({
    kind: 'deterministic-scan',
    status: 'complete',
    findings: [{ severity: 'medium', summary: 'writes nearby' }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'security-approval-required');
  assert.equal(r.status, 403);
  assert.equal(r.counts.medium, 1);
});

test('security: low findings pass but waive nothing; a clean scan says clean', () => {
  const scan = (findings) => ({ kind: 'deterministic-scan', status: 'complete', findings });
  const low = evaluateSecurity(scan([{ severity: 'low', summary: 'nit' }]));
  assert.equal(low.ok, true);
  assert.deepEqual(low.counts, { critical: 0, high: 0, medium: 0, low: 1 });
  assert.ok(/waiving nothing/.test(low.reason), low.reason);
  const clean = evaluateSecurity(scan([]));
  assert.equal(clean.ok, true);
  assert.equal(clean.reason, 'clean');
  // unknown severities are counted nowhere — they neither block nor pass-signal
  const weird = evaluateSecurity(scan([{ severity: 'banana', summary: '?' }]));
  assert.equal(weird.ok, true);
  assert.deepEqual(weird.counts, { critical: 0, high: 0, medium: 0, low: 0 });
});

// ----------------------------------------------------- static-check matrix
// Runs on the DOWNLOADED bytes — the marketplace's own scan verdict is never
// trusted for these families.

const wf = (name, run) => 'name: ' + name + '\nversion: 1\ndescription: unit fixture\nnodes:\n  - id: n1\n    run: ' + run + '\n';
const codes = (text) => marketStaticChecks(text).failures.map((f) => f.code);

test('static: empty or non-string source is SOURCE_EMPTY with no name', () => {
  for (const text of ['', '   \n  ', null, undefined, 7]) {
    const r = marketStaticChecks(text);
    assert.equal(r.ok, false);
    assert.deepEqual(r.failures.map((f) => f.code), ['SOURCE_EMPTY']);
    assert.equal(r.name, null);
  }
});

test('static: name must exist and be lowercase-hyphenated', () => {
  assert.ok(codes('version: 1\n').includes('NAME_MISSING'));
  assert.ok(codes('name: Bad Name\nnodes:\n').includes('NAME_FORMAT'));
});

test('static: a workflow with no nodes list fails', () => {
  assert.ok(codes('name: good-name\nversion: 1\n').includes('NODES_MISSING'));
});

test('static: absolute writes and ../ escapes fail; the dev-null carve-out does not', () => {
  assert.ok(codes(wf('market-x', 'echo hi > /tmp/out')).includes('LOCATION_ABSOLUTE_WRITE'));
  assert.ok(codes(wf('market-x', 'cat a | tee /var/log/x')).includes('LOCATION_ABSOLUTE_WRITE'));
  assert.ok(codes(wf('market-x', 'cp ../secrets out')).includes('LOCATION_PARENT_ESCAPE'));
  // > /dev/null is a discard, not an artifact write — the carve-out is deliberate
  assert.ok(!codes(wf('market-x', 'echo loud > /dev/null')).includes('LOCATION_ABSOLUTE_WRITE'));
});

test('static: network, privilege, destructive, and credential families each fail', () => {
  assert.ok(codes(wf('market-x', 'curl http://evil.example')).includes('FORBIDDEN_NETWORK'));
  assert.ok(codes(wf('market-x', 'sudo make install')).includes('FORBIDDEN_PRIVILEGE'));
  assert.ok(codes(wf('market-x', 'rm -rf /')).includes('FORBIDDEN_DESTRUCTIVE'));
  assert.ok(codes(wf('market-x', 'cat ~/.ssh/id_rsa')).includes('FORBIDDEN_CREDENTIAL'));
});

test('static: a clean workflow passes with its resolved name', () => {
  const r = marketStaticChecks(wf('market-x', 'echo hello'));
  assert.equal(r.ok, true);
  assert.deepEqual(r.failures, []);
  assert.equal(r.name, 'market-x');
});

// ------------------------------------------------------------- visibility scoping

test('scoping: public entries are always visible; the wire never strips them', () => {
  const pub = { id: 'p', visibility: 'public', owner: 'market' };
  assert.equal(entryVisibleToPrincipal(pub, null), true);
  assert.equal(entryVisibleToPrincipal(pub, { id: 'svc', ownerIds: ['alice'] }), true);
});

test('scoping: a private entry shows only to a principal holding its owner — dev fails closed', () => {
  const priv = { id: 'q', visibility: 'private', owner: 'alice' };
  assert.equal(entryVisibleToPrincipal(priv, { id: 'svc-alice', ownerIds: ['alice'] }), true);
  assert.equal(entryVisibleToPrincipal(priv, { id: 'svc-bob', ownerIds: ['bob'] }), false);
  assert.equal(entryVisibleToPrincipal(priv, null), false); // dev posture
  assert.equal(entryVisibleToPrincipal(priv, { id: 'svc', ownerIds: [] }), false);
  // an owner that is not even a string never satisfies the holder check
  assert.equal(entryVisibleToPrincipal({ id: 'r', visibility: 'private' }, { id: 'svc', ownerIds: [undefined] }), false);
  // no entry at all is never visible
  assert.equal(entryVisibleToPrincipal(null, { id: 'svc', ownerIds: ['alice'] }), false);
});

test('scoping: the array filter drops what the single-entry check drops; non-arrays read as empty', () => {
  const entries = [
    { id: 'pub', visibility: 'public', owner: 'market' },
    { id: 'priv-alice', visibility: 'private', owner: 'alice' },
    { id: 'priv-bob', visibility: 'private', owner: 'bob' },
  ];
  const ids = (p) => scopeEntriesForPrincipal(entries, p).map((e) => e.id);
  assert.deepEqual(ids(null), ['pub']);
  assert.deepEqual(ids({ id: 'svc-alice', ownerIds: ['alice'] }), ['pub', 'priv-alice']);
  assert.deepEqual(ids({ id: 'svc-root', ownerIds: ['alice', 'bob'] }), ['pub', 'priv-alice', 'priv-bob']);
  assert.deepEqual(scopeEntriesForPrincipal(undefined, null), []);
  assert.deepEqual(scopeEntriesForPrincipal('not-an-array', null), []);
});

// ------------------------------------------------- marketplace capability detection
// Feature detection reads the target's own openapi document. Every failure
// shape must degrade to supported:false with an honest reason — never throw,
// never assume.

const withServer = async (handler, fn) => {
  const srv = createServer(handler);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  try {
    return await fn('http://127.0.0.1:' + srv.address().port);
  } finally {
    srv.closeAllConnections?.();
    await new Promise((resolve) => srv.close(resolve));
  }
};
const openapi = (paths) => (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ openapi: '3.0.0', paths }));
};

test('detection: an advertised marketplace namespace is found', async () => {
  await withServer(openapi({ '/api/health': {}, '/api/marketplace/search': {}, '/api/marketplace/entries/{id}': {} }), async (baseUrl) => {
    const s = await detectMarketplaceSupport({ baseUrl, timeoutMs: 2000 });
    assert.equal(s.supported, true);
    assert.ok(Array.isArray(s.paths));
    assert.ok(s.paths.some((p) => p.startsWith('/api/marketplace/')));
  });
});

test('detection: openapi without the namespace reports unsupported, not an error', async () => {
  await withServer(openapi({ '/api/health': {}, '/api/codebases': {} }), async (baseUrl) => {
    const s = await detectMarketplaceSupport({ baseUrl, timeoutMs: 2000 });
    assert.equal(s.supported, false);
    assert.equal(s.reason, 'marketplace-not-advertised');
    assert.equal(typeof s.hint, 'string');
  });
});

test('detection: no openapi document at all (404) is unsupported with a hint', async () => {
  await withServer((req, res) => { res.writeHead(404); res.end('not found'); }, async (baseUrl) => {
    const s = await detectMarketplaceSupport({ baseUrl, timeoutMs: 2000 });
    assert.equal(s.supported, false);
    assert.equal(s.reason, 'marketplace-not-advertised');
  });
});

test('detection: an unreachable target is an OUTAGE, never "not advertised"', async () => {
  // Wrong behaviour this prevents: a connection-refused READ was reported as
  // 'marketplace-not-advertised' — a durable claim about the installation,
  // derived from a transient network failure.
  const closed = await detectMarketplaceSupport({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 });
  assert.equal(closed.supported, false);
  assert.equal(closed.outcome, 'UNAVAILABLE');
  assert.equal(closed.reason, 'marketplace-unreachable');
});

test('detection: an unconfigured Archon is NOT_CONFIGURED, never "not advertised"', async () => {
  // Wrong behaviour this prevents: "no Archon is configured at all" (operator
  // action: set archon.baseUrl) was reported as "this installation does not
  // advertise a marketplace" (a different action entirely).
  const none = await detectMarketplaceSupport({});
  assert.equal(none.supported, false);
  assert.equal(none.outcome, 'NOT_CONFIGURED');
  assert.equal(none.reason, 'marketplace-not-configured');
});

test('detection: a silent target times out to UNAVAILABLE instead of hanging', async () => {
  // Wrong behaviour this prevents: a timeout — the same outage as an
  // unreachable target — was reported as 'marketplace-not-advertised'.
  await withServer(() => { /* never answers */ }, async (baseUrl) => {
    const s = await detectMarketplaceSupport({ baseUrl, timeoutMs: 200 });
    assert.equal(s.supported, false);
    assert.equal(s.outcome, 'UNAVAILABLE');
    assert.equal(s.reason, 'marketplace-unreachable');
  });
});
