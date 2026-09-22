// RC v3 durable-write contract test (GPT work order, 2026-09-22): TWO
// GENUINE node processes conflicting on the same task in the same
// tasks.json — not an in-process import-bust emulation, real spawned
// processes with their own module records, caches, and lock state.
//
// Scenario (the exact one the work order names):
//   1. Store starts with a FAILED projection of the task.
//   2. Process A (stale writer) hydrates the FAILED record and starts an
//      upsert; its publish path pauses IMMEDIATELY BEFORE PUBLICATION —
//      before lock acquisition (DSH_TEST_PERSIST_PAUSE_AT rendezvous:
//      <prefix>.arrived written, waits for <prefix>.go).
//   3. Process B (second writer) publishes a SHIP envelope for the SAME
//      task while A is frozen. B must succeed — nothing is held.
//   4. A is released. On resume A must observe B's newer SHIP bytes inside
//      its locked read→scan→publish sequence and FAIL CLOSED with
//      `task-conflict` — it must NOT overwrite the SHIP record.
//   5. Disk after A's attempt is byte-identical to disk after B's publish;
//      the publish lock is released by both processes.
//
// LIMITATION covered elsewhere: writers that IGNORE the lock protocol
// (plain fs writes) are a documented unsupported class — see
// test/tasks-external-writer.test.mjs and the lib/tasks.js header.
// Fully offline: both workers stub fetch; no network, no Archon.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TASKS_JS = pathToFileURL(resolve(HERE, '..', 'lib', 'tasks.js')).href;

const TASK_ID = 'task-rc31';

// Worker program: one spawned process = one genuine writer. argv:
//   1 mode   — "stale" | "ship"
//   2 file   — path to this script (unused; argv[1] is the script itself)
// reads TASKS_JS from argv[2], DSH_HOME from env.
const WORKER = `
const mode = process.argv[2];
const tasksJs = process.argv[3];
const taskId = process.argv[4];
// Offline: no Archon, no network — this test is about the durable store.
globalThis.fetch = async () => { throw new Error('offline-by-test'); };
const mod = await import(tasksJs);
const task = await mod.getTask(taskId);
if (!task) { console.log('NO_TASK'); process.exit(2); }
const base = { ...task };
delete base.archonRead;
delete base.archonReadReason;
try {
  if (mode === 'stale') {
    // First (and only) persist of this process pauses BEFORE the lock.
    await mod.upsertTask({ ...base, verdict: 'FAILED', failureCodes: ['run-not-found'], evidence: 'stale-write-must-not-win' });
    console.log('STALE_PUBLISHED');
    process.exit(3);
  } else if (mode === 'ship') {
    await mod.upsertTask({ ...base, verdict: 'SHIP', failureCodes: [], evidence: 'ship-write-wins' });
    console.log('SHIP_OK');
    process.exit(0);
  } else {
    console.log('BAD_MODE');
    process.exit(2);
  }
} catch (err) {
  if (err && err.code === 'task-conflict') { console.log('CONFLICT:' + err.code); process.exit(0); }
  console.log('ERROR:' + ((err && err.message) || err));
  process.exit(4);
}
`;

function failedEnvelope(taskId) {
  return {
    taskId,
    tasksVersion: 2,
    kind: 'goal',
    objective: 'Process values.csv and report running totals.',
    status: 'closed',
    verdict: 'FAILED',
    failureCodes: ['run-not-found'],
    sealedBy: 'goal-runner-m1',
    attempts: [],
    checks: [],
  };
}

function spawnWorker(script, mode, env) {
  return new Promise((resolvePromise, reject) => {
    const merged = { ...process.env, ...env };
    // The pause rendezvous is granted per-spawn only — never inherited from
    // the test-runner process by accident.
    if (!('DSH_TEST_PERSIST_PAUSE_AT' in env)) delete merged.DSH_TEST_PERSIST_PAUSE_AT;
    const child = spawn(process.execPath, [script, mode, TASKS_JS, TASK_ID], {
      env: merged,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function waitForFile(path, ms = 15_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try { await access(path); return; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + path);
    await new Promise((r) => { setTimeout(r, 25); });
  }
}

async function fileGone(path) {
  try { await access(path); return false; } catch { return true; }
}

test('two genuine processes: stale writer paused before publication cannot overwrite a newer SHIP record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opui-rc31-'));
  try {
    await mkdir(join(dir, 'operator-ui'), { recursive: true });
    const file = join(dir, 'operator-ui', 'tasks.json');
    const lock = file + '.lock';
    await writeFile(file, JSON.stringify({ tasksVersion: 2, tasks: [failedEnvelope(TASK_ID)] }, null, 2) + '\n', 'utf8');

    const script = join(dir, 'writer.mjs');
    await writeFile(script, WORKER, 'utf8');
    const baseEnv = { DSH_HOME: dir };

    // --- Process A: stale writer, paused immediately before publication.
    const pausePrefix = join(dir, 'pause-stale');
    const aPromise = spawnWorker(script, 'stale', { ...baseEnv, DSH_TEST_PERSIST_PAUSE_AT: pausePrefix });
    await waitForFile(pausePrefix + '.arrived');
    // The rendezvous fires BEFORE lock acquisition — A holds nothing, so B
    // can publish freely while A is frozen (this is the placement the
    // contract documents; a pause INSIDE the lock would deadlock B).
    assert.equal(await fileGone(lock), true, 'paused writer must not hold the publish lock yet');

    // --- Process B: genuine second process publishes SHIP for the SAME task.
    const b = await spawnWorker(script, 'ship', baseEnv);
    assert.equal(b.code, 0, 'SHIP writer must publish cleanly while A is paused (exit ' + b.code + ') stderr=' + b.stderr);
    assert.match(b.stdout, /SHIP_OK/, 'SHIP writer reported success');
    const afterShip = await readFile(file, 'utf8');
    const shipDoc = JSON.parse(afterShip);
    const shipped = shipDoc.tasks.find((t) => t.taskId === TASK_ID);
    assert.equal(shipped.verdict, 'SHIP', 'disk now holds the newer SHIP record');
    assert.equal(shipped.evidence, 'ship-write-wins');
    assert.equal(await fileGone(lock), true, 'SHIP writer released the publish lock');

    // --- Release A: it resumes into a world where its observation is stale.
    await writeFile(pausePrefix + '.go', 'go', 'utf8');
    const a = await aPromise;
    assert.equal(a.code, 0, 'stale writer exits cleanly having failed closed (exit ' + a.code + ') stdout=' + a.stdout + ' stderr=' + a.stderr);
    assert.match(a.stdout, /CONFLICT:task-conflict/, 'stale writer was refused with task-conflict');
    assert.doesNotMatch(a.stdout, /STALE_PUBLISHED/, 'stale writer must never publish');

    // The stale writer could not overwrite the newer SHIP record: bytes on
    // disk are exactly what B published, nothing from A's payload landed.
    const finalBytes = await readFile(file, 'utf8');
    assert.equal(finalBytes, afterShip, 'durable store byte-identical after the stale writer resumed — SHIP preserved');
    assert.equal(JSON.parse(finalBytes).tasks.find((t) => t.taskId === TASK_ID).evidence, 'ship-write-wins');
    assert.equal(await fileGone(lock), true, 'stale writer released the publish lock after failing closed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
