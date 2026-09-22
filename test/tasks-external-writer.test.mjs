// D1 refresh-boundary (OP-5 §3): the durable file is re-synchronized by
// content hash at every async read/write entry, so the one-shot hydrate is
// never permanent authority. The spec names the hazard as CONCURRENT WRITERS,
// not concurrent readers — these tests drive an EXTERNAL writer (plain fs
// writes, no module, no lock) against a live module instance and prove:
//   (i)  a live SHIP envelope replaces an older cached FAILED projection with
//        NO restart — another legitimate process updated the same task
//   (ii) two writers on the SAME task fail CLOSED: the stale expectedFp
//        write-back is refused, disk keeps the newer durable bytes, and
//        memory adopts the disk winner — never last-writer-wins over the
//        objective history
//   (iii) an external write to a DIFFERENT task never false-conflicts our
//        persist (no permanent wedge after ordinary external churn)
//   (iv)  a genuinely FAILED historical envelope round-trips untouched when
//        nothing external changed — the separate FAILED regression stays
//        distinct from any stale-live-state assertion
// Fully offline: globalThis.fetch is stubbed to throw, proving none of this
// needs a live Archon.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let homeCounter = 0;

async function freshHome() {
  const dir = await mkdtemp(join(tmpdir(), 'opui-d1-'));
  homeCounter += 1;
  return { dir, bust: Date.now() + '-' + homeCounter + '-' + Math.random().toString(36).slice(2) };
}

function goalEnvelope(taskId, verdict, extra = {}) {
  return {
    taskId,
    tasksVersion: 2,
    kind: 'goal',
    objective: 'Process values.csv and report running totals.',
    status: 'closed',
    verdict,
    failureCodes: verdict === 'FAILED' ? ['run-not-found'] : [],
    sealedBy: 'goal-runner-m1',
    attempts: [],
    checks: [],
    ...extra,
  };
}

async function seedStore(dir, tasks) {
  await mkdir(join(dir, 'operator-ui'), { recursive: true });
  const file = join(dir, 'operator-ui', 'tasks.json');
  await writeFile(file, JSON.stringify({ tasksVersion: 2, tasks }, null, 2) + '\n', 'utf8');
  return file;
}

// Another legitimate process writes tasks.json directly — no module instance,
// no lock, no cooperation with ours. This is exactly the concurrent-writer
// hazard D1 must handle (the guarded DSH-web reconciliation append, a second
// operator session, an operator's correction script).
async function externalWrite(dir, mutate) {
  const file = join(dir, 'operator-ui', 'tasks.json');
  const doc = JSON.parse(await readFile(file, 'utf8'));
  const next = mutate(doc) || doc;
  await writeFile(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return file;
}

async function withOffline(fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline-by-test'); };
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}

test('(i) live SHIP replaces an older cached FAILED projection — no restart', async () => {
  const { dir, bust } = await freshHome();
  process.env.DSH_HOME = dir;
  try {
    await withOffline(async () => {
      await seedStore(dir, [goalEnvelope('task-d1a', 'FAILED')]);
      const mod = await import('../lib/tasks.js?bust=' + bust + '-a');

      // The process boots and reads while the task is still FAILED — its
      // cache now holds the OLD projection (the DSH web process at 07:37).
      const before = await mod.getTask('task-d1a');
      assert.ok(before, 'envelope readable while FAILED');
      assert.equal(before.verdict, 'FAILED', 'cache hydrated the pre-ship projection');

      // Another legitimate process seals the task SHIP on disk. No restart,
      // no re-import, no signal to us.
      await externalWrite(dir, (doc) => {
        const t = doc.tasks.find((x) => x.taskId === 'task-d1a');
        t.verdict = 'SHIP';
        t.failureCodes = [];
        t.nextAction = { kind: 'ship', label: 'Ship it' };
      });

      // The SAME module instance adopts it live at the next read entry.
      const after = await mod.getTask('task-d1a');
      assert.equal(after.verdict, 'SHIP', 'live SHIP envelope replaces the stale FAILED projection');
      assert.deepEqual(after.failureCodes, [], 'stale failure codes gone with the stale projection');
      assert.equal(after.nextAction && after.nextAction.kind, 'ship');
      const cached = mod.peekTask('task-d1a');
      assert.equal(cached.verdict, 'SHIP', 'every subsequent reader serves the fresh durable copy');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('(ii) concurrent SAME-task writers fail closed — disk keeps the newer bytes, memory adopts the disk winner', async () => {
  const { dir, bust } = await freshHome();
  process.env.DSH_HOME = dir;
  try {
    await withOffline(async () => {
      await seedStore(dir, [goalEnvelope('task-d1b', 'FAILED')]);
      const mod = await import('../lib/tasks.js?bust=' + bust + '-b');

      // The read model reads the envelope; its fingerprint is captured at
      // read time — this is the exact guard getTaskRead's reconciliation
      // upsert uses before writing back (requirement g).
      const read = await mod.getTask('task-d1b');
      const expectedFp = mod.taskFp(read);
      assert.ok(expectedFp, 'fingerprint of the read copy');

      // A second writer lands between read and write-back, moving the SAME
      // task on disk.
      await externalWrite(dir, (doc) => {
        const t = doc.tasks.find((x) => x.taskId === 'task-d1b');
        t.verdict = 'SHIP';
        t.objective = 'NEWER durable objective history — must not be clobbered';
      });
      const diskAfter = await readFile(join(dir, 'operator-ui', 'tasks.json'), 'utf8');

      // The stale write-back must FAIL CLOSED — never a silent
      // last-writer-wins overwrite of the objective history.
      await assert.rejects(
        () => mod.upsertTask({ ...read, verdict: 'FAILED', evidence: 'stale-writeback' }, { expectedFp }),
        (err) => Boolean(err) && err.code === 'task-conflict',
        'upsert with a stale expectedFp refuses the publish (task-conflict)');

      // The refused write left the durable history byte-identical.
      assert.equal(await readFile(join(dir, 'operator-ui', 'tasks.json'), 'utf8'), diskAfter,
        'durable objective history untouched by the refused write');

      // Memory adopted the disk winner before refusing — no wedge, no stale
      // authority: the next read serves the SECOND writer's truth.
      const after = mod.peekTask('task-d1b');
      assert.ok(after, 'task still present after the conflict (not evicted)');
      assert.equal(after.verdict, 'SHIP', 'memory holds the disk winner, not our rejected copy');
      assert.match(after.objective, /NEWER durable/, 'the newer durable history survives in cache too');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('(iii) external write to a DIFFERENT task never false-conflicts our persist', async () => {
  const { dir, bust } = await freshHome();
  process.env.DSH_HOME = dir;
  try {
    await withOffline(async () => {
      await seedStore(dir, [goalEnvelope('task-d1c1', 'FAILED')]);
      const mod = await import('../lib/tasks.js?bust=' + bust + '-c');

      const mine = await mod.getTask('task-d1c1');
      assert.equal(mine.verdict, 'FAILED');

      // External churn adds an UNRELATED task — our next publish of ours
      // must succeed (only SAME-task divergence is a conflict) and must
      // PRESERVE the external addition in the rewrite.
      await externalWrite(dir, (doc) => {
        doc.tasks.push(goalEnvelope('task-d1c2', 'SHIP'));
      });

      await mod.upsertTask({ ...mine, evidence: 'republished-after-external-churn' });

      const final = JSON.parse(await readFile(join(dir, 'operator-ui', 'tasks.json'), 'utf8'));
      const ours = final.tasks.find((t) => t.taskId === 'task-d1c1');
      const theirs = final.tasks.find((t) => t.taskId === 'task-d1c2');
      assert.equal(ours && ours.evidence, 'republished-after-external-churn', 'our publish landed');
      assert.ok(theirs, 'the external task is preserved in the rewrite — no wedge, no clobber');
      assert.equal(theirs.verdict, 'SHIP');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('(iv) a genuinely FAILED historical envelope round-trips untouched', async () => {
  const { dir, bust } = await freshHome();
  process.env.DSH_HOME = dir;
  try {
    await withOffline(async () => {
      const historical = goalEnvelope('task-d1d', 'FAILED', {
        attempts: [
          { attempt: 1, workflow: 'csv-running-total-v1', runId: null, status: 'refused', failureCode: 'run-not-found' },
        ],
        nextAction: { kind: 'operator-action', label: 'Inspect the task' },
      });
      await seedStore(dir, [historical]);
      const mod = await import('../lib/tasks.js?bust=' + bust + '-d');

      // Two full sync passes — hydration then a second read entry.
      const first = await mod.getTask('task-d1d');
      const second = await mod.getTask('task-d1d');
      for (const read of [first, second]) {
        assert.equal(read.verdict, 'FAILED', 'FAILED verdict preserved — no drift toward a live state');
        assert.deepEqual(read.failureCodes, ['run-not-found'], 'historical failure code preserved');
        assert.equal(read.attempts.length, 1, 'no attempt invented or dropped');
        assert.equal(read.attempts[0].failureCode, 'run-not-found');
        assert.equal(read.nextAction.kind, 'operator-action');
      }
      // The durable bytes are unchanged by reads (no read-path write).
      const disk = JSON.parse(await readFile(join(dir, 'operator-ui', 'tasks.json'), 'utf8'));
      assert.equal(disk.tasks[0].verdict, 'FAILED');
      assert.deepEqual(disk.tasks[0], historical, 'disk copy byte-equal to the fixture after reads');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
