// OP-4R Phase B integration tests — the DSH integration half of the explicit
// fresh-run path (GPT work order "Attempt 2 Ruling", Phase B):
//   "Test that an ordinary dispatch still encounters the existing guard,
//    while the explicitly authorized fresh-run request creates a new run
//    without resuming or altering run 7245beda-c754-4862-af56-ae2e72e11d15…
//    Validate that run discovery attributes the new child to Attempt 3,
//    rather than adopting the failed historical child or another plausible
//    run."
//
// Everything runs against scripts/mock-archon.mjs on a dedicated port — never
// 3090, never the dev-host. Every case runs in its OWN child process with a fresh
// DSH_HOME seeded from the REAL attempt-2 envelope fixture, because
// lib/tasks.js caches envelopes in module state. Four cases, in order:
//   T1 ordinary dispatch  → the guard still bites: menu observation, zero run
//   T2 authorized fresh-run → ONE new child, parent-linked to attempt 3,
//                            historical run + two prior attempts untouched
//   T3 unapproved         → approval gate still bites (option ≠ authority)
//   T4 malformed fresh-run→ fails closed before config/registry/dispatch
//                            (zero dispatch bytes on the wire)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const PORT = 13779;
const BASE = 'http://127.0.0.1:' + PORT;

const TASK_ID = 'task-970ff68d';
const CONV_PLATFORM = 'web-1789946601072-wa6vlx';
const CONV_DB = 'fc764d99b8f0d7ba3426df409ea63540';
const P1 = 'dc92aa5a4a569d452a2fa65a2a0e2053';
const HISTORICAL = '7245beda-c754-4862-af56-ae2e72e11d15';
const DECOY = 'run-mock-decoy-foreign';
const OBJECTIVE = 'Process values.csv in order and report running total after each row';
const PLAIN = 'task ' + TASK_ID + ': ' + OBJECTIVE;
const WIRE = '--force ' + PLAIN;
const SEEDED = 'rcos-verify-seed:csv-running-total-v1';
const APPROVED_AT = '2026-09-21T00:30:50.780Z';
const VIA = 'gpt-op4r-attempt-3';
const GUARD_MENU_MSG = 'Archon returned a prior-run decision menu — no run was created; operator action required';
const MALFORMED_MSG = 'fresh-run option present without explicit authorization — refusing to dispatch';

const REGISTRY = {
  registry_version: 'v1',
  capabilities: [{
    id: 'csv-running-total',
    name: 'CSV running total',
    description: OBJECTIVE,
    version: '1.0.0',
    status: 'active',
    workflow: 'csv-running-total-v1',
    tags: ['csv', 'running', 'total'],
    requires: ['filesystem:read', 'shell:execute'],
    verification: { terminalStatus: 'completed', expectOutput: SEEDED },
    objectiveEvaluation: { kind: 'output-contains', value: SEEDED },
  }],
};

const caseScript = join(HERE, 'op4r-phaseb-case.mjs');
const fixturePath = join(HERE, 'fixtures', 'op4r-real-envelope-attempt2-task-970ff68d.json');
let tmpRoot;
let registryPath;
let mockProc;
let fixtureWrapper;

async function newHome(name) {
  const home = join(tmpRoot, 'home-' + name);
  await mkdir(home, { recursive: true });
  return home;
}

async function postJson(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('POST ' + path + ' → HTTP ' + res.status + ': ' + (await res.text()));
  return res.json();
}

async function getJson(path) {
  return fetch(BASE + path).then((r) => r.json());
}

const mockCalls = () => getJson('/api/_mock/calls');
const wireLog = () => getJson('/api/_mock/dispatches');
const csvRunIds = async () => {
  const body = await getJson('/api/workflows/runs?limit=50');
  return body.runs.filter((r) => r && r.workflow_name === 'csv-running-total-v1').map((r) => r.id).sort();
};
const runDetail = (id) => getJson('/api/workflows/runs/' + id);
const readStore = async (home) => {
  const parsed = JSON.parse(await readFile(join(home, 'operator-ui', 'tasks.json'), 'utf8'));
  return parsed.tasks.find((t) => t.taskId === TASK_ID);
};

// The child re-hydrates the fixture itself; the parent only needs it for the
// "prior attempts carried verbatim" projections.
const priorProjection = (index) => {
  const a = fixtureWrapper.tasks[0].attempts[index];
  return index === 0 ? { ...a, freshRun: null, observation: null } : { ...a, freshRun: null };
};

function runCase(caseName, home, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [caseScript, caseName, home], {
      cwd: ROOT,
      env: {
        ...process.env,
        DSH_OPERATOR_UI_ARCHON: BASE,
        DSH_OPERATOR_UI_REGISTRY: registryPath,
        DSH_OPERATOR_UI_AUTHORITY_PRESET: 'ASK_BEFORE_ACTION',
        DSH_HOME: home,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('case ' + caseName + ' timed out after ' + timeoutMs + 'ms\n' + stderr));
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('case ' + caseName + ' exited ' + code + '\nstderr:\n' + stderr + '\nstdout:\n' + stdout));
      const lines = stdout.trim().split('\n');
      try { resolve(JSON.parse(lines[lines.length - 1])); }
      catch (err) { reject(new Error('case ' + caseName + ' produced no JSON report: ' + stdout + '\n' + stderr)); }
    });
  });
}

// Reset the conversation tail to its two provisioning pre-rows.
const seedConv = () => postJson('/api/_mock/seed-conversation', {
  platformId: CONV_PLATFORM, dbId: CONV_DB, codebaseId: P1,
});

// The historical Attempt-1 run: failed, working_path set (guard-eligible),
// parent-linked to THIS task's conversation — the run Attempt 3 must neither
// adopt nor alter.
const seedHistorical = () => postJson('/api/_mock/seed-run', {
  id: HISTORICAL,
  conversationId: CONV_PLATFORM,
  workflowName: 'csv-running-total-v1',
  workingPath: '/home/<redacted>/p1x-ws',
  parentConversationId: CONV_DB,
  parentPlatformId: CONV_PLATFORM,
  codebaseId: P1,
  message: PLAIN,
  status: 'failed',
});

before(async () => {
  fixtureWrapper = JSON.parse(await readFile(fixturePath, 'utf8'));
  assert.equal(fixtureWrapper.tasksVersion, 2);
  assert.equal(fixtureWrapper.tasks[0].taskId, TASK_ID);

  tmpRoot = await mkdtemp(join(tmpdir(), 'op4r-phaseb-'));
  registryPath = join(tmpRoot, 'registry.json');
  await writeFile(registryPath, JSON.stringify(REGISTRY, null, 2));

  // Stale-port guard: never dispatch against a leftover mock.
  let stale = false;
  try { stale = (await fetch(BASE + '/api/health')).ok; } catch { /* free */ }
  if (stale) throw new Error('port ' + PORT + ' already serves a mock — refusing to run');

  mockProc = spawn(process.execPath, [join(ROOT, 'scripts', 'mock-archon.mjs'), String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  const deadline = Date.now() + 5000;
  for (;;) {
    try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error('mock Archon did not become healthy on ' + PORT);
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(async () => {
  if (mockProc) mockProc.kill('SIGKILL');
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

test('T1: an ordinary attempt-3 dispatch still hits the guard — menu observation, zero new run', async () => {
  await seedConv();
  await seedHistorical();
  const histBefore = await runDetail(HISTORICAL);
  const calls0 = await mockCalls();

  const home = await newHome('t1-ordinary');
  const r = await runCase('ordinary', home, 90000);

  // The guard path: FAILED with the operator-action verdict, no run, and the
  // observation claims ONLY menu evidence — never execution.
  assert.equal(r.verdict, 'FAILED');
  assert.deepEqual(r.failureCodes, ['run-not-created-operator-action-required']);
  assert.equal(r.error, GUARD_MENU_MSG);
  assert.equal(r.nextAction.kind, 'operator-action');
  assert.equal(r.nextAction.label, 'Resolve the prior-run decision menu');
  assert.deepEqual(r.route, { id: 'csv-running-total', version: '1.0.0', workflow: 'csv-running-total-v1', lifecycle: 'active' });
  assert.equal(r.conversationId, CONV_PLATFORM);
  assert.equal(r.execution, null);
  assert.equal(r.capabilityValidation, null);
  assert.equal(r.objectiveEvaluation, null);

  // Approval carried from the fixture — the retry record, not a re-stamp.
  assert.equal(r.authority.mode, 'approval');
  assert.equal(r.authority.approvedAt, APPROVED_AT);
  assert.equal(r.authority.approvedFrom, 'carried-from-prior-attempt');
  assert.equal(r.authority.retryAuthorization.carriedApprovalAt, APPROVED_AT);
  assert.equal(r.authority.retryAuthorization.via, VIA);
  assert.ok(r.authority.retryAuthorization.authorizedAt);

  // Attempt 3 recorded, no fresh-run option on it, observation = menu only.
  assert.equal(r.attempts.length, 3);
  const a3 = r.attempts[2];
  assert.equal(a3.attempt, 3);
  assert.equal(a3.runId, null);
  assert.equal(a3.status, null);
  assert.equal(a3.adoption, null);
  assert.equal(a3.childConversationId, null);
  assert.equal(a3.freshRun, null);
  assert.equal(a3.failureCode, 'run-not-created-operator-action-required');
  assert.equal(a3.error, GUARD_MENU_MSG);
  assert.equal(a3.observation.kind, 'prior-run-menu');
  assert.equal(a3.observation.notProofOf, 'execution');
  assert.equal(typeof a3.observation.freshMessages, 'number');
  assert.equal(a3.observation.freshMessages, 2); // dispatch user row + combined guard row
  assert.ok(a3.observation.messageId);
  assert.equal(a3.dispatch.accepted, true);
  assert.equal(a3.dispatch.status, 'started');
  assert.equal(a3.dispatch.runId, null);
  assert.match(a3.dispatch.responseSha256, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(a3.discovery.candidates, []);
  assert.equal(a3.discovery.dispatchToken, null);
  assert.deepEqual(a3.discovery.rejected, []);
  assert.ok(a3.discovery.elapsedMs >= 10000, 'discovery must exhaust the full adoption window');
  // The attempt-2 observation rides along verbatim as carried truth.
  assert.equal(r.attempts[1].observation.recordedBy, 'op4r-attempt2-observation-20260922');
  assert.equal(r.trust.label, 'Observed');

  // Persisted envelope: two prior attempts projected verbatim, attempt 3
  // appended, conversation association intact, lineage unchanged (null).
  const store = await readStore(home);
  assert.equal(store.status, 'closed');
  assert.equal(store.verdict, 'FAILED');
  assert.equal(store.lineage, null);
  assert.deepEqual(store.conversation, fixtureWrapper.tasks[0].conversation);
  assert.equal(store.authority.approvedAt, APPROVED_AT);
  assert.equal(store.attempts.length, 3);
  assert.deepEqual(store.attempts[0], priorProjection(0));
  assert.deepEqual(store.attempts[1], priorProjection(1));
  assert.equal(store.attempts[2].freshRun, null);
  assert.equal(store.attempts[2].observation.kind, 'prior-run-menu');

  // Wire: byte-identical ordinary message, guard engaged, zero force token.
  const log = await wireLog();
  assert.equal(log.count, 1);
  const w = log.wires[0];
  assert.equal(w.workflow, 'csv-running-total-v1');
  assert.equal(w.conversationId, CONV_PLATFORM);
  assert.equal(w.wire, PLAIN);
  assert.equal(w.force, false);
  assert.equal(w.plain, PLAIN);
  assert.equal(w.guard, true);

  // Zero runs created; the historical run byte-identical.
  assert.deepEqual(await csvRunIds(), [HISTORICAL]);
  assert.deepEqual(await runDetail(HISTORICAL), histBefore);
  const calls1 = await mockCalls();
  assert.equal(calls1.dispatchPosts - calls0.dispatchPosts, 1);
});

test('T2: the authorized fresh-run creates ONE new parent-linked child — attempt 3, historical untouched', async () => {
  await seedConv();
  const histBefore = await runDetail(HISTORICAL);

  // Exactly one forked child materializes for this dispatch, after a delay
  // that lands inside the discovery window; a plausible decoy csv run on a
  // FOREIGN conversation lands mid-discovery too — neither may be adopted by
  // mistake.
  await postJson('/api/_mock/fork-next-dispatch', { count: 1 });
  await postJson('/api/_mock/delay-next-dispatch', { ms: 1500 });
  await postJson('/api/_mock/seed-run', {
    id: DECOY,
    conversationId: 'web-decoy-foreign',
    workflowName: 'csv-running-total-v1',
    codebaseId: P1,
    message: PLAIN,
    delayMs: 1000,
  });
  const calls0 = await mockCalls();
  const wires0 = (await wireLog()).count;

  const home = await newHome('t2-force');
  const r = await runCase('force', home, 90000);

  // SHIP: execution terminal, capability validated, objective satisfied.
  assert.equal(r.verdict, 'SHIP');
  assert.deepEqual(r.failureCodes, []);
  assert.equal(r.nextAction.kind, 'ship');
  const childId = r.attempts[2].runId;
  assert.match(childId, /^run-mock-child-/);
  assert.deepEqual(r.execution, { completed: true, status: 'completed', runId: childId });
  assert.equal(r.capabilityValidation.pass, true);
  assert.equal(r.objectiveEvaluation.status, 'SATISFIED');
  assert.equal(r.objectiveEvaluation.pass, true);
  assert.deepEqual(r.checks.map((c) => c.id), ['terminal-status', 'declared-expectation', 'objective-satisfaction', 'contains:' + SEEDED]);
  assert.deepEqual(r.checks.slice(0, 3).map((c) => c.pass), [true, true, true]);
  assert.equal(r.trust.label, 'Objective satisfied');

  // Same carried approval as T1 — the option never widens authority.
  assert.equal(r.conversationId, CONV_PLATFORM);
  assert.equal(r.authority.mode, 'approval');
  assert.equal(r.authority.approvedAt, APPROVED_AT);
  assert.equal(r.authority.approvedFrom, 'carried-from-prior-attempt');
  assert.equal(r.authority.retryAuthorization.via, VIA);
  assert.equal(r.authority.retryAuthorization.carriedApprovalAt, APPROVED_AT);

  // Attempt 3: fresh-run explicitly stamped, child attributed, discovery null
  // (adoption recorded instead — nothing left unresolved).
  assert.equal(r.attempts.length, 3);
  const a3 = r.attempts[2];
  assert.equal(a3.attempt, 3);
  assert.equal(a3.status, 'completed');
  assert.equal(a3.freshRun.authorized, true);
  assert.equal(a3.freshRun.via, VIA);
  assert.ok(a3.freshRun.authorizedAt);
  assert.equal(a3.observation, null);
  assert.equal(a3.discovery, null);
  assert.equal(a3.failureCode, null);
  assert.equal(a3.error, null);
  assert.ok(a3.startedAt);
  assert.ok(a3.endedAt);
  assert.deepEqual(a3.outputs, ['emit: ' + SEEDED]);
  assert.equal(a3.dispatch.accepted, true);
  assert.equal(a3.dispatch.runId, null);
  // Adoption proves five legs on the run detail — the child is THIS task's.
  const ad = a3.adoption;
  assert.equal(ad.mode, 'parent-linked');
  assert.equal(ad.verifiedFrom, 'run-detail');
  assert.equal(ad.runId, childId);
  assert.equal(ad.workflow, 'csv-running-total-v1');
  assert.equal(ad.boundConversationId, CONV_PLATFORM);
  assert.equal(a3.childConversationId, ad.childConversationId);
  assert.match(ad.childConversationId, /^web-child-/);
  assert.equal(ad.parentConversationId, CONV_DB);
  assert.equal(ad.parentPlatformId, CONV_PLATFORM);
  assert.equal(ad.codebaseId, P1);
  assert.equal(ad.userMessage, PLAIN);
  assert.equal(typeof ad.candidatesConsidered, 'number');
  assert.ok(ad.candidatesConsidered >= 1);
  assert.match(ad.detailSha256, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(ad.evidence.map((e) => e.id),
    ['workflow-name', 'parent-conversation-id', 'parent-platform-id', 'codebase-id', 'user-message']);
  assert.ok(ad.evidence.every((e) => e.pass === true));

  // Independent re-read of the child detail — attribution holds outside DSH.
  const childDetail = await runDetail(childId);
  assert.equal(childDetail.run.conversation_id, ad.childConversationId);
  assert.equal(childDetail.run.parent_conversation_id, CONV_DB);
  assert.equal(childDetail.run.parent_platform_id, CONV_PLATFORM);
  assert.equal(childDetail.run.user_message, PLAIN);
  assert.equal(childDetail.run.workflow_name, 'csv-running-total-v1');

  // Persisted: prior attempts verbatim, conversation block preserved,
  // approval record preserved, lineage unchanged.
  const store = await readStore(home);
  assert.equal(store.status, 'closed');
  assert.equal(store.verdict, 'SHIP');
  assert.equal(store.lineage, null);
  assert.deepEqual(store.conversation, fixtureWrapper.tasks[0].conversation);
  assert.equal(store.authority.approvedAt, APPROVED_AT);
  assert.equal(store.authority.retryAuthorization.via, VIA);
  assert.equal(store.attempts.length, 3);
  assert.deepEqual(store.attempts[0], priorProjection(0));
  assert.deepEqual(store.attempts[1], priorProjection(1));
  assert.equal(store.attempts[2].runId, childId);
  assert.equal(store.attempts[2].freshRun.authorized, true);

  // Wire: the ONLY difference from T1 is the explicit --force token.
  const log = await wireLog();
  assert.equal(log.count, wires0 + 1);
  const w = log.wires[wires0];
  assert.equal(w.workflow, 'csv-running-total-v1');
  assert.equal(w.conversationId, CONV_PLATFORM);
  assert.equal(w.wire, WIRE);
  assert.equal(w.force, true);
  assert.equal(w.plain, PLAIN);
  assert.equal(w.guard, false);

  // Exactly ONE new csv run: child + decoy (existed, not adopted) +
  // historical (retained). Historical detail byte-identical.
  assert.deepEqual(await csvRunIds(), [childId, DECOY, HISTORICAL].sort());
  assert.notEqual(ad.runId, HISTORICAL);
  assert.notEqual(ad.runId, DECOY);
  assert.deepEqual(await runDetail(HISTORICAL), histBefore);
  const calls1 = await mockCalls();
  assert.equal(calls1.dispatchPosts - calls0.dispatchPosts, 1);
});

test('T3: the fresh-run option never substitutes for approval — awaiting-approval, no dispatch', async () => {
  const calls0 = await mockCalls();
  const wires0 = await wireLog();
  const runs0 = await csvRunIds();

  const home = await newHome('t3-unapproved');
  const r = await runCase('unapproved', home);

  assert.equal(r.verdict, 'PENDING');
  assert.deepEqual(r.failureCodes, ['awaiting-approval']);
  assert.equal(r.nextAction.kind, 'approve');
  assert.equal(r.authority.mode, 'approval');
  assert.equal(r.authority.approvedAt, null);
  // No attempt was pushed — the gate bites before any dispatch work.
  assert.equal(r.attempts.length, 2);

  const store = await readStore(home);
  assert.equal(store.status, 'awaiting-approval');
  assert.equal(store.verdict, 'PENDING');
  assert.equal(store.endedAt, null);
  assert.equal(store.authority.approvedAt, null);
  assert.equal(store.route.selected.workflow, 'csv-running-total-v1');
  assert.equal(store.attempts.length, 2);
  assert.deepEqual(store.attempts[0], priorProjection(0));
  assert.deepEqual(store.attempts[1], priorProjection(1));

  // Zero network dispatch: no wire bytes, no new run.
  const calls1 = await mockCalls();
  assert.equal(calls1.dispatchPosts, calls0.dispatchPosts);
  assert.deepEqual(await wireLog(), wires0);
  assert.deepEqual(await csvRunIds(), runs0);
});

test('T4: a malformed fresh-run fails closed before config, registry, approval, or dispatch', async () => {
  const calls0 = await mockCalls();
  const wires0 = await wireLog();
  const runs0 = await csvRunIds();

  const home = await newHome('t4-malformed');
  const r = await runCase('malformed', home);

  assert.equal(r.verdict, 'FAILED');
  assert.deepEqual(r.failureCodes, ['fresh-run-not-authorized']);
  assert.equal(r.error, MALFORMED_MSG);
  assert.equal(r.nextAction.kind, 'inspect');
  // route null proves registry+routing never ran; authority null proves the
  // approval block never ran; attempts stayed at the two carried ones.
  assert.equal(r.route, null);
  assert.equal(r.authority, null);
  assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[2], undefined);

  const store = await readStore(home);
  assert.equal(store.status, 'closed');
  assert.equal(store.verdict, 'FAILED');
  assert.deepEqual(store.failureCodes, ['fresh-run-not-authorized']);
  assert.equal(store.error, MALFORMED_MSG);
  assert.equal(store.route, null);
  assert.equal(store.authority, null);
  assert.equal(store.attempts.length, 2);
  assert.deepEqual(store.attempts[0], priorProjection(0));
  assert.deepEqual(store.attempts[1], priorProjection(1));

  // Zero dispatch bytes reached the wire.
  const calls1 = await mockCalls();
  assert.equal(calls1.dispatchPosts, calls0.dispatchPosts);
  assert.deepEqual(await wireLog(), wires0);
  assert.deepEqual(await csvRunIds(), runs0);
});
