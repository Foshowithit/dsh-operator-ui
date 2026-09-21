// OP-4R Phase C — non-dispatch integration inspection (GPT work order:
// "durable task identity, parent binding, approval preservation, retry
// idempotence, T1 negative cases, and honest DSH projections. Use fixtures
// and existing historical execution evidence. No live workflow dispatch, new
// conversation, or dev-host workflow modification.")
//
// Every input here is a captured historical record: the REAL persisted
// operator envelope (fixture) and the REAL failed Archon run (t1 fixture).
// Store behavior is exercised through the public API of lib/tasks.js with a
// fresh $DSH_HOME per case; "restart" = a unique import specifier (fresh
// module record), the same convention as tasks-durability.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const FIXTURE_URL = new URL('./fixtures/op4-real-envelope-task-970ff68d.json', import.meta.url);
const RUN_FIXTURE_URL = new URL('./fixtures/op4-real-run-7245beda.json', import.meta.url);

const TASK_ID = 'task-970ff68d';
const WF = 'csv-running-total-v1';
const MSG = 'task task-970ff68d: Process values.csv in order and report running total after each row';

const fixture = JSON.parse(await readFile(FIXTURE_URL, 'utf8'));
const { run, associationFromPersistedEnvelope } = JSON.parse(await readFile(RUN_FIXTURE_URL, 'utf8'));
const realTask = fixture.tasks[0];

// Canonical form: recursively key-sorted, compact separators (matches the
// fixture's recorded provenance sha).
function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonicalize(v[k])]));
  }
  return v;
}
function sha256SortedKeys(obj) {
  return createHash('sha256').update(JSON.stringify(canonicalize(obj))).digest('hex');
}

let homeCounter = 0;
async function freshHome() {
  const dir = await mkdtemp(join(tmpdir(), 'opui-op4c-'));
  homeCounter += 1;
  return { dir, bust: Date.now() + '-' + homeCounter + '-' + Math.random().toString(36).slice(2) };
}

// Seed a fresh $DSH_HOME with the REAL durable store (minus the fixture's
// provenance annotation — the store file itself never carried one).
async function seedRealStore(dir) {
  await mkdir(join(dir, 'operator-ui'), { recursive: true });
  await writeFile(
    join(dir, 'operator-ui', 'tasks.json'),
    JSON.stringify({ tasksVersion: fixture.tasksVersion, tasks: fixture.tasks }, null, 2) + '\n',
  );
}

test('op4c fixture integrity: the envelope is the real historical record, unmutated', () => {
  assert.equal(fixture._provenance.taskSha256_of_sorted_keys, sha256SortedKeys(realTask));
  assert.equal(realTask.taskId, TASK_ID);
  assert.equal(realTask.status, 'closed');
  assert.equal(realTask.sealedBy, 'goal-runner-m1');
  assert.equal(realTask.verdict, 'FAILED');
  assert.deepEqual(realTask.failureCodes, ['run-not-found']);
  assert.equal(realTask.error, 'dispatch accepted but no run appeared');
  assert.equal(realTask.attempts.length, 1);
  assert.equal(realTask.attempts[0].attempt, 1);
  assert.equal(realTask.attempts[0].runId, null);
  assert.equal(realTask.attempts[0].workflow, WF);
  assert.equal(realTask.attempts[0].endedAt, '2026-09-21T00:31:01.789Z');
});

test('op4c durable identity: the real envelope hydrates and survives a restart verbatim', async () => {
  const { dir, bust } = await freshHome();
  process.env.DSH_HOME = dir;
  try {
    await seedRealStore(dir);
    const modA = await import('../lib/tasks.js?bust=' + bust + '-a');
    const t1 = await modA.getTask(TASK_ID);
    assert.ok(t1, 'real envelope must hydrate from disk');
    assert.equal(t1.taskId, TASK_ID);
    assert.equal(t1.objective, realTask.objective);
    assert.equal(t1.createdAt, realTask.createdAt);
    assert.equal(t1.status, 'closed');
    assert.equal(t1.sealedBy, 'goal-runner-m1');

    // Restart: fresh module record, empty cache, hydrate from disk.
    const modB = await import('../lib/tasks.js?bust=' + bust + '-b');
    const t2 = await modB.getTask(TASK_ID);
    assert.deepEqual(t2, realTask, 'restart must not mutate the historical envelope');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('op4c parent binding: the persisted association matches the real run record and T1 adopts on it', async () => {
  const { verifyParentLinkage } = await import('../lib/goal.js');
  const a = realTask.conversation;
  assert.equal(a.archonConversationId, associationFromPersistedEnvelope.archonConversationId);
  assert.equal(a.dbId, associationFromPersistedEnvelope.dbId);
  assert.equal(a.expectedCodebaseId, associationFromPersistedEnvelope.expectedCodebaseId);
  assert.equal(a.provisioningState, 'associated');
  // The three durable binding ids are exactly the three namespaces the real
  // child run carries as parent links.
  assert.equal(run.parent_platform_id, a.archonConversationId);
  assert.equal(run.parent_conversation_id, a.dbId);
  assert.equal(run.codebase_id, a.expectedCodebaseId);
  const check = verifyParentLinkage(run, a, WF, MSG);
  assert.equal(check.pass, true, JSON.stringify(check.evidence));
});

test('op4c approval preservation: the authority block round-trips verbatim', async () => {
  const { dir, bust } = await freshHome();
  process.env.DSH_HOME = dir;
  try {
    await seedRealStore(dir);
    const modA = await import('../lib/tasks.js?bust=' + bust + '-a');
    const got = await modA.getTask(TASK_ID);
    assert.deepEqual(got.authority, realTask.authority);
    assert.equal(got.authority.preset, 'ASK_BEFORE_ACTION');
    assert.deepEqual(got.authority.missing, ['shell:execute']);
    assert.equal(got.authority.approvedAt, '2026-09-21T00:30:50.780Z');

    await modA.upsertTask(got);
    const modB = await import('../lib/tasks.js?bust=' + bust + '-b');
    const again = await modB.getTask(TASK_ID);
    assert.deepEqual(again.authority, realTask.authority, 'approval record must survive persist + restart');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('op4c retry idempotence: re-upsert never duplicates attempts; unrelated churn never touches the closed record', async () => {
  const { dir, bust } = await freshHome();
  process.env.DSH_HOME = dir;
  try {
    await seedRealStore(dir);
    const modA = await import('../lib/tasks.js?bust=' + bust + '-a');
    const got = await modA.getTask(TASK_ID);
    await modA.upsertTask(got);
    await modA.upsertTask(got); // the "same task again" shape — no attempt rows may appear
    let after = await modA.getTask(TASK_ID);
    assert.equal(after.attempts.length, 1, 're-upsert must not append attempt rows');
    assert.deepEqual(after.attempts, realTask.attempts);

    // Unrelated churn: a different task arrives after the fact.
    const other = { ...realTask, taskId: 'task-unrelated0', status: 'running', verdict: 'PENDING', attempts: [], checks: [], sealedBy: null };
    await modA.upsertTask(other);
    after = await modA.getTask(TASK_ID);
    assert.deepEqual(after, realTask, 'churn must not mutate the historical envelope');

    // And across a restart.
    const modB = await import('../lib/tasks.js?bust=' + bust + '-b');
    after = await modB.getTask(TASK_ID);
    assert.deepEqual(after.attempts, realTask.attempts);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('op4c honest projections: trust stays Observed/truth-null and retry-vs-runId stay consistent', async () => {
  const { dir, bust } = await freshHome();
  process.env.DSH_HOME = dir;
  try {
    await seedRealStore(dir);
    const modA = await import('../lib/tasks.js?bust=' + bust + '-a');
    const got = await modA.getTask(TASK_ID);
    // The ladder never claimed execution: index 0, no truth value.
    assert.deepEqual(got.trust, {
      rungs: ['Observed', 'Executed', 'Validated', 'Objective satisfied'],
      index: 0,
      label: 'Observed',
      truth: null,
    });
    // The retry projection exists ONLY because no run was ever adopted —
    // a retry recommendation next to an adopted runId would be dishonest.
    assert.equal(got.nextAction.kind, 'retry');
    assert.match(got.nextAction.reason, /no run appeared/);
    assert.equal(got.attempts[0].runId, null);
    assert.deepEqual(got.failureCodes, ['run-not-found']);
    assert.equal(got.execution, null, 'no execution truth may be projected for a never-adopted run');
    assert.equal(got.capabilityValidation, null);
    assert.equal(got.objectiveEvaluation, null);
    assert.equal(got.claim, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('op4c integration gap (encoded): run-to-task reconstruction cannot read the forked child', async () => {
  const { projectTaskFromRun, admitTask, taskConversationId } = await import('../lib/task-truth.js');
  // The real child run's conversation_id is a forked 32-hex db id, and the
  // OP-4R flow dispatched on the operator conversation, not an
  // rcos-task-<8hex> conversation — reconstruction returns null for it.
  // The parent-linked T1 adoption (lib/goal.js) is what binds this run;
  // the reconstruction path is a SEPARATE, still-unfixed mechanism.
  assert.equal(projectTaskFromRun(run), null, 'child run must not silently project into a wrong task');
  // Control: a run on a task-named conversation DOES project (the mechanism
  // boundary, not a corruption of the helper).
  const admitted = admitTask('control objective', '01234567-89ab-cdef-0123-456789abcdef');
  assert.equal(admitted.conversationId, taskConversationId('task-01234567'));
  const control = { ...run, conversation_id: admitted.conversationId };
  const projected = projectTaskFromRun(control);
  assert.equal(projected.taskId, 'task-01234567');
  assert.equal(projected.execution.failed, true, 'the failed status carries through');
});
