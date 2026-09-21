// OP-4R Phase C-R acceptance tests (GPT work order, 2026-09-21).
//
// What these tests must establish, in GPT's words:
//   - "a verified child-run association survives a fresh process"
//   - "a second child of the same parent cannot be mistaken for the first attempt"
//   - "wrong workflow/project/parent evidence fails closed"
//   - cover "missing run detail, an unresolved historical association, a
//     successful empty run list, an Archon fetch failure, and recovery after
//     that failure"
//   - "a restart must neither create another conversation nor dispatch
//     another workflow"
//
// Every input is a captured historical record: the REAL persisted operator
// envelope (fixture) and the REAL failed Archon run (t1 fixture), plus
// synthetic siblings derived from the real run where the scenario needs a
// second child. Archon is stubbed at globalThis.fetch with a per-call log;
// the log doubles as a network allowlist proof (GET /runs reads only — never
// a conversation create or a workflow dispatch). "Restart" = a unique import
// specifier, the same convention as tasks-durability.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_URL = new URL('./fixtures/op4-real-envelope-task-970ff68d.json', import.meta.url);
const RUN_FIXTURE_URL = new URL('./fixtures/op4-real-run-7245beda.json', import.meta.url);

const TASK_ID = 'task-970ff68d';
const WF = 'csv-running-total-v1';
const MSG = 'task task-970ff68d: Process values.csv in order and report running total after each row';

const fixture = JSON.parse(await readFile(FIXTURE_URL, 'utf8'));
const { run: realRun } = JSON.parse(await readFile(RUN_FIXTURE_URL, 'utf8'));
const realTask = fixture.tasks[0];

const { verifyParentLinkage, adoptionRecord, nextAction } = await import('../lib/goal.js');
const { projectTaskFromRun } = await import('../lib/task-truth.js');
const { validateStoredAssociation, reconcileAdoptedRun } = await import('../lib/reconcile.js');

// A synthetic SECOND child of the SAME parent: every verification leg except
// the run's own identity is identical to the real child, because that is
// exactly what a redispatch would look like from the outside.
const SECOND_ID = '7245beda-0000-4000-8000-0000000000b2';
const secondChildRun = () => ({ ...realRun, id: SECOND_ID, conversation_id: 'ffff0000ffff0000ffff0000ffff0001' });

// The T1-shaped envelope: the real historical envelope plus one attempt whose
// run pointer and adoption block are exactly what production's
// adoptionRecord() builds from the real run detail.
function adoptedEnvelope() {
  const evidence = verifyParentLinkage(realRun, realTask.conversation, WF, MSG).evidence;
  assert.equal(evidence.every((e) => e.pass), true, 'real run must verify against the real association');
  const adoption = adoptionRecord({
    mode: 'direct-exact',
    detail: realRun,
    conversationId: realTask.conversation.archonConversationId,
    workflowName: WF,
    evidence,
    candidatesConsidered: 1,
    discoveredAfterMs: 4321,
    detailText: JSON.stringify(realRun),
  });
  return JSON.parse(JSON.stringify({ ...realTask, attempts: [{ ...realTask.attempts[0], runId: realRun.id, adoption }] }));
}

const jsonRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// Archon stub with a call log. Everything default-deny: an id with no detail
// entry answers 404 (Archon ANSWERING absence — distinct from an outage).
function stubArchon({ runs = [], details = {}, failList = false, listStatus = null, listBody = null, failDetail = [], detailStatus = {} } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ method: (opts && opts.method) || 'GET', url: u });
    const path = u.replace(/^https?:\/\/[^/]+/, '');
    if (path.startsWith('/api/workflows/runs?')) {
      if (failList) throw new Error('fetch failed (stubbed Archon outage)');
      if (listStatus != null) return jsonRes({ error: 'stub' }, listStatus);
      if (listBody === 'INVALID_JSON') return { ok: true, status: 200, json: async () => { throw new Error('Unexpected token in JSON'); } };
      if (listBody != null) return jsonRes(listBody);
      return jsonRes({ runs });
    }
    const m = path.match(/^\/api\/workflows\/runs\/(.+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (detailStatus[id] != null) return jsonRes({ error: 'stub' }, detailStatus[id]);
      if (failDetail.includes(id)) throw new Error('fetch failed (stubbed Archon outage)');
      if (!Object.prototype.hasOwnProperty.call(details, id)) return jsonRes({ error: 'not found' }, 404);
      return jsonRes(details[id]);
    }
    return jsonRes({ error: 'unexpected path ' + path }, 500);
  };
  return calls;
}
const detailCalls = (calls) => calls.filter((c) => /\/api\/workflows\/runs\/[^?]/.test(c.url));

let homeCounter = 0;
async function freshHome(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix || 'opui-op4r-'));
  homeCounter += 1;
  return { dir, bust: Date.now() + '-' + homeCounter + '-' + Math.random().toString(36).slice(2) };
}

async function seedStore(dir, tasks, tasksVersion) {
  await mkdir(join(dir, 'operator-ui'), { recursive: true });
  await writeFile(join(dir, 'operator-ui', 'tasks.json'), JSON.stringify({ tasksVersion: tasksVersion || 2, tasks }, null, 2) + '\n');
}
async function seedRealStore(dir) {
  await seedStore(dir, fixture.tasks, fixture.tasksVersion);
}
async function readDiskStore(dir) {
  return JSON.parse(await readFile(join(dir, 'operator-ui', 'tasks.json'), 'utf8'));
}

// --- 1. Outage vs empty at the read boundary --------------------------------

test('op4r read boundary: a successful empty list is ok; an Archon fetch failure is unavailable — never conflated', async () => {
  const { dir, bust } = await freshHome();
  process.env.DSH_HOME = dir;
  try {
    const mod = await import('../lib/tasks.js?bust=' + bust);

    stubArchon({ runs: [] });
    let read = await mod.listTasksRead();
    assert.equal(read.state, 'ok');
    assert.deepEqual(read.tasks, []);
    read = await mod.getTaskRead('task-absent');
    assert.equal(read.state, 'ok');
    assert.equal(read.task, null, 'successful empty read answers task-not-found, not an error');

    stubArchon({ failList: true });
    await assert.rejects(
      () => mod.getTaskRead('task-absent'),
      (err) => err.code === 'archon-unavailable',
      'an outage with no cached envelope must throw the distinct archon-unavailable code, never a quiet null'
    );
    let out = await mod.listTasksRead();
    assert.equal(out.state, 'unavailable');
    assert.match(out.reason, /could not be reached/);

    out = await (stubArchon({ listStatus: 503 }), mod.listTasksRead());
    assert.equal(out.state, 'unavailable');
    assert.match(out.reason, /HTTP 503/);

    out = await (stubArchon({ listBody: 'INVALID_JSON' }), mod.listTasksRead());
    assert.equal(out.state, 'unavailable');
    assert.match(out.reason, /invalid JSON/);

    out = await (stubArchon({ listBody: { nope: true } }), mod.listTasksRead());
    assert.equal(out.state, 'unavailable');
    assert.match(out.reason, /no runs array/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 2. THE DEMO: restart reconstruction of the verified child association --

test('op4r restart: the verified child association reconstructs from disk, re-validates by run id, and re-reads are idempotent', async () => {
  const { dir, bust } = await freshHome();
  process.env.DSH_HOME = dir;
  try {
    await seedStore(dir, [adoptedEnvelope()]);
    const modA = await import('../lib/tasks.js?bust=' + bust + '-a');
    const calls = stubArchon({ runs: [], details: { [realRun.id]: realRun } });

    const read = await modA.getTaskRead(TASK_ID);
    assert.equal(read.state, 'ok');
    assert.equal(read.identity.state, 'reconciled');
    assert.equal(read.identity.runId, realRun.id);
    assert.equal(read.identity.childConversationId, realRun.conversation_id);
    assert.equal(read.identity.statusObserved, 'failed');

    // The attempt's never-recorded status is filled from the VERIFIED run,
    // marked as a reconciliation observation — never silently rewritten.
    const attempt = read.task.attempts.find((a) => a.adoption && a.adoption.runId === realRun.id);
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.statusObserved.from, 'reconciliation');
    assert.equal(attempt.childConversationId, realRun.conversation_id);

    const entry = read.task.reconciliation[0];
    assert.equal(entry.kind, 'child-run-association-verified');
    assert.equal(entry.runId, realRun.id);
    assert.equal(entry.statusObserved, 'failed');
    assert.equal(entry.evidence.length, 5);
    assert.equal(entry.evidence.every((e) => e.pass), true, JSON.stringify(entry.evidence));

    // Historical observation immutable: the original FAILED verdict and the
    // authority block survive the reconciliation byte-for-byte.
    assert.equal(read.task.verdict, 'FAILED');
    assert.deepEqual(read.task.failureCodes, ['run-not-found']);
    assert.equal(read.task.error, 'dispatch accepted but no run appeared');
    assert.equal(read.task.status, 'closed');
    assert.deepEqual(read.task.authority, realTask.authority);
    assert.deepEqual(read.task.trust, realTask.trust);

    // Network allowlist: reads only. A restart must neither create another
    // conversation nor dispatch another workflow.
    assert.ok(calls.length >= 2, 'list + detail must have been read');
    for (const c of calls) {
      assert.equal(c.method, 'GET', 'reconciliation is read-only: ' + c.url);
      assert.match(c.url, /^http:\/\/127\.0\.0\.1:3090\/api\/workflows\/runs/, 'only the runs API is touched: ' + c.url);
      assert.ok(!c.url.includes('/api/conversations'), 'never creates a conversation');
      assert.ok(!c.url.includes('dispatch'), 'never dispatches a workflow');
    }
    assert.deepEqual(
      detailCalls(calls).map((c) => c.url),
      ['http://127.0.0.1:3090/api/workflows/runs/' + encodeURIComponent(realRun.id)],
      'the stored run id is the ONLY run ever fetched — no parent-id sweep'
    );

    // The reconciliation was persisted.
    const disk = await readDiskStore(dir);
    const diskTask = disk.tasks.find((t) => t.taskId === TASK_ID);
    assert.equal(diskTask.reconciliation.length, 1);
    assert.equal(diskTask.reconciliation[0].kind, 'child-run-association-verified');
    assert.equal(diskTask.attempts[0].status, 'failed');

    // Restart: a fresh process hydrates the persisted association and
    // REPLAYS it — no re-read, no duplicate append, no second dispatch.
    const modB = await import('../lib/tasks.js?bust=' + bust + '-b');
    const replayCalls = stubArchon({ runs: [], details: { [realRun.id]: realRun } });
    const replay = await modB.getTaskRead(TASK_ID);
    assert.equal(replay.state, 'ok');
    assert.equal(replay.identity.state, 'reconciled');
    assert.equal(replay.identity.replayed, true);
    assert.equal(replay.identity.runId, realRun.id);
    assert.equal(replay.task.reconciliation.length, 1, 'no duplicate entry on replay');
    assert.equal(detailCalls(replayCalls).length, 0, 'replay re-fetches nothing: the persisted verdict is consumed, not re-derived');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 3. Second-child protection ---------------------------------------------

test('op4r second child of the same parent is never mistaken for the stored attempt', async () => {
  const { dir, bust } = await freshHome();
  process.env.DSH_HOME = dir;
  try {
    await seedStore(dir, [adoptedEnvelope()]);
    const mod = await import('../lib/tasks.js?bust=' + bust + '-a');
    // The NEWER sibling sits first in the list, the way Archon returns recent
    // runs — the stored id must still be the only one fetched.
    const calls = stubArchon({ runs: [secondChildRun(), realRun], details: { [realRun.id]: realRun, [SECOND_ID]: secondChildRun() } });

    const read = await mod.getTaskRead(TASK_ID);
    assert.equal(read.identity.state, 'reconciled');
    assert.equal(read.identity.runId, realRun.id, 'the stored association selects the stored run, not the newest sibling');
    assert.deepEqual(
      detailCalls(calls).map((c) => decodeURIComponent(c.url.split('/runs/')[1])),
      [realRun.id],
      'the second child is never fetched, let alone adopted'
    );

    // Tampered detail: the retrieved id does not match the stored id — the
    // association refuses and nothing is appended.
    const { dir: dir2, bust: bust2 } = await freshHome();
    process.env.DSH_HOME = dir2;
    try {
      await seedStore(dir2, [adoptedEnvelope()]);
      const mod2 = await import('../lib/tasks.js?bust=' + bust2 + '-a');
      stubArchon({ runs: [], details: { [realRun.id]: secondChildRun() } });
      const bad = await mod2.getTaskRead(TASK_ID);
      assert.equal(bad.identity.state, 'unresolved');
      assert.ok(
        bad.identity.reason.includes('child-run-id mismatch: retrieved run ' + SECOND_ID + ' is not the stored adopted run ' + realRun.id),
        'mismatch names both runs, got: ' + bad.identity.reason
      );
      assert.equal(bad.task.reconciliation, undefined, 'no entry is appended on a mismatch');
      assert.equal(bad.task.attempts[0].status, null, 'the attempt status is never filled from an unverified run');
      assert.equal(bad.task.verdict, 'FAILED');
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 4. Fail-closed legs ------------------------------------------------------

test('op4r fail-closed: wrong workflow, parent, project, or message evidence refuses the association', async () => {
  const association = realTask.conversation;
  const adoption = adoptedEnvelope().attempts[0].adoption;
  const leg = (tampered) => {
    const verdict = validateStoredAssociation({ detail: { ...realRun, ...tampered }, adoption, association });
    return verdict;
  };

  let v = leg({ workflow_name: 'other-wf-v9' });
  assert.equal(v.pass, false);
  assert.match(v.reason, /workflow mismatch: run .* is other-wf-v9, association expects csv-running-total-v1/);

  v = leg({ parent_conversation_id: 'deadbeefdeadbeefdeadbeefdeadbeef' });
  assert.equal(v.pass, false);
  assert.match(v.reason, /parent-link verification failed on legs: parent-conversation-id/);

  v = leg({ parent_platform_id: 'web-bogus' });
  assert.equal(v.pass, false);
  assert.match(v.reason, /parent-link verification failed on legs: parent-platform-id/);

  v = leg({ codebase_id: 'c0ffee00c0ffee00c0ffee00c0ffee00' });
  assert.equal(v.pass, false);
  assert.match(v.reason, /parent-link verification failed on legs: codebase-id/);

  v = leg({ user_message: 'task task-970ff68d: something entirely different' });
  assert.equal(v.pass, false);
  assert.match(v.reason, /parent-link verification failed on legs: user-message/);

  // Missing association evidence fails closed rather than passing vacuously.
  v = validateStoredAssociation({ detail: realRun, adoption, association: null });
  assert.equal(v.pass, false);
  assert.match(v.reason, /parent-link verification failed on legs: parent-conversation-id, parent-platform-id, codebase-id/);

  v = validateStoredAssociation({ detail: realRun, adoption: null, association });
  assert.equal(v.pass, false);
  assert.equal(v.reason, 'no verified association stored on the attempt');

  // End-to-end: a wrong-project detail leaves the envelope untouched.
  const { dir, bust } = await freshHome();
  process.env.DSH_HOME = dir;
  try {
    await seedStore(dir, [adoptedEnvelope()]);
    const mod = await import('../lib/tasks.js?bust=' + bust + '-a');
    stubArchon({ runs: [], details: { [realRun.id]: { ...realRun, codebase_id: 'c0ffee00c0ffee00c0ffee00c0ffee00' } } });
    const read = await mod.getTaskRead(TASK_ID);
    assert.equal(read.identity.state, 'unresolved');
    assert.match(read.identity.reason, /codebase-id/);
    assert.equal(read.task.reconciliation, undefined);
    assert.equal(read.task.attempts[0].status, null);
    assert.equal(read.task.verdict, 'FAILED');
    assert.deepEqual(read.task.failureCodes, ['run-not-found']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 5. Missing run detail: an ANSWER, not an outage -------------------------

test('op4r missing run detail (HTTP 404) is an answer: unresolved, envelope untouched, distinct from an outage', async () => {
  const { dir, bust } = await freshHome();
  process.env.DSH_HOME = dir;
  try {
    await seedStore(dir, [adoptedEnvelope()]);
    const mod = await import('../lib/tasks.js?bust=' + bust);
    const calls = stubArchon({ runs: [], details: {} }); // every detail id -> 404
    const read = await mod.getTaskRead(TASK_ID);
    assert.equal(read.state, 'ok', 'a 404 is Archon answering — the read itself succeeded');
    assert.equal(read.task.archonRead, undefined, 'an answer is never dressed up as an outage');
    assert.equal(read.identity.state, 'unresolved');
    assert.equal(read.identity.reason, 'run detail unavailable for the stored run id');
    assert.equal(read.task.reconciliation, undefined);
    assert.equal(read.task.attempts[0].status, null);
    assert.equal(read.task.verdict, 'FAILED');
    assert.equal(detailCalls(calls).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 6. Detail-read outage during reconciliation: skipped, never recorded ----

test('op4r a detail-read outage during reconciliation is skipped silently — never recorded as an identity verdict', async () => {
  const { dir, bust } = await freshHome();
  process.env.DSH_HOME = dir;
  try {
    await seedStore(dir, [adoptedEnvelope()]);
    const mod = await import('../lib/tasks.js?bust=' + bust);
    stubArchon({ runs: [], failDetail: [realRun.id] });
    const read = await mod.getTaskRead(TASK_ID);
    assert.equal(read.state, 'ok', 'the list read succeeded, so the envelope read is ok');
    assert.equal(read.identity, null, 'an outage makes no identity claim either way');
    assert.equal(read.task.archonRead, undefined);
    assert.equal(read.task.reconciliation, undefined, 'nothing was appended during the outage');
    assert.equal(read.task.attempts[0].status, null);
    const disk = await readDiskStore(dir);
    assert.equal(disk.tasks[0].reconciliation, undefined, 'the outage was not persisted as evidence');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 7. Unresolved historical association ------------------------------------

test('op4r unresolved historical association: a successful empty read makes no claim and preserves the original observation', async () => {
  const { dir, bust } = await freshHome();
  process.env.DSH_HOME = dir;
  try {
    await seedRealStore(dir);
    const mod = await import('../lib/tasks.js?bust=' + bust);
    stubArchon({ runs: [] });
    const read = await mod.getTaskRead(TASK_ID);
    assert.equal(read.state, 'ok');
    assert.equal(read.identity.state, 'unresolved');
    assert.equal(read.identity.reason, 'no verified association: no run in a successful read satisfies the persisted association');
    // The REAL envelope is history: nothing appended, nothing rewritten.
    assert.equal(read.task.reconciliation, undefined);
    assert.equal(read.task.verdict, 'FAILED');
    assert.deepEqual(read.task.failureCodes, ['run-not-found']);
    assert.equal(read.task.attempts[0].runId, null);
    const disk = await readDiskStore(dir);
    assert.equal(disk.tasks[0].reconciliation, undefined, 'an unresolved-by-evidence read does not mutate the store either');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 8. Identified historical run --------------------------------------------

test('op4r identified historical run appends evidence and preserves the original observation verbatim', async () => {
  const { dir, bust } = await freshHome();
  process.env.DSH_HOME = dir;
  try {
    await seedRealStore(dir);
    const modA = await import('../lib/tasks.js?bust=' + bust + '-a');
    const calls = stubArchon({ runs: [realRun], details: { [realRun.id]: realRun } });
    const read = await modA.getTaskRead(TASK_ID);
    assert.equal(read.state, 'ok');
    assert.equal(read.identity.state, 'identified');
    assert.equal(read.identity.runId, realRun.id);
    assert.equal(read.identity.statusObserved, 'failed');
    const entry = read.task.reconciliation[0];
    assert.equal(entry.kind, 'child-run-identified');
    assert.equal(entry.runId, realRun.id);
    assert.equal(entry.evidence.every((e) => e.pass), true);

    // Original observation preserved: the append names the failed child run
    // but rewrites nothing.
    assert.equal(read.task.verdict, 'FAILED');
    assert.deepEqual(read.task.failureCodes, ['run-not-found']);
    assert.equal(read.task.error, 'dispatch accepted but no run appeared');
    assert.equal(read.task.attempts[0].runId, null, 'the historical attempt is never backfilled');
    assert.equal(read.task.attempts[0].status, null);
    assert.equal(read.task.objectiveEvaluation, null, 'no objective satisfaction is projected');
    const disk = await readDiskStore(dir);
    assert.equal(disk.tasks[0].reconciliation.length, 1);

    // Re-open: the existing entry blocks a re-run — no duplicate, no extra reads.
    const callsBefore = calls.length;
    const read2 = await modA.getTaskRead(TASK_ID);
    assert.equal(read2.identity, null, 'history already identified — no new verdict');
    assert.equal(read2.task.reconciliation.length, 1);
    assert.equal(calls.length - callsBefore, 1, 'only the list read happens; no detail re-fetch');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 9. Ambiguous historical association -------------------------------------

test('op4r ambiguous historical: two verifying children create an explicit ambiguity, never an attribution', async () => {
  const { dir, bust } = await freshHome();
  process.env.DSH_HOME = dir;
  try {
    await seedRealStore(dir);
    const mod = await import('../lib/tasks.js?bust=' + bust);
    stubArchon({ runs: [secondChildRun(), realRun], details: { [realRun.id]: realRun, [SECOND_ID]: secondChildRun() } });
    const read = await mod.getTaskRead(TASK_ID);
    assert.equal(read.state, 'ok');
    assert.equal(read.identity.state, 'unresolved');
    assert.match(read.identity.reason, /^ambiguous: 2 runs independently verify against the persisted association \(/);
    assert.ok(read.identity.reason.includes(realRun.id));
    assert.ok(read.identity.reason.includes(SECOND_ID));
    const entry = read.task.reconciliation[0];
    assert.equal(entry.kind, 'identification-ambiguous');
    assert.equal(entry.candidates.length, 2);
    assert.ok(entry.candidates.includes(realRun.id) && entry.candidates.includes(SECOND_ID));
    assert.equal(read.task.attempts[0].runId, null, 'ambiguity never backfills the attempt');
    assert.equal(read.task.verdict, 'FAILED');
    const disk = await readDiskStore(dir);
    assert.equal(disk.tasks[0].reconciliation[0].kind, 'identification-ambiguous');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 10. Outage ≠ empty projection + recovery --------------------------------

test('op4r outage markers are per-read cosmetics: cache and store stay clean, and a later successful read recovers', async () => {
  const { dir, bust } = await freshHome();
  process.env.DSH_HOME = dir;
  try {
    await seedRealStore(dir);
    const modA = await import('../lib/tasks.js?bust=' + bust + '-a');

    stubArchon({ failList: true });
    let read = await modA.getTaskRead(TASK_ID);
    assert.equal(read.state, 'unavailable');
    assert.equal(read.task.archonRead, 'unavailable');
    assert.equal(typeof read.task.archonReadReason, 'string');

    let list = await modA.listTasksRead();
    assert.equal(list.state, 'unavailable');
    assert.equal(list.tasks[0].archonRead, 'unavailable', 'the cached envelope is served, explicitly marked');

    // Recovery: the next successful read serves the CLEAN record — the marker
    // never entered the cache.
    stubArchon({ runs: [] });
    read = await modA.getTaskRead(TASK_ID);
    assert.equal(read.state, 'ok');
    assert.equal(read.task.archonRead, undefined);
    assert.equal(read.task.archonReadReason, undefined);
    assert.deepEqual(read.task, realTask, 'the recovered envelope is the historical record verbatim');
    list = await modA.listTasksRead();
    assert.equal(list.state, 'ok');
    assert.equal(list.tasks[0].archonRead, undefined);

    // Marker hygiene: even a marked copy handed back into upsertTask never
    // reaches the durable store.
    const marked = { ...realTask, archonRead: 'unavailable', archonReadReason: 'archon could not be reached (x)' };
    const clean = await modA.upsertTask(marked);
    assert.equal(clean.archonRead, undefined);
    const modB = await import('../lib/tasks.js?bust=' + bust + '-b');
    stubArchon({ runs: [] });
    const fromDisk = await modB.getTaskRead(TASK_ID);
    assert.equal(fromDisk.task.archonRead, undefined);
    assert.deepEqual(fromDisk.task, realTask, 'no marker ever persists');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 11. discoverRun: outage vs found vs none --------------------------------

test('op4r discoverRun: an outage is "unavailable" (never a retry signal), a verified run is "found", a clean empty read is "none"', async () => {
  const { dir, bust } = await freshHome('opui-op4r-discover-');
  process.env.DSH_HOME = dir;
  try {
    const { discoverRun } = await import('../lib/goal.js');
    const base = {
      workflowName: WF,
      preIds: new Set(),
      association: realTask.conversation,
      dispatchedMessage: MSG,
    };

    // (a) Every read fails -> unavailable, with the outage-not-absence reason.
    stubArchon({ failList: true });
    let d = await discoverRun({ ...base, conversationId: realRun.conversation_id });
    assert.equal(d.status, 'unavailable');
    assert.equal(d.adoption, null);
    assert.match(d.reason, /never returned a successful read/);
    assert.match(d.reason, /outage, not absence/);

    // (b) Fail-then-serve -> found by direct child-conversation identity.
    let flips = 0;
    globalThis.fetch = async (url) => {
      const u = String(url);
      const path = u.replace(/^https?:\/\/[^/]+/, '');
      if (path.startsWith('/api/workflows/runs?')) {
        if (flips === 0) { flips += 1; throw new Error('fetch failed (first read only)'); }
        return jsonRes({ runs: [realRun] });
      }
      return jsonRes({ run: realRun });
    };
    d = await discoverRun({ ...base, conversationId: realRun.conversation_id });
    assert.equal(d.status, 'found');
    assert.equal(d.adoption.mode, 'direct-exact');
    assert.equal(d.adoption.runId, realRun.id);
    assert.equal(d.adoption.userMessage, MSG);

    // (c) The run sits on the PARENT conversation only -> parent-linked mode,
    // held for the settle polls, still found with full five-leg evidence.
    stubArchon({ runs: [realRun], details: { [realRun.id]: realRun } });
    d = await discoverRun({ ...base, conversationId: realTask.conversation.archonConversationId });
    assert.equal(d.status, 'found');
    assert.equal(d.adoption.mode, 'parent-linked');
    assert.equal(d.adoption.runId, realRun.id);
    assert.equal(d.adoption.evidence.every((e) => e.pass), true);

    // (d) Successful reads, genuinely empty -> "none": absence was ANSWERED,
    // which is a different world from (a).
    stubArchon({ runs: [] });
    d = await discoverRun({ ...base, conversationId: realRun.conversation_id });
    assert.equal(d.status, 'none');
    assert.equal(d.adoption, null);
    assert.equal(d.reason, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 12. nextAction ladder: outage is inspect, never retry -------------------

test('op4r nextAction: an archon-unavailable attempt routes to inspect — an outage is never a retry signal', () => {
  const a = nextAction({ verdict: 'FAILED', failureCodes: ['archon-unavailable'], trust: 'Observed' });
  assert.equal(a.kind, 'inspect');
  assert.equal(a.label, 'Inspect Archon availability');
  assert.match(a.reason, /an outage is never a retry signal/);

  // Contrast: genuine absence (run-not-found) still routes to retry — the
  // distinction between the two failure codes is load-bearing.
  const r = nextAction({ verdict: 'FAILED', failureCodes: ['run-not-found'], trust: 'Observed' });
  assert.equal(r.kind, 'retry');
});

// --- 13. projectTaskFromRun: no parent-id ownership shortcut -----------------

test('op4r projectTaskFromRun infers ownership from the legacy token only — never from a child run parent id', () => {
  // The REAL forked child carries full parent linkage to the real association,
  // but its own conversation is not a legacy rcos-task token: no projection.
  assert.equal(realRun.parent_conversation_id, realTask.conversation.dbId);
  assert.equal(realRun.parent_platform_id, realTask.conversation.archonConversationId);
  assert.equal(projectTaskFromRun(realRun), null, 'parent linkage alone projects nothing');
  assert.equal(projectTaskFromRun(secondChildRun()), null, 'a second child projects nothing either');

  // The legacy path stays intact for records that genuinely use it.
  const legacy = projectTaskFromRun({ id: realRun.id, conversation_id: 'rcos-task-970ff68d', workflow_name: WF, status: 'failed' });
  assert.deepEqual(legacy, {
    taskId: TASK_ID,
    runId: realRun.id,
    workflow: WF,
    execution: { status: 'failed', completed: false, failed: true },
  });
});
