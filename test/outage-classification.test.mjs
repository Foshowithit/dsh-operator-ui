// Failure-collapse regression suite: an UNREADABLE read must never be reported
// as ABSENCE, as UNSUPPORTED, or as MALFORMED.
//
// Three defect sites, all in the same class (a read of external/durable state
// that collapsed distinguishable failures into one value):
//   1. lib/flowrouter.js verifyImport — an Archon outage during local
//      verification was reported as LOCAL_VERIFICATION_FAILED.
//   2. lib/marketplace.js detectMarketplaceSupport — a 500/timeout/unconfigured
//      Archon was reported as "this installation does not advertise a
//      marketplace".
//   3. lib/marketplace.js readLedger — a corrupt ledger read as "no imports",
//      which let a write path rewrite it from the empty read.
//
// Everything here is deterministic and in-process: real loopback HTTP servers
// for detection, a stubbed global fetch for the import/verify ladders, and a
// throwaway $DSH_HOME for the ledger and task store. No ports are assumed free
// (the servers bind :0) and no sibling process is touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// $DSH_HOME must be set before any module reads it at call time. Every read of
// getDshHome() happens per-call, so this is sufficient and contained to this
// test process (node --test runs each file in its own child).
const HOME = await mkdtemp(join(tmpdir(), 'outage-classification-'));
process.env.DSH_HOME = HOME;

const { detectMarketplaceSupport, readLedger, listInstallations, importMarketplaceWorkflow } =
  await import('../lib/marketplace.js');
const { verifyImport } = await import('../lib/flowrouter.js');
const { upsertTask } = await import('../lib/tasks.js');

const sha256s = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

test.after(async () => { await rm(HOME, { recursive: true, force: true }); });

// ------------------------------------------------------------------ helpers

const withServer = async (handler, fn) => {
  const srv = createServer(handler);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  try { return await fn('http://127.0.0.1:' + srv.address().port); }
  finally { srv.closeAllConnections?.(); await new Promise((resolve) => srv.close(resolve)); }
};

const resp = (status, body, asText = false) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return typeof body === 'string' ? JSON.parse(body) : body; },
  async text() { return asText && typeof body === 'string' ? body : JSON.stringify(body); },
});

// Stub the global fetch for one test, restoring it no matter how the test ends.
// A router that returns `undefined` falls through to the real fetch, so a test
// can drive a real local listener while Archon traffic is faulted.
function stubFetch(router) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push((opts && opts.method) || 'GET', ' ' + u);
    const r = router(u, opts || {});
    return r === undefined ? orig(url, opts) : r;
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

// ============================================================ 1. detection
// A 500 / timeout / unreachable / unconfigured Archon must NOT yield
// "marketplace-not-advertised". Only an Archon that ANSWERED (404, or a 200
// openapi without the namespace) may conclude NOT_ADVERTISED.

test('detection: an advertised marketplace namespace is AVAILABLE', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ openapi: '3.0.0', paths: { '/api/health': {}, '/api/marketplace/search': {} } }));
  }, async (baseUrl) => {
    const s = await detectMarketplaceSupport({ baseUrl, timeoutMs: 2000 });
    assert.equal(s.supported, true);
    assert.equal(s.outcome, 'AVAILABLE');
    assert.ok(s.paths.some((p) => p.startsWith('/api/marketplace/')));
  });
});

test('detection: an ANSWERED 404 is genuinely NOT_ADVERTISED', async () => {
  await withServer((req, res) => { res.writeHead(404); res.end('not found'); }, async (baseUrl) => {
    const s = await detectMarketplaceSupport({ baseUrl, timeoutMs: 2000 });
    assert.equal(s.supported, false);
    assert.equal(s.outcome, 'NOT_ADVERTISED');
    assert.equal(s.reason, 'marketplace-not-advertised');
  });
});

test('detection: an ANSWERED openapi without the namespace is NOT_ADVERTISED', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ openapi: '3.0.0', paths: { '/api/health': {} } }));
  }, async (baseUrl) => {
    const s = await detectMarketplaceSupport({ baseUrl, timeoutMs: 2000 });
    assert.equal(s.supported, false);
    assert.equal(s.outcome, 'NOT_ADVERTISED');
  });
});

test('detection: an HTTP 500 is UNAVAILABLE, never "not advertised"', async () => {
  await withServer((req, res) => { res.writeHead(500); res.end('boom'); }, async (baseUrl) => {
    const s = await detectMarketplaceSupport({ baseUrl, timeoutMs: 2000 });
    assert.equal(s.supported, false);
    assert.equal(s.outcome, 'UNAVAILABLE');
    assert.equal(s.reason, 'marketplace-unreachable');
    assert.notEqual(s.reason, 'marketplace-not-advertised');
  });
});

test('detection: a silent target times out to UNAVAILABLE, never "not advertised"', async () => {
  await withServer(() => { /* never answers */ }, async (baseUrl) => {
    const s = await detectMarketplaceSupport({ baseUrl, timeoutMs: 200 });
    assert.equal(s.supported, false);
    assert.equal(s.outcome, 'UNAVAILABLE');
    assert.notEqual(s.reason, 'marketplace-not-advertised');
  });
});

test('detection: an unreachable target is UNAVAILABLE, never "not advertised"', async () => {
  const s = await detectMarketplaceSupport({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 });
  assert.equal(s.supported, false);
  assert.equal(s.outcome, 'UNAVAILABLE');
  assert.notEqual(s.reason, 'marketplace-not-advertised');
});

test('detection: an unconfigured Archon is NOT_CONFIGURED, never "not advertised"', async () => {
  const s = await detectMarketplaceSupport({});
  assert.equal(s.supported, false);
  assert.equal(s.outcome, 'NOT_CONFIGURED');
  assert.equal(s.reason, 'marketplace-not-configured');
});

test('detection: an ANSWERED but unreadable body is INVALID, never "not advertised"', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{ this is not json');
  }, async (baseUrl) => {
    const s = await detectMarketplaceSupport({ baseUrl, timeoutMs: 2000 });
    assert.equal(s.supported, false);
    assert.equal(s.outcome, 'INVALID');
    assert.notEqual(s.reason, 'marketplace-not-advertised');
  });
});

// ================================================= 2. import-ladder detection
// The consumer must pass the outage through as its OWN refusal code, not as
// the durable claim "marketplace-unsupported".

const ENTRY_ID = 'mkt-ok';
const SOURCE = 'name: market-ok\nversion: 1\ndescription: outage suite fixture\nnodes:\n  - id: n1\n    run: echo hi\n';
const MARKET_BASE = 'http://127.0.0.1:3999';

const writeConfig = async (extra = {}) => {
  await writeFile(join(HOME, 'operator-ui.config.json'), JSON.stringify({
    configVersion: 1,
    archon: { baseUrl: MARKET_BASE },
    ...extra,
  }), 'utf8');
};

const writeWorkspaces = async () => {
  await mkdir(join(HOME, 'operator-ui'), { recursive: true });
  await writeFile(join(HOME, 'operator-ui', 'workspaces.json'),
    JSON.stringify({ version: 1, workspaces: [{ workspaceId: 'ws-test', owner: 'alice' }] }), 'utf8');
};

// A router that serves a healthy marketplace for the happy ladder paths.
const marketRouter = (overrides = {}) => (url) => {
  if (url.includes('/api/openapi.json')) {
    if (overrides.openapi) return overrides.openapi();
    return resp(200, { openapi: '3.0.0', paths: { '/api/marketplace/search': {}, '/api/marketplace/entries/{id}': {} } });
  }
  if (url.includes('/api/marketplace/entries/' + ENTRY_ID + '/source')) return resp(200, SOURCE, true);
  if (url.includes('/api/marketplace/entries/')) {
    return resp(200, { entry: {
      id: ENTRY_ID, name: 'market-ok', owner: 'alice', visibility: 'public',
      revision: 'rev-1', digest: sha256s(SOURCE), requires: [],
      securityReview: { kind: 'deterministic-scan', status: 'complete', findings: [] },
    } });
  }
  return resp(404, {});
};

const importArgs = () => ({ entryId: ENTRY_ID, workspaceId: 'ws-test', owner: 'alice' });

test('import ladder: a detection OUTAGE refuses as marketplace-unreachable, not marketplace-unsupported', async () => {
  const workflowsDir = join(HOME, 'wf-outage');
  await writeConfig({ marketplace: { workflowsDir } });
  await writeWorkspaces();
  const { restore } = stubFetch(marketRouter({ openapi: () => resp(500, { error: 'boom' }) }));
  try {
    const out = await importMarketplaceWorkflow(importArgs());
    assert.equal(out.ok, false);
    assert.equal(out.code, 'marketplace-unreachable');
    assert.notEqual(out.code, 'marketplace-unsupported');
    assert.ok(!/does not advertise a marketplace/.test(String(out.error)), out.error);
    assert.equal(await exists(workflowsDir), false, 'an outage must not write an install target');
  } finally { restore(); }
});

test('import ladder: an ANSWERED 404 still refuses as marketplace-unsupported (behaviour preserved)', async () => {
  const workflowsDir = join(HOME, 'wf-404');
  await writeConfig({ marketplace: { workflowsDir } });
  await writeWorkspaces();
  const { restore } = stubFetch(marketRouter({ openapi: () => resp(404, {}) }));
  try {
    const out = await importMarketplaceWorkflow(importArgs());
    assert.equal(out.ok, false);
    assert.equal(out.code, 'marketplace-unsupported');
  } finally { restore(); }
});

// ============================================================== 3. ledger
// A corrupt / unreadable ledger must never be read as "no imports".

const LEDGER = () => join(HOME, 'operator-ui', 'marketplace.json');

test('ledger: a MISSING file is legitimately empty', async () => {
  await rm(LEDGER(), { force: true });
  const read = await readLedger();
  assert.equal(read.ok, true);
  assert.deepEqual(read.imports, []);
});

test('ledger: a VALID file is read back', async () => {
  await mkdir(dirname(LEDGER()), { recursive: true });
  await writeFile(LEDGER(), JSON.stringify({ ledgerVersion: 1, imports: [{ importId: 'mkt_x', entryId: 'e', revision: 'r', owner: 'alice' }] }), 'utf8');
  const read = await readLedger();
  assert.equal(read.ok, true);
  assert.equal(read.imports.length, 1);
  assert.equal(read.imports[0].importId, 'mkt_x');
});

test('ledger: a CORRUPT file is not read as empty (it refuses)', async () => {
  await mkdir(dirname(LEDGER()), { recursive: true });
  await writeFile(LEDGER(), '{ this is not json', 'utf8');
  const read = await readLedger();
  assert.equal(read.ok, false);
  assert.equal(read.code, 'ledger-corrupt');
  assert.equal(read.imports, undefined, 'a failed read must not hand back an array');
});

test('ledger: a WRONG-SHAPE file is not read as empty (it refuses)', async () => {
  await writeFile(LEDGER(), JSON.stringify({ ledgerVersion: 1, imports: 'nope' }), 'utf8');
  const read = await readLedger();
  assert.equal(read.ok, false);
  assert.equal(read.code, 'ledger-corrupt');
});

test('ledger: an UNREADABLE file (directory in its place) refuses rather than reading empty', async () => {
  await rm(LEDGER(), { force: true, recursive: true });
  await mkdir(LEDGER(), { recursive: true });
  const read = await readLedger();
  assert.equal(read.ok, false);
  assert.equal(read.code, 'ledger-unreadable');
});

test('listInstallations: a corrupt ledger refuses instead of reporting "no imports"', async () => {
  await rm(LEDGER(), { force: true, recursive: true });
  await mkdir(dirname(LEDGER()), { recursive: true });
  await writeFile(LEDGER(), 'not json at all', 'utf8');
  const out = await listInstallations({ principal: null, owner: 'alice' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'ledger-corrupt');
  assert.equal(out.status, 500);
});

test('import ladder: a corrupt ledger fails closed BEFORE any write and does not rewrite the ledger', async () => {
  const workflowsDir = join(HOME, 'wf-corrupt');
  await writeConfig({ marketplace: { workflowsDir } });
  await writeWorkspaces();
  await mkdir(dirname(LEDGER()), { recursive: true });
  const corrupt = '{"ledgerVersion":1,"imports":[{"importId":"mkt_keep"';
  await writeFile(LEDGER(), corrupt, 'utf8');
  const { restore } = stubFetch(marketRouter());
  try {
    const out = await importMarketplaceWorkflow(importArgs());
    assert.equal(out.ok, false);
    assert.equal(out.code, 'ledger-corrupt');
    // the YAML was never written (the ledger read precedes the writes)
    assert.equal(await exists(join(workflowsDir, 'market-ok.yaml')), false);
    // and the corrupt ledger was left byte-identical — not rewritten from an empty read
    assert.equal(await readFile(LEDGER(), 'utf8'), corrupt);
  } finally { restore(); }
});

test('import ladder: a valid ledger still imports (the guard did not break the happy path)', async () => {
  const workflowsDir = join(HOME, 'wf-happy');
  await writeConfig({ marketplace: { workflowsDir } });
  await writeWorkspaces();
  await rm(LEDGER(), { force: true });
  const { restore } = stubFetch(marketRouter());
  try {
    const out = await importMarketplaceWorkflow(importArgs());
    assert.equal(out.ok, true);
    assert.equal(out.import.entryId, ENTRY_ID);
    assert.equal(await exists(join(workflowsDir, 'market-ok.yaml')), true);
    const read = await readLedger();
    assert.equal(read.ok, true);
    assert.equal(read.imports.length, 1);
  } finally { restore(); }
});

// ================================================== 4. local verification reads
// An outage during verifyImport must not be reported as a failed verification.

const FIXTURE = join(HOME, 'fixture');
const PKG = join(HOME, 'pkg');

async function makeStagedImport(taskId, alias) {
  await mkdir(join(PKG, 'workflows'), { recursive: true });
  await writeFile(join(PKG, 'workflows', 'x.yaml'), 'name: x\nversion: 1\nnodes:\n  - id: n1\n    run: echo hi\n', 'utf8');
  await mkdir(FIXTURE, { recursive: true });
  await writeFile(join(FIXTURE, 'objective.txt'), 'count things\n', 'utf8');
  await writeFile(join(FIXTURE, 'expected.json'), JSON.stringify({ rows: [{ row: 1, total: 3 }] }), 'utf8');
  await upsertTask({
    taskId, kind: 'import', status: 'staged', verdict: 'STAGED',
    packagePath: PKG, startedAt: new Date().toISOString(),
    local: { import: 'STAGED', verification: 'UNVERIFIED', routing: 'INELIGIBLE', alias },
    checks: [], source: {},
    manifest: { implementation: { entrypoint: 'workflows/x.yaml' } },
  });
  return { importTaskId: taskId, fixtureDir: FIXTURE, timing: { settleMs: 0, startAttempts: 1, startRetryMs: 0, pollMs: 1, deadlineMs: 30 } };
}

const verifyConfig = async () => writeConfig({
  teaching: { workflowsDir: join(HOME, 'teach-wf'), workspaceDir: join(HOME, 'teach-ws') },
});

// A router for verifyImport: the run POST, the runs list (limit 100 = the task
// store's own read, limit 10 = the verification observation), and the detail.
const verifyRouter = ({ start, list100, list10, detail }) => (url, opts) => {
  if ((opts.method || 'GET') === 'POST' && url.includes('/run')) return start();
  if (url.includes('/api/workflows/runs/')) return detail();
  if (url.includes('/api/workflows/runs')) return url.includes('limit=100') ? list100() : list10();
  return resp(404, {});
};

test('verify: an OUTAGE during observation is LOCAL_VERIFICATION_UNAVAILABLE, never LOCAL_VERIFICATION_FAILED', async () => {
  await verifyConfig();
  const args = await makeStagedImport('imp_outage', 'outage-alias');
  const { restore } = stubFetch(verifyRouter({
    start: () => resp(200, { accepted: true }),
    list100: () => resp(500, {}),
    list10: () => resp(500, {}),
    detail: () => resp(500, {}),
  }));
  try {
    const out = await verifyImport(args);
    assert.equal(out.ok, true);
    assert.equal(out.import.status, 'refused', 'must still fail closed');
    assert.equal(out.import.refusal.code, 'LOCAL_VERIFICATION_UNAVAILABLE');
    assert.notEqual(out.import.refusal.code, 'LOCAL_VERIFICATION_FAILED');
    assert.ok(/outage/.test(out.import.refusal.reason), out.import.refusal.reason);
  } finally { restore(); }
});

test('verify: Archon ANSWERING with no such run is LOCAL_VERIFICATION_ABSENT', async () => {
  await verifyConfig();
  const args = await makeStagedImport('imp_absent', 'absent-alias');
  const { restore } = stubFetch(verifyRouter({
    start: () => resp(200, { accepted: true }),
    list100: () => resp(200, { runs: [] }),
    list10: () => resp(200, { runs: [] }),
    detail: () => resp(404, {}),
  }));
  try {
    const out = await verifyImport(args);
    assert.equal(out.ok, true);
    assert.equal(out.import.status, 'refused');
    assert.equal(out.import.refusal.code, 'LOCAL_VERIFICATION_ABSENT');
  } finally { restore(); }
});

test('verify: a run record present but UNUSABLE is LOCAL_VERIFICATION_MALFORMED', async () => {
  await verifyConfig();
  const args = await makeStagedImport('imp_malformed', 'malformed-alias');
  const localName = 'malformed-alias-v0-1-0';
  const { restore } = stubFetch(verifyRouter({
    start: () => resp(200, { accepted: true }),
    list100: () => resp(200, { runs: [] }),
    list10: () => resp(200, { runs: [{ id: 'run-x', workflow_name: localName, status: 'completed' }] }),
    detail: () => resp(200, { run: { id: 'run-x' } }), // no events array
  }));
  try {
    const out = await verifyImport(args);
    assert.equal(out.ok, true);
    assert.equal(out.import.refusal.code, 'LOCAL_VERIFICATION_MALFORMED');
  } finally { restore(); }
});

test('verify: a run that actually ran and failed is still LOCAL_VERIFICATION_FAILED (code preserved)', async () => {
  await verifyConfig();
  const args = await makeStagedImport('imp_failed', 'failed-alias');
  const localName = 'failed-alias-v0-1-0';
  const { restore } = stubFetch(verifyRouter({
    start: () => resp(200, { accepted: true }),
    list100: () => resp(200, { runs: [] }),
    list10: () => resp(200, { runs: [{ id: 'run-y', workflow_name: localName, status: 'failed' }] }),
    detail: () => resp(200, { run: { id: 'run-y' }, events: [] }),
  }));
  try {
    const out = await verifyImport(args);
    assert.equal(out.ok, true);
    assert.equal(out.import.status, 'refused');
    assert.equal(out.import.refusal.code, 'LOCAL_VERIFICATION_FAILED');
  } finally { restore(); }
});

test('verify: a transport failure while STARTING is named an outage, not "the executor refused"', async () => {
  await verifyConfig();
  const args = await makeStagedImport('imp_start', 'start-alias');
  const { restore } = stubFetch(verifyRouter({
    start: () => { throw new Error('connect ECONNREFUSED'); },
    list100: () => resp(500, {}),
    list10: () => resp(500, {}),
    detail: () => resp(500, {}),
  }));
  try {
    const out = await verifyImport(args);
    assert.equal(out.ok, false);
    assert.ok(/unreachable/.test(out.error), out.error);
    assert.ok(/outage/.test(out.error), out.error);
    assert.ok(!/refused the imported workflow/.test(out.error), out.error);
  } finally { restore(); }
});

test('verify: a satisfied run missing the expectation marker names the MARKER, not the grader', async () => {
  // Wrong behaviour this prevents: the refusal quoted the grader ("all running
  // totals match") while the absent expectation marker was the real failure —
  // a weaker refusal than goal.js's own standard of naming the check that failed.
  await verifyConfig();
  const args = await makeStagedImport('imp_marker', 'marker-alias');
  const localName = 'marker-alias-v0-1-0';
  const { restore } = stubFetch(verifyRouter({
    start: () => resp(200, { accepted: true }),
    list100: () => resp(200, { runs: [] }),
    list10: () => resp(200, { runs: [{ id: 'run-z', workflow_name: localName, status: 'completed' }] }),
    detail: () => resp(200, { run: { id: 'run-z' }, events: [{ data: { node_output: 'RESULT row=1 total=3' } }] }),
  }));
  try {
    const out = await verifyImport(args);
    assert.equal(out.ok, true);
    assert.equal(out.import.refusal.code, 'LOCAL_VERIFICATION_FAILED');
    assert.equal(out.import.verification.grader.satisfied, true, 'the grader really did match');
    assert.ok(/expectation marker/.test(out.import.refusal.reason), out.import.refusal.reason);
    assert.ok(/learned-marker-alias-v0-1-0:done/.test(out.import.refusal.reason), out.import.refusal.reason);
  } finally { restore(); }
});

// ============================================ 5. route-level consumer (index.js)
// The producer distinguishes an outage; the CONSUMER must not re-collapse it.
// lib/index.js maps a feature-detection outcome to the transport refusal in ONE
// helper shared by search and inspect — so boot the REAL plugin and drive the
// REAL route, proving the collapse cannot reappear one layer up.

const ROUTE = '/plugins/operator-ui';

let pluginRoutes = null;
async function ensurePlugin() {
  if (pluginRoutes) return pluginRoutes;
  const routes = [];
  const ctx = {
    webServer: { register(spec) { routes.push(spec); return () => {}; } },
    tools: { register() { return () => {}; } },
    effect(fn) { const t = fn(); return () => { if (typeof t === 'function') t(); }; },
  };
  const { apply } = await import('../lib/index.js');
  apply(ctx);
  pluginRoutes = routes;
  return routes;
}

// Boot the plugin once, serve it on an ephemeral loopback port, and fault only
// the Archon base URL — the test's own client calls fall through to real fetch.
async function withPluginRoute(fault, fn) {
  const routes = await ensurePlugin();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let route = null;
    for (const r of routes) {
      if (r.kind === 'exact' && r.path === url.pathname) { route = r; break; }
      if (r.kind === 'prefix' && (url.pathname === r.path || url.pathname.startsWith(r.path + '/'))) {
        if (!route || r.path.length > route.path.length) route = r;
      }
    }
    if (!route) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'no route' })); return; }
    try { await route.handler(req, res, url); }
    catch (e) {
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) })); }
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const { restore } = stubFetch((url) => {
    if (!url.startsWith(MARKET_BASE)) return undefined; // our own listener → real fetch
    if (url.includes('/api/openapi.json')) return fault();
    return resp(404, {});
  });
  try {
    return await fn(async (path) => {
      const r = await globalThis.fetch(base + ROUTE + path);
      return { status: r.status, body: await r.json().catch(() => null) };
    });
  } finally {
    restore();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('route: a search/inspect OUTAGE is 502 marketplace-unreachable, never 409 marketplace-unsupported', async () => {
  // Wrong behaviour this prevents: the producer learned to say "outage", but the
  // consumer re-collapsed it into the durable claim 'marketplace-unsupported'.
  await writeConfig();
  await withPluginRoute(() => resp(500, { error: 'boom' }), async (call) => {
    const search = await call('/marketplace?op=search');
    assert.equal(search.status, 502);
    assert.equal(search.body.code, 'marketplace-unreachable');
    assert.notEqual(search.body.code, 'marketplace-unsupported');
    const inspect = await call('/marketplace?op=inspect&entry_id=x');
    assert.equal(inspect.status, 502);
    assert.equal(inspect.body.code, 'marketplace-unreachable');
  });
});

test('route: an ANSWERED 404 still yields 409 marketplace-unsupported (control)', async () => {
  await writeConfig();
  await withPluginRoute(() => resp(404, {}), async (call) => {
    const search = await call('/marketplace?op=search');
    assert.equal(search.status, 409);
    assert.equal(search.body.code, 'marketplace-unsupported');
    const status = await call('/marketplace?op=status');
    assert.equal(status.status, 200);
    assert.equal(status.body.outcome, 'NOT_ADVERTISED');
    assert.equal(status.body.reason, 'marketplace-not-advertised');
  });
});

test('route: the status op reports an OUTAGE verbatim instead of "not advertised"', async () => {
  await writeConfig();
  await withPluginRoute(() => resp(503, {}), async (call) => {
    const status = await call('/marketplace?op=status');
    assert.equal(status.status, 200);
    assert.equal(status.body.supported, false);
    assert.equal(status.body.outcome, 'UNAVAILABLE');
    assert.equal(status.body.reason, 'marketplace-unreachable');
  });
});
