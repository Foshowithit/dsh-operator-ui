// dsh-operator-ui — RCOS task projection/cache.
//
// The task envelope is the RCOS-level record born ABOVE DSH/Archon:
//   task_id → objective → route decision(s) → attempts (executions) →
//   evidence → checks → verdict(s) → lineage.
//
// Durability (R-1, 2026-09-20): task envelopes persist to the running
// operator's own store, `$DSH_HOME/operator-ui/tasks.json`, via an atomic
// tmp+rename write on every upsert. Writes are best-effort: a failed write
// is recorded and the volatile cache remains the in-memory authority; module
// load and boot never depend on the file. This store belongs to the operator
// — a local projection of execution truth, not a competing lifecycle
// authority. (D1 refresh boundary, OP-5, 2026-09-22) The durable file is
// re-synchronized by content hash at every async read/write entry, so the
// one-shot hydrate is never permanent authority: when ANOTHER legitimate
// process updates the same durable task, the fresh disk copy is adopted live
// (no restart) and every reader serves it — a live SHIP envelope replaces an
// older cached FAILED projection in place. When two writers move the SAME
// task, publish fails closed with code `task-conflict` and the durable
// objective history is left untouched — never a last-writer-wins overwrite.
// (S2-R, 2026-09-20) Task↔conversation association is now EXPLICIT
// and inspectable: the envelope carries a `conversation` block (lib/
// conversation.js) whose archonConversationId is the id Archon returned from
// its supported creation API — never derived. The legacy deterministic
// `rcos-task-<id>` projection remains for READING old runs only; it never
// overrides a persisted association. Durable execution truth remains Archon
// and verification truth remains the sealed receipt machinery. (The earlier
// "writes nothing" stance is the regression
// the slice spec names: an operator restart lost approval-gated envelopes.)
//
// Durable-write contract (RC v3, 2026-09-22): ONE supported contract for
// getting bytes into tasks.json. Supported writers all go through this
// module, and every publish takes a cross-process lock file
// (`tasks.json.lock`, O_EXCL create with pid+nonce content, mtime-based
// stale takeover after LOCK_STALE_MS) that serializes the WHOLE
// read → conflict-scan → hash-recheck → rename sequence across processes.
// The content-hash re-check right before rename stays (defense in depth),
// but it is no longer the only thing standing between check and rename —
// a writer holding the lock cannot have another supported writer publish
// underneath it. Ownership of the lock is re-verified immediately before
// rename: if the lock was stolen/taken over while we held it, we fail
// closed (`task-conflict`) instead of publishing without the lock.
// LIMITATION (disclosed deliberately): this protocol protects only writers
// that follow it. An arbitrary process that ignores the lock and writes
// tasks.json with plain fs calls is NOT protected — the hash re-check can
// narrow that race but cannot close it (atomic rename ≠ CAS). External-writer
// tests exercise exactly that unsupported-writer class.
// Test-only pause hook: DSH_TEST_PERSIST_PAUSE_AT=<path prefix> makes the
// NEXT persist in this process pause BEFORE lock acquisition (writes
// <prefix>.arrived, waits for <prefix>.go, one-shot, ~20s deadline) so a
// test can freeze a writer immediately before publication while another
// genuine process publishes — the scenario RC v3 requires. Never set in
// production.
//
// Envelope rules (M0 adjudication, M1 scope upgrade):
// - Retry = SAME task_id, NEW attempt (never a new task).
// - Fork  = NEW task_id with lineage {parentTaskId, forkedFromTaskId},
//   inheriting objective/context — never rewinding workspace state.
// - Verdict scope is explicit: 'objective-evaluation' when the objective-
//   satisfaction check passed, 'capability-validation' otherwise (refusals and
//   unexecuted goals evaluate nothing). Never silently upgraded.

import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getDshHome, resolveConfig } from './config.js';
import { projectTaskFromRun } from './task-truth.js';
import { reconcileAdoptedRun, identifyHistoricalRun } from './reconcile.js';

export const TASKS_VERSION = 2;
// Bounded ORDINARY history. Evidence-bearing records are exempt (see
// evictOrdinary): a pin carries the identity witness that local equivocation
// evidence is built from, and an equivocation record IS the standing evidence
// that keeps a publisher quarantined — neither may be evicted by unrelated
// task churn.
const MAX_TASKS = 200;
const RETAINED_KINDS = new Set(['pin', 'equivocation']);
const volatileTasks = new Map();

// D1 refresh-boundary state (see the header): `diskHash` is the sha256 of the
// tasks.json bytes last observed (adopted or successfully published) — a
// re-read matching it is a no-op; `durableFp` maps taskId → fingerprint of
// that task's last-observed DISK content, updated only on adoption and after
// a successful publish (never by read-path sets); `writeInFlight` counts
// in-flight upserts per task id so a concurrent refresh never yanks a slot
// out from under its own writer, and persist can tell "only we changed this
// task" apart from "a second writer landed too".
let diskHash = null;
let syncPromise = null;
const durableFp = new Map();
const writeInFlight = new Map();

function fpOf(task) {
  return createHash('sha256').update(JSON.stringify(task) || '').digest('hex');
}
function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}
// Exported for the external-writer tests: the exact fingerprint upsertTask
// compares against when a caller passes `expectedFp`.
export function taskFp(task) {
  return task ? fpOf(task) : null;
}

function archonHeaders() {
  const { config } = resolveConfig();
  const headers = {};
  const tokenVar = config.archon.tokenVar;
  if (typeof tokenVar === 'string' && process.env[tokenVar]) headers.authorization = 'Bearer ' + process.env[tokenVar];
  return headers;
}

// OP-4R Phase C-R: the Archon read boundary distinguishes SUCCESSFUL-EMPTY
// from UNAVAILABLE. `[]` used to collapse "Archon answered: no runs" into
// "Archon could not be reached / its response could not be read", letting a
// transient outage masquerade as run-not-found. The distinction is made ONLY
// here and carried into discovery, listTasksRead and the reconciliation —
// never converted downstream into run-not-found, FAILED, or permission to
// redispatch.
async function readArchonRuns(limit = 100) {
  const { config } = resolveConfig();
  try {
    const res = await fetch(config.archon.baseUrl + '/api/workflows/runs?limit=' + Math.min(MAX_TASKS, Math.max(1, limit)), {
      headers: archonHeaders(),
      signal: AbortSignal.timeout(config.archon.timeoutMs),
    });
    if (!res.ok) return { state: 'unavailable', runs: null, reason: 'archon runs list returned HTTP ' + res.status };
    let body;
    try { body = await res.json(); } catch {
      return { state: 'unavailable', runs: null, reason: 'archon runs list response could not be read (invalid JSON)' };
    }
    if (!body || !Array.isArray(body.runs)) {
      return { state: 'unavailable', runs: null, reason: 'archon runs list response could not be read (no runs array)' };
    }
    return { state: 'ok', runs: body.runs };
  } catch (err) {
    return { state: 'unavailable', runs: null, reason: 'archon could not be reached (' + ((err && err.message) || 'network error') + ')' };
  }
}

// Independent run-detail read keyed by an EXPLICIT run id only — used by
// reconciliation to validate a stored association against freshly retrieved
// truth. A 404 is Archon ANSWERING that the run is absent (state ok, run
// null — the missing-run-detail leg); unreachable/unreadable is unavailable.
async function readArchonRunDetail(runId) {
  const { config } = resolveConfig();
  try {
    const res = await fetch(config.archon.baseUrl + '/api/workflows/runs/' + encodeURIComponent(runId), {
      headers: archonHeaders(),
      signal: AbortSignal.timeout(config.archon.timeoutMs),
    });
    if (res.status === 404) return { state: 'ok', run: null, reason: null };
    if (!res.ok) return { state: 'unavailable', run: null, reason: 'archon run detail returned HTTP ' + res.status };
    let body;
    try { body = await res.json(); } catch {
      return { state: 'unavailable', run: null, reason: 'archon run detail response could not be read (invalid JSON)' };
    }
    const run = body && body.run ? body.run : body;
    if (!run || typeof run !== 'object') return { state: 'ok', run: null, reason: null };
    return { state: 'ok', run: { ...run, id: run.id || runId }, reason: null };
  } catch (err) {
    return { state: 'unavailable', run: null, reason: 'archon could not be reached (' + ((err && err.message) || 'network error') + ')' };
  }
}

function objectiveFromRun(run, taskId) {
  const msg = String(run && run.user_message || '');
  const escaped = String(taskId || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = msg.match(new RegExp('^(?:task|goal)\\s+' + escaped + ':\\s*(.*)$', 'i'));
  return m ? m[1] : msg;
}

export function envelopeFromRun(run) {
  const p = projectTaskFromRun(run);
  if (!p) return null;
  const receiptDecision = run && run.receipt && run.receipt.decision ? String(run.receipt.decision).toUpperCase() : null;
  const verdict = receiptDecision || (p.execution.failed ? 'FAILED' : p.execution.completed ? 'COMPLETED' : 'PENDING');
  return {
    taskId: p.taskId,
    tasksVersion: TASKS_VERSION,
    kind: 'goal',
    objective: objectiveFromRun(run, p.taskId),
    status: ['running', 'queued', 'pending'].includes(p.execution.status) ? 'running' : 'closed',
    createdAt: run.started_at || null,
    endedAt: null,
    route: { selected: { workflow: p.workflow }, considered: [], reason: 'reconstructed from authoritative Archon run' },
    attempts: [{ attempt: 1, workflow: p.workflow, runId: p.runId, status: p.execution.status, outputs: [], startedAt: run.started_at || null, endedAt: null }],
    checks: [],
    execution: { completed: p.execution.completed, status: p.execution.status, runId: p.runId },
    capabilityValidation: receiptDecision ? { pass: receiptDecision === 'SHIP', decision: receiptDecision } : null,
    objectiveEvaluation: null,
    verdict,
    verdictDetail: {
      decision: verdict,
      scope: receiptDecision ? 'capability-validation' : 'execution',
      failureCodes: [],
      error: null,
    },
    failureCodes: [],
    error: null,
    evidence: null,
    lineage: null,
    reconstructedFrom: 'archon',
  };
}

function mergeTask(projected, cached) {
  if (!projected) return cached;
  if (!cached) return projected;
  const attempts = new Map();
  for (const a of projected.attempts || []) if (a && a.runId) attempts.set(a.runId, a);
  for (const a of cached.attempts || []) attempts.set(a && a.runId ? a.runId : 'attempt:' + String(a && a.attempt), a);
  return { ...projected, ...cached, attempts: [...attempts.values()] };
}

// Type-aware retention: evidence-bearing records are never removed by
// ordinary bounded eviction. Deleting evidence is only ever an explicit
// operation — never incidental churn. When nothing is evictable (e.g. a cache
// full of pins/equivocations), the bound yields rather than deleting evidence.
function evictOrdinary(keepId) {
  for (const [taskId, task] of volatileTasks) {
    if (taskId === keepId) continue;
    if (RETAINED_KINDS.has(task && task.kind)) continue;
    volatileTasks.delete(taskId);
    return;
  }
}

// --- Durability (R-1): atomic tasks.json persist + lazy hydrate -----------

function tasksFilePath() {
  return join(getDshHome(), 'operator-ui', 'tasks.json');
}

// D1: content-hash-tracked durable sync REPLACES the one-shot hydrate. Runs
// at every async read/write entry, single-flight per process. When the file's
// hash moved since last observed, the disk copies are the authority: every
// task NOT currently being written is adopted from disk — that is how a live
// SHIP envelope replaces an older cached FAILED projection without a restart,
// and how an externally appended correction reaches every reader. Tasks with
// an in-flight write keep their slot (their own persist conflict-check owns
// the decision). ENOENT (fresh $DSH_HOME) is the normal first-run shape;
// read/parse failures are recorded and the process runs volatile-only.
function syncDisk() {
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    try {
      let raw = null;
      try {
        raw = await readFile(tasksFilePath(), 'utf8');
      } catch (err) {
        if (!err || err.code !== 'ENOENT') console.error('[tasks] durable sync read failed:', err && err.message);
        return;
      }
      const h = hashText(raw);
      if (diskHash !== null && h === diskHash) return;
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { diskHash = h; return; }
      if (!parsed || parsed.tasksVersion !== TASKS_VERSION || !Array.isArray(parsed.tasks)) { diskHash = h; return; }
      for (const task of parsed.tasks) {
        if (!task || !task.taskId) continue;
        if (writeInFlight.has(task.taskId)) continue;
        volatileTasks.set(task.taskId, task);
        durableFp.set(task.taskId, fpOf(task));
      }
      diskHash = h;
    } catch (err) {
      console.error('[tasks] durable sync failed:', (err && err.message) || err);
    }
  })().finally(() => { syncPromise = null; });
  return syncPromise;
}

// Serialized in-process (persistChain) AND across processes (the
// tasks.json.lock publish lock, header "Durable-write contract"). The lock
// wraps the WHOLE read → conflict-scan → hash-recheck → rename sequence, so
// a supported writer's pre-publication observation can never be stale by the
// time it renames: a writer that resumes after another process published sees
// the newer bytes in its locked read and fails closed. Before publishing, the
// CURRENT durable file is re-compared per task (D1):
//   - only we changed the task (in-flight write, disk still at our
//     last-observed fingerprint) → proceed;
//   - a second writer moved the same task → adopt the surviving durable copy
//     into memory, then throw `task-conflict` WITHOUT renaming: the durable
//     objective history stays untouched (fail closed, never last-writer-wins);
//   - our local change is read-derived (no write in flight) → the disk copy
//     wins and is adopted instead of clobbered.
// The file hash is re-verified immediately before the rename (defense in
// depth against writers that IGNORE the lock — see the header limitation) and
// lock ownership is re-verified right before rename (a taken-over lock means
// we no longer own publication → fail closed). Non-conflict I/O errors keep
// the R-1 best-effort contract: recorded, volatile stays authority.

// Cross-process publish lock (RC v3). A lock file older than LOCK_STALE_MS
// is assumed to belong to a crashed holder and may be taken over; the token
// re-check before rename means an interrupted-then-resumed writer discovers
// it lost the lock instead of publishing unlocked.
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 20_000;
const LOCK_POLL_MS = 25;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function lockPathFor(file) {
  return file + '.lock';
}

async function readLockToken(path) {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.token === 'string' ? parsed.token : null;
  } catch {
    return null; // missing/unreadable = no owned lock
  }
}

async function acquirePublishLock(file) {
  const path = lockPathFor(file);
  const token = randomUUID();
  const body = JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }) + '\n';
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fh = await open(path, 'wx');
      try { await fh.writeFile(body, 'utf8'); } finally { await fh.close(); }
      return { path, token };
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        await mkdir(dirname(file), { recursive: true });
        continue;
      }
      if (!err || err.code !== 'EEXIST') throw err;
    }
    // Held by someone else: take over only if the holder looks crashed.
    let stale = false;
    try {
      const st = await lstat(path);
      stale = Date.now() - st.mtimeMs > LOCK_STALE_MS;
    } catch { continue; } // vanished between EEXIST and stat — retry immediately
    if (stale) {
      try { await unlink(path); } catch { /* another waiter took it first */ }
      continue;
    }
    if (Date.now() >= deadline) {
      const err = new Error('tasks.json publish lock still held after ' + LOCK_WAIT_MS + 'ms — refusing to publish concurrently (fail closed)');
      err.code = 'task-conflict';
      throw err;
    }
    await sleep(LOCK_POLL_MS);
  }
}

// Release only our own lock: if the file now carries another writer's token
// (stale takeover happened while we were inside), leave theirs in place.
async function releasePublishLock(lock) {
  if (!lock) return;
  if ((await readLockToken(lock.path)) === lock.token) {
    try { await unlink(lock.path); } catch { /* already gone */ }
  }
}

// Test-only, one-shot: pause BEFORE lock acquisition so a genuine second
// process can publish while this writer sits frozen immediately before
// publication. Consumed on first fire; never armed in production.
async function maybePauseBeforeLock(file) {
  const prefix = process.env.DSH_TEST_PERSIST_PAUSE_AT;
  if (!prefix) return;
  delete process.env.DSH_TEST_PERSIST_PAUSE_AT;
  await writeFile(prefix + '.arrived', String(process.pid), 'utf8');
  const deadline = Date.now() + 20_000;
  for (;;) {
    try { await readFile(prefix + '.go'); return; } catch { /* not yet */ }
    if (Date.now() >= deadline) {
      const err = new Error('test persist pause timed out waiting for ' + prefix + '.go');
      err.code = 'task-conflict';
      throw err;
    }
    await sleep(LOCK_POLL_MS);
  }
}

let persistChain = Promise.resolve();
function persistTasks() {
  const run = persistChain.then(async () => {
    const file = tasksFilePath();
    const tmp = file + '.tmp';
    await maybePauseBeforeLock(file);
    await mkdir(dirname(file), { recursive: true });
    const lock = await acquirePublishLock(file);
    try {
      await syncDisk();
      let prior = null;
      try { prior = await readFile(file, 'utf8'); } catch { prior = null; }
      let conflict = null;
      if (prior !== null) {
        let ext = null;
        try { ext = JSON.parse(prior); } catch { ext = null; }
        const extTasks = ext && ext.tasksVersion === TASKS_VERSION && Array.isArray(ext.tasks) ? ext.tasks : [];
        for (const diskTask of extTasks) {
          if (!diskTask || !diskTask.taskId) continue;
          const local = volatileTasks.get(diskTask.taskId);
          if (!local) continue; // evicted or never cached — nothing of ours to clobber
          const dfp = fpOf(diskTask);
          if (fpOf(local) === dfp) continue;
          if (writeInFlight.has(diskTask.taskId)) {
            const known = durableFp.get(diskTask.taskId);
            if (known != null && dfp === known) continue; // only we moved — our write is the update
            volatileTasks.set(diskTask.taskId, diskTask);
            durableFp.set(diskTask.taskId, dfp);
            conflict = conflict || new Error('concurrent writers on ' + diskTask.taskId + ' — durable publish refused (fail closed)');
            continue;
          }
          // Read-derived local: the durable copy is authoritative for it.
          volatileTasks.set(diskTask.taskId, diskTask);
          durableFp.set(diskTask.taskId, dfp);
        }
      }
      if (conflict) {
        conflict.code = 'task-conflict';
        throw conflict;
      }
      const payload = JSON.stringify({ tasksVersion: TASKS_VERSION, tasks: [...volatileTasks.values()] }, null, 2) + '\n';
      try {
        if (prior !== null) {
          let now = null;
          try { now = await readFile(file, 'utf8'); } catch { now = null; }
          if (now === null || hashText(now) !== hashText(prior)) {
            const err = new Error('tasks.json changed while a write was being prepared — publish refused (fail closed)');
            err.code = 'task-conflict';
            throw err;
          }
        }
        await writeFile(tmp, payload, 'utf8');
        // We must still OWN publication: a stale takeover would have replaced
        // our lock with another writer's token between acquire and here.
        if ((await readLockToken(lock.path)) !== lock.token) {
          const err = new Error('publish lock lost before rename (taken over) — refusing to publish unlocked (fail closed)');
          err.code = 'task-conflict';
          throw err;
        }
        await rename(tmp, file);
        diskHash = hashText(payload);
        for (const task of volatileTasks.values()) durableFp.set(task.taskId, fpOf(task));
      } catch (err) {
        if (err && err.code === 'task-conflict') throw err;
        // Durability is best-effort: the volatile cache stays the in-memory
        // authority and a failed write never throws out of this module.
        console.error('[tasks] durable write failed:', err && err.message);
      }
    } finally {
      await releasePublishLock(lock);
    }
  });
  persistChain = run.catch(() => {});
  return run;
}

export async function upsertTask(task, opts = {}) {
  if (!task || !task.taskId) throw new Error('taskId required');
  // Phase C-R invariant: availability markers are per-read cosmetics on the
  // response copy; a marked envelope handed back during an outage must never
  // enter the cache or the durable store.
  const clean = (task.archonRead || task.archonReadReason)
    ? (({ archonRead, archonReadReason, ...rest }) => rest)(task)
    : task;
  await syncDisk();
  // Fail-closed optimistic guard (D1): a caller that read this task and then
  // writes it back (the reconciliation append) must not clobber a durable
  // record that moved in between. Omitted `expectedFp` = caller accepts the
  // current state (every other call site).
  if (opts.expectedFp != null) {
    const cur = volatileTasks.get(clean.taskId);
    const curFp = cur ? fpOf(cur) : null;
    if (curFp !== opts.expectedFp) {
      const err = new Error('task ' + clean.taskId + ' changed after it was read — refusing stale write (fail closed)');
      err.code = 'task-conflict';
      throw err;
    }
  }
  writeInFlight.set(clean.taskId, (writeInFlight.get(clean.taskId) || 0) + 1);
  try {
    // Move-to-newest on update so eviction below always takes the oldest entry.
    volatileTasks.delete(clean.taskId);
    volatileTasks.set(clean.taskId, clean);
    while (volatileTasks.size > MAX_TASKS) evictOrdinary(clean.taskId);
    await persistTasks();
  } finally {
    const n = (writeInFlight.get(clean.taskId) || 1) - 1;
    if (n > 0) writeInFlight.set(clean.taskId, n);
    else writeInFlight.delete(clean.taskId);
  }
  return clean;
}

// Synchronous cache read for host routes that already expect a plain object.
// `listTasks()` hydrates this cache from Archon after restart; GoalRunner uses
// `getTask()` when it needs an authoritative async reconstruction.
export function peekTask(taskId) {
  return volatileTasks.get(taskId) || null;
}

// --- OP-4R Phase C-R: identity recovery wiring ----------------------------
//
// Reconciliation runs inside getTaskRead only (listTasksRead stays a light
// projection; per-task recovery happens when a task is actually opened).
// Idempotency: a reconciliation entry already on the envelope means the work
// is done — no re-read, no duplicate append. During an Archon outage, no
// reconciliation runs at all: an unreadable Archon must never be recorded as
// "unresolved identity" (that state is for EVIDENCE, not for outages).

async function reconcileTask(task, runs, fetchDetail) {
  const attempts = Array.isArray(task.attempts) ? task.attempts : [];
  const existing = Array.isArray(task.reconciliation) ? task.reconciliation : [];
  const adopted = attempts.filter((a) => a && a.adoption && a.adoption.runId).pop() || null;
  if (adopted) {
    if (existing.some((e) => e && e.kind === 'child-run-association-verified' && e.runId === adopted.adoption.runId)) {
      return { identity: { state: 'reconciled', runId: adopted.adoption.runId, replayed: true }, appended: false };
    }
    const detailRead = await readArchonRunDetail(adopted.adoption.runId);
    // The envelope itself was built from a successful list read; an unreadable
    // detail is a transient outage, not an identity verdict — skip silently.
    if (detailRead.state !== 'ok') return { identity: null, appended: false, skipped: detailRead.reason };
    return reconcileAdoptedRun(task, { detail: detailRead.run, checkedAt: new Date().toISOString() });
  }
  const historicalEligible = Boolean(
    task.conversation
    && attempts.length
    && attempts.some((a) => a && a.runId == null)
    && !existing.some((e) => e && (e.kind === 'child-run-identified' || e.kind === 'identification-ambiguous'))
  );
  if (historicalEligible) {
    return identifyHistoricalRun(task, {
      runs,
      fetchDetail,
      expectedMessage: 'task ' + task.taskId + ': ' + task.objective,
      checkedAt: new Date().toISOString(),
    });
  }
  return { identity: null, appended: false };
}

function markUnavailable(task, reason) {
  // Marker travels on a COPY; the volatile cache keeps the clean record and
  // nothing marked is ever persisted.
  return { ...(task || {}), archonRead: 'unavailable', archonReadReason: reason };
}

export async function getTaskRead(taskId) {
  await syncDisk();
  const cached = volatileTasks.get(taskId) || null;
  // Fingerprint of exactly what this read observed: a reconciliation append
  // may only land if the durable record is still that same record (D1).
  const readFp = cached ? fpOf(cached) : null;
  const runsRead = await readArchonRuns();
  if (runsRead.state === 'unavailable') {
    // Outage ≠ empty. With a cached envelope: serve it, explicitly marked.
    // Without one: fail with a distinct code — never a quiet null that a
    // caller could read as "task not found".
    if (cached) return { state: 'unavailable', reason: runsRead.reason, task: markUnavailable(cached, runsRead.reason), identity: null };
    const err = new Error('task ' + taskId + ' cannot be read: archon unavailable (' + runsRead.reason + ')');
    err.code = 'archon-unavailable';
    throw err;
  }
  const runs = runsRead.runs;
  const projected = runs.map(envelopeFromRun).filter(Boolean).find((t) => t.taskId === taskId) || null;
  const merged = mergeTask(projected, cached);
  if (!merged) return { state: 'ok', task: null, identity: null };
  // Detach before reconciling: reconcile appends an entry (and may fill a
  // never-recorded attempt status) on THIS read's copy, and those writes land
  // on shared objects — mergeTask aliases `cached` outright when there is no
  // projection and shares attempt objects when there is. The D1 guard below
  // must still fingerprint the pristine cache, so only an EXTERNAL change
  // between this read and the write may trip it — never our own append.
  const target = {
    ...merged,
    attempts: (Array.isArray(merged.attempts) ? merged.attempts : []).map((a) => (a && typeof a === 'object' ? { ...a } : a)),
  };
  const fetchDetail = async (runId) => {
    const d = await readArchonRunDetail(runId);
    return d.state === 'ok' ? d.run : null;
  };
  const recon = await reconcileTask(target, runs, fetchDetail);
  if (recon.appended) {
    // Upstream writers must win over a stale read: the append is refused
    // (task-conflict) if anything changed the durable record since this read
    // captured it — fail closed instead of overwriting newer history.
    await upsertTask(target, readFp != null ? { expectedFp: readFp } : {});
  } else {
    volatileTasks.set(taskId, target);
  }
  return { state: 'ok', task: target, identity: recon.identity || null };
}

export async function getTask(taskId) {
  const read = await getTaskRead(taskId);
  return read.task;
}

export async function listTasksRead() {
  await syncDisk();
  const runsRead = await readArchonRuns();
  if (runsRead.state === 'unavailable') {
    const tasks = [...volatileTasks.values()]
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .slice(0, MAX_TASKS)
      .map((t) => markUnavailable(t, runsRead.reason));
    return { state: 'unavailable', reason: runsRead.reason, tasks };
  }
  const byId = new Map();
  for (const run of runsRead.runs) {
    const projected = envelopeFromRun(run);
    if (!projected) continue;
    const prior = byId.get(projected.taskId);
    if (!prior) byId.set(projected.taskId, projected);
    else prior.attempts.push(...projected.attempts);
  }
  for (const [taskId, cached] of volatileTasks) byId.set(taskId, mergeTask(byId.get(taskId) || null, cached));
  const tasks = [...byId.values()]
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, MAX_TASKS);
  for (const task of tasks) volatileTasks.set(task.taskId, task);
  return { state: 'ok', tasks };
}

export async function listTasks() {
  return (await listTasksRead()).tasks;
}

export async function taskCount() { return (await listTasks()).length; }

export function forkTaskId() {
  return 'task-' + randomUUID().replace(/-/g, '').slice(0, 8);
}

export function envelopeFromGoal(goal, lineage) {
  const objectiveSatisfied = goal.objectiveEvaluation && goal.objectiveEvaluation.status === 'SATISFIED';
  const scope = objectiveSatisfied ? 'objective-evaluation' : goal.capabilityValidation ? 'capability-validation' : 'execution';
  const failureCodes = goal.failureCodes || [];
  return {
    taskId: goal.taskId,
    tasksVersion: TASKS_VERSION,
    kind: 'goal',
    objective: goal.objective,
    // awaiting-approval is its own durable status: the Preview surface keys
    // off it, and it must never read as "running" (nothing is executing).
    status: (goal.failureCodes || []).includes('awaiting-approval')
      ? 'awaiting-approval'
      : goal.verdict === 'PENDING' ? 'running' : 'closed',
    createdAt: goal.startedAt,
    endedAt: goal.endedAt || null,
    route: goal.route ? {
      selected: goal.route.selected,
      considered: (goal.route.considered || []).map((c) => ({ id: c.id, score: c.score, reasons: c.reasons })),
      reason: goal.route.reason || null,
    } : null,
    attempts: (goal.attempts || []).map((a) => ({
      attempt: a.attempt,
      workflow: a.workflow,
      runId: a.runId || null,
      status: a.status || null,
      outputs: a.outputs || [],
      startedAt: a.startedAt || null,
      endedAt: a.endedAt || null,
      // OP-4R: the adopted run's identity + provenance travels with the
      // attempt. `adoption` records how the run was attributed to this
      // dispatch (mode, every verification leg, the child conversation id as
      // verbatim provenance); `childConversationId` is never compared against
      // the durable association and never overwrites it.
      adoption: a.adoption || null,
      childConversationId: a.childConversationId || null,
      failureCode: a.failureCode || null,
      error: a.error || null,
      dispatch: a.dispatch || null,
      discovery: a.discovery || null,
      // OP-4R Attempt 3: fresh-run provenance (who explicitly authorized the
      // bypass) and the post-dispatch menu observation (menu evidence only —
      // never proof a run executed) both travel with the attempt.
      freshRun: a.freshRun || null,
      observation: a.observation || null,
    })),
    checks: goal.checks || [],
    execution: goal.execution || null,
    capabilityValidation: goal.capabilityValidation || null,
    objectiveEvaluation: goal.objectiveEvaluation || null,
    claim: goal.claim || null,
    trust: goal.trust || null,           // derived ladder: Observed → … → Objective satisfied (+ truth named per rung)
    nextAction: goal.nextAction || null, // first-class suggested operator action (suggests; never auto-executes)
    verdict: goal.verdict,               // STRING (SHIP/BLOCK/FAILED/PENDING/PENDING-approval); detail below
    verdictDetail: {
      decision: goal.verdict,
      // M1: the gate now evaluates OBJECTIVE SATISFACTION (3rd check), so a
      // SHIP vouches at objective scope. A goal that never executed keeps the
      // capability-validation scope — a refusal evaluates nothing.
      scope,
      failureCodes,
      error: goal.error || null,
    },
    failureCodes,
    error: goal.error || null,
    evidence: goal.evidence || null,
    authority: goal.authority || null, // granted policy the task ran (or waits) under: {preset, requires, granted, missing, mode, reason, approvedAt}
    // S2-R: explicit Archon conversation association — DISTINCT identity from
    // the task id and any run id. {provisioningState, archonConversationId, …}
    // once provisioned; null until then. Never a derived id.
    conversation: goal.conversation || null,
    lineage: lineage || null, // {parentTaskId, forkedFromTaskId} when forked
    sealedBy: 'goal-runner-m1',
  };
}
