// The FlowRouter refusal transport, tested where it actually ships.
//
// The invariant: a refusal must reach the operator with (a) its IDENTITY — a
// typed code, because the code is what carries the next action — and (b) a
// status that follows the OPERATOR ACTION. 409 means "do not retry", so a
// refusal whose meaning is "a read could not be completed" must never be 409.
//
// Nothing in this repo imported lib/flowrouter.js before this file: `admitImport`
// and `stagePackage` had no test at all, so their refusal codes could have been
// dropped, renamed, or never attached without anything going red. These rows
// drive the REAL functions and the REAL plugin — no stub of the module under
// test, no injected seam.
//
// Determinism: $DSH_HOME is a throwaway mkdtemp, Archon is pinned to a closed
// port (127.0.0.1:1), the listener binds :0, and the config FILE is the single
// source of the registry path (the ambient env override is deleted below). No
// port is assumed free and no sibling process is touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = await mkdtemp(join(tmpdir(), 'flowrouter-refusal-'));
process.env.DSH_HOME = HOME;
delete process.env.DSH_OPERATOR_UI_REGISTRY;
delete process.env.DSH_OPERATOR_UI_ARCHON;

const { stagePackage, admitImport, canonicalJson, packageDigest } = await import('../lib/flowrouter.js');
const { upsertTask } = await import('../lib/tasks.js');

test.after(async () => { await rm(HOME, { recursive: true, force: true }); });

const CONFIG = join(HOME, 'operator-ui.config.json');
const REGISTRY = join(HOME, 'registry.json');
const WORKFLOWS = join(HOME, 'workflows');
const WORKSPACE = join(HOME, 'verify-workspace');

async function putConfig(extra) {
  await writeFile(CONFIG, JSON.stringify({
    configVersion: 1,
    archon: { baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 },
    registry: { path: REGISTRY, schema: 'rcos-public-v1', maxBytes: 200000 },
    teaching: { workflowsDir: WORKFLOWS, workspaceDir: WORKSPACE },
    ...(extra || {}),
  }, null, 2) + '\n', 'utf8');
}

// The three shapes the configured registry can actually be in.
async function registryAbsent() { await rm(REGISTRY, { recursive: true, force: true }); }
async function registryUnreadable() { await rm(REGISTRY, { recursive: true, force: true }); await mkdir(REGISTRY, { recursive: true }); }
async function registryHolding(capabilities) {
  await rm(REGISTRY, { recursive: true, force: true });
  await writeFile(REGISTRY, JSON.stringify({ registry_version: 'v1', capabilities }, null, 2) + '\n', 'utf8');
}

const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');

// A verified import envelope, shaped after what verifyImport writes: only the
// fields admitImport reads are populated.
let seq = 0;
async function verifiedImport(alias) {
  const taskId = 'imp_verified_' + (++seq);
  await upsertTask({
    taskId,
    kind: 'import',
    status: 'verified',
    verdict: 'VERIFIED',
    startedAt: '2026-01-01T00:00:00.000Z',
    local: { import: 'STAGED', verification: 'VERIFIED', routing: 'INELIGIBLE', alias },
    checks: [],
    source: { identity: 'acme/' + alias, version: '0.1.0' },
    manifest: {
      identity: { id: 'acme/' + alias, version: '0.1.0', title: 'Demo', description: 'a demo capability' },
      contract: {},
      implementation: { entrypoint: 'workflows/demo.yaml', tools: [], bundle: { algorithm: 'sha256', digest: 'x', package_digest: 'y' } },
      routing: { task_signatures: ['demo'] },
      evidence: { verdicts: [] },
      lifecycle: { status: 'promoted' },
      xRcos: { required_authority: [], provenance: {}, evidence_standard: null },
    },
    verification: { fixture_hash: 'sha256:fixture', marker_ok: true },
  });
  return taskId;
}

// A STAGED import carrying the package bytes verifyImport re-reads before it
// ever reaches the executor.
async function stagedImport(taskId, alias, packageDir) {
  await upsertTask({
    taskId,
    kind: 'import',
    status: 'staged',
    verdict: 'STAGED',
    startedAt: '2026-01-01T00:00:00.000Z',
    local: { import: 'STAGED', verification: 'UNVERIFIED', routing: 'INELIGIBLE', alias },
    checks: [],
    source: { identity: 'acme/' + alias, version: '0.1.0' },
    packagePath: packageDir,
    manifest: { identity: { id: 'acme/' + alias, version: '0.1.0' }, implementation: { entrypoint: 'workflows/demo.yaml' } },
  });
}

const DEMO_YAML = 'name: demo-v0-1-0\nnodes:\n  - id: report\n    bash: echo RESULT ok=1\n';
const DEMO_BYTES = Buffer.from(DEMO_YAML, 'utf8');

// A package whose declared digests are computed by the MODULE'S OWN rule
// (canonicalJson + packageDigest), so schema + integrity + compatibility all
// pass and the run reaches the collision read. Nothing here is a shortcut
// around the check under test.
async function validPackage(dir, { compatibility = ['rcos'] } = {}) {
  const impl = { entrypoint: 'workflows/demo.yaml', tools: [], bundle: { algorithm: 'sha256', digest: sha256hex(DEMO_BYTES) } };
  const base = {
    manifest_version: '0.1',
    identity: { id: 'acme/demo', version: '0.1.0', title: 'Demo' },
    implementation: impl,
    routing: { compatibility, task_signatures: ['demo'] },
    'x-rcos': { required_authority: [] },
  };
  const noDigest = Buffer.from(canonicalJson({ ...base, implementation: { ...impl, bundle: { algorithm: 'sha256' } } }), 'utf8');
  const pkgDigest = packageDigest([
    { path: 'capability.json', bytes: noDigest },
    { path: 'workflows/demo.yaml', bytes: DEMO_BYTES },
  ]);
  const manifest = { ...base, implementation: { ...impl, bundle: { ...impl.bundle, package_digest: pkgDigest } } };
  await mkdir(join(dir, 'workflows'), { recursive: true });
  await writeFile(join(dir, 'capability.json'), canonicalJson(manifest), 'utf8');
  await writeFile(join(dir, 'workflows', 'demo.yaml'), DEMO_BYTES);
  return dir;
}

// ============================================= 1. the PRODUCER: typed codes
// A stage/verify refusal travels INSIDE the envelope (`ok:true`, verdict
// REFUSED) — so the code is the only thing that identifies it, and nextAction
// is the only thing that tells the operator what to do with it.

test('stage: a package dir with NO manifest is PACKAGE_MANIFEST_MISSING — an input to supply', async () => {
  await putConfig();
  const out = await stagePackage({ packageDir: join(HOME, 'no-such-package') });
  assert.equal(out.ok, true, 'a stage refusal travels inside the envelope');
  assert.equal(out.import.verdict, 'REFUSED');
  // Wrong behaviour this prevents: one bare `catch { SCHEMA_INVALID }` around
  // the manifest read reported ENOENT — a package dir that holds no manifest —
  // as a verdict about bytes we never held. Nothing was read, so nothing was
  // judged malformed.
  assert.equal(out.import.refusal.code, 'PACKAGE_MANIFEST_MISSING');
  assert.notEqual(out.import.refusal.code, 'SCHEMA_INVALID', 'nothing was read, so nothing was judged malformed');
  // A refusal with a code but no nextAction hands the operator an identifier
  // and nothing to do with it — the gap this table closes.
  assert.equal(out.import.nextAction.kind, 'inspect');
  assert.match(out.import.nextAction.label, /manifest/);
});

test('stage: a manifest that EXISTS but cannot be READ is its own code, never a missing one', async () => {
  // ENOENT means "supply the package"; EACCES/EISDIR mean "the path is unwell".
  // Different operator actions, so they cannot share a code.
  await putConfig();
  const dir = join(HOME, 'pkg-manifest-is-a-directory');
  await mkdir(join(dir, 'capability.json'), { recursive: true }); // present, unreadable as bytes
  const out = await stagePackage({ packageDir: dir });
  assert.equal(out.import.verdict, 'REFUSED');
  assert.equal(out.import.refusal.code, 'PACKAGE_MANIFEST_UNREADABLE');
  assert.notEqual(out.import.refusal.code, 'PACKAGE_MANIFEST_MISSING');
  assert.notEqual(out.import.refusal.code, 'SCHEMA_INVALID');
  assert.equal(out.import.nextAction.kind, 'retry', 'a read that failed is retryable, not a verdict to inspect');
  assert.match(out.import.nextAction.label, /Repair/);
});

test('stage: a manifest we READ and cannot PARSE is still SCHEMA_INVALID (control)', async () => {
  // The control that keeps the split honest: it must not over-reach. Bytes in
  // hand that are not valid JSON are a genuine verdict about a package we read,
  // so the code and its status stay exactly as they were.
  await putConfig();
  const dir = join(HOME, 'pkg-bad-json');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'capability.json'), '{ not json', 'utf8');
  const out = await stagePackage({ packageDir: dir });
  assert.equal(out.import.refusal.code, 'SCHEMA_INVALID');
  assert.notEqual(out.import.refusal.code, 'PACKAGE_MANIFEST_UNREADABLE', 'bytes we DID read must not be softened into a read failure');
  assert.equal(out.import.nextAction.kind, 'inspect');
});

test('stage: a package that declares an entrypoint it does NOT ship is INTEGRITY_ENTRYPOINT_MISSING', async () => {
  // The read one step after the manifest read, with the identical defect: one
  // bare `catch { INTEGRITY_FAIL }` reported ENOENT as an integrity verdict. The
  // schema check already guarantees `entrypoint` is non-empty, so this is a real
  // statement about the package — it declares a file it does not ship.
  await putConfig();
  const dir = await validPackage(join(HOME, 'pkg-entry-missing'));
  await rm(join(dir, 'workflows', 'demo.yaml'), { recursive: true, force: true });
  const out = await stagePackage({ packageDir: dir });
  assert.equal(out.import.verdict, 'REFUSED');
  assert.equal(out.import.refusal.code, 'INTEGRITY_ENTRYPOINT_MISSING');
  assert.notEqual(out.import.refusal.code, 'INTEGRITY_FAIL', 'we never got bytes to hash, so no digest verdict was reached');
  assert.equal(out.import.nextAction.kind, 'inspect');
  assert.match(out.import.nextAction.label, /entrypoint/);
});

test('stage: a declared entrypoint that EXISTS but cannot be READ is its own code', async () => {
  await putConfig();
  const dir = await validPackage(join(HOME, 'pkg-entry-unreadable'));
  await rm(join(dir, 'workflows', 'demo.yaml'), { recursive: true, force: true });
  await mkdir(join(dir, 'workflows', 'demo.yaml'), { recursive: true }); // present, unreadable as bytes
  const out = await stagePackage({ packageDir: dir });
  assert.equal(out.import.refusal.code, 'INTEGRITY_ENTRYPOINT_UNREADABLE');
  assert.notEqual(out.import.refusal.code, 'INTEGRITY_ENTRYPOINT_MISSING');
  assert.notEqual(out.import.refusal.code, 'INTEGRITY_FAIL');
  assert.equal(out.import.nextAction.kind, 'retry');
  assert.match(out.import.nextAction.label, /Repair/);
});

test('stage: a DIGEST MISMATCH on bytes we read is still INTEGRITY_FAIL (control)', async () => {
  // The control that keeps INTEGRITY_FAIL meaning what it says: a verdict about
  // bytes we DID read. If the split had captured this case, the operator would
  // lose the one code that tells them the package's own evidence contradicts
  // its bytes.
  await putConfig();
  const dir = await validPackage(join(HOME, 'pkg-bad-digest'));
  const m = JSON.parse(await readFile(join(dir, 'capability.json'), 'utf8'));
  m.implementation.bundle.digest = '0'.repeat(64);
  await writeFile(join(dir, 'capability.json'), canonicalJson(m), 'utf8');
  const out = await stagePackage({ packageDir: dir });
  assert.equal(out.import.refusal.code, 'INTEGRITY_FAIL');
  assert.notEqual(out.import.refusal.code, 'INTEGRITY_ENTRYPOINT_MISSING');
  assert.notEqual(out.import.refusal.code, 'INTEGRITY_ENTRYPOINT_UNREADABLE');
});

test('stage: an unreadable REGISTRY is refused as a read failure, never as "alias free"', async () => {
  // Wrong behaviour this prevents: the collision check read the registry with a
  // bare `catch {}` and fell back to an empty capability list, so an UNREADABLE
  // registry produced `alias free: demo` — reporting a read failure as the
  // absence of every capability this home owns — and staged the package anyway.
  await putConfig();
  await registryUnreadable();
  const dir = await validPackage(join(HOME, 'pkg-unreadable'));
  const out = await stagePackage({ packageDir: dir });
  assert.equal(out.import.verdict, 'REFUSED');
  assert.equal(out.import.refusal.code, 'REGISTRY_UNREADABLE');
  assert.notEqual(out.import.refusal.code, 'LOCAL_ID_COLLISION');
  const collision = out.import.checks.find((c) => c.id === 'collision');
  assert.equal(collision.pass, false, 'an unread registry must not report the alias as free');
  assert.match(collision.detail, /UNKNOWN/);
  assert.equal(out.import.nextAction.kind, 'retry', 'a read failure is retryable, not a verdict to inspect');
});

test('stage: an ABSENT registry is REGISTRY_MISSING — a different action from unreadable', async () => {
  await putConfig();
  await registryAbsent();
  const dir = await validPackage(join(HOME, 'pkg-missing'));
  const out = await stagePackage({ packageDir: dir });
  assert.equal(out.import.refusal.code, 'REGISTRY_MISSING');
  assert.equal(out.import.nextAction.label, 'Create the capability registry');
});

test('stage: a taken alias is LOCAL_ID_COLLISION and asks for a different alias', async () => {
  await putConfig();
  await registryHolding([{ id: 'demo' }]);
  const dir = await validPackage(join(HOME, 'pkg-collision'));
  const out = await stagePackage({ packageDir: dir });
  assert.equal(out.import.refusal.code, 'LOCAL_ID_COLLISION');
  assert.equal(out.import.nextAction.kind, 'inspect');
  assert.match(out.import.nextAction.label, /alias/);
});

// ========================================== 2. the PRODUCER: admitImport
// The two refusals the transport used to deliver anonymously: a bare catch
// around the durable-state read, and a code buried INSIDE an error string.

test('admit: an import that is not VERIFIED is IMPORT_NOT_VERIFIED', async () => {
  await putConfig();
  await upsertTask({ taskId: 'imp_only_staged', kind: 'import', status: 'staged', local: { alias: 'demo' }, checks: [] });
  const out = await admitImport({ importTaskId: 'imp_only_staged' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'IMPORT_NOT_VERIFIED');
});

test('admit: an absent registry and an unreadable one are different codes', async () => {
  // Both used to be the same anonymous "registry unreadable" string, so no
  // caller could tell "create the file" from "fix its permissions" — and the
  // transport had no code to map, so both left as 409.
  await putConfig();
  const taskId = await verifiedImport('learned-demo');
  await registryAbsent();
  const missing = await admitImport({ importTaskId: taskId });
  await registryUnreadable();
  const unreadable = await admitImport({ importTaskId: taskId });
  assert.equal(missing.code, 'REGISTRY_MISSING');
  assert.equal(unreadable.code, 'REGISTRY_UNREADABLE');
  assert.notEqual(missing.code, unreadable.code);
  assert.notEqual(missing.error, unreadable.error);
});

test('admit: a taken alias is LOCAL_ID_COLLISION, carried as a CODE not just prose', async () => {
  await putConfig();
  await registryHolding([{ id: 'learned-demo' }]);
  const taskId = await verifiedImport('learned-demo');
  const out = await admitImport({ importTaskId: taskId });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'LOCAL_ID_COLLISION', 'the code must be readable by a caller, not only by a human');
  assert.match(out.error, /LOCAL_ID_COLLISION/);
});

test('admit: a readable registry admits (control)', async () => {
  // Without this control the rows above could pass for the wrong reason — e.g.
  // failing at the status check and never reaching the registry read at all.
  await putConfig();
  await registryHolding([]);
  const taskId = await verifiedImport('learned-demo');
  const out = await admitImport({ importTaskId: taskId });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.import.status, 'admitted');
  assert.equal(out.capability.id, 'learned-demo');
  assert.equal(out.import.nextAction.kind, 'retry');
  const written = JSON.parse(await readFile(REGISTRY, 'utf8'));
  assert.deepEqual(written.capabilities.map((c) => c.id), ['learned-demo']);
});

// ========================================== 3. the TRANSPORT: the status
// The typed code only matters because the route maps it to a status. These rows
// drive the REAL plugin over real HTTP, so the assertion is about the bytes a
// client receives — the mapping helper's return value is not the evidence.

const routes = [];
const ctx = {
  webServer: { register(spec) { routes.push(spec); return () => {}; } },
  tools: { register() { return () => {}; } },
  effect(fn) { const t = fn(); return () => { if (typeof t === 'function') t(); }; },
};
const { apply, flowrouterRefusalStatus, DELIBERATE_409_CODES } = await import('../lib/index.js');
await apply(ctx);

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
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
test.after(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); });

const flowrouter = async (op, body) => {
  const res = await fetch(base + '/plugins/operator-ui/flowrouter?op=' + op, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('transport: an unreadable registry leaves as 500, never as the do-not-retry 409', async () => {
  await putConfig();
  const taskId = await verifiedImport('learned-http');
  await registryUnreadable();
  const r = await flowrouter('admit', { importTaskId: taskId });
  assert.equal(r.body.code, 'REGISTRY_UNREADABLE');
  assert.notEqual(r.status, 409, 'a read failure must never be a do-not-retry refusal');
  assert.equal(r.status, 500);
});

test('transport: an absent registry leaves as 500 with its own code', async () => {
  await putConfig();
  const taskId = await verifiedImport('learned-http');
  await registryAbsent();
  const r = await flowrouter('admit', { importTaskId: taskId });
  assert.equal(r.body.code, 'REGISTRY_MISSING');
  assert.notEqual(r.status, 409);
  assert.equal(r.status, 500);
});

test('transport: a genuine business refusal is still 409 (control)', async () => {
  // The fix must not turn every refusal into a 5xx: an ANSWERED, readable
  // registry that already owns the alias is a real do-not-retry conflict.
  await putConfig();
  await registryHolding([{ id: 'learned-http' }]);
  const taskId = await verifiedImport('learned-http');
  const r = await flowrouter('admit', { importTaskId: taskId });
  assert.equal(r.body.code, 'LOCAL_ID_COLLISION');
  assert.equal(r.status, 409);
});

test('transport: an unreachable executor leaves as 502 — an outage stays retryable', async () => {
  // The headline case. `verifyImport` reports EXECUTOR_UNREACHABLE when the
  // local executor never answered; under the old `out.ok ? 200 : 409` ternary
  // that OUTAGE left as 409 — "do not retry" for the one condition whose only
  // remedy is to retry. The run itself is never reached, so the ~6.5s is the
  // production settle+retry window, not a workload.
  await putConfig();
  await mkdir(WORKFLOWS, { recursive: true });
  const fixture = join(HOME, 'fixture');
  await mkdir(fixture, { recursive: true });
  await writeFile(join(fixture, 'objective.txt'), 'count the words\n', 'utf8');
  await writeFile(join(fixture, 'expected.json'), JSON.stringify({ rows: [] }) + '\n', 'utf8');
  const pkg = await validPackage(join(HOME, 'staged-package'));
  await stagedImport('imp_http_verify', 'learned-http-verify', pkg);
  const r = await flowrouter('verify', { importTaskId: 'imp_http_verify', fixtureDir: fixture });
  assert.equal(r.body.code, 'EXECUTOR_UNREACHABLE');
  assert.notEqual(r.status, 409, 'an outage must stay retryable');
  assert.equal(r.status, 502);
});

test('transport: an unconfigured export leaves as 400', async () => {
  await putConfig(); // no flowrouter block — publisher is not configured
  const r = await flowrouter('export', { capabilityId: 'demo', outDir: join(HOME, 'out') });
  assert.equal(r.body.code, 'EXPORT_NOT_CONFIGURED');
  assert.equal(r.status, 400);
});

test('transport: a package entrypoint that exists but cannot be READ is its own code, never a raw errno', async () => {
  // The staged package's own bytes could not be read, so verification never
  // started. This used to be an unguarded read: the fs error escaped to the
  // route catch and shipped as a 500 whose `code` was a raw errno (EISDIR here)
  // — a code that is not ours and never went through the status mapping.
  await putConfig();
  await mkdir(WORKFLOWS, { recursive: true });
  const fixture = join(HOME, 'fixture-pkg');
  await mkdir(fixture, { recursive: true });
  await writeFile(join(fixture, 'objective.txt'), 'count the words\n', 'utf8');
  await writeFile(join(fixture, 'expected.json'), JSON.stringify({ rows: [] }) + '\n', 'utf8');
  const pkg = join(HOME, 'package-with-a-directory-entrypoint');
  await validPackage(pkg);
  // Replace the entrypoint FILE with a DIRECTORY: present, unreadable as bytes.
  await rm(join(pkg, 'workflows', 'demo.yaml'), { recursive: true, force: true });
  await mkdir(join(pkg, 'workflows', 'demo.yaml'), { recursive: true });
  await stagedImport('imp_pkg_read', 'learned-pkg-read', pkg);
  const r = await flowrouter('verify', { importTaskId: 'imp_pkg_read', fixtureDir: fixture });
  assert.equal(r.body.code, 'PACKAGE_BYTES_UNREADABLE');
  assert.equal(r.status, 500);
});

test('transport: a genuinely ABSENT package entrypoint is its own code', async () => {
  await putConfig();
  await mkdir(WORKFLOWS, { recursive: true });
  const fixture = join(HOME, 'fixture-absent');
  await mkdir(fixture, { recursive: true });
  await writeFile(join(fixture, 'objective.txt'), 'count the words\n', 'utf8');
  await writeFile(join(fixture, 'expected.json'), JSON.stringify({ rows: [] }) + '\n', 'utf8');
  const pkg = join(HOME, 'package-without-entrypoint');
  await validPackage(pkg);
  await rm(join(pkg, 'workflows', 'demo.yaml'), { recursive: true, force: true }); // genuinely gone
  await stagedImport('imp_pkg_missing', 'learned-pkg-missing', pkg);
  const r = await flowrouter('verify', { importTaskId: 'imp_pkg_missing', fixtureDir: fixture });
  assert.equal(r.body.code, 'PACKAGE_BYTES_MISSING');
  assert.notEqual(r.body.code, 'PACKAGE_BYTES_UNREADABLE', 'absent must not be reported as unreadable');
  assert.equal(r.status, 500);
});

test('transport: a stage refusal rides INSIDE a 200, with its code — the envelope is the identity', async () => {
  // The stage/verify REFUSED envelope is the deliberate non-change: the
  // transport SUCCEEDED (it staged a refusal) and the refusal is TYPED, so the
  // conditions stay distinguishable. The consequence, stated rather than
  // hidden: a client that reads only the STATUS sees 200 and no refusal. That
  // is the linked client work — this row pins the shape so the day the client
  // half changes, the change is visible here.
  await putConfig();
  const r = await flowrouter('stage', { packageDir: join(HOME, 'transport-no-package') });
  assert.equal(r.status, 200);
  assert.equal(r.body.import.verdict, 'REFUSED');
  assert.equal(r.body.import.refusal.code, 'PACKAGE_MANIFEST_MISSING');
  assert.equal(r.body.import.nextAction.kind, 'inspect');
  assert.match(r.body.import.nextAction.reason, /capability\.json/);
});

test('status: the manifest split is TWO decisions, not one code with two spellings', () => {
  // Asserted on the mapping helper rather than over HTTP, and the reason is
  // itself the finding: a stage refusal never reaches the status mapping,
  // because it leaves inside an `ok:true` envelope (row above). The helper call
  // is therefore the only surface on which these two codes can be observed —
  // and the guard below is what makes classifying them non-optional.
  assert.equal(flowrouterRefusalStatus('PACKAGE_MANIFEST_MISSING'), 400, 'an input the operator must supply');
  assert.equal(flowrouterRefusalStatus('PACKAGE_MANIFEST_UNREADABLE'), 500, 'a local read that failed');
  assert.notEqual(
    flowrouterRefusalStatus('PACKAGE_MANIFEST_MISSING'),
    flowrouterRefusalStatus('PACKAGE_MANIFEST_UNREADABLE'),
    'missing and unreadable must not prescribe the same operator action',
  );
  // The house convention cannot change the status: this family also names the
  // same condition in lower-hyphen form.
  assert.equal(flowrouterRefusalStatus('package-manifest-unreadable'), 500);
});

test('status: the entrypoint split is two decisions, and INTEGRITY_FAIL keeps its own', () => {
  // Same surface, same reason as the row above: a stage refusal never reaches
  // the mapping over HTTP (it leaves inside an `ok:true` envelope), so the
  // helper call is where these decisions are observable.
  assert.equal(flowrouterRefusalStatus('INTEGRITY_ENTRYPOINT_MISSING'), 400, 'a package that declares a file it does not ship');
  assert.equal(flowrouterRefusalStatus('INTEGRITY_ENTRYPOINT_UNREADABLE'), 500, 'a local read that failed');
  assert.notEqual(
    flowrouterRefusalStatus('INTEGRITY_ENTRYPOINT_MISSING'),
    flowrouterRefusalStatus('INTEGRITY_ENTRYPOINT_UNREADABLE'),
  );
  // The third decision, and the one that keeps the split from swallowing the
  // code it came from: a digest verdict on bytes we DID read stays 409.
  assert.equal(flowrouterRefusalStatus('INTEGRITY_FAIL'), 409, 'a digest mismatch is still a do-not-retry verdict');
});

const teach = async (body) => {
  const res = await fetch(base + '/plugins/operator-ui/teach', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('promote: a registry READ failure is not a do-not-retry 409, and carries a code', async () => {
  // COUPLED ASSERTION. The code comes from lib/teach.js (the other half of the
  // ruling: promoteCandidate's registry read-failure returns). That half has
  // LANDED: promoteCandidate now returns a typed code for every refusal, and the
  // three registry-* spellings my guard's NOT_IN_SOURCE hand-list carries are the
  // literals it actually emits — so the hand-list is verified against the source
  // rather than assumed, which was the whole risk of hand-maintaining it. This
  // row was RED before that half landed, for the right reason. The assertion is
  // about the PROPERTY rather than about a spelling this file does not own, so
  // the two halves cannot agree on a code name and still disagree on behaviour:
  // an unmapped code falls through to the 409 fallthrough and fails here.
  // (Deliberately no line numbers: they drift, and a stale reference in a test
  // comment is its own small version of the defect this file is about.)
  await putConfig();
  await registryUnreadable();
  await upsertTask({
    taskId: 'teach_promote_probe',
    kind: 'teaching',
    status: 'candidate',
    verdict: 'CANDIDATE',
    candidate: { capabilityId: 'demo', version: '0.1.0', workflow: 'demo-v0-1-0', requires: [], requiresUnknown: [] },
    provenance: { builtBy: 'test' },
    evaluations: [],
  });
  const r = await teach({ promoteTaskId: 'teach_promote_probe' });
  assert.equal(typeof r.body.code, 'string', 'promoteCandidate must return a typed code for a registry READ failure (lib/teach.js) — this assertion IS the coupling to the other half of the ruling');
  assert.notEqual(r.status, 409, 'a registry read failure must never be a do-not-retry refusal');
  assert.equal(r.status, 500);
});

// ============================ 4. the FALLTHROUGH guard (the dangerous default)
// An unenumerated code silently inheriting 409 is the failure this whole family
// is about: 409 is the one status an outage must never receive, and it is
// exactly what a future code falls into by accident. This guard enumerates
// every code the producers can emit — derived from lib/flowrouter.js's own
// source so a new refusal cannot be added without being classified — and
// asserts each is either explicitly mapped or on the exported deliberate-409
// list. It does NOT change the fallthrough's behaviour.

// Codes that appear in the source but never reach the mapping, because they are
// DETAILS INSIDE another refusal's body rather than a refusal's own code. Each
// needs a reason: MUST_NOT_EXPORT rides inside EXPORT_LEAK_FORBIDDEN's
// `failures[]`, and the refusal's own code is EXPORT_LEAK_FORBIDDEN.
const NOT_A_REFUSAL_CODE = new Set(['MUST_NOT_EXPORT']);

// Codes a producer emits that the source scan cannot see: constants, `||`
// defaults, and codes thrown by a collaborator module and only carried here.
const NOT_IN_SOURCE = [
  // lib/equivocation.js's QUARANTINE_CODE, set on the quarantine refusal.
  'PUBLISHER_EQUIVOCATION_UNACKNOWLEDGED',
  // the publisher-auth catch's `e.code || 'PUBLISHER_AUTH_INVALID'` default.
  'PUBLISHER_AUTH_INVALID',
  // thrown by lib/identity.js and carried out by the publisher-auth catch.
  'SIGNED_STATEMENT_MISMATCH',
  'UNAUTHENTICATED',
  'SEQUENCE_ROLLBACK',
  'IDENTITY_HISTORY_FORK',
  'KEY_NOT_AUTHORIZED',
  // lib/tasks.js getTask's throw; reaches the flowrouter route catch.
  'ARCHON_UNAVAILABLE',
  // lib/teach.js promoteCandidate's refusals (task #54), in the family's
  // lower-hyphen convention. The mapping normalises, so the spelling cannot
  // change the STATUS — but it does change whether the check BELOW finds the
  // code in DELIBERATE_409_CODES, which does not normalise. So a code that
  // lands on the 409 fallthrough must be listed in its NORMALISED (upper-snake)
  // form, which is why the last entry looks different from its neighbours. The
  // two before it never reach the 409 branch (403 and 400), so their producer
  // spelling is safe.
  'authority-scopes-unknown',
  'registry-not-configured',
  'registry-missing',
  'registry-unreadable',
  'registry-malformed',
  'CAPABILITY_NOT_PROMOTED',
];

test('guard: every code the flowrouter producers can emit is a DECISION, not a fallthrough', async () => {
  const src = await readFile(new URL('../lib/flowrouter.js', import.meta.url), 'utf8');
  const emitted = new Set(NOT_IN_SOURCE);
  for (const m of src.matchAll(/\bcode:\s*'([A-Z][A-Z0-9_]*)'/g)) emitted.add(m[1]);
  for (const m of src.matchAll(/\brefuse\('([A-Z][A-Z0-9_]+)'/g)) emitted.add(m[1]);
  for (const c of NOT_A_REFUSAL_CODE) emitted.delete(c);

  // The scan must actually be reading the file it thinks it is: if a rename or
  // a regex slip emptied this set, the guard would pass vacuously.
  assert.ok(emitted.size >= 25, 'the source scan found only ' + emitted.size + ' codes — it is not reading the producers');

  const unclassified = [];
  for (const code of emitted) {
    const status = flowrouterRefusalStatus(code);
    if (status === 409) {
      if (!DELIBERATE_409_CODES.has(code)) unclassified.push(code + ' → 409 by FALLTHROUGH');
    } else {
      assert.ok([400, 403, 500, 502].includes(status), code + ' mapped to an unexpected status ' + status);
    }
  }
  assert.deepEqual(unclassified, [], 'these codes inherit the do-not-retry fallthrough without a decision: ' + unclassified.join(', '));
});

test('guard: the deliberate-409 list cannot contradict the mapping', async () => {
  // The inverse check, so the list stays load-bearing rather than decorative: a
  // code cannot be listed as a deliberate 409 AND mapped to another status.
  for (const code of DELIBERATE_409_CODES) {
    assert.equal(flowrouterRefusalStatus(code), 409, code + ' is listed as a deliberate 409 but the mapping says otherwise');
  }
});

// =============================== 5. the same guard for the TEACH family (#59)
// The scan above reads lib/flowrouter.js's OWN SOURCE, so it cannot see codes
// emitted by lib/teach.js — those are enumerated by hand in NOT_IN_SOURCE. That
// makes the list the one place a teach-family code can be forgotten, and a
// forgotten code does not go RED, it goes QUIET: this guard only checks what it
// enumerates, so a code added to a producer and not to the list is unchecked.
// This is the sibling assertion, so both halves of "every emitted code is a
// classification decision" live in one file and are read together.
//
// SCOPE, and it is narrower than "every code teach.js contains" on purpose.
// These are the codes that can actually REACH flowrouterRefusalStatus from the
// teach family: the six promoteCandidate returns, which arrive as `out.code` and
// therefore take the mapping's 409 default, plus getTask's thrown
// `archon-unavailable`, which the route catch passes 500 as a fallback and the
// mapping lifts to 502. Codes that ride INSIDE a teaching envelope —
// dispatch-rejected, dispatch-malformed, run-not-found, run-timeout,
// teaching-already-in-flight, and _teach's registry-not-configured /
// teaching-not-configured / source-not-found — never reach the mapping at all,
// because teachRCOS RETURNS an envelope and never throws one. Listing them here
// would assert something about a path that does not exist.
const TEACH_FAMILY_CODES = [
  'capability-not-promoted',   // 409 — the deliberate do-not-retry state conflict
  'authority-scopes-unknown',  // 403 — well-formed, not allowed
  'registry-not-configured',   // 400 — a request input the operator must set
  'registry-missing',          // 500 — local durable state
  'registry-unreadable',       // 500 — local durable state
  'registry-malformed',        // 500 — read successfully, unusable
  'archon-unavailable',        // 502 — a remote read that did not complete
];

test('guard: every code the TEACH family can reach the mapping with is a DECISION', async () => {
  // Non-empty, so a careless edit that empties the table cannot make this pass
  // vacuously — the failure mode the file's own source-scan guard calls out.
  assert.ok(TEACH_FAMILY_CODES.length >= 7, 'the teach-family table shrank to ' + TEACH_FAMILY_CODES.length + ' — this guard would pass vacuously');

  const unclassified = [];
  for (const code of TEACH_FAMILY_CODES) {
    const status = flowrouterRefusalStatus(code);
    if (status === 409) {
      // Normalise BEFORE consulting the list: the producers emit lower-hyphen
      // and the list holds normalised codes. Doing it the other way round is
      // exactly how a deliberate decision gets mistaken for a fallthrough.
      const normalised = String(code).toUpperCase().replace(/-/g, '_');
      if (!DELIBERATE_409_CODES.has(normalised)) unclassified.push(code + ' → 409 by FALLTHROUGH');
    } else {
      assert.ok([400, 403, 500, 502].includes(status), code + ' mapped to an unexpected status ' + status);
    }
  }
  assert.deepEqual(unclassified, [], 'these teach-family codes inherit the do-not-retry fallthrough without a decision: ' + unclassified.join(', '));
});

// The inverse check ("no DELIBERATE_409_CODES entry contradicts the mapping") is
// NOT duplicated here: the test above runs it over the WHOLE exported set, and
// CAPABILITY_NOT_PROMOTED is a member, so the teach family is already covered by
// it. A second copy would be a second thing to keep in step.

