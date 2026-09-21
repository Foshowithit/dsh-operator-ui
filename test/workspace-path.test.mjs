// P2 fresh-workspace E2E — the PARENT half.
//
// Walks the milestone the product path must support end to end: a fresh user
// creates a workspace, submits a task, has the conversation provisioned and
// bound through the supported interface, dispatches through the real execution
// path, and can inspect the receipt. Nothing here provisions a conversation or
// seeds a task through a test-only path.
//
// Each case runs in its OWN child process with a fresh DSH_HOME (the lib caches
// task envelopes in module state, so restart semantics only prove anything
// across real process boundaries). The mock archon's admin counters make every
// assertion two-sided: the child proves the response, the parent proves what
// actually reached Archon — creations, dispatches, codebase registrations, and
// project bindings — plus the execution identity recorded on the run itself.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = 13778;
const BASE = 'http://127.0.0.1:' + PORT;

// One capability, routable ONLY by the test objective "verify echo running
// total seed values" (all six tokens land in tags/description — 6/6 hits,
// score 1.0, clearing both routeObjective thresholds). requires shell:execute,
// which the AUTO_WITHIN_POLICY preset pre-authorizes (it is not a holdout), so
// the task reaches the dispatch gate instead of stopping at the authority block.
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
let wsDir;
let wsDir2;

const newHome = async (name) => {
  const dir = join(tmpRoot, 'home-' + name);
  await mkdir(dir, { recursive: true });
  return dir;
};

const mockCalls = async () => {
  const b = await (await fetch(BASE + '/api/_mock/calls')).json();
  return {
    createPosts: b.createPosts,
    dispatchPosts: b.dispatchPosts,
    codebasePosts: b.codebasePosts,
    setProjectPosts: b.setProjectPosts,
  };
};

const delta = (before, after) => ({
  createPosts: after.createPosts - before.createPosts,
  dispatchPosts: after.dispatchPosts - before.dispatchPosts,
  codebasePosts: after.codebasePosts - before.codebasePosts,
  setProjectPosts: after.setProjectPosts - before.setProjectPosts,
});

const mockRuns = async () => (await (await fetch(BASE + '/api/workflows/runs?limit=100')).json()).runs;

// The run the plugin dispatched must carry the SAME execution identity the
// workspace and the conversation were bound to — the recorded row, not a label.
const assertRunIdentity = async (child, expectPath) => {
  const runs = await mockRuns();
  const run = runs.find((r) => r.conversation_id === child.conversationId);
  assert.ok(run, 'no run recorded for conversation ' + child.conversationId);
  assert.equal(run.codebase_id, child.codebaseId, 'run codebase_id must match the workspace codebase');
  assert.equal(run.working_path, expectPath, 'run working_path must match the workspace path');
  return run;
};

// Spawn the case child and parse the LAST stdout line as its JSON result.
async function runCase(caseName, home, arg, timeoutMs = 90000) {
  const args = [join(ROOT, 'test', 'workspace-case.mjs'), caseName, home];
  if (arg !== undefined) args.push(JSON.stringify(arg));
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      DSH_OPERATOR_UI_ARCHON: BASE,
      DSH_OPERATOR_UI_REGISTRY: registryPath,
      DSH_OPERATOR_UI_AUTHORITY_PRESET: 'AUTO_WITHIN_POLICY',
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

const caseArg = (extra) => ({ wsDir, wsName: basename(wsDir), wsDir2, wsDir2Name: basename(wsDir2), ...extra });

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'p2-workspace-'));
  registryPath = join(tmpRoot, 'registry.json');
  await writeFile(registryPath, JSON.stringify(REGISTRY, null, 2));

  // Real paths: the plugin records the path it was handed, and the mock resolves
  // it too — resolving both here removes any symlinked-prefix ambiguity.
  wsDir = join(tmpRoot, 'ws-alpha');
  wsDir2 = join(tmpRoot, 'ws-beta');
  await mkdir(wsDir, { recursive: true });
  await mkdir(wsDir2, { recursive: true });
  wsDir = await realpath(wsDir);
  wsDir2 = await realpath(wsDir2);

  // Refuse to run against a stale mock on our port: leftover state would
  // corrupt the call-count deltas.
  let stale = false;
  try { stale = (await fetch(BASE + '/api/health')).ok; } catch {}
  if (stale) throw new Error('a mock archon is already listening on 127.0.0.1:' + PORT + ' — kill it first');

  mockProc = spawn(process.execPath, [join(ROOT, 'scripts', 'mock-archon.mjs'), String(PORT)], { stdio: 'ignore' });
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      if ((await fetch(BASE + '/api/health')).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error('mock archon failed to start on :' + PORT);
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(async () => {
  if (mockProc) mockProc.kill('SIGKILL');
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the cases

test('refusals: an unhonorable create says why, persists nothing, dispatches nothing', async () => {
  const home = await newHome('refusals');
  const before = await mockCalls();
  const r = await runCase('create-refusals', home, caseArg());
  const after_ = await mockCalls();
  const d = delta(before, after_);

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.codes, {
    noOwner: '400:workspace-owner-required',
    noPath: '400:workspace-path-required',
    badPath: '400:workspace-create-failed',
    unknown: '404:workspace-not-found',
  });
  // Only the uncreatable-path attempt may reach Archon (the codebase POST that
  // Archon refuses); nothing may be persisted and nothing may be dispatched.
  assert.equal(d.codebasePosts, 1, 'exactly one codebase POST (the refused one)');
  assert.equal(d.createPosts, 0, 'no conversation creation');
  assert.equal(d.dispatchPosts, 0, 'no dispatch');
  const store = join(home, 'operator-ui', 'workspaces.json');
  const files = await readdir(join(home, 'operator-ui')).catch(() => []);
  assert.equal(files.includes('workspaces.json'), false, 'no workspace store may be written: ' + store);
});

test('create: a workspace registers once, resolves to its live codebase, and is owner-scoped', async () => {
  const home = await newHome('create');
  const before = await mockCalls();
  const r = await runCase('create-and-resolve', home, caseArg());
  const after_ = await mockCalls();
  const d = delta(before, after_);

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.name, basename(wsDir), 'workspace name comes from the registered codebase');
  assert.equal(r.codebaseRead, 'ok', 'the workspace resolves to a live codebase read');
  assert.equal(r.codebasePath, wsDir);
  assert.equal(r.foreign, '403:workspace-owner-mismatch', 'a foreign owner must be refused');
  assert.equal(r.listed, true, 'the workspace appears in the owner list');
  // Registering the same path twice is one Archon row (dedupe) — two POSTs, no
  // conversation, no dispatch.
  assert.equal(d.codebasePosts, 2, 'create + idempotent re-create');
  assert.equal(d.createPosts, 0, 'no conversation creation');
  assert.equal(d.dispatchPosts, 0, 'no dispatch');
});

test('two-step: submit is refused unbound, then binds through the supported path and executes the SAME task', async () => {
  const home = await newHome('two-step');
  const before = await mockCalls();
  const r = await runCase('refuse-then-provision', home, caseArg());
  const after_ = await mockCalls();
  const d = delta(before, after_);

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.verdict0, 'FAILED', 'an unbound task must be refused, not dispatched');
  assert.deepEqual(r.failureCodes0, ['conversation-not-bound']);
  assert.equal(r.attempts0, 0, 'the refusal must record no attempt');
  assert.equal(r.provisionReused, false, 'the first provision creates the conversation');
  assert.equal(r.verdict1, 'SHIP', 'the bound retry must execute and ship');
  assert.equal(r.attempts1, 1, 'one dispatch attempt');
  // ONE conversation creation across both attempts: the retry reuses the bound
  // association instead of creating a second one.
  assert.equal(d.createPosts, 1, 'exactly one conversation creation total');
  assert.equal(d.dispatchPosts, 1, 'exactly one dispatch total');
  assert.equal(d.codebasePosts, 1, 'one codebase registration');
  assert.ok(d.setProjectPosts >= 1, 'the project binding must reach Archon');
  const run = await assertRunIdentity(r, wsDir);
  assert.equal(run.status, 'completed');
});

test('one-shot: create workspace, submit task, execute, inspect the receipt', async () => {
  const home = await newHome('one-shot');
  const before = await mockCalls();
  const r = await runCase('happy-e2e', home, caseArg());
  const after_ = await mockCalls();
  const d = delta(before, after_);

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.verdict, 'SHIP');
  assert.deepEqual(r.failureCodes, []);
  assert.equal(r.executionStatus, 'completed');
  assert.equal(r.objectiveEvaluation, 'SATISFIED');
  assert.equal(r.capabilityValidation, true);
  assert.equal(r.dispatchable, true, 'the receipt must be inspectable as dispatchable');
  assert.equal(r.readbackVerdict, 'SHIP', 'the stored envelope reads back as shipped');
  assert.equal(d.createPosts, 1, 'exactly one conversation creation');
  assert.equal(d.dispatchPosts, 1, 'exactly one dispatch');
  assert.equal(d.codebasePosts, 1, 'one codebase registration');
  assert.ok(d.setProjectPosts >= 1, 'the project binding must reach Archon');
  const run = await assertRunIdentity(r, wsDir);
  assert.equal(run.status, 'completed');
  assert.equal(run.workflow_name, 'verify-echo-v1');
});

test('mismatch: a task executed in one workspace is refused a different one', async () => {
  const home = await newHome('mismatch');
  const before = await mockCalls();
  const r = await runCase('task-mismatch', home, caseArg());
  const after_ = await mockCalls();
  const d = delta(before, after_);

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.verdict, 'SHIP', 'the first workspace executes normally');
  assert.notEqual(r.ws1CodebaseId, r.ws2CodebaseId, 'the two workspaces are distinct codebases');
  assert.equal(r.clash, '409:workspace-task-mismatch', 'rebinding a bound task elsewhere must be refused');
  // The refusal is a refusal: no second conversation, no second dispatch.
  assert.equal(d.codebasePosts, 2, 'both workspaces registered');
  assert.equal(d.createPosts, 1, 'only the original conversation');
  assert.equal(d.dispatchPosts, 1, 'only the original dispatch');
  await assertRunIdentity(r, wsDir);
});
