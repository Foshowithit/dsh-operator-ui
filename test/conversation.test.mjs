// S2-R conversation-identity integration tests (GPT work order "S2 Discrepancy
// Review", section C + the 9 required validation cases).
//
// Everything runs against scripts/mock-archon.mjs on an OS-assigned ephemeral
// port — never a fixed port, never 3090, never the Dell. Each case runs in its
// OWN child process with a fresh DSH_HOME: the lib caches task envelopes in
// module state, so restart and idempotence semantics only prove anything across
// real process boundaries. The mock's admin routes count creation/dispatch
// POSTs, so every refusal case is asserted not just on its failure code but on
// ZERO dispatches.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PROJECT = 'p1x-csv-fixture';
const P1_ID = 'dc92aa5a4a569d452a2fa65a2a0e2053';

// --------------------------------------------------------------- mock lifecycle
//
// The mock binds an OS-assigned ephemeral port, never a hardcoded 137xx, so two
// concurrent runs of this file (or this file beside any other) cannot collide
// on a port. Binding :0 only PROBES for a free port: the kernel releases it the
// instant we close, so a sibling process can steal it before the mock child
// binds. startMock() treats a failed start as a lost race and retries on a
// fresh port rather than trusting the probed number.
async function freePort() {
  const srv = createServer();
  await new Promise((res, rej) => { srv.once('error', rej); srv.listen(0, '127.0.0.1', res); });
  const { port } = srv.address();
  await new Promise((res) => srv.close(res));
  return port;
}

async function startMock({ attempts = 6, readyTimeoutMs = 5000 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const port = await freePort();
    const base = 'http://127.0.0.1:' + port;
    const proc = spawn(process.execPath, [join(ROOT, 'scripts', 'mock-archon.mjs'), String(port)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    let exited = null;
    proc.on('exit', (code) => { exited = code; });
    const deadline = Date.now() + readyTimeoutMs;
    let ready = false;
    for (;;) {
      if (exited !== null) {
        lastErr = new Error('mock archon exited (' + exited + ') before binding :' + port +
          ' — the probed port was taken before the bind' + (stderr ? ': ' + stderr.trim().split('\n')[0] : ''));
        break;
      }
      try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch {}
      if (Date.now() > deadline) { lastErr = new Error('mock archon never answered on :' + port + ' within ' + readyTimeoutMs + 'ms'); break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (ready && exited === null) return { proc, port, base };
    if (ready) lastErr = new Error('mock archon on :' + port + ' exited right after answering');
    try { proc.kill('SIGKILL'); } catch {}
  }
  throw new Error('could not start a mock archon after ' + attempts + ' attempts: ' + (lastErr ? lastErr.message : 'unknown'));
}

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

// Acquire the port and prove the mock is live BEFORE any config or case code can
// observe BASE. There is no hard-fail guard to delete here: with an ephemeral
// port there is nothing to collide with, and the retry above absorbs the only
// remaining race (a sibling stealing the probed port).
const mock = await startMock();
const BASE = mock.base;
mockProc = mock.proc;

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
  assert.equal(detail.run.working_path, '/home/chow/p1x-ws');
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
  assert.equal(detail.run.working_path, '/home/chow/p1x-ws');
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
  // so the mismatch path (not the snapshot filter) is what catches it. The
  // ordering is PROVEN by the dispatch POST, not timed — see
  // dispatchAndSeedAfterSnapshot.
  await postJson('/api/_mock/drop-next-dispatch', {});
  const { seed: stray, r } = await dispatchAndSeedAfterSnapshot({
    home,
    taskId: 'task-beefcafe',
    seedArgs: { conversationId: p.conversationId, workflowName: 'example-echo-ground-v1' },
  });
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
//
// THE SEED MATERIALIZES IMMEDIATELY (delayMs 0). WHETHER IT LANDS BEFORE OR
// AFTER THE CASE CHILD'S PRE-DISPATCH SNAPSHOT IS DECIDED BY *WHEN* THIS IS
// CALLED, NEVER BY A TIMER. A timer cannot express that ordering: it is a bet
// on how fast a child process boots, and when the bet loses the case is decided
// by the temporal filter instead of the leg it exists to test. Two sanctioned
// orderings, both causal:
//   * PRE-snapshot  — call seedChild(...) and await waitRow(seed.id) BEFORE
//     starting the case (case 9j: the snapshot boundary must be the ONLY thing
//     excluding a fully-linked run).
//   * POST-snapshot — use dispatchAndSeedAfterSnapshot(...) below, which proves
//     the snapshot has already happened by waiting for the dispatch POST.
const seedChild = (over) => postJson('/api/_mock/seed-run', {
  status: 'completed',
  output: SEED_OUTPUT,
  workflowName: 'verify-echo-v1',
  delayMs: 0,
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

// Start the dispatch-only case and seed a run that is GUARANTEED to land after
// the case child's pre-dispatch snapshot.
//
// THE ORDERING IS CAUSAL, AND THAT IS THE WHOLE POINT. The case child takes its
// pre-dispatch snapshot (one run-list read) and only THEN POSTs the dispatch,
// so "the mock has served the dispatch POST" is a PROOF that the snapshot is
// already behind us — not an estimate of it. The form this replaces seeded with
// `delayMs: 2500` and asserted in a comment that 2500 ms "lands it AFTER the
// case child's pre-dispatch snapshot": a 2.5 s bet on child-process boot time.
// When the bet loses, the run lands INSIDE the snapshot and the case is decided
// by the temporal filter instead of the leg it exists to test — 9b's stray
// becomes a pre-dispatch EXCLUSION, so the mismatch diagnostic never names it,
// and 9e-9i's poisoned child is "never considered" at all, so the leg reason
// the case asserts is never produced. That is a FLAKY NEGATIVE TEST, which is
// not evidence: it fails by naming a different leg, or none.
//
// FALSIFIED, NOT ARGUED: forcing the old default to `delayMs: 0` (i.e. the run
// materializing before the snapshot, which is what a slow boot produces)
// reproduces case 9i's failure exactly — "the poisoned child was never
// considered" — with the user-message leg never evaluated. The load-dependent
// red was this race losing, not a defect in the leg checks.
//
// THE MARGIN IS LARGE AND ONE-SIDED. Discovery re-lists every ADOPTION_POLL_MS
// (500 ms) until its 10 s deadline; this helper seeds within milliseconds of
// the dispatch, so the run is visible to the FIRST discovery poll. There is no
// upper bound on how slow a loaded box may be, and none is needed.
//
// Returns the seed handle AND the case result, because the cases assert on both
// (9b names the stray id in the refusal text; 9e-9i match on the leg reason).
async function dispatchAndSeedAfterSnapshot({ home, taskId, seedArgs, timeoutMs = 90000 }) {
  const before = (await mockCalls()).dispatchPosts;
  const pending = runCase('dispatch-only', home, { taskId }, timeoutMs);
  const deadline = Date.now() + 60000;
  for (;;) {
    if ((await mockCalls()).dispatchPosts > before) break;
    if (Date.now() > deadline) {
      throw new Error('case ' + taskId + ' never dispatched — cannot prove the pre-dispatch snapshot was taken, so the seed ordering is unproven');
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const seed = await seedChild(seedArgs);
  await waitRow(seed.id);
  return { seed, r: await pending };
}

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
    ['workflow-name', 'parent-conversation-id', 'parent-platform-id', 'codebase-id', 'user-message', 'working-path']);
  // These cases are workspace-less (no workspace is ever provisioned), so the
  // working-path leg is emitted INAPPLICABLE — present in the evidence, with no
  // verdict. Every other leg passes.
  assert.ok(r.adoption.evidence.every((e) => e.applicable === false || e.pass === true));
  assert.equal(r.adoption.evidence.find((e) => e.id === 'working-path').applicable, false);

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
  const { seed, r } = await dispatchAndSeedAfterSnapshot({
    home,
    taskId: 'task-9e0a3333',
    seedArgs: {
      conversationId: 'rcos-child-wrongdb',
      parentConversationId: 'db-not-ours',
      parentPlatformId: p.conversationId,
      codebaseId: P1_ID,
      message: taskMsg('task-9e0a3333'),
    },
  });
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
  const { seed, r } = await dispatchAndSeedAfterSnapshot({
    home,
    taskId: 'task-9f0a4444',
    seedArgs: {
      conversationId: 'rcos-child-wrongplat',
      parentConversationId: p.dbId,
      parentPlatformId: 'web-wrongplatform',
      codebaseId: P1_ID,
      message: taskMsg('task-9f0a4444'),
    },
  });
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
  const { seed, r } = await dispatchAndSeedAfterSnapshot({
    home,
    taskId: 'task-9g0a5555',
    seedArgs: {
      conversationId: 'rcos-child-wrongproj',
      parentConversationId: p.dbId,
      parentPlatformId: p.conversationId,
      codebaseId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
      message: taskMsg('task-9g0a5555'),
    },
  });
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
  const { r } = await dispatchAndSeedAfterSnapshot({
    home,
    taskId: 'task-9h0a6666',
    seedArgs: {
      conversationId: 'rcos-child-wrongwf',
      workflowName: 'example-echo-ground-v1',
      parentConversationId: p.dbId,
      parentPlatformId: p.conversationId,
      codebaseId: P1_ID,
      message: taskMsg('task-9h0a6666'),
    },
  });
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
  const { seed, r } = await dispatchAndSeedAfterSnapshot({
    home,
    taskId: 'task-9i0a7777',
    seedArgs: {
      conversationId: 'rcos-child-wrongmsg',
      parentConversationId: p.dbId,
      parentPlatformId: p.conversationId,
      codebaseId: P1_ID,
      message: 'task task-9i0a7777: something else entirely',
    },
  });
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
  // The seed must be FRESH when the child snapshots (its parent legs are
  // hidden from the LIST, so the projection assertions only mean something if
  // the run was not already history). FRESH is now PROVEN by the dispatch POST
  // rather than assumed from a timer — see dispatchAndSeedAfterSnapshot.
  const { seed, r } = await dispatchAndSeedAfterSnapshot({
    home,
    taskId: 'task-9l0aaaaa',
    seedArgs: {
      conversationId: 'rcos-child-hidden',
      parentConversationId: p.dbId,
      parentPlatformId: p.conversationId,
      codebaseId: P1_ID,
      message: taskMsg('task-9l0aaaaa'),
      listHidesParent: true,
    },
  });
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
  const { seed, r } = await dispatchAndSeedAfterSnapshot({
    home,
    taskId: 'task-9m0abbbb',
    seedArgs: {
      conversationId: 'rcos-child-detailpoison',
      parentConversationId: p.dbId,
      parentPlatformId: p.conversationId,
      codebaseId: P1_ID,
      message: taskMsg('task-9m0abbbb'),
      detailOnly: { parent_platform_id: 'web-poisoned-detail' },
    },
  });
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
