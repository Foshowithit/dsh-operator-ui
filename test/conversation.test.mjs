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
  assert.match(r.error, new RegExp(stray.id));
  assert.match(r.error, /example-echo-ground-v1/);
  assert.match(r.error, /verify-echo-v1/);
  const calls1 = await mockCalls();
  assert.equal(calls1.createPosts - calls0.createPosts, 1);
  assert.equal(calls1.dispatchPosts - calls0.dispatchPosts, 1); // accepted, but no run ever appeared
});
