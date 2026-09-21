// S2-R conversation-identity integration tests (GPT work order "S2 Discrepancy
// Review", section C + the 9 required validation cases).
//
// Everything runs against scripts/mock-archon.mjs on a dedicated port — never
// 3090, never the dev-host. Each case runs in its OWN child process with a fresh
// DSH_HOME: the lib caches task envelopes in module state, so restart and
// idempotence semantics only prove anything across real process boundaries.
// The mock's admin routes count creation/dispatch POSTs, so every refusal case
// is asserted not just on its failure code but on ZERO dispatches.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = 13777;
const BASE = 'http://127.0.0.1:' + PORT;
const PROJECT = 'p1x-csv-fixture';
const P1_ID = 'dc92aa5a4a569d452a2fa65a2a0e2053';

// One capability, routable ONLY by the test objective "verify echo running
// total seed values" (all six tokens land in tags/description — 6/6 hits,
// score 1.0, clearing both routeObjective thresholds). requires shell:execute
// + the ASK_BEFORE_ACTION preset is what makes the approval gate bite.
const REGISTRY = {
  registry_version: 'v1',
  capabilities: [
    {
      id: 'verify-echo',
      name: 'Verify echo',
      description: 'Deterministic seeded echo verification for running totals',
      version: '1.0.0',
      status: 'active',
      workflow: 'verify-echo-v1',
      tags: ['verify', 'echo', 'running', 'total', 'seed', 'values'],
      requires: ['shell:execute'],
      verification: { terminalStatus: 'completed', expectOutput: 'rcos-verify-seed:rcos-verify-echo-v1' },
      objectiveEvaluation: { kind: 'output-contains', value: 'rcos-verify-seed:rcos-verify-echo-v1' },
    },
  ],
};

let tmpRoot;
let registryPath;
let mockProc;

const newHome = async (name) => {
  const dir = join(tmpRoot, 'home-' + name);
  await mkdir(dir, { recursive: true });
  return dir;
};

const postJson = async (path, body) => {
  const resp = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error('POST ' + path + ' → HTTP ' + resp.status);
  return resp.json();
};

const mockCalls = async () => {
  const b = await (await fetch(BASE + '/api/_mock/calls')).json();
  return { createPosts: b.createPosts, dispatchPosts: b.dispatchPosts };
};

// Spawn the case child and parse the LAST stdout line as its JSON result.
async function runCase(caseName, home, arg, timeoutMs = 60000) {
  const args = [join(ROOT, 'test', 'conversation-case.mjs'), caseName, home];
  if (arg !== undefined) args.push(JSON.stringify(arg));
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      DSH_OPERATOR_UI_ARCHON: BASE,
      DSH_OPERATOR_UI_REGISTRY: registryPath,
      DSH_OPERATOR_UI_AUTHORITY_PRESET: 'ASK_BEFORE_ACTION',
      DSH_HOME: home,
    },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('case ' + caseName + ' timed out after ' + timeoutMs + 'ms\nstderr: ' + err));
    }, timeoutMs);
    child.on('exit', (c) => { clearTimeout(t); resolve(c); });
    child.on('error', (e) => { clearTimeout(t); reject(e); });
  });
  assert.equal(code, 0, 'case ' + caseName + ' exited ' + code + '\nstderr: ' + err);
  const lines = out.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 's2r-conversation-'));
  registryPath = join(tmpRoot, 'registry.json');
  await writeFile(registryPath, JSON.stringify(REGISTRY, null, 2));

  // Refuse to run against a stale mock on our port: leftover state would
  // corrupt the call-count deltas.
  let stale = false;
  try { stale = (await fetch(BASE + '/api/health')).ok; } catch {}
  if (stale) throw new Error('a mock archon is already listening on 127.0.0.1:' + PORT + ' — kill it first');

  mockProc = spawn(process.execPath, [join(ROOT, 'scripts', 'mock-archon.mjs'), String(PORT)], { stdio: 'ignore' });
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      if ((await fetch(BASE + '/api/health')).ok) return;
    } catch {}
    if (Date.now() > deadline) throw new Error('mock archon failed to start on :' + PORT);
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(async () => {
  if (mockProc) mockProc.kill('SIGKILL');
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

test('cases 1+2: new objective provisions once; a valid association is reused, never re-created', async () => {
  const calls0 = await mockCalls();
  const r = await runCase('provision-new', await newHome('provision-new'));
  assert.equal(r.ok, true);
  assert.equal(r.reused, false);
  assert.match(r.conversationId, /^web-/);
  assert.equal(r.codebaseId, P1_ID);
  const calls1 = await mockCalls();
  assert.equal(calls1.createPosts - calls0.createPosts, 1);
  assert.equal(calls1.dispatchPosts, calls0.dispatchPosts);

  const home2 = await newHome('provision-reuse');
  const r2 = await runCase('provision-reuse', home2);
  assert.equal(r2.ok, true);
  assert.equal(r2.reused, true);
  assert.equal(r2.conversationId, r2.firstId);
  assert.equal(r2.persistedId, r2.firstId);
  const calls2 = await mockCalls();
  assert.equal(calls2.createPosts - calls1.createPosts, 1); // ONE create across TWO provisions
  assert.equal(calls2.dispatchPosts, calls1.dispatchPosts);
});

test('case 3: approved dispatch on a bound conversation ships exactly once', async () => {
  const calls0 = await mockCalls();
  const r = await runCase('dispatch-happy', await newHome('dispatch-happy'));
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'SHIP');
  assert.equal(r.workflow, 'verify-echo-v1');
  assert.deepEqual(r.failureCodes, []);
  assert.match(r.runId, /^run-mock-verify-/);
  assert.match(r.conversationId, /^web-/);
  const detail = await (await fetch(BASE + '/api/workflows/runs/' + r.runId)).json();
  assert.equal(detail.run.conversation_id, r.conversationId);
  assert.equal(detail.run.workflow_name, 'verify-echo-v1');
  assert.equal(detail.run.working_path, '/home/<redacted>/p1x-ws');
  const calls1 = await mockCalls();
  assert.equal(calls1.createPosts - calls0.createPosts, 1);
  assert.equal(calls1.dispatchPosts - calls0.dispatchPosts, 1);
});

test('case 4: a conversation re-bound to the wrong project blocks before any dispatch', async () => {
  const calls0 = await mockCalls();
  const r = await runCase('dispatch-wrong-project', await newHome('wrong-project'));
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'FAILED');
  assert.deepEqual(r.failureCodes, ['conversation-bound-wrong-project']);
  assert.equal(r.attempts, 0);
  const calls1 = await mockCalls();
  assert.equal(calls1.dispatchPosts, calls0.dispatchPosts); // gate refused BEFORE the dispatch POST
});

test('case 5: missing and dangling associations both block before any dispatch', async () => {
  const calls0 = await mockCalls();

  const a = await runCase('dispatch-unbound-a', await newHome('unbound-a'));
  assert.equal(a.ok, true);
  assert.equal(a.verdict, 'FAILED');
  assert.deepEqual(a.failureCodes, ['conversation-not-bound']);
  assert.equal(a.attempts, 0);

  // 5b: a persisted association whose conversation no longer exists.
  const homeB = await newHome('unbound-b');
  const seed = await runCase('seed-custom', homeB, {
    taskId: 'task-2468ace0',
    conversation: {
      archonConversationId: 'web-orphan0001',
      provisioningState: 'associated',
      projectName: PROJECT,
      expectedCodebaseId: P1_ID,
      boundAt: new Date().toISOString(),
    },
  });
  assert.equal(seed.ok, true);
  const b = await runCase('dispatch-unbound-b', homeB, { taskId: 'task-2468ace0' });
  assert.equal(b.ok, true);
  assert.equal(b.verdict, 'FAILED');
  assert.deepEqual(b.failureCodes, ['conversation-association-dangling']);
  assert.equal(b.attempts, 0);

  const calls1 = await mockCalls();
  assert.equal(calls1.dispatchPosts, calls0.dispatchPosts); // zero dispatches across both refusals
});

test('case 6: the association survives a process restart — the SAME conversation is recovered', async () => {
  const calls0 = await mockCalls();
  const home = await newHome('restart');
  const a = await runCase('restart-a', home);
  assert.equal(a.ok, true);
  const b = await runCase('restart-b', home); // NEW process, same DSH_HOME, no re-seed
  assert.equal(b.ok, true);
  assert.equal(b.reused, true);
  assert.equal(b.conversationId, a.conversationId);
  const calls1 = await mockCalls();
  assert.equal(calls1.createPosts - calls0.createPosts, 1); // ONE creation across TWO processes
});

test('case 7: an unresolved intent refuses re-provisioning — no duplicate creation POST', async () => {
  const calls0 = await mockCalls();
  const r = await runCase('intent-orphan', await newHome('intent-orphan'));
  assert.equal(r.ok, true);
  assert.equal(r.error.code, 'conversation-provision-unresolved');
  const calls1 = await mockCalls();
  assert.equal(calls1.createPosts, calls0.createPosts); // intent state blocks the creation call
});

test('case 8: a pending objective without human approval dispatches nothing', async () => {
  const calls0 = await mockCalls();
  const r = await runCase('no-approval', await newHome('no-approval'));
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'PENDING');
  assert.deepEqual(r.failureCodes, ['awaiting-approval']);
  assert.equal(r.envelopeStatus, 'awaiting-approval');
  assert.equal(r.attempts, 0);
  const calls1 = await mockCalls();
  assert.equal(calls1.createPosts, calls0.createPosts);
  assert.equal(calls1.dispatchPosts, calls0.dispatchPosts);
});

test('case 9a: T1 — the run adopted is the exact bound-conversation + workflow match, under decoys', async () => {
  const calls0 = await mockCalls();
  const home = await newHome('t1-success');
  const p = await runCase('provision-only', home, { taskId: 'task-5150beef' });
  assert.equal(p.ok, true);
  const convId = p.conversationId;

  // Decoy A: right workflow, WRONG conversation — the workflow-name-only
  // fallback GPT prohibited would have adopted this one.
  await postJson('/api/_mock/delay-next-dispatch', { ms: 400 });
  const decoyA = await postJson('/api/_mock/seed-run', { conversationId: 'rcos-task-deadbeef', workflowName: 'verify-echo-v1', delayMs: 600 });
  // Decoy B: right conversation, WRONG workflow.
  const decoyB = await postJson('/api/_mock/seed-run', { conversationId: convId, workflowName: 'example-echo-ground-v1', delayMs: 700 });

  const r = await runCase('dispatch-only', home, { taskId: 'task-5150beef' });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'SHIP');
  assert.equal(r.conversationId, convId);
  assert.equal(r.workflow, 'verify-echo-v1');
  assert.notEqual(r.runId, decoyA.id);
  assert.notEqual(r.runId, decoyB.id);
  assert.match(r.runId, /^run-mock-verify-/);
  assert.equal(r.adoption.mode, 'direct-exact');
  assert.equal(r.adoption.verifiedFrom, 'run-detail');
  assert.equal(r.adoption.childConversationId, convId);
  const detail = await (await fetch(BASE + '/api/workflows/runs/' + r.runId)).json();
  assert.equal(detail.run.conversation_id, convId);
  assert.equal(detail.run.workflow_name, 'verify-echo-v1');
  assert.equal(detail.run.working_path, '/home/<redacted>/p1x-ws');
  const calls1 = await mockCalls();
  assert.equal(calls1.createPosts - calls0.createPosts, 1);
  assert.equal(calls1.dispatchPosts - calls0.dispatchPosts, 1);
});

test('case 9b: T1 — a wrong-workflow run on the bound conversation is refused and named', async () => {
  const calls0 = await mockCalls();
  const home = await newHome('t1-mismatch');
  const p = await runCase('provision-only', home, { taskId: 'task-beefcafe' });
  assert.equal(p.ok, true);

  // The dispatch is accepted but never materializes; a wrong-workflow run
  // lands on the bound conversation AFTER the child's pre-dispatch snapshot
  // so the mismatch path (not the snapshot filter) is what catches it.
  await postJson('/api/_mock/drop-next-dispatch', {});
  const stray = await postJson('/api/_mock/seed-run', { conversationId: p.conversationId, workflowName: 'example-echo-ground-v1', delayMs: 2500 });

  const r = await runCase('dispatch-only', home, { taskId: 'task-beefcafe' }, 90000);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'FAILED');
  assert.deepEqual(r.failureCodes, ['workflow-name-mismatch']);
  assert.equal(r.runId, null);
  assert.equal(r.adoption, null);
  assert.match(r.error, new RegExp(stray.id));
  assert.match(r.error, /example-echo-ground-v1/);
  assert.match(r.error, /verify-echo-v1/);
  const calls1 = await mockCalls();
  assert.equal(calls1.createPosts - calls0.createPosts, 1);
  assert.equal(calls1.dispatchPosts - calls0.dispatchPosts, 1); // accepted, but no run ever appeared
});

// ---- OP-4R Phase A: revised-T1 adoption controls ----
//
// The dispatch POST returns an acceptance, not a run. These cases prove the
// adoption modes and every failure shape the work order required: parent-linked
// adoption verified from run detail alone, the ambiguity refusal, per-leg
// rejection naming, the pre-dispatch snapshot boundary (history is never
// adopted), list-vs-detail projection trust, and a durable association that is
// never overwritten by a child id.

const OBJECTIVE_TEXT = 'verify echo running total seed values';
const taskMsg = (taskId) => 'task ' + taskId + ': ' + OBJECTIVE_TEXT;
const SEED_OUTPUT = 'rcos-verify-seed:rcos-verify-echo-v1';

// A fork-style seeded child: linkage lives ON the run record (parent legs),
// exactly like the real OP-4 child whose conversation row does not exist.
// delayMs 2500 lands it AFTER the case child's pre-dispatch snapshot but well
// inside the 10s adoption deadline.
const seedChild = (over) => postJson('/api/_mock/seed-run', {
  status: 'completed',
  output: SEED_OUTPUT,
  workflowName: 'verify-echo-v1',
  delayMs: 2500,
  ...over,
});

const waitRow = async (runId, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const b = await (await fetch(BASE + '/api/workflows/runs?limit=50')).json();
    const row = (b.runs || []).find((x) => x && x.id === runId);
    if (row) return row;
    if (Date.now() > deadline) throw new Error('run ' + runId + ' never appeared in the list');
    await new Promise((r) => setTimeout(r, 150));
  }
};

test('case 9c: T1 — a parent-linked child is adopted on five verified legs, association intact', async () => {
  const calls0 = await mockCalls();
  const home = await newHome('t1-parent-linked');
  const p = await runCase('provision-only', home, { taskId: 'task-9c0a1111' });
  assert.equal(p.ok, true);
  assert.equal(typeof p.dbId, 'string');
  assert.match(p.dbId, /^db-/);

  // The dispatch materializes ONLY a child whose conversation row does not
  // exist — linkage is provable from the run detail alone.
  await postJson('/api/_mock/fork-next-dispatch', { count: 1 });
  const r = await runCase('dispatch-only', home, { taskId: 'task-9c0a1111' }, 90000);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'SHIP');
  assert.equal(r.adoption.mode, 'parent-linked');
  assert.equal(r.adoption.verifiedFrom, 'run-detail');
  assert.match(r.runId, /^run-mock-child-/);
  assert.equal(r.runId, r.adoption.runId);
  assert.match(r.childConversationId, /^web-child-/);
  assert.notEqual(r.childConversationId, p.conversationId);
  assert.equal(r.adoption.boundConversationId, p.conversationId);
  assert.equal(r.adoption.parentConversationId, p.dbId);
  assert.equal(r.adoption.parentPlatformId, p.conversationId);
  assert.equal(r.adoption.codebaseId, P1_ID);
  assert.equal(r.adoption.userMessage, taskMsg('task-9c0a1111'));
  assert.equal(r.adoption.candidatesConsidered, 1);
  assert.match(r.adoption.detailSha256, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(r.adoption.evidence.map((e) => e.id),
    ['workflow-name', 'parent-conversation-id', 'parent-platform-id', 'codebase-id', 'user-message']);
  assert.ok(r.adoption.evidence.every((e) => e.pass === true));

  // Independent retrieval: the detail carries every leg, and the child
  // conversation genuinely has no row (404), like the real child.
  const detail = await (await fetch(BASE + '/api/workflows/runs/' + r.runId)).json();
  assert.equal(detail.run.conversation_id, r.childConversationId);
  assert.equal(detail.run.parent_conversation_id, p.dbId);
  assert.equal(detail.run.parent_platform_id, p.conversationId);
  const childRes = await fetch(BASE + '/api/conversations/' + r.childConversationId);
  assert.equal(childRes.status, 404);

  // The durable association is still the PARENT in both namespaces.
  assert.equal(r.persistedConversation.archonConversationId, p.conversationId);
  assert.equal(r.persistedConversation.dbId, p.dbId);

  const calls1 = await mockCalls();
  assert.equal(calls1.createPosts - calls0.createPosts, 1);
  assert.equal(calls1.dispatchPosts - calls0.dispatchPosts, 1);
});

test('case 9d: T1 — two runs both proving the dispatch refuse adoption as ambiguous', async () => {
  const calls0 = await mockCalls();
  const home = await newHome('t1-ambiguous');
  const p = await runCase('provision-only', home, { taskId: 'task-9d0a2222' });
  assert.equal(p.ok, true);

  await postJson('/api/_mock/fork-next-dispatch', { count: 2 });
  const r = await runCase('dispatch-only', home, { taskId: 'task-9d0a2222' }, 90000);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'FAILED');
  assert.deepEqual(r.failureCodes, ['run-ambiguous']);
  assert.equal(r.runId, null);
  assert.equal(r.adoption, null);
  assert.equal(new Set(r.error.match(/run-mock-child-\d+/g) || []).size, 2);
  // The durable association survives the refusal untouched.
  assert.equal(r.persistedConversation.archonConversationId, p.conversationId);
  assert.equal(r.persistedConversation.dbId, p.dbId);
  const calls1 = await mockCalls();
  assert.equal(calls1.createPosts - calls0.createPosts, 1);
  assert.equal(calls1.dispatchPosts - calls0.dispatchPosts, 1);
});

test('case 9e: T1 — a child with a wrong parent db id is refused, leg named', async () => {
  const calls0 = await mockCalls();
  const home = await newHome('t1-wrong-parent-db');
  const p = await runCase('provision-only', home, { taskId: 'task-9e0a3333' });
  assert.equal(p.ok, true);

  await postJson('/api/_mock/drop-next-dispatch', {});
  const seed = await seedChild({
    conversationId: 'rcos-child-wrongdb',
    parentConversationId: 'db-not-ours',
    parentPlatformId: p.conversationId,
    codebaseId: P1_ID,
    message: taskMsg('task-9e0a3333'),
  });
  const r = await runCase('dispatch-only', home, { taskId: 'task-9e0a3333' }, 90000);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'FAILED');
  assert.deepEqual(r.failureCodes, ['run-not-found']);
  assert.equal(r.runId, null);
  assert.equal(r.adoption, null);
  const rej = ((r.discovery && r.discovery.rejected) || []).find((x) => x.id === seed.id);
  assert.ok(rej, 'the poisoned child was never considered');
  assert.match(rej.reason, /parent-conversation-id/);
  assert.equal(rej.childConversationId, 'rcos-child-wrongdb');
  const calls1 = await mockCalls();
  assert.equal(calls1.createPosts - calls0.createPosts, 1);
  assert.equal(calls1.dispatchPosts - calls0.dispatchPosts, 1);
});

test('case 9f: T1 — a child with a wrong parent platform id is refused, leg named', async () => {
  const calls0 = await mockCalls();
  const home = await newHome('t1-wrong-platform');
  const p = await runCase('provision-only', home, { taskId: 'task-9f0a4444' });
  assert.equal(p.ok, true);

  await postJson('/api/_mock/drop-next-dispatch', {});
  const seed = await seedChild({
    conversationId: 'rcos-child-wrongplat',
    parentConversationId: p.dbId,
    parentPlatformId: 'web-wrongplatform',
    codebaseId: P1_ID,
    message: taskMsg('task-9f0a4444'),
  });
  const r = await runCase('dispatch-only', home, { taskId: 'task-9f0a4444' }, 90000);
  assert.equal(r.verdict, 'FAILED');
  assert.deepEqual(r.failureCodes, ['run-not-found']);
  assert.equal(r.adoption, null);
  const rej = ((r.discovery && r.discovery.rejected) || []).find((x) => x.id === seed.id);
  assert.ok(rej, 'the poisoned child was never considered');
  assert.match(rej.reason, /parent-platform-id/);
  const calls1 = await mockCalls();
  assert.equal(calls1.dispatchPosts - calls0.dispatchPosts, 1);
});

test('case 9g: T1 — a child from the wrong project is refused, leg named', async () => {
  const calls0 = await mockCalls();
  const home = await newHome('t1-wrong-project-child');
  const p = await runCase('provision-only', home, { taskId: 'task-9g0a5555' });
  assert.equal(p.ok, true);

  await postJson('/api/_mock/drop-next-dispatch', {});
  const seed = await seedChild({
    conversationId: 'rcos-child-wrongproj',
    parentConversationId: p.dbId,
    parentPlatformId: p.conversationId,
    codebaseId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
    message: taskMsg('task-9g0a5555'),
  });
  const r = await runCase('dispatch-only', home, { taskId: 'task-9g0a5555' }, 90000);
  assert.equal(r.verdict, 'FAILED');
  assert.deepEqual(r.failureCodes, ['run-not-found']);
  assert.equal(r.adoption, null);
  const rej = ((r.discovery && r.discovery.rejected) || []).find((x) => x.id === seed.id);
  assert.ok(rej, 'the poisoned child was never considered');
  assert.match(rej.reason, /codebase-id/);
  const calls1 = await mockCalls();
  assert.equal(calls1.dispatchPosts - calls0.dispatchPosts, 1);
});

test('case 9h: T1 — a wrong-workflow child of the correct parent is never adoptable', async () => {
  const calls0 = await mockCalls();
  const home = await newHome('t1-wrongwf-child');
  const p = await runCase('provision-only', home, { taskId: 'task-9h0a6666' });
  assert.equal(p.ok, true);

  await postJson('/api/_mock/drop-next-dispatch', {});
  await seedChild({
    conversationId: 'rcos-child-wrongwf',
    workflowName: 'example-echo-ground-v1',
    parentConversationId: p.dbId,
    parentPlatformId: p.conversationId,
    codebaseId: P1_ID,
    message: taskMsg('task-9h0a6666'),
  });
  const r = await runCase('dispatch-only', home, { taskId: 'task-9h0a6666' }, 90000);
  assert.equal(r.verdict, 'FAILED');
  assert.deepEqual(r.failureCodes, ['run-not-found']);
  assert.equal(r.adoption, null);
  // Excluded by the workflow-name filter BEFORE linkage: nothing reached the
  // leg checks (9b's mismatch diagnostic does not fire — the stray is on a
  // CHILD conversation, not ours).
  assert.equal(r.discovery.rejected.length, 0);
  assert.equal(r.error, 'dispatch accepted but no run appeared');
  const calls1 = await mockCalls();
  assert.equal(calls1.dispatchPosts - calls0.dispatchPosts, 1);
});

test('case 9i: T1 — a child carrying a different user_message is refused, leg named', async () => {
  const calls0 = await mockCalls();
  const home = await newHome('t1-wrong-message');
  const p = await runCase('provision-only', home, { taskId: 'task-9i0a7777' });
  assert.equal(p.ok, true);

  await postJson('/api/_mock/drop-next-dispatch', {});
  const seed = await seedChild({
    conversationId: 'rcos-child-wrongmsg',
    parentConversationId: p.dbId,
    parentPlatformId: p.conversationId,
    codebaseId: P1_ID,
    message: 'task task-9i0a7777: something else entirely',
  });
  const r = await runCase('dispatch-only', home, { taskId: 'task-9i0a7777' }, 90000);
  assert.equal(r.verdict, 'FAILED');
  assert.deepEqual(r.failureCodes, ['run-not-found']);
  assert.equal(r.adoption, null);
  const rej = ((r.discovery && r.discovery.rejected) || []).find((x) => x.id === seed.id);
  assert.ok(rej, 'the poisoned child was never considered');
  assert.match(rej.reason, /user-message/);
  const calls1 = await mockCalls();
  assert.equal(calls1.dispatchPosts - calls0.dispatchPosts, 1);
});

test('case 9j: T1 — a provably-linked run that predates the dispatch is never adopted', async () => {
  const calls0 = await mockCalls();
  const home = await newHome('t1-historical');
  const p = await runCase('provision-only', home, { taskId: 'task-9j0a8888' });
  assert.equal(p.ok, true);

  // Land BEFORE the child's pre-dispatch snapshot, with every leg correct —
  // the snapshot boundary is the ONLY thing excluding it.
  const seed = await seedChild({
    conversationId: 'rcos-child-historical',
    parentConversationId: p.dbId,
    parentPlatformId: p.conversationId,
    codebaseId: P1_ID,
    message: taskMsg('task-9j0a8888'),
    delayMs: 0,
  });
  await waitRow(seed.id);
  await postJson('/api/_mock/drop-next-dispatch', {});
  const r = await runCase('dispatch-only', home, { taskId: 'task-9j0a8888' }, 90000);
  assert.equal(r.verdict, 'FAILED');
  assert.deepEqual(r.failureCodes, ['run-not-found']);
  assert.equal(r.adoption, null);
  assert.equal(r.discovery.rejected.length, 0);
  // The run was genuinely there and genuinely linked — history, not identity,
  // is what excluded it.
  const detail = await (await fetch(BASE + '/api/workflows/runs/' + seed.id)).json();
  assert.equal(detail.run.parent_conversation_id, p.dbId);
  assert.equal(detail.run.parent_platform_id, p.conversationId);
  const calls1 = await mockCalls();
  assert.equal(calls1.dispatchPosts - calls0.dispatchPosts, 1);
});

test('case 9k: T1 — dispatch accepted, nothing materializes: run-not-found, nothing considered', async () => {
  const calls0 = await mockCalls();
  const home = await newHome('t1-pure-none');
  const p = await runCase('provision-only', home, { taskId: 'task-9k0a9999' });
  assert.equal(p.ok, true);

  await postJson('/api/_mock/drop-next-dispatch', {});
  const r = await runCase('dispatch-only', home, { taskId: 'task-9k0a9999' }, 90000);
  assert.equal(r.verdict, 'FAILED');
  assert.deepEqual(r.failureCodes, ['run-not-found']);
  assert.equal(r.runId, null);
  assert.equal(r.adoption, null);
  assert.equal(r.discovery.rejected.length, 0);
  assert.equal(r.discovery.candidates.length, 0);
  assert.equal(r.error, 'dispatch accepted but no run appeared');
  const calls1 = await mockCalls();
  assert.equal(calls1.dispatchPosts - calls0.dispatchPosts, 1);
});

test('case 9l: T1 — parent legs hidden from LIST are recovered from the detail GET', async () => {
  const calls0 = await mockCalls();
  const home = await newHome('t1-list-hides');
  const p = await runCase('provision-only', home, { taskId: 'task-9l0aaaaa' });
  assert.equal(p.ok, true);

  await postJson('/api/_mock/drop-next-dispatch', {});
  const seed = await seedChild({
    conversationId: 'rcos-child-hidden',
    parentConversationId: p.dbId,
    parentPlatformId: p.conversationId,
    codebaseId: P1_ID,
    message: taskMsg('task-9l0aaaaa'),
    listHidesParent: true,
  });
  // The seed must be FRESH when the child snapshots: projection assertions
  // happen after the case, not before it (a pre-dispatch waitRow would push
  // the seed into the snapshot, making it history by construction).
  const r = await runCase('dispatch-only', home, { taskId: 'task-9l0aaaaa' }, 90000);
  assert.equal(r.verdict, 'SHIP');
  assert.equal(r.adoption.mode, 'parent-linked');
  assert.equal(r.runId, seed.id);
  assert.equal(r.adoption.parentConversationId, p.dbId);
  assert.equal(r.adoption.parentPlatformId, p.conversationId);
  // The LIST projection hid both parent legs the whole time; adoption could
  // only have come from the detail GET.
  const row = await waitRow(seed.id);
  assert.equal(row.parent_conversation_id, undefined);
  assert.equal(row.parent_platform_id, undefined);
  const detail = await (await fetch(BASE + '/api/workflows/runs/' + seed.id)).json();
  assert.equal(detail.run.parent_conversation_id, p.dbId);
  assert.equal(detail.run.parent_platform_id, p.conversationId);
  const calls1 = await mockCalls();
  assert.equal(calls1.dispatchPosts - calls0.dispatchPosts, 1);
});

test('case 9m: T1 — a detail-poisoned leg refuses adoption even when the list looks right', async () => {
  const calls0 = await mockCalls();
  const home = await newHome('t1-detail-poison');
  const p = await runCase('provision-only', home, { taskId: 'task-9m0abbbb' });
  assert.equal(p.ok, true);

  await postJson('/api/_mock/drop-next-dispatch', {});
  const seed = await seedChild({
    conversationId: 'rcos-child-detailpoison',
    parentConversationId: p.dbId,
    parentPlatformId: p.conversationId,
    codebaseId: P1_ID,
    message: taskMsg('task-9m0abbbb'),
    detailOnly: { parent_platform_id: 'web-poisoned-detail' },
  });
  const r = await runCase('dispatch-only', home, { taskId: 'task-9m0abbbb' }, 90000);
  assert.equal(r.verdict, 'FAILED');
  assert.deepEqual(r.failureCodes, ['run-not-found']);
  assert.equal(r.adoption, null);
  const rej = ((r.discovery && r.discovery.rejected) || []).find((x) => x.id === seed.id);
  assert.ok(rej, 'the poisoned child was never considered');
  assert.match(rej.reason, /parent-platform-id/);
  // The projections disagree, and adoption trusted the poisoned one: the LIST
  // looked right the whole time, the DETAIL is what refused.
  const row = await waitRow(seed.id);
  assert.equal(row.parent_platform_id, p.conversationId);
  const detail = await (await fetch(BASE + '/api/workflows/runs/' + seed.id)).json();
  assert.equal(detail.run.parent_platform_id, 'web-poisoned-detail');
  const calls1 = await mockCalls();
  assert.equal(calls1.dispatchPosts - calls0.dispatchPosts, 1);
});
