// Transport-status regression suite: a refusal must reach the operator with
// BOTH its identity (a code) and a status that reflects the operator action —
// an unreadable read is never delivered as a do-not-retry business refusal, and
// a coded throw is never delivered anonymously.
//
// Defects covered, all one family (a read/throw that collapsed distinguishable
// facts into one value at the transport surface):
//   1. lib/index.js handleAdmission ended every refusal with
//      `out.ok ? sendJson(res, 200, out) : sendJson(res, 409, out)`, so
//      `admission-store-unreadable` (a LOCAL STORE READ failure) left the
//      process as 409 Conflict — byte-identical to a genuine "your envelope is
//      not admissible" refusal. 409 says DO NOT RETRY; the honest answer for an
//      unreadable store is "the machine is unwell — inspect, then retry".
//   2. lib/admission.js:110/:115 returned `{ok:false, error}` with NO code at
//      all, so those refusals arrived as 409 with `code: undefined`.
//   3. lib/admission.js:98 read the frozen workflow bytes with a bare
//      `catch { workflowBytes = null }`, so an UNREADABLE workflow (EISDIR)
//      was reported as `admission-workflow-bytes-missing` — the same code as a
//      genuinely absent one — and left as 409.
//   4. lib/index.js handleGoal's catch answered every unrecognised coded throw
//      with a bare 500 and DROPPED the code. That catch is the mechanism of the
//      whole family, so it is tested directly.
//
// Deterministic and in-process: the REAL plugin is booted through apply(ctx) on
// an ephemeral loopback port and driven over real HTTP, so the assertions are
// about the bytes a client actually receives — not about a helper's return
// value. Only $DSH_HOME is throwaway. No port is assumed free (the listener
// binds :0) and no sibling process is touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// $DSH_HOME is read per call (getDshHome()), so setting it before the first
// request is sufficient; it is set before the import too, for clarity.
const HOME = await mkdtemp(join(tmpdir(), 'admission-status-'));
process.env.DSH_HOME = HOME;

const ROUTE = '/plugins/operator-ui';
const ADMISSION = ROUTE + '/admission';
const STORE_DIR = join(HOME, 'operator-ui');
const TASKS = join(STORE_DIR, 'tasks.json');

test.after(async () => { await rm(HOME, { recursive: true, force: true }); });

// ------------------------------------------------- boot the REAL plugin
const routes = [];
const ctx = {
  webServer: { register(spec) { routes.push(spec); return () => {}; } },
  tools: { register() { return () => {}; } },
  effect(fn) { const t = fn(); return () => { if (typeof t === 'function') t(); }; },
};
const { apply } = await import('../lib/index.js');
apply(ctx);

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

const admit = async (body) => {
  const res = await fetch(base + ADMISSION, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

// Put the store into a known shape: a JSON string, or `null` for "no file".
const putStore = async (content) => {
  await rm(TASKS, { recursive: true, force: true });
  await mkdir(STORE_DIR, { recursive: true });
  if (content !== null) await writeFile(TASKS, content, 'utf8');
};

// ================================================= 1. the unreadable store
// A store that EXISTS but cannot be read is an outage of the operator's own
// durable state — never the business verdict "this envelope is not admissible".

test('admission: a store that exists but cannot be READ is not a 409 business refusal', async () => {
  // Wrong behaviour this prevents: a directory sitting where tasks.json should
  // be is a READ failure (EISDIR), and the route answered 409 Conflict — the
  // same status as a genuine inadmissible envelope — telling the operator not
  // to retry a condition whose only remedy is to inspect and retry.
  await rm(TASKS, { recursive: true, force: true });
  await mkdir(TASKS, { recursive: true }); // exists, but unreadable as a file
  const r = await admit({ goalTaskId: 'goal-any' });
  assert.equal(r.body.code, 'admission-store-unreadable');
  assert.notEqual(r.status, 409, 'an unreadable store must never be a do-not-retry business refusal');
  assert.equal(r.status, 500);
});

test('admission: a MALFORMED store is an unreadable store, not a business refusal', async () => {
  // Wrong behaviour this prevents: a store we cannot PARSE was delivered as the
  // same 409 as a store we parsed and found wanting — two different operator
  // actions ("repair the store" vs "fix your request") behind one status.
  await putStore('{ this is not json');
  const r = await admit({ goalTaskId: 'goal-any' });
  assert.equal(r.body.code, 'admission-store-unreadable');
  assert.notEqual(r.status, 409);
  assert.equal(r.status, 500);
});

test('admission: a store with no tasks array is an unreadable store, not a business refusal', async () => {
  await putStore(JSON.stringify({ operatorUi: 1, tasks: 'nope' }));
  const r = await admit({ goalTaskId: 'goal-any' });
  assert.equal(r.body.code, 'admission-store-unreadable');
  assert.notEqual(r.status, 409);
});

// ============================================ 2. the genuine business refusal
// The fix must not turn every refusal into a 5xx: an ANSWERED, readable store
// that simply holds no such goal is a real "do not retry this id" conflict.

test('admission: a GENUINE business refusal is still 409 (control)', async () => {
  await putStore(JSON.stringify({ tasks: [] }));
  const r = await admit({ goalTaskId: 'goal-absent' });
  assert.equal(r.body.code, 'admission-goal-not-found');
  assert.equal(r.status, 409);
});

test('admission: unreadable-store and absent-goal differ by STATUS, not only by code', async () => {
  // The point of the whole fix: two facts that used to share one transport
  // status now differ AT the transport layer, so a client that reads only the
  // status still knows whether retrying can help.
  await putStore(JSON.stringify({ tasks: [] }));
  const absent = await admit({ goalTaskId: 'goal-absent' });
  await rm(TASKS, { recursive: true, force: true });
  await mkdir(TASKS, { recursive: true });
  const unreadable = await admit({ goalTaskId: 'goal-any' });
  assert.equal(absent.body.code, 'admission-goal-not-found');
  assert.equal(unreadable.body.code, 'admission-store-unreadable');
  assert.notEqual(unreadable.status, absent.status, 'the two facts must not share a status');
  assert.equal(absent.status, 409);
  assert.notEqual(unreadable.status, 409);
});

// ============================================ 3. the unreadable REGISTRY
// Same class, one read further in: a configured registry that cannot be read
// (or is present but unusable) is a read failure, not a verdict about readable
// data. These refusals used to carry NO code at all and fell through to the
// same 409 default — the collapse surviving one line away from the one being
// fixed, and with no identity for the operator either.

const WORKFLOW = 'admission-status-wf';
const REGISTRY = join(HOME, 'registry.json');
const WORKFLOWS = join(HOME, 'workflows');
const WORKFLOW_YAML = () => join(WORKFLOWS, WORKFLOW + '.yaml');
const GOAL_ID = 'goal-admission-status';

// The SHIP envelope shaped after the accepted P6D goal record: only the fields
// admission reads are populated.
function shipEnvelope() {
  return {
    taskId: GOAL_ID,
    kind: 'goal',
    objective: 'verify the admission transport status',
    status: 'closed',
    verdict: 'SHIP',
    failureCodes: [],
    error: null,
    route: { selected: { id: 'verify-admission-status', version: '1.0.0', workflow: WORKFLOW, lifecycle: 'active' } },
    attempts: [{ attempt: 1, workflow: WORKFLOW, runId: 'run-admission-status', status: 'completed' }],
    capabilityValidation: { pass: true, checks: [{ id: 'terminal-status', pass: true }] },
    objectiveEvaluation: { status: 'SATISFIED', pass: true, checks: [{ id: 'contains:sentinel:one', pass: true, expected: 'sentinel:one' }] },
    authority: { preset: 'AUTO_WITHIN_POLICY', requires: [], granted: [], missing: [], mode: 'auto' },
    workspace: { workspaceId: 'ws-admission-status', name: 'ws', owner: 'alice' },
    executionEnvironment: {
      environmentId: 'env-admission-status',
      establishedBy: 'adopted-run',
      worker: {
        establishedBy: 'bridge-receipt',
        id: 'brg_adee94a83cb5800b358a2be7fc7de345',
        environmentId: 'env-admission-status-solari',
        receiptSha256: 'sha256:4b3d340eb03c9b127caf7a1e341964566e4aea8d448057677709b7c830404a57',
      },
    },
  };
}

// Lay down the fixture the registry read needs: a config naming the registry
// and the teaching workflows dir, the frozen workflow bytes, and a readable
// store holding one SHIP goal.
async function putRegistryFixture() {
  await mkdir(WORKFLOWS, { recursive: true });
  await writeFile(WORKFLOW_YAML(), 'name: ' + WORKFLOW + '\nkind: loop\nnodes: []\n', 'utf8');
  await writeFile(join(HOME, 'operator-ui.config.json'), JSON.stringify({
    configVersion: 1,
    registry: { path: REGISTRY, schema: 'rcos-public-v1', maxBytes: 200000 },
    teaching: { workflowsDir: WORKFLOWS, workspaceDir: join(HOME, 'teach-ws') },
  }, null, 2) + '\n', 'utf8');
  await putStore(JSON.stringify({ tasks: [shipEnvelope()] }));
  await rm(REGISTRY, { recursive: true, force: true });
  await writeFile(REGISTRY, JSON.stringify({ registry_version: 'v1', capabilities: [] }, null, 2) + '\n', 'utf8');
}

const admitGoal = () => admit({
  goalTaskId: GOAL_ID, requires: [],
  description: 'admission transport status probe', tags: ['admission', 'status'],
});

test('admission: the fixture reaches the registry read and admits (200 control)', async () => {
  // Without this control the two failure cases below could pass for the wrong
  // reason (e.g. failing earlier at a gate and never touching the registry).
  await putRegistryFixture();
  const r = await admitGoal();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  // The mapping must never INVENT identity: a success carries no refusal code.
  assert.equal(r.body.code, undefined, 'a successful admission must not carry a refusal code');
});

test('admission: a registry that exists but cannot be READ is not a 409 business refusal', async () => {
  // Wrong behaviour this prevents: a configured-but-unreadable registry is a
  // READ failure, and it used to leave as 409 with NO code at all — the same
  // status as a genuine inadmissible envelope, and no identity for the operator.
  await putRegistryFixture();
  await rm(REGISTRY, { recursive: true, force: true });
  await mkdir(REGISTRY, { recursive: true }); // exists, unreadable as a file
  const r = await admitGoal();
  assert.equal(r.body.code, 'admission-registry-unreadable');
  assert.notEqual(r.status, 409);
  assert.equal(r.status, 500);
});

test('admission: a registry present but MALFORMED is not a 409 business refusal', async () => {
  // Wrong behaviour this prevents: a registry we cannot USE was delivered as a
  // bare refusal with no code — "present but unusable" and "you may not do
  // this" collapsed into one 409 with nothing to act on.
  await putRegistryFixture();
  await rm(REGISTRY, { recursive: true, force: true });
  await writeFile(REGISTRY, JSON.stringify({ registry_version: 'v1' }, null, 2) + '\n', 'utf8');
  const r = await admitGoal();
  assert.equal(r.body.code, 'admission-registry-malformed');
  assert.notEqual(r.status, 409);
  assert.equal(r.status, 500);
});

test('admission: every READ-failure code and every business code stay distinguishable', async () => {
  // The invariant in one place: three read failures (store, registry read,
  // registry shape) share 500 and never 409; a genuine business refusal keeps
  // 409. A client reading only the status can still choose retry vs repair.
  await putRegistryFixture();
  await rm(REGISTRY, { recursive: true, force: true });
  await mkdir(REGISTRY, { recursive: true });
  const registryRead = await admitGoal();

  await putStore(JSON.stringify({ tasks: [] }));
  const absent = await admit({ goalTaskId: GOAL_ID, requires: [], description: 'x', tags: ['a'] });

  assert.equal(registryRead.status, 500);
  assert.equal(absent.status, 409);
  assert.notEqual(registryRead.status, absent.status);
});

// ====================================== 4. the UNREADABLE workflow bytes
// `try { readFile } catch { workflowBytes = null }` made an unreadable frozen
// workflow indistinguishable from an absent one: both were reported as
// `admission-workflow-bytes-missing` and both left as the do-not-retry 409.
// ENOENT is a genuine absence; anything else is a read failure.

test('admission: workflow bytes that are ABSENT stay admission-workflow-bytes-missing (409)', async () => {
  await putRegistryFixture();
  await rm(WORKFLOW_YAML(), { recursive: true, force: true }); // genuinely gone
  const r = await admitGoal();
  assert.equal(r.body.code, 'admission-workflow-bytes-missing');
  assert.equal(r.status, 409, 'an authoritative absence is still a do-not-retry conflict');
});

test('admission: workflow bytes that exist but cannot be READ are their own code and not a 409', async () => {
  // Wrong behaviour this prevents: a directory where the frozen workflow should
  // be is a READ failure (EISDIR), and it was reported as "workflow bytes not
  // found" — telling the operator the workflow does not exist when the truth is
  // we could not read it — and delivered as a do-not-retry 409.
  await putRegistryFixture();
  await rm(WORKFLOW_YAML(), { recursive: true, force: true });
  await mkdir(WORKFLOW_YAML(), { recursive: true }); // exists, unreadable as a file
  const r = await admitGoal();
  assert.equal(r.body.code, 'admission-workflow-unreadable');
  assert.notEqual(r.body.code, 'admission-workflow-bytes-missing', 'unreadable must not be reported as absent');
  assert.notEqual(r.status, 409);
  assert.equal(r.status, 500);
});

// ============================ 5. the goal route's catch must not erase identity
// lib/index.js handleGoal's catch answered every unrecognised coded throw with a
// bare 500 and dropped the code. That catch is the MECHANISM of this whole
// defect family — a refusal arriving anonymously — so it is driven directly
// rather than trusted.

test('goal: a coded throw escaping the pipeline keeps its CODE in the response', async () => {
  // Wrong behaviour this prevents: the throw reached the transport, the catch
  // discarded `e.code`, and the operator received a bare 500 with an
  // unidentifiable error string — the same erasure that made an unreadable
  // store byte-identical to a business refusal.
  //
  // The driver is a real production path, not an injection: a retry whose
  // parent lookup cannot reach Archon throws `archon-unavailable` from
  // lib/goal.js's PRE-try setup (getTask's reconciling read), so it genuinely
  // escapes the pipeline's own recording catch and lands in the route's catch.
  // archon.baseUrl is pinned to a closed port so the failure is deterministic
  // and nothing else listening on 3090 can change the outcome.
  await writeFile(join(HOME, 'operator-ui.config.json'), JSON.stringify({
    configVersion: 1,
    archon: { baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 },
  }, null, 2) + '\n', 'utf8');
  await putStore(JSON.stringify({ tasks: [] }));
  const res = await fetch(base + ROUTE + '/goal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ retryOf: 'task-that-does-not-exist' }),
  });
  const body = await res.json().catch(() => null);
  assert.equal(res.status, 500);
  assert.equal(body.code, 'archon-unavailable', 'the code must survive the catch');
});



