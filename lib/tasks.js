// dsh-operator-ui — RCOS task projection/cache.
//
// The task envelope is the RCOS-level record born ABOVE DSH/Archon:
//   task_id → objective → route decision(s) → attempts (executions) →
//   evidence → checks → verdict(s) → lineage.
//
// Durability (R-1, 2026-09-20): task envelopes persist to the running
// operator's own store, `$DSH_HOME/operator-ui/tasks.json`, via an atomic
// tmp+rename write on every upsert, and hydrate lazily from that file on the
// first async access after a restart. Writes are best-effort: a failed write
// is recorded and the volatile cache remains the in-memory authority; module
// load and boot never depend on the file. This is the single writer's own
// store — a local projection of execution truth, not a competing lifecycle
// authority. (S2-R, 2026-09-20) Task↔conversation association is now EXPLICIT
// and inspectable: the envelope carries a `conversation` block (lib/
// conversation.js) whose archonConversationId is the id Archon returned from
// its supported creation API — never derived. The legacy deterministic
// `rcos-task-<id>` projection remains for READING old runs only; it never
// overrides a persisted association. Durable execution truth remains Archon
// and verification truth remains the sealed receipt machinery. (The earlier
// "writes nothing" stance is the regression
// the slice spec names: an operator restart lost approval-gated envelopes.)
//
// Envelope rules (M0 adjudication, M1 scope upgrade):
// - Retry = SAME task_id, NEW attempt (never a new task).
// - Fork  = NEW task_id with lineage {parentTaskId, forkedFromTaskId},
//   inheriting objective/context — never rewinding workspace state.
// - Verdict scope is explicit: 'objective-evaluation' when the objective-
//   satisfaction check passed, 'capability-validation' otherwise (refusals and
//   unexecuted goals evaluate nothing). Never silently upgraded.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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

// One-shot hydrate, memoized per process: fills the cache from the durable
// file without clobbering anything already live in memory. Best-effort — a
// missing file (fresh $DSH_HOME) is the normal first-run shape; any other
// read/parse failure is recorded and the process runs volatile-only.
let hydratePromise = null;
function hydrateFromDisk() {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    try {
      const raw = await readFile(tasksFilePath(), 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.tasksVersion !== TASKS_VERSION || !Array.isArray(parsed.tasks)) return;
      for (const task of parsed.tasks) {
        if (task && task.taskId && !volatileTasks.has(task.taskId)) volatileTasks.set(task.taskId, task);
      }
    } catch (err) {
      if (!err || err.code !== 'ENOENT') console.error('[tasks] durable hydrate failed:', err && err.message);
    }
  })();
  return hydratePromise;
}

// Serialized so concurrent upserts can never interleave inside the shared
// tmp file. Atomic publish: write tmp, rename over the target.
let persistChain = Promise.resolve();
function persistTasks() {
  const run = persistChain.then(async () => {
    const file = tasksFilePath();
    const tmp = file + '.tmp';
    const payload = JSON.stringify({ tasksVersion: TASKS_VERSION, tasks: [...volatileTasks.values()] }, null, 2) + '\n';
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(tmp, payload, 'utf8');
      await rename(tmp, file);
    } catch (err) {
      // Durability is best-effort: the volatile cache stays the in-memory
      // authority and a failed write never throws out of this module.
      console.error('[tasks] durable write failed:', err && err.message);
    }
  });
  persistChain = run.catch(() => {});
  return run;
}

export async function upsertTask(task) {
  if (!task || !task.taskId) throw new Error('taskId required');
  // Phase C-R invariant: availability markers are per-read cosmetics on the
  // response copy; a marked envelope handed back during an outage must never
  // enter the cache or the durable store.
  const clean = (task.archonRead || task.archonReadReason)
    ? (({ archonRead, archonReadReason, ...rest }) => rest)(task)
    : task;
  await hydrateFromDisk();
  // Move-to-newest on update so eviction below always takes the oldest entry.
  volatileTasks.delete(clean.taskId);
  volatileTasks.set(clean.taskId, clean);
  while (volatileTasks.size > MAX_TASKS) evictOrdinary(clean.taskId);
  await persistTasks();
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
  await hydrateFromDisk();
  const cached = volatileTasks.get(taskId) || null;
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
  volatileTasks.set(taskId, merged);
  const fetchDetail = async (runId) => {
    const d = await readArchonRunDetail(runId);
    return d.state === 'ok' ? d.run : null;
  };
  const recon = await reconcileTask(merged, runs, fetchDetail);
  if (recon.appended) await upsertTask(merged);
  return { state: 'ok', task: merged, identity: recon.identity || null };
}

export async function getTask(taskId) {
  const read = await getTaskRead(taskId);
  return read.task;
}

export async function listTasksRead() {
  await hydrateFromDisk();
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
