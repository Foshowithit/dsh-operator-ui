// T3-class Mac-local durability test (spec §10; full T3 with a live operator,
// human approval, and real Archon stays execution-gated). Covers the four
// R-1 acceptance behaviors that are provable without any dispatch:
//   restart recovery — envelopes survive a fresh module load via tasks.json
//   approval preservation — an awaiting-approval envelope round-trips verbatim
//   no dispatch on load — hydrate/persist never POST and never need a live Archon
//   historical-receipt isolation — sealed evidence survives later unrelated churn
// Each subtest gets a fresh module instance via a unique import specifier
// (ESM query = fresh module record), emulating a process restart.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let homeCounter = 0;

async function freshHome() {
  const dir = await mkdtemp(join(tmpdir(), 'opui-t3-'));
  homeCounter += 1;
  return { dir, bust: Date.now() + '-' + homeCounter + '-' + Math.random().toString(36).slice(2) };
}

function awaitingGoal(taskId) {
  return {
    taskId,
    objective: 'Process values.csv and report running totals.',
    failureCodes: ['awaiting-approval'],
    verdict: 'PENDING',
    startedAt: '2026-09-20T00:00:00.000Z',
    checks: [],
    attempts: [],
    authority: {
      preset: 'ASK_BEFORE_ACTION',
      mode: 'approval',
      approvedAt: '2026-09-20T00:00:01.000Z',
      requires: ['filesystem:read'],
      granted: ['filesystem:read', 'git:read', 'browser:read', 'network:outbound', 'external:draft'],
      missing: ['shell:execute'],
    },
  };
}

test('restart recovery + approval preservation: upsert, "restart", read back', async () => {
  const { dir, bust } = await freshHome();
  process.env.DSH_HOME = dir;
  try {
    const modA = await import('../lib/tasks.js?bust=' + bust + '-a');
    const envelope = modA.envelopeFromGoal(awaitingGoal('task-t3a'), null);
    assert.equal(envelope.status, 'awaiting-approval');
    await modA.upsertTask(envelope);

    const file = join(dir, 'operator-ui', 'tasks.json');
    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(onDisk.tasksVersion, 2);
    assert.equal(onDisk.tasks.length, 1);

    // "Restart": brand-new module record, empty cache, hydrates from disk.
    const modB = await import('../lib/tasks.js?bust=' + bust + '-b');
    const revived = await modB.getTask('task-t3a');
    assert.ok(revived, 'envelope must survive restart');
    assert.equal(revived.status, 'awaiting-approval');
    assert.equal(revived.authority.mode, 'approval');
    assert.equal(revived.authority.approvedAt, '2026-09-20T00:00:01.000Z');
    assert.equal(revived.authority.missing[0], 'shell:execute');
    assert.equal(revived.sealedBy, 'goal-runner-m1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('no dispatch on load: hydrate/persist work fully offline and never POST', async () => {
  const { dir, bust } = await freshHome();
  process.env.DSH_HOME = dir;
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ method: (init && init.method) || 'GET', url: String(url) });
    throw new Error('offline-by-test');
  };
  try {
    // Seed a durable file first (as a previous process would have left it).
    await mkdir(join(dir, 'operator-ui'), { recursive: true });
    const seeded = { tasksVersion: 2, tasks: [{ taskId: 'task-t3b', tasksVersion: 2, kind: 'goal', status: 'closed', verdict: 'SHIP', sealedBy: 'goal-runner-m1', evidence: 'learned-csv-running-total-v0-1-0:done' }] };
    await writeFile(join(dir, 'operator-ui', 'tasks.json'), JSON.stringify(seeded, null, 2), 'utf8');

    const modA = await import('../lib/tasks.js?bust=' + bust + '-a');
    assert.equal(calls.length, 0, 'module load must not touch the network');

    const revived = await modA.getTask('task-t3b');
    assert.ok(revived, 'hydrate must work with Archon unreachable');
    // getTask's Archon READ (GET /api/workflows/runs) is legitimate and was
    // attempted (and failed) offline; dispatch would be a POST — none allowed.
    for (const c of calls) assert.notEqual(c.method.toUpperCase(), 'POST', 'no dispatch from this module');
    const beforeUpsert = calls.length;
    await modA.upsertTask({ ...revived, status: 'closed' });
    assert.equal(calls.length, beforeUpsert, 'upsert/persist must not touch the network');
  } finally {
    globalThis.fetch = realFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('historical-receipt isolation: sealed evidence survives later unrelated churn', async () => {
  const { dir, bust } = await freshHome();
  process.env.DSH_HOME = dir;
  try {
    const modA = await import('../lib/tasks.js?bust=' + bust + '-a');
    const historical = modA.envelopeFromGoal(awaitingGoal('task-hist'), null);
    historical.verdict = 'SHIP';
    historical.evidence = 'RESULT row=1 total=23\nRESULT row=6 total=118\nlearned-csv-running-total-v0-1-0:done';
    await modA.upsertTask(historical);

    const modB = await import('../lib/tasks.js?bust=' + bust + '-b');
    // Later, unrelated churn in a "new process".
    await modB.upsertTask({
      taskId: 'task-later', tasksVersion: 2, kind: 'goal', objective: 'unrelated',
      status: 'closed', verdict: 'FAILED', createdAt: '2026-09-20T01:00:00.000Z',
    });
    const after = await modB.getTask('task-hist');
    assert.ok(after, 'historical envelope must not be evicted/overwritten by churn');
    assert.equal(after.verdict, 'SHIP');
    assert.equal(after.evidence, historical.evidence, 'sealed evidence must round-trip byte-identical');
    assert.equal(after.sealedBy, 'goal-runner-m1');
    // And the durable file holds both, historical intact.
    const onDisk = JSON.parse(await readFile(join(dir, 'operator-ui', 'tasks.json'), 'utf8'));
    const diskHist = onDisk.tasks.find((t) => t.taskId === 'task-hist');
    assert.ok(diskHist && diskHist.evidence === historical.evidence);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
